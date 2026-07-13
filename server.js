import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { initAuthDB, setupAuth } from "./auth.js";
import { mpRouter } from "./Routes/mp.js";
import { botWhatsappRouter } from "./Routes/botWhatsapp.js";
import { cotizadorRouter } from "./Routes/cotizador.js";
import { createRequire } from "module";
import { normalizarProducto } from "./productos-normalizacion.js"; // clave canónica compartida con el front
const requireCJS = createRequire(import.meta.url); // server.js es ESM; require solo para el JSON de polígonos
const { Pool } = pg;

// ─── VALIDACIÓN DE VARIABLES DE ENTORNO ──────────────────────────────
// Obligatorias: sin estas el server NO puede funcionar -> FATAL.
const REQUIRED_ENV = [
  "DATABASE_URL",
  "JWT_SECRET",
  "ADMIN_SECRET",
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("❌ FATAL: faltan variables de entorno:", missing.join(", "));
  process.exit(1);
}

// Opcionales: si faltan, el server arranca igual (p. ej. staging sin integraciones
// externas) y solo se loguea un warning. El código que las usa hace su propio guard.
const TN_ENV = ["TN_STORE_ID", "TN_ACCESS_TOKEN", "TN_CLIENT_SECRET"];
const TF_ENV = ["TF_APIKEY", "TF_APITOKEN", "TF_USERTOKEN_AT", "TF_USERTOKEN_FR"];
const missingTN = TN_ENV.filter(k => !process.env[k]);
const missingTF = TF_ENV.filter(k => !process.env[k]);
if (missingTN.length > 0) console.warn(`⚠️ Integración Tienda Nube deshabilitada: faltan ${missingTN.join(", ")}`);
if (missingTF.length > 0) console.warn(`⚠️ Facturación (TusFacturas) deshabilitada: faltan ${missingTF.join(", ")}`);
if (!process.env.WEBHOOK_URL) console.warn("⚠️ WEBHOOK_URL no configurada: se usa la URL por defecto de producción.");

// Flags de integración para los guards en runtime.
const TN_ENABLED = missingTN.length === 0;
const TF_ENABLED = missingTF.length === 0;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const STORE_ID = process.env.TN_STORE_ID;
const ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const TN_CLIENT_SECRET = process.env.TN_CLIENT_SECRET;
const headers = {
  Authentication: `bearer ${ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // max: tope de conexiones simultáneas. 20 es un punto medio para Neon; subir/bajar
  // según el límite del plan (Neon pooler suele tolerar más; sin pooler, menos).
  max: 20,
  // Si el pool está saturado, fallar rápido (5s) en vez de colgar la request indefinido.
  connectionTimeoutMillis: 5000,
  // Cerrar conexiones ociosas a los 30s.
  idleTimeoutMillis: 30000,
  // Nota: no se setea search_path acá. El pooler de Neon NO soporta el parámetro
  // de arranque `options` ("unsupported startup parameter in options: search_path").
  // `public` ya es el esquema por defecto de Postgres y todas las tablas viven ahí,
  // así que las queries sin prefijo resuelven solo. Si se quisiera fijar explícito,
  // hacerlo server-side por rol: ALTER ROLE <owner> SET search_path TO public;
});

// ─── REINTENTO ANTE CONEXIONES "ENVENENADAS" DE NEON ─────────────────
// Tras un restart/wake del compute de Neon, el pooler (PgBouncer) a veces entrega
// conexiones que no ven el schema public: TODA query falla con 42P01 / 3F000 (u otros
// errores de conexión). Antes esas conexiones quedaban en el pool y se reusaban -> panel
// caído ~1h hasta reiniciar a mano. Acá envolvemos pool.query: ante un error transitorio
// EVICTAMOS la conexión mala (client.release(err) la DESTRUYE, no la devuelve al pool) y
// reintentamos con una conexión NUEVA. Las conexiones nuevas ya nacen sanas por el
// `ALTER ROLE neondb_owner SET search_path TO public` corrido en Neon.
//
// Sólo afecta a pool.query (sentencias sueltas). pool.connect() queda intacto, así que las
// transacciones (BEGIN…COMMIT sobre un client propio, p. ej. las funciones *Tx de stock)
// NO se reintentan — reintentar una sentencia suelta de una transacción sería incorrecto.
// Transitorios al EJECUTAR la query (conexión envenenada / caída a mitad).
const ERRORES_TRANSITORIOS = new Set(["42P01", "3F000", "57P01", "08006", "08003", "ECONNRESET", "ETIMEDOUT"]);
function esErrorTransitorio(err) {
  if (!err) return false;
  if (err.code && ERRORES_TRANSITORIOS.has(err.code)) return true;
  return /Connection terminated|connection error|ECONNRESET|ETIMEDOUT/i.test(String(err.message || ""));
}
// Transitorios al CONECTAR (pool.connect): incluye ECONNREFUSED y el timeout propio del
// pool de pg. NO incluye 42P01/3F000 (errores de schema, imposibles en connect).
const ERRORES_CONNECT_TRANSITORIOS = new Set(["ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "08006", "08003", "57P01"]);
function esConnectTransitorio(err) {
  if (!err) return false;
  if (err.code && ERRORES_CONNECT_TRANSITORIOS.has(err.code)) return true;
  return /Connection terminated|connection error|timeout exceeded when trying to connect/i.test(String(err.message || ""));
}
const BACKOFFS_MS = [250, 500, 1000];
const esperarMs = (ms) => new Promise(r => setTimeout(r, ms));

pool.query = async function reintentarQuery(...args) {
  let ultimoError;
  for (let intento = 1; intento <= 3; intento++) {
    let client;
    try {
      client = await pool.connect();           // si falla, client queda undefined
      const res = await client.query(...args);
      client.release();                          // éxito: la conexión vuelve sana al pool
      return res;
    } catch (err) {
      ultimoError = err;
      // El connect y la query comparten los 3 intentos/backoff (no se multiplican).
      // Clasificación según en qué etapa falló: si hay client, falló la query; si no,
      // falló el connect.
      const transitorio = client ? esErrorTransitorio(err) : esConnectTransitorio(err);
      if (!transitorio) {
        if (client) client.release();            // query no-transitoria: soltar normal y propagar
        throw err;                               // (connect no-transitorio: no hay client que soltar)
      }
      if (client) client.release(err);           // query transitoria: EVICTAR la conexión envenenada
      // (connect transitorio: nunca devolvió client -> nada que evictar, solo backoff)
      if (intento < 3) {
        console.warn(`pool.query: reintento ${intento}/3 por error transitorio ${err.code || err.message}`);
        await esperarMs(BACKOFFS_MS[intento - 1]);
      }
    }
  }
  console.warn(`pool.query: reintentos agotados (3/3), propago último error ${ultimoError?.code || ultimoError?.message}`);
  throw ultimoError;
};

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_estados (
      id TEXT PRIMARY KEY,
      estado TEXT DEFAULT 'Por empaquetar',
      repartidor TEXT DEFAULT 'Sin asignar',
      tab_manual TEXT, fecha_manual TEXT, franja_manual TEXT,
      cobrar BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos_manuales (
      id TEXT PRIMARY KEY,
      numero TEXT, cliente TEXT, telefono TEXT, email TEXT,
      direccion TEXT, entre_calles TEXT, barrio TEXT, zona TEXT,
      fecha TEXT, franja TEXT, productos TEXT,
      total_num NUMERIC, total TEXT, pago TEXT, medio_pago TEXT,
      cobrar BOOLEAN DEFAULT false, tab_actual TEXT, local TEXT, nota TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS caja_movimientos (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL, tipo TEXT NOT NULL, concepto TEXT,
      monto NUMERIC NOT NULL, fecha TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS caja_aperturas (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL, fecha TEXT NOT NULL,
      monto_inicial NUMERIC DEFAULT 0,
      cerrada BOOLEAN DEFAULT false, monto_cierre NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS facturas (
      id SERIAL PRIMARY KEY,
      pedido_id TEXT, tipo TEXT, numero TEXT, cae TEXT,
      vencimiento_cae TEXT, cliente TEXT, documento_tipo TEXT,
      documento_nro TEXT, total NUMERIC, pdf_url TEXT,
      fecha TEXT, datos_raw JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos_productos (
      pedido_id TEXT PRIMARY KEY,
      productos TEXT NOT NULL,
      total_num NUMERIC NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos_tn (
      id BIGINT PRIMARY KEY,
      store_id TEXT, numero TEXT, estado_tn TEXT, payment_status TEXT,
      total NUMERIC, contact_email TEXT, contact_name TEXT, contact_phone TEXT,
      data JSONB, tn_created_at TIMESTAMP, updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS webhook_events (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL, resource_id BIGINT NOT NULL, signature TEXT NOT NULL,
      processed_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(event_type, resource_id, signature)
    );
  `);

  // Migraciones
  await pool.query(`ALTER TABLE pedidos_manuales ADD COLUMN IF NOT EXISTS email TEXT;`);
  await pool.query(`ALTER TABLE pedidos_manuales ADD COLUMN IF NOT EXISTS mp_preference_id TEXT;`);
  await pool.query(`ALTER TABLE pedidos_manuales ADD COLUMN IF NOT EXISTS mp_payment_id TEXT;`);
  await pool.query(`ALTER TABLE pedidos_tn ADD COLUMN IF NOT EXISTS mp_preference_id TEXT;`);
  await pool.query(`ALTER TABLE pedidos_tn ADD COLUMN IF NOT EXISTS mp_payment_id TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS cliente_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS telefono_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS direccion_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS barrio_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS zona_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS medio_pago_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS nota_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS email_override TEXT;`);
  await pool.query(`ALTER TABLE facturas ADD COLUMN IF NOT EXISTS local TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS codigo_pago_override TEXT;`);
  await pool.query(`ALTER TABLE pedidos_manuales ADD COLUMN IF NOT EXISTS codigo_pago TEXT;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS comandas_impresas INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS tarjeta TEXT NOT NULL DEFAULT 'no';`);
  await pool.query(`CREATE TABLE IF NOT EXISTS repartidores (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, activo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS costos_areas (area INTEGER PRIMARY KEY, costo NUMERIC NOT NULL DEFAULT 1);`);
  await pool.query(`INSERT INTO costos_areas (area, costo) SELECT g, 1 FROM generate_series(1,10) g ON CONFLICT (area) DO NOTHING;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS geocoding_cache (
    address_key TEXT PRIMARY KEY,
    lat NUMERIC NOT NULL,
    lng NUMERIC NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY,
    usuario TEXT NOT NULL,
    accion TEXT NOT NULL,
    entidad_tipo TEXT NOT NULL,
    entidad_id TEXT NOT NULL,
    detalle JSONB,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS pedidos_manuales_seq START 1;`);
  await pool.query(`INSERT INTO repartidores (nombre) VALUES ('Sin asignar') ON CONFLICT (nombre) DO NOTHING;`);
     console.log("DB inicializada");
  await initAuthDB(pool);
}
initDB().catch(console.error);

const { requireAuth, requireAdmin, requireRole } = setupAuth(app, pool);

// ─── AUDITORIA HELPER ────────────────────────────────────────────────
async function registrarAuditoria(usuario, accion, entidadTipo, entidadId, detalle = {}) {
  try {
    await pool.query(
      "INSERT INTO auditoria (usuario, accion, entidad_tipo, entidad_id, detalle) VALUES ($1,$2,$3,$4,$5)",
      [usuario || "Sistema", accion, entidadTipo, String(entidadId), JSON.stringify(detalle)]
    );
  } catch (e) { console.error("Error auditoria:", e.message); }
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────
app.get("/api/health", async (req, res) => {
  const start = Date.now();
  try {
    await pool.query("SELECT 1");
    res.json({ status: "healthy", server: "ok", database: "ok", database_latency_ms: Date.now() - start, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: "unhealthy", server: "ok", database: "error", timestamp: new Date().toISOString() });
  }
});

function fechaArgentinaISO(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function fechaArgentinaDDMMYYYY(d = new Date()) {
  const partes = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const dd = partes.find(p => p.type === "day").value;
  const mm = partes.find(p => p.type === "month").value;
  const yyyy = partes.find(p => p.type === "year").value;
  return `${dd}/${mm}/${yyyy}`;
}

function fechaHoy() {
  return fechaArgentinaDDMMYYYY();
}

function fechaVencimiento(dias = 30) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return fechaArgentinaDDMMYYYY(d);
}

const TN_CODE_FRENCH = "01KQ7S2Z0799JKAT5A1VTH12EQ";
const TN_CODE_AT = "01KQ7TFQPTTZQ7CFFKCKVWEZQV";

function clasificarPedidoBackend(p) {
  const ff = p.fulfillments?.[0];
  const tipo = ff?.shipping?.type || "";
  const optionName = (ff?.shipping?.option?.name || "").toLowerCase();
  const optionCode = ff?.shipping?.option?.code || "";
  const esPickup = tipo === "pickup" || optionName.includes("retiro") || optionName.includes("pickup") || optionName.includes("local");
  let esFrench;
  if (optionCode === TN_CODE_FRENCH) esFrench = true;
  else if (optionCode === TN_CODE_AT) esFrench = false;
  else esFrench = optionName.includes("recoleta");
  if (esPickup) return esFrench ? "retiro-fr" : "retiro-at";
  return esFrench ? "delivery-fr" : "delivery-at";
}

function localLabelBackend(tabActual) {
  if (tabActual === "retiro-at" || tabActual === "delivery-at") return "A. Thomas";
  if (tabActual === "retiro-fr" || tabActual === "delivery-fr") return "French";
  return "—";
}

function parsearFranjaBackend(ownerNote) {
  if (!ownerNote) return { fecha: null, franja: null };
  const match = ownerNote.match(/(\d+\/\d+\/\d+), entre las (\d+:\d+) y las (\d+:\d+)/);
  if (!match) return { fecha: null, franja: null };
  const [, fecha, inicio, fin] = match;
  const [dia, mes, anio] = fecha.split("/");
  return { fecha: `${anio}-${mes.padStart(2,"0")}-${dia.padStart(2,"0")}`, franja: `${inicio} – ${fin}` };
}

function medioPagoLabelBackend(gateway) {
  if (!gateway) return "Otro";
  if (gateway.includes("mercado-pago")) return "Mercado Pago";
  if (gateway.includes("offline") || gateway.includes("efectivo")) return "Efectivo";
  if (gateway.includes("transfer")) return "Transferencia";
  if (gateway === "not-provided") return "Efectivo";
  return "Otro";
}

function formatoFechaLarga(yyyymmdd) {
  if (!yyyymmdd) return "";
  const d = new Date(yyyymmdd + "T12:00:00");
  return d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function formatoPesos(n) { return `$${Number(n || 0).toLocaleString("es-AR")}`; }

// ─── TUSFACTURAS — CREDENCIALES POR SUCURSAL ─────────────────────────
const TF_APIKEY = process.env.TF_APIKEY;
const TF_APITOKEN = process.env.TF_APITOKEN;
const TF_CUIT_EMISOR = process.env.TF_CUIT_EMISOR || "30712271503";

function getTFCredentials(local) {
  if (local === "French") {
    return { usertoken: process.env.TF_USERTOKEN_FR, pdv: process.env.TF_PDV_FR || "00018" };
  }
  return { usertoken: process.env.TF_USERTOKEN_AT, pdv: process.env.TF_PDV_AT || "00017" };
}

// ─── MAIL ─────────────────────────────────────────────────────────────
const mailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } })
  : null;

