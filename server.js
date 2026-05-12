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

app.listen(process.env.PORT || 3001, () => {
  console.log("Servidor corriendo");
});