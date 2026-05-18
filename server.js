import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const app = express();
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const STORE_ID = "7597872";
const ACCESS_TOKEN = "657a5d5af8780cd0304f2652e5122b651c60b66c";
const TN_CLIENT_SECRET = process.env.TN_CLIENT_SECRET || "";
const headers = {
  Authentication: `bearer ${ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:wtZlEaHjqrFUMslzmlbzGsAYOGHbXUis@postgres.railway.internal:5432/railway",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

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
      numero TEXT, cliente TEXT, telefono TEXT,
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
  store_id TEXT,
  numero TEXT,
  estado_tn TEXT,
  payment_status TEXT,
  total NUMERIC,
  contact_email TEXT,
  contact_name TEXT,
  contact_phone TEXT,
  data JSONB,
  tn_created_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id SERIAL PRIMARY KEY,
  event_type TEXT NOT NULL,
  resource_id BIGINT NOT NULL,
  signature TEXT NOT NULL,
  processed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(event_type, resource_id, signature)
);
  `);
  console.log("DB inicializada");
}
initDB().catch(console.error);
function fechaHoy() {
  const hoy = new Date();
  return `${String(hoy.getDate()).padStart(2,"0")}/${String(hoy.getMonth()+1).padStart(2,"0")}/${hoy.getFullYear()}`;
}

function fechaVencimiento(dias = 30) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
}

// TIENDA NUBE
app.get("/api/orders", async (req, res) => {
  try {
    const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/orders`, { headers });
    res.json(r.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error conectando con Tienda Nube" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`, { headers });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo productos" });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/categories`, { headers });
    res.json(r.data);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo categorías" });
  }
});

// ESTADOS
app.get("/api/estados", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos_estados");
    const estados = {};
    result.rows.forEach(r => {
      estados[r.id] = {
        estado: r.estado, repartidor: r.repartidor,
        tabManual: r.tab_manual, fechaManual: r.fecha_manual,
        franjaManual: r.franja_manual, cobrar: r.cobrar,
      };
    });
    res.json(estados);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo estados" });
  }
});

app.post("/api/estados/:id", async (req, res) => {
  const { id } = req.params;
  const { estado, repartidor, tabManual, fechaManual, franjaManual, cobrar } = req.body;
  try {
    await pool.query(`
      INSERT INTO pedidos_estados (id, estado, repartidor, tab_manual, fecha_manual, franja_manual, cobrar, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
      ON CONFLICT (id) DO UPDATE SET
        estado=EXCLUDED.estado, repartidor=EXCLUDED.repartidor,
        tab_manual=EXCLUDED.tab_manual, fecha_manual=EXCLUDED.fecha_manual,
        franja_manual=EXCLUDED.franja_manual, cobrar=EXCLUDED.cobrar, updated_at=NOW()
    `, [id, estado, repartidor, tabManual, fechaManual, franjaManual, cobrar]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error guardando estado" });
  }
});

// PEDIDOS MANUALES
app.get("/api/pedidos-manuales", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    const pedidos = result.rows.map(r => ({
      id: r.id, numero: r.numero, cliente: r.cliente, telefono: r.telefono,
      direccion: r.direccion, entreCalles: r.entre_calles, barrio: r.barrio,
      zona: r.zona, fecha: r.fecha, franja: r.franja,
      fechaDisplay: r.fecha, franjaDisplay: r.franja || "Sin franja",
      productos: r.productos, totalNum: Number(r.total_num), total: r.total,
      pago: r.pago, medioPago: r.medio_pago, cobrar: r.cobrar,
      tabActual: r.tab_actual, local: r.local, nota: r.nota,
      esManual: true, estado: "Por empaquetar", repartidor: "Sin asignar",
    }));
    res.json(pedidos);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo pedidos manuales" });
  }
});

app.post("/api/pedidos-manuales", async (req, res) => {
  const p = req.body;
  try {
    await pool.query(`
      INSERT INTO pedidos_manuales
        (id, numero, cliente, telefono, direccion, entre_calles, barrio, zona, fecha, franja, productos, total_num, total, pago, medio_pago, cobrar, tab_actual, local, nota)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    `, [p.id, p.numero, p.cliente, p.telefono, p.direccion, p.entreCalles, p.barrio, p.zona, p.fecha, p.franja, p.productos, p.totalNum, p.total, p.pago, p.medioPago, p.cobrar, p.tabActual, p.local, p.nota]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error guardando pedido manual" });
  }
});

// CAJA
app.post("/api/caja/apertura", async (req, res) => {
  const { local, fecha, montoInicial } = req.body;
  try {
    const existe = await pool.query("SELECT id FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    if (existe.rows.length > 0) return res.json({ ok: true, yaExiste: true });
    await pool.query("INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ($1,$2,$3)", [local, fecha, montoInicial]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'apertura','Apertura de caja',$2,$3)", [local, montoInicial, fecha]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error en apertura de caja" });
  }
});

