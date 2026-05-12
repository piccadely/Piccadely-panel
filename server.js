import express from "express";
import cors from "cors";
import axios from "axios";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors({ origin: "*" }));
app.use(express.json());

const STORE_ID = "7597872";
const ACCESS_TOKEN = "657a5d5af8780cd0304f2652e5122b651c60b66c";

const headers = {
  Authentication: `bearer ${ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:wtZlEaHjqrFUMslzmlbzGsAYOGHbXUis@postgres.railway.internal:5432/railway",
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// Crear tablas si no existen
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pedidos_estados (
      id TEXT PRIMARY KEY,
      estado TEXT DEFAULT 'Por empaquetar',
      repartidor TEXT DEFAULT 'Sin asignar',
      tab_manual TEXT,
      fecha_manual TEXT,
      franja_manual TEXT,
      cobrar BOOLEAN DEFAULT false,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pedidos_manuales (
      id TEXT PRIMARY KEY,
      numero TEXT,
      cliente TEXT,
      telefono TEXT,
      direccion TEXT,
      entre_calles TEXT,
      barrio TEXT,
      zona TEXT,
      fecha TEXT,
      franja TEXT,
      productos TEXT,
      total_num NUMERIC,
      total TEXT,
      pago TEXT,
      medio_pago TEXT,
      cobrar BOOLEAN DEFAULT false,
      tab_actual TEXT,
      local TEXT,
      nota TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  CREATE TABLE IF NOT EXISTS caja_movimientos (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL,
      tipo TEXT NOT NULL,
      concepto TEXT,
      monto NUMERIC NOT NULL,
      fecha TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS caja_aperturas (
      id SERIAL PRIMARY KEY,
      local TEXT NOT NULL,
      fecha TEXT NOT NULL,
      monto_inicial NUMERIC DEFAULT 0,
      cerrada BOOLEAN DEFAULT false,
      monto_cierre NUMERIC,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log("DB inicializada");
}

initDB().catch(console.error);

// TIENDA NUBE
app.get("/api/orders", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/orders`,
      { headers }
    );
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error conectando con Tienda Nube" });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`,
      { headers }
    );
    res.json(response.data);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo productos" });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/categories`,
      { headers }
    );
    res.json(response.data);
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
        estado: r.estado,
        repartidor: r.repartidor,
        tabManual: r.tab_manual,
        fechaManual: r.fecha_manual,
        franjaManual: r.franja_manual,
        cobrar: r.cobrar,
      };
    });
    res.json(estados);
  } catch (err) {
    console.error(err);
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
        estado = EXCLUDED.estado,
        repartidor = EXCLUDED.repartidor,
        tab_manual = EXCLUDED.tab_manual,
        fecha_manual = EXCLUDED.fecha_manual,
        franja_manual = EXCLUDED.franja_manual,
        cobrar = EXCLUDED.cobrar,
        updated_at = NOW()
    `, [id, estado, repartidor, tabManual, fechaManual, franjaManual, cobrar]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error guardando estado" });
  }
});

// PEDIDOS MANUALES
app.get("/api/pedidos-manuales", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pedidos_manuales ORDER BY created_at DESC");
    const pedidos = result.rows.map(r => ({
      id: r.id,
      numero: r.numero,
      cliente: r.cliente,
      telefono: r.telefono,
      direccion: r.direccion,
      entreCalles: r.entre_calles,
      barrio: r.barrio,
      zona: r.zona,
      fecha: r.fecha,
      franja: r.franja,
      fechaDisplay: r.fecha,
      franjaDisplay: r.franja || "Sin franja",
      productos: r.productos,
      totalNum: Number(r.total_num),
      total: r.total,
      pago: r.pago,
      medioPago: r.medio_pago,
      cobrar: r.cobrar,
      tabActual: r.tab_actual,
      local: r.local,
      nota: r.nota,
      esManual: true,
      estado: "Por empaquetar",
      repartidor: "Sin asignar",
    }));
    res.json(pedidos);
  } catch (err) {
    console.error(err);
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
    console.error(err);
    res.status(500).json({ error: "Error guardando pedido manual" });
  }
});
// CAJA - Apertura
app.post("/api/caja/apertura", async (req, res) => {
  const { local, fecha, montoInicial } = req.body;
  try {
    const existe = await pool.query(
      "SELECT id FROM caja_aperturas WHERE local=$1 AND fecha=$2",
      [local, fecha]
    );
    if (existe.rows.length > 0) {
      return res.json({ ok: true, yaExiste: true });
    }
    await pool.query(
      "INSERT INTO caja_aperturas (local, fecha, monto_inicial) VALUES ($1,$2,$3)",
      [local, fecha, montoInicial]
    );
    await pool.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'apertura','Apertura de caja',$2,$3)",
      [local, montoInicial, fecha]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error en apertura de caja" });
  }
});

// CAJA - Estado del día
app.get("/api/caja/estado/:local/:fecha", async (req, res) => {
  const { local, fecha } = req.params;
  try {
    const apertura = await pool.query(
      "SELECT * FROM caja_aperturas WHERE local=$1 AND fecha=$2",
      [local, fecha]
    );
    const movimientos = await pool.query(
      "SELECT * FROM caja_movimientos WHERE local=$1 AND fecha=$2 ORDER BY created_at ASC",
      [local, fecha]
    );
    res.json({
      apertura: apertura.rows[0] || null,
      movimientos: movimientos.rows,
    });
  } catch (err) {
    res.status(500).json({ error: "Error trayendo estado de caja" });
  }
});

// CAJA - Ajuste
app.post("/api/caja/ajuste", async (req, res) => {
  const { local, fecha, tipo, concepto, monto } = req.body;
  try {
    await pool.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,$2,$3,$4,$5)",
      [local, tipo, concepto, monto, fecha]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Error registrando ajuste" });
  }
});

// CAJA - Cierre Z
app.post("/api/caja/cierre", async (req, res) => {
  const { local, fecha, montoCierre } = req.body;
  try {
    await pool.query(
      "UPDATE caja_aperturas SET cerrada=true, monto_cierre=$1 WHERE local=$2 AND fecha=$3",
      [montoCierre, local, fecha]
    );
    await pool.query(
      "INSERT INTO caja_movimientos (local, tipo, concepto, monto, fecha) VALUES ($1,'cierre','Cierre Z',$2,$3)",
      [local, montoCierre, fecha]
    );
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
const TF_CUIT = "30712271503";

// Tabla para guardar comprobantes emitidos
async function initFacturas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS facturas (
      id SERIAL PRIMARY KEY,
      pedido_id TEXT,
      tipo TEXT,
      numero TEXT,
      cae TEXT,
      vencimiento_cae TEXT,
      cliente TEXT,
      documento_tipo TEXT,
      documento_nro TEXT,
      total NUMERIC,
      pdf_url TEXT,
      fecha TEXT,
      datos_raw JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initFacturas().catch(console.error);

app.post("/api/facturar", async (req, res) => {
  const { pedidoId, tipo, cliente, documentoTipo, documentoNro, razonSocial, domicilio, email, total, productos, fecha } = req.body;

  // Determinar condición IVA del cliente
  const condicionCliente = documentoTipo === "CUIT" ? "RI" : "CF";

  // Determinar tipo de comprobante TusFacturas
  let tipoComprobante;
  if (tipo === "FACTURA A") tipoComprobante = "FACTURA A";
  else if (tipo === "FACTURA B") tipoComprobante = "FACTURA B";
  else if (tipo === "FACTURA B EXENTO") tipoComprobante = "FACTURA B";
  else if (tipo === "TICKET X") tipoComprobante = "TICKET";
  else tipoComprobante = "FACTURA B";

  // Calcular precio sin IVA (precio con IVA / 1.21)
  const totalNum = Number(total);
  const esExento = tipo === "FACTURA B EXENTO";
  const alicuota = esExento ? 0 : 21;
  const precioSinIva = esExento ? totalNum : Number((totalNum / 1.21).toFixed(2));

  const hoy = new Date();
const dd = String(hoy.getDate()).padStart(2, "0");
const mm = String(hoy.getMonth() + 1).padStart(2, "0");
const aaaa = hoy.getFullYear();
const fechaFormateada = fecha || `${dd}/${mm}/${aaaa}`;
  const body = {
    apitoken: TF_APITOKEN,
    usertoken: TF_USERTOKEN,
    apikey: TF_APIKEY,
    cliente: {
      documento_tipo: documentoTipo,
      documento_nro: documentoNro || "0",
      razon_social: razonSocial || cliente,
      email: email || "",
      domicilio: domicilio || "Sin domicilio",
      provincia: "2",
      condicion_pago: "201",
      condicion_iva: condicionCliente,
      condicion_iva_operacion: condicionCliente,
      envia_por_mail: email ? "S" : "N",
      reclama_deuda: "N",
    },
    comprobante: {const vencimiento = new Date(hoy);
vencimiento.setDate(vencimiento.getDate() + 30);
const venc = `${String(vencimiento.getDate()).padStart(2,"0")}/${String(vencimiento.getMonth()+1).padStart(2,"0")}/${vencimiento.getFullYear()}`;
      fecha: fechaFormateada,
      tipo: tipoComprobante,
      operacion: "V",
      moneda: "PES",
      cotizacion: 1,
      punto_venta: TF_PDV,
      rubro: "Alimentos y bebidas",
      rubro_grupo_contable: "Alimentos",
      detalle: productos.map(p => ({
        cantidad: p.cantidad,
        producto: {
          descripcion: p.descripcion,
          codigo: p.codigo || "001",
          lista_precios: "standard",
          leyenda: "",
          unidad_bulto: 1,
          alicuota,
          precio_unitario_sin_iva: Number((p.precioTotal / p.cantidad / (esExento ? 1 : 1.21)).toFixed(2)),
          actualiza_precio: "S",
        },
        bonificacion_porcentaje: 0,
        afecta_stock: "N",
      })),
      bonificacion: 0,
      external_reference: pedidoId || `pedido-${Date.now()}`,
    },
  };

  try {
    const response = await axios.post(
      "https://www.tusfacturas.app/app/api/v2/facturacion/nuevo",
      body,
      { headers: { "Content-Type": "application/json" } }
    );

    const data = response.data;

    if (data.error === "N") {
      // Guardar en DB
      await pool.query(`
        INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        pedidoId, tipo, data.comprobante_nro, data.cae, data.vencimiento_cae,
        razonSocial || cliente, documentoTipo, documentoNro, totalNum,
        data.comprobante_pdf_url || "", fechaFormateada, JSON.stringify(data)
      ]);
      res.json({ ok: true, data });
    } else {
      res.json({ ok: false, error: data.errores || data });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/facturas/:pedidoId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM facturas WHERE pedido_id=$1 ORDER BY created_at DESC",
      [req.params.pedidoId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Error trayendo facturas" });
  }
});