const DIRECCION_A_THOMAS = "Alvarez Thomas 1558, Villa Ortúzar";
const DIRECCION_FRENCH = "French 2615, Recoleta";
const WHATSAPP_PICCADELY = "11-6239-3600";
const COLOR_NARANJA = "#F68B32";

function htmlMailConfirmacion(pedido) {
  const esRetiro = String(pedido.tabActual || "").startsWith("retiro");
  const esFrench = pedido.local === "French";
  const direccionLocal = esFrench ? DIRECCION_FRENCH : DIRECCION_A_THOMAS;
  let fechaTxt = pedido.fechaDisplay || pedido.fecha || "";
  try { fechaTxt = new Date(fechaTxt + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" }); } catch (e) {}
  const productosLista = (pedido.productos || "").split(", ").filter(Boolean).map(p => `<li style="margin:4px 0;">${p}</li>`).join("");
  const cobrarBlock = pedido.cobrar
    ? `<tr><td style="padding:6px 0;color:#c0392b;font-weight:bold;">⚠ A cobrar en entrega:</td><td style="padding:6px 0;color:#c0392b;font-weight:bold;text-align:right;">${formatoPesos(pedido.totalNum || pedido.total_num)}</td></tr>`
    : `<tr><td style="padding:6px 0;color:#666;">Pago:</td><td style="padding:6px 0;text-align:right;">${pedido.medioPago || "—"} (abonado)</td></tr>`;
  const direccionBlock = esRetiro
    ? `<tr><td style="padding:6px 0;color:#666;">🏪 Retirar en:</td><td style="padding:6px 0;text-align:right;">${direccionLocal}</td></tr>`
    : `<tr><td style="padding:6px 0;color:#666;">📍 Dirección de entrega:</td><td style="padding:6px 0;text-align:right;">${pedido.direccion || ""}${pedido.barrio ? ", " + pedido.barrio : ""}</td></tr>`;
  const notaBlock = pedido.nota ? `<tr><td colspan="2" style="padding:10px 0;color:#666;font-style:italic;border-top:1px solid #eee;">📝 Nota: ${pedido.nota}</td></tr>` : "";
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:${COLOR_NARANJA};padding:30px 24px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:28px;">Piccadely</h1>
      <p style="margin:8px 0 0;color:#ffffff;font-size:14px;">Confirmación de pedido</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 8px;font-size:16px;color:#333;">Hola <strong>${pedido.cliente || ""}</strong>,</p>
      <p style="margin:0 0 20px;font-size:14px;color:#555;line-height:1.5;">Gracias por tu pedido en Piccadely. Confirmamos los siguientes datos:</p>
      <div style="background:#fafafa;border:1px solid #eee;border-radius:6px;padding:18px 20px;">
        <h2 style="margin:0 0 14px;color:${COLOR_NARANJA};font-size:16px;">📋 Pedido ${pedido.numero || ""}</h2>
        <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;">
          <tr><td style="padding:6px 0;color:#666;">📅 Entrega:</td><td style="padding:6px 0;text-align:right;text-transform:capitalize;">${fechaTxt}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">🕐 Horario:</td><td style="padding:6px 0;text-align:right;">${pedido.franjaDisplay || pedido.franja || "A confirmar"}</td></tr>
          ${direccionBlock}
          <tr><td style="padding:6px 0;color:#666;">🏪 Sucursal:</td><td style="padding:6px 0;text-align:right;">${pedido.local || ""}</td></tr>
          ${notaBlock}
        </table>
        <h3 style="margin:18px 0 8px;color:#333;font-size:14px;">🛒 Productos:</h3>
        <ul style="margin:0 0 14px;padding-left:20px;color:#333;font-size:14px;">${productosLista}</ul>
        <table style="width:100%;font-size:14px;color:#333;border-collapse:collapse;border-top:2px solid ${COLOR_NARANJA};margin-top:14px;">
          <tr><td style="padding:10px 0 6px;color:#666;font-weight:bold;">Total:</td><td style="padding:10px 0 6px;text-align:right;font-weight:bold;font-size:16px;">${formatoPesos(pedido.totalNum || pedido.total_num)}</td></tr>
          ${cobrarBlock}
        </table>
      </div>
      <p style="margin:22px 0 6px;font-size:14px;color:#555;line-height:1.5;">Si tenés alguna duda, respondé este mail o escribinos al WhatsApp <strong>${WHATSAPP_PICCADELY}</strong>.</p>
      <p style="margin:14px 0 0;font-size:13px;color:${COLOR_NARANJA};font-style:italic;text-align:center;font-weight:bold;">Si hay piccada, que sea Piccadely. Piccadely, con doble C.</p>
    </div>
    <div style="background:#f5f5f5;padding:16px 24px;text-align:center;color:#999;font-size:11px;">Piccadely · ${DIRECCION_A_THOMAS} · ${DIRECCION_FRENCH}</div>
  </div>
</body></html>`;
}

function htmlMailAnulacion(pedido) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;background:#ffffff;">
    <div style="background:${COLOR_NARANJA};padding:30px 24px;text-align:center;">
      <h1 style="margin:0;color:#ffffff;font-size:28px;">Piccadely</h1>
      <p style="margin:8px 0 0;color:#ffffff;font-size:14px;">Pedido cancelado</p>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 12px;font-size:16px;color:#333;">Hola <strong>${pedido.cliente || ""}</strong>,</p>
      <p style="margin:0 0 16px;font-size:14px;color:#555;line-height:1.5;">Te confirmamos que tu pedido <strong>${pedido.numero || ""}</strong> fue cancelado.</p>
      <p style="margin:0 0 16px;font-size:14px;color:#555;line-height:1.5;">Si esto fue un error o tenés consultas, respondé este mail o escribinos al WhatsApp <strong>${WHATSAPP_PICCADELY}</strong>.</p>
      <p style="margin:20px 0 0;font-size:13px;color:${COLOR_NARANJA};font-style:italic;text-align:center;font-weight:bold;">Si hay piccada, que sea Piccadely. Piccadely, con doble C.</p>
    </div>
    <div style="background:#f5f5f5;padding:16px 24px;text-align:center;color:#999;font-size:11px;">Piccadely · ${DIRECCION_A_THOMAS} · ${DIRECCION_FRENCH}</div>
  </div>
</body></html>`;
}

async function enviarMailConfirmacion(pedido) {
  if (!mailTransporter || !pedido.email) return;
  try {
    await mailTransporter.sendMail({ from: `Piccadely <${process.env.GMAIL_USER}>`, to: pedido.email, subject: `Piccadely · Confirmación de tu pedido ${pedido.numero || ""}`, html: htmlMailConfirmacion(pedido) });
    console.log(`✉ Mail confirmación enviado a ${pedido.email} para pedido ${pedido.numero}`);
  } catch (err) { console.error(`Error enviando confirmación:`, err.message); }
}

async function enviarMailAnulacion(pedido) {
  if (!mailTransporter || !pedido.email) return;
  try {
    await mailTransporter.sendMail({ from: `Piccadely <${process.env.GMAIL_USER}>`, to: pedido.email, subject: `Piccadely · Pedido ${pedido.numero || ""} cancelado`, html: htmlMailAnulacion(pedido) });
    console.log(`✉ Mail anulación enviado a ${pedido.email} para pedido ${pedido.numero}`);
  } catch (err) { console.error(`Error enviando anulación:`, err.message); }
}

// ─── MERCADO PAGO ─────────────────────────────────────────────────────
app.use("/api/mp", mpRouter(pool, mailTransporter));
app.use("/api/bot", botWhatsappRouter());
app.use("/api", cotizadorRouter(pool, mailTransporter));

 // ─── ORDERS ───────────────────────────────────────────────────────────
app.get("/api/orders", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT t.data
      FROM pedidos_tn t
      LEFT JOIN pedidos_estados e ON e.id::text = t.id::text
      WHERE COALESCE(e.estado, '') NOT IN ('Entregado', 'Anulado')
         OR t.tn_created_at > NOW() - INTERVAL '7 days'
      ORDER BY t.tn_created_at DESC
    `);

    if (result.rows.length === 0) {
      const check = await pool.query("SELECT 1 FROM pedidos_tn LIMIT 1");
      if (check.rows.length === 0) {
        // Fallback a TN solo si la integración está configurada (en staging no).
        if (!TN_ENABLED) { console.warn("⚠️ Tienda Nube no configurada: /api/orders devuelve []"); return res.json([]); }
        const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/orders?aggregates=fulfillment_orders`, { headers });
        return res.json(r.data);
      }
    }

    res.json(result.rows.map(r => r.data));
  } catch (err) {
    console.error("Error /api/orders:", err.message);
    res.status(500).json({ error: "Error trayendo pedidos" });
  }
});

// ─── REPORTES: pedidos por rango de fechas (histórico, lee toda la base) ──
// A diferencia de /api/orders (ventana de 7 días para el panel operativo),
// este endpoint lee TODA la base y porta la misma lógica de procesamiento
// del front (useMemo pedidosProcesados) para que un pedido dé idéntico acá.
app.get("/api/reportes/pedidos", async (req, res) => {
  const { desde, hasta } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!desde || !hasta || !re.test(desde) || !re.test(hasta)) {
    return res.status(400).json({ error: "Parámetros 'desde' y 'hasta' requeridos (formato YYYY-MM-DD)" });
  }
  if (desde > hasta) {
    return res.status(400).json({ error: "'desde' no puede ser posterior a 'hasta'" });
  }
  // OPT-IN: sin el parámetro, comportamiento idéntico (solo Entregado/Anulado).
  // Con incluirActivos=1 también devuelve los no finalizados (Por empaquetar/Listo/
  // En camino) con su estado vivo, para el reporte fusionado.
  const incluirActivos = req.query.incluirActivos === "1" || req.query.incluirActivos === "true";
  try {
    // Estados (incluye overrides de datos) — keyed por id (texto)
    const estadosRes = await pool.query("SELECT * FROM pedidos_estados");
    const estadosMap = {};
    estadosRes.rows.forEach(r => {
      estadosMap[r.id] = {
        estado: r.estado, repartidor: r.repartidor, tabManual: r.tab_manual,
        fechaManual: r.fecha_manual, franjaManual: r.franja_manual, cobrar: r.cobrar,
        clienteOverride: r.cliente_override, telefonoOverride: r.telefono_override,
        direccionOverride: r.direccion_override, barrioOverride: r.barrio_override,
        zonaOverride: r.zona_override, medioPagoOverride: r.medio_pago_override,
        notaOverride: r.nota_override, emailOverride: r.email_override,
        codigoPagoOverride: r.codigo_pago_override, medioPagoOtroOverride: r.medio_pago_otro_override,
        motivoAnulacion: r.motivo_anulacion || null,
      };
    });
    // Overrides de productos/total
    const overridesRes = await pool.query("SELECT * FROM pedidos_productos");
    const overridesMap = {};
    overridesRes.rows.forEach(r => { overridesMap[r.pedido_id] = { productos: r.productos, total_num: Number(r.total_num) }; });

    // Pedidos TN dentro del margen [desde - 30d, hasta + 5d] (la fecha de
    // entrega/fecha_manual puede diferir de la de creación).
    const tnRes = await pool.query(
      `SELECT t.data
       FROM pedidos_tn t
       WHERE t.tn_created_at BETWEEN ($1::date - INTERVAL '30 days') AND ($2::date + INTERVAL '5 days')
       ORDER BY t.tn_created_at DESC`,
      [desde, hasta]
    );

    const resultado = [];

    for (const row of tnRes.rows) {
      const p = row.data;
      const est = estadosMap[String(p.id)] || {};
      const estado = est.estado || "Por empaquetar";
      if (!incluirActivos && estado !== "Entregado" && estado !== "Anulado") continue;
      const { fecha, franja } = parsearFranjaBackend(p.owner_note);
      const fechaDisplay = est.fechaManual || fecha;
      if (!fechaDisplay || fechaDisplay < desde || fechaDisplay > hasta) continue;
      const tabAuto = clasificarPedidoBackend(p);
      const tabActual = est.tabManual || tabAuto;
      const ov = overridesMap[String(p.id)];
      const totalNum = ov ? Number(ov.total_num) : Number(p.total);
      const codigoPago = est.codigoPagoOverride
        ? est.codigoPagoOverride
        : (p.gateway_id ? String(p.gateway_id) : (p.transactions?.[0]?.id ? String(p.transactions[0].id) : ""));
      resultado.push({
        id: String(p.id), numero: `#${p.number}`,
        cliente: est.clienteOverride || p.contact_name || "",
        telefono: est.telefonoOverride || p.contact_phone || "",
        productos: ov ? ov.productos : (p.products || []).map(pr => `${pr.name} x${pr.quantity}`).join(", "),
        totalNum,
        total: `$${totalNum.toLocaleString("es-AR")}`,
        medioPago: est.medioPagoOverride || medioPagoLabelBackend(p.gateway),
        medioPagoOtro: est.medioPagoOtroOverride || "",
        codigoPago,
        repartidor: est.repartidor || "Sin asignar",
        estado,
        local: localLabelBackend(tabActual),
        tabActual,
        zona: est.zonaOverride || p.fulfillments?.[0]?.shipping?.option?.name || "Sin zona",
        fechaDisplay,
        franjaDisplay: est.franjaManual || franja || "Sin franja",
        esManual: false, esCorporativo: false, motivoAnulacion: est.motivoAnulacion || null,
        cobrar: !!est.cobrar,
        pago: p.payment_status === "paid" ? "Pagado" : "Pendiente",
        direccion: est.direccionOverride || `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}${p.shipping_address?.floor ? ` ${p.shipping_address.floor}` : ""}`.trim(),
        barrio: est.barrioOverride || p.shipping_address?.locality || p.shipping_address?.city || "",
        entreCalles: "",
        email: (est.emailOverride !== undefined && est.emailOverride !== null) ? est.emailOverride : (p.contact_email || ""),
        nota: (est.notaOverride !== undefined && est.notaOverride !== null) ? est.notaOverride : (p.note || ""),
        transaccionMP: p.gateway_id || p.transactions?.[0]?.id || null,
      });
    }

    // Manuales — son livianos; se traen todos y se filtran por fechaDisplay.
    const manualesRes = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    for (const r of manualesRes.rows) {
      const est = estadosMap[r.id] || {};
      const estado = est.estado || "Por empaquetar";
      if (!incluirActivos && estado !== "Entregado" && estado !== "Anulado") continue;
      const fechaDisplay = est.fechaManual || r.fecha;
      if (!fechaDisplay || fechaDisplay < desde || fechaDisplay > hasta) continue;
      const tabActual = est.tabManual || r.tab_actual;
      const ov = overridesMap[r.id];
      const totalNum = ov ? Number(ov.total_num) : Number(r.total_num);
      const codigoPago = est.codigoPagoOverride ? est.codigoPagoOverride : (r.codigo_pago || "");
      resultado.push({
        id: r.id, numero: r.numero,
        cliente: est.clienteOverride || r.cliente || "",
        telefono: est.telefonoOverride || r.telefono || "",
        productos: ov ? ov.productos : r.productos,
        totalNum,
        total: ov ? `$${totalNum.toLocaleString("es-AR")}` : r.total,
        medioPago: est.medioPagoOverride || r.medio_pago,
        medioPagoOtro: est.medioPagoOtroOverride || "",
        codigoPago,
        repartidor: est.repartidor || "Sin asignar",
        estado,
        local: localLabelBackend(tabActual),
        tabActual,
        zona: est.zonaOverride || r.zona || "",
        fechaDisplay,
        franjaDisplay: est.franjaManual || r.franja || "Sin franja",
        esManual: true, esCorporativo: !!r.es_corporativo, motivoAnulacion: est.motivoAnulacion || null,
        cobrar: (est.cobrar !== undefined && est.cobrar !== null) ? !!est.cobrar : !!r.cobrar,
        pago: r.pago,
        direccion: est.direccionOverride || r.direccion || "",
        barrio: est.barrioOverride || r.barrio || "",
        entreCalles: r.entre_calles || "",
        email: (est.emailOverride !== undefined && est.emailOverride !== null) ? est.emailOverride : (r.email || ""),
        nota: (est.notaOverride !== undefined && est.notaOverride !== null) ? est.notaOverride : (r.nota || ""),
        transaccionMP: null,
      });
    }

    res.json(resultado);
  } catch (err) {
    console.error("Error /api/reportes/pedidos:", err.message);
    res.status(500).json({ error: "Error trayendo reporte de pedidos" });
  }
});