app.get("/api/caja/estado/:local/:fecha", async (req, res) => {
  const { local, fecha } = req.params;
  try {
    const apertura = await pool.query("SELECT * FROM caja_aperturas WHERE local=$1 AND fecha=$2", [local, fecha]);
    const movimientos = await pool.query("SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC", [local, fecha]);
    res.json({ apertura: apertura.rows[0] || null, movimientos: movimientos.rows });
  } catch (err) {
    res.status(500).json({ error: "Error trayendo estado de caja" });
  }
});

app.post("/api/caja/ajuste", async (req, res) => {
  const { local, fecha, tipo, concepto, monto } = req.body;
  try {
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)", [local, tipo, concepto, monto, fecha]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error registrando ajuste" });
  }
});

app.post("/api/caja/cierre", async (req, res) => {
  const { local, fecha, montoCierre } = req.body;
  try {
    await pool.query("UPDATE caja_aperturas SET cerrada=true, monto_cierre=$1 WHERE local=$2 AND fecha=$3", [montoCierre, local, fecha]);
    await pool.query("INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'cierre','Cierre Z',$2,$3)", [local, montoCierre, fecha]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error en cierre de caja" });
  }
});

// FACTURACIÓN
const TF_APIKEY = "72026";
const TF_APITOKEN = "f3e0ae8012f40c58d93b5c0333ae634b";
const TF_USERTOKEN = "686753022f9690813f6166450767316fffb6b8c1867cf5db2b3ba5f7211d5d84";
const TF_PDV = "00007";
const TF_CUIT_EMISOR = process.env.TF_CUIT_EMISOR || "30712271503";

function esNotaCredito(f) {
  return String(f.tipo || "").toUpperCase().includes("NOTA DE CREDITO");
}

function obtenerFacturaActiva(facturas) {
  const facturasEmitidas = facturas.filter(f => !esNotaCredito(f));
  const notasCredito = facturas.filter(f => esNotaCredito(f));
  if (facturasEmitidas.length > notasCredito.length) {
    return facturasEmitidas[facturasEmitidas.length - 1];
  }
  return null;
}

function numeroSinPuntoVenta(numero) {
  const s = String(numero || "");
  if (s.includes("-")) {
    const partes = s.split("-");
    return partes[partes.length - 1].replace(/^0+/, "") || partes[partes.length - 1];
  }
  return s.replace(/^0+/, "") || s;
}

function puntoVentaDesdeNumero(numero) {
  const s = String(numero || "");
  if (s.includes("-")) {
    return s.split("-")[0].replace(/^0+/, "") || String(Number(TF_PDV));
  }
  return String(Number(TF_PDV));
}
app.get("/api/facturas/:pedidoId", async (req, res) => {
  const { pedidoId } = req.params;
  try {
    const result = await pool.query(
      "SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC",
      [pedidoId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error trayendo facturas:", err.message);
    res.status(500).json({ error: "Error trayendo facturas" });
  }
});
app.post("/api/facturar", async (req, res) => {
  const { pedidoId, tipo, cliente, documentoTipo, documentoNro, razonSocial, domicilio, email, total, productos } = req.body;

  const esFacturaA = tipo === "FACTURA A";
  const esExento = tipo === "FACTURA B EXENTO";
  const sinDatos = !documentoNro || String(documentoNro).trim() === "";

  // Parsear total desde cualquier formato: "$43.140", "43140.00", 43140
  const totalNum = (() => {
    const raw = String(total).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return Number(raw.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", "."));
  })();

  console.log("FACTURAR:", { tipo, total, totalNum, documentoNro, sinDatos });

  if (!totalNum || totalNum <= 0) {
    return res.json({ ok: false, error: "Total inválido: " + total });
  }
// Bloqueo de duplicados en backend
  try {
    const existentes = await pool.query(
      "SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC",
      [pedidoId]
    );
    const facturaActiva = obtenerFacturaActiva(existentes.rows);
    if (facturaActiva) {
      return res.json({
        ok: false,
        yaFacturado: true,
        error: "Este pedido ya tiene una factura activa. Primero anulala con nota de crédito.",
        factura: facturaActiva,
      });
    }
  } catch (err) {
    console.error("Error validando factura existente:", err.message);
    return res.status(500).json({ ok: false, error: "Error validando si el pedido ya estaba facturado" });
  }
  const tipoComprobante = esFacturaA ? "FACTURA A" : "FACTURA B";

  const clienteObj = (sinDatos && !esFacturaA) ? {
    documento_tipo: "DNI",
    documento_nro: "0",
    razon_social: "Consumidor Final",
    email: "",
    domicilio: "Sin domicilio",
    provincia: "2",
    condicion_pago: "201",
    condicion_iva: "CF",
    condicion_iva_operacion: "CF",
    envia_por_mail: "N",
    reclama_deuda: "N",
  } : {
    documento_tipo: documentoTipo,
    documento_nro: String(documentoNro).trim() || "0",
    razon_social: razonSocial || cliente,
    email: email || "",
    domicilio: domicilio || "Sin domicilio",
    provincia: "2",
    condicion_pago: "201",
    condicion_iva: esFacturaA ? "RI" : "CF",
    condicion_iva_operacion: esFacturaA ? "RI" : "CF",
    envia_por_mail: email ? "S" : "N",
    reclama_deuda: "N",
  };

  const descripcion = productos.map(p => p.descripcion).join(", ").substring(0, 200);
  const precioSinIva = esExento ? totalNum : Math.round((totalNum / 1.21) * 100) / 100;

  const detalle = [{
    cantidad: 1,
    bonificacion_porcentaje: 0,
    afecta_stock: "N",
    producto: {
      descripcion,
      codigo: "VENTA",
      lista_precios: "standard",
      leyenda: "",
      unidad_bulto: 1,
      alicuota: esExento ? 0 : 21,
      precio_unitario_sin_iva: precioSinIva,
      actualiza_precio: "S",
    },
  }];

  const body = {
    apitoken: TF_APITOKEN,
    usertoken: TF_USERTOKEN,
    apikey: TF_APIKEY,
    cliente: clienteObj,
    comprobante: {
      fecha: fechaHoy(),
      vencimiento: fechaVencimiento(30),
      tipo: tipoComprobante,
      operacion: "V",
      moneda: "PES",
      cotizacion: 1,
      punto_venta: TF_PDV,
      rubro: "Alimentos y bebidas",
      rubro_grupo_contable: "Alimentos",
      bonificacion: 0,
      total: totalNum,
      external_reference: String(pedidoId) || `pedido-${Date.now()}`,
      detalle,
    },
  };

  console.log("TF body:", JSON.stringify(body, null, 2));

  try {
    const response = await axios.post(
      "https://www.tusfacturas.app/app/api/v2/facturacion/nuevo",
      body,
      { headers: { "Content-Type": "application/json" } }
    );
    const data = response.data;
    console.log("TF response:", JSON.stringify(data));
    if (data.error === "N") {
      await pool.query(`
        INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [pedidoId, tipo, data.comprobante_nro, data.cae, data.vencimiento_cae,
          clienteObj.razon_social, clienteObj.documento_tipo, clienteObj.documento_nro,
          totalNum, data.comprobante_pdf_url || "", fechaHoy(), JSON.stringify(data)]);
      res.json({ ok: true, data });
    } else {
      res.json({ ok: false, error: data.errores || data });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/nota-credito", async (req, res) => {
  const { facturaId, pedidoId } = req.body;

  try {
    const facturaRes = await pool.query(
      "SELECT * FROM facturas WHERE id=$1 AND pedido_id=$2",
      [facturaId, pedidoId]
    );

    if (facturaRes.rows.length === 0) {
      return res.json({ ok: false, error: "Factura no encontrada para este pedido" });
    }

    const factura = facturaRes.rows[0];

    const todasRes = await pool.query(
      "SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at ASC",
      [pedidoId]
    );

    const facturaActiva = obtenerFacturaActiva(todasRes.rows);

    if (!facturaActiva || Number(facturaActiva.id) !== Number(factura.id)) {
      return res.json({ ok: false, error: "Esta factura ya no está activa o ya fue anulada." });
    }

    const tipoFacturaOriginal = String(factura.tipo).includes("FACTURA A") ? "FACTURA A" : "FACTURA B";
    const tipoNC = tipoFacturaOriginal === "FACTURA A" ? "NOTA DE CREDITO A" : "NOTA DE CREDITO B";
    const totalNum = Number(factura.total);
    const esExento = String(factura.tipo).includes("EXENTO");
    const precioSinIva = esExento ? totalNum : Math.round((totalNum / 1.21) * 100) / 100;

    const clienteObj = {
      documento_tipo: factura.documento_tipo || "DNI",
      documento_nro: factura.documento_nro || "0",
      razon_social: factura.cliente || "Consumidor Final",
      email: "",
      domicilio: "Sin domicilio",
      provincia: "2",
      condicion_pago: "201",
      condicion_iva: tipoFacturaOriginal === "FACTURA A" ? "RI" : "CF",
      condicion_iva_operacion: tipoFacturaOriginal === "FACTURA A" ? "RI" : "CF",
      envia_por_mail: "N",
      reclama_deuda: "N",
    };

    const body = {
      apitoken: TF_APITOKEN,
      usertoken: TF_USERTOKEN,
      apikey: TF_APIKEY,
      cliente: clienteObj,
      comprobante: {
        fecha: fechaHoy(),
        vencimiento: fechaVencimiento(30),
        tipo: tipoNC,
        operacion: "V",
        moneda: "PES",
        cotizacion: 1,
        punto_venta: TF_PDV,
        rubro: "Alimentos y bebidas",
        rubro_grupo_contable: "Alimentos",
        bonificacion: 0,
        total: totalNum,
        external_reference: `${pedidoId}-NC-${factura.id}`,
        comprobantes_asociados: [{
          tipo_comprobante: tipoFacturaOriginal,
          punto_venta: puntoVentaDesdeNumero(factura.numero),
          numero: numeroSinPuntoVenta(factura.numero),
          comprobante_fecha: factura.fecha,
          cuit: TF_CUIT_EMISOR,
        }],
        detalle: [{
          cantidad: 1,
          bonificacion_porcentaje: 0,
          afecta_stock: "N",
          producto: {
            descripcion: `Anulación de ${tipoFacturaOriginal} Nº ${factura.numero}`,
            codigo: "NC",
            lista_precios: "standard",
            leyenda: "",
            unidad_bulto: 1,
            alicuota: esExento ? 0 : 21,
            precio_unitario_sin_iva: precioSinIva,
            actualiza_precio: "N",
          },
        }],
      },
    };

    const response = await axios.post(
      "https://www.tusfacturas.app/app/api/v2/facturacion/nuevo",
      body,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;

    if (data.error === "N") {
      await pool.query(`
        INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        pedidoId, tipoNC, data.comprobante_nro, data.cae, data.vencimiento_cae,
        clienteObj.razon_social, clienteObj.documento_tipo, clienteObj.documento_nro,
        totalNum, data.comprobante_pdf_url || "", fechaHoy(), JSON.stringify(data),
      ]);
      return res.json({ ok: true, data });
    }

    return res.json({ ok: false, error: data.errores || data });

  } catch (err) {
    console.error("Error emitiendo nota de crédito:", err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.response?.data || err.message });
  }
});
app.get("/api/caja/historial/:local", async (req, res) => {
  const { local } = req.params;
  try {
    const aperturas = await pool.query(
      "SELECT * FROM caja_aperturas WHERE local=$1 ORDER BY fecha DESC LIMIT 30",
      [decodeURIComponent(local)]
    );
    const resultado = [];
    for (const apertura of aperturas.rows) {
      const movimientos = await pool.query(
        "SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC",
        [decodeURIComponent(local), apertura.fecha]
      );
      resultado.push({ apertura, movimientos: movimientos.rows });
    }
    res.json(resultado);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: "Error trayendo historial" });
  }
});
app.post("/api/pedidos/productos/:id", async (req, res) => {
  const { id } = req.params;
  const { productos, totalNum } = req.body;
  try {
    await pool.query(
      `INSERT INTO pedidos_productos (pedido_id, productos, total_num)
       VALUES ($1, $2, $3)
       ON CONFLICT (pedido_id) DO UPDATE SET productos=$2, total_num=$3`,
      [id, productos, totalNum]
    );
    res.json({ ok: true });
  } catch(err) {
    console.error(err.message);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/pedidos/productos/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query("SELECT * FROM pedidos_productos WHERE pedido_id=$1", [id]);
    res.json(result.rows[0] || null);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
// ============================
// WEBHOOKS TIENDA NUBE
// ============================

function verifyTNSignature(rawBody, signature) {
  if (!TN_CLIENT_SECRET || !signature || !rawBody) return false;
  const expected = crypto
    .createHmac("sha256", TN_CLIENT_SECRET)
    .update(rawBody)
    .digest("hex");
  try {
    const sigBuf = Buffer.from(signature, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

async function upsertOrderFromTN(orderId) {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/orders/${orderId}`,
      { headers }
    );
    const o = response.data;
    await pool.query(`
      INSERT INTO pedidos_tn
        (id, store_id, numero, estado_tn, payment_status, total,
         contact_email, contact_name, contact_phone, data, tn_created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (id) DO UPDATE SET
        numero = EXCLUDED.numero,
        estado_tn = EXCLUDED.estado_tn,
        payment_status = EXCLUDED.payment_status,
        total = EXCLUDED.total,
        contact_email = EXCLUDED.contact_email,
        contact_name = EXCLUDED.contact_name,
        contact_phone = EXCLUDED.contact_phone,
        data = EXCLUDED.data,
        updated_at = NOW()
    `, [
      o.id, String(o.store_id || ""), o.number || null, o.status || null,
      o.payment_status || null, parseFloat(o.total) || 0,
      o.contact_email || null, o.contact_name || null, o.contact_phone || null,
      JSON.stringify(o), o.created_at || null
    ]);
    console.log(`Pedido TN ${orderId} sincronizado`);
  } catch (err) {
    console.error(`Error sincronizando pedido ${orderId}:`, err.response?.data || err.message);
  }
}

async function processWebhookEvent(event, resourceId) {
  if (!event || !resourceId) return;
  if (event === "order/cancelled" || event === "order/voided") {
    await pool.query(
      "UPDATE pedidos_tn SET estado_tn = 'cancelled', updated_at = NOW() WHERE id = $1",
      [resourceId]
    );
    return;
  }
  if (event.startsWith("order/")) {
    await upsertOrderFromTN(resourceId);
  }
}

app.get("/api/webhooks/tiendanube", (req, res) => {
  res.json({ ok: true, message: "Webhook endpoint activo" });
});

app.post("/api/webhooks/tiendanube", async (req, res) => {
  try {
    const signature = req.headers["x-linkedstore-hmac-sha256"];
    if (!verifyTNSignature(req.rawBody, signature)) {
      console.warn("Webhook con firma inválida");
      return res.status(401).json({ error: "Invalid signature" });
    }
    const { event, id: resourceId } = req.body || {};
    if (!event || !resourceId) {
      return res.status(400).json({ error: "Payload inválido" });
    }
    try {
      await pool.query(
        `INSERT INTO webhook_events (event_type, resource_id, signature) VALUES ($1, $2, $3)`,
        [event, resourceId, signature]
      );
    } catch (err) {
      if (err.code === "23505") {
        console.log(`Webhook duplicado ignorado: ${event} ${resourceId}`);
        return res.json({ ok: true, duplicate: true });
      }
      throw err;
    }
    res.json({ ok: true });
    processWebhookEvent(event, resourceId).catch(err => {
      console.error("Error procesando webhook:", err);
    });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: err.message });
  }
});
// ============================
// ADMIN WEBHOOKS TIENDA NUBE
// ============================

const WEBHOOK_URL = "https://piccadely-panel-production.up.railway.app/api/webhooks/tiendanube";
const WEBHOOK_EVENTS = [
  "order/created",
  "order/paid",
  "order/updated",
  "order/cancelled",
  "order/voided"
];

app.get("/api/admin/webhooks", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`,
      { headers }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post("/api/admin/webhooks/setup", async (req, res) => {
  try {
    const existing = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`,
      { headers }
    );
    const existingHooks = existing.data || [];
    const created = [];
    const skipped = [];

    for (const event of WEBHOOK_EVENTS) {
      const exists = existingHooks.find(h => h.event === event && h.url === WEBHOOK_URL);
      if (exists) {
        skipped.push({ event, id: exists.id });
        continue;
      }
      try {
        const response = await axios.post(
          `https://api.tiendanube.com/2025-03/${STORE_ID}/webhooks`,
          { event, url: WEBHOOK_URL },
          { headers: { ...headers, "Content-Type": "application/json" } }
        );
        created.push({ event, id: response.data.id });
      } catch (err) {
        created.push({ event, error: err.response?.data || err.message });
      }
    }
    res.json({ ok: true, created, skipped });
  } catch (err) {
    res.status(500).json({ error: err.response?.data || err.message });
  }
});
app.listen(process.env.PORT || 3001, () => {
  console.log("Servidor corriendo");
});