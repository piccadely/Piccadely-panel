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
import { whatsappWebhookRouter, revisarHuerfanosWhatsApp } from "./Routes/whatsappWebhook.js";
import { whatsappBandejaRouter } from "./Routes/whatsappBandeja.js";
import { whatsappAdminRouter } from "./Routes/whatsappAdmin.js";
import { normalizarTelefonoAR, mismoTelefonoAR } from "./Routes/telefonoAR.js";
import { autotestR2 } from "./r2Storage.js";
import { iniciarRetencionWhatsApp } from "./whatsappRetencion.js";
import { cotizadorRouter, clienteKeyDe } from "./Routes/cotizador.js";
import { regalosRouter } from "./Routes/regalos.js";
import { createRequire } from "module";
import { normalizarProducto, calcularEnvioTN, esExcluidoProduccion, esBasuraVenta, claveProducto } from "./productos-normalizacion.js"; // clave canónica + costo de envío TN + filtros de producción, compartidos con el front
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
    CREATE TABLE IF NOT EXISTS sobres (
      id SERIAL PRIMARY KEY,
      local_origen TEXT NOT NULL,
      monto_declarado NUMERIC NOT NULL,
      monto_real NUMERIC,
      concepto TEXT,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','recibido','rechazado')),
      caja_destino TEXT,
      fecha_creacion TEXT NOT NULL,
      fecha_resolucion TEXT,
      usuario_crea TEXT, usuario_resuelve TEXT,
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
    CREATE TABLE IF NOT EXISTS proveedores (
      id SERIAL PRIMARY KEY,
      razon_social TEXT NOT NULL,
      cuit TEXT,
      condicion_iva TEXT,
      email TEXT,
      telefono TEXT,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS categorias_gasto (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ordenes_compra (
      id SERIAL PRIMARY KEY,
      proveedor_id INTEGER REFERENCES proveedores(id),
      categoria_gasto_id INTEGER REFERENCES categorias_gasto(id),
      fecha TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      monto_total NUMERIC NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobada','recibida','anulada')),
      nota TEXT,
      usuario_crea TEXT,
      usuario_aprueba TEXT,
      fecha_aprobacion TEXT,
      motivo_anulacion TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS facturas_compra (
      id SERIAL PRIMARY KEY,
      proveedor_id INTEGER REFERENCES proveedores(id),
      categoria_gasto_id INTEGER REFERENCES categorias_gasto(id),
      orden_compra_id INTEGER REFERENCES ordenes_compra(id),
      proveedor_cuit TEXT,
      proveedor_razon_social TEXT,
      tipo_comprobante TEXT NOT NULL,
      punto_venta TEXT,
      numero_comprobante TEXT,
      cae TEXT,
      fecha TEXT NOT NULL,
      alicuota_iva NUMERIC NOT NULL,
      neto_gravado NUMERIC NOT NULL DEFAULT 0,
      iva NUMERIC NOT NULL DEFAULT 0,
      percep_iva NUMERIC NOT NULL DEFAULT 0,
      percep_iibb_bsas NUMERIC NOT NULL DEFAULT 0,
      percep_iibb_caba NUMERIC NOT NULL DEFAULT 0,
      neto_no_gravado NUMERIC NOT NULL DEFAULT 0,
      exentas NUMERIC NOT NULL DEFAULT 0,
      otros_tributos NUMERIC NOT NULL DEFAULT 0,
      total NUMERIC NOT NULL,
      estado_pago TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado_pago IN ('pendiente','pagada','anulada')),
      motivo_anulacion TEXT,
      usuario_crea TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_factura_compra_num
      ON facturas_compra (proveedor_id, tipo_comprobante, numero_comprobante)
      WHERE estado_pago != 'anulada';
    CREATE UNIQUE INDEX IF NOT EXISTS uq_factura_compra_orden
      ON facturas_compra (orden_compra_id) WHERE orden_compra_id IS NOT NULL AND estado_pago != 'anulada';
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
  // Área asignada a mano en el alta manual (1-10). NULL = sin asignar → el reporte de zonas
  // geolocaliza como siempre. Si tiene valor, MANDA sobre el geocodificado. Retrocompatible.
  await pool.query(`ALTER TABLE pedidos_estados ADD COLUMN IF NOT EXISTS area_manual INTEGER;`);
  // Compras Entrega 4 — pago (total) de facturas de proveedor. caja_origen NULL = pago externo.
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS fecha_pago TEXT;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS medio_pago TEXT;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS caja_origen TEXT;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS usuario_paga TEXT;`);
  // NC/ND de proveedor — vínculo informativo opcional a otra factura del mismo proveedor.
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS factura_asociada_id INTEGER REFERENCES facturas_compra(id);`);
  // Multi-alícuota: neto+IVA por alícuota (10,5 / 21 / 27). neto_gravado/iva/alicuota_iva viejos se
  // mantienen como espejo agregado (deprecados, no se borran). El 0%/exento va en sus columnas.
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS neto_105 NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS iva_105  NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS neto_21  NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS iva_21   NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS neto_27  NUMERIC NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS iva_27   NUMERIC NOT NULL DEFAULT 0;`);
  // Fecha de contabilización (imputación al libro IVA). El libro filtra por esta; la cuenta corriente/pagos usan `fecha`.
  await pool.query(`ALTER TABLE facturas_compra ADD COLUMN IF NOT EXISTS fecha_contable TEXT;`);
  await pool.query(`UPDATE facturas_compra SET fecha_contable = fecha WHERE fecha_contable IS NULL;`);
  // Pagos de compras SIN factura (pago a cuenta / anticipo a proveedor). Hoy solo filas 'a_cuenta': el pago de
  // factura sigue en facturas_compra (fecha_pago/medio_pago/caja_origen). 'factura' + factura_id quedan para cuando
  // se migren los pagos viejos (imputación / pago parcial, cambio aparte). caja_*_id sin FK, como gastos_comunes.
  await pool.query(`CREATE TABLE IF NOT EXISTS pagos_compra (
    id SERIAL PRIMARY KEY,
    tipo TEXT NOT NULL CHECK (tipo IN ('factura','a_cuenta')),
    proveedor_id INTEGER NOT NULL REFERENCES proveedores(id),
    factura_id INTEGER REFERENCES facturas_compra(id),
    fecha TEXT NOT NULL,
    monto NUMERIC NOT NULL CHECK (monto > 0),
    medio_pago TEXT NOT NULL,
    caja_origen TEXT,
    caja_movimiento_id INTEGER,
    concepto TEXT,
    observaciones TEXT,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    motivo_anulacion TEXT,
    usuario TEXT,
    usuario_anula TEXT,
    anulado_at TIMESTAMP,
    caja_movimiento_anulacion_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT pagos_compra_tipo_factura_chk CHECK (
      (tipo = 'factura' AND factura_id IS NOT NULL)
      OR (tipo = 'a_cuenta' AND factura_id IS NULL AND concepto IS NOT NULL AND btrim(concepto) <> ''))
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pagos_compra_proveedor ON pagos_compra (proveedor_id) WHERE estado = 'activo';`);
  // Cotizaciones / "Ventas a realizar" (pipeline). Antes se creaba a mano; ahora en initDB.
  await pool.query(`CREATE TABLE IF NOT EXISTS cotizaciones (
    id SERIAL PRIMARY KEY,
    cliente_nombre TEXT, empresa TEXT, email TEXT, telefono TEXT,
    personas INTEGER, modo TEXT, mix TEXT, fecha_evento TEXT, zona TEXT,
    nivel_elegido TEXT, opciones JSONB, total_elegido NUMERIC, con_bebidas BOOLEAN,
    canal TEXT, estado TEXT DEFAULT 'pendiente', notas TEXT,
    cliente_key TEXT, motivo_perdida TEXT, origen TEXT DEFAULT 'formulario',
    creada_en TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS cliente_key TEXT;`);
  await pool.query(`ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS motivo_perdida TEXT;`);
  await pool.query(`ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS origen TEXT DEFAULT 'formulario';`);
  // Backfill de cliente_key (idempotente): email lower+trim, o teléfono solo dígitos.
  await pool.query(`UPDATE cotizaciones SET cliente_key = COALESCE(NULLIF(lower(trim(email)),''), NULLIF(regexp_replace(COALESCE(telefono,''),'\\D','','g'),'')) WHERE cliente_key IS NULL;`);
  // CRM Entrega 1: notas y seguimiento por cliente (cliente_key = misma clave que /api/clientes). No se borran: se anulan.
  await pool.query(`CREATE TABLE IF NOT EXISTS clientes_notas (
    id SERIAL PRIMARY KEY,
    cliente_key TEXT NOT NULL CHECK (btrim(cliente_key) <> ''),
    tipo TEXT NOT NULL DEFAULT 'nota' CHECK (tipo IN ('nota','llamada','whatsapp','mail','reunion')),
    texto TEXT NOT NULL CHECK (btrim(texto) <> ''),
    proximo_contacto DATE,
    hecho BOOLEAN NOT NULL DEFAULT false,
    hecho_at TIMESTAMP,
    hecho_por TEXT,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    usuario TEXT,
    usuario_anula TEXT,
    anulado_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_notas_cliente ON clientes_notas (cliente_key);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_clientes_notas_proximo ON clientes_notas (proximo_contacto) WHERE proximo_contacto IS NOT NULL;`);
  // Gastos comunes (gastos sin factura de proveedor). Separado de Compras.
  await pool.query(`CREATE TABLE IF NOT EXISTS categorias_gasto_comun (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL,
    es_retiro BOOLEAN NOT NULL DEFAULT false,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS gastos_comunes (
    id SERIAL PRIMARY KEY,
    fecha TEXT NOT NULL,
    descripcion TEXT NOT NULL,
    monto NUMERIC NOT NULL CHECK (monto > 0),
    categoria_id INTEGER NOT NULL REFERENCES categorias_gasto_comun(id),
    caja_origen TEXT,
    caja_movimiento_id INTEGER,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    motivo_anulacion TEXT,
    usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`INSERT INTO categorias_gasto_comun (nombre, es_retiro)
    SELECT n, r FROM (VALUES ('Librería',false),('Limpieza',false),('Viáticos',false),('Mantenimiento',false),('Varios',false),('Retiros',true)) AS v(n, r)
    WHERE NOT EXISTS (SELECT 1 FROM categorias_gasto_comun);`);
  // RRHH Fase 1 (fichas, liquidaciones, novedades). NO calcula sueldos: registra lo que liquida el estudio.
  await pool.query(`CREATE TABLE IF NOT EXISTS empleados (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL, dni TEXT, cuil TEXT, fecha_nacimiento TEXT,
    domicilio TEXT, telefono TEXT, email TEXT, contacto_emergencia TEXT,
    local TEXT, puesto TEXT, categoria_convenio TEXT, jornada TEXT,
    fecha_ingreso TEXT, fecha_egreso TEXT,
    cbu_alias TEXT,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS liquidaciones_sueldo (
    id SERIAL PRIMARY KEY,
    empleado_id INTEGER NOT NULL REFERENCES empleados(id),
    periodo TEXT NOT NULL,
    bruto NUMERIC NOT NULL DEFAULT 0,
    no_remunerativo NUMERIC NOT NULL DEFAULT 0,
    deducciones NUMERIC NOT NULL DEFAULT 0,
    neto NUMERIC NOT NULL DEFAULT 0,
    contribuciones NUMERIC NOT NULL DEFAULT 0,
    notas TEXT, usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (empleado_id, periodo)
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS novedades_empleado (
    id SERIAL PRIMARY KEY,
    empleado_id INTEGER NOT NULL REFERENCES empleados(id),
    tipo TEXT NOT NULL CHECK (tipo IN ('adelanto','hora_extra','bono','descuento','otro')),
    fecha TEXT NOT NULL,
    monto NUMERIC NOT NULL CHECK (monto > 0),
    concepto TEXT,
    caja_origen TEXT,
    caja_movimiento_id INTEGER,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    motivo_anulacion TEXT, usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  // RRHH Fase 2 (pago de sueldos). El estado de la liquidación NO se guarda: se calcula (pagado = Σ pagos activos).
  await pool.query(`CREATE TABLE IF NOT EXISTS pagos_sueldo (
    id SERIAL PRIMARY KEY,
    liquidacion_id INTEGER NOT NULL REFERENCES liquidaciones_sueldo(id),
    fecha TEXT NOT NULL,
    monto NUMERIC NOT NULL CHECK (monto > 0),
    medio_pago TEXT NOT NULL,
    caja_origen TEXT,
    caja_movimiento_id INTEGER,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    motivo_anulacion TEXT, usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  // TESORERÍA Entrega A: cuentas bancarias / billeteras + movimientos + conciliación. Saldos calculados, no guardados.
  // Nombre único sin mayúsculas ni tildes (índice por expresión; translate/lower/btrim son IMMUTABLE).
  await pool.query(`CREATE TABLE IF NOT EXISTS cuentas_tesoreria (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL CHECK (btrim(nombre) <> ''),
    tipo TEXT NOT NULL CHECK (tipo IN ('banco','billetera')),
    saldo_inicial NUMERIC NOT NULL DEFAULT 0,
    fecha_saldo_inicial DATE NOT NULL,
    activa BOOLEAN NOT NULL DEFAULT true,
    notas TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_cuentas_tesoreria_nombre ON cuentas_tesoreria
    (lower(translate(btrim(nombre), 'ÁÀÄÂÉÈËÊÍÌÏÎÓÒÖÔÚÙÜÛÑáàäâéèëêíìïîóòöôúùüûñ', 'AAAAEEEEIIIIOOOOUUUUNaaaaeeeeiiiioooouuuun')));`);
  // transferencia_id agrupa las dos patas de una transferencia (cuenta↔cuenta o cuenta↔caja).
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS transferencias_tesoreria_seq;`);
  // origen_tipo ya admite los orígenes de la Entrega B (pagos/sueldos/gastos), así no hace falta otra migración.
  await pool.query(`CREATE TABLE IF NOT EXISTS movimientos_tesoreria (
    id SERIAL PRIMARY KEY,
    cuenta_id INTEGER NOT NULL REFERENCES cuentas_tesoreria(id),
    fecha DATE NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','egreso')),
    monto NUMERIC NOT NULL CHECK (monto > 0),
    concepto TEXT NOT NULL CHECK (btrim(concepto) <> ''),
    origen_tipo TEXT NOT NULL DEFAULT 'manual' CHECK (origen_tipo IN ('manual','transferencia','pago_factura','pago_a_cuenta','pago_sueldo','adelanto','adicional','gasto_comun')),
    origen_id INTEGER,
    transferencia_id INTEGER,
    conciliado BOOLEAN NOT NULL DEFAULT false,
    conciliado_at TIMESTAMP,
    conciliado_por TEXT,
    estado TEXT NOT NULL DEFAULT 'activo' CHECK (estado IN ('activo','anulado')),
    motivo_anulacion TEXT,
    usuario TEXT,
    usuario_anula TEXT,
    anulado_at TIMESTAMP,
    caja_movimiento_id INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT movimientos_tesoreria_transf_chk CHECK ((origen_tipo = 'transferencia') = (transferencia_id IS NOT NULL)),
    CONSTRAINT movimientos_tesoreria_conciliado_chk CHECK (NOT (conciliado AND estado = 'anulado'))
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mov_tesoreria_cuenta_fecha ON movimientos_tesoreria (cuenta_id, fecha);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mov_tesoreria_origen ON movimientos_tesoreria (origen_tipo, origen_id);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_mov_tesoreria_transferencia ON movimientos_tesoreria (transferencia_id) WHERE transferencia_id IS NOT NULL;`);
  // TESORERÍA Entrega B1: una cuenta como origen de pagos de compras y gastos comunes (caja O cuenta, nunca las dos).
  await pool.query(`ALTER TABLE pagos_compra ADD COLUMN IF NOT EXISTS cuenta_id INTEGER REFERENCES cuentas_tesoreria(id);`);
  await pool.query(`ALTER TABLE gastos_comunes ADD COLUMN IF NOT EXISTS cuenta_id INTEGER REFERENCES cuentas_tesoreria(id);`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagos_compra_un_origen_chk') THEN
      ALTER TABLE pagos_compra ADD CONSTRAINT pagos_compra_un_origen_chk CHECK (caja_origen IS NULL OR cuenta_id IS NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'gastos_comunes_un_origen_chk') THEN
      ALTER TABLE gastos_comunes ADD CONSTRAINT gastos_comunes_un_origen_chk CHECK (caja_origen IS NULL OR cuenta_id IS NULL);
    END IF;
  END $$;`);
  // El pago de factura es total: un solo pago ACTIVO por factura.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_pagos_compra_factura_activo ON pagos_compra (factura_id) WHERE tipo = 'factura' AND estado = 'activo';`);
  // Backfill idempotente: cada factura 'pagada' sin su fila en pagos_compra → fila tipo 'factura' con los datos del pago
  // que guardaba facturas_compra (desde acá el listado de pagos y la cuenta corriente leen solo pagos_compra).
  await pool.query(`INSERT INTO pagos_compra (tipo, proveedor_id, factura_id, fecha, monto, medio_pago, caja_origen, concepto, usuario)
    SELECT 'factura', fc.proveedor_id, fc.id, COALESCE(NULLIF(btrim(fc.fecha_pago), ''), fc.fecha), fc.total,
           COALESCE(NULLIF(btrim(fc.medio_pago), ''), 'Sin dato'), NULLIF(btrim(fc.caja_origen), ''),
           btrim(fc.tipo_comprobante || ' ' || COALESCE(NULLIF(btrim(fc.punto_venta), '') || '-', '') || COALESCE(fc.numero_comprobante, '')),
           fc.usuario_paga
    FROM facturas_compra fc
    WHERE fc.estado_pago = 'pagada' AND fc.proveedor_id IS NOT NULL AND fc.total > 0
      AND NOT EXISTS (SELECT 1 FROM pagos_compra pc WHERE pc.tipo = 'factura' AND pc.factura_id = fc.id AND pc.estado = 'activo');`);
  // TESORERÍA Entrega B2: RRHH. Cuenta como origen de pagos de sueldo y adelantos (caja O cuenta), medio de pago en los
  // adelantos y el id de la ENTRADA de caja que repone una anulación (antes no se guardaba).
  await pool.query(`ALTER TABLE pagos_sueldo ADD COLUMN IF NOT EXISTS cuenta_id INTEGER REFERENCES cuentas_tesoreria(id);`);
  await pool.query(`ALTER TABLE pagos_sueldo ADD COLUMN IF NOT EXISTS caja_movimiento_anulacion_id INTEGER;`);
  await pool.query(`ALTER TABLE novedades_empleado ADD COLUMN IF NOT EXISTS cuenta_id INTEGER REFERENCES cuentas_tesoreria(id);`);
  await pool.query(`ALTER TABLE novedades_empleado ADD COLUMN IF NOT EXISTS medio_pago TEXT;`);
  await pool.query(`ALTER TABLE novedades_empleado ADD COLUMN IF NOT EXISTS caja_movimiento_anulacion_id INTEGER;`);
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pagos_sueldo_un_origen_chk') THEN
      ALTER TABLE pagos_sueldo ADD CONSTRAINT pagos_sueldo_un_origen_chk CHECK (caja_origen IS NULL OR cuenta_id IS NULL);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'novedades_empleado_un_origen_chk') THEN
      ALTER TABLE novedades_empleado ADD CONSTRAINT novedades_empleado_un_origen_chk CHECK (caja_origen IS NULL OR cuenta_id IS NULL);
    END IF;
  END $$;`);
  // STOCK DE INSUMOS Fase 1 (NUEVO, separado del tablero de cocina/stock_lotes). Stock = Σ movimientos por insumo+local.
  await pool.query(`CREATE TABLE IF NOT EXISTS insumos (
    id SERIAL PRIMARY KEY,
    codigo INTEGER UNIQUE,
    nombre TEXT NOT NULL,
    categoria TEXT,
    unidad TEXT NOT NULL CHECK (unidad IN ('g','unidad')),
    peso_unidad_g NUMERIC,
    precio_sin_iva NUMERIC,
    precio_con_iva NUMERIC,
    stock_minimo NUMERIC NOT NULL DEFAULT 0,
    activo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS insumos_movimientos (
    id SERIAL PRIMARY KEY,
    insumo_id INTEGER NOT NULL REFERENCES insumos(id),
    local TEXT NOT NULL,
    tipo TEXT NOT NULL CHECK (tipo IN ('ingreso','ajuste','consumo')),
    cantidad NUMERIC NOT NULL,
    fecha TEXT NOT NULL,
    nota TEXT,
    referencia TEXT,
    usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  // STOCK Fase 2a/3a: recetas con módulos anidados y combos (SIN descuento automático; eso es Fase 2b).
  await pool.query(`CREATE TABLE IF NOT EXISTS recetas (
    id SERIAL PRIMARY KEY,
    nombre TEXT NOT NULL UNIQUE,
    tipo TEXT NOT NULL CHECK (tipo IN ('producto','modulo','combo')),
    activo BOOLEAN NOT NULL DEFAULT true,
    notas TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  // Fase 3a: sumar 'combo' al CHECK en bases ya creadas (idempotente).
  await pool.query(`ALTER TABLE recetas DROP CONSTRAINT IF EXISTS recetas_tipo_check;`);
  await pool.query(`ALTER TABLE recetas ADD CONSTRAINT recetas_tipo_check CHECK (tipo IN ('producto','modulo','combo'));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receta_productos (
    id SERIAL PRIMARY KEY,
    receta_id INTEGER NOT NULL REFERENCES recetas(id),
    producto_nombre TEXT NOT NULL,
    producto_clave TEXT NOT NULL UNIQUE
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS receta_lineas (
    id SERIAL PRIMARY KEY,
    receta_id INTEGER NOT NULL REFERENCES recetas(id),
    orden INTEGER NOT NULL DEFAULT 0,
    insumo_id INTEGER REFERENCES insumos(id),
    subreceta_id INTEGER REFERENCES recetas(id),
    modo TEXT NOT NULL DEFAULT 'unidades' CHECK (modo IN ('unidades','gramos')),
    cantidad NUMERIC NOT NULL CHECK (cantidad > 0),
    peso_g NUMERIC,
    desperdicio_pct NUMERIC NOT NULL DEFAULT 8,
    CHECK ((insumo_id IS NULL) <> (subreceta_id IS NULL))
  );`);
  // WhatsApp Cloud API (Meta): conversaciones por cliente + mensajes (entrantes/salientes) + statuses.
  // wa_id = número normalizado a formato AR canónico 549XXXXXXXXXX (clave única: un cliente = una conversación).
  // telefono_envio = el wa_id tal cual lo manda Meta (se responde a ese, sin reformatear).
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_conversaciones (
    id SERIAL PRIMARY KEY,
    wa_id TEXT NOT NULL UNIQUE,
    telefono_envio TEXT NOT NULL,
    nombre TEXT,
    estado TEXT NOT NULL DEFAULT 'bot' CHECK (estado IN ('bot','pendiente_agente','cerrada')),
    handoff_at TIMESTAMP,
    ultimo_mensaje_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_mensajes (
    id SERIAL PRIMARY KEY,
    conversacion_id INTEGER NOT NULL REFERENCES wa_conversaciones(id),
    wa_message_id TEXT UNIQUE,
    direccion TEXT NOT NULL CHECK (direccion IN ('in','out')),
    autor TEXT NOT NULL CHECK (autor IN ('cliente','bot','agente')),
    tipo TEXT NOT NULL DEFAULT 'text',
    texto TEXT,
    estado TEXT,
    error TEXT,
    wa_timestamp TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_mensajes_conv ON wa_mensajes (conversacion_id, id);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_statuses (
    id SERIAL PRIMARY KEY,
    wa_message_id TEXT NOT NULL,
    status TEXT NOT NULL,
    wa_timestamp TIMESTAMP,
    error TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE (wa_message_id, status)
  );`);
  // Fase 2 — bandeja multiagente (idempotente). Estado 'agente' = la tomó una persona (bot pausado).
  await pool.query(`ALTER TABLE wa_conversaciones DROP CONSTRAINT IF EXISTS wa_conversaciones_estado_check;`);
  await pool.query(`ALTER TABLE wa_conversaciones ADD CONSTRAINT wa_conversaciones_estado_check CHECK (estado IN ('bot','pendiente_agente','agente','cerrada'));`);
  await pool.query(`ALTER TABLE wa_conversaciones ADD COLUMN IF NOT EXISTS agente_id INTEGER;   -- usuarios.id (sin FK: usuarios se crea en initAuthDB, al final)`);
  await pool.query(`ALTER TABLE wa_conversaciones ADD COLUMN IF NOT EXISTS asignada_at TIMESTAMP;`);
  await pool.query(`ALTER TABLE wa_conversaciones ADD COLUMN IF NOT EXISTS ultimo_entrante_at TIMESTAMP;`);   // ventana de 24 h de Meta
  await pool.query(`ALTER TABLE wa_conversaciones ADD COLUMN IF NOT EXISTS no_leidos INTEGER NOT NULL DEFAULT 0;`);
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS usuario_id INTEGER;`);   // agente que escribió
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS usuario_nombre TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_conv_ultimo ON wa_conversaciones (ultimo_mensaje_at DESC);`);
  // Backfill de la ventana para conversaciones previas a esta fase (solo las que no la tienen).
  await pool.query(`UPDATE wa_conversaciones c SET ultimo_entrante_at = x.ult
    FROM (SELECT conversacion_id, MAX(COALESCE(wa_timestamp, created_at)) AS ult FROM wa_mensajes WHERE direccion = 'in' GROUP BY conversacion_id) x
    WHERE x.conversacion_id = c.id AND c.ultimo_entrante_at IS NULL;`);
  // Fase 3 — archivos (R2) y plantillas (idempotente).
  // media_estado: pendiente | ok | error | deshabilitado (R2 sin autotest OK) | vencido (borrado por retención).
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_id TEXT;`);       // id del media en Meta
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_key TEXT;`);      // clave en R2
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_mime TEXT;`);
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_nombre TEXT;`);
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_bytes INTEGER;`);
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS media_estado TEXT;`);
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS caption TEXT;`);        // pie de foto/documento (el bot NO lo lee)
  await pool.query(`ALTER TABLE wa_mensajes ADD COLUMN IF NOT EXISTS plantilla_nombre TEXT;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wa_mensajes_created ON wa_mensajes (created_at);`);   // retención
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_plantillas (
    id SERIAL PRIMARY KEY,
    meta_id TEXT UNIQUE,
    nombre TEXT NOT NULL,
    idioma TEXT NOT NULL DEFAULT 'es_AR',
    categoria TEXT,
    estado TEXT,                 -- APPROVED / PENDING / REJECTED / PAUSED / DISABLED / … (tal cual Meta)
    motivo TEXT,                 -- motivo de rechazo
    componentes JSONB,
    creada_por TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
  );`);
  // Fase 4 — interruptores sin redeploy (whatsappAjustes.js). SIN filas iniciales a propósito:
  // si no hay fila, el ajuste vale APAGADO (default seguro en una base nueva como la de producción).
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_ajustes (
    clave TEXT PRIMARY KEY,                -- wa_activo / bot_activo
    valor BOOLEAN NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW(),
    updated_by_id INTEGER,                 -- usuarios.id (sin FK: usuarios se crea al final, en initAuthDB)
    updated_by TEXT
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS wa_ajustes_historial (
    id SERIAL PRIMARY KEY,
    clave TEXT NOT NULL,
    valor_anterior BOOLEAN,
    valor BOOLEAN NOT NULL,
    usuario_id INTEGER,
    usuario TEXT,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS repartidores (id SERIAL PRIMARY KEY, nombre TEXT NOT NULL UNIQUE, activo BOOLEAN DEFAULT true, created_at TIMESTAMP DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS costos_areas (area INTEGER PRIMARY KEY, costo NUMERIC NOT NULL DEFAULT 1);`);
  await pool.query(`INSERT INTO costos_areas (area, costo) SELECT g, 1 FROM generate_series(1,10) g ON CONFLICT (area) DO NOTHING;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS geocoding_cache (
    address_key TEXT PRIMARY KEY,
    lat NUMERIC NOT NULL,
    lng NUMERIC NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
  );`);
  // Señales de confianza del geocoder (las usa el reporte de zonas para NO clasificar
  // direcciones dudosas). Retrocompatible: filas viejas quedan location_type NULL /
  // partial_match FALSE. El mapa (geocodificar()) NO las escribe; solo geocodificarConConfianza().
  await pool.query(`ALTER TABLE geocoding_cache ADD COLUMN IF NOT EXISTS location_type TEXT;`);
  await pool.query(`ALTER TABLE geocoding_cache ADD COLUMN IF NOT EXISTS partial_match BOOLEAN DEFAULT FALSE;`);
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
  // Índices para la búsqueda de cliente por email (autocompletar alta manual). Solo aceleran.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_manuales_email ON pedidos_manuales (lower(email));`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_tn_contact_email ON pedidos_tn (lower(contact_email));`);
     console.log("DB inicializada");
  await initAuthDB(pool);
}
// Después de crear las tablas: reporta entrantes de WhatsApp que quedaron sin responder (TODO en whatsappWebhook.js).
initDB().then(() => {
  revisarHuerfanosWhatsApp(pool);
  iniciarRetencionWhatsApp(pool);   // job diario de retención (cerradas y bot; nunca las atendidas)
}).catch(console.error);

// Transporter de mail (Gmail SMTP). Definido acá (antes de setupAuth) para inyectarlo al
// módulo de auth, que lo usa para enviar los códigos 2FA del login.
const mailTransporter = (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } })
  : null;

const { requireAuth, requireAdmin, requireRole } = setupAuth(app, pool, mailTransporter);

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
// (mailTransporter se define más arriba, antes de setupAuth, para inyectarlo al 2FA del auth)
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
app.use("/api/bot", botWhatsappRouter({ requireAuth }));   // POST /whatsapp (Botmaker, público) + GET /catalogo (debug, con login)
app.use("/api/whatsapp", whatsappWebhookRouter(pool));   // Cloud API de Meta: GET verificación + POST eventos (guarda, bot, envío)
app.use("/api/whatsapp", whatsappBandejaRouter(pool, { requireAuth }));   // bandeja multiagente (requiere login)
app.use("/api/whatsapp", whatsappAdminRouter(pool, { requireAuth }));     // Configuración WhatsApp + corte (solo admin/superadmin)
app.use("/api", cotizadorRouter(pool, mailTransporter, requireAdmin));
app.use("/api/regalos", regalosRouter(pool, mailTransporter));   // Cotizador de Regalos Empresariales (público: catálogo, cálculo y propuesta)

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
// Un pedido "como lo ve el panel" (overrides de pedidos_estados y pedidos_productos aplicados). COMPARTIDO por el
// reporte de pedidos y la ficha de cliente: misma precedencia que el front (override > TN / manual).
// est = estadoPedidoDeFila(fila de pedidos_estados) o {}; ov = { productos, total_num } de pedidos_productos o undefined.
const estadoPedidoDeFila = (r) => ({
  estado: r.estado, repartidor: r.repartidor, tabManual: r.tab_manual,
  fechaManual: r.fecha_manual, franjaManual: r.franja_manual, cobrar: r.cobrar,
  clienteOverride: r.cliente_override, telefonoOverride: r.telefono_override,
  direccionOverride: r.direccion_override, barrioOverride: r.barrio_override,
  zonaOverride: r.zona_override, medioPagoOverride: r.medio_pago_override,
  notaOverride: r.nota_override, emailOverride: r.email_override,
  codigoPagoOverride: r.codigo_pago_override, medioPagoOtroOverride: r.medio_pago_otro_override,
  motivoAnulacion: r.motivo_anulacion || null,
});
function filaPedidoTN(p, est, ov) {
  const estado = est.estado || "Por empaquetar";
  const { fecha, franja } = parsearFranjaBackend(p.owner_note);
  const tabActual = est.tabManual || clasificarPedidoBackend(p);
  const totalNum = ov ? Number(ov.total_num) : Number(p.total);
  const codigoPago = est.codigoPagoOverride
    ? est.codigoPagoOverride
    : (p.gateway_id ? String(p.gateway_id) : (p.transactions?.[0]?.id ? String(p.transactions[0].id) : ""));
  // Envío TN como ítem "Envío" (misma fórmula compartida que el front). Consistente en
  // Finalizados/Ventas/Reservas. El total (p.total) ya incluye el envío.
  const envioTN = calcularEnvioTN(p);
  const lineasTN = (p.products || []).map(pr => `${pr.name} x${pr.quantity}`);
  if (envioTN > 0) lineasTN.push("Envío x1");
  return {
    id: String(p.id), numero: `#${p.number}`,
    cliente: est.clienteOverride || p.contact_name || "",
    telefono: est.telefonoOverride || p.contact_phone || "",
    productos: ov ? ov.productos : lineasTN.join(", "),
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
    fechaDisplay: est.fechaManual || fecha,
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
    // Cupón de descuento TN (aditivo; para mostrarlo también en Finalizados).
    cuponCodigo: p.coupon?.[0]?.code || null,
    cuponTipo: p.coupon?.[0]?.type || null,
    descuentoMonto: parseFloat(p.discount_coupon || p.discount || 0) || 0,
  };
}
function filaPedidoManual(r, est, ov) {
  const tabActual = est.tabManual || r.tab_actual;
  const totalNum = ov ? Number(ov.total_num) : Number(r.total_num);
  return {
    id: r.id, numero: r.numero,
    cliente: est.clienteOverride || r.cliente || "",
    telefono: est.telefonoOverride || r.telefono || "",
    productos: ov ? ov.productos : r.productos,
    totalNum,
    total: ov ? `$${totalNum.toLocaleString("es-AR")}` : r.total,
    medioPago: est.medioPagoOverride || r.medio_pago,
    medioPagoOtro: est.medioPagoOtroOverride || "",
    codigoPago: est.codigoPagoOverride ? est.codigoPagoOverride : (r.codigo_pago || ""),
    repartidor: est.repartidor || "Sin asignar",
    estado: est.estado || "Por empaquetar",
    local: localLabelBackend(tabActual),
    tabActual,
    zona: est.zonaOverride || r.zona || "",
    fechaDisplay: est.fechaManual || r.fecha,
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
    // Manuales no tienen cupón de TN.
    cuponCodigo: null,
    cuponTipo: null,
    descuentoMonto: 0,
  };
}

async function handlerReportePedidos(req, res) {
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
    estadosRes.rows.forEach(r => { estadosMap[r.id] = estadoPedidoDeFila(r); });
    // Overrides de productos/total
    const overridesRes = await pool.query("SELECT * FROM pedidos_productos");
    const overridesMap = {};
    overridesRes.rows.forEach(r => { overridesMap[r.pedido_id] = { productos: r.productos, total_num: Number(r.total_num) }; });

    // Pedidos TN dentro del margen [desde - 30d, hasta + 5d] (la fecha de
    // entrega/fecha_manual puede diferir de la de creación).
    const tnRes = await pool.query(
      `SELECT t.data
       FROM pedidos_tn t
       WHERE t.tn_created_at BETWEEN ($1::date - INTERVAL '365 days') AND ($2::date + INTERVAL '5 days')
       ORDER BY t.tn_created_at DESC`,
      [desde, hasta]
    );

    const resultado = [];

    for (const row of tnRes.rows) {
      const p = row.data;
      const fila = filaPedidoTN(p, estadosMap[String(p.id)] || {}, overridesMap[String(p.id)]);
      if (!incluirActivos && fila.estado !== "Entregado" && fila.estado !== "Anulado") continue;
      if (!fila.fechaDisplay || fila.fechaDisplay < desde || fila.fechaDisplay > hasta) continue;
      resultado.push(fila);
    }

    // Manuales — son livianos; se traen todos y se filtran por fechaDisplay.
    const manualesRes = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    for (const r of manualesRes.rows) {
      const fila = filaPedidoManual(r, estadosMap[r.id] || {}, overridesMap[r.id]);
      if (!incluirActivos && fila.estado !== "Entregado" && fila.estado !== "Anulado") continue;
      if (!fila.fechaDisplay || fila.fechaDisplay < desde || fila.fechaDisplay > hasta) continue;
      resultado.push(fila);
    }

    res.json(resultado);
  } catch (err) {
    console.error("Error /api/reportes/pedidos:", err.message);
    res.status(500).json({ error: "Error trayendo reporte de pedidos" });
  }
}
// General (caja / reservas / productos / finalizados): cualquier usuario logueado.
// El modo fusionado (incluirActivos = "por vender") es SOLO admin.
app.get("/api/reportes/pedidos", requireAuth, (req, res) => {
  const incluirActivos = req.query.incluirActivos === "1" || req.query.incluirActivos === "true";
  if (incluirActivos && !["admin", "superadmin"].includes(req.user?.rol)) return res.status(403).json({ error: "Requiere rol admin" });
  return handlerReportePedidos(req, res);
});
// Endpoint dedicado ADMIN-ONLY: Dashboard ejecutivo y Reporte de ventas (misma data que
// /api/reportes/pedidos, pero cerrado por rol para que el encargado/operarios no lo lean).
app.get("/api/reportes/ventas-admin", requireAdmin, handlerReportePedidos);

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

app.get("/api/reportes/zonas", requireAdmin, async (req, res) => {
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
    const estadosRes = await pool.query("SELECT id, estado, repartidor, fecha_manual, tab_manual, area_manual FROM pedidos_estados");
    const estadosMap = {};
    estadosRes.rows.forEach(r => { estadosMap[r.id] = { estado: r.estado, repartidor: r.repartidor, fechaManual: r.fecha_manual, tabManual: r.tab_manual, areaManual: r.area_manual }; });

    // Cache de geocoding: address_key -> {lat,lng,confiable}. Una sola query bulk. Las que
    // falten se geocodifican al vuelo más abajo (con confianza) y se agregan a este mapa.
    const geoRes = await pool.query("SELECT address_key, lat, lng, location_type, partial_match FROM geocoding_cache");
    const geoMap = {};
    geoRes.rows.forEach(r => {
      geoMap[r.address_key] = { lat: Number(r.lat), lng: Number(r.lng), confiable: esGeoConfiable(r.location_type, r.partial_match) };
    });

    // Costos por área (desde la tabla, fallback 1). Una sola lectura.
    const costoMap = await cargarCostosAreas();

    // Acumulador por repartidor (texto tal cual, sin joinear con la tabla repartidores)
    // + lista de pedidos (detalle por pedido para el Excel).
    const porRepartidor = {};
    const pedidos = [];
    const registros = [];   // se llenan en los loops; se clasifican DESPUÉS del geocoding pre-pass
    const nuevoRep = () => {
      const o = { sin_coordenada: 0, fuera_de_area: 0, dudosa: 0, total_pedidos: 0, total_costo: 0 };
      for (let n = 1; n <= 10; n++) o["area" + n] = 0;
      return o;
    };
    // direccion/barrio LEGIBLES (crudos); addressKey ya viene normalizado (lower+trim).
    // "dudosa" = geocodificó pero con baja confianza (partial_match / location_type impreciso):
    // NO la metemos en un área para no contaminar costos; queda para revisión manual.
    // areaManual (1-10) = área asignada a mano en el alta: MANDA sobre el geocodificado
    // (no se geocodifica ni corre point-in-polygon).
    const procesar = ({ numero, direccion, barrio, repartidor, addressKey, areaManual, fechaDisplay }) => {
      const rep = repartidor || "Sin asignar";
      if (!porRepartidor[rep]) porRepartidor[rep] = nuevoRep();
      const acc = porRepartidor[rep];
      acc.total_pedidos++;
      let area = null, motivo = null;
      const areaOverride = sanitizarAreaManual(areaManual);
      if (areaOverride != null) {
        area = areaOverride;
        acc["area" + area]++; acc.total_costo += (costoMap[String(area)] || 0);
      } else {
        const geo = geoMap[addressKey];
        if (!geo) { acc.sin_coordenada++; motivo = "sin_coordenada"; }
        else if (geo.confiable === false) { acc.dudosa++; motivo = "dudosa"; }
        else {
          area = areaDePunto(geo.lat, geo.lng);
          if (area == null) { acc.fuera_de_area++; motivo = "fuera_de_area"; }
          else { acc["area" + area]++; acc.total_costo += (costoMap[String(area)] || 0); }
        }
      }
      pedidos.push({ numero, direccion, barrio, repartidor: rep, area, motivo, fecha: fechaDisplay });
    };

    // TN — ventana amplia por fecha de creación; se filtra por fechaDisplay del rango.
    const tnRes = await pool.query(
      `SELECT t.data FROM pedidos_tn t
       WHERE t.tn_created_at BETWEEN ($1::date - INTERVAL '365 days') AND ($2::date + INTERVAL '5 days')
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
      const addressFull = `${dir}, ${barrio}, Buenos Aires, Argentina`;
      const addressKey = addressFull.toLowerCase().trim();
      registros.push({ numero: `#${p.number}`, direccion: dir, barrio, repartidor: est.repartidor, addressKey, addressFull, areaManual: est.areaManual, fechaDisplay });
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
      const addressFull = `${dir}, ${barrio}, Buenos Aires, Argentina`;
      const addressKey = addressFull.toLowerCase().trim();
      registros.push({ numero: p.numero, direccion: dir, barrio, repartidor: est.repartidor, addressKey, addressFull, areaManual: est.areaManual, fechaDisplay });
    }

    // ─── Geocoding pre-pass (al vuelo, con confianza) ────────────────────────
    // Direcciones de este rango que NO están en cache. Dedup por addressKey para no
    // geocodificar la misma dos veces. Secuencial (como el mapa) — la primera corrida de
    // un rango paga las llamadas a Google; después queda cacheado (persiste, sin TTL).
    // Tope defensivo: si un rango tuviera muchísimas nuevas, no explota (el resto queda
    // "sin_coordenada" hasta una próxima corrida, y se avisa con geocode.truncado).
    const LIMITE_GEOCODE = 500;
    const faltantes = new Map();   // addressKey -> addressFull (casing original para Google)
    for (const r of registros) {
      if (sanitizarAreaManual(r.areaManual) != null) continue;   // área manual: no se geocodifica
      if (!geoMap[r.addressKey] && !faltantes.has(r.addressKey)) faltantes.set(r.addressKey, r.addressFull);
    }
    let geocodificadas = 0, geocodeTruncado = false;
    for (const [addressKey, addressFull] of faltantes) {
      if (geocodificadas >= LIMITE_GEOCODE) { geocodeTruncado = true; break; }
      const g = await geocodificarConConfianza(addressFull);
      geocodificadas++;
      if (g) geoMap[addressKey] = { lat: g.lat, lng: g.lng, confiable: g.confiable };
      // si g es null (Google no resolvió / sin API key): se deja fuera del mapa -> sin_coordenada
    }

    // Clasificación final (ya con el cache completado por el pre-pass).
    for (const r of registros) procesar(r);

    // Filas por repartidor (orden alfabético) + totales por columna + gran total.
    const repartidores = Object.keys(porRepartidor)
      .sort((a, b) => a.localeCompare(b))
      .map(nombre => ({ repartidor: nombre, ...porRepartidor[nombre] }));
    const totales = nuevoRep();
    for (const r of repartidores) {
      for (let n = 1; n <= 10; n++) totales["area" + n] += r["area" + n];
      totales.sin_coordenada += r.sin_coordenada;
      totales.fuera_de_area += r.fuera_de_area;
      totales.dudosa += r.dudosa;
      totales.total_pedidos += r.total_pedidos;
      totales.total_costo += r.total_costo;
    }
    res.json({ desde, hasta, costoArea: costoMap, repartidores, totales, pedidos,
      geocode: { faltantes: faltantes.size, geocodificadas, truncado: geocodeTruncado, limite: LIMITE_GEOCODE } });
  } catch (err) {
    console.error("Error /api/reportes/zonas:", err.message);
    res.status(500).json({ error: "Error generando reporte de zonas" });
  }
});

  app.get("/api/products", async (req, res) => {
    if (!TN_ENABLED) { console.warn("⚠️ Tienda Nube no configurada: /api/products devuelve []"); return res.json([]); }
    // TN pagina con ?page=N&per_page=200 (200 = máximo por página). Traemos TODAS las páginas
    // (mismo patrón que el backfill de pedidos), si no los productos >200 quedan afuera.
    const PER_PAGE = 200, MAX_PAGES = 50;   // tope de seguridad: 10.000 productos
    const todos = [];
    let page = 1;
    try {
      while (page <= MAX_PAGES) {
        const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=${PER_PAGE}&page=${page}`, { headers });
        const lote = Array.isArray(r.data) ? r.data : [];
        todos.push(...lote);
        if (lote.length < PER_PAGE) break;   // última página
        page++;
      }
      res.json(todos);
    } catch (err) {
      // Si una página falla, no dejamos el catálogo a medias en silencio: si ya juntamos algo,
      // lo devolvemos (mejor incompleto que vacío) y logueamos; si no juntamos nada, error 500.
      console.error(`Error /api/products (página ${page}, ${todos.length} juntados):`, err.message);
      if (todos.length > 0) return res.json(todos);
      res.status(500).json({ error: "Error trayendo productos" });
    }
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
          areaManual: r.area_manual ?? null,
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
    // Área manual: se actualiza SOLO si el front mandó la clave 'areaManual' (1-10 o NULL para
    // "sin asignar"). Si la clave NO vino (front viejo), no se toca -> anti-clobber. El front
    // SIEMPRE manda el valor vigente al editar cualquier campo, así que re-manda el área actual
    // sin pisarla; y al elegir "(sin asignar)" manda NULL y la limpia.
    if ("areaManual" in req.body) {
      await pool.query(
        `INSERT INTO pedidos_estados (id, area_manual, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET area_manual = EXCLUDED.area_manual, updated_at = NOW()`,
        [id, sanitizarAreaManual(req.body.areaManual)]
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
    // LEFT JOIN a pedidos_estados para traer el area_manual (vive ahí, no en pedidos_manuales),
    // así el objeto del pedido manual ya carga su área para el select de edición.
    const result = await pool.query("SELECT m.*, e.area_manual FROM pedidos_manuales m LEFT JOIN pedidos_estados e ON e.id = m.id ORDER BY m.created_at DESC");
    const pedidos = result.rows.map(r => ({
      id: r.id, numero: r.numero, cliente: r.cliente, telefono: r.telefono, email: r.email || "",
      direccion: r.direccion, entreCalles: r.entre_calles, barrio: r.barrio, zona: r.zona,
      fecha: r.fecha, franja: r.franja, fechaDisplay: r.fecha, franjaDisplay: r.franja || "Sin franja",
      productos: r.productos, totalNum: Number(r.total_num), total: r.total,
      pago: r.pago, medioPago: r.medio_pago, cobrar: r.cobrar,
      tabActual: r.tab_actual, local: r.local, nota: r.nota,
codigoPago: r.codigo_pago || "", esManual: true, esCorporativo: !!r.es_corporativo, estado: "Por empaquetar", repartidor: "Sin asignar",
      areaManual: r.area_manual ?? null,
    }));
    res.json(pedidos);
  } catch (err) { res.status(500).json({ error: "Error trayendo pedidos manuales" }); }
});

// ─── BUSCAR CLIENTE POR EMAIL O TELÉFONO (autocompletar alta manual) ──
// Datos del cliente de UN pedido (manual o TN) con los overrides de pedidos_estados
// (prioridad si no vacíos). Lo usan la búsqueda por email y la búsqueda por teléfono.
function datosClienteDePedido(canal, p, ov = {}) {
  let base;
  if (canal === "manual") {
    base = {
      cliente: p.cliente || "", telefono: p.telefono || "", email: p.email || "",
      direccion: p.direccion || "", entreCalles: p.entre_calles || "",
      barrio: p.barrio || "", zona: p.zona || "", nota: p.nota || "",
    };
  } else {
    const d = p.data || {};
    const sa = d.shipping_address || {};
    const direccion = `${sa.address || ""} ${sa.number || ""}${sa.floor ? ` ${sa.floor}` : ""}`.trim();
    base = {
      cliente: d.contact_name || "", telefono: d.contact_phone || p.contact_phone || "", email: d.contact_email || p.contact_email || "",
      direccion, entreCalles: "", // TN no tiene entre calles
      barrio: sa.locality || sa.city || "",
      zona: d.fulfillments?.[0]?.shipping?.option?.name || "",
      nota: d.note || "",
    };
  }
  const pick = (v, b) => (v !== null && v !== undefined && String(v).trim() !== "") ? v : b;
  return {
    cliente: pick(ov.cliente_override, base.cliente),
    telefono: pick(ov.telefono_override, base.telefono),
    email: pick(ov.email_override, base.email),
    direccion: pick(ov.direccion_override, base.direccion),
    entreCalles: base.entreCalles, // no hay override de entre calles
    barrio: pick(ov.barrio_override, base.barrio),
    zona: pick(ov.zona_override, base.zona),
    nota: pick(ov.nota_override, base.nota),
  };
}

// Por email: datos del pedido MÁS RECIENTE (manual o TN) con ese email + cuántos pedidos tiene.
// Solo lectura, con login (devuelve datos personales). No incluye CUIT (por decisión).
app.get("/api/clientes/buscar", requireAuth, async (req, res) => {
  const email = String(req.query.email || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ error: "email requerido" });
  try {
    // Pedido más reciente de cada canal.
    const manRes = await pool.query(
      "SELECT id, cliente, telefono, direccion, entre_calles, barrio, zona, nota, created_at FROM pedidos_manuales WHERE lower(email) = $1 ORDER BY created_at DESC LIMIT 1",
      [email]
    );
    const tnRes = await pool.query(
      "SELECT id, data, tn_created_at FROM pedidos_tn WHERE lower(contact_email) = $1 ORDER BY tn_created_at DESC LIMIT 1",
      [email]
    );
    const man = manRes.rows[0] || null;
    const tn = tnRes.rows[0] || null;
    if (!man && !tn) return res.json({ encontrado: false });

    // Ganador = el más reciente entre ambos (created_at vs tn_created_at).
    const fMan = man ? new Date(man.created_at).getTime() : -Infinity;
    const fTn = tn ? new Date(tn.tn_created_at).getTime() : -Infinity;
    const usarManual = fMan >= fTn;
    const pedidoId = usarManual ? man.id : String(tn.id);

    const ovRes = await pool.query(
      "SELECT cliente_override, telefono_override, direccion_override, barrio_override, zona_override, nota_override FROM pedidos_estados WHERE id = $1",
      [pedidoId]
    );
    const cntRes = await pool.query(
      "SELECT (SELECT count(*) FROM pedidos_manuales WHERE lower(email) = $1) + (SELECT count(*) FROM pedidos_tn WHERE lower(contact_email) = $1) AS n",
      [email]
    );
    const { email: _email, ...datos } = datosClienteDePedido(usarManual ? "manual" : "tn", usarManual ? man : tn, ovRes.rows[0] || {});
    res.json({ encontrado: true, ...datos, pedidos: Number(cntRes.rows[0]?.n) || 1 });
  } catch (err) {
    console.error("Error GET /api/clientes/buscar:", err.message);
    res.status(500).json({ error: "Error buscando cliente" });
  }
});

// Por teléfono: compara normalizado (formatos AR: +54, 9, 0, 15; sin código de área → últimos 8)
// contra los teléfonos de pedidos manuales y de TN, con sus overrides. Agrupa por cliente
// (nombre normalizado) y de cada uno devuelve los datos del pedido MÁS RECIENTE + cuántos pedidos tiene.
// Si hay varios clientes distintos con ese teléfono, vienen todos (el más reciente primero).
app.get("/api/clientes/buscar-telefono", requireAuth, async (req, res) => {
  const clave = normalizarTelefonoAR(req.query.telefono);
  if (clave.length < 8) return res.status(400).json({ error: "teléfono incompleto (mínimo 8 dígitos)" });
  try {
    // Prefiltro en SQL por los últimos 6 dígitos (no cambian con prefijos); la comparación fina va en JS.
    const fin6 = clave.slice(-6);
    const OV = "e.cliente_override, e.telefono_override, e.email_override, e.direccion_override, e.barrio_override, e.zona_override, e.nota_override";
    const manRes = await pool.query(
      `SELECT m.id, m.cliente, m.telefono, m.email, m.direccion, m.entre_calles, m.barrio, m.zona, m.nota, m.created_at AS fecha, ${OV}
         FROM pedidos_manuales m LEFT JOIN pedidos_estados e ON e.id = m.id
        WHERE right(regexp_replace(COALESCE(NULLIF(trim(e.telefono_override), ''), m.telefono, ''), '\\D', '', 'g'), 6) = $1`,
      [fin6]
    );
    const tnRes = await pool.query(
      `SELECT t.id, t.data, t.contact_phone, t.contact_email, t.tn_created_at AS fecha, ${OV}
         FROM pedidos_tn t LEFT JOIN pedidos_estados e ON e.id = t.id::text
        WHERE right(regexp_replace(COALESCE(NULLIF(trim(e.telefono_override), ''), t.contact_phone, t.data->>'contact_phone', ''), '\\D', '', 'g'), 6) = $1`,
      [fin6]
    );
    const pedidos = [
      ...manRes.rows.map((r) => ({ fecha: r.fecha, datos: datosClienteDePedido("manual", r, r) })),
      ...tnRes.rows.map((r) => ({ fecha: r.fecha, datos: datosClienteDePedido("tn", r, r) })),
    ].filter((p) => mismoTelefonoAR(p.datos.telefono, clave))
     .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0));

    // Un cliente = mismo nombre (sin acentos, mayúsculas ni espacios de más); sin nombre → por email.
    const claveCliente = (d) => String(d.cliente || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim() || String(d.email || "").toLowerCase().trim() || "(sin nombre)";
    const grupos = new Map();
    for (const p of pedidos) {
      const k = claveCliente(p.datos);
      if (!grupos.has(k)) grupos.set(k, { ...p.datos, pedidos: 0, ultimoPedido: p.fecha });   // el primero es el más reciente
      grupos.get(k).pedidos++;
    }
    const clientes = [...grupos.values()];
    res.json({ encontrado: clientes.length > 0, clientes });
  } catch (err) {
    console.error("Error GET /api/clientes/buscar-telefono:", err.message);
    res.status(500).json({ error: "Error buscando cliente" });
  }
});

// Área manual válida = entero 1-10; cualquier otra cosa (null, "", fuera de rango) → null.
function sanitizarAreaManual(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return (Number.isInteger(n) && n >= 1 && n <= 10) ? n : null;
}

app.post("/api/pedidos-manuales", async (req, res) => {
  const p = req.body;
  try {
    const seqRes = await pool.query("SELECT nextval('pedidos_manuales_seq') AS n");
    const numero = `#M${seqRes.rows[0].n}`;
    await pool.query(`
      INSERT INTO pedidos_manuales (id, numero, cliente, telefono, email, direccion, entre_calles, barrio, zona, fecha, franja, productos, total_num, total, pago, medio_pago, cobrar, tab_actual, local, nota, es_corporativo)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
    `, [p.id, numero, p.cliente, p.telefono, p.email || "", p.direccion, p.entreCalles, p.barrio, p.zona, p.fecha, p.franja, p.productos, p.totalNum, p.total, p.pago, p.medioPago, p.cobrar, p.tabActual, p.local, p.nota, !!p.esCorporativo]);
    // Área manual (override del reporte de zonas). Se guarda en pedidos_estados; upsert de una
    // sola columna (no toca estado/repartidor/overrides). Solo si vino un valor válido 1-10.
    const areaManual = sanitizarAreaManual(p.areaManual);
    if (areaManual != null) {
      await pool.query(
        `INSERT INTO pedidos_estados (id, area_manual, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (id) DO UPDATE SET area_manual = EXCLUDED.area_manual, updated_at = NOW()`,
        [p.id, areaManual]
      );
    }
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

// ─── COMPRAS — ABM PROVEEDORES Y CATEGORÍAS DE GASTO ────────────────────
// Cimiento del módulo de compras (admin + superadmin). Después: órdenes, facturas, pagos, libro.
const CONDICIONES_IVA = ["RI", "Monotributo", "Exento", "CF"];

// Fecha de contabilización (imputación al libro IVA). Default: si la factura es de un mes anterior al
// actual (zona AR) → HOY; si es del mes actual (o futuro) → igual a la fecha. Nunca anterior a la fecha.
function calcularFechaContable(fecha, provista) {
  const hoy = fechaArgentinaISO();
  let fc = (provista && String(provista).trim()) ? String(provista).trim() : null;
  if (!fc) fc = (String(fecha).slice(0, 7) < hoy.slice(0, 7)) ? hoy : fecha;
  if (!esFechaISO(fc)) return { error: "Fecha de contabilización inválida (YYYY-MM-DD)." };
  if (fc < fecha) return { error: "La fecha de contabilización no puede ser anterior a la fecha de la factura." };
  return { fechaContable: fc };
}
// Razón social normalizada para detectar duplicados (minúsculas + espacios colapsados).
const razonNorm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
// Comprobante repetido = mismo proveedor + tipo (sin tildes/mayúsculas) + punto de venta + número, normalizados
// (solo dígitos y sin ceros a la izquierda: "0001-00001234" = "1-1234"). Las anuladas no cuentan (se pueden recargar).
// Complementa el índice uq_factura_compra_num (que compara el texto tal cual y no incluye el punto de venta).
const numComprobanteNorm = (s) => { const d = String(s || "").replace(/\D/g, "").replace(/^0+/, ""); return d || String(s || "").trim().toUpperCase(); };
async function comprobanteCompraRepetido(exec, { proveedorId, tipo, puntoVenta, numero, excluirId = null }) {
  const r = await exec.query(
    "SELECT id, tipo_comprobante, punto_venta, numero_comprobante, fecha, estado_pago FROM facturas_compra WHERE proveedor_id = $1 AND estado_pago <> 'anulada' AND ($2::int IS NULL OR id <> $2)",
    [proveedorId, excluirId]
  );
  const t = tipoCompraNorm(tipo).replace(/\s+/g, " ").trim(), pv = numComprobanteNorm(puntoVenta), n = numComprobanteNorm(numero);
  return r.rows.find(f => tipoCompraNorm(f.tipo_comprobante).replace(/\s+/g, " ").trim() === t
    && numComprobanteNorm(f.punto_venta) === pv && numComprobanteNorm(f.numero_comprobante) === n) || null;
}
// 23505 de los índices únicos de facturas_compra → 409 con mensaje claro (null si es otro índice).
// uq_factura_compra_num NO cuenta anuladas y NO mira el punto de venta: mismo proveedor + tipo + número (texto tal cual).
function msgUnicoFacturaCompra(err) {
  if (err.constraint === "uq_factura_compra_num") return "Ya existe un comprobante de este proveedor con el mismo tipo y número (sin anular). Ese control no distingue el punto de venta: revisá el número o el tipo de comprobante.";
  if (err.constraint === "uq_factura_compra_orden") return "Esa orden de compra ya tiene una factura cargada (sin anular).";
  return null;
}
const msgComprobanteRepetido = (f) =>`Ya está cargado ${f.tipo_comprobante} ${f.punto_venta ? `${f.punto_venta}-` : ""}${f.numero_comprobante} de este proveedor (fecha ${f.fecha}, ${f.estado_pago}). Revisá el número: no se puede cargar dos veces el mismo comprobante.`;

app.get("/api/compras/proveedores", requireAdmin, async (req, res) => {
  try {
    // Por defecto solo activos (compat). incluirInactivos=1 → todos (la vista Proveedores filtra en el front).
    const sql = req.query.incluirInactivos === "1"
      ? "SELECT * FROM proveedores ORDER BY razon_social ASC"
      : "SELECT * FROM proveedores WHERE activo = true ORDER BY razon_social ASC";
    const result = await pool.query(sql);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/proveedores", requireAdmin, async (req, res) => {
  const { razon_social, cuit, condicion_iva, email, telefono, confirmar } = req.body;
  if (!razon_social || !razon_social.trim()) return res.status(400).json({ error: "La razón social es obligatoria." });
  const cuitLimpio = cuit ? String(cuit).replace(/\D/g, "") : "";
  if (cuitLimpio && cuitLimpio.length !== 11) return res.status(400).json({ error: "El CUIT debe tener 11 dígitos." });
  if (condicion_iva && !CONDICIONES_IVA.includes(condicion_iva)) return res.status(400).json({ error: "Condición de IVA inválida." });
  try {
    // Duplicado por CUIT → bloquea. Sin CUIT, misma razón social → avisa (requiere confirmación).
    if (cuitLimpio) {
      const dup = await pool.query("SELECT razon_social FROM proveedores WHERE regexp_replace(coalesce(cuit,''),'\\D','','g') = $1 LIMIT 1", [cuitLimpio]);
      if (dup.rows.length > 0) return res.status(409).json({ error: `Ya existe ${dup.rows[0].razon_social} con ese CUIT.` });
    } else if (!confirmar) {
      const dupN = await pool.query("SELECT razon_social FROM proveedores WHERE lower(trim(regexp_replace(razon_social,'\\s+',' ','g'))) = $1 LIMIT 1", [razonNorm(razon_social)]);
      if (dupN.rows.length > 0) return res.status(409).json({ requiereConfirmacion: true, error: `Ya existe un proveedor "${dupN.rows[0].razon_social}" con esa razón social. ¿Crearlo igual?` });
    }
    const result = await pool.query(
      "INSERT INTO proveedores (razon_social, cuit, condicion_iva, email, telefono) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [razon_social.trim(), cuitLimpio || null, condicion_iva || null, email?.trim() || null, telefono?.trim() || null]
    );
    res.json({ ok: true, proveedor: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/compras/proveedores/:id", requireAdmin, async (req, res) => {
  const { razon_social, cuit, condicion_iva, email, telefono, confirmar } = req.body;
  let cuitLimpio;
  if (cuit !== undefined) {
    cuitLimpio = cuit ? String(cuit).replace(/\D/g, "") : null;
    if (cuitLimpio && cuitLimpio.length !== 11) return res.status(400).json({ error: "El CUIT debe tener 11 dígitos." });
  }
  if (condicion_iva && !CONDICIONES_IVA.includes(condicion_iva)) return res.status(400).json({ error: "Condición de IVA inválida." });
  try {
    // Mismos chequeos de duplicado que en alta, excluyendo el propio id.
    if (cuitLimpio) {
      const dup = await pool.query("SELECT razon_social FROM proveedores WHERE regexp_replace(coalesce(cuit,''),'\\D','','g') = $1 AND id <> $2 LIMIT 1", [cuitLimpio, req.params.id]);
      if (dup.rows.length > 0) return res.status(409).json({ error: `Ya existe ${dup.rows[0].razon_social} con ese CUIT.` });
    } else if (razon_social && !confirmar) {
      const dupN = await pool.query("SELECT razon_social FROM proveedores WHERE lower(trim(regexp_replace(razon_social,'\\s+',' ','g'))) = $1 AND id <> $2 LIMIT 1", [razonNorm(razon_social), req.params.id]);
      if (dupN.rows.length > 0) return res.status(409).json({ requiereConfirmacion: true, error: `Ya existe otro proveedor "${dupN.rows[0].razon_social}" con esa razón social. ¿Guardar igual?` });
    }
    await pool.query(
      `UPDATE proveedores SET
         razon_social = COALESCE($1, razon_social),
         cuit = COALESCE($2, cuit),
         condicion_iva = COALESCE($3, condicion_iva),
         email = COALESCE($4, email),
         telefono = COALESCE($5, telefono)
       WHERE id = $6`,
      [razon_social?.trim() || null, cuitLimpio ?? null, condicion_iva || null, email?.trim() || null, telefono?.trim() || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/compras/proveedores/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE proveedores SET activo = false WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/compras/categorias", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM categorias_gasto WHERE activo = true ORDER BY nombre ASC");
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/categorias", requireAdmin, async (req, res) => {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  try {
    const result = await pool.query("INSERT INTO categorias_gasto (nombre) VALUES ($1) RETURNING *", [nombre.trim()]);
    res.json({ ok: true, categoria: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/api/compras/categorias/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE categorias_gasto SET activo = false WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── COMPRAS — ÓRDENES DE COMPRA (Entrega 2) ────────────────────────────
// Flujo: pendiente → aprobada → (recibida = Entrega 3) ; anulable desde pendiente/aprobada.
const esFechaISO = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
};

app.get("/api/compras/ordenes", requireAdmin, async (req, res) => {
  const { estado, proveedor } = req.query;
  try {
    const params = [];
    let sql = `SELECT oc.*, p.razon_social AS proveedor_nombre, c.nombre AS categoria_nombre
               FROM ordenes_compra oc
               LEFT JOIN proveedores p ON p.id = oc.proveedor_id
               LEFT JOIN categorias_gasto c ON c.id = oc.categoria_gasto_id
               WHERE 1=1`;
    if (estado) { params.push(estado); sql += ` AND oc.estado = $${params.length}`; }
    if (proveedor) { params.push(proveedor); sql += ` AND oc.proveedor_id = $${params.length}`; }
    sql += " ORDER BY oc.fecha DESC, oc.created_at DESC";
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/ordenes", requireAdmin, async (req, res) => {
  const { proveedor_id, categoria_gasto_id, fecha, descripcion, monto_total, nota, usuario } = req.body;
  if (!descripcion || !descripcion.trim()) return res.status(400).json({ error: "La descripción es obligatoria." });
  const monto = Number(monto_total);
  if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: "El monto total debe ser mayor a 0." });
  if (!esFechaISO(fecha)) return res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)." });
  try {
    const prov = await pool.query("SELECT id FROM proveedores WHERE id = $1 AND activo = true", [proveedor_id]);
    if (prov.rows.length === 0) return res.status(400).json({ error: "Proveedor inválido." });
    const cat = await pool.query("SELECT id FROM categorias_gasto WHERE id = $1 AND activo = true", [categoria_gasto_id]);
    if (cat.rows.length === 0) return res.status(400).json({ error: "Categoría de gasto inválida." });
    const result = await pool.query(
      `INSERT INTO ordenes_compra (proveedor_id, categoria_gasto_id, fecha, descripcion, monto_total, nota, usuario_crea)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [proveedor_id, categoria_gasto_id, fecha, descripcion.trim(), monto, nota?.trim() || null, usuario || null]
    );
    res.json({ ok: true, orden: result.rows[0] });
    registrarAuditoria(usuario, "orden_compra_crear", "orden_compra", result.rows[0].id, { proveedor_id, monto });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/api/compras/ordenes/:id", requireAdmin, async (req, res) => {
  const { proveedor_id, categoria_gasto_id, fecha, descripcion, monto_total, nota } = req.body;
  try {
    const actual = await pool.query("SELECT estado FROM ordenes_compra WHERE id = $1", [req.params.id]);
    if (actual.rows.length === 0) return res.status(404).json({ error: "Orden no encontrada." });
    if (actual.rows[0].estado !== "pendiente") return res.status(403).json({ error: `No se puede editar una orden ${actual.rows[0].estado}.` });
    if (descripcion !== undefined && !String(descripcion).trim()) return res.status(400).json({ error: "La descripción es obligatoria." });
    let monto;
    if (monto_total !== undefined) {
      monto = Number(monto_total);
      if (!Number.isFinite(monto) || monto <= 0) return res.status(400).json({ error: "El monto total debe ser mayor a 0." });
    }
    if (fecha !== undefined && !esFechaISO(fecha)) return res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)." });
    if (proveedor_id !== undefined) {
      const prov = await pool.query("SELECT id FROM proveedores WHERE id = $1 AND activo = true", [proveedor_id]);
      if (prov.rows.length === 0) return res.status(400).json({ error: "Proveedor inválido." });
    }
    if (categoria_gasto_id !== undefined) {
      const cat = await pool.query("SELECT id FROM categorias_gasto WHERE id = $1 AND activo = true", [categoria_gasto_id]);
      if (cat.rows.length === 0) return res.status(400).json({ error: "Categoría de gasto inválida." });
    }
    await pool.query(
      `UPDATE ordenes_compra SET
         proveedor_id = COALESCE($1, proveedor_id),
         categoria_gasto_id = COALESCE($2, categoria_gasto_id),
         fecha = COALESCE($3, fecha),
         descripcion = COALESCE($4, descripcion),
         monto_total = COALESCE($5, monto_total),
         nota = COALESCE($6, nota)
       WHERE id = $7`,
      [proveedor_id ?? null, categoria_gasto_id ?? null, fecha ?? null, descripcion?.trim() ?? null, monto ?? null, nota?.trim() ?? null, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/ordenes/:id/aprobar", requireAdmin, async (req, res) => {
  const { usuario } = req.body;
  const fechaAprob = fechaArgentinaISO();
  try {
    const result = await pool.query(
      "UPDATE ordenes_compra SET estado = 'aprobada', usuario_aprueba = $1, fecha_aprobacion = $2 WHERE id = $3 AND estado = 'pendiente' RETURNING id",
      [usuario || null, fechaAprob, req.params.id]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "La orden no está pendiente (no se puede aprobar)." });
    res.json({ ok: true });
    registrarAuditoria(usuario, "orden_compra_aprobar", "orden_compra", req.params.id, { fecha: fechaAprob });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/ordenes/:id/anular", requireAdmin, async (req, res) => {
  const { motivo, usuario } = req.body;
  if (!motivo || !motivo.trim()) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  try {
    const result = await pool.query(
      "UPDATE ordenes_compra SET estado = 'anulada', motivo_anulacion = $1 WHERE id = $2 AND estado IN ('pendiente','aprobada') RETURNING id",
      [motivo.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "La orden no se puede anular (debe estar pendiente o aprobada)." });
    res.json({ ok: true });
    registrarAuditoria(usuario, "orden_compra_anular", "orden_compra", req.params.id, { motivo: motivo.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── COMPRAS — FACTURAS DE PROVEEDOR (Entrega 3) ────────────────────────
// Una factura con estado_pago='pendiente' ES la cuenta por pagar. Se carga desde una orden
// aprobada (la pasa a 'recibida', atómico) o suelta (orden_compra_id NULL).
const ALICUOTAS_IVA = [0, 2.5, 5, 10.5, 21, 27];

// ── Signo por tipo (regla central, reusada en libro de compras y cuenta corriente) ──
// Nota de Crédito RESTA (-1). Factura y Nota de Débito SUMAN (+1). Los montos SIEMPRE se guardan
// en positivo; el signo se aplica al calcular/mostrar.
// El form guarda el tipo CON tilde ("Nota de Crédito A"): se compara siempre sin tildes y en mayúsculas.
function tipoCompraNorm(tipo) { return String(tipo || "").normalize("NFD").replace(/\p{M}/gu, "").toUpperCase(); }
function esNotaCreditoCompra(tipo) { return tipoCompraNorm(tipo).includes("NOTA DE CREDITO"); }
function esNotaDebitoCompra(tipo) { return tipoCompraNorm(tipo).includes("NOTA DE DEBITO"); }
function signoComprobante(tipo) { return esNotaCreditoCompra(tipo) ? -1 : 1; }
// Mismo criterio en SQL (translate en vez de upper sobre acentos: upper() no toca no-ASCII en collation C).
const SQL_FC_ES_NC = "translate(upper(fc.tipo_comprobante), 'ÁÉÍÓÚáéíóú', 'AEIOUAEIOU') LIKE 'NOTA DE CREDITO%'";

// Suma de netos e IVA gravados (multi-alícuota). Reusado en cuadre e insert (espejo neto_gravado/iva).
function netosMultiAlicuota(f) {
  const n = (x) => Number(x) || 0;
  return {
    neto: n(f.neto_105) + n(f.neto_21) + n(f.neto_27),
    iva: n(f.iva_105) + n(f.iva_21) + n(f.iva_27),
  };
}

// Valida el cuadre del comprobante. Devuelve { ok, calculado } (tolerancia ±1 peso por redondeo).
function chequearCuadreFactura(f) {
  const n = (x) => Number(x) || 0;
  const { neto, iva } = netosMultiAlicuota(f);
  const calculado = neto + iva + n(f.neto_no_gravado) + n(f.exentas) +
    n(f.otros_tributos) + n(f.percep_iva) + n(f.percep_iibb_bsas) + n(f.percep_iibb_caba);
  return { ok: Math.abs(calculado - n(f.total)) <= 1, calculado: Math.round(calculado * 100) / 100 };
}

// Valida campos fiscales comunes (crear/editar). Devuelve string de error o null.
function validarFacturaCompra(b) {
  if (!b.tipo_comprobante || !String(b.tipo_comprobante).trim()) return "El tipo de comprobante es obligatorio.";
  if (!b.numero_comprobante || !String(b.numero_comprobante).trim()) return "El número de comprobante es obligatorio.";
  if (!esFechaISO(b.fecha)) return "Fecha inválida (formato YYYY-MM-DD).";
  if (!(Number(b.total) > 0)) return "El total debe ser mayor a 0.";
  // Montos siempre positivos (el signo NC/ND se aplica al leer). IVA por alícuota sin su neto = error de carga.
  const camposMonto = ["neto_105", "iva_105", "neto_21", "iva_21", "neto_27", "iva_27", "percep_iva", "percep_iibb_bsas", "percep_iibb_caba", "neto_no_gravado", "exentas", "otros_tributos"];
  for (const c of camposMonto) if ((Number(b[c]) || 0) < 0) return "Los importes no pueden ser negativos (el signo de la nota de crédito se aplica solo).";
  for (const [n, i, a] of [["neto_105", "iva_105", "10,5"], ["neto_21", "iva_21", "21"], ["neto_27", "iva_27", "27"]]) {
    if ((Number(b[i]) || 0) > 0 && !((Number(b[n]) || 0) > 0)) return `Hay IVA ${a}% sin neto gravado al ${a}%.`;
  }
  const cuadre = chequearCuadreFactura(b);
  if (!cuadre.ok) return `El total no coincide: cargado $${Number(b.total)}, calculado $${cuadre.calculado}.`;
  return null;
}

app.get("/api/compras/facturas", requireAdmin, async (req, res) => {
  const { estado_pago, proveedor, q } = req.query;
  try {
    const params = [];
    // pago_id / pago_cuenta: el pago ACTIVO de la factura (para anularlo y mostrar "desde <cuenta>").
    let sql = `SELECT fc.*, c.nombre AS categoria_nombre, oc.descripcion AS orden_descripcion, pa.id AS pago_id, pa.cuenta_nombre AS pago_cuenta
               FROM facturas_compra fc
               LEFT JOIN LATERAL (
                 SELECT pc.id, ct.nombre AS cuenta_nombre FROM pagos_compra pc LEFT JOIN cuentas_tesoreria ct ON ct.id = pc.cuenta_id
                 WHERE pc.factura_id = fc.id AND pc.tipo = 'factura' AND pc.estado = 'activo' LIMIT 1
               ) pa ON true
               LEFT JOIN categorias_gasto c ON c.id = fc.categoria_gasto_id
               LEFT JOIN ordenes_compra oc ON oc.id = fc.orden_compra_id
               WHERE 1=1`;
    if (estado_pago) { params.push(estado_pago); sql += ` AND fc.estado_pago = $${params.length}`; }
    if (proveedor) { params.push(proveedor); sql += ` AND fc.proveedor_id = $${params.length}`; }
    // Búsqueda abierta: nº de comprobante (con/sin punto de venta ni guiones), razón social o CUIT.
    if (q && q.trim()) {
      const qLower = `%${q.trim().toLowerCase()}%`;
      const qDigits = q.replace(/\D/g, "");
      const ors = [];
      params.push(qLower); ors.push(`lower(fc.proveedor_razon_social) LIKE $${params.length}`);
      if (qDigits) {
        params.push(`%${qDigits}%`); const pd = params.length;
        ors.push(`fc.proveedor_cuit LIKE $${pd}`);
        ors.push(`regexp_replace(coalesce(fc.punto_venta,'') || coalesce(fc.numero_comprobante,''), '\\D', '', 'g') LIKE $${pd}`);
        ors.push(`regexp_replace(coalesce(fc.numero_comprobante,''), '\\D', '', 'g') LIKE $${pd}`);
      } else {
        params.push(qLower); ors.push(`lower(coalesce(fc.numero_comprobante,'')) LIKE $${params.length}`);
      }
      sql += ` AND (${ors.join(" OR ")})`;
    }
    sql += " ORDER BY fc.fecha DESC, fc.created_at DESC";
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/compras/ordenes-aprobadas", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT oc.*, p.razon_social AS proveedor_nombre, c.nombre AS categoria_nombre
       FROM ordenes_compra oc
       LEFT JOIN proveedores p ON p.id = oc.proveedor_id
       LEFT JOIN categorias_gasto c ON c.id = oc.categoria_gasto_id
       WHERE oc.estado = 'aprobada' ORDER BY oc.fecha DESC, oc.created_at DESC`
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/compras/facturas", requireAdmin, async (req, res) => {
  const b = req.body;
  const errValidacion = validarFacturaCompra(b);
  if (errValidacion) return res.status(400).json({ error: errValidacion });
  let client;
  try {
    // Proveedor y categoría activos (+ snapshot de datos del proveedor).
    const prov = await pool.query("SELECT id, cuit, razon_social FROM proveedores WHERE id = $1 AND activo = true", [b.proveedor_id]);
    if (prov.rows.length === 0) return res.status(400).json({ error: "Proveedor inválido." });
    const cat = await pool.query("SELECT id FROM categorias_gasto WHERE id = $1 AND activo = true", [b.categoria_gasto_id]);
    if (cat.rows.length === 0) return res.status(400).json({ error: "Categoría de gasto inválida." });
    const snapCuit = prov.rows[0].cuit || null;
    const snapRazon = prov.rows[0].razon_social || null;

    const repetido = await comprobanteCompraRepetido(pool, { proveedorId: b.proveedor_id, tipo: b.tipo_comprobante, puntoVenta: b.punto_venta, numero: b.numero_comprobante });
    if (repetido) return res.status(409).json({ error: msgComprobanteRepetido(repetido) });

    // Factura asociada (NC/ND): vínculo informativo OPCIONAL a otra factura del MISMO proveedor.
    let facturaAsociadaId = null;
    if (b.factura_asociada_id) {
      const fa = await pool.query("SELECT id FROM facturas_compra WHERE id = $1 AND proveedor_id = $2", [b.factura_asociada_id, b.proveedor_id]);
      if (fa.rows.length === 0) return res.status(400).json({ error: "La factura asociada no existe o no es del mismo proveedor." });
      facturaAsociadaId = Number(b.factura_asociada_id);
    }

    // Multi-alícuota: netos/IVA por alícuota (positivos). Espejo: neto_gravado/iva = suma (compat
    // con código viejo). alicuota_iva = la de mayor neto (informativo; ya no es la fuente de verdad).
    const n105 = Number(b.neto_105) || 0, i105 = Number(b.iva_105) || 0,
      n21 = Number(b.neto_21) || 0, i21 = Number(b.iva_21) || 0,
      n27 = Number(b.neto_27) || 0, i27 = Number(b.iva_27) || 0;
    const netoGravado = n105 + n21 + n27, ivaTotal = i105 + i21 + i27;
    const alicDom = (n21 >= n105 && n21 >= n27) ? 21 : (n105 >= n27 ? 10.5 : 27);

    const fcCalc = calcularFechaContable(b.fecha, b.fecha_contable);
    if (fcCalc.error) return res.status(400).json({ error: fcCalc.error });

    const cols = `(proveedor_id, categoria_gasto_id, orden_compra_id, proveedor_cuit, proveedor_razon_social,
      tipo_comprobante, punto_venta, numero_comprobante, cae, fecha, fecha_contable, alicuota_iva, neto_gravado, iva,
      neto_105, iva_105, neto_21, iva_21, neto_27, iva_27,
      percep_iva, percep_iibb_bsas, percep_iibb_caba, neto_no_gravado, exentas, otros_tributos, total, usuario_crea, factura_asociada_id)`;
    const vals = [
      b.proveedor_id, b.categoria_gasto_id, b.orden_compra_id || null, snapCuit, snapRazon,
      String(b.tipo_comprobante).trim(), b.punto_venta?.trim() || null, String(b.numero_comprobante).trim(),
      b.cae?.trim() || null, b.fecha, fcCalc.fechaContable, alicDom, netoGravado, ivaTotal,
      n105, i105, n21, i21, n27, i27,
      Number(b.percep_iva) || 0, Number(b.percep_iibb_bsas) || 0, Number(b.percep_iibb_caba) || 0,
      Number(b.neto_no_gravado) || 0, Number(b.exentas) || 0, Number(b.otros_tributos) || 0, Number(b.total),
      b.usuario || null, facturaAsociadaId,
    ];
    const ph = vals.map((_, i) => `$${i + 1}`).join(",");

    if (b.orden_compra_id) {
      // Carga DESDE orden: transacción atómica (crea factura + pasa la orden a 'recibida').
      client = await pool.connect();
      await client.query("BEGIN");
      const ord = await client.query("SELECT estado FROM ordenes_compra WHERE id = $1 FOR UPDATE", [b.orden_compra_id]);
      if (ord.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Orden no encontrada." }); }
      if (ord.rows[0].estado !== "aprobada") { await client.query("ROLLBACK"); return res.status(409).json({ error: "La orden no está aprobada (ya fue recibida o anulada)." }); }
      const ins = await client.query(`INSERT INTO facturas_compra ${cols} VALUES (${ph}) RETURNING id`, vals);
      await client.query("UPDATE ordenes_compra SET estado = 'recibida' WHERE id = $1 AND estado = 'aprobada'", [b.orden_compra_id]);
      await client.query("COMMIT");
      res.json({ ok: true, id: ins.rows[0].id });
      registrarAuditoria(b.usuario, "factura_compra_crear", "factura_compra", ins.rows[0].id, { orden_compra_id: b.orden_compra_id, total: Number(b.total) });
    } else {
      // Factura suelta: INSERT simple (el índice único evita duplicados).
      const ins = await pool.query(`INSERT INTO facturas_compra ${cols} VALUES (${ph}) RETURNING id`, vals);
      res.json({ ok: true, id: ins.rows[0].id });
      registrarAuditoria(b.usuario, "factura_compra_crear", "factura_compra", ins.rows[0].id, { suelta: true, total: Number(b.total) });
    }
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") return res.status(409).json({ error: msgUnicoFacturaCompra(err) || "Ya existe una factura con ese número para este proveedor." });
    console.error("Error POST /api/compras/facturas:", err.message);
    res.status(500).json({ error: "Error cargando la factura" });
  } finally {
    if (client) client.release();
  }
});

// Campos que el PATCH exige en el body (la CLAVE presente; null o "" valen como vacío/0). Sin esto, un PATCH
// parcial pisaba con null/0 lo que no viniera. factura_asociada_id solo se exige para NC/ND.
const PATCH_FC_REQUERIDOS = ["cae", "fecha_contable", "neto_105", "iva_105", "neto_21", "iva_21", "neto_27", "iva_27",
  "percep_iva", "percep_iibb_bsas", "percep_iibb_caba", "neto_no_gravado", "exentas", "otros_tributos"];

// Edición completa de facturas / NC / ND (mismo form que la carga). Solo comprobantes 'pendiente':
// pagada o anulada no se editan. Como el pago es único (no hay parciales), 'pendiente' = sin pagos, así
// que la clase (Factura/NC/ND) también se puede corregir acá. Todo en una transacción; audita antes→después.
app.patch("/api/compras/facturas/:id", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  const tiene = (k) => Object.prototype.hasOwnProperty.call(b, k);
  const esNotaPatch = esNotaCreditoCompra(b.tipo_comprobante) || esNotaDebitoCompra(b.tipo_comprobante);
  const faltan = [...PATCH_FC_REQUERIDOS, ...(esNotaPatch ? ["factura_asociada_id"] : [])].filter(k => !tiene(k));
  if (faltan.length) return res.status(400).json({ error: `Faltan campos en la edición: ${faltan.join(", ")}. Mandá el comprobante completo.`, faltan });
  const errValidacion = validarFacturaCompra(b);
  if (errValidacion) return res.status(400).json({ error: errValidacion });
  const fcCalc = calcularFechaContable(b.fecha, b.fecha_contable);
  if (fcCalc.error) return res.status(400).json({ error: fcCalc.error });
  const tipoNuevo = String(b.tipo_comprobante).trim();
  const esFacturaNueva = !esNotaCreditoCompra(tipoNuevo) && !esNotaDebitoCompra(tipoNuevo);
  const avisos = [];
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const act = await client.query("SELECT * FROM facturas_compra WHERE id = $1 FOR UPDATE", [id]);
    if (act.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Comprobante no encontrado." }); }
    const antes = act.rows[0];
    if (antes.estado_pago !== "pendiente") { await client.query("ROLLBACK"); return res.status(403).json({ error: `No se puede editar un comprobante ${antes.estado_pago}.` }); }

    // Categoría (obligatoria, activa).
    const catId = b.categoria_gasto_id ? Number(b.categoria_gasto_id) : antes.categoria_gasto_id;
    const cat = await client.query("SELECT id FROM categorias_gasto WHERE id = $1 AND activo = true", [catId]);
    if (cat.rows.length === 0) throw { _http: 400, msg: "Categoría de gasto inválida." };

    // Proveedor: si cambia, se valida activo y se actualiza el snapshot. Un comprobante de una orden no cambia de proveedor.
    const provId = b.proveedor_id ? Number(b.proveedor_id) : antes.proveedor_id;
    const cambiaProveedor = provId !== antes.proveedor_id;
    let snapCuit = antes.proveedor_cuit, snapRazon = antes.proveedor_razon_social;
    if (cambiaProveedor) {
      if (antes.orden_compra_id) throw { _http: 400, msg: `Este comprobante viene de la orden #${antes.orden_compra_id}: no se le puede cambiar el proveedor.` };
      const prov = await client.query("SELECT cuit, razon_social FROM proveedores WHERE id = $1 AND activo = true", [provId]);
      if (prov.rows.length === 0) throw { _http: 400, msg: "Proveedor inválido." };
      snapCuit = prov.rows[0].cuit || null; snapRazon = prov.rows[0].razon_social || null;
    }

    // Chequeo con los valores FINALES: lo que viene en el body o, si no viene, lo que ya tiene la fila.
    const final = (campo) => (b[campo] !== undefined && b[campo] !== null) ? b[campo] : antes[campo];
    const repetido = await comprobanteCompraRepetido(client, { proveedorId: provId, tipo: final("tipo_comprobante"), puntoVenta: final("punto_venta"), numero: final("numero_comprobante"), excluirId: id });
    if (repetido) throw { _http: 409, msg: msgComprobanteRepetido(repetido) };

    // Factura asociada (solo NC/ND): del MISMO proveedor y nunca él mismo. Si cambió el proveedor y la
    // asociada quedó de otro, se limpia con aviso (no bloquea).
    let asociadaId = null;
    if (!esFacturaNueva && b.factura_asociada_id) {
      const faId = Number(b.factura_asociada_id);
      if (faId === id) throw { _http: 400, msg: "Un comprobante no puede asociarse a sí mismo." };
      const fa = await client.query("SELECT id FROM facturas_compra WHERE id = $1 AND proveedor_id = $2", [faId, provId]);
      if (fa.rows.length > 0) asociadaId = faId;
      else if (cambiaProveedor) avisos.push("La factura asociada era de otro proveedor: quedó sin asociar.");
      else throw { _http: 400, msg: "La factura asociada no existe o no es del mismo proveedor." };
    } else if (esFacturaNueva && antes.factura_asociada_id) {
      avisos.push("Al pasar a Factura se quitó la factura asociada.");
    }

    // Espejo neto_gravado / iva / alicuota_iva recalculado desde las columnas por alícuota.
    const n105 = Number(b.neto_105) || 0, i105 = Number(b.iva_105) || 0,
      n21 = Number(b.neto_21) || 0, i21 = Number(b.iva_21) || 0,
      n27 = Number(b.neto_27) || 0, i27 = Number(b.iva_27) || 0;
    const netoGravado = n105 + n21 + n27, ivaTotal = i105 + i21 + i27;
    const alicDom = (n21 >= n105 && n21 >= n27) ? 21 : (n105 >= n27 ? 10.5 : 27);

    const despues = {
      proveedor_id: provId, proveedor_cuit: snapCuit, proveedor_razon_social: snapRazon, categoria_gasto_id: catId,
      // punto_venta: si no viene en el body se conserva el de la fila (mismo valor que usó el chequeo de repetido).
      tipo_comprobante: tipoNuevo, punto_venta: (b.punto_venta !== undefined && b.punto_venta !== null) ? (String(b.punto_venta).trim() || null) : antes.punto_venta, numero_comprobante: String(b.numero_comprobante).trim(),
      cae: b.cae?.trim() || null, fecha: b.fecha, fecha_contable: fcCalc.fechaContable, factura_asociada_id: asociadaId,
      alicuota_iva: alicDom, neto_gravado: netoGravado, iva: ivaTotal,
      neto_105: n105, iva_105: i105, neto_21: n21, iva_21: i21, neto_27: n27, iva_27: i27,
      percep_iva: Number(b.percep_iva) || 0, percep_iibb_bsas: Number(b.percep_iibb_bsas) || 0, percep_iibb_caba: Number(b.percep_iibb_caba) || 0,
      neto_no_gravado: Number(b.neto_no_gravado) || 0, exentas: Number(b.exentas) || 0, otros_tributos: Number(b.otros_tributos) || 0,
      total: Number(b.total),
    };
    const cols = Object.keys(despues);
    await client.query(
      `UPDATE facturas_compra SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} WHERE id = $${cols.length + 1}`,
      [...cols.map(c => despues[c]), id]
    );

    // NC/ND que apuntaban a ESTE comprobante: si dejó de ser Factura o cambió de proveedor, quedan sin asociar.
    if (!esFacturaNueva || cambiaProveedor) {
      const desv = await client.query("UPDATE facturas_compra SET factura_asociada_id = NULL WHERE factura_asociada_id = $1 RETURNING id", [id]);
      if (desv.rowCount > 0) avisos.push(`${desv.rowCount} nota(s) de crédito/débito asociadas a este comprobante quedaron sin asociar.`);
    }
    await client.query("COMMIT");

    // Auditoría: solo los campos que cambiaron (antes → después). Números y textos normalizados para no marcar falsos cambios.
    const textos = new Set(["proveedor_cuit", "proveedor_razon_social", "tipo_comprobante", "punto_venta", "numero_comprobante", "cae", "fecha", "fecha_contable"]);
    const norm = (c, v) => (v === null || v === undefined || v === "") ? null : (textos.has(c) ? String(v) : Number(v));
    const cambios = {};
    for (const c of cols) if (norm(c, antes[c]) !== norm(c, despues[c])) cambios[c] = { antes: antes[c] ?? null, despues: despues[c] ?? null };
    res.json({ ok: true, avisos });
    registrarAuditoria(b.usuario || req.user?.nombre_completo, "factura_compra_editar", "factura_compra", id, { tipo: tipoNuevo, cambios });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (err && err._http) return res.status(err._http).json({ error: err.msg });
    if (err.code === "23505") return res.status(409).json({ error: msgUnicoFacturaCompra(err) || `Ya existe un/a ${String(b.tipo_comprobante).trim()} número ${String(b.numero_comprobante).trim()} cargado/a para este proveedor.` });
    console.error("Error PATCH /api/compras/facturas:", err.message);
    res.status(500).json({ error: "Error guardando el comprobante" });
  } finally {
    if (client) client.release();
  }
});

// Anula la factura (estado_pago='anulada'). Solo desde 'pendiente'. DECISIÓN: NO revierte la orden
// asociada a 'aprobada' (queda 'recibida'); si hiciera falta revertir, se maneja aparte.
app.post("/api/compras/facturas/:id/anular", requireAdmin, async (req, res) => {
  const { motivo, usuario } = req.body;
  if (!motivo || !motivo.trim()) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  try {
    const result = await pool.query(
      "UPDATE facturas_compra SET estado_pago = 'anulada', motivo_anulacion = $1 WHERE id = $2 AND estado_pago = 'pendiente' RETURNING id",
      [motivo.trim(), req.params.id]
    );
    if (result.rows.length === 0) return res.status(400).json({ error: "La factura no se puede anular (debe estar pendiente)." });
    res.json({ ok: true });
    registrarAuditoria(usuario, "factura_compra_anular", "factura_compra", req.params.id, { motivo: motivo.trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── COMPRAS — PAGOS (Entrega 4 + Tesorería B1) ────────────────────────
// Todo pago de compras queda en pagos_compra: tipo 'factura' (pago TOTAL de una factura) o 'a_cuenta' (sin factura).
// Origen de la plata: externo (no toca nada), caja (SALIDA con fecha de hoy) o cuenta de tesorería (egreso con la fecha
// del pago, vía registrarMovimientoCuenta). Nunca caja y cuenta a la vez. Las CAJAS válidas son CAJAS_TRANSFERIBLES
// (definida más abajo, se accede en request-time); Administración solo superadmin (bloqueaCajaAdmin).
// Lee y valida el origen del body. Si algo no va, ya respondió (400/403) y devuelve null.
function leerOrigenPago(req, res, cajaOrigen, cuentaId) {
  const caja = cajaOrigen && String(cajaOrigen).trim() !== "" ? String(cajaOrigen).trim() : null;
  const cuenta = cuentaId !== undefined && cuentaId !== null && String(cuentaId).trim() !== "" ? Number(cuentaId) : null;
  if (caja && cuenta !== null) { res.status(400).json({ error: "Elegí un solo origen: caja o cuenta." }); return null; }
  if (cuenta !== null && !(Number.isInteger(cuenta) && cuenta > 0)) { res.status(400).json({ error: "Cuenta de origen inválida." }); return null; }
  if (caja) {
    if (!CAJAS_TRANSFERIBLES.includes(caja)) { res.status(400).json({ error: "Caja de origen inválida." }); return null; }
    if (bloqueaCajaAdmin(req, res, caja)) return null;   // Administración solo superadmin
  }
  return { caja, cuentaId: cuenta };
}
// Errores de pagos/gastos: los de tesorería (cuenta inactiva, fecha anterior al saldo inicial, conciliado) traen su status.
function responderErrorPago(res, e, generico, ruta) {
  if (e instanceof ErrorTesoreria) return res.status(e.status).json({ error: e.message });
  if (e && e.code === "23505") return res.status(409).json({ error: "La factura ya tiene un pago activo." });
  if (e && e.code === "23503") return res.status(400).json({ error: "La cuenta de origen no existe." });   // FK cuenta_id (lo demás se valida antes)
  console.error(`Error ${ruta}:`, e && e.message);
  return res.status(500).json({ error: generico });
}
const comprobanteCompraTxt = (f) => `${f.tipo_comprobante} ${f.punto_venta ? `${f.punto_venta}-` : ""}${f.numero_comprobante || ""}`.trim();

// Pago TOTAL de una factura 'pendiente' → 'pagada'. Fila 'factura' en pagos_compra + salida de caja o egreso en la cuenta
// + columnas de facturas_compra (fecha_pago/medio_pago/caja_origen/usuario_paga, como antes). Atómico, FOR UPDATE de la factura.
app.post("/api/compras/facturas/:id/pagar", requireAdmin, async (req, res) => {
  const { medioPago, cajaOrigen, cuentaId, fechaPago } = req.body || {};
  if (!medioPago || !String(medioPago).trim()) return res.status(400).json({ error: "El medio de pago es obligatorio." });
  const fPago = fechaPago && esFechaISO(fechaPago) ? fechaPago : fechaArgentinaISO();
  const origen = leerOrigenPago(req, res, cajaOrigen, cuentaId);
  if (!origen) return;
  const medio = String(medioPago).trim();
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client, pagoId, total;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      "SELECT id, estado_pago, tipo_comprobante, total, proveedor_id, proveedor_razon_social, punto_venta, numero_comprobante FROM facturas_compra WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    const f = sel.rows[0];
    if (!f) throw new ErrorTesoreria(404, "Factura no encontrada.");
    // Una nota de crédito NO se paga (es un crédito, resta del saldo). Facturas y ND sí.
    if (esNotaCreditoCompra(f.tipo_comprobante)) throw new ErrorTesoreria(400, "Una nota de crédito no se paga.");
    if (f.estado_pago !== "pendiente") throw new ErrorTesoreria(409, "La factura no está pendiente (no se puede pagar).");
    if (!f.proveedor_id) throw new ErrorTesoreria(400, "La factura no tiene proveedor asignado.");
    total = Number(f.total);
    if (!(total > 0)) throw new ErrorTesoreria(400, "La factura tiene total 0: no hay nada que pagar.");
    const concepto = `Pago factura ${f.proveedor_razon_social || "proveedor"}${f.numero_comprobante ? ` ${f.numero_comprobante}` : ""}`;
    const ins = await client.query(
      `INSERT INTO pagos_compra (tipo, proveedor_id, factura_id, fecha, monto, medio_pago, caja_origen, cuenta_id, concepto, usuario)
       VALUES ('factura',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [f.proveedor_id, f.id, fPago, total, medio, origen.caja, origen.cuentaId, comprobanteCompraTxt(f), quien]
    );
    pagoId = ins.rows[0].id;
    if (origen.caja) {
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4) RETURNING id",
        [origen.caja, concepto, -Math.abs(total), fechaArgentinaISO()]   // HOY para caer en el día abierto de la caja
      );
      await client.query("UPDATE pagos_compra SET caja_movimiento_id = $1 WHERE id = $2", [mov.rows[0].id, pagoId]);
    }
    if (origen.cuentaId) {
      await registrarMovimientoCuenta(client, { cuentaId: origen.cuentaId, fecha: fPago, tipo: "egreso", monto: total, concepto, origenTipo: "pago_factura", origenId: pagoId, usuario: quien });
    }
    await client.query(
      "UPDATE facturas_compra SET estado_pago='pagada', fecha_pago=$1, medio_pago=$2, caja_origen=$3, usuario_paga=$4 WHERE id=$5",
      [fPago, medio, origen.caja, quien, f.id]
    );
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error registrando el pago", "/api/compras/facturas/:id/pagar");
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true, pago_id: pagoId });
  registrarAuditoria(quien, "factura_compra_pago", "factura_compra", req.params.id, { pago_id: pagoId, medioPago: medio, cajaOrigen: origen.caja, cuentaId: origen.cuentaId, total, fecha: fPago });
});

// Cuenta corriente: saldo por proveedor (anuladas excluidas de todo).
app.get("/api/compras/cuenta-corriente", requireAdmin, async (req, res) => {
  try {
    // Saldo con signo: facturas + ND 'pendiente' SUMAN; NC 'no anulada' RESTAN (la NC no se paga, resta por existir).
    // Pagos a cuenta (pagos_compra 'a_cuenta' activos) RESTAN del saldo. Los pagos de FACTURA no restan: ya están
    // reflejados en que la factura dejó de estar 'pendiente' (restarlos sería contarlos dos veces).
    // total_pagado = Σ pagos_compra activos (factura + a cuenta): una sola fuente, sin sumar también facturas_compra.
    // Saldo negativo = a favor nuestro (le pagamos de más / por adelantado).
    const result = await pool.query(`
      WITH pg AS (
        SELECT proveedor_id,
          SUM(monto) FILTER (WHERE tipo = 'a_cuenta') AS a_cuenta,
          SUM(monto) FILTER (WHERE tipo = 'factura') AS facturas
        FROM pagos_compra WHERE estado = 'activo' GROUP BY proveedor_id
      ), fac AS (
        SELECT p.id, p.razon_social, p.cuit,
          COALESCE(SUM(fc.total) FILTER (WHERE fc.estado_pago <> 'anulada' AND NOT (${SQL_FC_ES_NC})), 0)
            - COALESCE(SUM(fc.total) FILTER (WHERE fc.estado_pago <> 'anulada' AND ${SQL_FC_ES_NC}), 0)
            AS total_facturado,
          COALESCE(SUM(fc.total) FILTER (WHERE fc.estado_pago = 'pendiente' AND NOT (${SQL_FC_ES_NC})), 0)
            - COALESCE(SUM(fc.total) FILTER (WHERE fc.estado_pago <> 'anulada' AND ${SQL_FC_ES_NC}), 0)
            AS saldo_facturas,
          COUNT(fc.id) FILTER (WHERE fc.estado_pago = 'pendiente' AND NOT (${SQL_FC_ES_NC})) AS facturas_pendientes
        FROM proveedores p
        LEFT JOIN facturas_compra fc ON fc.proveedor_id = p.id
        WHERE p.activo = true
        GROUP BY p.id, p.razon_social, p.cuit
      )
      SELECT fac.id, fac.razon_social, fac.cuit, fac.total_facturado, fac.facturas_pendientes,
        COALESCE(pg.a_cuenta, 0) AS pagos_a_cuenta,
        COALESCE(pg.facturas, 0) + COALESCE(pg.a_cuenta, 0) AS total_pagado,
        fac.saldo_facturas - COALESCE(pg.a_cuenta, 0) AS saldo_pendiente
      FROM fac LEFT JOIN pg ON pg.proveedor_id = fac.id
      ORDER BY saldo_pendiente DESC, fac.razon_social ASC
    `);
    // Deuda total = solo saldos positivos; "a favor nuestro" = saldos negativos (en positivo), por separado.
    const totalDeuda = result.rows.reduce((a, r) => a + Math.max(0, Number(r.saldo_pendiente)), 0);
    const totalAFavor = result.rows.reduce((a, r) => a + Math.max(0, -Number(r.saldo_pendiente)), 0);
    res.json({ proveedores: result.rows, totalDeuda, totalAFavor });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── COMPRAS — PAGOS A CUENTA (sin factura) + listado de pagos ─────────
// Listado: SOLO pagos_compra (factura + a cuenta). Filtros: tipo (factura|a_cuenta), proveedor, desde/hasta (fecha del
// pago), incluirAnulados. `id` es el id del PAGO (para anular); `factura_id`, el de la factura si es de factura.
app.get("/api/compras/pagos", requireAdmin, async (req, res) => {
  const { tipo, proveedor, desde, hasta, incluirAnulados } = req.query;
  if ((desde && !esFechaISO(desde)) || (hasta && !esFechaISO(hasta))) return res.status(400).json({ error: "Fechas inválidas (YYYY-MM-DD)." });
  try {
    const params = [];
    let sql = `SELECT pc.*, p.razon_social, ct.nombre AS cuenta_nombre
               FROM pagos_compra pc
               JOIN proveedores p ON p.id = pc.proveedor_id
               LEFT JOIN cuentas_tesoreria ct ON ct.id = pc.cuenta_id
               WHERE 1=1`;
    if (tipo === "factura" || tipo === "a_cuenta") { params.push(tipo); sql += ` AND pc.tipo = $${params.length}`; }
    if (incluirAnulados !== "1") sql += " AND pc.estado = 'activo'";
    if (proveedor) { params.push(proveedor); sql += ` AND pc.proveedor_id = $${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND pc.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND pc.fecha <= $${params.length}`; }
    sql += " ORDER BY pc.fecha DESC, pc.id DESC";
    const pagos = (await pool.query(sql, params)).rows.map((p) => ({
      clave: `${p.tipo}-${p.id}`, tipo: p.tipo, id: p.id, factura_id: p.factura_id, proveedor_id: p.proveedor_id, proveedor: p.razon_social,
      fecha: p.fecha, monto: Number(p.monto), medio_pago: p.medio_pago, caja_origen: p.caja_origen, cuenta_id: p.cuenta_id, cuenta_nombre: p.cuenta_nombre,
      usuario: p.usuario, concepto: p.concepto, observaciones: p.observaciones, estado: p.estado, motivo_anulacion: p.motivo_anulacion,
      usuario_anula: p.usuario_anula, anulado_at: p.anulado_at,
    }));
    const activos = pagos.filter(p => p.estado === "activo");
    res.json({
      pagos,
      totalFacturas: activos.filter(p => p.tipo === "factura").reduce((a, p) => a + p.monto, 0),
      totalACuenta: activos.filter(p => p.tipo === "a_cuenta").reduce((a, p) => a + p.monto, 0),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pago a cuenta (sin factura) a un proveedor ACTIVO. Mismos orígenes que el pago de factura: externo, caja o cuenta.
// Atómico: el pago y la salida de caja / el egreso en la cuenta en la misma transacción.
app.post("/api/compras/pagos-a-cuenta", requireAdmin, async (req, res) => {
  const { proveedor_id, fecha, monto, medioPago, cajaOrigen, cuentaId, concepto, observaciones } = req.body || {};
  const m = Number(monto);
  if (!proveedor_id) return res.status(400).json({ error: "El proveedor es obligatorio." });
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "El monto debe ser mayor a 0." });
  if (!esFechaISO(fecha)) return res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)." });
  if (!medioPago || !String(medioPago).trim()) return res.status(400).json({ error: "El medio de pago es obligatorio." });
  if (!concepto || !String(concepto).trim()) return res.status(400).json({ error: "El concepto es obligatorio (ej. \"Anticipo pedido semana 43\")." });
  const origen = leerOrigenPago(req, res, cajaOrigen, cuentaId);
  if (!origen) return;
  const conc = String(concepto).trim(), obs = observaciones && String(observaciones).trim() ? String(observaciones).trim() : null;
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const prov = await client.query("SELECT id, razon_social FROM proveedores WHERE id = $1 AND activo = true", [proveedor_id]);
    if (prov.rows.length === 0) throw new ErrorTesoreria(400, "Proveedor inválido o dado de baja.");
    const ins = await client.query(
      `INSERT INTO pagos_compra (tipo, proveedor_id, fecha, monto, medio_pago, caja_origen, cuenta_id, concepto, observaciones, usuario)
       VALUES ('a_cuenta',$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [proveedor_id, fecha, m, String(medioPago).trim(), origen.caja, origen.cuentaId, conc, obs, quien]
    );
    const id = ins.rows[0].id;
    const movConcepto = `Pago a cuenta #${id}: ${prov.rows[0].razon_social} - ${conc}`;
    if (origen.caja) {
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4) RETURNING id",
        [origen.caja, movConcepto, -Math.abs(m), fechaArgentinaISO()]   // HOY: cae en el día abierto
      );
      await client.query("UPDATE pagos_compra SET caja_movimiento_id = $1 WHERE id = $2", [mov.rows[0].id, id]);
    }
    if (origen.cuentaId) {
      await registrarMovimientoCuenta(client, { cuentaId: origen.cuentaId, fecha, tipo: "egreso", monto: m, concepto: movConcepto, origenTipo: "pago_a_cuenta", origenId: id, usuario: quien });
    }
    await client.query("COMMIT");
    res.json({ ok: true, id });
    registrarAuditoria(quien, "pago_a_cuenta_crear", "pago_compra", id, { proveedor_id: Number(proveedor_id), monto: m, cajaOrigen: origen.caja, cuentaId: origen.cuentaId, concepto: conc });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorPago(res, e, "Error registrando el pago a cuenta", "POST /api/compras/pagos-a-cuenta");
  } finally { if (client) client.release(); }
});

// Anular un pago de compras (a cuenta o de factura). Motivo obligatorio; transacción + FOR UPDATE + guard anti-doble.
// - Caja: se repone con una ENTRADA "Anulación pago a cuenta #id" / "Anulación pago factura #id" (hoy). También en
//   los pagos viejos copiados por la migración (sin caja_movimiento_id).
// - Cuenta: se anula su movimiento en Tesorería; si está conciliado → 409 (hay que desconciliarlo primero).
// - Factura: vuelve a 'pendiente' y se limpian fecha_pago/medio_pago/caja_origen/usuario_paga.
async function anularPagoCompra(req, res) {
  const motivo = String((req.body || {}).motivo || "").trim();
  if (!motivo) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client, pg;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT pc.id, pc.tipo, pc.factura_id, pc.monto, pc.caja_origen, pc.cuenta_id, pc.estado, pc.concepto, p.razon_social
       FROM pagos_compra pc JOIN proveedores p ON p.id = pc.proveedor_id WHERE pc.id = $1 FOR UPDATE OF pc`,
      [req.params.id]
    );
    pg = sel.rows[0];
    if (!pg) throw new ErrorTesoreria(404, "Pago no encontrado.");
    if (pg.estado !== "activo") throw new ErrorTesoreria(409, "El pago ya está anulado.");
    if (pg.tipo === "factura") {
      const fac = await client.query("SELECT estado_pago FROM facturas_compra WHERE id = $1 FOR UPDATE", [pg.factura_id]);
      if (!fac.rows[0] || fac.rows[0].estado_pago !== "pagada") throw new ErrorTesoreria(409, "La factura de este pago no figura como pagada: revisala antes de anular.");
    }
    if (pg.cuenta_id) await anularMovimientoPorOrigen(client, pg.tipo === "factura" ? "pago_factura" : "pago_a_cuenta", pg.id, motivo, quien);
    let movAnulId = null;
    if (pg.caja_origen) {
      if (bloqueaCajaAdmin(req, res, pg.caja_origen)) { await client.query("ROLLBACK"); return; }
      const concepto = pg.tipo === "factura"
        ? `Anulación pago factura #${pg.id}: ${pg.razon_social} ${pg.concepto || ""}`.trim()
        : `Anulación pago a cuenta #${pg.id}: ${pg.razon_social} - ${pg.concepto}`;
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4) RETURNING id",
        [pg.caja_origen, concepto, Math.abs(Number(pg.monto)), fechaArgentinaISO()]
      );
      movAnulId = mov.rows[0].id;
    }
    const up = await client.query(
      `UPDATE pagos_compra SET estado = 'anulado', motivo_anulacion = $1, usuario_anula = $2, anulado_at = NOW(), caja_movimiento_anulacion_id = $3
       WHERE id = $4 AND estado = 'activo' RETURNING id`,
      [motivo, quien, movAnulId, pg.id]
    );
    if (up.rows.length === 0) throw new ErrorTesoreria(409, "El pago ya está anulado.");
    if (pg.tipo === "factura") {
      await client.query(
        "UPDATE facturas_compra SET estado_pago = 'pendiente', fecha_pago = NULL, medio_pago = NULL, caja_origen = NULL, usuario_paga = NULL WHERE id = $1 AND estado_pago = 'pagada'",
        [pg.factura_id]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error anulando el pago", "anular pago de compras");
  } finally { if (client) client.release(); }
  res.json({ ok: true });
  registrarAuditoria(quien, pg.tipo === "factura" ? "pago_factura_anular" : "pago_a_cuenta_anular", "pago_compra", pg.id,
    { motivo, tipo: pg.tipo, factura_id: pg.factura_id, cajaOrigen: pg.caja_origen || null, cuentaId: pg.cuenta_id || null, monto: Number(pg.monto) });
}
app.post("/api/compras/pagos/:id/anular", requireAdmin, anularPagoCompra);
app.post("/api/compras/pagos-a-cuenta/:id/anular", requireAdmin, anularPagoCompra);   // ruta anterior (front viejo a mitad de un deploy)

// ─── CLIENTES (CRM simple, agregado de pedidos) ─────────────────────────
// Admin + superadmin. Agrupa pedidos TN + manuales por cliente único (email si hay, si no teléfono
// normalizado). Métricas sobre ENTREGADOS. Corporativo = pedido manual con es_corporativo=true O
// alguna Factura A asociada. Todo en SQL (volumen chico).
// cliente_key = email (lower+trim) o, si no hay, teléfono (solo dígitos). MISMA fórmula que clienteKeyDe
// (Routes/cotizador.js) y que el backfill de cotizaciones.cliente_key.
const SQL_KEY_TN = `COALESCE(NULLIF(lower(trim(COALESCE(e.email_override, t.data->>'contact_email',''))),''),
                   NULLIF(regexp_replace(COALESCE(e.telefono_override, t.data->>'contact_phone',''),'\\D','','g'),''))`;
const SQL_KEY_MANUAL = `COALESCE(NULLIF(lower(trim(COALESCE(e.email_override, m.email,''))),''),
                   NULLIF(regexp_replace(COALESCE(e.telefono_override, m.telefono,''),'\\D','','g'),''))`;
// Base de clientes: datos, métricas y temperatura. COMPARTIDA por /api/clientes, la ficha y los seguimientos.
// filtroAgg filtra antes de agrupar (p. ej. por cliente_key); conCompras = solo clientes con algún entregado.
function sqlClientes({ filtroAgg = "", conCompras = true, filtroFinal = "", orderBy = "" } = {}) {
  return `
      WITH base AS (
        -- Tienda Nube (TN no persiste flag corporativo; solo por Factura A)
        SELECT
          ${SQL_KEY_TN} AS cliente_key,
          COALESCE(e.cliente_override, t.data->>'contact_name','')                                   AS nombre,
          lower(trim(COALESCE(e.email_override, t.data->>'contact_email','')))                       AS email,
          regexp_replace(COALESCE(e.telefono_override, t.data->>'contact_phone',''),'\\D','','g')     AS telefono,
          COALESCE(e.direccion_override, TRIM(CONCAT_WS(' ', t.data->'shipping_address'->>'address', t.data->'shipping_address'->>'number'))) AS direccion,
          COALESCE(e.zona_override, t.data->'fulfillments'->0->'shipping'->'option'->>'name','')      AS zona,
          COALESCE(pp.total_num, NULLIF(t.data->>'total','')::numeric, 0)                            AS total,
          COALESCE(e.estado,'Por empaquetar') = 'Entregado'                                          AS entregado,
          t.tn_created_at                                                                            AS fecha,
          EXISTS (SELECT 1 FROM facturas fa WHERE fa.pedido_id = t.id::text AND UPPER(fa.tipo) LIKE 'FACTURA A%') AS es_corp_pedido
        FROM pedidos_tn t
        LEFT JOIN pedidos_estados   e  ON e.id = t.id::text
        LEFT JOIN pedidos_productos pp ON pp.pedido_id = t.id::text
        WHERE COALESCE(e.estado,'Por empaquetar') <> 'Anulado'
        UNION ALL
        -- Manuales
        SELECT
          ${SQL_KEY_MANUAL} AS cliente_key,
          COALESCE(e.cliente_override, m.cliente,'')                                                  AS nombre,
          lower(trim(COALESCE(e.email_override, m.email,'')))                                         AS email,
          regexp_replace(COALESCE(e.telefono_override, m.telefono,''),'\\D','','g')                   AS telefono,
          COALESCE(e.direccion_override, m.direccion,'')                                              AS direccion,
          COALESCE(e.zona_override, m.zona,'')                                                        AS zona,
          COALESCE(pp.total_num, m.total_num, 0)                                                      AS total,
          COALESCE(e.estado,'Por empaquetar') = 'Entregado'                                           AS entregado,
          m.created_at                                                                               AS fecha,
          (COALESCE(m.es_corporativo,false)
            OR EXISTS (SELECT 1 FROM facturas fa WHERE fa.pedido_id = m.id AND UPPER(fa.tipo) LIKE 'FACTURA A%')) AS es_corp_pedido
        FROM pedidos_manuales m
        LEFT JOIN pedidos_estados   e  ON e.id = m.id
        LEFT JOIN pedidos_productos pp ON pp.pedido_id = m.id
        WHERE COALESCE(e.estado,'Por empaquetar') <> 'Anulado'
      ),
      agg AS (
        SELECT cliente_key,
          (array_agg(nombre ORDER BY fecha DESC))[1]                        AS nombre,
          max(email)    FILTER (WHERE email <> '')                          AS email,
          max(telefono) FILTER (WHERE telefono <> '')                       AS telefono,
          (array_agg(direccion ORDER BY fecha DESC))[1]                     AS direccion,
          (array_agg(zona ORDER BY fecha DESC))[1]                          AS zona,
          count(*) FILTER (WHERE entregado)                                 AS cantidad_compras,
          COALESCE(sum(total) FILTER (WHERE entregado), 0)                  AS total_gastado,
          min(fecha) FILTER (WHERE entregado)                               AS primera_compra,
          max(fecha) FILTER (WHERE entregado)                               AS ultima_compra,
          bool_or(es_corp_pedido)                                           AS es_corporativo
        FROM base
        WHERE cliente_key IS NOT NULL ${filtroAgg}
        GROUP BY cliente_key
        ${conCompras ? "HAVING count(*) FILTER (WHERE entregado) > 0" : ""}
      )
      SELECT cliente_key, nombre, email, telefono, direccion, zona,
             cantidad_compras, total_gastado, primera_compra, ultima_compra, es_corporativo,
             ROUND(total_gastado / NULLIF(cantidad_compras,0), 2) AS ticket_promedio,
             ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ultima_compra::date) AS dias_desde_ultima,
             CASE
               WHEN ultima_compra IS NULL THEN NULL
               WHEN ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ultima_compra::date) <= 30  THEN 'caliente'
               WHEN ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ultima_compra::date) <= 180 THEN 'tibio'
               WHEN ((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - ultima_compra::date) <= 365 THEN 'frio'
               ELSE 'dormido'
             END AS temperatura
      FROM agg
      WHERE 1=1 ${filtroFinal}
      ${orderBy ? `ORDER BY ${orderBy}` : ""}
    `;
}
app.get("/api/clientes", requireAdmin, async (req, res) => {
  const { tipo, buscar, orden, temperatura } = req.query;
  // ORDER BY con whitelist (nunca interpolar input crudo).
  const ORDENES = {
    total: "total_gastado DESC NULLS LAST",
    ultima: "ultima_compra DESC NULLS LAST",
    cantidad: "cantidad_compras DESC",
    nombre: "lower(nombre) ASC",
  };
  const orderBy = ORDENES[orden] || ORDENES.total;
  const params = [];
  let filtroTipo = "";
  if (tipo === "corporativos") filtroTipo = "AND es_corporativo = true";
  else if (tipo === "particulares") filtroTipo = "AND es_corporativo = false";
  let filtroBuscar = "";
  if (buscar && String(buscar).trim()) {
    params.push(`%${String(buscar).trim()}%`);
    filtroBuscar = `AND (nombre ILIKE $${params.length} OR email ILIKE $${params.length} OR telefono ILIKE $${params.length})`;
  }
  try {
    const { rows } = await pool.query(sqlClientes({ filtroFinal: `${filtroTipo} ${filtroBuscar}`, orderBy }), params);
    // Resumen sobre TODO el set (tipo/búsqueda aplicados, temperatura NO) para que los contadores
    // por temperatura se mantengan al filtrar por una. La lista sí se filtra por temperatura.
    const totalClientes = rows.length;
    const corporativos = rows.filter(r => r.es_corporativo).length;
    const cont = (t) => rows.filter(r => r.temperatura === t).length;
    const resumen = {
      totalClientes, corporativos, particulares: totalClientes - corporativos,
      calientes: cont("caliente"), tibios: cont("tibio"), frios: cont("frio"), dormidos: cont("dormido"),
    };
    const temp = String(temperatura || "");
    const clientes = ["caliente", "tibio", "frio", "dormido"].includes(temp) ? rows.filter(r => r.temperatura === temp) : rows;
    res.json({ clientes, ...resumen });
  } catch (err) {
    console.error("Error /api/clientes:", err.message);
    res.status(500).json({ error: "Error generando la base de clientes" });
  }
});

// ─── CRM Entrega 1: FICHA DE CLIENTE + NOTAS Y SEGUIMIENTO — admin + superadmin ─
const TIPOS_NOTA_CLIENTE = ["nota", "llamada", "whatsapp", "mail", "reunion"];
// La clave llega tal cual la arma el sistema (email en minúsculas o solo dígitos): se limpia igual que clienteKeyDe.
const claveClienteDeQuery = (k) => { const s = String(k || "").trim(); return s.includes("@") ? s.toLowerCase() : (s.replace(/\D/g, "") || null); };

// Ficha: datos + métricas + temperatura (misma consulta que /api/clientes), "qué compra siempre", todos sus pedidos
// (TN + manuales, con overrides, también anulados), sus oportunidades y sus notas.
app.get("/api/clientes/ficha", requireAdmin, async (req, res) => {
  const key = claveClienteDeQuery(req.query.key);
  if (!key) return res.status(400).json({ error: "Falta el cliente (key)." });
  try {
    const cli = (await pool.query(sqlClientes({ filtroAgg: "AND cliente_key = $1", conCompras: false }), [key])).rows[0] || null;
    // Pedidos del cliente (todos los estados), armados con las mismas funciones que el reporte de pedidos.
    const tn = await pool.query(`SELECT t.data FROM pedidos_tn t LEFT JOIN pedidos_estados e ON e.id = t.id::text WHERE ${SQL_KEY_TN} = $1`, [key]);
    const man = await pool.query(`SELECT m.* FROM pedidos_manuales m LEFT JOIN pedidos_estados e ON e.id = m.id WHERE ${SQL_KEY_MANUAL} = $1`, [key]);
    const ids = [...tn.rows.map((r) => String(r.data.id)), ...man.rows.map((r) => r.id)];
    const estados = {}, overrides = {};
    if (ids.length) {
      for (const r of (await pool.query("SELECT * FROM pedidos_estados WHERE id = ANY($1)", [ids])).rows) estados[r.id] = estadoPedidoDeFila(r);
      for (const r of (await pool.query("SELECT pedido_id, productos, total_num FROM pedidos_productos WHERE pedido_id = ANY($1)", [ids])).rows) overrides[r.pedido_id] = { productos: r.productos, total_num: Number(r.total_num) };
    }
    const creado = {};
    for (const r of tn.rows) creado[String(r.data.id)] = r.data.created_at || "";
    for (const r of man.rows) creado[r.id] = r.created_at ? new Date(r.created_at).toISOString() : "";
    const pedidos = [
      ...tn.rows.map((r) => filaPedidoTN(r.data, estados[String(r.data.id)] || {}, overrides[String(r.data.id)])),
      ...man.rows.map((r) => filaPedidoManual(r, estados[r.id] || {}, overrides[r.id])),
    ].map((p) => ({
      id: p.id, numero: p.numero, fecha: p.fechaDisplay || String(creado[p.id] || "").slice(0, 10), local: p.local, estado: p.estado,
      medioPago: p.medioPago || "", total: p.totalNum, productos: p.productos || "", esManual: p.esManual, motivoAnulacion: p.motivoAnulacion,
    })).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) || String(creado[b.id]).localeCompare(String(creado[a.id])));
    // "Qué compra siempre": MISMA normalización que el reporte de productos vendidos (normalizarProducto + sin
    // envíos/medios de pago ni basura), sobre los pedidos no anulados. Por cantidad y por cantidad de pedidos.
    const prod = {};
    for (const p of pedidos.filter((x) => x.estado !== "Anulado")) {
      const enEste = new Set();
      for (const item of String(p.productos).split(", ")) {
        const m = item.match(/^(.+) x(\d+)$/);
        if (!m) continue;
        const nombre = normalizarProducto(m[1].trim());
        if (esExcluidoProduccion(nombre) || esBasuraVenta(nombre)) continue;
        prod[nombre] = prod[nombre] || { nombre, cantidad: 0, veces: 0 };
        prod[nombre].cantidad += Number(m[2]);
        if (!enEste.has(nombre)) { prod[nombre].veces += 1; enEste.add(nombre); }
      }
    }
    const lista = Object.values(prod);
    const porCantidad = [...lista].sort((a, b) => b.cantidad - a.cantidad || b.veces - a.veces || a.nombre.localeCompare(b.nombre)).slice(0, 10);
    const porVeces = [...lista].sort((a, b) => b.veces - a.veces || b.cantidad - a.cantidad || a.nombre.localeCompare(b.nombre)).slice(0, 10);
    const oportunidades = (await pool.query(
      `SELECT id, estado AS etapa, total_elegido AS monto, creada_en AS fecha, fecha_evento, origen, canal, cliente_nombre, empresa, email, telefono, motivo_perdida
       FROM cotizaciones WHERE cliente_key = $1 ORDER BY creada_en DESC`, [key])).rows.map((o) => ({ ...o, monto: o.monto === null ? null : Number(o.monto) }));
    const notas = (await pool.query(
      `SELECT id, tipo, texto, proximo_contacto::text AS proximo_contacto, hecho, hecho_at, hecho_por, estado, usuario, usuario_anula, anulado_at, created_at
       FROM clientes_notas WHERE cliente_key = $1 ORDER BY created_at DESC, id DESC`, [key])).rows;
    if (!cli && !pedidos.length && !oportunidades.length && !notas.length) return res.status(404).json({ error: "Cliente no encontrado." });
    // Sin pedidos (p. ej. un lead de Ventas a realizar): los datos salen de su oportunidad más reciente.
    const op = oportunidades[0];
    const datos = cli
      ? { nombre: cli.nombre, email: cli.email, telefono: cli.telefono, direccion: cli.direccion, zona: cli.zona, es_corporativo: !!cli.es_corporativo }
      : { nombre: op?.cliente_nombre || "", email: op?.email ? String(op.email).trim().toLowerCase() : null, telefono: op?.telefono ? String(op.telefono).replace(/\D/g, "") : null, direccion: "", zona: "", es_corporativo: false };
    const metricas = cli
      ? { cantidad_compras: Number(cli.cantidad_compras), total_gastado: Number(cli.total_gastado), ticket_promedio: cli.ticket_promedio === null ? null : Number(cli.ticket_promedio),
          primera_compra: cli.primera_compra, ultima_compra: cli.ultima_compra, dias_desde_ultima: cli.dias_desde_ultima === null ? null : Number(cli.dias_desde_ultima) }
      : { cantidad_compras: 0, total_gastado: 0, ticket_promedio: null, primera_compra: null, ultima_compra: null, dias_desde_ultima: null };
    res.json({ cliente_key: key, datos, metricas, temperatura: cli ? cli.temperatura : null, compraSiempre: { porCantidad, porVeces }, pedidos, oportunidades, notas });
  } catch (err) {
    console.error("Error /api/clientes/ficha:", err.message);
    res.status(500).json({ error: "Error armando la ficha del cliente" });
  }
});

// Notas y seguimiento (no se borran: se anulan). Solo el autor o un superadmin pueden anular.
app.post("/api/clientes/notas", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const key = claveClienteDeQuery(b.cliente_key);
  const tipo = b.tipo || "nota";
  const texto = String(b.texto || "").trim();
  const proximo = b.proximo_contacto ? String(b.proximo_contacto) : null;
  if (!key) return res.status(400).json({ error: "Falta el cliente." });
  if (!TIPOS_NOTA_CLIENTE.includes(tipo)) return res.status(400).json({ error: "Tipo de nota inválido." });
  if (!texto) return res.status(400).json({ error: "El texto es obligatorio." });
  if (proximo && !esFechaISO(proximo)) return res.status(400).json({ error: "Próximo contacto inválido (YYYY-MM-DD)." });
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  try {
    const r = await pool.query(
      "INSERT INTO clientes_notas (cliente_key, tipo, texto, proximo_contacto, usuario) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [key, tipo, texto, proximo, quien]
    );
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(quien, "cliente_nota_crear", "cliente_nota", r.rows[0].id, { cliente_key: key, tipo, proximo_contacto: proximo });
  } catch (err) { console.error("Error POST /api/clientes/notas:", err.message); res.status(500).json({ error: "Error guardando la nota" }); }
});
// Marcar (o desmarcar) un seguimiento como hecho.
app.post("/api/clientes/notas/:id/hecho", requireAdmin, async (req, res) => {
  const hecho = (req.body || {}).hecho !== false;
  const quien = req.user?.nombre_completo || null;
  try {
    const r = await pool.query(
      `UPDATE clientes_notas SET hecho = $1, hecho_at = CASE WHEN $1 THEN NOW() END, hecho_por = CASE WHEN $1 THEN $2 END
       WHERE id = $3 AND estado = 'activo' RETURNING id, cliente_key`, [hecho, quien, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Nota no encontrada o anulada." });
    res.json({ ok: true });
    registrarAuditoria(quien, hecho ? "cliente_seguimiento_hecho" : "cliente_seguimiento_pendiente", "cliente_nota", req.params.id, { cliente_key: r.rows[0].cliente_key });
  } catch (err) { console.error("Error hecho nota:", err.message); res.status(500).json({ error: "Error actualizando el seguimiento" }); }
});
app.post("/api/clientes/notas/:id/anular", requireAdmin, async (req, res) => {
  const quien = req.user?.nombre_completo || null;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const n = (await client.query("SELECT id, cliente_key, usuario, estado FROM clientes_notas WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!n) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Nota no encontrada." }); }
    if (n.estado !== "activo") { await client.query("ROLLBACK"); return res.status(409).json({ error: "La nota ya está anulada." }); }
    if (req.user?.rol !== "superadmin" && n.usuario !== quien) { await client.query("ROLLBACK"); return res.status(403).json({ error: "Solo quien escribió la nota (o un superadmin) puede anularla." }); }
    await client.query("UPDATE clientes_notas SET estado = 'anulado', usuario_anula = $1, anulado_at = NOW() WHERE id = $2", [quien, n.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "cliente_nota_anular", "cliente_nota", n.id, { cliente_key: n.cliente_key, autor: n.usuario });
  } catch (err) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error anular nota:", err.message); res.status(500).json({ error: "Error anulando la nota" });
  } finally { if (client) client.release(); }
});
// Seguimientos pendientes: próximo contacto sin hacer (notas activas), por fecha (vencidos y de hoy primero).
app.get("/api/clientes/seguimientos", requireAdmin, async (req, res) => {
  try {
    const hoy = fechaArgentinaISO();
    const { rows } = await pool.query(
      `SELECT id, cliente_key, tipo, texto, proximo_contacto::text AS proximo_contacto, usuario, created_at FROM clientes_notas
       WHERE estado = 'activo' AND NOT hecho AND proximo_contacto IS NOT NULL ORDER BY proximo_contacto ASC, id ASC`);
    // Nombre / contacto: de la base de clientes (misma consulta) o, si no tiene pedidos, de su oportunidad más reciente.
    const keys = [...new Set(rows.map((r) => r.cliente_key))];
    const info = {};
    if (keys.length) {
      for (const c of (await pool.query(sqlClientes({ filtroAgg: "AND cliente_key = ANY($1)", conCompras: false }), [keys])).rows) info[c.cliente_key] = { nombre: c.nombre, telefono: c.telefono, email: c.email };
      const faltan = keys.filter((k) => !info[k]);
      if (faltan.length) {
        for (const o of (await pool.query("SELECT DISTINCT ON (cliente_key) cliente_key, cliente_nombre, telefono, email FROM cotizaciones WHERE cliente_key = ANY($1) ORDER BY cliente_key, creada_en DESC", [faltan])).rows) {
          info[o.cliente_key] = { nombre: o.cliente_nombre, telefono: o.telefono, email: o.email };
        }
      }
    }
    res.json(rows.map((r) => ({
      ...r, nombre: info[r.cliente_key]?.nombre || r.cliente_key, telefono: info[r.cliente_key]?.telefono || null, email: info[r.cliente_key]?.email || null,
      vencido: r.proximo_contacto < hoy, es_hoy: r.proximo_contacto === hoy,
    })));
  } catch (err) { console.error("Error /api/clientes/seguimientos:", err.message); res.status(500).json({ error: "Error trayendo los seguimientos" }); }
});

// Alta MANUAL de oportunidad (pipeline "Ventas a realizar"). Reusa la tabla cotizaciones con
// origen='manual'. Admin + superadmin. El cliente puede ser existente (autocompletado) o nuevo.
app.post("/api/ventas/oportunidades", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.cliente_nombre || !String(b.cliente_nombre).trim()) return res.status(400).json({ error: "El nombre del cliente es obligatorio." });
  const ETAPAS = ["pendiente", "contactado", "cotizado", "ganada", "perdida"];
  const estado = ETAPAS.includes(b.estado) ? b.estado : "pendiente";
  if (estado === "perdida" && !String(b.motivo_perdida || "").trim()) return res.status(400).json({ error: "Indicá el motivo de la pérdida." });
  try {
    const cliente_key = clienteKeyDe(b.email, b.telefono);
    const q = await pool.query(
      `INSERT INTO cotizaciones (cliente_nombre, empresa, email, telefono, personas, fecha_evento, zona,
         total_elegido, notas, estado, motivo_perdida, cliente_key, origen, canal)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual','manual') RETURNING id, creada_en`,
      [b.cliente_nombre.trim(), b.empresa || null, b.email || null, b.telefono || null, b.personas || null,
       b.fecha_evento || null, b.zona || null, Number(b.total_elegido) || null, b.notas || null, estado,
       b.motivo_perdida || null, cliente_key]
    );
    res.json({ ok: true, id: q.rows[0].id });
    registrarAuditoria(b.usuario, "oportunidad_crear", "cotizacion", q.rows[0].id, { cliente: b.cliente_nombre, total: b.total_elegido, estado });
  } catch (err) {
    console.error("Error /api/ventas/oportunidades:", err.message);
    res.status(500).json({ error: "Error creando la oportunidad" });
  }
});

// ─── GASTOS COMUNES (sin factura de proveedor) — admin + superadmin ─────
// Reusa el patrón del pago de factura desde caja (salida atómica) + bloqueaCajaAdmin + CAJAS_TRANSFERIBLES.
app.get("/api/gastos-comunes/categorias", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM categorias_gasto_comun WHERE activo = true ORDER BY nombre ASC");
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/gastos-comunes/categorias", requireAdmin, async (req, res) => {
  const { nombre, es_retiro } = req.body;
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  try {
    const r = await pool.query("INSERT INTO categorias_gasto_comun (nombre, es_retiro) VALUES ($1,$2) RETURNING *", [String(nombre).trim(), !!es_retiro]);
    res.json({ ok: true, categoria: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/gastos-comunes/categorias/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE categorias_gasto_comun SET activo = false WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/gastos-comunes", requireAdmin, async (req, res) => {
  const { desde, hasta, categoria, origen, incluirAnulados } = req.query;
  try {
    const params = [];
    let sql = `SELECT g.*, c.nombre AS categoria_nombre, c.es_retiro, ct.nombre AS cuenta_nombre
               FROM gastos_comunes g JOIN categorias_gasto_comun c ON c.id = g.categoria_id
               LEFT JOIN cuentas_tesoreria ct ON ct.id = g.cuenta_id WHERE 1=1`;
    if (incluirAnulados !== "1") sql += " AND g.estado <> 'anulado'";
    if (desde) { params.push(desde); sql += ` AND g.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND g.fecha <= $${params.length}`; }
    if (categoria) { params.push(categoria); sql += ` AND g.categoria_id = $${params.length}`; }
    if (origen === "externo") sql += " AND g.caja_origen IS NULL AND g.cuenta_id IS NULL";
    else if (origen === "caja") sql += " AND g.caja_origen IS NOT NULL";
    else if (origen === "cuenta") sql += " AND g.cuenta_id IS NOT NULL";
    sql += " ORDER BY g.fecha DESC, g.id DESC";
    const { rows } = await pool.query(sql, params);
    const activos = rows.filter(r => r.estado === "activo");
    const totalGastos = activos.filter(r => !r.es_retiro).reduce((a, r) => a + Number(r.monto), 0);
    const totalRetiros = activos.filter(r => r.es_retiro).reduce((a, r) => a + Number(r.monto), 0);
    const porCategoria = {};
    for (const r of activos) porCategoria[r.categoria_nombre] = (porCategoria[r.categoria_nombre] || 0) + Number(r.monto);
    res.json({ gastos: rows, totalGastos, totalRetiros, porCategoria });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Origen: externo (solo el gasto), caja (salida con fecha de hoy) o cuenta de tesorería (egreso con la fecha del gasto).
app.post("/api/gastos-comunes", requireAdmin, async (req, res) => {
  const { fecha, descripcion, monto, categoria_id, cajaOrigen, cuentaId } = req.body || {};
  if (!descripcion || !String(descripcion).trim()) return res.status(400).json({ error: "La descripción es obligatoria." });
  const m = Number(monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "El monto debe ser mayor a 0." });
  if (!esFechaISO(fecha)) return res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)." });
  const origen = leerOrigenPago(req, res, cajaOrigen, cuentaId);   // caja inválida / Administración sin superadmin / las dos
  if (!origen) return;
  const usuario = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  try {
    const cat = await pool.query("SELECT id, nombre FROM categorias_gasto_comun WHERE id = $1 AND activo = true", [categoria_id]);
    if (cat.rows.length === 0) return res.status(400).json({ error: "Categoría inválida." });
    const catNombre = cat.rows[0].nombre;
    const desc = String(descripcion).trim();

    // Externo: solo el gasto, sin tocar caja ni cuenta.
    if (!origen.caja && !origen.cuentaId) {
      const r = await pool.query(
        "INSERT INTO gastos_comunes (fecha, descripcion, monto, categoria_id, caja_origen, usuario) VALUES ($1,$2,$3,$4,NULL,$5) RETURNING id",
        [fecha, desc, m, categoria_id, usuario]
      );
      res.json({ ok: true, id: r.rows[0].id });
      registrarAuditoria(usuario, "gasto_comun_crear", "gasto", r.rows[0].id, { monto: m, categoria: catNombre, externo: true });
      return;
    }

    // Sale de caja o de una cuenta: transacción atómica (el gasto + la salida / el egreso, todo o nada).
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");
      let movId = null;
      if (origen.caja) {
        const mov = await client.query(
          "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4) RETURNING id",
          [origen.caja, `Gasto: ${catNombre} - ${desc}`, -Math.abs(m), fechaArgentinaISO()]   // HOY: cae en el día abierto
        );
        movId = mov.rows[0].id;
      }
      const g = await client.query(
        "INSERT INTO gastos_comunes (fecha, descripcion, monto, categoria_id, caja_origen, caja_movimiento_id, cuenta_id, usuario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [fecha, desc, m, categoria_id, origen.caja, movId, origen.cuentaId, usuario]
      );
      if (origen.cuentaId) {
        await registrarMovimientoCuenta(client, { cuentaId: origen.cuentaId, fecha, tipo: "egreso", monto: m, concepto: `Gasto: ${catNombre} - ${desc}`, origenTipo: "gasto_comun", origenId: g.rows[0].id, usuario });
      }
      await client.query("COMMIT");
      res.json({ ok: true, id: g.rows[0].id });
      registrarAuditoria(usuario, "gasto_comun_crear", "gasto", g.rows[0].id, { monto: m, categoria: catNombre, cajaOrigen: origen.caja, cuentaId: origen.cuentaId });
    } catch (e) {
      if (client) await client.query("ROLLBACK").catch(() => {});
      return responderErrorPago(res, e, "Error registrando el gasto", "POST /api/gastos-comunes");
    } finally { if (client) client.release(); }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/gastos-comunes/:id/anular", requireAdmin, async (req, res) => {
  const { motivo } = req.body || {};
  if (!motivo || !String(motivo).trim()) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  const usuario = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query("SELECT id, descripcion, monto, caja_origen, cuenta_id, estado FROM gastos_comunes WHERE id = $1 FOR UPDATE", [req.params.id]);
    const g = sel.rows[0];
    if (!g) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Gasto no encontrado." }); }
    if (g.estado !== "activo") { await client.query("ROLLBACK"); return res.status(409).json({ error: "El gasto ya está anulado." }); }
    if (g.cuenta_id) await anularMovimientoPorOrigen(client, "gasto_comun", g.id, String(motivo).trim(), usuario);   // conciliado → 409
    if (g.caja_origen) {
      if (bloqueaCajaAdmin(req, res, g.caja_origen)) { await client.query("ROLLBACK"); return; }
      await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4)",
        [g.caja_origen, `Anulación gasto #${g.id}: ${g.descripcion}`, Math.abs(Number(g.monto)), fechaArgentinaISO()]
      );
    }
    await client.query("UPDATE gastos_comunes SET estado = 'anulado', motivo_anulacion = $1 WHERE id = $2", [String(motivo).trim(), req.params.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(usuario, "gasto_comun_anular", "gasto", req.params.id, { motivo: String(motivo).trim() });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error anulando el gasto", "anular gasto");
  } finally { if (client) client.release(); }
});

// ─── RRHH — Fase 1 (fichas, liquidaciones, novedades) — SOLO superadmin ─
// No calcula sueldos: registra lo que liquida el estudio. El pago del sueldo es Fase 2.
// Reusa: superadmin (como libro de ventas), salida atómica + anulación con reposición (gastos comunes).
// PRIVACIDAD: nunca loguear DNI/CUIL/CBU en consola ni auditoría (en auditoría solo id y nombre).
const soloSuperadmin = [requireAuth, requireRole("superadmin")];
const esPeriodoYM = (s) => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const TIPOS_NOVEDAD = ["adelanto", "hora_extra", "bono", "descuento", "otro"];

// --- Empleados (fichas) ---
app.get("/api/rrhh/empleados", soloSuperadmin, async (req, res) => {
  try {
    const sql = req.query.incluirInactivos === "1"
      ? "SELECT * FROM empleados ORDER BY activo DESC, nombre ASC"
      : "SELECT * FROM empleados WHERE activo = true ORDER BY nombre ASC";
    const r = await pool.query(sql);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/rrhh/empleados", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (b.cuil && !/^\d{11}$/.test(String(b.cuil).replace(/\D/g, ""))) return res.status(400).json({ error: "El CUIL debe tener 11 dígitos." });
  try {
    const r = await pool.query(
      `INSERT INTO empleados (nombre, dni, cuil, fecha_nacimiento, domicilio, telefono, email, contacto_emergencia, local, puesto, categoria_convenio, jornada, fecha_ingreso, cbu_alias)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [String(b.nombre).trim(), b.dni || null, b.cuil || null, b.fecha_nacimiento || null, b.domicilio || null, b.telefono || null, b.email || null, b.contacto_emergencia || null, b.local || null, b.puesto || null, b.categoria_convenio || null, b.jornada || null, b.fecha_ingreso || null, b.cbu_alias || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(b.usuario, "empleado_crear", "empleado", r.rows[0].id, { nombre: String(b.nombre).trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/rrhh/empleados/:id", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  if (b.nombre !== undefined && !String(b.nombre).trim()) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
  if (b.cuil && !/^\d{11}$/.test(String(b.cuil).replace(/\D/g, ""))) return res.status(400).json({ error: "El CUIL debe tener 11 dígitos." });
  const campos = ["nombre", "dni", "cuil", "fecha_nacimiento", "domicilio", "telefono", "email", "contacto_emergencia", "local", "puesto", "categoria_convenio", "jornada", "fecha_ingreso", "fecha_egreso", "cbu_alias", "activo"];
  const sets = [], vals = [];
  for (const c of campos) if (b[c] !== undefined) { vals.push(c === "nombre" ? String(b[c]).trim() : b[c]); sets.push(`${c} = $${vals.length}`); }
  if (sets.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
  vals.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE empleados SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING nombre`, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: "Empleado no encontrado." });
    res.json({ ok: true });
    registrarAuditoria(b.usuario, "empleado_editar", "empleado", req.params.id, { nombre: r.rows[0].nombre });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/rrhh/empleados/:id/baja", soloSuperadmin, async (req, res) => {
  const { fecha_egreso, usuario } = req.body || {};
  if (fecha_egreso && !esFechaISO(fecha_egreso)) return res.status(400).json({ error: "Fecha de egreso inválida (YYYY-MM-DD)." });
  try {
    const r = await pool.query("UPDATE empleados SET activo = false, fecha_egreso = COALESCE($1, fecha_egreso) WHERE id = $2 RETURNING nombre", [fecha_egreso || null, req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Empleado no encontrado." });
    res.json({ ok: true });
    registrarAuditoria(usuario, "empleado_baja", "empleado", req.params.id, { nombre: r.rows[0].nombre, fecha_egreso: fecha_egreso || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Liquidaciones (una por empleado y mes) ---
function avisoNetoLiq(bruto, noRem, deduc, neto) {
  const esperado = bruto + noRem - deduc;
  return Math.abs(neto - esperado) > 1
    ? `El neto no cierra: bruto + no remunerativo − deducciones = ${esperado.toFixed(2)}, cargaste ${neto.toFixed(2)}.`
    : null;
}
// Estado de pago de una liquidación (calculado, nunca se guarda). Los adelantos NO se restan.
function estadoPagoDe(neto, pagado) {
  const saldo = Number(neto) - Number(pagado);
  if (Number(pagado) <= 0) return "pendiente";
  if (saldo <= 1) return "pagada";
  return "parcial";
}
app.get("/api/rrhh/liquidaciones", soloSuperadmin, async (req, res) => {
  const { periodo, empleado } = req.query;
  try {
    const params = [];
    let sql = `SELECT l.*, e.nombre AS empleado_nombre, e.local AS empleado_local
               FROM liquidaciones_sueldo l JOIN empleados e ON e.id = l.empleado_id WHERE 1=1`;
    if (periodo) { params.push(periodo); sql += ` AND l.periodo = $${params.length}`; }
    if (empleado) { params.push(empleado); sql += ` AND l.empleado_id = $${params.length}`; }
    sql += " ORDER BY l.periodo DESC, e.nombre ASC";
    const { rows } = await pool.query(sql, params);
    // Pagos de esas liquidaciones (activos + anulados para historial), con su forma (banco / efectivo) calculada.
    const pagosPorLiq = {};
    if (rows.length > 0) {
      const ids = rows.map(r => r.id);
      const pg = await pool.query(
        `SELECT p.*, ct.nombre AS cuenta_nombre FROM pagos_sueldo p LEFT JOIN cuentas_tesoreria ct ON ct.id = p.cuenta_id
         WHERE p.liquidacion_id = ANY($1) ORDER BY p.fecha DESC, p.id DESC`, [ids]);
      for (const p of pg.rows) (pagosPorLiq[p.liquidacion_id] = pagosPorLiq[p.liquidacion_id] || []).push({ ...p, forma: formaPagoSueldo(p) });
    }
    // Adicionales del período (hora extra / bono / otro activos, por la fecha de la novedad): SOLO informativo,
    // no tocan el neto ni el saldo de la liquidación del estudio.
    const adicionales = {};
    if (rows.length > 0) {
      const ad = await pool.query(
        `SELECT empleado_id, substring(fecha, 1, 7) AS mes, SUM(monto) AS total FROM novedades_empleado
         WHERE tipo IN ('hora_extra','bono','otro') AND estado = 'activo' AND empleado_id = ANY($1) GROUP BY 1, 2`,
        [[...new Set(rows.map(r => r.empleado_id))]]);
      for (const a of ad.rows) adicionales[`${a.empleado_id}|${a.mes}`] = Number(a.total);
    }
    const enriquecidas = rows.map(l => {
      const pagos = pagosPorLiq[l.id] || [];
      const pagado = pagos.filter(p => p.estado === "activo").reduce((a, p) => a + Number(p.monto), 0);
      const saldo = Number(l.neto) - pagado;
      const { banco, efectivo } = desgloseFormas(pagos);
      return { ...l, pagos, pagado, saldo, estado_pago: estadoPagoDe(l.neto, pagado), pagado_banco: banco, pagado_efectivo: efectivo,
        adicionales_periodo: adicionales[`${l.empleado_id}|${l.periodo}`] || 0 };
    });
    res.json(enriquecidas);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/rrhh/liquidaciones", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  if (!esPeriodoYM(b.periodo)) return res.status(400).json({ error: "Período inválido (formato YYYY-MM)." });
  const empId = Number(b.empleado_id);
  if (!empId) return res.status(400).json({ error: "Falta el empleado." });
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const bruto = num(b.bruto), noRem = num(b.no_remunerativo), deduc = num(b.deducciones), neto = num(b.neto), contrib = num(b.contribuciones);
  try {
    const emp = await pool.query("SELECT nombre FROM empleados WHERE id = $1", [empId]);
    if (emp.rows.length === 0) return res.status(400).json({ error: "Empleado inválido." });
    const dup = await pool.query("SELECT id FROM liquidaciones_sueldo WHERE empleado_id = $1 AND periodo = $2", [empId, b.periodo]);
    if (dup.rows.length > 0) return res.status(409).json({ error: `Ya hay una liquidación de ${emp.rows[0].nombre} para ${b.periodo}.` });
    const r = await pool.query(
      `INSERT INTO liquidaciones_sueldo (empleado_id, periodo, bruto, no_remunerativo, deducciones, neto, contribuciones, notas, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [empId, b.periodo, bruto, noRem, deduc, neto, contrib, b.notas || null, b.usuario || null]
    );
    res.json({ ok: true, id: r.rows[0].id, aviso: avisoNetoLiq(bruto, noRem, deduc, neto) });
    registrarAuditoria(b.usuario, "liquidacion_crear", "liquidacion", r.rows[0].id, { empleado_id: empId, empleado: emp.rows[0].nombre, periodo: b.periodo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.patch("/api/rrhh/liquidaciones/:id", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const bruto = num(b.bruto), noRem = num(b.no_remunerativo), deduc = num(b.deducciones), neto = num(b.neto), contrib = num(b.contribuciones);
  try {
    // No permitir bajar el neto por debajo de lo ya pagado.
    const pg = await pool.query("SELECT COALESCE(SUM(monto),0) AS pagado FROM pagos_sueldo WHERE liquidacion_id = $1 AND estado = 'activo'", [req.params.id]);
    const pagado = Number(pg.rows[0].pagado);
    if (pagado > 0 && neto < pagado - 1) return res.status(409).json({ error: `No podés bajar el neto a ${neto.toFixed(2)}: ya hay $${pagado.toFixed(2)} pagados. Anulá pagos primero.` });
    const r = await pool.query(
      `UPDATE liquidaciones_sueldo SET bruto=$1, no_remunerativo=$2, deducciones=$3, neto=$4, contribuciones=$5, notas=$6 WHERE id=$7 RETURNING empleado_id, periodo`,
      [bruto, noRem, deduc, neto, contrib, b.notas || null, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: "Liquidación no encontrada." });
    res.json({ ok: true, aviso: avisoNetoLiq(bruto, noRem, deduc, neto) });
    registrarAuditoria(b.usuario, "liquidacion_editar", "liquidacion", req.params.id, { empleado_id: r.rows[0].empleado_id, periodo: r.rows[0].periodo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Pagos de sueldo (Fase 2 + Tesorería B2) ---
// Saldo = neto − Σ pagos activos. Los adelantos NO se restan. Varios pagos por liquidación.
// Origen de cada pago: externo, caja (SALIDA con fecha de hoy) o cuenta de tesorería (egreso con la fecha del pago),
// nunca caja y cuenta a la vez (leerOrigenPago, el mismo de Compras).
// Forma (calculada, nunca se guarda): caja → efectivo; cuenta → banco; externo → según el medio (Efectivo → efectivo,
// cualquier otro → banco). Solo informativa: el costo y el saldo no cambian.
function formaPagoSueldo(p) {
  if (p.caja_origen) return "efectivo";
  if (p.cuenta_id) return "banco";
  return normTesoreria(p.medio_pago) === "efectivo" ? "efectivo" : "banco";
}
const desgloseFormas = (pagos) => pagos.filter((p) => p.estado === "activo")
  .reduce((a, p) => { a[formaPagoSueldo(p)] += Number(p.monto); return a; }, { banco: 0, efectivo: 0 });

// Pago simple (body plano: monto, medioPago, cajaOrigen | cuentaId) o "pago dividido" (body.partes: dos renglones, p. ej.
// banco + efectivo). Una sola transacción con FOR UPDATE de la liquidación: si una parte falla no queda ninguna, y la
// suma de las partes no puede superar el saldo.
app.post("/api/rrhh/liquidaciones/:id/pagos", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  if (!esFechaISO(b.fecha)) return res.status(400).json({ error: "Fecha inválida (YYYY-MM-DD)." });
  const dividido = Array.isArray(b.partes);
  const crudas = dividido ? b.partes : [{ monto: b.monto, medioPago: b.medioPago, cajaOrigen: b.cajaOrigen, cuentaId: b.cuentaId }];
  if (dividido && crudas.length !== 2) return res.status(400).json({ error: "Un pago dividido tiene dos partes." });
  const partes = [];
  for (const [i, p] of crudas.entries()) {
    const pre = dividido ? `Parte ${i + 1}: ` : "";
    const m = Number(p && p.monto);
    if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: `${pre}El monto debe ser mayor a 0.` });
    if (!p.medioPago || !String(p.medioPago).trim()) return res.status(400).json({ error: `${pre}El medio de pago es obligatorio.` });
    const origen = leerOrigenPago(req, res, p.cajaOrigen, p.cuentaId);
    if (!origen) return;
    partes.push({ monto: m, medio: String(p.medioPago).trim(), ...origen });
  }
  const total = partes.reduce((a, p) => a + p.monto, 0);
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client, liq;
  const ids = [];
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT l.id, l.neto, l.periodo, e.nombre AS empleado_nombre
       FROM liquidaciones_sueldo l JOIN empleados e ON e.id = l.empleado_id WHERE l.id = $1 FOR UPDATE`, [req.params.id]);
    liq = sel.rows[0];
    if (!liq) throw new ErrorTesoreria(404, "Liquidación no encontrada.");
    const pg = await client.query("SELECT COALESCE(SUM(monto),0) AS pagado FROM pagos_sueldo WHERE liquidacion_id = $1 AND estado = 'activo'", [req.params.id]);
    const saldo = Number(liq.neto) - Number(pg.rows[0].pagado);
    if (total > saldo + 1) {
      throw new ErrorTesoreria(400, dividido
        ? `Las dos partes suman $${total.toFixed(2)} y superan el saldo. Queda por pagar $${saldo.toFixed(2)}.`
        : `El pago supera el saldo. Queda por pagar $${saldo.toFixed(2)}.`);
    }
    const concepto = `Pago sueldo: ${liq.empleado_nombre} ${liq.periodo}`;
    for (const p of partes) {
      let cajaMovId = null;
      if (p.caja) {
        const mov = await client.query(
          "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4) RETURNING id",
          [p.caja, concepto, -Math.abs(p.monto), fechaArgentinaISO()]   // HOY: cae en el día abierto
        );
        cajaMovId = mov.rows[0].id;
      }
      const pago = await client.query(
        "INSERT INTO pagos_sueldo (liquidacion_id, fecha, monto, medio_pago, caja_origen, caja_movimiento_id, cuenta_id, usuario) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [req.params.id, b.fecha, p.monto, p.medio, p.caja, cajaMovId, p.cuentaId, quien]
      );
      ids.push(pago.rows[0].id);
      if (p.cuentaId) {
        await registrarMovimientoCuenta(client, { cuentaId: p.cuentaId, fecha: b.fecha, tipo: "egreso", monto: p.monto, concepto, origenTipo: "pago_sueldo", origenId: pago.rows[0].id, usuario: quien });
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error registrando el pago", "POST /api/rrhh/liquidaciones/:id/pagos");
  } finally { if (client) client.release(); }
  res.json({ ok: true, id: ids[0], ids });
  partes.forEach((p, i) => registrarAuditoria(quien, "pago_sueldo_crear", "pago_sueldo", ids[i], {
    liquidacion_id: Number(req.params.id), empleado: liq.empleado_nombre, periodo: liq.periodo, monto: p.monto, medioPago: p.medio,
    cajaOrigen: p.caja, cuentaId: p.cuentaId, forma: formaPagoSueldo({ caja_origen: p.caja, cuenta_id: p.cuentaId, medio_pago: p.medio }), ...(dividido ? { dividido: true } : {}),
  }));
});
// Anular: desde caja repone con una ENTRADA (y guarda su id); desde cuenta anula el egreso (conciliado → 409).
app.post("/api/rrhh/pagos/:id/anular", soloSuperadmin, async (req, res) => {
  const motivo = String((req.body || {}).motivo || "").trim();
  if (!motivo) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT p.id, p.monto, p.caja_origen, p.cuenta_id, p.estado, e.nombre AS empleado_nombre
       FROM pagos_sueldo p JOIN liquidaciones_sueldo l ON l.id = p.liquidacion_id JOIN empleados e ON e.id = l.empleado_id
       WHERE p.id = $1 FOR UPDATE OF p`, [req.params.id]);
    const p = sel.rows[0];
    if (!p) throw new ErrorTesoreria(404, "Pago no encontrado.");
    if (p.estado !== "activo") throw new ErrorTesoreria(409, "El pago ya está anulado.");
    if (p.cuenta_id) await anularMovimientoPorOrigen(client, "pago_sueldo", p.id, motivo, quien);
    let movAnulId = null;
    if (p.caja_origen) {
      if (bloqueaCajaAdmin(req, res, p.caja_origen)) { await client.query("ROLLBACK"); return; }
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4) RETURNING id",
        [p.caja_origen, `Anulación pago sueldo #${p.id}: ${p.empleado_nombre}`, Math.abs(Number(p.monto)), fechaArgentinaISO()]
      );
      movAnulId = mov.rows[0].id;
    }
    await client.query("UPDATE pagos_sueldo SET estado='anulado', motivo_anulacion=$1, caja_movimiento_anulacion_id=$2 WHERE id=$3", [motivo, movAnulId, p.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "pago_sueldo_anular", "pago_sueldo", p.id, { motivo, cajaOrigen: p.caja_origen || null, cuentaId: p.cuenta_id || null, monto: Number(p.monto) });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error anulando el pago", "anular pago sueldo");
  } finally { if (client) client.release(); }
});

// --- Novedades (adelantos/extras/bonos/descuentos) ---
// Con PAGO (origen externo / caja / cuenta + medio): adelanto y los ADICIONALES fuera del recibo (hora_extra, bono, otro).
// "descuento" es solo registro. Los adicionales NO tocan la liquidación del estudio ni su saldo; sí suman al costo de
// personal. Los registros viejos sin origen se ven como "Externo".
const TIPOS_ADICIONAL = ["hora_extra", "bono", "otro"];
const TIPOS_CON_PAGO = ["adelanto", ...TIPOS_ADICIONAL];
const ETIQUETA_NOVEDAD = { adelanto: "Adelanto", hora_extra: "Hora extra", bono: "Bono", descuento: "Descuento", otro: "Otro" };
app.get("/api/rrhh/novedades", soloSuperadmin, async (req, res) => {
  const { empleado, periodo, incluirAnulados, tipo, origen } = req.query;
  try {
    const params = [];
    let sql = `SELECT n.*, e.nombre AS empleado_nombre, ct.nombre AS cuenta_nombre FROM novedades_empleado n
               JOIN empleados e ON e.id = n.empleado_id LEFT JOIN cuentas_tesoreria ct ON ct.id = n.cuenta_id WHERE 1=1`;
    if (incluirAnulados !== "1") sql += " AND n.estado <> 'anulado'";
    if (empleado) { params.push(empleado); sql += ` AND n.empleado_id = $${params.length}`; }
    if (esPeriodoYM(periodo)) { params.push(periodo + "-01", periodo + "-31"); sql += ` AND n.fecha >= $${params.length - 1} AND n.fecha <= $${params.length}`; }
    if (TIPOS_NOVEDAD.includes(tipo)) { params.push(tipo); sql += ` AND n.tipo = $${params.length}`; }
    // Origen: solo las novedades con pago (el descuento no tiene origen).
    if (origen === "externo") sql += ` AND n.tipo <> 'descuento' AND n.caja_origen IS NULL AND n.cuenta_id IS NULL`;
    else if (origen === "caja") sql += " AND n.caja_origen IS NOT NULL";
    else if (origen === "cuenta") sql += " AND n.cuenta_id IS NOT NULL";
    sql += " ORDER BY n.fecha DESC, n.id DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
// Atómico: la novedad + la salida de caja (hoy) o el egreso en la cuenta (fecha de la novedad), todo o nada.
app.post("/api/rrhh/novedades", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const empId = Number(b.empleado_id);
  if (!empId) return res.status(400).json({ error: "Falta el empleado." });
  if (!TIPOS_NOVEDAD.includes(b.tipo)) return res.status(400).json({ error: "Tipo de novedad inválido." });
  if (!esFechaISO(b.fecha)) return res.status(400).json({ error: "Fecha inválida (YYYY-MM-DD)." });
  const m = Number(b.monto);
  if (!Number.isFinite(m) || m <= 0) return res.status(400).json({ error: "El monto debe ser mayor a 0." });
  const conPago = TIPOS_CON_PAGO.includes(b.tipo), esAdicional = TIPOS_ADICIONAL.includes(b.tipo);
  const origen = conPago ? leerOrigenPago(req, res, b.cajaOrigen, b.cuentaId) : { caja: null, cuentaId: null };   // descuento: el origen se ignora
  if (!origen) return;
  const medio = conPago
    ? (b.medioPago && String(b.medioPago).trim() ? String(b.medioPago).trim() : origen.caja ? "Efectivo" : origen.cuentaId ? "Transferencia" : null)
    : null;
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const emp = await client.query("SELECT nombre FROM empleados WHERE id = $1", [empId]);
    if (emp.rows.length === 0) throw new ErrorTesoreria(400, "Empleado inválido.");
    const nombre = emp.rows[0].nombre;
    const n = await client.query(
      `INSERT INTO novedades_empleado (empleado_id, tipo, fecha, monto, concepto, caja_origen, cuenta_id, medio_pago, usuario)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [empId, b.tipo, b.fecha, m, b.concepto || null, origen.caja, origen.cuentaId, medio, quien]
    );
    const id = n.rows[0].id;
    // Adelanto: concepto de siempre. Adicional: prefijo fijo + "#id" (no editable en Caja).
    const concepto = esAdicional ? `Pago adicional #${id}: ${nombre} (${ETIQUETA_NOVEDAD[b.tipo]})` : `Adelanto sueldo: ${nombre}`;
    if (origen.caja) {
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4) RETURNING id",
        [origen.caja, concepto, -Math.abs(m), fechaArgentinaISO()]   // HOY: cae en el día abierto
      );
      await client.query("UPDATE novedades_empleado SET caja_movimiento_id = $1 WHERE id = $2", [mov.rows[0].id, id]);
    }
    if (origen.cuentaId) {
      await registrarMovimientoCuenta(client, { cuentaId: origen.cuentaId, fecha: b.fecha, tipo: "egreso", monto: m, concepto, origenTipo: esAdicional ? "adicional" : "adelanto", origenId: id, usuario: quien });
    }
    await client.query("COMMIT");
    res.json({ ok: true, id });
    registrarAuditoria(quien, "novedad_crear", "novedad", id, { empleado_id: empId, empleado: nombre, tipo: b.tipo, monto: m,
      ...(conPago ? { cajaOrigen: origen.caja, cuentaId: origen.cuentaId, medioPago: medio } : {}) });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error registrando la novedad", "POST /api/rrhh/novedades");
  } finally { if (client) client.release(); }
});
// Anular (motivo obligatorio): desde caja repone con una ENTRADA (y guarda su id); desde cuenta anula el egreso
// (conciliado → 409). Un descuento o un registro sin origen solo se marca anulado.
app.post("/api/rrhh/novedades/:id/anular", soloSuperadmin, async (req, res) => {
  const motivo = String((req.body || {}).motivo || "").trim();
  if (!motivo) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  const quien = req.user?.nombre_completo || null;   // de la SESIÓN, nunca del body
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT n.id, n.tipo, n.monto, n.caja_origen, n.cuenta_id, n.estado, e.nombre AS empleado_nombre
       FROM novedades_empleado n JOIN empleados e ON e.id = n.empleado_id WHERE n.id = $1 FOR UPDATE OF n`, [req.params.id]);
    const n = sel.rows[0];
    if (!n) throw new ErrorTesoreria(404, "Novedad no encontrada.");
    if (n.estado !== "activo") throw new ErrorTesoreria(409, "La novedad ya está anulada.");
    const esAdicional = TIPOS_ADICIONAL.includes(n.tipo);
    if (n.cuenta_id) await anularMovimientoPorOrigen(client, esAdicional ? "adicional" : "adelanto", n.id, motivo, quien);
    let movAnulId = null;
    if (n.caja_origen) {
      if (bloqueaCajaAdmin(req, res, n.caja_origen)) { await client.query("ROLLBACK"); return; }
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4) RETURNING id",
        [n.caja_origen, esAdicional ? `Anulación pago adicional #${n.id}: ${n.empleado_nombre}` : `Anulación adelanto #${n.id}: ${n.empleado_nombre}`, Math.abs(Number(n.monto)), fechaArgentinaISO()]
      );
      movAnulId = mov.rows[0].id;
    }
    await client.query("UPDATE novedades_empleado SET estado='anulado', motivo_anulacion=$1, caja_movimiento_anulacion_id=$2 WHERE id=$3", [motivo, movAnulId, n.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "novedad_anular", "novedad", n.id, { motivo, tipo: n.tipo, cajaOrigen: n.caja_origen || null, cuentaId: n.cuenta_id || null });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    return responderErrorPago(res, e, "Error anulando la novedad", "anular novedad");
  } finally { if (client) client.release(); }
});

// --- Reporte de costo de personal ---
// Costo = bruto + no remunerativo + contribuciones de la liquidación + ADICIONALES fuera del recibo (hora_extra, bono,
// otro activos, por la fecha de la novedad). Banco / efectivo: desglose informativo de los pagos de sueldo.
app.get("/api/rrhh/reporte", soloSuperadmin, async (req, res) => {
  const { desde, hasta, local } = req.query;
  try {
    const params = [];
    let sql = `SELECT l.id, l.periodo, l.bruto, l.no_remunerativo, l.contribuciones, l.neto, e.id AS empleado_id, e.nombre AS empleado_nombre, e.local AS empleado_local
               FROM liquidaciones_sueldo l JOIN empleados e ON e.id = l.empleado_id WHERE 1=1`;
    if (esPeriodoYM(desde)) { params.push(desde); sql += ` AND l.periodo >= $${params.length}`; }
    if (esPeriodoYM(hasta)) { params.push(hasta); sql += ` AND l.periodo <= $${params.length}`; }
    if (local) { params.push(local); sql += ` AND e.local = $${params.length}`; }
    const { rows } = await pool.query(sql, params);
    const costoDe = (r) => Number(r.bruto) + Number(r.no_remunerativo) + Number(r.contribuciones);
    const nuevoEmp = (id, nombre, loc) => ({ empleado_id: id, empleado: nombre, local: loc, costo: 0, adicionales: 0, adelantos: 0, banco: 0, efectivo: 0 });
    let total = 0;
    const porMes = {}, porLocal = {}, porEmpleado = {}, netoMes = {};
    for (const r of rows) {
      const c = costoDe(r); total += c;
      porMes[r.periodo] = (porMes[r.periodo] || 0) + c;
      netoMes[r.periodo] = (netoMes[r.periodo] || 0) + Number(r.neto);
      const loc = r.empleado_local || "(sin local)";
      porLocal[loc] = (porLocal[loc] || 0) + c;
      if (!porEmpleado[r.empleado_id]) porEmpleado[r.empleado_id] = nuevoEmp(r.empleado_id, r.empleado_nombre, r.empleado_local);
      porEmpleado[r.empleado_id].costo += c;
    }
    // Adelantos y adicionales activos del período por empleado (por la fecha de la novedad).
    const paramsA = [];
    let sqlA = `SELECT n.empleado_id, n.tipo, n.fecha, n.monto, e.nombre AS empleado_nombre, e.local AS empleado_local
                FROM novedades_empleado n JOIN empleados e ON e.id = n.empleado_id
                WHERE n.tipo IN ('adelanto','hora_extra','bono','otro') AND n.estado='activo'`;
    if (esPeriodoYM(desde)) { paramsA.push(desde + "-01"); sqlA += ` AND n.fecha >= $${paramsA.length}`; }
    if (esPeriodoYM(hasta)) { paramsA.push(hasta + "-31"); sqlA += ` AND n.fecha <= $${paramsA.length}`; }
    if (local) { paramsA.push(local); sqlA += ` AND e.local = $${paramsA.length}`; }
    const nov = await pool.query(sqlA, paramsA);
    let totalAdelantos = 0, totalAdicionales = 0;
    for (const a of nov.rows) {
      const monto = Number(a.monto);
      if (!porEmpleado[a.empleado_id]) porEmpleado[a.empleado_id] = nuevoEmp(a.empleado_id, a.empleado_nombre, a.empleado_local);
      if (a.tipo === "adelanto") { totalAdelantos += monto; porEmpleado[a.empleado_id].adelantos += monto; continue; }
      // Adicional: suma al costo (total, mes de la novedad y local).
      totalAdicionales += monto; total += monto;
      porEmpleado[a.empleado_id].adicionales += monto;
      const mes = String(a.fecha).slice(0, 7), loc = a.empleado_local || "(sin local)";
      porMes[mes] = (porMes[mes] || 0) + monto;
      porLocal[loc] = (porLocal[loc] || 0) + monto;
    }
    // Pagado y pendiente por mes (sobre el neto de las liquidaciones del período) + desglose banco / efectivo
    // (informativo: el costo no cambia).
    const pagadoMes = {};
    let totalPagado = 0, totalBanco = 0, totalEfectivo = 0;
    if (rows.length > 0) {
      const liqDe = {}; for (const r of rows) liqDe[r.id] = r;
      const pg = await pool.query("SELECT liquidacion_id, monto, caja_origen, cuenta_id, medio_pago FROM pagos_sueldo WHERE liquidacion_id = ANY($1) AND estado='activo'", [rows.map(r => r.id)]);
      for (const p of pg.rows) {
        const l = liqDe[p.liquidacion_id], monto = Number(p.monto), forma = formaPagoSueldo(p);
        pagadoMes[l.periodo] = (pagadoMes[l.periodo] || 0) + monto;
        totalPagado += monto;
        porEmpleado[l.empleado_id][forma] += monto;
        if (forma === "banco") totalBanco += monto; else totalEfectivo += monto;
      }
    }
    const porMesPago = {};
    for (const mes of Object.keys(netoMes)) {
      const pagado = pagadoMes[mes] || 0;
      porMesPago[mes] = { neto: netoMes[mes], pagado, pendiente: netoMes[mes] - pagado };
    }
    const totalNeto = Object.values(netoMes).reduce((a, v) => a + v, 0);
    res.json({
      total, totalAdelantos, totalAdicionales, porMes, porLocal,
      porEmpleado: Object.values(porEmpleado).sort((x, y) => (y.costo + y.adicionales) - (x.costo + x.adicionales)),
      porMesPago, totalNeto, totalPagado, totalPendiente: totalNeto - totalPagado, totalBanco, totalEfectivo,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TESORERÍA — Entrega A (cuentas bancarias / billeteras, movimientos, conciliación) — SOLO superadmin ─
// Saldo según sistema = saldo_inicial + Σ ingresos − Σ egresos (activos, fecha >= fecha_saldo_inicial).
// Saldo conciliado = lo mismo, solo con los conciliados. Se permite saldo negativo (descubierto).
// fecha = la del banco (elegible). Las patas de CAJA de una transferencia van con fecha HOY, como el resto.
// Un movimiento conciliado no se edita ni se anula: primero se desconcilia. Los de pagos/sueldos/gastos
// (Entrega B) se crean y anulan desde su pago con registrarMovimientoCuenta / anularMovimientoPorOrigen.
const TIPOS_CUENTA_TESORERIA = ["banco", "billetera"];
const ORIGENES_TESORERIA = ["manual", "transferencia", "pago_factura", "pago_a_cuenta", "pago_sueldo", "adelanto", "adicional", "gasto_comun"];
const normTesoreria = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const limpiarTexto = (s) => String(s || "").replace(/\s+/g, " ").trim();
const montoTesoreria = (x) => { const n = Number(x); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null; };
// Error con status HTTP: los helpers lo tiran dentro de la transacción del que llama.
class ErrorTesoreria extends Error { constructor(status, mensaje) { super(mensaje); this.status = status; } }
const responderErrorTesoreria = (res, e, generico) => {
  if (e instanceof ErrorTesoreria) return res.status(e.status).json({ error: e.message });
  if (e && e.code === "23505") return res.status(409).json({ error: "Ya existe una cuenta con ese nombre." });
  console.error(`Tesorería: ${generico}:`, e && e.message);
  return res.status(500).json({ error: generico });
};
// Suma con signo de un movimiento (ingreso +, egreso −). En SQL y en JS.
const SQL_SIGNO_TES = "(CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE -m.monto END)";
const SQL_CUENTAS_TES = `
  SELECT c.id, c.nombre, c.tipo, c.saldo_inicial, c.fecha_saldo_inicial::text AS fecha_saldo_inicial, c.activa, c.notas, c.created_at,
    c.saldo_inicial + COALESCE(SUM(${SQL_SIGNO_TES}) FILTER (WHERE m.estado = 'activo' AND m.fecha >= c.fecha_saldo_inicial), 0) AS saldo_sistema,
    c.saldo_inicial + COALESCE(SUM(${SQL_SIGNO_TES}) FILTER (WHERE m.estado = 'activo' AND m.conciliado AND m.fecha >= c.fecha_saldo_inicial), 0) AS saldo_conciliado,
    COUNT(m.id) FILTER (WHERE m.estado = 'activo' AND NOT m.conciliado AND m.fecha >= c.fecha_saldo_inicial) AS sin_conciliar,
    COALESCE(SUM(${SQL_SIGNO_TES}) FILTER (WHERE m.estado = 'activo' AND NOT m.conciliado AND m.fecha >= c.fecha_saldo_inicial), 0) AS monto_sin_conciliar,
    COUNT(m.id) FILTER (WHERE m.estado = 'activo' AND m.conciliado) AS conciliados,
    COUNT(m.id) FILTER (WHERE m.estado = 'activo') AS movimientos_activos
  FROM cuentas_tesoreria c LEFT JOIN movimientos_tesoreria m ON m.cuenta_id = c.id`;
const cuentaTesDeFila = (r) => ({
  ...r, saldo_inicial: Number(r.saldo_inicial), saldo_sistema: Number(r.saldo_sistema), saldo_conciliado: Number(r.saldo_conciliado),
  sin_conciliar: Number(r.sin_conciliar), monto_sin_conciliar: Number(r.monto_sin_conciliar), conciliados: Number(r.conciliados),
  movimientos_activos: Number(r.movimientos_activos), descubierto: Number(r.saldo_sistema) < -0.005,
});
async function cuentaTesoreriaConSaldos(db, id) {
  const r = await db.query(`${SQL_CUENTAS_TES} WHERE c.id = $1 GROUP BY c.id`, [id]);
  return r.rows[0] ? cuentaTesDeFila(r.rows[0]) : null;
}

// HELPER (Entrega B): registra un movimiento en una cuenta DENTRO de la transacción del que llama (client con BEGIN).
// Valida cuenta activa (la bloquea FOR UPDATE para que no se desactive en el medio), fecha, tipo, monto y concepto.
// Tira ErrorTesoreria (status 400/404) si algo no va: el que llama hace ROLLBACK.
async function registrarMovimientoCuenta(client, { cuentaId, fecha, tipo, monto, concepto, origenTipo = "manual", origenId = null, usuario = null, transferenciaId = null, cajaMovimientoId = null }) {
  if (!ORIGENES_TESORERIA.includes(origenTipo)) throw new ErrorTesoreria(400, "Origen de movimiento inválido.");
  if (!["ingreso", "egreso"].includes(tipo)) throw new ErrorTesoreria(400, "Tipo de movimiento inválido (ingreso / egreso).");
  const m = montoTesoreria(monto);
  if (!m) throw new ErrorTesoreria(400, "El monto debe ser mayor a 0.");
  if (!esFechaISO(fecha)) throw new ErrorTesoreria(400, "Fecha inválida (formato YYYY-MM-DD).");
  const conc = limpiarTexto(concepto);
  if (!conc) throw new ErrorTesoreria(400, "El concepto es obligatorio.");
  const cta = await client.query("SELECT id, nombre, activa, fecha_saldo_inicial::text AS fecha_saldo_inicial FROM cuentas_tesoreria WHERE id = $1 FOR UPDATE", [cuentaId]);
  const c = cta.rows[0];
  if (!c) throw new ErrorTesoreria(404, "Cuenta no encontrada.");
  if (!c.activa) throw new ErrorTesoreria(400, `La cuenta ${c.nombre} está desactivada.`);
  if (fecha < c.fecha_saldo_inicial) throw new ErrorTesoreria(400, `La fecha es anterior al saldo inicial de ${c.nombre} (${c.fecha_saldo_inicial}).`);
  const r = await client.query(
    `INSERT INTO movimientos_tesoreria (cuenta_id, fecha, tipo, monto, concepto, origen_tipo, origen_id, transferencia_id, caja_movimiento_id, usuario)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [cuentaId, fecha, tipo, m, conc, origenTipo, origenId, transferenciaId, cajaMovimientoId, usuario]
  );
  return { id: r.rows[0].id, cuenta: c.nombre, monto: m };
}
// HELPER (Entrega B): anula los movimientos activos de un origen (p. ej. 'pago_sueldo', 42) DENTRO de la transacción
// del que llama. Si alguno está conciliado tira 409 (hay que desconciliarlo antes). Devuelve cuántos anuló.
// Manuales y transferencias NO pasan por acá: tienen sus propios endpoints.
async function anularMovimientoPorOrigen(client, origenTipo, origenId, motivo, usuario = null) {
  if (!ORIGENES_TESORERIA.includes(origenTipo) || ["manual", "transferencia"].includes(origenTipo)) throw new ErrorTesoreria(400, "Origen inválido para anular por origen.");
  const sel = await client.query(
    "SELECT id, conciliado FROM movimientos_tesoreria WHERE origen_tipo = $1 AND origen_id = $2 AND estado = 'activo' FOR UPDATE",
    [origenTipo, origenId]
  );
  if (sel.rows.some((x) => x.conciliado)) throw new ErrorTesoreria(409, "El movimiento en la cuenta está conciliado: desconciliá el movimiento en Tesorería primero.");
  if (sel.rows.length === 0) return 0;
  await client.query(
    "UPDATE movimientos_tesoreria SET estado = 'anulado', motivo_anulacion = $1, usuario_anula = $2, anulado_at = NOW() WHERE id = ANY($3::int[])",
    [limpiarTexto(motivo) || "Anulado desde su origen", usuario, sel.rows.map((x) => x.id)]
  );
  return sel.rows.length;
}

// --- Cuentas ---
// Para elegir la cuenta de origen de un pago (admin y superadmin): SOLO id, nombre y tipo de las activas, sin saldos.
app.get("/api/tesoreria/cuentas-activas", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("SELECT id, nombre, tipo FROM cuentas_tesoreria WHERE activa ORDER BY nombre");
    res.json(r.rows);
  } catch (e) { responderErrorTesoreria(res, e, "Error trayendo las cuentas"); }
});
app.get("/api/tesoreria/cuentas", soloSuperadmin, async (req, res) => {
  try {
    const r = await pool.query(`${SQL_CUENTAS_TES} ${req.query.incluirInactivas === "1" ? "" : "WHERE c.activa"} GROUP BY c.id ORDER BY c.activa DESC, c.nombre`);
    res.json(r.rows.map(cuentaTesDeFila));
  } catch (e) { responderErrorTesoreria(res, e, "Error trayendo las cuentas"); }
});
// Valida nombre/tipo/saldo inicial para alta y edición. Devuelve los valores limpios o tira ErrorTesoreria.
async function validarCuentaTesoreria(b, idActual = null) {
  const nombre = limpiarTexto(b.nombre);
  if (!nombre) throw new ErrorTesoreria(400, "El nombre es obligatorio.");
  if (nombre.length > 80) throw new ErrorTesoreria(400, "El nombre es demasiado largo (máximo 80).");
  const otras = await pool.query("SELECT id, nombre FROM cuentas_tesoreria WHERE id <> COALESCE($1, -1)", [idActual]);
  const igual = otras.rows.find((c) => normTesoreria(c.nombre) === normTesoreria(nombre));
  if (igual) throw new ErrorTesoreria(409, `Ya existe la cuenta "${igual.nombre}".`);
  return nombre;
}
app.post("/api/tesoreria/cuentas", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  try {
    const nombre = await validarCuentaTesoreria(b);
    if (!TIPOS_CUENTA_TESORERIA.includes(b.tipo)) throw new ErrorTesoreria(400, "Tipo de cuenta inválido (banco / billetera).");
    const saldo = Number(b.saldo_inicial || 0);
    if (!Number.isFinite(saldo)) throw new ErrorTesoreria(400, "Saldo inicial inválido.");
    if (!esFechaISO(b.fecha_saldo_inicial)) throw new ErrorTesoreria(400, "La fecha del saldo inicial es obligatoria (YYYY-MM-DD).");
    const r = await pool.query(
      "INSERT INTO cuentas_tesoreria (nombre, tipo, saldo_inicial, fecha_saldo_inicial, notas) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [nombre, b.tipo, Math.round(saldo * 100) / 100, b.fecha_saldo_inicial, limpiarTexto(b.notas) || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(quien, "tesoreria_cuenta_crear", "cuenta_tesoreria", r.rows[0].id, { nombre, tipo: b.tipo, saldo_inicial: saldo, fecha_saldo_inicial: b.fecha_saldo_inicial });
  } catch (e) { responderErrorTesoreria(res, e, "Error creando la cuenta"); }
});
// Edición: nombre y notas siempre; saldo inicial y su fecha solo si la cuenta no tiene movimientos conciliados.
app.patch("/api/tesoreria/cuentas/:id", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  let client;
  try {
    const nombre = await validarCuentaTesoreria(b, Number(req.params.id));
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query("SELECT id, nombre, saldo_inicial, fecha_saldo_inicial::text AS fecha_saldo_inicial FROM cuentas_tesoreria WHERE id = $1 FOR UPDATE", [req.params.id]);
    const c = sel.rows[0];
    if (!c) throw new ErrorTesoreria(404, "Cuenta no encontrada.");
    const saldo = b.saldo_inicial === undefined ? Number(c.saldo_inicial) : Number(b.saldo_inicial);
    const fechaSaldo = b.fecha_saldo_inicial === undefined ? c.fecha_saldo_inicial : b.fecha_saldo_inicial;
    if (!Number.isFinite(saldo)) throw new ErrorTesoreria(400, "Saldo inicial inválido.");
    if (!esFechaISO(fechaSaldo)) throw new ErrorTesoreria(400, "Fecha del saldo inicial inválida (YYYY-MM-DD).");
    const cambiaSaldo = Math.abs(saldo - Number(c.saldo_inicial)) > 0.004 || fechaSaldo !== c.fecha_saldo_inicial;
    if (cambiaSaldo) {
      const conc = await client.query("SELECT COUNT(*)::int AS n FROM movimientos_tesoreria WHERE cuenta_id = $1 AND conciliado", [c.id]);
      if (conc.rows[0].n > 0) throw new ErrorTesoreria(409, "La cuenta tiene movimientos conciliados: el saldo inicial y su fecha ya no se pueden cambiar.");
      const antes = await client.query("SELECT COUNT(*)::int AS n FROM movimientos_tesoreria WHERE cuenta_id = $1 AND estado = 'activo' AND fecha < $2", [c.id, fechaSaldo]);
      if (antes.rows[0].n > 0) throw new ErrorTesoreria(409, `Hay ${antes.rows[0].n} movimiento(s) anteriores a ${fechaSaldo}: quedarían fuera del saldo.`);
    }
    await client.query("UPDATE cuentas_tesoreria SET nombre = $1, notas = $2, saldo_inicial = $3, fecha_saldo_inicial = $4 WHERE id = $5",
      [nombre, limpiarTexto(b.notas) || null, Math.round(saldo * 100) / 100, fechaSaldo, c.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_cuenta_editar", "cuenta_tesoreria", c.id, { nombre_anterior: c.nombre, nombre, ...(cambiaSaldo ? { saldo_inicial: saldo, fecha_saldo_inicial: fechaSaldo } : {}) });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error editando la cuenta");
  } finally { if (client) client.release(); }
});
// Desactivar (no se borra): solo con saldo según sistema en 0.
app.post("/api/tesoreria/cuentas/:id/desactivar", soloSuperadmin, async (req, res) => {
  const quien = req.user?.nombre_completo || null;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const lock = await client.query("SELECT id FROM cuentas_tesoreria WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!lock.rows[0]) throw new ErrorTesoreria(404, "Cuenta no encontrada.");
    const c = await cuentaTesoreriaConSaldos(client, req.params.id);
    if (!c.activa) throw new ErrorTesoreria(409, "La cuenta ya está desactivada.");
    if (Math.abs(c.saldo_sistema) > 0.004) throw new ErrorTesoreria(409, `No se puede desactivar: el saldo según sistema es $${c.saldo_sistema.toFixed(2)} (tiene que ser 0).`);
    await client.query("UPDATE cuentas_tesoreria SET activa = false WHERE id = $1", [c.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_cuenta_desactivar", "cuenta_tesoreria", c.id, { nombre: c.nombre });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error desactivando la cuenta");
  } finally { if (client) client.release(); }
});
app.post("/api/tesoreria/cuentas/:id/activar", soloSuperadmin, async (req, res) => {
  const quien = req.user?.nombre_completo || null;
  try {
    const r = await pool.query("UPDATE cuentas_tesoreria SET activa = true WHERE id = $1 AND NOT activa RETURNING nombre", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Cuenta no encontrada o ya activa." });
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_cuenta_activar", "cuenta_tesoreria", req.params.id, { nombre: r.rows[0].nombre });
  } catch (e) { responderErrorTesoreria(res, e, "Error activando la cuenta"); }
});

// --- Movimientos de una cuenta (con saldo acumulado y la contraparte de las transferencias) ---
app.get("/api/tesoreria/cuentas/:id/movimientos", soloSuperadmin, async (req, res) => {
  const { desde, hasta, soloSinConciliar, incluirAnulados } = req.query;
  if ((desde && !esFechaISO(desde)) || (hasta && !esFechaISO(hasta))) return res.status(400).json({ error: "Fechas inválidas (YYYY-MM-DD)." });
  try {
    const cuenta = await cuentaTesoreriaConSaldos(pool, req.params.id);
    if (!cuenta) return res.status(404).json({ error: "Cuenta no encontrada." });
    const r = await pool.query(
      `SELECT m.id, m.cuenta_id, m.fecha::text AS fecha, m.tipo, m.monto, m.concepto, m.origen_tipo, m.origen_id, m.transferencia_id,
              m.conciliado, m.conciliado_at, m.conciliado_por, m.estado, m.motivo_anulacion, m.usuario, m.usuario_anula, m.anulado_at,
              m.caja_movimiento_id, m.created_at,
              COALESCE(oc.nombre, cm.local) AS contraparte, CASE WHEN oc.id IS NOT NULL THEN 'cuenta' WHEN cm.id IS NOT NULL THEN 'caja' END AS contraparte_tipo
       FROM movimientos_tesoreria m
       LEFT JOIN movimientos_tesoreria o ON o.transferencia_id = m.transferencia_id AND o.id <> m.id
       LEFT JOIN cuentas_tesoreria oc ON oc.id = o.cuenta_id
       LEFT JOIN caja_movimientos cm ON cm.id = m.caja_movimiento_id
       WHERE m.cuenta_id = $1 ORDER BY m.fecha ASC, m.id ASC`, [cuenta.id]);
    // Saldo acumulado sobre TODOS los activos desde el saldo inicial (no depende de los filtros).
    let acum = cuenta.saldo_inicial;
    const todos = r.rows.map((m) => {
      const monto = Number(m.monto), suma = m.estado === "activo" && m.fecha >= cuenta.fecha_saldo_inicial;
      if (suma) acum += m.tipo === "ingreso" ? monto : -monto;
      return { ...m, monto, saldo_acumulado: suma ? Math.round(acum * 100) / 100 : null, editable: m.origen_tipo === "manual" && m.estado === "activo" && !m.conciliado };
    });
    const movimientos = todos.filter((m) => (incluirAnulados === "1" || m.estado === "activo")
      && (soloSinConciliar !== "1" || (!m.conciliado && m.estado === "activo"))
      && (!desde || m.fecha >= desde) && (!hasta || m.fecha <= hasta)).reverse();   // más nuevos arriba
    res.json({ cuenta, movimientos });
  } catch (e) { responderErrorTesoreria(res, e, "Error trayendo los movimientos"); }
});

// --- Movimientos manuales (cobros, depósitos, liquidaciones de MP/TN, comisiones, impuestos del banco) ---
app.post("/api/tesoreria/movimientos", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const mov = await registrarMovimientoCuenta(client, { cuentaId: b.cuenta_id, fecha: b.fecha, tipo: b.tipo, monto: b.monto, concepto: b.concepto, origenTipo: "manual", usuario: quien });
    await client.query("COMMIT");
    res.json({ ok: true, id: mov.id });
    registrarAuditoria(quien, "tesoreria_movimiento_crear", "movimiento_tesoreria", mov.id, { cuenta: mov.cuenta, tipo: b.tipo, monto: mov.monto, fecha: b.fecha });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error registrando el movimiento");
  } finally { if (client) client.release(); }
});
// Lock + chequeos comunes para editar / anular un movimiento manual.
async function movimientoManualEditable(client, id, accion) {
  const sel = await client.query(
    `SELECT m.id, m.cuenta_id, m.fecha::text AS fecha, m.tipo, m.monto, m.concepto, m.origen_tipo, m.estado, m.conciliado,
            c.nombre AS cuenta, c.fecha_saldo_inicial::text AS fecha_saldo_inicial
     FROM movimientos_tesoreria m JOIN cuentas_tesoreria c ON c.id = m.cuenta_id WHERE m.id = $1 FOR UPDATE OF m`, [id]);
  const m = sel.rows[0];
  if (!m) throw new ErrorTesoreria(404, "Movimiento no encontrado.");
  if (m.estado !== "activo") throw new ErrorTesoreria(409, "El movimiento está anulado.");
  if (m.conciliado) throw new ErrorTesoreria(409, `El movimiento está conciliado: desconcilialo para ${accion}lo.`);
  if (m.origen_tipo === "transferencia") throw new ErrorTesoreria(409, `Es una pata de una transferencia: ${accion === "anular" ? "anulá la transferencia completa" : "anulala y cargala de nuevo"}.`);
  if (m.origen_tipo !== "manual") throw new ErrorTesoreria(409, `Este movimiento viene de un ${m.origen_tipo.replace(/_/g, " ")}: se ${accion === "anular" ? "anula" : "corrige"} desde ese pago.`);
  return m;
}
app.patch("/api/tesoreria/movimientos/:id", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const m = await movimientoManualEditable(client, req.params.id, "editar");
    const tipo = b.tipo ?? m.tipo, fecha = b.fecha ?? m.fecha, concepto = limpiarTexto(b.concepto ?? m.concepto), monto = montoTesoreria(b.monto ?? m.monto);
    if (!["ingreso", "egreso"].includes(tipo)) throw new ErrorTesoreria(400, "Tipo de movimiento inválido (ingreso / egreso).");
    if (!monto) throw new ErrorTesoreria(400, "El monto debe ser mayor a 0.");
    if (!esFechaISO(fecha)) throw new ErrorTesoreria(400, "Fecha inválida (formato YYYY-MM-DD).");
    if (fecha < m.fecha_saldo_inicial) throw new ErrorTesoreria(400, `La fecha es anterior al saldo inicial de ${m.cuenta} (${m.fecha_saldo_inicial}).`);
    if (!concepto) throw new ErrorTesoreria(400, "El concepto es obligatorio.");
    await client.query("UPDATE movimientos_tesoreria SET tipo = $1, fecha = $2, monto = $3, concepto = $4 WHERE id = $5", [tipo, fecha, monto, concepto, m.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_movimiento_editar", "movimiento_tesoreria", m.id, {
      cuenta: m.cuenta, antes: { tipo: m.tipo, fecha: m.fecha, monto: Number(m.monto), concepto: m.concepto }, despues: { tipo, fecha, monto, concepto },
    });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error editando el movimiento");
  } finally { if (client) client.release(); }
});
app.post("/api/tesoreria/movimientos/:id/anular", soloSuperadmin, async (req, res) => {
  const motivo = limpiarTexto((req.body || {}).motivo);
  const quien = req.user?.nombre_completo || null;
  if (!motivo) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const m = await movimientoManualEditable(client, req.params.id, "anular");
    await client.query("UPDATE movimientos_tesoreria SET estado = 'anulado', motivo_anulacion = $1, usuario_anula = $2, anulado_at = NOW() WHERE id = $3", [motivo, quien, m.id]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_movimiento_anular", "movimiento_tesoreria", m.id, { cuenta: m.cuenta, tipo: m.tipo, monto: Number(m.monto), motivo });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error anulando el movimiento");
  } finally { if (client) client.release(); }
});

// --- Transferencias (atómicas) ---
// modo 'cuentas': egreso en cuenta origen + ingreso en cuenta destino.
// modo 'deposito': salida de una caja (hoy) + ingreso en la cuenta (fecha elegida).
// modo 'retiro': egreso de la cuenta (fecha elegida) + entrada en una caja (hoy).
// Las dos patas comparten transferencia_id; los conceptos de caja llevan "#<transferencia_id>" (no editables en Caja).
app.post("/api/tesoreria/transferencias", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  const monto = montoTesoreria(b.monto);
  const nota = limpiarTexto(b.concepto);
  if (!["cuentas", "deposito", "retiro"].includes(b.modo)) return res.status(400).json({ error: "Tipo de transferencia inválido." });
  if (!monto) return res.status(400).json({ error: "El monto debe ser mayor a 0." });
  if (!esFechaISO(b.fecha)) return res.status(400).json({ error: "Fecha inválida (formato YYYY-MM-DD)." });
  if (b.modo !== "cuentas") {
    if (!CAJAS_TRANSFERIBLES.includes(b.caja)) return res.status(400).json({ error: "Caja inválida." });
    if (bloqueaCajaAdmin(req, res, b.caja)) return;   // Administración solo superadmin
  }
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const tid = Number((await client.query("SELECT nextval('transferencias_tesoreria_seq') AS id")).rows[0].id);
    const nombreDe = async (id) => { const r = await client.query("SELECT nombre FROM cuentas_tesoreria WHERE id = $1", [id]); if (!r.rows[0]) throw new ErrorTesoreria(404, "Cuenta no encontrada."); return r.rows[0].nombre; };
    const comun = { fecha: b.fecha, monto, origenTipo: "transferencia", usuario: quien, transferenciaId: tid };
    const conNota = (t) => (nota ? `${t}: ${nota}` : t);
    const detalle = { modo: b.modo, monto, fecha: b.fecha, transferencia_id: tid };
    if (b.modo === "cuentas") {
      const o = Number(b.cuenta_origen_id), d = Number(b.cuenta_destino_id);
      if (!o || !d) throw new ErrorTesoreria(400, "Elegí la cuenta de origen y la de destino.");
      if (o === d) throw new ErrorTesoreria(400, "El origen y el destino no pueden ser la misma cuenta.");
      // Lock en orden de id (evita deadlocks entre dos transferencias cruzadas).
      await client.query("SELECT id FROM cuentas_tesoreria WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [[o, d]]);
      const nO = await nombreDe(o), nD = await nombreDe(d);
      await registrarMovimientoCuenta(client, { ...comun, cuentaId: o, tipo: "egreso", concepto: conNota(`Transferencia a ${nD}`) });
      await registrarMovimientoCuenta(client, { ...comun, cuentaId: d, tipo: "ingreso", concepto: conNota(`Transferencia desde ${nO}`) });
      Object.assign(detalle, { origen: nO, destino: nD });
    } else {
      const cId = Number(b.cuenta_id);
      if (!cId) throw new ErrorTesoreria(400, "Elegí la cuenta.");
      const nC = await nombreDe(cId);
      const deposito = b.modo === "deposito";
      const mov = await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [b.caja, deposito ? "salida" : "entrada", conNota(`${deposito ? "Depósito a cuenta" : "Retiro de cuenta"} #${tid}: ${nC}`), deposito ? -monto : monto, fechaArgentinaISO()]   // HOY: cae en el día abierto
      );
      await registrarMovimientoCuenta(client, {
        ...comun, cuentaId: cId, tipo: deposito ? "ingreso" : "egreso", cajaMovimientoId: mov.rows[0].id,
        concepto: conNota(deposito ? `Depósito desde caja ${b.caja}` : `Retiro a caja ${b.caja}`),
      });
      Object.assign(detalle, { cuenta: nC, caja: b.caja });
    }
    await client.query("COMMIT");
    res.json({ ok: true, transferencia_id: tid });
    registrarAuditoria(quien, "tesoreria_transferencia_crear", "transferencia_tesoreria", tid, detalle);
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error registrando la transferencia");
  } finally { if (client) client.release(); }
});
// Anula las dos patas (y repone la caja si había) en la misma transacción. No si alguna está conciliada.
app.post("/api/tesoreria/transferencias/:tid/anular", soloSuperadmin, async (req, res) => {
  const motivo = limpiarTexto((req.body || {}).motivo);
  const quien = req.user?.nombre_completo || null;
  if (!motivo) return res.status(400).json({ error: "El motivo de anulación es obligatorio." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sel = await client.query(
      `SELECT m.id, m.tipo, m.monto, m.estado, m.conciliado, m.caja_movimiento_id, c.nombre AS cuenta
       FROM movimientos_tesoreria m JOIN cuentas_tesoreria c ON c.id = m.cuenta_id
       WHERE m.transferencia_id = $1 ORDER BY m.id FOR UPDATE OF m`, [req.params.tid]);
    const patas = sel.rows;
    if (patas.length === 0) throw new ErrorTesoreria(404, "Transferencia no encontrada.");
    if (patas.some((p) => p.estado !== "activo")) throw new ErrorTesoreria(409, "La transferencia ya está anulada.");
    if (patas.some((p) => p.conciliado)) throw new ErrorTesoreria(409, "Una de las patas está conciliada: desconciliala antes de anular.");
    for (const p of patas.filter((x) => x.caja_movimiento_id)) {
      const cm = (await client.query("SELECT id, local, tipo FROM caja_movimientos WHERE id = $1", [p.caja_movimiento_id])).rows[0];
      if (!cm) continue;
      if (bloqueaCajaAdmin(req, res, cm.local)) { await client.query("ROLLBACK"); return; }
      const fueDeposito = cm.tipo === "salida", m = Math.abs(Number(p.monto));
      await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)",
        [cm.local, fueDeposito ? "entrada" : "salida", `Anulación ${fueDeposito ? "depósito a cuenta" : "retiro de cuenta"} #${req.params.tid}: ${p.cuenta}`, fueDeposito ? m : -m, fechaArgentinaISO()]
      );
    }
    await client.query("UPDATE movimientos_tesoreria SET estado = 'anulado', motivo_anulacion = $1, usuario_anula = $2, anulado_at = NOW() WHERE transferencia_id = $3",
      [motivo, quien, req.params.tid]);
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(quien, "tesoreria_transferencia_anular", "transferencia_tesoreria", req.params.tid, { motivo, patas: patas.map((p) => ({ id: p.id, cuenta: p.cuenta, tipo: p.tipo, monto: Number(p.monto) })) });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    responderErrorTesoreria(res, e, "Error anulando la transferencia");
  } finally { if (client) client.release(); }
});

// --- Conciliación: marcar / desmarcar uno o varios (solo activos) ---
app.post("/api/tesoreria/conciliar", soloSuperadmin, async (req, res) => {
  const b = req.body || {};
  const quien = req.user?.nombre_completo || null;
  const ids = Array.isArray(b.ids) ? [...new Set(b.ids.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : [];
  if (ids.length === 0) return res.status(400).json({ error: "Elegí al menos un movimiento." });
  if (typeof b.conciliado !== "boolean") return res.status(400).json({ error: "Falta indicar si se concilia o se desconcilia." });
  try {
    const r = await pool.query(
      `UPDATE movimientos_tesoreria SET conciliado = $1, conciliado_at = CASE WHEN $1 THEN NOW() END, conciliado_por = CASE WHEN $1 THEN $2 END
       WHERE id = ANY($3::int[]) AND estado = 'activo' AND conciliado <> $1 RETURNING id`,
      [b.conciliado, quien, ids]
    );
    res.json({ ok: true, actualizados: r.rows.length });
    if (r.rows.length) registrarAuditoria(quien, b.conciliado ? "tesoreria_conciliar" : "tesoreria_desconciliar", "movimiento_tesoreria", r.rows.map((x) => x.id).join(","), { cantidad: r.rows.length });
  } catch (e) { responderErrorTesoreria(res, e, "Error actualizando la conciliación"); }
});

// ─── STOCK DE INSUMOS — Fase 1 ─────────────────────────────────────────
// Módulo NUEVO, separado del tablero de cocina (stock_lotes / /api/stock). Namespaceado en /api/insumos
// para no colisionar con el GET /api/stock existente. Stock actual = Σ movimientos (con signo) por insumo+local.
// Permisos: ver = gestión (admin/superadmin/encargado/solo_lectura); cargar = admin/superadmin/encargado;
// maestro (ABM) = admin/superadmin (requireAdmin).
const INSUMO_LOCALES = ["A. Thomas", "French"];
const stockVer = [requireAuth, requireRole("admin", "superadmin", "encargado", "solo_lectura")];
const stockCarga = [requireAuth, requireRole("admin", "superadmin", "encargado")];
const numOrNull = (x) => { if (x === "" || x === null || x === undefined) return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

// --- Maestro de insumos ---
app.get("/api/insumos", stockVer, async (req, res) => {
  const { categoria, q, incluirInactivos } = req.query;
  try {
    const params = [];
    let sql = "SELECT * FROM insumos WHERE 1=1";
    if (incluirInactivos !== "1") sql += " AND activo = true";
    if (categoria) { params.push(categoria); sql += ` AND categoria = $${params.length}`; }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); sql += ` AND (lower(nombre) LIKE $${params.length} OR CAST(codigo AS TEXT) LIKE $${params.length})`; }
    sql += " ORDER BY categoria NULLS LAST, nombre ASC";
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/insumos", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (!["g", "unidad"].includes(b.unidad)) return res.status(400).json({ error: "Unidad inválida (g o unidad)." });
  try {
    const r = await pool.query(
      `INSERT INTO insumos (codigo, nombre, categoria, unidad, peso_unidad_g, precio_sin_iva, precio_con_iva, stock_minimo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [numOrNull(b.codigo), String(b.nombre).trim(), b.categoria || null, b.unidad, numOrNull(b.peso_unidad_g), numOrNull(b.precio_sin_iva), numOrNull(b.precio_con_iva), numOrNull(b.stock_minimo) || 0]
    );
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(b.usuario, "insumo_crear", "insumo", r.rows[0].id, { nombre: String(b.nombre).trim() });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Ya existe un insumo con el código ${b.codigo}.` });
    res.status(500).json({ error: err.message });
  }
});
app.patch("/api/insumos/:id", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (b.nombre !== undefined && !String(b.nombre).trim()) return res.status(400).json({ error: "El nombre no puede quedar vacío." });
  if (b.unidad !== undefined && !["g", "unidad"].includes(b.unidad)) return res.status(400).json({ error: "Unidad inválida (g o unidad)." });
  const numFields = ["codigo", "peso_unidad_g", "precio_sin_iva", "precio_con_iva", "stock_minimo"];
  const campos = ["codigo", "nombre", "categoria", "unidad", "peso_unidad_g", "precio_sin_iva", "precio_con_iva", "stock_minimo", "activo"];
  const sets = [], vals = [];
  for (const c of campos) if (b[c] !== undefined) {
    let v = b[c];
    if (c === "nombre") v = String(b[c]).trim();
    else if (numFields.includes(c)) v = numOrNull(b[c]);
    vals.push(v); sets.push(`${c} = $${vals.length}`);
  }
  if (sets.length === 0) return res.status(400).json({ error: "Nada para actualizar." });
  vals.push(req.params.id);
  try {
    const r = await pool.query(`UPDATE insumos SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING nombre`, vals);
    if (r.rows.length === 0) return res.status(404).json({ error: "Insumo no encontrado." });
    res.json({ ok: true });
    registrarAuditoria(b.usuario, "insumo_editar", "insumo", req.params.id, { nombre: r.rows[0].nombre });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: `Ya existe un insumo con el código ${b.codigo}.` });
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/insumos/:id/baja", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("UPDATE insumos SET activo = false WHERE id = $1 RETURNING nombre", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Insumo no encontrado." });
    res.json({ ok: true });
    registrarAuditoria(req.body?.usuario, "insumo_baja", "insumo", req.params.id, { nombre: r.rows[0].nombre });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Stock actual (Σ movimientos por insumo + local) ---
app.get("/api/insumos/stock", stockVer, async (req, res) => {
  const { local, categoria, q } = req.query;
  try {
    const params = [];
    let sql = "SELECT * FROM insumos i WHERE i.activo = true";
    if (categoria) { params.push(categoria); sql += ` AND i.categoria = $${params.length}`; }
    if (q) { params.push(`%${String(q).toLowerCase()}%`); sql += ` AND lower(i.nombre) LIKE $${params.length}`; }
    sql += " ORDER BY i.categoria NULLS LAST, i.nombre ASC";
    const ins = await pool.query(sql, params);
    const mov = await pool.query("SELECT insumo_id, local, COALESCE(SUM(cantidad),0) AS total FROM insumos_movimientos GROUP BY insumo_id, local");
    const byKey = {};
    for (const m of mov.rows) byKey[`${m.insumo_id}|${m.local}`] = Number(m.total);
    const filas = ins.rows.map(i => {
      const porLocal = {}; let total = 0;
      for (const L of INSUMO_LOCALES) { const v = byKey[`${i.id}|${L}`] || 0; porLocal[L] = v; total += v; }
      const relevante = local ? (porLocal[local] || 0) : total;   // el mínimo se evalúa sobre el local filtrado, o el total
      return { ...i, porLocal, total, bajo_minimo: Number(relevante) < Number(i.stock_minimo) };
    });
    res.json(filas);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Ingreso de mercadería (positivo) ---
app.post("/api/insumos/ingreso", stockCarga, async (req, res) => {
  const b = req.body || {};
  const insId = Number(b.insumo_id);
  if (!insId) return res.status(400).json({ error: "Falta el insumo." });
  if (!INSUMO_LOCALES.includes(b.local)) return res.status(400).json({ error: "Local inválido." });
  const cant = Number(b.cantidad);
  if (!Number.isFinite(cant) || cant <= 0) return res.status(400).json({ error: "La cantidad debe ser mayor a 0." });
  if (!esFechaISO(b.fecha)) return res.status(400).json({ error: "Fecha inválida (YYYY-MM-DD)." });
  if (!["kg", "g", "unidad"].includes(b.unidad_ingreso)) return res.status(400).json({ error: "Unidad de ingreso inválida." });
  try {
    const ins = await pool.query("SELECT unidad FROM insumos WHERE id = $1 AND activo = true", [insId]);
    if (ins.rows.length === 0) return res.status(400).json({ error: "Insumo inválido." });
    const base = ins.rows[0].unidad;   // 'g' | 'unidad'
    let cantBase;
    if (base === "g") {
      if (b.unidad_ingreso === "kg") cantBase = cant * 1000;
      else if (b.unidad_ingreso === "g") cantBase = cant;
      else return res.status(400).json({ error: "Ese insumo se controla en gramos: ingresá kg o g." });
    } else {
      if (b.unidad_ingreso === "unidad") cantBase = cant;
      else return res.status(400).json({ error: "Ese insumo se controla por unidad." });
    }
    const r = await pool.query(
      "INSERT INTO insumos_movimientos (insumo_id, local, tipo, cantidad, fecha, nota, usuario) VALUES ($1,$2,'ingreso',$3,$4,$5,$6) RETURNING id",
      [insId, b.local, cantBase, b.fecha, b.nota || null, b.usuario || null]
    );
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(b.usuario, "insumo_ingreso", "insumo", insId, { local: b.local, cantidadBase: cantBase });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Recuento (ajuste por diferencia contra el stock del sistema) ---
app.post("/api/insumos/recuento", stockCarga, async (req, res) => {
  const b = req.body || {};
  if (!INSUMO_LOCALES.includes(b.local)) return res.status(400).json({ error: "Local inválido." });
  if (!esFechaISO(b.fecha)) return res.status(400).json({ error: "Fecha inválida (YYYY-MM-DD)." });
  if (!Array.isArray(b.items) || b.items.length === 0) return res.status(400).json({ error: "No hay ítems para el recuento." });
  const ids = b.items.map(it => Number(it.insumo_id)).filter(Boolean);
  if (ids.length === 0) return res.status(400).json({ error: "No hay ítems válidos." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const insR = await client.query("SELECT id, unidad FROM insumos WHERE id = ANY($1)", [ids]);
    const uni = {}; for (const r of insR.rows) uni[r.id] = r.unidad;
    const stR = await client.query("SELECT insumo_id, COALESCE(SUM(cantidad),0) AS total FROM insumos_movimientos WHERE local = $1 AND insumo_id = ANY($2) GROUP BY insumo_id", [b.local, ids]);
    const cur = {}; for (const r of stR.rows) cur[r.insumo_id] = Number(r.total);
    const resumen = [];
    for (const it of b.items) {
      const id = Number(it.insumo_id);
      if (!id || !uni[id]) continue;
      const contadoRaw = Number(it.contado);
      if (!Number.isFinite(contadoRaw) || contadoRaw < 0) continue;
      const contadoBase = uni[id] === "g" ? contadoRaw * 1000 : contadoRaw;   // el front manda kg para 'g'
      const actual = cur[id] || 0;
      const diff = contadoBase - actual;
      if (Math.abs(diff) < 0.0001) continue;   // sin cambio → no genera movimiento
      await client.query(
        "INSERT INTO insumos_movimientos (insumo_id, local, tipo, cantidad, fecha, nota, usuario) VALUES ($1,$2,'ajuste',$3,$4,$5,$6)",
        [id, b.local, diff, b.fecha, `Recuento ${b.fecha}`, b.usuario || null]
      );
      resumen.push({ insumo_id: id, actual, contado: contadoBase, diferencia: diff });
    }
    await client.query("COMMIT");
    res.json({ ok: true, ajustes: resumen.length, resumen });
    registrarAuditoria(b.usuario, "insumo_recuento", "local", b.local, { fecha: b.fecha, ajustes: resumen.length });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error POST /api/insumos/recuento:", e.message);
    return res.status(500).json({ error: "Error registrando el recuento" });
  } finally { if (client) client.release(); }
});

// --- Historial de movimientos ---
app.get("/api/insumos/movimientos", stockVer, async (req, res) => {
  const { insumo_id, local, desde, hasta } = req.query;
  try {
    const params = [];
    let sql = "SELECT m.*, i.nombre AS insumo_nombre, i.unidad FROM insumos_movimientos m JOIN insumos i ON i.id = m.insumo_id WHERE 1=1";
    if (insumo_id) { params.push(insumo_id); sql += ` AND m.insumo_id = $${params.length}`; }
    if (local) { params.push(local); sql += ` AND m.local = $${params.length}`; }
    if (desde) { params.push(desde); sql += ` AND m.fecha >= $${params.length}`; }
    if (hasta) { params.push(hasta); sql += ` AND m.fecha <= $${params.length}`; }
    sql += " ORDER BY m.fecha DESC, m.id DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── RECETAS (Fase 2a) — módulos anidados, editor, importación, necesidades ─
// SIN descuento automático de stock (Fase 2b). Ver = gestión; escribir = admin/superadmin.
async function cargarRecetasIndex(exec = pool) {
  const recs = await exec.query("SELECT * FROM recetas");
  const lineas = await exec.query("SELECT * FROM receta_lineas ORDER BY receta_id, orden, id");
  const prods = await exec.query("SELECT * FROM receta_productos ORDER BY id");
  const byId = {};
  for (const r of recs.rows) byId[r.id] = { ...r, lineas: [], productos: [] };
  for (const l of lineas.rows) if (byId[l.receta_id]) byId[l.receta_id].lineas.push(l);
  for (const p of prods.rows) if (byId[p.receta_id]) byId[p.receta_id].productos.push(p);
  return byId;
}
async function cargarInsumosIndex(exec = pool) {
  const r = await exec.query("SELECT * FROM insumos");
  const byId = {}; for (const i of r.rows) byId[i.id] = i;
  return byId;
}
// Explosión recursiva de una receta (por 1 unidad). Devuelve base por insumo (g o unidades), costo y avisos.
function explotarReceta(recetaId, recetasById, insumosById, depth = 0, seen = new Set()) {
  const out = { insumos: {}, costo: 0, avisos: [] };
  const receta = recetasById[recetaId];
  if (!receta) { out.avisos.push({ tipo: "receta_faltante", detalle: `Receta #${recetaId} no encontrada` }); return out; }
  if (depth > 5 || seen.has(recetaId)) { out.avisos.push({ tipo: "ciclo", detalle: `Ciclo o profundidad máxima en "${receta.nombre}"` }); return out; }
  const seen2 = new Set(seen); seen2.add(recetaId);
  for (const l of receta.lineas) {
    const cant = Number(l.cantidad) || 0;
    if (l.subreceta_id) {
      const sub = explotarReceta(l.subreceta_id, recetasById, insumosById, depth + 1, seen2);
      for (const [iid, g] of Object.entries(sub.insumos)) out.insumos[iid] = (out.insumos[iid] || 0) + g * cant;
      out.costo += sub.costo * cant;
      for (const a of sub.avisos) out.avisos.push(a);
      continue;
    }
    const ins = insumosById[l.insumo_id];
    if (!ins) { out.avisos.push({ tipo: "insumo_faltante", detalle: `Insumo #${l.insumo_id} en "${receta.nombre}"` }); continue; }
    const desp = 1 + (Number(l.desperdicio_pct) || 0) / 100;
    if (ins.unidad === "g") {
      let gramos;
      if (l.modo === "unidades") {
        const peso = l.peso_g != null ? Number(l.peso_g) : (ins.peso_unidad_g != null ? Number(ins.peso_unidad_g) : null);
        if (peso == null) { out.avisos.push({ tipo: "falta_peso", insumo: ins.nombre, detalle: `Falta peso por unidad de "${ins.nombre}" (en "${receta.nombre}")` }); continue; }
        gramos = cant * peso * desp;
      } else {
        gramos = cant * desp;
      }
      out.insumos[l.insumo_id] = (out.insumos[l.insumo_id] || 0) + gramos;
      if (ins.precio_sin_iva == null) out.avisos.push({ tipo: "sin_precio", insumo: ins.nombre, detalle: `Sin precio: "${ins.nombre}"` });
      else out.costo += (gramos / 1000) * Number(ins.precio_sin_iva);
    } else {
      const unidades = cant * desp;
      out.insumos[l.insumo_id] = (out.insumos[l.insumo_id] || 0) + unidades;
      if (ins.precio_sin_iva == null) out.avisos.push({ tipo: "sin_precio", insumo: ins.nombre, detalle: `Sin precio: "${ins.nombre}"` });
      else out.costo += unidades * Number(ins.precio_sin_iva);
    }
  }
  return out;
}
async function insertarLineasReceta(client, recetaId, lineas) {
  let orden = 0;
  for (const l of (lineas || [])) {
    const tieneIns = l.insumo_id != null && l.insumo_id !== "";
    const tieneSub = l.subreceta_id != null && l.subreceta_id !== "";
    if (tieneIns === tieneSub) throw { _http: 400, msg: "Cada línea debe tener un insumo O un módulo (no ambos)." };
    const cant = Number(l.cantidad);
    if (!(cant > 0)) throw { _http: 400, msg: "La cantidad de cada línea debe ser mayor a 0." };
    await client.query(
      "INSERT INTO receta_lineas (receta_id, orden, insumo_id, subreceta_id, modo, cantidad, peso_g, desperdicio_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [recetaId, orden++, tieneIns ? Number(l.insumo_id) : null, tieneSub ? Number(l.subreceta_id) : null,
       l.modo === "gramos" ? "gramos" : "unidades", cant,
       (l.peso_g === "" || l.peso_g == null) ? null : Number(l.peso_g),
       (l.desperdicio_pct == null || l.desperdicio_pct === "") ? 8 : Number(l.desperdicio_pct)]
    );
  }
}

// Importación inicial desde recetas_seed.json (idempotente por nombre).
app.post("/api/recetas/importar-inicial", requireAdmin, async (req, res) => {
  let seed;
  try { seed = requireCJS("./recetas_seed.json"); }
  catch (e) { return res.status(500).json({ error: "No se pudo leer recetas_seed.json" }); }
  const resumen = { modulos_creados: 0, recetas_creadas: 0, salteadas: 0, vinculadas: 0, errores: [] };
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const insR = await client.query("SELECT id, codigo FROM insumos WHERE codigo IS NOT NULL");
    const insByCodigo = {}; for (const i of insR.rows) insByCodigo[i.codigo] = i.id;
    const exR = await client.query("SELECT id, nombre FROM recetas");
    const recByNombre = {}; for (const r of exR.rows) recByNombre[r.nombre.toLowerCase()] = r.id;

    const crearReceta = async (nombre, tipo) => {
      const r = await client.query("INSERT INTO recetas (nombre, tipo) VALUES ($1,$2) RETURNING id", [nombre, tipo]);
      recByNombre[nombre.toLowerCase()] = r.rows[0].id; return r.rows[0].id;
    };
    const insertarLineasSeed = async (recetaId, lineas, nombreReceta, ordenInicial = 0) => {
      let orden = ordenInicial;
      for (const ln of (lineas || [])) {
        const iid = insByCodigo[ln.codigo];
        if (!iid) { resumen.errores.push(`Código ${ln.codigo} (en "${nombreReceta}") no existe en insumos`); continue; }
        await client.query(
          "INSERT INTO receta_lineas (receta_id, orden, insumo_id, modo, cantidad, peso_g, desperdicio_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [recetaId, orden++, iid, ln.modo === "gramos" ? "gramos" : "unidades", ln.cantidad, ln.peso_g ?? null, ln.desperdicio_pct ?? 8]
        );
      }
      return orden;
    };

    for (const m of (seed.modulos || [])) {
      if (recByNombre[m.nombre.toLowerCase()]) { resumen.salteadas++; continue; }
      const id = await crearReceta(m.nombre, "modulo");
      await insertarLineasSeed(id, m.lineas, m.nombre);
      resumen.modulos_creados++;
    }
    for (const rc of (seed.recetas || [])) {
      if (recByNombre[rc.nombre.toLowerCase()]) { resumen.salteadas++; continue; }
      const id = await crearReceta(rc.nombre, "producto");
      let orden = await insertarLineasSeed(id, rc.lineas, rc.nombre);
      for (const mod of (rc.modulos || [])) {
        const subId = recByNombre[mod.modulo.toLowerCase()];
        if (!subId) { resumen.errores.push(`Módulo "${mod.modulo}" (en "${rc.nombre}") no existe`); continue; }
        await client.query(
          "INSERT INTO receta_lineas (receta_id, orden, subreceta_id, modo, cantidad, desperdicio_pct) VALUES ($1,$2,$3,'unidades',$4,0)",
          [id, orden++, subId, mod.cantidad]
        );
      }
      resumen.recetas_creadas++;
      const clave = claveProducto(normalizarProducto(rc.nombre));
      const dup = await client.query("SELECT id FROM receta_productos WHERE producto_clave = $1", [clave]);
      if (dup.rows.length === 0) {
        await client.query("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3)", [id, rc.nombre, clave]);
        resumen.vinculadas++;
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, resumen });
    registrarAuditoria(req.body?.usuario, "recetas_importar", "recetas", 0, { modulos: resumen.modulos_creados, recetas: resumen.recetas_creadas, salteadas: resumen.salteadas });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error importar recetas:", e.message);
    res.status(500).json({ error: "Error importando recetas: " + e.message });
  } finally { if (client) client.release(); }
});

// Importación de combos (recetas hechas de otras recetas) desde combos_seed.json (idempotente por nombre).
app.post("/api/recetas/importar-combos", requireAdmin, async (req, res) => {
  let seed;
  try { seed = requireCJS("./combos_seed.json"); }
  catch (e) { return res.status(500).json({ error: "No se pudo leer combos_seed.json" }); }
  const resumen = { creados: 0, salteados: 0, pendientes: [] };
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const insR = await client.query("SELECT id, codigo FROM insumos WHERE codigo IS NOT NULL");
    const insByCodigo = {}; for (const i of insR.rows) insByCodigo[i.codigo] = i.id;
    const recR = await client.query("SELECT id, nombre FROM recetas");
    const recByNombre = {}; for (const r of recR.rows) recByNombre[r.nombre.toLowerCase()] = r.id;

    for (const combo of (seed.combos || [])) {
      if (recByNombre[combo.nombre.toLowerCase()]) { resumen.salteados++; continue; }
      // Resolver componentes; si falta alguno → pendiente, no se crea.
      const resueltos = [];
      const falta = [];
      for (const comp of (combo.componentes || [])) {
        if (comp.receta_faltante) { falta.push(comp.receta_faltante); continue; }
        if (comp.receta) {
          const rid = recByNombre[String(comp.receta).toLowerCase()];
          if (!rid) { falta.push(comp.receta); continue; }
          resueltos.push({ subreceta_id: rid, cantidad: comp.cantidad });
          continue;
        }
        if (comp.codigo != null) {
          const iid = insByCodigo[comp.codigo];
          if (!iid) { falta.push(`insumo código ${comp.codigo}`); continue; }
          resueltos.push({ insumo_id: iid, cantidad: comp.cantidad });
          continue;
        }
        falta.push("componente inválido");
      }
      if (falta.length > 0) { resumen.pendientes.push({ combo: combo.nombre, falta }); continue; }
      // Crear el combo.
      const r = await client.query("INSERT INTO recetas (nombre, tipo, notas) VALUES ($1,'combo',$2) RETURNING id", [combo.nombre, combo.notas || null]);
      const id = r.rows[0].id;
      recByNombre[combo.nombre.toLowerCase()] = id;
      let orden = 0;
      for (const c of resueltos) {
        if (c.subreceta_id) await client.query("INSERT INTO receta_lineas (receta_id, orden, subreceta_id, modo, cantidad, desperdicio_pct) VALUES ($1,$2,$3,'unidades',$4,0)", [id, orden++, c.subreceta_id, c.cantidad]);
        else await client.query("INSERT INTO receta_lineas (receta_id, orden, insumo_id, modo, cantidad, desperdicio_pct) VALUES ($1,$2,$3,'unidades',$4,0)", [id, orden++, c.insumo_id, c.cantidad]);
      }
      const clave = claveProducto(normalizarProducto(combo.nombre));
      const dup = await client.query("SELECT id FROM receta_productos WHERE producto_clave = $1", [clave]);
      if (dup.rows.length === 0) await client.query("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3)", [id, combo.nombre, clave]);
      resumen.creados++;
    }
    await client.query("COMMIT");
    res.json({ ok: true, resumen });
    registrarAuditoria(req.body?.usuario, "combos_importar", "recetas", 0, { creados: resumen.creados, salteados: resumen.salteados, pendientes: resumen.pendientes.length });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error importar combos:", e.message);
    res.status(500).json({ error: "Error importando combos: " + e.message });
  } finally { if (client) client.release(); }
});

// Listado con líneas, módulos, productos vinculados y costo estimado.
app.get("/api/recetas", stockVer, async (req, res) => {
  const { q, tipo, incluirInactivas } = req.query;
  try {
    const idx = await cargarRecetasIndex();
    const insIdx = await cargarInsumosIndex();
    let lista = Object.values(idx);
    if (incluirInactivas !== "1") lista = lista.filter(r => r.activo);
    if (tipo) lista = lista.filter(r => r.tipo === tipo);
    if (q) { const s = String(q).toLowerCase(); lista = lista.filter(r => r.nombre.toLowerCase().includes(s)); }
    lista.sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nombre.localeCompare(b.nombre));
    const out = lista.map(r => {
      const exp = explotarReceta(r.id, idx, insIdx);
      const lineas = r.lineas.map(l => l.subreceta_id
        ? { ...l, es_modulo: true, ref_nombre: idx[l.subreceta_id]?.nombre || `#${l.subreceta_id}` }
        : { ...l, es_modulo: false, ref_nombre: insIdx[l.insumo_id]?.nombre || `#${l.insumo_id}`, unidad: insIdx[l.insumo_id]?.unidad, categoria: insIdx[l.insumo_id]?.categoria });
      return { ...r, lineas, costo_estimado: exp.costo, avisos: exp.avisos };
    });
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/api/recetas", requireAdmin, async (req, res) => {
  const b = req.body || {};
  if (!b.nombre || !String(b.nombre).trim()) return res.status(400).json({ error: "El nombre es obligatorio." });
  if (!["producto", "modulo"].includes(b.tipo)) return res.status(400).json({ error: "Tipo inválido (producto o modulo)." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const r = await client.query("INSERT INTO recetas (nombre, tipo, notas) VALUES ($1,$2,$3) RETURNING id", [String(b.nombre).trim(), b.tipo, b.notas || null]);
    const id = r.rows[0].id;
    await insertarLineasReceta(client, id, b.lineas);
    for (const prod of (b.productos || [])) {
      const nombre = String(prod.nombre || prod).trim();
      if (!nombre) continue;
      const clave = claveProducto(normalizarProducto(nombre));
      await client.query("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3)", [id, nombre, clave]);
    }
    // Guard de ciclo con el grafo ya insertado.
    const idx = await cargarRecetasIndex(client);
    const exp = explotarReceta(id, idx, await cargarInsumosIndex(client));
    if (exp.avisos.some(a => a.tipo === "ciclo")) throw { _http: 400, msg: "La receta genera un ciclo de módulos." };
    await client.query("COMMIT");
    res.json({ ok: true, id });
    registrarAuditoria(b.usuario, "receta_crear", "receta", id, { nombre: String(b.nombre).trim(), tipo: b.tipo });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (e && e._http) return res.status(e._http).json({ error: e.msg });
    if (e && e.code === "23505") return res.status(409).json({ error: "Ya existe una receta o producto vinculado con ese nombre/clave." });
    console.error("Error POST /api/recetas:", e.message);
    res.status(500).json({ error: e.message });
  } finally { if (client) client.release(); }
});

app.patch("/api/recetas/:id", requireAdmin, async (req, res) => {
  const b = req.body || {};
  const id = Number(req.params.id);
  if (b.tipo !== undefined && !["producto", "modulo"].includes(b.tipo)) return res.status(400).json({ error: "Tipo inválido." });
  if (Array.isArray(b.lineas) && b.lineas.some(l => Number(l.subreceta_id) === id)) return res.status(400).json({ error: "Un módulo no puede incluirse a sí mismo." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const sets = [], vals = [];
    if (b.nombre !== undefined) { if (!String(b.nombre).trim()) throw { _http: 400, msg: "El nombre no puede quedar vacío." }; vals.push(String(b.nombre).trim()); sets.push(`nombre = $${vals.length}`); }
    if (b.tipo !== undefined) { vals.push(b.tipo); sets.push(`tipo = $${vals.length}`); }
    if (b.notas !== undefined) { vals.push(b.notas || null); sets.push(`notas = $${vals.length}`); }
    if (sets.length > 0) { vals.push(id); const up = await client.query(`UPDATE recetas SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id`, vals); if (up.rows.length === 0) throw { _http: 404, msg: "Receta no encontrada." }; }
    if (Array.isArray(b.lineas)) {
      await client.query("DELETE FROM receta_lineas WHERE receta_id = $1", [id]);
      await insertarLineasReceta(client, id, b.lineas);
      const idx = await cargarRecetasIndex(client);
      const exp = explotarReceta(id, idx, await cargarInsumosIndex(client));
      if (exp.avisos.some(a => a.tipo === "ciclo")) throw { _http: 400, msg: "La receta genera un ciclo de módulos." };
    }
    await client.query("COMMIT");
    res.json({ ok: true });
    registrarAuditoria(b.usuario, "receta_editar", "receta", id, { nombre: b.nombre });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (e && e._http) return res.status(e._http).json({ error: e.msg });
    if (e && e.code === "23505") return res.status(409).json({ error: "Ya existe una receta con ese nombre." });
    console.error("Error PATCH /api/recetas:", e.message);
    res.status(500).json({ error: e.message });
  } finally { if (client) client.release(); }
});

app.post("/api/recetas/:id/duplicar", requireAdmin, async (req, res) => {
  const { nombre, usuario } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: "Falta el nombre de la copia." });
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const orig = await client.query("SELECT * FROM recetas WHERE id = $1", [req.params.id]);
    if (orig.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Receta no encontrada." }); }
    const nueva = await client.query("INSERT INTO recetas (nombre, tipo, notas) VALUES ($1,$2,$3) RETURNING id", [String(nombre).trim(), orig.rows[0].tipo, orig.rows[0].notas]);
    const nid = nueva.rows[0].id;
    await client.query(
      `INSERT INTO receta_lineas (receta_id, orden, insumo_id, subreceta_id, modo, cantidad, peso_g, desperdicio_pct)
       SELECT $1, orden, insumo_id, subreceta_id, modo, cantidad, peso_g, desperdicio_pct FROM receta_lineas WHERE receta_id = $2`,
      [nid, req.params.id]
    );
    await client.query("COMMIT");
    res.json({ ok: true, id: nid });
    registrarAuditoria(usuario, "receta_duplicar", "receta", nid, { desde: Number(req.params.id), nombre: String(nombre).trim() });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    if (e && e.code === "23505") return res.status(409).json({ error: "Ya existe una receta con ese nombre." });
    console.error("Error duplicar receta:", e.message);
    res.status(500).json({ error: e.message });
  } finally { if (client) client.release(); }
});

app.post("/api/recetas/:id/baja", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query("UPDATE recetas SET activo = false WHERE id = $1 RETURNING nombre", [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Receta no encontrada." });
    res.json({ ok: true });
    registrarAuditoria(req.body?.usuario, "receta_baja", "receta", req.params.id, { nombre: r.rows[0].nombre });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Vínculos producto de venta → receta ───
// Clave del vínculo = la MISMA que usa el matcheo de pedidos (necesidades / stock).
const claveVinculo = (nombre) => claveProducto(normalizarProducto(String(nombre || "").trim()));
// Índice clave → vínculo (con su receta). Indexa también re-normalizando producto_nombre: los vínculos
// guardados antes de sumar un alias (ej. "La Gourmet Chica", previo al alias de La Gourmet) tienen la
// clave vieja en producto_clave y tienen que contar igual. La clave exacta guardada tiene prioridad.
async function indiceVinculos(exec = pool) {
  const r = await exec.query("SELECT rp.id, rp.receta_id, rp.producto_nombre, rp.producto_clave, r.nombre AS receta, r.activo FROM receta_productos rp JOIN recetas r ON r.id = rp.receta_id ORDER BY rp.id");
  const idx = new Map();
  for (const x of r.rows) { const k = claveVinculo(x.producto_nombre); if (!idx.has(k)) idx.set(k, x); }
  for (const x of r.rows) idx.set(x.producto_clave, x);
  return idx;
}

// Productos vinculados a una receta (producto o combo; los módulos no se venden).
app.post("/api/recetas/:id/productos", requireAdmin, async (req, res) => {
  const { nombre, usuario } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ error: "Falta el nombre del producto." });
  const producto = String(nombre).trim();
  const clave = claveVinculo(producto);
  try {
    const rec = await pool.query("SELECT id, nombre, tipo, activo FROM recetas WHERE id = $1", [req.params.id]);
    if (rec.rows.length === 0) return res.status(404).json({ error: "Receta no encontrada." });
    if (rec.rows[0].tipo === "modulo") return res.status(400).json({ error: "Los módulos no se venden: vinculá el producto a una receta de producto o a un combo." });
    const dup = (await indiceVinculos()).get(clave);
    if (dup && dup.receta_id === rec.rows[0].id) return res.status(409).json({ error: `Ese producto ya está vinculado a esta receta ("${dup.producto_nombre}").` });
    if (dup && dup.activo) return res.status(409).json({ error: `Ese producto ya está vinculado a la receta "${dup.receta}". Desvinculalo ahí primero.` });
    if (dup) {
      // Vínculo de una receta DADA DE BAJA: no cuenta para nada pero bloqueaba el UNIQUE → se reasigna.
      await pool.query("UPDATE receta_productos SET receta_id = $1, producto_nombre = $2, producto_clave = $3 WHERE id = $4", [rec.rows[0].id, producto, clave, dup.id]);
      res.json({ ok: true, id: dup.id, reasignadoDe: dup.receta });
      registrarAuditoria(usuario, "receta_vincular", "receta", req.params.id, { producto, reasignadoDe: dup.receta });
      return;
    }
    const r = await pool.query("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3) RETURNING id", [req.params.id, producto, clave]);
    res.json({ ok: true, id: r.rows[0].id });
    registrarAuditoria(usuario, "receta_vincular", "receta", req.params.id, { producto });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Ese producto ya está vinculado a otra receta." });
    res.status(500).json({ error: err.message });
  }
});

// Importación de vínculos producto → receta desde vinculos_seed.json: { vinculos: [{ producto, receta }] }.
// Receta por nombre (activa, sin distinguir mayúsculas). Clave existente para la misma receta → salteado;
// para OTRA receta → conflicto (no se toca). Idempotente.
app.post("/api/recetas/importar-vinculos", requireAdmin, async (req, res) => {
  let seed;
  try { seed = requireCJS("./vinculos_seed.json"); }
  catch (e) { return res.status(500).json({ error: "No se pudo leer vinculos_seed.json (¿está en la raíz del proyecto?)" }); }
  if (!Array.isArray(seed?.vinculos)) return res.status(400).json({ error: "vinculos_seed.json tiene que tener { vinculos: [{ producto, receta }] }" });
  const resumen = { creados: 0, salteados: 0, conflictos: [], recetas_no_encontradas: [], invalidos: [] };
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const recR = await client.query("SELECT id, nombre, tipo FROM recetas WHERE activo = true");
    const recPorNombre = {}; for (const r of recR.rows) recPorNombre[r.nombre.trim().toLowerCase()] = r;
    const idx = await indiceVinculos(client);
    for (const v of seed.vinculos) {
      const producto = String(v?.producto || "").trim(), receta = String(v?.receta || "").trim();
      if (!producto || !receta) { resumen.invalidos.push({ producto, receta, motivo: "falta producto o receta" }); continue; }
      const rec = recPorNombre[receta.toLowerCase()];
      if (!rec) { resumen.recetas_no_encontradas.push({ producto, receta }); continue; }
      if (rec.tipo === "modulo") { resumen.invalidos.push({ producto, receta, motivo: "la receta es un módulo" }); continue; }
      const clave = claveVinculo(producto);
      const ex = idx.get(clave);
      if (ex && ex.receta_id === rec.id) { resumen.salteados++; continue; }
      if (ex) { resumen.conflictos.push({ producto, receta: rec.nombre, vinculado_a: ex.receta, receta_activa: !!ex.activo }); continue; }
      const ins = await client.query("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3) RETURNING id", [rec.id, producto, clave]);
      idx.set(clave, { id: ins.rows[0].id, receta_id: rec.id, producto_nombre: producto, producto_clave: clave, receta: rec.nombre, activo: true });
      resumen.creados++;
    }
    await client.query("COMMIT");
    res.json({ ok: true, resumen });
    registrarAuditoria(req.body?.usuario, "vinculos_importar", "recetas", 0, { creados: resumen.creados, salteados: resumen.salteados, conflictos: resumen.conflictos.length, no_encontradas: resumen.recetas_no_encontradas.length });
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error importar vínculos:", e.message);
    res.status(500).json({ error: "Error importando vínculos: " + e.message });
  } finally { if (client) client.release(); }
});
app.delete("/api/recetas/:id/productos/:pid", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM receta_productos WHERE id = $1 AND receta_id = $2", [req.params.pid, req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Productos necesarios: demanda de cocina (Por empaquetar/Listo) × recetas → insumos, vs stock.
app.get("/api/insumos/necesidades", stockVer, async (req, res) => {
  const { desde, hasta, local } = req.query;
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!desde || !hasta || !re.test(desde) || !re.test(hasta)) return res.status(400).json({ error: "Parámetros 'desde' y 'hasta' requeridos (YYYY-MM-DD)." });
  if (desde > hasta) return res.status(400).json({ error: "'desde' no puede ser posterior a 'hasta'." });
  const localFiltro = (local === "A. Thomas" || local === "French") ? local : null;   // null = ambos
  try {
    const estadosRes = await pool.query("SELECT id, estado, tab_manual, fecha_manual FROM pedidos_estados");
    const estadosMap = {}; estadosRes.rows.forEach(r => estadosMap[r.id] = { estado: r.estado, tabManual: r.tab_manual, fechaManual: r.fecha_manual });
    const ovRes = await pool.query("SELECT pedido_id, productos FROM pedidos_productos");
    const ovMap = {}; ovRes.rows.forEach(r => ovMap[r.pedido_id] = r.productos);

    const demanda = {};   // clave-nombre (normalizarProducto) -> qty
    const addProductos = (productosStr) => {
      for (const item of String(productosStr || "").split(", ")) {
        const m = item.match(/^(.+) x(\d+)$/);
        if (!m) continue;
        const raw = m[1].trim();
        if (esExcluidoProduccion(raw)) continue;
        const nombre = normalizarProducto(raw);
        demanda[nombre] = (demanda[nombre] || 0) + Number(m[2]);
      }
    };
    const tnRes = await pool.query(`SELECT t.data FROM pedidos_tn t WHERE t.tn_created_at BETWEEN ($1::date - INTERVAL '365 days') AND ($2::date + INTERVAL '5 days')`, [desde, hasta]);
    for (const row of tnRes.rows) {
      const p = row.data; const est = estadosMap[String(p.id)] || {};
      const estado = est.estado || "Por empaquetar";
      if (estado !== "Por empaquetar" && estado !== "Listo") continue;
      const { fecha } = parsearFranjaBackend(p.owner_note);
      const fd = est.fechaManual || fecha;
      if (!fd || fd < desde || fd > hasta) continue;
      const loc = localLabelBackend(est.tabManual || clasificarPedidoBackend(p));
      if (localFiltro && loc !== localFiltro) continue;
      const ov = ovMap[String(p.id)];
      addProductos(ov || (p.products || []).map(pr => `${pr.name} x${pr.quantity}`).join(", "));
    }
    const manRes = await pool.query("SELECT * FROM pedidos_manuales");
    for (const r of manRes.rows) {
      const est = estadosMap[r.id] || {};
      const estado = est.estado || "Por empaquetar";
      if (estado !== "Por empaquetar" && estado !== "Listo") continue;
      const fd = est.fechaManual || r.fecha;
      if (!fd || fd < desde || fd > hasta) continue;
      const loc = localLabelBackend(est.tabManual || r.tab_actual);
      if (localFiltro && loc !== localFiltro) continue;
      addProductos(ovMap[r.id] || r.productos);
    }

    const idx = await cargarRecetasIndex();
    const insIdx = await cargarInsumosIndex();
    const recetaPorClave = {};
    const rp = await pool.query("SELECT rp.producto_clave, rp.producto_nombre, rp.receta_id FROM receta_productos rp JOIN recetas r ON r.id = rp.receta_id WHERE r.activo = true ORDER BY rp.id");
    // También por el nombre re-normalizado (vínculos con clave vieja, previa a un alias); la clave guardada manda.
    for (const x of rp.rows) { const k = claveVinculo(x.producto_nombre); if (!(k in recetaPorClave)) recetaPorClave[k] = x.receta_id; }
    for (const x of rp.rows) recetaPorClave[x.producto_clave] = x.receta_id;

    const necesarioBase = {};   // insumo_id -> base
    const sinReceta = [];
    const avisosSet = {};
    for (const [nombre, qty] of Object.entries(demanda)) {
      const recetaId = recetaPorClave[claveProducto(nombre)];
      if (!recetaId) { sinReceta.push({ producto: nombre, cantidad: qty }); continue; }
      const exp = explotarReceta(recetaId, idx, insIdx);
      for (const [iid, base] of Object.entries(exp.insumos)) necesarioBase[iid] = (necesarioBase[iid] || 0) + base * qty;
      for (const a of exp.avisos) avisosSet[a.detalle] = a;
    }

    const stR = await pool.query("SELECT insumo_id, local, COALESCE(SUM(cantidad),0) AS total FROM insumos_movimientos GROUP BY insumo_id, local");
    const stockByInsumo = {};
    for (const s of stR.rows) {
      if (localFiltro && s.local !== localFiltro) continue;
      stockByInsumo[s.insumo_id] = (stockByInsumo[s.insumo_id] || 0) + Number(s.total);
    }

    const items = Object.entries(necesarioBase).map(([iid, necesario]) => {
      const ins = insIdx[iid] || {};
      const stock = stockByInsumo[iid] || 0;
      return { insumo_id: Number(iid), nombre: ins.nombre || `#${iid}`, categoria: ins.categoria || null, unidad: ins.unidad || "g", necesario, stock, faltante: Math.max(0, necesario - stock) };
    }).sort((a, b) => (a.categoria || "").localeCompare(b.categoria || "") || a.nombre.localeCompare(b.nombre));

    sinReceta.sort((a, b) => b.cantidad - a.cantidad);
    res.json({ items, sin_receta: sinReceta, avisos: Object.values(avisosSet) });
  } catch (err) { console.error("Error /api/insumos/necesidades:", err.message); res.status(500).json({ error: err.message }); }
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

// Variante del geocoder para el REPORTE DE ZONAS. NO se usa en el mapa (que acepta
// cualquier resultado): el reporte agrega a costo por área, así que una coord dudosa
// contamina números. Además de lat/lng evalúa la CONFIANZA (location_type + partial_match)
// y persiste esas señales en geocoding_cache. Devuelve { lat, lng, location_type,
// partial_match, confiable, cached }.
//   REGLA: confiable = partial_match !== true  Y  location_type ∈ {ROOFTOP, RANGE_INTERPOLATED}.
//   Filas viejas cacheadas SIN location_type (NULL) se tratan como confiables (ya venían
//   usándose; no las rompemos): el filtro solo aplica a lo que geocodificamos de nuevo.
const LOCATION_TYPES_CONFIABLES = new Set(["ROOFTOP", "RANGE_INTERPOLATED"]);
function esGeoConfiable(locationType, partialMatch) {
  if (locationType == null) return true;               // legacy sin etiquetar → confiable
  return partialMatch !== true && LOCATION_TYPES_CONFIABLES.has(locationType);
}
async function geocodificarConConfianza(direccionCompleta) {
  const key = direccionCompleta.toLowerCase().trim();
  try {
    const cached = await pool.query("SELECT lat, lng, location_type, partial_match FROM geocoding_cache WHERE address_key=$1", [key]);
    if (cached.rows.length > 0) {
      const c = cached.rows[0];
      return { lat: Number(c.lat), lng: Number(c.lng), location_type: c.location_type,
        partial_match: !!c.partial_match, confiable: esGeoConfiable(c.location_type, c.partial_match), cached: true };
    }
  } catch(e) {}
  if (!GOOGLE_MAPS_API_KEY) return null;
  try {
    const res = await axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
      params: { address: direccionCompleta, key: GOOGLE_MAPS_API_KEY, region: "ar", language: "es" }
    });
    if (res.data.status === "OK" && res.data.results[0]) {
      const r0 = res.data.results[0];
      const loc = r0.geometry.location;
      const locationType = r0.geometry.location_type || null;
      const partialMatch = r0.partial_match === true;
      // Upsert: si por una carrera la fila ya existía, completamos/actualizamos las señales.
      await pool.query(
        `INSERT INTO geocoding_cache (address_key, lat, lng, location_type, partial_match)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (address_key) DO UPDATE SET location_type = EXCLUDED.location_type, partial_match = EXCLUDED.partial_match`,
        [key, loc.lat, loc.lng, locationType, partialMatch]
      );
      return { lat: loc.lat, lng: loc.lng, location_type: locationType, partial_match: partialMatch,
        confiable: esGeoConfiable(locationType, partialMatch), cached: false };
    }
  } catch(e) { console.error("Geocoding (confianza) error:", e.message); }
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
// La caja "Administración" es exclusiva de superadmin (los demás locales, sin cambios).
// Responde 403 y devuelve true si hay que bloquear la operación.
function bloqueaCajaAdmin(req, res, local) {
  if (String(local) === "Administración" && req.user?.rol !== "superadmin") {
    res.status(403).json({ error: "La caja Administración es solo para superadmin." });
    return true;
  }
  return false;
}
app.post("/api/caja/apertura", requireAuth, async (req, res) => {
  const { local, fecha, montoInicial, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, local)) return;
  try {
    const existe = await pool.query("SELECT id FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    if (existe.rows.length > 0) return res.json({ ok: true, yaExiste: true });
    await pool.query("INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ($1,$2,$3)", [local, fecha, montoInicial]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'apertura','Apertura de caja',$2,$3)", [local, montoInicial, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "apertura_caja", "caja", local, { fecha, montoInicial });
  } catch (err) { res.status(500).json({ error: "Error en apertura de caja" }); }
});
app.post("/api/caja/reabrir", requireAuth, async (req, res) => {
  const { local, fecha, montoInicial, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, local)) return;
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

app.get("/api/caja/estado/:local/:fecha", requireAuth, async (req, res) => {
  const { local, fecha } = req.params;
  if (bloqueaCajaAdmin(req, res, local)) return;
  try {
    const apertura = await pool.query("SELECT * FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    const movimientos = await pool.query("SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC", [local, fecha]);
    res.json({ apertura: apertura.rows[0] || null, movimientos: movimientos.rows });
  } catch (err) { res.status(500).json({ error: "Error trayendo estado de caja" }); }
});

app.post("/api/caja/ajuste", requireAuth, async (req, res) => {
  const { local, fecha, tipo, concepto, monto, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, local)) return;
  try {
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)", [local, tipo, concepto, monto, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "ajuste_caja", "caja", local, { fecha, tipo, concepto, monto });
  } catch (err) { res.status(500).json({ error: "Error registrando ajuste" }); }
});
// SOBRE — Etapa 1: sale de la caja del local y queda PENDIENTE en la bandeja (tabla sobres),
// SIN impactar ninguna caja destino. Atómico (salida local + sobre pendiente, las dos o ninguna).
// La recepción/rechazo (Parte B) la hace el superadmin. La entrada a Administración YA NO ocurre acá.
app.post("/api/caja/sobre", requireAuth, async (req, res) => {
  const { localOrigen, monto, concepto, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, localOrigen)) return;   // no se envía un sobre DESDE la caja Administración
  const montoAbs = Math.abs(Number(monto));
  if (!Number.isFinite(montoAbs) || montoAbs <= 0) return res.status(400).json({ error: "Monto inválido" });
  const conceptoTxt = (concepto && String(concepto).trim()) || "";
  const fecha = fechaArgentinaISO();   // día del local (siempre hoy)
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    // 1. Salida en el local origen (la plata queda EN TRÁNSITO, no en ninguna caja destino).
    await client.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4)",
      [localOrigen, conceptoTxt ? `Sobre a bandeja: ${conceptoTxt}` : "Sobre a bandeja", -montoAbs, fecha]
    );
    // 2. Sobre PENDIENTE en la bandeja (lo recibe/rechaza el superadmin en la Parte B).
    await client.query(
      "INSERT INTO sobres (local_origen, monto_declarado, concepto, estado, fecha_creacion, usuario_crea) VALUES ($1,$2,$3,'pendiente',$4,$5)",
      [localOrigen, montoAbs, conceptoTxt || null, fecha, usuarioAudit || null]
    );
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error /api/caja/sobre:", e.message);
    return res.status(500).json({ error: "Error registrando el sobre" });
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true });
  registrarAuditoria(usuarioAudit, "sobre_creado", "sobre", localOrigen, { monto: montoAbs, concepto: conceptoTxt, fecha });
});

// Bandeja de sobres PENDIENTES (para el superadmin): lista + total en tránsito.
app.get("/api/sobres/pendientes", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, local_origen, monto_declarado, concepto, fecha_creacion, usuario_crea FROM sobres WHERE estado='pendiente' ORDER BY created_at ASC"
    );
    const total = rows.reduce((a, s) => a + Number(s.monto_declarado), 0);
    res.json({ total, sobres: rows });
  } catch (err) { console.error("Error /api/sobres/pendientes:", err.message); res.status(500).json({ error: "Error trayendo sobres pendientes" }); }
});

// Recepción en LOTE (confía en lo declarado, sin corrección): entrada en cajaDestino por el monto
// declarado de cada sobre + marca 'recibido'. TODO el lote en UNA transacción (todo o nada). Solo superadmin.
app.post("/api/sobres/recibir-multiple", requireAuth, async (req, res) => {
  if (req.user?.rol !== "superadmin") return res.status(403).json({ error: "Solo superadmin puede recibir sobres." });
  const { sobreIds, cajaDestino, usuario: usuarioAudit } = req.body;
  if (!Array.isArray(sobreIds) || sobreIds.length === 0) return res.status(400).json({ error: "No hay sobres seleccionados." });
  if (!CAJAS_TRANSFERIBLES.includes(cajaDestino)) return res.status(400).json({ error: "Caja destino inválida." });
  const ids = sobreIds.map(Number).filter(Number.isInteger);
  const fecha = fechaArgentinaISO();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, local_origen, monto_declarado, concepto FROM sobres WHERE id = ANY($1::int[]) AND estado='pendiente' FOR UPDATE",
      [ids]
    );
    if (rows.length !== ids.length) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Alguno de los sobres ya no está pendiente. Refrescá e intentá de nuevo." });
    }
    for (const s of rows) {
      await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4)",
        [cajaDestino, `Sobre recibido desde ${s.local_origen}${s.concepto ? `: ${s.concepto}` : ""}`, Number(s.monto_declarado), fecha]
      );
      await client.query(
        "UPDATE sobres SET estado='recibido', monto_real=monto_declarado, caja_destino=$1, fecha_resolucion=$2, usuario_resuelve=$3 WHERE id=$4",
        [cajaDestino, fecha, usuarioAudit || null, s.id]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error /api/sobres/recibir-multiple:", e.message);
    return res.status(500).json({ error: "Error recibiendo sobres" });
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true, recibidos: ids.length });
  registrarAuditoria(usuarioAudit, "sobres_recibidos_lote", "sobre", cajaDestino, { sobreIds: ids, cajaDestino, fecha });
});

// Recepción INDIVIDUAL con corrección de monto real (X−Y). Atómico. Solo superadmin.
app.post("/api/sobres/:id/recibir", requireAuth, async (req, res) => {
  if (req.user?.rol !== "superadmin") return res.status(403).json({ error: "Solo superadmin puede recibir sobres." });
  const { cajaDestino, montoReal, usuario: usuarioAudit } = req.body;
  if (!CAJAS_TRANSFERIBLES.includes(cajaDestino)) return res.status(400).json({ error: "Caja destino inválida." });
  const Y = Number(montoReal);
  if (!Number.isFinite(Y) || Y < 0) return res.status(400).json({ error: "Monto real inválido." });
  const fecha = fechaArgentinaISO();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT id, local_origen, monto_declarado, concepto FROM sobres WHERE id=$1 AND estado='pendiente' FOR UPDATE", [req.params.id]);
    const s = rows[0];
    if (!s) { await client.query("ROLLBACK"); return res.status(409).json({ error: "El sobre ya no está pendiente." }); }
    const X = Number(s.monto_declarado);
    if (Y > 0) {
      await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4)",
        [cajaDestino, `Sobre recibido desde ${s.local_origen}${s.concepto ? `: ${s.concepto}` : ""}`, Y, fecha]
      );
    }
    const dif = X - Y;   // >0: declaró de más (se devuelve al local); <0: declaró de menos (se baja del local)
    if (dif !== 0) {
      await client.query(
        "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)",
        [s.local_origen, dif > 0 ? "entrada" : "salida", `Ajuste sobre (declarado ${X} / real ${Y})`, dif, fecha]
      );
    }
    await client.query(
      "UPDATE sobres SET estado='recibido', monto_real=$1, caja_destino=$2, fecha_resolucion=$3, usuario_resuelve=$4 WHERE id=$5",
      [Y, cajaDestino, fecha, usuarioAudit || null, s.id]
    );
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error /api/sobres/:id/recibir:", e.message);
    return res.status(500).json({ error: "Error recibiendo el sobre" });
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true });
  registrarAuditoria(usuarioAudit, "sobre_recibido", "sobre", req.params.id, { cajaDestino, montoReal: Y, fecha });
});

// RECHAZO: la plata vuelve al local origen (revierte la salida inicial). Atómico. Solo superadmin.
app.post("/api/sobres/:id/rechazar", requireAuth, async (req, res) => {
  if (req.user?.rol !== "superadmin") return res.status(403).json({ error: "Solo superadmin puede rechazar sobres." });
  const { usuario: usuarioAudit } = req.body;
  const fecha = fechaArgentinaISO();
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT id, local_origen, monto_declarado FROM sobres WHERE id=$1 AND estado='pendiente' FOR UPDATE", [req.params.id]);
    const s = rows[0];
    if (!s) { await client.query("ROLLBACK"); return res.status(409).json({ error: "El sobre ya no está pendiente." }); }
    await client.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4)",
      [s.local_origen, "Sobre rechazado (devuelto)", Number(s.monto_declarado), fecha]
    );
    await client.query(
      "UPDATE sobres SET estado='rechazado', fecha_resolucion=$1, usuario_resuelve=$2 WHERE id=$3",
      [fecha, usuarioAudit || null, s.id]
    );
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error /api/sobres/:id/rechazar:", e.message);
    return res.status(500).json({ error: "Error rechazando el sobre" });
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true });
  registrarAuditoria(usuarioAudit, "sobre_rechazado", "sobre", req.params.id, { fecha });
});
app.post("/api/caja/cerrar-historico", requireAuth, async (req, res) => {
  const { local, fecha, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, local)) return;
  try {
    await pool.query("UPDATE caja_aperturas SET cerrada=true, monto_cierre=monto_inicial WHERE local=$1 AND fecha=$2 AND cerrada=false", [local, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "cierre_historico", "caja", local, { fecha });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/caja/cierre", requireAuth, async (req, res) => {
  const { local, fecha, montoCierre, usuario: usuarioAudit } = req.body;
  if (bloqueaCajaAdmin(req, res, local)) return;
  try {
    await pool.query("UPDATE caja_aperturas SET cerrada=true, monto_cierre=$1 WHERE local=$2 AND fecha=$3", [montoCierre, local, fecha]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'cierre','Cierre Z',$2,$3)", [local, montoCierre, fecha]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "cierre_caja", "caja", local, { fecha, montoCierre });
  } catch (err) { res.status(500).json({ error: "Error en cierre de caja" }); }
});
// ===== FONDO FIJO (uno por local) =====
const FONDOS_VALIDOS = ["Fondo Fijo A. Thomas", "Fondo Fijo French"];

app.get("/api/fondo-fijo/:local", requireAuth, async (req, res) => {
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
app.post("/api/fondo-fijo/movimiento", requireAuth, async (req, res) => {
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

app.get("/api/caja/historial/:local", requireAuth, async (req, res) => {
  const { local } = req.params;
  if (bloqueaCajaAdmin(req, res, decodeURIComponent(local))) return;
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

// Caja "Administración" PERSISTENTE (saldo acumulado, como el Fondo Fijo): suma entrada/salida
// de TODOS sus movimientos, sin filtrar por fecha. Excluye apertura/cierre. Solo superadmin.
app.get("/api/caja/administracion", requireAuth, async (req, res) => {
  if (bloqueaCajaAdmin(req, res, "Administración")) return;
  try {
    const movs = await pool.query(
      "SELECT * FROM caja_movimientos WHERE local='Administración' AND tipo IN ('entrada','salida') ORDER BY created_at DESC"
    );
    const saldo = movs.rows.reduce((a, m) => a + Number(m.monto), 0);
    res.json({ saldo, movimientos: movs.rows });
  } catch (err) { res.status(500).json({ error: "Error trayendo la caja Administración" }); }
});

// Prefijos de conceptos AUTOGENERADOS (transferencias/sobres/pagos/apertura-cierre): NO editables.
// ⚠️ Mantener en sync con la MISMA lista en el front (App.jsx: CONCEPTOS_AUTO_PREFIJOS).
const CONCEPTOS_AUTO_PREFIJOS = [
  "transferencia a", "transferencia desde", "pago factura", "sobre a bandeja",
  "sobre recibido", "sobre rechazado", "ajuste sobre", "apertura", "reapertura", "cierre",
  "gasto:", "anulación gasto",
  "adelanto sueldo:", "anulación adelanto",
  "pago sueldo:", "anulación pago sueldo",
  "pago a cuenta #", "anulación pago a cuenta #",   // con "#": "Pago a cuenta de la luz" (manual) sigue editable
  "depósito a cuenta #", "anulación depósito a cuenta #", "retiro de cuenta #", "anulación retiro de cuenta #",   // tesorería ↔ caja
  "anulación pago factura #",
  "pago adicional #", "anulación pago adicional #",   // RRHH: hora extra / bono / otro fuera del recibo
];
// Comparación sin tildes ni mayúsculas ("Deposito a cuenta #3" también es automático).
const sinTildesConcepto = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
function esConceptoAutogenerado(concepto) {
  const c = sinTildesConcepto(concepto);
  return CONCEPTOS_AUTO_PREFIJOS.some(p => c.startsWith(sinTildesConcepto(p)));
}

// Editar SOLO el concepto de un movimiento MANUAL (nunca monto/tipo/fecha/local). Los autogenerados
// (transferencias/sobres/pagos) conservan su rastro. Respeta el permiso de la caja Administración.
app.patch("/api/caja/movimiento/:id/concepto", requireAuth, async (req, res) => {
  const { concepto, usuario: usuarioAudit } = req.body;
  if (!concepto || !String(concepto).trim()) return res.status(400).json({ error: "El concepto no puede estar vacío." });
  try {
    const r = await pool.query("SELECT id, local, concepto FROM caja_movimientos WHERE id=$1", [req.params.id]);
    const m = r.rows[0];
    if (!m) return res.status(404).json({ error: "Movimiento no encontrado." });
    if (bloqueaCajaAdmin(req, res, m.local)) return;   // Administración solo superadmin
    if (esConceptoAutogenerado(m.concepto)) return res.status(403).json({ error: "No se puede editar el concepto de un movimiento automático." });
    await pool.query("UPDATE caja_movimientos SET concepto=$1 WHERE id=$2", [String(concepto).trim(), req.params.id]);
    res.json({ ok: true });
    registrarAuditoria(usuarioAudit, "editar_concepto_movimiento", "caja", m.local, { id: m.id, anterior: m.concepto, nuevo: String(concepto).trim() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── TRANSFERENCIA ENTRE CAJAS ─────────────────────────────────────────
// Salida en origen (−monto) + entrada en destino (+monto), mismo monto, ATÓMICO (BEGIN/COMMIT/
// ROLLBACK). Solo admin/superadmin; si toca "Administración" (origen o destino) exige superadmin.
// Fecha SIEMPRE hoy (Argentina): cae en el día abierto de las cajas de local; para las
// persistentes (fondo/Administración) la fecha es informativa. Se relacionan por el concepto.
const CAJAS_TRANSFERIBLES = ["A. Thomas", "French", "Administración", "Fondo Fijo A. Thomas", "Fondo Fijo French"];
app.post("/api/caja/transferencia", requireAuth, async (req, res) => {
  const { origen, destino, monto, concepto, usuario: usuarioAudit } = req.body;
  const rol = req.user?.rol;
  if (!["admin", "superadmin"].includes(rol)) return res.status(403).json({ error: "Solo admin puede transferir entre cajas." });
  if (!CAJAS_TRANSFERIBLES.includes(origen) || !CAJAS_TRANSFERIBLES.includes(destino)) return res.status(400).json({ error: "Caja de origen o destino inválida." });
  if (origen === destino) return res.status(400).json({ error: "El origen y el destino no pueden ser la misma caja." });
  const montoAbs = Math.abs(Number(monto));
  if (!Number.isFinite(montoAbs) || montoAbs <= 0) return res.status(400).json({ error: "Monto inválido." });
  if (!concepto || !String(concepto).trim()) return res.status(400).json({ error: "El concepto es obligatorio." });
  if ((origen === "Administración" || destino === "Administración") && rol !== "superadmin") {
    return res.status(403).json({ error: "Transferir con la caja Administración es solo para superadmin." });
  }
  const conceptoTxt = String(concepto).trim();
  const fecha = fechaArgentinaISO();   // SIEMPRE hoy
  let client;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'salida',$2,$3,$4)",
      [origen, `Transferencia a ${destino}: ${conceptoTxt}`, -montoAbs, fecha]
    );
    await client.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'entrada',$2,$3,$4)",
      [destino, `Transferencia desde ${origen}: ${conceptoTxt}`, montoAbs, fecha]
    );
    await client.query("COMMIT");
  } catch (e) {
    if (client) await client.query("ROLLBACK").catch(() => {});
    console.error("Error /api/caja/transferencia:", e.message);
    return res.status(500).json({ error: "Error registrando la transferencia" });
  } finally {
    if (client) client.release();
  }
  res.json({ ok: true, origen, destino, monto: montoAbs, fecha });
  registrarAuditoria(usuarioAudit, "transferencia_caja", "caja", origen, { origen, destino, monto: montoAbs, concepto: conceptoTxt, fecha });
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

// ─── CONTABLE — LIBRO DE VENTAS (formato AFIP) ───────────────────────
// SOLO superadmin. Lee de la tabla facturas (NO la modifica ni cambia cómo se emite).
// Toda factura se emite con alícuota ÚNICA 21% (o EXENTO alícuota 0), así que el neto y
// el IVA se calculan sin ambigüedad desde `total`. El filtro es por created_at (timestamp
// real); la columna `fecha` es DD/MM/YYYY (texto) y solo se usa para mostrar/exportar.
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Tipo de comprobante (string) → código AFIP.
function codComprobanteAFIP(tipo) {
  const t = String(tipo || "").toUpperCase();
  if (t.includes("NOTA DE CREDITO A")) return 3;
  if (t.includes("NOTA DE CREDITO B")) return 8;
  if (t.includes("FACTURA A")) return 1;
  return 6;   // FACTURA B y FACTURA B EXENTO
}
// Tipo de documento del receptor (string) → código AFIP.
function codDocReceptorAFIP(docTipo, docNro) {
  const t = String(docTipo || "").toUpperCase();
  if (t.includes("CUIT")) return 80;
  if (t.includes("CUIL")) return 86;
  if (t.includes("DNI")) return 96;
  const nro = String(docNro || "").trim();
  if (nro === "" || nro === "0") return 99;   // Consumidor Final
  return 96;
}
// Punto de venta: del prefijo de `numero` (ej "00017-…") o, si no lo tuviera, del local.
function pdvDeFactura(f) {
  const s = String(f.numero || "");
  if (s.includes("-")) { const n = Number(s.split("-")[0]); if (n) return n; }
  return f.local === "French" ? 18 : 17;
}
// Columnas del formato AFIP (IVA_VENTAS), en orden. El front las usa tal cual para la
// tabla en pantalla y para el header del Excel, así el export sale idéntico.
const LIBRO_VENTAS_COLUMNAS = [
  "Fecha de Emision", "Tipo de Comprobante", "Punto de Venta", "Numero Desde", "Numero Hasta",
  "Cod. Autorizacion", "Tipo Doc. Receptor", "Nro. Doc. Receptor", "Denominacion Receptor",
  "Tipo Cambio", "Moneda",
  "Imp. Neto Gravado IVA 0%",
  "IVA 2,5%", "Imp. Neto Gravado IVA 2,5%",
  "IVA 5%", "Imp. Neto Gravado IVA 5%",
  "IVA 10,5%", "Imp. Neto Gravado IVA 10,5%",
  "IVA 21%", "Imp. Neto Gravado IVA 21%",
  "IVA 27%", "Imp. Neto Gravado IVA 27%",
  "Imp. Neto Gravado Total", "Imp. Neto No Gravado", "Imp. Op. Exentas",
  "Otros Tributos", "Total IVA", "Imp. Total",
];

app.get("/api/contable/libro-ventas", requireAuth, async (req, res) => {
  if (req.user?.rol !== "superadmin") return res.status(403).json({ error: "Solo superadmin puede ver el libro de ventas." });
  const { desde, hasta, local } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: "Faltan las fechas desde/hasta." });
  try {
    const params = [desde, hasta];
    let sql = "SELECT tipo, numero, cae, cliente, documento_tipo, documento_nro, total, fecha, local, created_at FROM facturas WHERE created_at::date >= $1 AND created_at::date <= $2";
    if (local && local !== "Ambos") { params.push(local); sql += ` AND local = $${params.length}`; }
    sql += " ORDER BY created_at ASC, id ASC";
    const { rows } = await pool.query(sql, params);
    const filas = [];
    const tipos = [];   // tipo ORIGINAL (string) por fila, paralelo a `filas`. Solo para mostrar
                        // texto legible en pantalla; NO forma parte de las columnas oficiales del Excel.
    const tot = { neto21: 0, iva21: 0, netoTotal: 0, noGravado: 0, exentas: 0, totalIva: 0, impTotal: 0 };
    for (const f of rows) {
      const total = round2(f.total);
      const esExento = String(f.tipo || "").toUpperCase().includes("EXENTO");
      let neto21 = 0, iva21 = 0, exentas = 0;
      if (esExento) { exentas = total; }
      else { neto21 = round2(total / 1.21); iva21 = round2(total - neto21); }
      const netoTotal = neto21;
      const totalIva = iva21;
      const numeroSolo = Number(numeroSinPuntoVenta(f.numero)) || 0;
      tot.neto21 += neto21; tot.iva21 += iva21; tot.netoTotal += netoTotal;
      tot.exentas += exentas; tot.totalIva += totalIva; tot.impTotal += total;
      tipos.push(f.tipo || "");
      filas.push({
        "Fecha de Emision": f.fecha || "",
        "Tipo de Comprobante": codComprobanteAFIP(f.tipo),
        "Punto de Venta": pdvDeFactura(f),
        "Numero Desde": numeroSolo,
        "Numero Hasta": numeroSolo,
        "Cod. Autorizacion": f.cae || "",
        "Tipo Doc. Receptor": codDocReceptorAFIP(f.documento_tipo, f.documento_nro),
        "Nro. Doc. Receptor": f.documento_nro || "0",
        "Denominacion Receptor": f.cliente || "",
        "Tipo Cambio": 1,
        "Moneda": "PES",
        "Imp. Neto Gravado IVA 0%": 0,
        "IVA 2,5%": 0, "Imp. Neto Gravado IVA 2,5%": 0,
        "IVA 5%": 0, "Imp. Neto Gravado IVA 5%": 0,
        "IVA 10,5%": 0, "Imp. Neto Gravado IVA 10,5%": 0,
        "IVA 21%": iva21, "Imp. Neto Gravado IVA 21%": neto21,
        "IVA 27%": 0, "Imp. Neto Gravado IVA 27%": 0,
        "Imp. Neto Gravado Total": netoTotal,
        "Imp. Neto No Gravado": 0,
        "Imp. Op. Exentas": exentas,
        "Otros Tributos": 0,
        "Total IVA": totalIva,
        "Imp. Total": total,
      });
    }
    const totales = {
      neto21: round2(tot.neto21), iva21: round2(tot.iva21), netoTotal: round2(tot.netoTotal),
      noGravado: 0, exentas: round2(tot.exentas), totalIva: round2(tot.totalIva),
      impTotal: round2(tot.impTotal), cantidad: filas.length,
    };
    res.json({ columnas: LIBRO_VENTAS_COLUMNAS, filas, tipos, totales });
  } catch (err) {
    console.error("Error /api/contable/libro-ventas:", err.message);
    res.status(500).json({ error: "Error generando el libro de ventas" });
  }
});

// ─── CONTABLE — LIBRO DE COMPRAS (formato AFIP IVA_COMPRAS) ─────────────
// SOLO superadmin. Lee de facturas_compra (NO la modifica). Excluye anuladas.
// Tipo de comprobante recibido (string) → "código - texto" como el Excel de referencia.
function tipoCompraAFIP(tipo) {
  const t = tipoCompraNorm(tipo);
  if (t.includes("NOTA DE CREDITO A")) return "3 - Nota de Crédito A";
  if (t.includes("NOTA DE CREDITO B")) return "8 - Nota de Crédito B";
  if (t.includes("NOTA DE CREDITO C")) return "13 - Nota de Crédito C";
  if (t.includes("NOTA DE DEBITO A")) return "2 - Nota de Débito A";
  if (t.includes("NOTA DE DEBITO B")) return "7 - Nota de Débito B";
  if (t.includes("NOTA DE DEBITO C")) return "12 - Nota de Débito C";
  if (t.includes("FACTURA A")) return "1 - Factura A";
  if (t.includes("FACTURA B")) return "6 - Factura B";
  if (t.includes("FACTURA C")) return "11 - Factura C";
  return tipo || "";
}
// ⚠️ Varios headers llevan un ESPACIO FINAL a propósito — copiados EXACTO del Excel de referencia
// (FECHA , FACTURA , CUIT , PROVEEDOR , NETO , NETO NO GRAVADO , OTROS TRIBUTOS , TOTAL IVA , IMP. TOTAL ).
// NO "corregir". Las claves de las filas de abajo deben coincidir carácter a carácter.
const LIBRO_COMPRAS_COLUMNAS = [
  "FECHA ", "TIPO", "FACTURA ", "CUIT ", "PROVEEDOR ", "NETO ",
  "PERCEP. IVA", "PERCEP. IIBB BSAS", "PERCEP. IIBB CABA",
  "NETO NO GRAVADO ", "OP. EXENTAS", "OTROS TRIBUTOS ", "TOTAL IVA ", "IMP. TOTAL ",
];

app.get("/api/contable/libro-compras", requireAuth, async (req, res) => {
  if (req.user?.rol !== "superadmin") return res.status(403).json({ error: "Solo superadmin puede ver el libro de compras." });
  const { desde, hasta, proveedor } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: "Faltan las fechas desde/hasta." });
  try {
    // El libro se imputa por fecha_contable (no por la fecha de la factura). Fallback a fecha por compat.
    const params = [desde, hasta];
    let sql = "SELECT * FROM facturas_compra WHERE estado_pago <> 'anulada' AND COALESCE(fecha_contable, fecha) >= $1 AND COALESCE(fecha_contable, fecha) <= $2";
    if (proveedor) { params.push(proveedor); sql += ` AND proveedor_id = $${params.length}`; }
    sql += " ORDER BY COALESCE(fecha_contable, fecha) ASC, id ASC";
    const { rows } = await pool.query(sql, params);
    const filas = [];
    const tot = { neto: 0, percepIva: 0, percepBsas: 0, percepCaba: 0, noGravado: 0, exentas: 0, otros: 0, totalIva: 0, impTotal: 0 };
    for (const f of rows) {
      // Signo: NC resta (-1), Factura/ND suman (+1). Los montos se guardan en positivo; acá se firman
      // para que las NC salgan en NEGATIVO (formato AFIP) y el total del período neteé correctamente.
      // NETO y TOTAL IVA = suma de las columnas por alícuota (10,5+21+27). El IVA_COMPRAS es agregado
      // (una NETO, una TOTAL IVA), no columnas por alícuota.
      const sg = signoComprobante(f.tipo_comprobante);
      const { neto: netoRaw, iva: ivaRaw } = netosMultiAlicuota(f);
      const neto = netoRaw * sg, pIva = (Number(f.percep_iva) || 0) * sg, pBsas = (Number(f.percep_iibb_bsas) || 0) * sg,
        pCaba = (Number(f.percep_iibb_caba) || 0) * sg, noGrav = (Number(f.neto_no_gravado) || 0) * sg, ex = (Number(f.exentas) || 0) * sg,
        otros = (Number(f.otros_tributos) || 0) * sg, iva = ivaRaw * sg, total = (Number(f.total) || 0) * sg;
      tot.neto += neto; tot.percepIva += pIva; tot.percepBsas += pBsas; tot.percepCaba += pCaba;
      tot.noGravado += noGrav; tot.exentas += ex; tot.otros += otros; tot.totalIva += iva; tot.impTotal += total;
      filas.push({
        "FECHA ": f.fecha || "",
        "TIPO": tipoCompraAFIP(f.tipo_comprobante),
        "FACTURA ": f.numero_comprobante || "",
        "CUIT ": f.proveedor_cuit || "",
        "PROVEEDOR ": f.proveedor_razon_social || "",
        "NETO ": neto,
        "PERCEP. IVA": pIva,
        "PERCEP. IIBB BSAS": pBsas,
        "PERCEP. IIBB CABA": pCaba,
        "NETO NO GRAVADO ": noGrav,
        "OP. EXENTAS": ex,
        "OTROS TRIBUTOS ": otros,
        "TOTAL IVA ": iva,
        "IMP. TOTAL ": total,
      });
    }
    const r2 = (n) => Math.round(n * 100) / 100;
    const totales = {
      neto: r2(tot.neto), percepIva: r2(tot.percepIva), percepBsas: r2(tot.percepBsas), percepCaba: r2(tot.percepCaba),
      noGravado: r2(tot.noGravado), exentas: r2(tot.exentas), otros: r2(tot.otros), totalIva: r2(tot.totalIva),
      impTotal: r2(tot.impTotal), cantidad: filas.length,
    };
    res.json({ columnas: LIBRO_COMPRAS_COLUMNAS, filas, totales });
  } catch (err) {
    console.error("Error /api/contable/libro-compras:", err.message);
    res.status(500).json({ error: "Error generando el libro de compras" });
  }
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
app.listen(process.env.PORT || 3001, () => {
  console.log("Servidor corriendo");
  // Autotest de R2 en segundo plano: loguea "R2: OK" o "R2: ERROR <motivo>". Nunca tira: si falla,
  // solo quedan deshabilitados los archivos de WhatsApp y el resto del servidor sigue normal.
  autotestR2();
});