app.post("/api/nota-credito", async (req, res) => {
  const { facturaId, pedidoId } = req.body;
  try {
    const result = await pool.query("SELECT * FROM facturas WHERE id=$1", [facturaId]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Factura no encontrada" });
    const factura = result.rows[0];
    const datosOriginales = factura.datos_raw;

    const tipoNC = factura.tipo === "FACTURA A" ? "NOTA DE CREDITO A" : "NOTA DE CREDITO B";

    const body = {
      apitoken: TF_APITOKEN,
      usertoken: TF_USERTOKEN,
      apikey: TF_APIKEY,
      cliente: {
        documento_tipo: factura.documento_tipo,
        documento_nro: factura.documento_nro,
        razon_social: factura.cliente,
        domicilio: "Sin domicilio",
        provincia: "2",
        condicion_pago: "201",
        condicion_iva: factura.documento_tipo === "CUIT" ? "RI" : "CF",
        condicion_iva_operacion: factura.documento_tipo === "CUIT" ? "RI" : "CF",
        envia_por_mail: "N",
        reclama_deuda: "N",
      },
      comprobante: {vencimiento: venc,
  
fecha: `${String(new Date().getDate()).padStart(2,"0")}/${String(new Date().getMonth()+1).padStart(2,"0")}/${new Date().getFullYear()}`,        tipo: tipoNC,
        operacion: "V",
        moneda: "PES",
        cotizacion: 1,
        punto_venta: TF_PDV,
        rubro: "Alimentos y bebidas",
        rubro_grupo_contable: "Alimentos",
        comprobantes_asociados: [{
          tipo_comprobante: factura.tipo,
          punto_venta: TF_PDV,
          numero: factura.numero,
          cae: factura.cae,
          fecha: factura.fecha,
        }],
        detalle: datosOriginales?.detalle || [{
          cantidad: 1,
          producto: {
            descripcion: "Anulación de comprobante",
            codigo: "NC001",
            lista_precios: "standard",
            leyenda: "",
            unidad_bulto: 1,
            alicuota: 21,
            precio_unitario_sin_iva: Number((Number(factura.total) / 1.21).toFixed(2)),
            actualiza_precio: "N",
          },
          bonificacion_porcentaje: 0,
          afecta_stock: "N",
        }],
        bonificacion: 0,
        external_reference: `NC-${pedidoId}-${Date.now()}`,
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
        factura.cliente, factura.documento_tipo, factura.documento_nro, -Number(factura.total),
        data.comprobante_pdf_url || "", new Date().toLocaleDateString("es-AR"), JSON.stringify(data)
      ]);
      res.json({ ok: true, data });
    } else {
      res.json({ ok: false, error: data.errores || data });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.listen(process.env.PORT || 3001, () => {
  console.log("Servidor corriendo");
});