// ─── REPORTE: PEDIDOS POR REPARTIDOR Y ZONA GEOGRÁFICA ────────────────
// Cuenta pedidos ENTREGADOS de delivery por repartidor y por área (polígono).
// Solo lectura: reconstruye el address_key igual que el mapa y busca lat/lng en
// geocoding_cache (sin llamar a Google). Point-in-polygon contra areas_poligonos.json.

// Carga SEGURA de los polígonos: si falta el archivo, el server NO cae; el endpoint
// responde 503. Reemplazá con el JSON real en la carpeta del backend.
let AREAS_POLIGONOS = null;
try {
  AREAS_POLIGONOS = requireCJS("./areas_poligonos.json");
} catch (e) {
  console.warn("⚠️ areas_poligonos.json no encontrado: /api/reportes/zonas deshabilitado hasta agregarlo.");
}

// Costo por área (1-10) desde la tabla costos_areas. Fallback 1 si falta un área.
async function cargarCostosAreas() {
  const map = {};
  for (let n = 1; n <= 10; n++) map[String(n)] = 1;
  try {
    const r = await pool.query("SELECT area, costo FROM costos_areas");
    r.rows.forEach(row => { map[String(row.area)] = Number(row.costo); });
  } catch (e) { console.error("cargarCostosAreas:", e.message); }
  return map;
}

// Ray casting. Polígono = lista de puntos [lon, lat]. lng = X, lat = Y (ojo el orden).
function puntoEnPoligono(lat, lng, poligono) {
  let dentro = false;
  for (let i = 0, j = poligono.length - 1; i < poligono.length; j = i++) {
    const xi = poligono[i][0], yi = poligono[i][1]; // [lon, lat]
    const xj = poligono[j][0], yj = poligono[j][1];
    const intersecta = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi);
    if (intersecta) dentro = !dentro;
  }
  return dentro;
}

// Área (1-10) del punto o null. Recorre 1→10 y devuelve la PRIMERA que matchee
// (número más bajo). Un área matchea si el punto cae en CUALQUIERA de sus polígonos.
function areaDePunto(lat, lng) {
  if (!AREAS_POLIGONOS) return null;
  for (let n = 1; n <= 10; n++) {
    const poligonos = AREAS_POLIGONOS[String(n)];
    if (!Array.isArray(poligonos)) continue;
    for (const poly of poligonos) {
      if (Array.isArray(poly) && poly.length >= 3 && puntoEnPoligono(lat, lng, poly)) return n;
    }
  }
  return null;
}

// GET /api/costos-areas -> { "1": costo, ..., "10": costo } (fallback 1 por área).
app.get("/api/costos-areas", async (req, res) => {
  try {
    res.json(await cargarCostosAreas());
  } catch (err) { console.error("Error GET /api/costos-areas:", err.message); res.status(500).json({ error: "Error trayendo costos de áreas" }); }
});

// PATCH /api/costos-areas -> body { costos: { "1": num, ..., "10": num } }. Cada valor
// debe ser número finito >= 0. Upsert por área.
app.patch("/api/costos-areas", async (req, res) => {
  const costos = req.body?.costos;
  if (!costos || typeof costos !== "object") {
    return res.status(400).json({ error: "Falta 'costos' (objeto { \"1\"..\"10\": número })" });
  }
  for (let n = 1; n <= 10; n++) {
    const v = Number(costos[String(n)]);
    if (!Number.isFinite(v) || v < 0) {
      return res.status(400).json({ error: `Costo inválido para área ${n} (debe ser número >= 0)` });
    }
  }
  try {
    for (let n = 1; n <= 10; n++) {
      await pool.query(
        "INSERT INTO costos_areas (area, costo) VALUES ($1, $2) ON CONFLICT (area) DO UPDATE SET costo = EXCLUDED.costo",
        [n, Number(costos[String(n)])]
      );
    }
    res.json({ ok: true, costos: await cargarCostosAreas() });
  } catch (err) { console.error("Error PATCH /api/costos-areas:", err.message); res.status(500).json({ error: "Error guardando costos de áreas" }); }
});

app.get("/api/reportes/zonas", async (req, res) => {
  const { desde, hasta } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!desde || !hasta || !re.test(desde) || !re.test(hasta)) {
    return res.status(400).json({ error: "Parámetros 'desde' y 'hasta' requeridos (formato YYYY-MM-DD)" });
  }
  if (desde > hasta) {
    return res.status(400).json({ error: "'desde' no puede ser posterior a 'hasta'" });
  }
  if (!AREAS_POLIGONOS) {
    return res.status(503).json({ error: "areas_poligonos.json no está disponible en el backend." });
  }
  try {
    // Estados: repartidor + fecha/tab (keyed por id texto).
    const estadosRes = await pool.query("SELECT id, estado, repartidor, fecha_manual, tab_manual FROM pedidos_estados");
    const estadosMap = {};
    estadosRes.rows.forEach(r => { estadosMap[r.id] = { estado: r.estado, repartidor: r.repartidor, fechaManual: r.fecha_manual, tabManual: r.tab_manual }; });

    // Cache de geocoding: address_key -> {lat,lng}. Una sola query, sin llamar a Google.
    const geoRes = await pool.query("SELECT address_key, lat, lng FROM geocoding_cache");
    const geoMap = {};
    geoRes.rows.forEach(r => { geoMap[r.address_key] = { lat: Number(r.lat), lng: Number(r.lng) }; });

    // Costos por área (desde la tabla, fallback 1). Una sola lectura.
    const costoMap = await cargarCostosAreas();

    // Acumulador por repartidor (texto tal cual, sin joinear con la tabla repartidores)
    // + lista de pedidos (detalle por pedido para el Excel).
    const porRepartidor = {};
    const pedidos = [];
    const nuevoRep = () => {
      const o = { sin_coordenada: 0, fuera_de_area: 0, total_pedidos: 0, total_costo: 0 };
      for (let n = 1; n <= 10; n++) o["area" + n] = 0;
      return o;
    };
    // direccion/barrio LEGIBLES (crudos); addressKey ya viene normalizado (lower+trim).
    const procesar = ({ numero, direccion, barrio, repartidor, addressKey, fechaDisplay }) => {
      const rep = repartidor || "Sin asignar";
      if (!porRepartidor[rep]) porRepartidor[rep] = nuevoRep();
      const acc = porRepartidor[rep];
      acc.total_pedidos++;
      let area = null, motivo = null;
      const geo = geoMap[addressKey];
      if (!geo) { acc.sin_coordenada++; motivo = "sin_coordenada"; }
      else {
        area = areaDePunto(geo.lat, geo.lng);
        if (area == null) { acc.fuera_de_area++; motivo = "fuera_de_area"; }
        else { acc["area" + area]++; acc.total_costo += (costoMap[String(area)] || 0); }
      }
      pedidos.push({ numero, direccion, barrio, repartidor: rep, area, motivo, fecha: fechaDisplay });
    };

    // TN — ventana amplia por fecha de creación; se filtra por fechaDisplay del rango.
    const tnRes = await pool.query(
      `SELECT t.data FROM pedidos_tn t
       WHERE t.tn_created_at BETWEEN ($1::date - INTERVAL '30 days') AND ($2::date + INTERVAL '5 days')
       ORDER BY t.tn_created_at DESC`,
      [desde, hasta]
    );
    for (const row of tnRes.rows) {
      const p = row.data;
      const est = estadosMap[String(p.id)] || {};
      if ((est.estado || "Por empaquetar") !== "Entregado") continue;
      const { fecha } = parsearFranjaBackend(p.owner_note);
      const fechaDisplay = est.fechaManual || fecha;
      if (!fechaDisplay || fechaDisplay < desde || fechaDisplay > hasta) continue;
      const tabActual = est.tabManual || clasificarPedidoBackend(p);
      if (String(tabActual || "").startsWith("retiro")) continue; // solo delivery
      const dir = `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}`.trim();
      const barrio = p.shipping_address?.locality || p.shipping_address?.city || "";
      const addressKey = `${dir}, ${barrio}, Buenos Aires, Argentina`.toLowerCase().trim();
      procesar({ numero: `#${p.number}`, direccion: dir, barrio, repartidor: est.repartidor, addressKey, fechaDisplay });
    }

    // Manuales
    const manualesRes = await pool.query("SELECT id, numero, direccion, barrio, fecha, tab_actual FROM pedidos_manuales");
    for (const p of manualesRes.rows) {
      const est = estadosMap[p.id] || {};
      if ((est.estado || "Por empaquetar") !== "Entregado") continue;
      const fechaDisplay = est.fechaManual || p.fecha;
      if (!fechaDisplay || fechaDisplay < desde || fechaDisplay > hasta) continue;
      const tabActual = est.tabManual || p.tab_actual;
      if (String(tabActual || "").startsWith("retiro")) continue; // solo delivery
      const dir = p.direccion || "";
      const barrio = p.barrio || "";
      const addressKey = `${dir}, ${barrio}, Buenos Aires, Argentina`.toLowerCase().trim();
      procesar({ numero: p.numero, direccion: dir, barrio, repartidor: est.repartidor, addressKey, fechaDisplay });
    }

    // Filas por repartidor (orden alfabético) + totales por columna + gran total.
    const repartidores = Object.keys(porRepartidor)
      .sort((a, b) => a.localeCompare(b))
      .map(nombre => ({ repartidor: nombre, ...porRepartidor[nombre] }));
    const totales = nuevoRep();
    for (const r of repartidores) {
      for (let n = 1; n <= 10; n++) totales["area" + n] += r["area" + n];
      totales.sin_coordenada += r.sin_coordenada;
      totales.fuera_de_area += r.fuera_de_area;
      totales.total_pedidos += r.total_pedidos;
      totales.total_costo += r.total_costo;
    }
    res.json({ desde, hasta, costoArea: costoMap, repartidores, totales, pedidos });
  } catch (err) {
    console.error("Error /api/reportes/zonas:", err.message);
    res.status(500).json({ error: "Error generando reporte de zonas" });
  }
});

  app.get("/api/products", async (req, res) => {
    if (!TN_ENABLED) { console.warn("⚠️ Tienda Nube no configurada: /api/products devuelve []"); return res.json([]); }
    try {
      const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`, { headers });
      res.json(r.data);
    } catch (err) { res.status(500).json({ error: "Error trayendo productos" }); }
  });

  app.get("/api/categories", async (req, res) => {
    if (!TN_ENABLED) { console.warn("⚠️ Tienda Nube no configurada: /api/categories devuelve []"); return res.json([]); }
    try {
      const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/categories`, { headers });
      res.json(r.data);
    } catch (err) { res.status(500).json({ error: "Error trayendo categorías" }); }
  });

  // ─── ESTADOS ──────────────────────────────────────────────────────────
  app.get("/api/estados", async (req, res) => {
    try {
      const result = await pool.query("SELECT * FROM pedidos_estados");
      const estados = {};
      result.rows.forEach(r => {
        estados[r.id] = {
          estado: r.estado, repartidor: r.repartidor,
          tabManual: r.tab_manual, fechaManual: r.fecha_manual,
          franjaManual: r.franja_manual, cobrar: r.cobrar,
          clienteOverride: r.cliente_override, telefonoOverride: r.telefono_override,
          direccionOverride: r.direccion_override, barrioOverride: r.barrio_override,
          zonaOverride: r.zona_override, medioPagoOverride: r.medio_pago_override,
          notaOverride: r.nota_override, emailOverride: r.email_override,
          codigoPagoOverride: r.codigo_pago_override,
          medioPagoOtroOverride: r.medio_pago_otro_override,
          comandasImpresas: r.comandas_impresas || 0,
          sobre: r.sobre || false,
          tarjeta: r.tarjeta || "no",
          tandaId: r.tanda_id ?? null,
      };
    });
    res.json(estados);
  } catch (err) { res.status(500).json({ error: "Error trayendo estados" }); }
});

