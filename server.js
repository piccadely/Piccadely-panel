import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";
import crypto from "crypto";
import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";
import { initAuthDB, setupAuth } from "./auth.js";
import { mpRouter } from "./Routes/mp.js";

const { Pool } = pg;

// ─── VALIDACIÓN DE VARIABLES DE ENTORNO ──────────────────────────────
const REQUIRED_ENV = [
  "DATABASE_URL",
  "TN_STORE_ID",
  "TN_ACCESS_TOKEN",
  "TN_CLIENT_SECRET",
  "TF_APIKEY",
  "TF_APITOKEN",
  "TF_USERTOKEN_AT",
  "TF_USERTOKEN_FR",
  "JWT_SECRET",
  "ADMIN_SECRET",
];

const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error("❌ FATAL: faltan variables de entorno:", missing.join(", "));
  process.exit(1);
}

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
});

pool.on("connect", client => {
  client.query("SET search_path TO public").catch(console.error);
});

async function initDB() {
  await pool.query("SET search_path TO public");
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
  await pool.query(`CREATE TABLE IF NOT EXISTS repartidores (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, activo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());`);
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
  app.get("/api/products", async (req, res) => {
    try {
      const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`, { headers });
      res.json(r.data);
    } catch (err) { res.status(500).json({ error: "Error trayendo productos" }); }
  });

  app.get("/api/categories", async (req, res) => {
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
          comandasImpresas: r.comandas_impresas || 0,
      };
    });
    res.json(estados);
  } catch (err) { res.status(500).json({ error: "Error trayendo estados" }); }
});

app.post("/api/estados/:id", async (req, res) => {
  const { id } = req.params;
  const { estado, repartidor, tabManual, fechaManual, franjaManual, cobrar, usuario: usuarioAudit } = req.body;
  try {
    // Leer estado previo para auditoria
    const previo = await pool.query("SELECT * FROM pedidos_estados WHERE id=$1", [id]);
    const prevData = previo.rows[0] || {};

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
      INSERT INTO pedidos_estados (id, estado, repartidor, tab_manual, fecha_manual, franja_manual, cobrar, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (id) DO UPDATE SET
        estado=EXCLUDED.estado, repartidor=EXCLUDED.repartidor,
        tab_manual=EXCLUDED.tab_manual, fecha_manual=EXCLUDED.fecha_manual,
        franja_manual=EXCLUDED.franja_manual, cobrar=EXCLUDED.cobrar, updated_at=NOW()
    `, [id, estado, repartidor, tabManual, fechaManual, franjaManual, cobrar]);
    if (mailAnularPedido) enviarMailAnulacion(mailAnularPedido).catch(console.error);
    res.json({ ok: true });

    // Auditoria (no bloquea la respuesta)
    if (estado && estado !== prevData.estado) registrarAuditoria(usuarioAudit, "cambio_estado", "pedido", id, { anterior: prevData.estado || "Por empaquetar", nuevo: estado });
    if (estado === "Anulado" && prevData.estado !== "Anulado") registrarAuditoria(usuarioAudit, "anulacion", "pedido", id, {});
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
// ─── DATOS EDITABLES DE PEDIDO ────────────────────────────────────────
app.patch("/api/pedidos/:id/datos", async (req, res) => {
  const { id } = req.params;
const { esManual, cliente, telefono, direccion, barrio, zona, medioPago, nota, email, codigoPago, usuario: usuarioAudit } = req.body;  try {
    if (esManual) {
      await pool.query(
        `UPDATE pedidos_manuales SET cliente=$1, telefono=$2, direccion=$3, barrio=$4, zona=$5, medio_pago=$6, nota=$7, email=$8, codigo_pago=$9 WHERE id=$10`,
        [cliente, telefono, direccion, barrio, zona, medioPago, nota, email, codigoPago || "", id]
      );
    } else {
      await pool.query(
        `INSERT INTO pedidos_estados (id, cliente_override, telefono_override, direccion_override, barrio_override, zona_override, medio_pago_override, nota_override, email_override, updated_at)
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
codigoPago: r.codigo_pago || "", esManual: true, estado: "Por empaquetar", repartidor: "Sin asignar",
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
      INSERT INTO pedidos_manuales (id, numero, cliente, telefono, email, direccion, entre_calles, barrio, zona, fecha, franja, productos, total_num, total, pago, medio_pago, cobrar, tab_actual, local, nota)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `, [p.id, numero, p.cliente, p.telefono, p.email || "", p.direccion, p.entreCalles, p.barrio, p.zona, p.fecha, p.franja, p.productos, p.totalNum, p.total, p.pago, p.medioPago, p.cobrar, p.tabActual, p.local, p.nota]);
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
    estadosRes.rows.forEach(r => { estadosMap[r.id] = { estado: r.estado, repartidor: r.repartidor, fechaManual: r.fecha_manual, franjaManual: r.franja_manual, cobrar: r.cobrar, tabManual: r.tab_manual }; });
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
    provincia: "2", condicion_pago: "201", condicion_iva: esFacturaA ? "RI" : "CF",
    condicion_iva_operacion: esFacturaA ? "RI" : "CF", envia_por_mail: email ? "S" : "N", reclama_deuda: "N",
  };
  const descripcion = productos.map(p => p.descripcion).join(", ").substring(0, 200);
  const precioSinIva = esExento ? totalNum : Math.round((totalNum / 1.21) * 100) / 100;
  const detalle = [{ cantidad: 1, bonificacion_porcentaje: 0, afecta_stock: "N", producto: { descripcion, codigo: "VENTA", lista_precios: "standard", leyenda: "", unidad_bulto: 1, alicuota: esExento ? 0 : 21, precio_unitario_sin_iva: precioSinIva, actualiza_precio: "S" } }];
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
  try {
    const response = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`, { headers });
    res.json(response.data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/admin/webhooks/setup", requireAdmin, async (req, res) => {
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

setInterval(resyncPedidosRecientes, 5 * 60 * 1000);
setTimeout(resyncPedidosRecientes, 30000);
app.listen(process.env.PORT || 3001, () => { console.log("Servidor corriendo"); });