app.post("/api/estados/:id", async (req, res) => {
  const { id } = req.params;
const { estado, repartidor, tabManual, fechaManual, franjaManual, cobrar, silencioso, motivoAnulacion, usuario: usuarioAudit } = req.body;  try {
    // Leer estado previo para auditoria
    const previo = await pool.query("SELECT * FROM pedidos_estados WHERE id=$1", [id]);
    const prevData = previo.rows[0] || {};

    // Motivo de anulación: solo se setea cuando el estado es "Anulado". En cualquier
    // otro cambio de estado va null -> el COALESCE/NULLIF del upsert conserva el existente.
    const motivoParam = (estado === "Anulado" && motivoAnulacion && motivoAnulacion.trim())
      ? motivoAnulacion.trim() : null;

    let mailAnularPedido = null;
    if (estado === "Anulado") {
      if (prevData.estado !== "Anulado") {
        const manual = await pool.query("SELECT * FROM pedidos_manuales WHERE id=$1", [id]);
        if (manual.rows[0] && manual.rows[0].email) {
          mailAnularPedido = { numero: manual.rows[0].numero, cliente: manual.rows[0].cliente, email: manual.rows[0].email };
        }
      }
    }
    await pool.query(`
      INSERT INTO pedidos_estados (id, estado, repartidor, tab_manual, fecha_manual, franja_manual, cobrar, motivo_anulacion, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
      ON CONFLICT (id) DO UPDATE SET
        estado=EXCLUDED.estado, repartidor=EXCLUDED.repartidor,
        -- Overrides de texto: si el front manda vacío/null (copia local stale), NO pisar lo guardado.
        tab_manual=COALESCE(NULLIF(EXCLUDED.tab_manual,''), pedidos_estados.tab_manual),
        fecha_manual=COALESCE(NULLIF(EXCLUDED.fecha_manual,''), pedidos_estados.fecha_manual),
        franja_manual=COALESCE(NULLIF(EXCLUDED.franja_manual,''), pedidos_estados.franja_manual),
        -- Motivo: solo se actualiza si vino uno nuevo (anulación); otros cambios no lo pisan.
        motivo_anulacion=COALESCE(NULLIF(EXCLUDED.motivo_anulacion,''), pedidos_estados.motivo_anulacion),
        cobrar=EXCLUDED.cobrar, updated_at=NOW()
    `, [id, estado, repartidor, tabManual, fechaManual, franjaManual, cobrar, motivoParam]);
if (mailAnularPedido && !silencioso) enviarMailAnulacion(mailAnularPedido).catch(console.error);
    res.json({ ok: true });

    // Hook de stock: al "salir" el pedido (En camino / Entregado) se descuenta del
    // stock del local (idempotente vía stock_descontado). No bloquea la respuesta.
    if (estado === "En camino" || estado === "Entregado") descontarStockDePedidoTx(id).catch(err => console.error("stock descuento falló:", err));

    // Auditoria (no bloquea la respuesta)
    if (estado && estado !== prevData.estado) registrarAuditoria(usuarioAudit, "cambio_estado", "pedido", id, { anterior: prevData.estado || "Por empaquetar", nuevo: estado });
    if (estado === "Anulado" && prevData.estado !== "Anulado") registrarAuditoria(usuarioAudit, "anulacion", "pedido", id, { motivo: motivoParam });
    if (fechaManual && fechaManual !== prevData.fecha_manual) registrarAuditoria(usuarioAudit, "cambio_fecha", "pedido", id, { anterior: prevData.fecha_manual, nuevo: fechaManual });
    if (franjaManual && franjaManual !== prevData.franja_manual) registrarAuditoria(usuarioAudit, "cambio_franja", "pedido", id, { anterior: prevData.franja_manual, nuevo: franjaManual });
  } catch (err) { res.status(500).json({ error: "Error guardando estado" }); }
});
// ─── CONTADOR DE COMANDAS IMPRESAS ────────────────────────────────────
app.post("/api/pedidos/:id/imprimir", async (req, res) => {
  const { id } = req.params;
  const { usuario: usuarioAudit } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO pedidos_estados (id, comandas_impresas, updated_at)
       VALUES ($1, 1, NOW())
       ON CONFLICT (id) DO UPDATE SET comandas_impresas = COALESCE(pedidos_estados.comandas_impresas, 0) + 1, updated_at = NOW()
       RETURNING comandas_impresas`,
      [id]
    );
    const nuevoValor = result.rows[0]?.comandas_impresas || 1;
    res.json({ ok: true, comandasImpresas: nuevoValor });
    registrarAuditoria(usuarioAudit, "impresion_comanda", "pedido", id, { total: nuevoValor });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// ─── MARCADOR "SOBRE" (avisado) POR PEDIDO ───────────────────────────
// Toggle persistente y compartido. UPSERT sobre la misma clave (id) que el
// resto de los overrides de pedidos_estados. Misma auth que /api/estados.
app.patch("/api/orders/:id/sobre", async (req, res) => {
  const { id } = req.params;
  const sobre = !!req.body.sobre;
  try {
    await pool.query(
      `INSERT INTO pedidos_estados (id, sobre, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET sobre = EXCLUDED.sobre, updated_at = NOW()`,
      [id, sobre]
    );
    res.json({ ok: true, sobre });
  } catch (err) { res.status(500).json({ error: "Error guardando sobre" }); }
});

// ─── MARCADOR "TARJETA DE REGALO" POR PEDIDO (3 estados) ─────────────
// Reemplaza al de "sobre". Valores: 'no' | 'pendiente' | 'hecha'. Upsert de UNA sola
// columna con el mismo patrón anti-clobber: NO pisa estado/repartidor/overrides.
app.patch("/api/orders/:id/tarjeta", async (req, res) => {
  const { id } = req.params;
  const { tarjeta } = req.body;
  if (!["no", "pendiente", "hecha"].includes(tarjeta)) {
    return res.status(400).json({ error: "tarjeta inválida (debe ser 'no', 'pendiente' o 'hecha')" });
  }
  try {
    await pool.query(
      `INSERT INTO pedidos_estados (id, tarjeta, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET tarjeta = EXCLUDED.tarjeta, updated_at = NOW()`,
      [id, tarjeta]
    );
    res.json({ ok: true, tarjeta });
  } catch (err) { res.status(500).json({ error: "Error guardando tarjeta" }); }
});
// ─── TANDAS DE REPARTO (Fase 1) ──────────────────────────────────────
// Membresía por pedido vía pedidos_estados.tanda_id (un pedido = una tanda).
// El upsert de tanda_id NO toca estado/repartidor/sobre ni ningún otro override:
// en una fila existente sólo actualiza tanda_id; en una fila nueva, las demás
// columnas toman su DEFAULT (mismo patrón de una sola columna que el upsert de
// comandas_impresas y el de sobre). Un pedido finalizado siempre tiene fila
// previa, así que cae por la rama ON CONFLICT y nunca se "reactiva".
async function setTandaIdPedido(id, tandaId) {
  await pool.query(
    `INSERT INTO pedidos_estados (id, tanda_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (id) DO UPDATE SET tanda_id = EXCLUDED.tanda_id, updated_at = NOW()`,
    [id, tandaId]
  );
}

app.get("/api/tandas", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM tandas ORDER BY id DESC");
    res.json(r.rows.map(t => ({ id: t.id, nombre: t.nombre, repartidor: t.repartidor, local: t.local, estado: t.estado, createdAt: t.created_at })));
  } catch (err) { res.status(500).json({ error: "Error trayendo tandas" }); }
});

app.post("/api/tandas", async (req, res) => {
  const { nombre, repartidor, local, pedidoIds, usuario: usuarioAudit } = req.body;
  if (!repartidor || !Array.isArray(pedidoIds) || pedidoIds.length === 0) {
    return res.status(400).json({ error: "repartidor y pedidoIds son requeridos" });
  }
  try {
    const ins = await pool.query(
      `INSERT INTO tandas (nombre, repartidor, local, estado) VALUES ($1,$2,$3,'armada') RETURNING *`,
      [nombre || null, repartidor, local || null]
    );
    const t = ins.rows[0];
    for (const pid of pedidoIds) await setTandaIdPedido(String(pid), t.id);
    res.json({ id: t.id, nombre: t.nombre, repartidor: t.repartidor, local: t.local, estado: t.estado, createdAt: t.created_at });
    registrarAuditoria(usuarioAudit, "tanda_creada", "tanda", String(t.id), { repartidor, local, pedidos: pedidoIds.length });
  } catch (err) { console.error("Error POST /api/tandas:", err.message); res.status(500).json({ error: "Error creando tanda" }); }
});

app.patch("/api/tandas/:id", async (req, res) => {
  const { id } = req.params;
  const { estado, nombre, repartidor, usuario: usuarioAudit } = req.body;
  try {
    const cur = await pool.query("SELECT * FROM tandas WHERE id=$1", [id]);
    if (!cur.rows[0]) return res.status(404).json({ error: "Tanda no encontrada" });
    const tanda = cur.rows[0];

    if (nombre !== undefined) await pool.query("UPDATE tandas SET nombre=$1 WHERE id=$2", [nombre, id]);

    // Reasignar repartidor: tanda + repartidor de sus pedidos (sólo esa columna)
    if (repartidor !== undefined && repartidor !== null) {
      await pool.query("UPDATE tandas SET repartidor=$1 WHERE id=$2", [repartidor, id]);
      await pool.query("UPDATE pedidos_estados SET repartidor=$1, updated_at=NOW() WHERE tanda_id=$2", [repartidor, id]);
    }

    // Transiciones de estado de la tanda (y de sus pedidos donde corresponde)
    if (estado) {
      await pool.query("UPDATE tandas SET estado=$1 WHERE id=$2", [estado, id]);
      const rep = (repartidor !== undefined && repartidor !== null) ? repartidor : tanda.repartidor;
      if (estado === "en_reparto") {
        // Despachar: pedidos a "En camino" con el repartidor de la tanda (no toca otros overrides)
        await pool.query("UPDATE pedidos_estados SET estado='En camino', repartidor=$1, updated_at=NOW() WHERE tanda_id=$2", [rep, id]);
        // Hook de stock: cada pedido de la tanda "sale" -> descontar (idempotente).
        const despachados = await pool.query("SELECT id FROM pedidos_estados WHERE tanda_id=$1", [id]);
        for (const row of despachados.rows) descontarStockDePedidoTx(row.id).catch(err => console.error("stock descuento falló:", err));
      } else if (estado === "entregada") {
        await pool.query("UPDATE pedidos_estados SET estado='Entregado', updated_at=NOW() WHERE tanda_id=$1", [id]);
        // Hook de stock: cubre el salto directo armada -> entregada (sin en_reparto).
        // Si ya pasó por en_reparto, el claim idempotente lo frena (no descuenta doble).
        const entregados = await pool.query("SELECT id FROM pedidos_estados WHERE tanda_id=$1", [id]);
        for (const row of entregados.rows) descontarStockDePedidoTx(row.id).catch(err => console.error("stock descuento falló:", err));
      } else if (estado === "cancelada") {
        // Deshacer: liberar los pedidos (vuelven al pool), sin tocar su estado
        await pool.query("UPDATE pedidos_estados SET tanda_id=NULL, updated_at=NOW() WHERE tanda_id=$1", [id]);
      }
    }

    const upd = await pool.query("SELECT * FROM tandas WHERE id=$1", [id]);
    const t = upd.rows[0];
    res.json({ id: t.id, nombre: t.nombre, repartidor: t.repartidor, local: t.local, estado: t.estado, createdAt: t.created_at });
    registrarAuditoria(usuarioAudit, "tanda_actualizada", "tanda", String(id), { estado, nombre, repartidor });
  } catch (err) { console.error("Error PATCH /api/tandas:", err.message); res.status(500).json({ error: "Error actualizando tanda" }); }
});

// Quitar/asignar UN pedido suelto: tandaId null lo saca de la tanda (vuelve al pool)
app.patch("/api/orders/:id/tanda", async (req, res) => {
  const { id } = req.params;
  const tandaId = req.body.tandaId == null ? null : Number(req.body.tandaId);
  try {
    await setTandaIdPedido(String(id), tandaId);
    res.json({ ok: true, tandaId });
  } catch (err) { res.status(500).json({ error: "Error actualizando tanda del pedido" }); }
});

// Local + tanda actual de un pedido (para validar al agregarlo a una tanda).
// El local sale del tab (manual override o auto), igual criterio que /api/mapa.
async function localYTandaDePedido(id) {
  const est = await pool.query("SELECT tab_manual, tanda_id FROM pedidos_estados WHERE id=$1", [id]);
  const e = est.rows[0] || {};
  const tn = await pool.query("SELECT data FROM pedidos_tn WHERE id::text=$1", [id]);
  if (tn.rows[0]) {
    const tabActual = e.tab_manual || clasificarPedidoBackend(tn.rows[0].data);
    return { tandaId: e.tanda_id ?? null, local: localLabelBackend(tabActual) };
  }
  const man = await pool.query("SELECT tab_actual FROM pedidos_manuales WHERE id=$1", [id]);
  if (man.rows[0]) {
    const tabActual = e.tab_manual || man.rows[0].tab_actual;
    return { tandaId: e.tanda_id ?? null, local: localLabelBackend(tabActual) };
  }
  return null;
}

// Agregar 1+ pedidos a una tanda EXISTENTE (inverso del quitar). Mismo upsert de una
// sola columna (tanda_id = :id), no pisa estado/repartidor. Valida: tanda 'armada',
// cada pedido sin tanda y del mismo local. Los que no cumplen no se agregan.
app.post("/api/tandas/:id/pedidos", async (req, res) => {
  const { id } = req.params;
  const { pedidoIds, usuario: usuarioAudit } = req.body;
  if (!Array.isArray(pedidoIds) || pedidoIds.length === 0) {
    return res.status(400).json({ error: "pedidoIds requerido" });
  }
  try {
    const cur = await pool.query("SELECT * FROM tandas WHERE id=$1", [id]);
    const tanda = cur.rows[0];
    if (!tanda) return res.status(404).json({ error: "Tanda no encontrada" });
    if (tanda.estado !== "armada") return res.status(409).json({ error: "La tanda ya fue despachada; no se le pueden agregar pedidos." });

    const agregados = [], rechazados = [];
    for (const pid of pedidoIds) {
      const info = await localYTandaDePedido(String(pid));
      if (!info) { rechazados.push({ id: String(pid), motivo: "no encontrado" }); continue; }
      if (info.tandaId != null) { rechazados.push({ id: String(pid), motivo: "ya está en una tanda" }); continue; }
      if (info.local !== tanda.local) { rechazados.push({ id: String(pid), motivo: `otro local (${info.local})` }); continue; }
      await setTandaIdPedido(String(pid), Number(id));
      agregados.push(String(pid));
    }
    res.json({ ok: true, tandaId: Number(id), agregados, rechazados });
    if (agregados.length) registrarAuditoria(usuarioAudit, "tanda_pedidos_agregados", "tanda", String(id), { agregados: agregados.length, rechazados: rechazados.length });
  } catch (err) { console.error("Error POST /api/tandas/:id/pedidos:", err.message); res.status(500).json({ error: "Error agregando pedidos a la tanda" }); }
});

// ─── STOCK (lotes por producto/local + descuento automático al salir) ─
// La CLAVE de matcheo es el nombre del producto, parseado IGUAL que la vista
// `produccion` (App.jsx ~3566-3577): regex ^(.+) x(\d+)$ sobre el string de
// productos. El `local` del lote usa el mismo label que produccion (p.local):
// tab_manual override, o clasificarPedidoBackend + localLabelBackend.

// Port del parseo de produccion: "Nombre xN, Otro x2" -> [{clave, cantidad}].
// Ítems que no matchean el patrón "Nombre xN" se ignoran (igual que el front).
function parsearProductosBackend(productosStr) {
  const out = [];
  (productosStr || "").split(", ").forEach(item => {
    const m = item.match(/^(.+) x(\d+)$/);
    if (!m) return;
    // Clave canónica (unifica corto/largo del mismo producto físico) -> el stock
    // descuenta con la misma clave con la que cocina/producción agrupan.
    out.push({ clave: normalizarProducto(m[1].trim()), cantidad: Number(m[2]) });
  });
  return out;
}

// String de productos de un pedido, con la MISMA precedencia que el front
// (pedidosProcesados): override (pedidos_productos) > TN aplanado "name xN" >
// manual (campo productos).
async function productosStringDePedido(id, client = pool) {
  const ov = await client.query("SELECT productos FROM pedidos_productos WHERE pedido_id=$1", [id]);
  if (ov.rows[0]) return ov.rows[0].productos || "";
  const tn = await client.query("SELECT data FROM pedidos_tn WHERE id::text=$1", [id]);
  if (tn.rows[0]) return (tn.rows[0].data.products || []).map(pr => `${pr.name} x${pr.quantity}`).join(", ");
  const man = await client.query("SELECT productos FROM pedidos_manuales WHERE id=$1", [id]);
  if (man.rows[0]) return man.rows[0].productos || "";
  return "";
}

// Local (label) de un pedido, mismo criterio que /api/mapa y tandas
// (localYTandaDePedido): tab_manual override, o clasificación auto.
async function localDePedido(id, client = pool) {
  const est = await client.query("SELECT tab_manual FROM pedidos_estados WHERE id=$1", [id]);
  const tabManual = est.rows[0]?.tab_manual || null;
  const tn = await client.query("SELECT data FROM pedidos_tn WHERE id::text=$1", [id]);
  if (tn.rows[0]) return localLabelBackend(tabManual || clasificarPedidoBackend(tn.rows[0].data));
  const man = await client.query("SELECT tab_actual FROM pedidos_manuales WHERE id=$1", [id]);
  if (man.rows[0]) return localLabelBackend(tabManual || man.rows[0].tab_actual);
  return null;
}

// Descuenta el stock del pedido cuando "sale" (En camino / Entregado).
// - Idempotente vía pedidos_estados.stock_descontado (no descuenta dos veces).
// - FIFO: gasta primero los lotes más viejos (fecha_produccion asc).
// - Best-effort: si no alcanza el stock, descuenta lo que haya (sin bajar de 0)
//   y audita el faltante; NUNCA bloquea el despacho.
// Requiere correr dentro de una transacción (usa FOR UPDATE): llamar siempre vía
// descontarStockDePedidoTx desde las rutas.
// BORDE CONOCIDO (v1.1, NO resuelto acá): si se REABRE un pedido ya despachado
// (vuelve a "Por empaquetar"), el stock no se re-acredita solo.
async function descontarStockDePedido(pedidoId, client = pool) {
  const id = String(pedidoId);

  // Claim atómico: reclamar el descuento en UNA operación que serializa por el
  // row-lock del pedido. Si la fila no existe, INSERT (count=1 -> seguimos); si
  // existe con stock_descontado=false, UPDATE (count=1 -> seguimos); si ya está
  // en true, el WHERE corta (count=0 -> otro evento ya lo tomó, no-op). Esto evita
  // el doble descuento cuando dos disparos (tanda + cambio manual) corren casi a la
  // vez. Como está dentro de la txn, si el descuento falla y hay ROLLBACK, el claim
  // se revierte y queda reintentable.
  const claim = await client.query(
    `INSERT INTO pedidos_estados (id, stock_descontado, updated_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (id) DO UPDATE SET stock_descontado = true, updated_at = NOW()
     WHERE pedidos_estados.stock_descontado = false`,
    [id]
  );
  if (claim.rowCount === 0) return; // ya descontado / reclamado por otro -> no-op

  const local = await localDePedido(id, client);
  const lineas = parsearProductosBackend(await productosStringDePedido(id, client));

  // Agrupar por clave (produccion suma cantidades del mismo nombre).
  const demanda = {};
  for (const { clave, cantidad } of lineas) demanda[clave] = (demanda[clave] || 0) + cantidad;

  const consumo = [], faltantes = [];
  if (local) {
    for (const clave of Object.keys(demanda)) {
      let restante = demanda[clave];
      const lotes = await client.query(
        `SELECT id, cantidad_disponible FROM stock_lotes
         WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0
         ORDER BY fecha_produccion ASC, id ASC
         FOR UPDATE`,
        [local, clave]
      );
      for (const lote of lotes.rows) {
        if (restante <= 0) break;
        const usar = Math.min(restante, Number(lote.cantidad_disponible));
        await client.query("UPDATE stock_lotes SET cantidad_disponible = cantidad_disponible - $1 WHERE id=$2", [usar, lote.id]);
        restante -= usar;
      }
      consumo.push({ clave, cantidad: demanda[clave], descontado: demanda[clave] - restante });
      if (restante > 0) faltantes.push({ clave, falto: restante });
    }
  }

  // (La marca stock_descontado=true ya se seteó en el claim atómico del inicio.)

  // Auditoria best-effort (no bloquea el despacho).
  if (faltantes.length) registrarAuditoria("Sistema", "stock_faltante", "stock", id, { local, faltantes });
  registrarAuditoria("Sistema", "stock_consumo", "stock", id, { local, productos: consumo });
}

// Corre el descuento en su propia transacción (necesaria para el FOR UPDATE del
// FIFO). Best-effort: nunca propaga el error al despacho.
async function descontarStockDePedidoTx(pedidoId) {
  let client;
  try {
    // connect() dentro del try: si el pool está saturado y rechaza por
    // connectionTimeoutMillis, queda atrapado acá (no escala como unhandled).
    client = await pool.connect();
    await client.query("BEGIN");
    await descontarStockDePedido(String(pedidoId), client);
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error(`Hook stock pedido ${pedidoId}:`, e.message);
  } finally {
    if (client) client.release(); // solo si llegó a conectarse
  }
}

// GET /api/stock?local= -> lotes con cantidad_disponible > 0 (del local pedido, o
// todos), agrupados por clave_producto: total_disponible + desglose por
// fecha_produccion (para mostrar "de ayer · de hoy"). Ordenado por clave_producto.
app.get("/api/stock", requireAuth, async (req, res) => {
  const { local } = req.query;
  try {
    const params = [];
    let filtro = "cantidad_disponible > 0";
    if (local) { params.push(local); filtro += ` AND local = $${params.length}`; }
    const r = await pool.query(
      `SELECT clave_producto, local,
              to_char(fecha_produccion, 'YYYY-MM-DD') AS fecha_produccion,
              SUM(cantidad_disponible)::int AS cantidad
       FROM stock_lotes WHERE ${filtro}
       GROUP BY clave_producto, local, fecha_produccion
       ORDER BY clave_producto ASC, fecha_produccion ASC`,
      params
    );
    const map = {};
    for (const row of r.rows) {
      if (!map[row.clave_producto]) map[row.clave_producto] = { clave_producto: row.clave_producto, total_disponible: 0, porFecha: [] };
      map[row.clave_producto].total_disponible += Number(row.cantidad);
      map[row.clave_producto].porFecha.push({ fecha_produccion: row.fecha_produccion, local: row.local, cantidad: Number(row.cantidad) });
    }
    res.json(Object.values(map));
  } catch (err) { console.error("Error GET /api/stock:", err.message); res.status(500).json({ error: "Error trayendo stock" }); }
});

// POST /api/stock/producir -> SIEMPRE inserta un lote nuevo (no upsert).
// fecha_produccion = la que venga o HOY (hora Argentina). usuario_id del JWT.
app.post("/api/stock/producir", requireAuth, async (req, res) => {
  const { local, clave_producto, cantidad, fecha_produccion } = req.body;
  const cant = Number(cantidad);
  if (!local || !clave_producto || !Number.isFinite(cant) || cant <= 0) {
    return res.status(400).json({ error: "local, clave_producto y cantidad (>0) son requeridos" });
  }
  const fecha = fecha_produccion || fechaArgentinaISO();
  try {
    await pool.query(
      `INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible, usuario_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [local, clave_producto, fecha, cant, req.user.id]
    );
    const tot = await pool.query(
      `SELECT COALESCE(SUM(cantidad_disponible),0)::int AS total FROM stock_lotes
       WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0`,
      [local, clave_producto]
    );
    res.json({ ok: true, local, clave_producto, fecha_produccion: fecha, total_disponible: tot.rows[0].total });
    registrarAuditoria(req.user.nombre_completo, "produccion", "stock", clave_producto, { local, producto: clave_producto, cantidad: cant, fecha_produccion: fecha, usuario: req.user.nombre_completo });
  } catch (err) { console.error("Error POST /api/stock/producir:", err.message); res.status(500).json({ error: "Error registrando producción" }); }
});

// POST /api/stock/descartar -> baja stock por merma/perecedero (NO por venta:
// piccadas hechas que no se vendieron). FIFO general (lote más viejo primero) o,
// si viene fecha_produccion, descarta solo de los lotes de esa fecha (tirar "el de
// ayer" puntual). Best-effort: baja lo que haya, sin pasar de 0. Mismo patrón de txn
// que el descuento por despacho (connect dentro del try + release con blindaje).
app.post("/api/stock/descartar", requireAuth, async (req, res) => {
  const { local, clave_producto, cantidad, fecha_produccion } = req.body;
  const cant = Number(cantidad);
  if (!local || !clave_producto || !Number.isFinite(cant) || cant <= 0) {
    return res.status(400).json({ error: "local, clave_producto y cantidad (>0) son requeridos" });
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const params = [local, clave_producto];
    let filtroFecha = "";
    if (fecha_produccion) { params.push(fecha_produccion); filtroFecha = ` AND fecha_produccion = $${params.length}`; }
    const lotes = await client.query(
      `SELECT id, cantidad_disponible FROM stock_lotes
       WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0${filtroFecha}
       ORDER BY fecha_produccion ASC, id ASC
       FOR UPDATE`,
      params
    );
    let restante = cant;
    for (const lote of lotes.rows) {
      if (restante <= 0) break;
      const usar = Math.min(restante, Number(lote.cantidad_disponible));
      await client.query("UPDATE stock_lotes SET cantidad_disponible = cantidad_disponible - $1 WHERE id=$2", [usar, lote.id]);
      restante -= usar;
    }
    const descartado = cant - restante;
    const tot = await client.query(
      `SELECT COALESCE(SUM(cantidad_disponible),0)::int AS total FROM stock_lotes
       WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0`,
      [local, clave_producto]
    );
    await client.query("COMMIT");
    res.json({ ok: true, local, clave_producto, fecha_produccion: fecha_produccion || null, descartado, total_disponible: tot.rows[0].total });
    registrarAuditoria(req.user.nombre_completo, "stock_descarte", "stock", clave_producto, { local, producto: clave_producto, cantidad: descartado, fecha: fecha_produccion || null, usuario: req.user.nombre_completo });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error POST /api/stock/descartar:", err.message);
    res.status(500).json({ error: "Error descartando stock" });
  } finally {
    if (client) client.release();
  }
});

// ─── DATOS EDITABLES DE PEDIDO ────────────────────────────────────────
app.patch("/api/pedidos/:id/datos", async (req, res) => {
  const { id } = req.params;
  const { esManual, cliente, telefono, direccion, barrio, zona, medioPago, medioPagoOtro, nota, email, codigoPago, esCorporativo, usuario: usuarioAudit } = req.body;
  try {
    if (esManual) {
      await pool.query(
        `UPDATE pedidos_manuales SET cliente=$1, telefono=$2, direccion=$3, barrio=$4, zona=$5, medio_pago=$6, nota=$7, email=$8, codigo_pago=$9, es_corporativo=$10 WHERE id=$11`,
        [cliente, telefono, direccion, barrio, zona, medioPago, nota, email, codigoPago || "", !!esCorporativo, id]
      );
    } else {
      await pool.query(
        `INSERT INTO pedidos_estados (id, cliente_override, telefono_override, direccion_override, barrio_override, zona_override, medio_pago_override, nota_override, email_override, codigo_pago_override, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
         ON CONFLICT (id) DO UPDATE SET
           cliente_override=EXCLUDED.cliente_override, telefono_override=EXCLUDED.telefono_override,
           direccion_override=EXCLUDED.direccion_override, barrio_override=EXCLUDED.barrio_override,
           zona_override=EXCLUDED.zona_override, medio_pago_override=EXCLUDED.medio_pago_override,
           nota_override=EXCLUDED.nota_override, email_override=EXCLUDED.email_override,
           codigo_pago_override=EXCLUDED.codigo_pago_override, updated_at=NOW()`,
        [id, cliente, telefono, direccion, barrio, zona, medioPago, nota, email, codigoPago || ""]
      );
    }
    // Detalle de "Otro" — se guarda siempre en pedidos_estados (manuales y TN)
    await pool.query(
      `INSERT INTO pedidos_estados (id, medio_pago_otro_override, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET medio_pago_otro_override=EXCLUDED.medio_pago_otro_override, updated_at=NOW()`,
      [id, medioPagoOtro || ""]
    );
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "edicion_datos", "pedido", id, { cliente, telefono, direccion, barrio, zona, medioPago, nota, email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── PEDIDOS MANUALES ─────────────────────────────────────────────────
app.patch("/api/pedidos-manuales/:id/email", async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  try {
    await pool.query("UPDATE pedidos_manuales SET email=$1 WHERE id=$2", [email, id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/pedidos-manuales", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    const pedidos = result.rows.map(r => ({
      id: r.id, numero: r.numero, cliente: r.cliente, telefono: r.telefono, email: r.email || "",
      direccion: r.direccion, entreCalles: r.entre_calles, barrio: r.barrio, zona: r.zona,
      fecha: r.fecha, franja: r.franja, fechaDisplay: r.fecha, franjaDisplay: r.franja || "Sin franja",
      productos: r.productos, totalNum: Number(r.total_num), total: r.total,
      pago: r.pago, medioPago: r.medio_pago, cobrar: r.cobrar,
      tabActual: r.tab_actual, local: r.local, nota: r.nota,
codigoPago: r.codigo_pago || "", esManual: true, esCorporativo: !!r.es_corporativo, estado: "Por empaquetar", repartidor: "Sin asignar",
    }));
    res.json(pedidos);
  } catch (err) { res.status(500).json({ error: "Error trayendo pedidos manuales" }); }
});

app.post("/api/pedidos-manuales", async (req, res) => {
  const p = req.body;
  try {
    const seqRes = await pool.query("SELECT nextval('pedidos_manuales_seq') AS n");
    const numero = `#M${seqRes.rows[0].n}`;
    await pool.query(`
      INSERT INTO pedidos_manuales (id, numero, cliente, telefono, email, direccion, entre_calles, barrio, zona, fecha, franja, productos, total_num, total, pago, medio_pago, cobrar, tab_actual, local, nota, es_corporativo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    `, [p.id, numero, p.cliente, p.telefono, p.email || "", p.direccion, p.entreCalles, p.barrio, p.zona, p.fecha, p.franja, p.productos, p.totalNum, p.total, p.pago, p.medioPago, p.cobrar, p.tabActual, p.local, p.nota, !!p.esCorporativo]);
    const pedidoConNumero = { ...p, numero };
    if (p.email && p.email.trim()) enviarMailConfirmacion(pedidoConNumero).catch(console.error);
    res.json({ ok: true, numero });
    registrarAuditoria(p.usuario || "Sistema", "creacion_manual", "pedido", p.id, { numero, cliente: p.cliente });
  } catch (err) { res.status(500).json({ error: "Error guardando pedido manual" }); }
});

// ─── REPARTIDORES ──────────────────────────────────────────────────────
app.get("/api/repartidores", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM repartidores WHERE activo = true ORDER BY CASE WHEN nombre = 'Sin asignar' THEN 0 ELSE 1 END, nombre ASC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/repartidores", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "Nombre requerido" });
  try {
    const result = await pool.query("INSERT INTO repartidores (nombre) VALUES ($1) RETURNING *", [nombre.trim()]);
    res.json({ ok: true, repartidor: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/repartidores/:id", requireAdmin, async (req, res) => {
  const { nombre, activo } = req.body;
  try {
    await pool.query("UPDATE repartidores SET nombre = COALESCE($1, nombre), activo = COALESCE($2, activo) WHERE id = $3", [nombre, activo, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/repartidores/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE repartidores SET activo = false WHERE id = $1 AND nombre != 'Sin asignar'", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── MAPA DE PEDIDOS ───────────────────────────────────────────────────
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || "";

async function geocodificar(direccionCompleta) {
  const key = direccionCompleta.toLowerCase().trim();
  try {
    const cached = await pool.query("SELECT lat, lng FROM geocoding_cache WHERE address_key=$1", [key]);
    if (cached.rows.length > 0) return { lat: Number(cached.rows[0].lat), lng: Number(cached.rows[0].lng), cached: true };
  } catch(e) {}
  if (!GOOGLE_MAPS_API_KEY) return null;
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: direccionCompleta, key: GOOGLE_MAPS_API_KEY, region: "ar", language: "es" }
    });
    if (res.data.status === "OK" && res.data.results[0]) {
      const loc = res.data.results[0].geometry.location;
      await pool.query("INSERT INTO geocoding_cache (address_key, lat, lng) VALUES ($1,$2,$3) ON CONFLICT (address_key) DO NOTHING", [key, loc.lat, loc.lng]);
      return { lat: loc.lat, lng: loc.lng, cached: false };
    }
  } catch(e) { console.error("Geocoding error:", e.message); }
  return null;
}

app.get("/api/mapa/pedidos/:fecha", async (req, res) => {
  const { fecha } = req.params;
  try {
    const tnRes = await pool.query("SELECT data FROM pedidos_tn ORDER BY tn_created_at DESC LIMIT 500");
    const estadosRes = await pool.query("SELECT * FROM pedidos_estados");
    const estadosMap = {};
    estadosRes.rows.forEach(r => { estadosMap[r.id] = { estado: r.estado, repartidor: r.repartidor, fechaManual: r.fecha_manual, franjaManual: r.franja_manual, cobrar: r.cobrar, tabManual: r.tab_manual, tandaId: r.tanda_id ?? null }; });
    const overridesRes = await pool.query("SELECT * FROM pedidos_productos");
    const overridesMap = {};
    overridesRes.rows.forEach(r => { overridesMap[r.pedido_id] = { productos: r.productos, total_num: Number(r.total_num) }; });
    const pedidos = [];
    for (const row of tnRes.rows) {
      const p = row.data;
      const est = estadosMap[String(p.id)] || {};
      const estado = est.estado || "Por empaquetar";
      if (estado === "Entregado" || estado === "Anulado") continue;
      const { fecha: fechaP, franja } = parsearFranjaBackend(p.owner_note);
      const fechaDisplay = est.fechaManual || fechaP;
      if (fechaDisplay !== fecha) continue;
      const tabAuto = clasificarPedidoBackend(p);
      const tabActual = est.tabManual || tabAuto;
      if (tabActual.startsWith("retiro")) continue;
      const dir = `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}`.trim();
      const barrio = p.shipping_address?.locality || p.shipping_address?.city || "";
      const ov = overridesMap[String(p.id)];
      pedidos.push({
        id: String(p.id), numero: `#${p.number}`, cliente: p.contact_name || "",
        telefono: p.contact_phone || "", direccion: dir, barrio,
        franjaDisplay: est.franjaManual || franja || "Sin franja",
        productos: ov ? ov.productos : p.products.map(pr => `${pr.name} x${pr.quantity}`).join(", "),
        total: ov ? ov.total_num : Number(p.total),
        estado, repartidor: est.repartidor || "Sin asignar",
        cobrar: !!est.cobrar, local: localLabelBackend(tabActual),
        tandaId: est.tandaId ?? null,
        addressFull: `${dir}, ${barrio}, Buenos Aires, Argentina`,
      });
    }
    const manualesRes = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    for (const p of manualesRes.rows) {
      const est = estadosMap[p.id] || {};
      const estado = est.estado || "Por empaquetar";
      if (estado === "Entregado" || estado === "Anulado") continue;
      const fechaDisplay = est.fechaManual || p.fecha;
      if (fechaDisplay !== fecha) continue;
      const tabActual = est.tabManual || p.tab_actual;
      if (tabActual.startsWith("retiro")) continue;
      const ov = overridesMap[p.id];
      pedidos.push({
        id: p.id, numero: p.numero, cliente: p.cliente || "",
        telefono: p.telefono || "", direccion: p.direccion || "", barrio: p.barrio || "",
        franjaDisplay: est.franjaManual || p.franja || "Sin franja",
        productos: ov ? ov.productos : p.productos,
        total: ov ? ov.total_num : Number(p.total_num),
        estado, repartidor: est.repartidor || "Sin asignar",
        cobrar: est.cobrar !== undefined ? !!est.cobrar : !!p.cobrar,
        local: localLabelBackend(tabActual),
        tandaId: est.tandaId ?? null,
        addressFull: `${p.direccion || ""}, ${p.barrio || ""}, Buenos Aires, Argentina`,
      });
    }
    for (const p of pedidos) {
      const geo = await geocodificar(p.addressFull);
      if (geo) { p.lat = geo.lat; p.lng = geo.lng; }
    }
    res.json(pedidos.filter(p => p.lat && p.lng));
  } catch (err) {
    console.error("Error mapa pedidos:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── AUDITORIA ─────────────────────────────────────────────────────
app.get("/api/auditoria/:entidadId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM auditoria WHERE entidad_id=$1 ORDER BY created_at DESC LIMIT 50",
      [req.params.entidadId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── CAJA ──────────────────────────────────────────────────────────────
app.post("/api/caja/apertura", async (req, res) => {
  const { local, fecha, montoInicial, usuario: usuarioAudit } = req.body;
  try {
    const existe = await pool.query("SELECT id FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    if (existe.rows.length > 0) return res.json({ ok: true, yaExiste: true });
    await pool.query("INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ($1,$2,$3)", [local, fecha, montoInicial]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'apertura','Apertura de caja',$2,$3)", [local, montoInicial, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "apertura_caja", "caja", local, { fecha, montoInicial });
  } catch (err) { res.status(500).json({ error: "Error en apertura de caja" }); }
});
app.post("/api/caja/reabrir", async (req, res) => {
  const { local, fecha, montoInicial, usuario: usuarioAudit } = req.body;
  try {
    const existe = await pool.query("SELECT id FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    if (existe.rows.length === 0) {
      await pool.query("INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ($1,$2,$3)", [local, fecha, montoInicial || 0]);
    } else {
      await pool.query("UPDATE caja_aperturas SET cerrada=false, monto_cierre=NULL, monto_inicial=$1 WHERE local=$2 AND fecha=$3", [montoInicial || 0, local, fecha]);
    }
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'apertura','Reapertura de caja',$2,$3)", [local, montoInicial || 0, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "reapertura_caja", "caja", local, { fecha, montoInicial });
  } catch (err) { res.status(500).json({ error: "Error reabriendo caja" }); }
});

app.get("/api/caja/estado/:local/:fecha", async (req, res) => {
  const { local, fecha } = req.params;
  try {
    const apertura = await pool.query("SELECT * FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    const movimientos = await pool.query("SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC", [local, fecha]);
    res.json({ apertura: apertura.rows[0] || null, movimientos: movimientos.rows });
  } catch (err) { res.status(500).json({ error: "Error trayendo estado de caja" }); }
});

app.post("/api/caja/ajuste", async (req, res) => {
  const { local, fecha, tipo, concepto, monto, usuario: usuarioAudit } = req.body;
  try {
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)", [local, tipo, concepto, monto, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "ajuste_caja", "caja", local, { fecha, tipo, concepto, monto });
  } catch (err) { res.status(500).json({ error: "Error registrando ajuste" }); }
});
app.post("/api/caja/sobre", async (req, res) => {
  const { localOrigen, fecha, monto, concepto, usuario: usuarioAudit } = req.body;
  try {
    const montoAbs = Math.abs(Number(monto));
    if (!montoAbs || montoAbs <= 0) return res.status(400).json({ error: "Monto inválido" });
    // 1. Salida en el local origen
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4)",
      [localOrigen, concepto ? `Sobre: ${concepto}` : "Sobre a Administración", -montoAbs, fecha]);
    // 2. Auto-abrir caja Administración si no existe
    const existe = await pool.query("SELECT id FROM caja_aperturas WHERE local='Administración' AND fecha=$1", [fecha]);
    if (existe.rows.length === 0) {
      await pool.query("INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ('Administración',$1,0)", [fecha]);
      await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ('Administración','apertura','Apertura de caja',0,$1)", [fecha]);
    }
    // 3. Entrada en Administración
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ('Administración','entrada',$1,$2,$3)",
      [concepto ? `Sobre desde ${localOrigen}: ${concepto}` : `Sobre desde ${localOrigen}`, montoAbs, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "sobre_caja", "caja", localOrigen, { monto: montoAbs, concepto, fecha });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/caja/cerrar-historico", async (req, res) => {
  const { local, fecha, usuario: usuarioAudit } = req.body;
  try {
    await pool.query("UPDATE caja_aperturas SET cerrada=true, monto_cierre=monto_inicial WHERE local=$1 AND fecha=$2 AND cerrada=false", [local, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "cierre_historico", "caja", local, { fecha });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/caja/cierre", async (req, res) => {
  const { local, fecha, montoCierre, usuario: usuarioAudit } = req.body;
  try {
    await pool.query("UPDATE caja_aperturas SET cerrada=true, monto_cierre=$1 WHERE local=$2 AND fecha=$3", [montoCierre, local, fecha]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'cierre','Cierre Z',$2,$3)", [local, montoCierre, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "cierre_caja", "caja", local, { fecha, montoCierre });
  } catch (err) { res.status(500).json({ error: "Error en cierre de caja" }); }
});
// ===== FONDO FIJO (uno por local) =====
const FONDOS_VALIDOS = ["Fondo Fijo A. Thomas", "Fondo Fijo French"];

app.get("/api/fondo-fijo/:local", async (req, res) => {
  const local = decodeURIComponent(req.params.local);
  if (!FONDOS_VALIDOS.includes(local)) return res.status(400).json({ error: "Fondo inválido" });
  try {
    const movs = await pool.query(
      "SELECT * FROM caja_movimientos WHERE local=$1 ORDER BY created_at DESC",
      [local]
    );
    const saldo = movs.rows.reduce((a, m) => a + Number(m.monto), 0);
    res.json({ saldo, movimientos: movs.rows });
  } catch (err) {
    res.status(500).json({ error: "Error trayendo el fondo fijo" });
  }
});
app.post("/api/fondo-fijo/movimiento", async (req, res) => {
  const { local, tipo, concepto, monto, fecha, usuario: usuarioAudit } = req.body;
  try {
    if (!FONDOS_VALIDOS.includes(local) || !["entrada", "salida"].includes(tipo) || !monto) {
      return res.status(400).json({ error: "Datos inválidos" });
    }
    const signo = tipo === "salida" ? -Math.abs(Number(monto)) : Math.abs(Number(monto));
    const conceptoFinal = concepto && concepto.trim() ? concepto.trim() : (tipo === "entrada" ? "Reposición" : "Gasto");
    await pool.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)",
      [local, tipo, conceptoFinal, signo, fecha]
    );
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "fondo_fijo_movimiento", "caja", local, { tipo, concepto: conceptoFinal, monto: signo, fecha });
  } catch (err) {
    res.status(500).json({ error: "Error registrando movimiento" });
  }
});

app.get("/api/caja/historial/:local", async (req, res) => {
  const { local } = req.params;
  try {
    const aperturas = await pool.query("SELECT * FROM caja_aperturas WHERE local=$1 ORDER BY fecha DESC LIMIT 30", [decodeURIComponent(local)]);
    const resultado = [];
    for (const apertura of aperturas.rows) {
      const movimientos = await pool.query("SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC", [decodeURIComponent(local), apertura.fecha]);
      resultado.push({ apertura, movimientos: movimientos.rows });
    }
    res.json(resultado);
  } catch (err) { res.status(500).json({ error: "Error trayendo historial" }); }
});

// ─── FACTURACIÓN ───────────────────────────────────────────────────────
function esNotaCredito(f) { return String(f.tipo || "").toUpperCase().includes("NOTA DE CREDITO"); }

function obtenerFacturaActiva(facturas) {
  const facturasEmitidas = facturas.filter(f => !esNotaCredito(f));
  const notasCredito = facturas.filter(f => esNotaCredito(f));
  if (facturasEmitidas.length > notasCredito.length) return facturasEmitidas[facturasEmitidas.length - 1];
  return null;
}

function numeroSinPuntoVenta(numero) {
  const s = String(numero || "");
  if (s.includes("-")) { const partes = s.split("-"); return partes[partes.length - 1].replace(/^0+/, "") || partes[partes.length - 1]; }
  return s.replace(/^0+/, "") || s;
}

function puntoVentaDesdeNumero(numero) {
  const s = String(numero || "");
  if (s.includes("-")) return s.split("-")[0].replace(/^0+/, "") || "17";
  return "17";
}

// ─── PDF FRESCO DESDE TUSFACTURAS ────────────────────────────────────
app.get("/api/facturas-all", async (req, res) => {
  try {
    const result = await pool.query("SELECT id, pedido_id, tipo, numero FROM facturas ORDER BY created_at ASC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error trayendo facturas" }); }
});
app.get("/api/facturas/:facturaId/pdf-url", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM facturas WHERE id=$1", [req.params.facturaId]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Factura no encontrada" });
    const factura = result.rows[0];
    const localFactura = factura.local || "A. Thomas";
    const { usertoken: TF_USERTOKEN } = getTFCredentials(localFactura);
    const pdv = puntoVentaDesdeNumero(factura.numero);
    const num = numeroSinPuntoVenta(factura.numero);
    const body = {
      apitoken: TF_APITOKEN, usertoken: TF_USERTOKEN, apikey: TF_APIKEY,
      comprobante: { tipo: factura.tipo, operacion: "V", punto_venta: pdv, numero: num }
    };
    const response = await axios.post("https://www.tusfacturas.app/app/api/v2/facturacion/comprobante", body, { headers: { "Content-Type": "application/json" } });
    const data = response.data;
    if (data.error === "N" && data.comprobante_pdf_url) {
      await pool.query("UPDATE facturas SET pdf_url=$1 WHERE id=$2", [data.comprobante_pdf_url, factura.id]);
      return res.json({ ok: true, pdf_url: data.comprobante_pdf_url });
    }
    return res.json({ ok: false, error: data.errores || "No se pudo obtener el PDF" });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.get("/api/facturas/:pedidoId", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC", [req.params.pedidoId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: "Error trayendo facturas" }); }
});

app.post("/api/facturar", async (req, res) => {
  if (!TF_ENABLED) { console.warn("⚠️ Facturación no configurada: /api/facturar deshabilitado"); return res.status(503).json({ ok: false, error: "Facturación no configurada en este entorno" }); }
  const { pedidoId, tipo, cliente, documentoTipo, documentoNro, razonSocial, domicilio, email, total, productos, local, usuario: usuarioAudit } = req.body;
  const { usertoken: TF_USERTOKEN, pdv: TF_PDV } = getTFCredentials(local);
  const esFacturaA = tipo === "FACTURA A";
  const esExento = tipo === "FACTURA B EXENTO";
  const sinDatos = !documentoNro || String(documentoNro).trim() === "";
  const totalNum = (() => {
    const raw = String(total).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return Number(raw.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", "."));
  })();
  if (!totalNum || totalNum <= 0) return res.json({ ok: false, error: "Total inválido: " + total });
  try {
    const existentes = await pool.query("SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC", [pedidoId]);
    const facturaActiva = obtenerFacturaActiva(existentes.rows);
    if (facturaActiva) return res.json({ ok: false, yaFacturado: true, error: "Este pedido ya tiene una factura activa.", factura: facturaActiva });
  } catch (err) { return res.status(500).json({ ok: false, error: "Error validando factura existente" }); }
  const tipoComprobante = esFacturaA ? "FACTURA A" : "FACTURA B";
  const clienteObj = (sinDatos && !esFacturaA) ? {
    documento_tipo: "DNI", documento_nro: "0", razon_social: "Consumidor Final", email: "",
    domicilio: "Sin domicilio", provincia: "2", condicion_pago: "201", condicion_iva: "CF",
    condicion_iva_operacion: "CF", envia_por_mail: "N", reclama_deuda: "N",
  } : {
    documento_tipo: documentoTipo, documento_nro: String(documentoNro).trim() || "0",
    razon_social: razonSocial || cliente, email: email || "", domicilio: domicilio || "Sin domicilio",
   provincia: "2", condicion_pago: "201", condicion_iva: esFacturaA ? "RI" : (esExento ? "E" : "CF"),
    condicion_iva_operacion: esFacturaA ? "RI" : (esExento ? "E" : "CF"), envia_por_mail: email ? "S" : "N", reclama_deuda: "N",
  };
  const descripcion = productos.map(p => p.descripcion).join(", ").substring(0, 200);
  const precioSinIva = Math.round((totalNum / 1.21) * 100) / 100;
  const detalle = [{ cantidad: 1, bonificacion_porcentaje: 0, afecta_stock: "N", producto: { descripcion, codigo: "VENTA", lista_precios: "standard", leyenda: "", unidad_bulto: 1, alicuota: 21, precio_unitario_sin_iva: precioSinIva, actualiza_precio: "S" } }];
  const body = { apitoken: TF_APITOKEN, usertoken: TF_USERTOKEN, apikey: TF_APIKEY, cliente: clienteObj, comprobante: { fecha: fechaHoy(), vencimiento: fechaVencimiento(30), tipo: tipoComprobante, operacion: "V", moneda: "PES", cotizacion: 1, punto_venta: TF_PDV, rubro: "Alimentos y bebidas", rubro_grupo_contable: "Alimentos", bonificacion: 0, total: totalNum, external_reference: String(pedidoId) || `pedido-${Date.now()}`, detalle } };
  console.log(`Facturando pedido ${pedidoId} - Local: ${local} - PDV: ${TF_PDV}`);
  try {
    const response = await axios.post("https://www.tusfacturas.app/app/api/v2/facturacion/nuevo", body, { headers: { "Content-Type": "application/json" } });
    const data = response.data;
    if (data.error === "N") {
      await pool.query(`INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw, local) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [pedidoId, tipo, data.comprobante_nro, data.cae, data.vencimiento_cae, clienteObj.razon_social, clienteObj.documento_tipo, clienteObj.documento_nro, totalNum, data.comprobante_pdf_url || "", fechaHoy(), JSON.stringify(data), local]);
      registrarAuditoria(usuarioAudit, "facturacion", "pedido", pedidoId, { tipo, numero: data.comprobante_nro, total: totalNum });
      res.json({ ok: true, data });
    } else { res.json({ ok: false, error: data.errores || data }); }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post("/api/nota-credito", async (req, res) => {
  if (!TF_ENABLED) { console.warn("⚠️ Facturación no configurada: /api/nota-credito deshabilitado"); return res.status(503).json({ ok: false, error: "Facturación no configurada en este entorno" }); }
  const { facturaId, pedidoId, usuario: usuarioAudit } = req.body;
  try {
    const facturaRes = await pool.query("SELECT * FROM facturas WHERE id=$1 AND pedido_id=$2", [facturaId, pedidoId]);
    if (facturaRes.rows.length === 0) return res.json({ ok: false, error: "Factura no encontrada" });
    const factura = facturaRes.rows[0];
    const todasRes = await pool.query("SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC", [pedidoId]);
    const facturaActiva = obtenerFacturaActiva(todasRes.rows);
    if (!facturaActiva || Number(facturaActiva.id) !== Number(factura.id)) return res.json({ ok: false, error: "Esta factura ya no está activa." });

    const localFactura = factura.local || "A. Thomas";
    const { usertoken: TF_USERTOKEN, pdv: TF_PDV } = getTFCredentials(localFactura);

    const tipoFacturaOriginal = String(factura.tipo).includes("FACTURA A") ? "FACTURA A" : "FACTURA B";
    const tipoNC = tipoFacturaOriginal === "FACTURA A" ? "NOTA DE CREDITO A" : "NOTA DE CREDITO B";
    const totalNum = Number(factura.total);
    const esExento = String(factura.tipo).includes("EXENTO");
    const precioSinIva = esExento ? totalNum : Math.round((totalNum / 1.21) * 100) / 100;
    const clienteObj = { documento_tipo: factura.documento_tipo || "DNI", documento_nro: factura.documento_nro || "0", razon_social: factura.cliente || "Consumidor Final", email: "", domicilio: "Sin domicilio", provincia: "2", condicion_pago: "201", condicion_iva: tipoFacturaOriginal === "FACTURA A" ? "RI" : "CF", condicion_iva_operacion: tipoFacturaOriginal === "FACTURA A" ? "RI" : "CF", envia_por_mail: "N", reclama_deuda: "N" };
    const body = { apitoken: TF_APITOKEN, usertoken: TF_USERTOKEN, apikey: TF_APIKEY, cliente: clienteObj, comprobante: { fecha: fechaHoy(), vencimiento: fechaVencimiento(30), tipo: tipoNC, operacion: "V", moneda: "PES", cotizacion: 1, punto_venta: TF_PDV, rubro: "Alimentos y bebidas", rubro_grupo_contable: "Alimentos", bonificacion: 0, total: totalNum, external_reference: `${pedidoId}-NC-${factura.id}`, comprobantes_asociados: [{ tipo_comprobante: tipoFacturaOriginal, punto_venta: puntoVentaDesdeNumero(factura.numero), numero: numeroSinPuntoVenta(factura.numero), comprobante_fecha: factura.fecha, cuit: TF_CUIT_EMISOR }], detalle: [{ cantidad: 1, bonificacion_porcentaje: 0, afecta_stock: "N", producto: { descripcion: `Anulación de ${tipoFacturaOriginal} Nº ${factura.numero}`, codigo: "NC", lista_precios: "standard", leyenda: "", unidad_bulto: 1, alicuota: esExento ? 0 : 21, precio_unitario_sin_iva: precioSinIva, actualiza_precio: "N" } }] } };
    const response = await axios.post("https://www.tusfacturas.app/app/api/v2/facturacion/nuevo", body, { headers: { "Content-Type": "application/json" } });
    const data = response.data;
    if (data.error === "N") {
      await pool.query(`INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw, local) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [pedidoId, tipoNC, data.comprobante_nro, data.cae, data.vencimiento_cae, clienteObj.razon_social, clienteObj.documento_tipo, clienteObj.documento_nro, totalNum, data.comprobante_pdf_url || "", fechaHoy(), JSON.stringify(data), localFactura]);
      registrarAuditoria(usuarioAudit, "nota_credito", "pedido", pedidoId, { factura_numero: factura.numero, tipo: tipoNC });
      return res.json({ ok: true, data });
    }
    return res.json({ ok: false, error: data.errores || data });
  } catch (err) { res.status(500).json({ ok: false, error: err.response?.data || err.message }); }
});

// ─── TUSFACTURAS WEBHOOK ──────────────────────────────────────────────
app.post("/api/tusfacturas/webhook", async (req, res) => {
  console.log("TusFacturas webhook:", JSON.stringify(req.body));
  res.sendStatus(200);
});

// ─── PEDIDOS PRODUCTOS ─────────────────────────────────────────────────
app.post("/api/pedidos/productos/:id", async (req, res) => {
  const { id } = req.params;
  const { productos, totalNum } = req.body;
  try {
    await pool.query(`INSERT INTO pedidos_productos (pedido_id, productos, total_num) VALUES ($1,$2,$3) ON CONFLICT (pedido_id) DO UPDATE SET productos=$2, total_num=$3`, [id, productos, totalNum]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/pedidos/productos/:id", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos_productos WHERE pedido_id=$1", [req.params.id]);
    res.json(result.rows[0] || null);
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Batch: TODOS los overrides de productos en UNA sola query/respuesta (evita el N+1 del
// front al cargar). Devuelve un mapa { [pedido_id]: { pedido_id, productos, total_num } },
// misma forma por pedido que el endpoint /:id. La tabla solo guarda overrides, así que
// trae solo los pedidos que tienen uno (igual que antes, que omitía los sin override).
app.get("/api/pedidos/productos-all", async (req, res) => {
  try {
    const result = await pool.query("SELECT pedido_id, productos, total_num FROM pedidos_productos");
    const map = {};
    for (const r of result.rows) map[r.pedido_id] = { pedido_id: r.pedido_id, productos: r.productos, total_num: r.total_num };
    res.json(map);
  } catch(err) { res.status(500).json({ error: "Error trayendo overrides de productos" }); }
});

// ─── WEBHOOKS TIENDA NUBE ──────────────────────────────────────────────
function verifyTNSignature(rawBody, signature) {
  if (!TN_CLIENT_SECRET || !signature || !rawBody) return false;
  const expected = crypto.createHmac("sha256", TN_CLIENT_SECRET).update(rawBody).digest("hex");
  try {
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch { return false; }
}

async function upsertOrderFromTN(orderId) {
  try {
    const response = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/orders/${orderId}?aggregates=fulfillment_orders`, { headers });
    const o = response.data;
    await pool.query(`
      INSERT INTO pedidos_tn (id, store_id, numero, estado_tn, payment_status, total, contact_email, contact_name, contact_phone, data, tn_created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (id) DO UPDATE SET numero=EXCLUDED.numero, estado_tn=EXCLUDED.estado_tn, payment_status=EXCLUDED.payment_status, total=EXCLUDED.total, contact_email=EXCLUDED.contact_email, contact_name=EXCLUDED.contact_name, contact_phone=EXCLUDED.contact_phone, data=EXCLUDED.data, updated_at=NOW()
    `, [o.id, String(o.store_id || ""), o.number || null, o.status || null, o.payment_status || null, parseFloat(o.total) || 0, o.contact_email || null, o.contact_name || null, o.contact_phone || null, JSON.stringify(o), o.created_at || null]);
    console.log(`Pedido TN ${orderId} sincronizado`);
  } catch (err) { console.error(`Error sincronizando pedido ${orderId}:`, err.message); }
}

async function processWebhookEvent(event, resourceId) {
  if (!event || !resourceId) return;
  if (event === "order/cancelled" || event === "order/voided") {
    await pool.query("UPDATE pedidos_tn SET estado_tn='cancelled', updated_at=NOW() WHERE id=$1", [resourceId]);
    return;
  }
  if (event.startsWith("order/")) await upsertOrderFromTN(resourceId);
}

app.get("/api/webhooks/tiendanube", (req, res) => res.json({ ok: true, message: "Webhook endpoint activo" }));

app.post("/api/webhooks/tiendanube", async (req, res) => {
  try {
    const signature = req.headers["x-linkedstore-hmac-sha256"];
    if (!verifyTNSignature(req.rawBody, signature)) { console.warn("Webhook con firma inválida"); return res.status(401).json({ error: "Invalid signature" }); }
    const { event, id: resourceId } = req.body || {};
    if (!event || !resourceId) return res.status(400).json({ error: "Payload inválido" });
    try {
      await pool.query(`INSERT INTO webhook_events (event_type, resource_id, signature) VALUES ($1,$2,$3)`, [event, resourceId, signature]);
    } catch (err) {
      if (err.code === "23505") { console.log(`Webhook duplicado ignorado: ${event} ${resourceId}`); return res.json({ ok: true, duplicate: true }); }
      throw err;
    }
    res.json({ ok: true });
    processWebhookEvent(event, resourceId).catch(console.error);
  } catch (err) { console.error("Webhook error:", err); res.status(500).json({ error: err.message }); }
});

// ─── ADMIN ─────────────────────────────────────────────────────────────
app.post("/api/admin/backfill-orders", requireAdmin, async (req, res) => {
  try {
    let page = 1, totalSynced = 0, totalPages = 0;
    while (true) {
      const response = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/orders?per_page=50&page=${page}&aggregates=fulfillment_orders`, { headers });
      const orders = response.data;
      if (!orders || orders.length === 0) break;
      for (const o of orders) {
        await pool.query(`INSERT INTO pedidos_tn (id, store_id, numero, estado_tn, payment_status, total, contact_email, contact_name, contact_phone, data, tn_created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW()) ON CONFLICT (id) DO UPDATE SET numero=EXCLUDED.numero, estado_tn=EXCLUDED.estado_tn, payment_status=EXCLUDED.payment_status, total=EXCLUDED.total, contact_email=EXCLUDED.contact_email, contact_name=EXCLUDED.contact_name, contact_phone=EXCLUDED.contact_phone, data=EXCLUDED.data, updated_at=NOW()`,
          [o.id, String(o.store_id || ""), o.number || null, o.status || null, o.payment_status || null, parseFloat(o.total) || 0, o.contact_email || null, o.contact_name || null, o.contact_phone || null, JSON.stringify(o), o.created_at || null]);
        totalSynced++;
      }
      totalPages++;
      console.log(`Backfill: página ${page} procesada, ${orders.length} pedidos`);
      if (orders.length < 50) break;
      page++;
      if (totalPages > 100) break;
    }
    res.json({ ok: true, totalSynced, totalPages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── SNAPSHOT DIARIO ───────────────────────────────────────────────────
app.get("/api/admin/snapshot-pendientes", requireAdmin, async (req, res) => {
  try {
    const DIAS_HORIZONTE = 15;
    const hoy = new Date();
    const limite = new Date();
    limite.setDate(hoy.getDate() + DIAS_HORIZONTE);
    const hoyStr = fechaArgentinaISO(hoy);
    const limiteStr = fechaArgentinaISO(limite);
    const estadosRes = await pool.query("SELECT * FROM pedidos_estados");
    const estadosMap = {};
    estadosRes.rows.forEach(r => { estadosMap[r.id] = { estado: r.estado, repartidor: r.repartidor, tabManual: r.tab_manual, fechaManual: r.fecha_manual, franjaManual: r.franja_manual, cobrar: r.cobrar }; });
    const overridesRes = await pool.query("SELECT * FROM pedidos_productos");
    const overridesMap = {};
    overridesRes.rows.forEach(r => { overridesMap[r.pedido_id] = { productos: r.productos, total_num: Number(r.total_num) }; });
    const tnRes = await pool.query("SELECT data FROM pedidos_tn ORDER BY tn_created_at DESC LIMIT 500");
    const manualesRes = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    const pedidos = [];
    for (const row of tnRes.rows) {
      const p = row.data;
      const local = estadosMap[String(p.id)] || {};
      const { fecha, franja } = parsearFranjaBackend(p.owner_note);
      const fechaDisplay = local.fechaManual || fecha;
      const estado = local.estado || "Por empaquetar";
      if (estado === "Entregado" || estado === "Anulado") continue;
      if (!fechaDisplay || fechaDisplay < hoyStr || fechaDisplay > limiteStr) continue;
      const tabAuto = clasificarPedidoBackend(p);
      const tabActual = local.tabManual || tabAuto;
      const ov = overridesMap[String(p.id)];
      pedidos.push({ numero: `#${p.number}`, cliente: p.contact_name || "", telefono: p.contact_phone || "", direccion: `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}`.trim(), barrio: p.shipping_address?.locality || "", fechaDisplay, franjaDisplay: local.franjaManual || franja || "Sin franja", productos: ov ? ov.productos : p.products.map(pr => `${pr.name} x${pr.quantity}`).join(", "), total: ov ? ov.total_num : Number(p.total), medioPago: medioPagoLabelBackend(p.gateway), cobrar: !!local.cobrar, nota: p.note || "", sucursal: localLabelBackend(tabActual), tipo: tabActual.startsWith("retiro") ? "Retiro" : "Delivery", repartidor: local.repartidor || "Sin asignar", estado });
    }
    for (const p of manualesRes.rows) {
      const local = estadosMap[p.id] || {};
      const fechaDisplay = local.fechaManual || p.fecha;
      const estado = local.estado || "Por empaquetar";
      if (estado === "Entregado" || estado === "Anulado") continue;
      if (!fechaDisplay || fechaDisplay < hoyStr || fechaDisplay > limiteStr) continue;
      const tabActual = local.tabManual || p.tab_actual;
      const ov = overridesMap[p.id];
      pedidos.push({ numero: p.numero, cliente: p.cliente || "", telefono: p.telefono || "", direccion: `${p.direccion || ""}${p.entre_calles ? ` (${p.entre_calles})` : ""}`.trim(), barrio: p.barrio || "", fechaDisplay, franjaDisplay: local.franjaManual || p.franja || "Sin franja", productos: ov ? ov.productos : p.productos, total: ov ? ov.total_num : Number(p.total_num), medioPago: p.medio_pago || "Otro", cobrar: local.cobrar !== undefined ? !!local.cobrar : !!p.cobrar, nota: p.nota || "", sucursal: localLabelBackend(tabActual), tipo: tabActual.startsWith("retiro") ? "Retiro" : "Delivery", repartidor: local.repartidor || "Sin asignar", estado });
    }
    const porFecha = {};
    pedidos.forEach(p => { if (!porFecha[p.fechaDisplay]) porFecha[p.fechaDisplay] = []; porFecha[p.fechaDisplay].push(p); });
    Object.values(porFecha).forEach(grupo => { grupo.sort((a, b) => { const ha = (a.franjaDisplay.match(/(\d{1,2}):(\d{2})/) || [])[0] || "99:99"; const hb = (b.franjaDisplay.match(/(\d{1,2}):(\d{2})/) || [])[0] || "99:99"; return ha.localeCompare(hb); }); });
    const doc = new PDFDocument({ size: "A4", margin: 36 });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="piccadely_pendientes_${hoyStr}.pdf"`);
    doc.pipe(res);
    const MARGIN = 36;
    const INNER_WIDTH = doc.page.width - MARGIN * 2;
    const CONTENT_X = MARGIN + 8;
    const CONTENT_WIDTH = INNER_WIDTH - 16;
    function asegurarEspacio(altura) { if (doc.y + altura > doc.page.height - doc.page.margins.bottom) doc.addPage(); }
    doc.fontSize(20).fillColor("#F68B32").font("Helvetica-Bold").text("Piccadely — Pedidos pendientes", MARGIN, doc.y);
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#666").font("Helvetica");
    doc.text(`Snapshot: ${new Date().toLocaleString("es-AR", { dateStyle: "long", timeStyle: "short" })}`, MARGIN, doc.y);
    doc.text(`Horizonte: ${hoyStr} al ${limiteStr} · Total: ${pedidos.length} pedidos`, MARGIN, doc.y);
    doc.moveDown(1);
    if (pedidos.length === 0) { doc.fontSize(13).fillColor("#666").text("No hay pedidos pendientes.", MARGIN, doc.y, { align: "center" }); doc.end(); return; }
    for (const fecha of Object.keys(porFecha).sort()) {
      const grupo = porFecha[fecha];
      asegurarEspacio(34);
      const headerY = doc.y;
      doc.save().rect(MARGIN, headerY, INNER_WIDTH, 24).fill("#F68B32").restore();
      doc.fillColor("#fff").fontSize(11).font("Helvetica-Bold").text(formatoFechaLarga(fecha).toUpperCase(), MARGIN + 10, headerY + 7, { width: INNER_WIDTH - 120, lineBreak: false });
      doc.fontSize(10).font("Helvetica").text(`${grupo.length} pedido${grupo.length > 1 ? "s" : ""}`, MARGIN, headerY + 8, { width: INNER_WIDTH - 10, align: "right", lineBreak: false });
      doc.fillColor("#000").font("Helvetica");
      doc.y = headerY + 30;
      for (const p of grupo) {
        const productosTxt = `Prod: ${p.productos}`;
        const lineasProd = Math.max(1, Math.ceil(productosTxt.length / 95));
        const lineasNota = p.nota ? Math.max(1, Math.ceil(p.nota.length / 95)) : 0;
        const tieneDireccion = p.tipo === "Delivery";
        const altura = 22 + (tieneDireccion ? 14 : 0) + (lineasProd * 12) + (lineasNota * 12) + 18 + 8;
        asegurarEspacio(altura + 8);
        const cardY = doc.y;
        doc.save().lineWidth(p.cobrar ? 1.5 : 0.5).rect(MARGIN, cardY, INNER_WIDTH, altura).stroke(p.cobrar ? "#c0392b" : "#ddd").restore();
        doc.fillColor("#F68B32").fontSize(11).font("Helvetica-Bold").text(p.numero, CONTENT_X, cardY + 7, { width: 70, lineBreak: false });
        doc.fillColor("#000").text(p.cliente || "—", CONTENT_X + 72, cardY + 7, { width: CONTENT_WIDTH - 182, lineBreak: false });
        doc.fillColor("#444").fontSize(10).font("Helvetica").text(p.franjaDisplay, MARGIN, cardY + 7, { width: INNER_WIDTH - 10, align: "right", lineBreak: false });
        doc.fillColor("#666").fontSize(9).text(`Tel: ${p.telefono || "—"}`, CONTENT_X, cardY + 22, { width: CONTENT_WIDTH - 150, lineBreak: false });
        const sucColor = p.sucursal === "French" ? "#7c3aed" : "#0c447c";
        doc.fillColor(sucColor).font("Helvetica-Bold").text(`${p.tipo} · ${p.sucursal}`, MARGIN, cardY + 22, { width: INNER_WIDTH - 10, align: "right", lineBreak: false });
        let cursorY = cardY + 36;
        if (tieneDireccion) { doc.fillColor("#333").fontSize(9).font("Helvetica").text(`Dir: ${p.direccion}${p.barrio ? ", " + p.barrio : ""}`, CONTENT_X, cursorY, { width: CONTENT_WIDTH, lineBreak: false, ellipsis: true }); cursorY += 14; }
        doc.fillColor("#000").text(productosTxt, CONTENT_X, cursorY, { width: CONTENT_WIDTH }); cursorY += lineasProd * 12 + 2;
        if (p.nota) { doc.fillColor("#888").fontSize(8).font("Helvetica-Oblique").text(`Nota: ${p.nota}`, CONTENT_X, cursorY, { width: CONTENT_WIDTH }); doc.font("Helvetica"); cursorY += lineasNota * 12 + 2; }
        doc.fillColor("#000").fontSize(10).font("Helvetica-Bold").text(`Total: ${formatoPesos(p.total)}`, CONTENT_X, cursorY, { width: 180, lineBreak: false });
        doc.fillColor("#666").fontSize(9).font("Helvetica").text(`Pago: ${p.medioPago}`, CONTENT_X + 130, cursorY + 1, { width: 200, lineBreak: false });
        if (p.cobrar) { doc.fillColor("#c0392b").fontSize(10).font("Helvetica-Bold").text("⚠ COBRAR EN ENTREGA", MARGIN, cursorY, { width: INNER_WIDTH - 10, align: "right", lineBreak: false }); }
        doc.fillColor("#000").font("Helvetica");
        doc.y = cardY + altura + 6;
      }
      doc.moveDown(0.3);
    }
    doc.end();
  } catch (err) { console.error("Error generando snapshot:", err.message); res.status(500).json({ error: err.message }); }
});

const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://piccadely-panel-production.up.railway.app/api/webhooks/tiendanube";
const WEBHOOK_EVENTS = ["order/created", "order/paid", "order/updated", "order/cancelled", "order/voided"];

app.get("/api/admin/webhooks", requireAdmin, async (req, res) => {
  if (!TN_ENABLED) return res.status(503).json({ error: "Tienda Nube no configurada en este entorno" });
  try {
    const response = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`, { headers });
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/webhooks/setup", requireAdmin, async (req, res) => {
  if (!TN_ENABLED) return res.status(503).json({ error: "Tienda Nube no configurada en este entorno" });
  try {
    const existing = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`, { headers });
    const existingHooks = existing.data || [];
    const created = [], skipped = [];
    for (const event of WEBHOOK_EVENTS) {
      const exists = existingHooks.find(h => h.event === event && h.url === WEBHOOK_URL);
      if (exists) { skipped.push({ event, id: exists.id }); continue; }
      try {
        const response = await axios.post(`https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`, { event, url: WEBHOOK_URL }, { headers: { ...headers, "Content-Type": "application/json" } });
        created.push({ event, id: response.data.id });
      } catch (err) { created.push({ event, error: err.message }); }
    }
    res.json({ ok: true, created, skipped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── AGENTE IA ─────────────────────────────────────────────────────────────
const SYSTEM_AGENTE = `Sos el asistente de ayuda del Panel de Piccadely, una empresa de delivery de picadas en Buenos Aires.
Respondés preguntas del equipo (encargados, call center, repartidores) sobre cómo usar el panel.
Respondés siempre en español argentino, de forma clara, simple y amigable.
Si la pregunta no tiene que ver con el panel, decís que solo podés ayudar con el panel.

CONOCIMIENTO DEL PANEL:

ACCESO:
- El panel se abre en el navegador con la URL que da el encargado.
- Hay tres roles: admin (ve todo), a_thomas (solo A. Thomas), french (solo French).
- Si olvidás la contraseña, el encargado la resetea.

PESTAÑAS PRINCIPALES:
- Retiro A. Thomas: clientes que retiran en Álvarez Thomas 1558.
- Retiro French: clientes que retiran en French 2615.
- Delivery A. Thomas: pedidos con envío desde A. Thomas.
- Delivery French: pedidos con envío desde French.
- Nuevo pedido: para cargar pedidos manuales (por teléfono o WhatsApp).

PEDIDOS AUTOMÁTICOS DE TIENDA NUBE:
- Entran solos cada 30 segundos, no hay que hacer nada.
- Si entra un pedido nuevo suena un beep y el título muestra 🔔.

ESTADOS DE UN PEDIDO (en orden):
1. Por empaquetar → 2. Listo → 3. En camino → 4. Entregado
- Para avanzar: expandí el pedido y hacé click en el botón → (nombre del próximo estado).
- Entregado pasa automáticamente a la sección Finalizados.
- Anulado: cancela el pedido. Si tiene factura, primero hay que anular la factura.

COLORES DE ALERTA:
- Fila roja clara: el horario de entrega ya pasó.
- Fila roja oscura: más de 2 horas de demora. Urgente.

EDITAR DATOS DE UN PEDIDO:
- Click en el pedido para expandir → editá el campo → click afuera para guardar.
- Se guarda automáticamente, sin botón de guardar.
- Campos editables: cliente, teléfono, dirección, barrio, zona, email, medio de pago, nota.

CARGAR PEDIDO MANUAL (call center):
1. Pestaña ➕ Nuevo pedido.
2. Completar datos del cliente y dirección.
3. Elegir fecha, horario, medio de pago y sección.
4. Agregar productos del catálogo o "Producto variable" si no está.
5. Click en ✅ Crear pedido.

IMPRIMIR COMANDA:
- Expandí el pedido → click en 🖨️ Imprimir comanda.
- Se imprime directo en la térmica sin diálogos.
- Si se abre una ventana del navegador, apretá Ctrl+P.

LINK DE PAGO MERCADO PAGO:
- Expandí el pedido → 💳 Enviar link de pago.
- Si tiene email, el link se genera y se envía automáticamente.
- Si no tiene email, el sistema pide que lo ingreses.
- Cuando el cliente paga, el estado se actualiza solo a "Pagado".
- También podés copiar el link con 📋 y mandarlo por WhatsApp.

FACTURACIÓN:
- Expandí el pedido → 🧾 Facturar.
- Factura B para consumidores finales, Factura A si el cliente tiene CUIT.
- Si hay CUIT cargado, el sistema sugiere Factura A automáticamente.
- Para anular: 🧾 Facturar → Anular factura (emite nota de crédito).
- PDV 17 para A. Thomas, PDV 18 para French.

CAJA (encargados):
- Menú ☰ → 💰 Caja.
- Abrir caja: al inicio del día, ingresar el efectivo disponible.
- Ajuste: para registrar ingresos o egresos durante el día.
- Cierre Z: al final del día, contar el efectivo y registrar. El sistema calcula la diferencia.
- El historial se puede exportar en Excel o PDF.

REPORTES (encargados, menú ☰):
- Pedidos finalizados: historial de entregados y anulados.
- Reporte de ventas: ventas filtradas por fecha, medio de pago o repartidor.
- Productos vendidos: ranking de los más pedidos.
- Análisis de producción: cuánto preparar para una fecha específica.

MOVER UN PEDIDO DE SECCIÓN:
- Expandí el pedido → Operaciones → Mover a sección → elegí la nueva sección.

CAMBIAR REPARTIDOR:
- Expandí el pedido → Operaciones → desplegable Repartidor.

COBRAR EN ENTREGA:
- Expandí el pedido → tildá "Cobrar en entrega" → aparece el badge COBRAR en la lista.`;

app.post("/api/agente", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: "messages requerido" });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada" });
  try {
    const resp = await axios.post("https://api.anthropic.com/v1/messages", {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      system: SYSTEM_AGENTE,
      messages: messages.slice(-10),
    }, {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      }
    });
    const text = resp.data.content?.[0]?.text || "No pude generar una respuesta.";
    res.json({ reply: text });
  } catch (err) {
    console.error("Error agente IA:", err.response?.data || err.message);
    res.status(500).json({ error: "Error al consultar el agente" });
  }
});

// ─── RE-SYNC PERIÓDICO DE PEDIDOS RECIENTES ─────────────────────────
async function resyncPedidosRecientes() {
  try {
    const hace48hs = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/orders?per_page=50&created_at_min=${hace48hs}&aggregates=fulfillment_orders`,
      { headers }
    );
    const orders = response.data || [];
    for (const o of orders) {
      await pool.query(`
        INSERT INTO pedidos_tn (id, store_id, numero, estado_tn, payment_status, total, contact_email, contact_name, contact_phone, data, tn_created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (id) DO UPDATE SET numero=EXCLUDED.numero, estado_tn=EXCLUDED.estado_tn, payment_status=EXCLUDED.payment_status, total=EXCLUDED.total, contact_email=EXCLUDED.contact_email, contact_name=EXCLUDED.contact_name, contact_phone=EXCLUDED.contact_phone, data=EXCLUDED.data, updated_at=NOW()
      `, [o.id, String(o.store_id || ""), o.number || null, o.status || null, o.payment_status || null, parseFloat(o.total) || 0, o.contact_email || null, o.contact_name || null, o.contact_phone || null, JSON.stringify(o), o.created_at || null]);
    }
    console.log(`Re-sync: ${orders.length} pedidos refrescados`);
  } catch (err) { console.error("Re-sync error:", err.message); }
}

// El re-sync llama a TN; solo se agenda si la integración está configurada.
if (TN_ENABLED) {
  setInterval(resyncPedidosRecientes, 5 * 60 * 1000);
  setTimeout(resyncPedidosRecientes, 30000);
} else {
  console.warn("⚠️ Tienda Nube no configurada: re-sync periódico de pedidos deshabilitado");
}
app.listen(process.env.PORT || 3001, () => { console.log("Servidor corriendo"); });