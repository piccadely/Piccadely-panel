import express from "express";
import axios from "axios";

// ─── Config Tienda Nube ──────────────────────────────────────────────
const STORE_ID = process.env.TN_STORE_ID;
const ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const tnHeaders = {
  Authentication: `bearer ${ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};

// ─── Piccadas por nivel: categoría + qué piccadas puede usar ─────────
const PICCADA = {
  economica:  { cat: 38586676, allow: ["suttile", "giovane", "la fausta"] },        // Piccadas Divertidas
  intermedia: { cat: 38346953, allow: ["comilona", "la piccada mundial"] },         // PiccaPromos
  premium:    { cat: 38586677, allow: ["magnolia", "amistad", "anita de baires"] }, // Piccadas Il Paradiso
};
const CAT_BEBIDAS = 38347075;

// Sándwiches por nivel. comer/piccar = porciones que cubre cada unidad.
// match = se busca por nombre (en minúsculas y sin acentos).
const SANDWICH = {
  economica: [
    { match: "comilona juntadely piccan 24", excluir: "combinada", comer: 12, piccar: 24 },
    { match: "comilona juntadely piccan 12", excluir: "combinada", comer: 6,  piccar: 12 },
  ],
  intermedia: [
    { match: "caja sandwichs clasicos x 12", comer: 4, piccar: 12 },
  ],
  premium: [
    { match: "caja sandwichs premium x 12", comer: 4, piccar: 12 },
  ],
};

// Piccada vegetariana por nivel (se suma SOLO si hay vegetarianos)
const VEG = {
  economica:  { variant: true,  match: "esquesitos" },          // tiene porciones en la variante
  premium:    { variant: true,  match: "quesos del gourmet" },  // tiene porciones en la variante
  intermedia: { variant: false, match: "piccada vegetariana",   // vieja: porciones fijas por tamaño
    sizes: [ { match: "chica", comer: 1, piccar: 3 }, { match: "mediana", comer: 2, piccar: 5 } ] },
};

// Cómo se reparten las porciones entre piccada y sándwich
const MIX = {
  solo_piccadas:{ piccada: 1.0, sandwich: 0 },
  mas_piccada:  { piccada: 0.7, sandwich: 0.3 },
  equilibrado:  { piccada: 0.5, sandwich: 0.5 },
  mas_sandwich: { piccada: 0.3, sandwich: 0.7 },
};

const ETIQUETAS = { economica: "Clásica", intermedia: "Selección", premium: "Premium" };

// ─── Catálogo en vivo con caché de 5 min ─────────────────────────────
let _cache = { data: null, ts: 0 };
async function getProductos() {
  const ahora = Date.now();
  if (_cache.data && ahora - _cache.ts < 5 * 60 * 1000) return _cache.data;
  const r = await axios.get(
    `https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`,
    { headers: tnHeaders }
  );
  _cache = { data: r.data, ts: ahora };
  return r.data;
}

// ─── Helpers ─────────────────────────────────────────────────────────
const sinAcentos = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const catIds = p => (p.categories || []).map(c => c.id);
const num = x => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

// Unidades de piccada de una categoría (solo las que tienen las porciones
// escritas en la variante, ej "Grande Comen 4- Piccan 9")
function unidadesPiccada(productos, cfg, modo) {
  const unidades = [];
  for (const p of productos) {
    if (p.published === false) continue;
    if (!catIds(p).includes(cfg.cat)) continue;
    const nombre = p.name?.es || "Piccada";
    if (cfg.allow && !cfg.allow.some(a => sinAcentos(nombre).includes(a))) continue;
    for (const v of (p.variants || [])) {
      const label = (v.values || []).map(x => x?.es).filter(Boolean).join(" ");
      if (!/piccan/i.test(label)) continue;               // solo variantes con porciones
      const comer  = num((label.match(/come?n?\s*(\d+)/i) || [])[1]);
      const piccar = num((label.match(/piccan\s*(\d+)/i) || [])[1]);
      const rinde  = modo === "comer" ? comer : piccar;
      const precio = num(v.price);
      if (rinde > 0 && precio > 0) {
        unidades.push({ nombre, tamano: label, comer, piccar, rinde, precio });
      }
    }
  }
  return unidades;
}

// Unidades de sándwich del nivel (productos puntuales, por nombre)
function unidadesSandwich(productos, nivel, modo) {
  const reglas = SANDWICH[nivel] || [];
  const unidades = [];
  for (const regla of reglas) {
    const prod = productos.find(p => {
      if (p.published === false) return false;
      const n = sinAcentos(p.name?.es);
      if (!n.includes(regla.match)) return false;
      if (regla.excluir && n.includes(regla.excluir)) return false;
      return true;
    });
    if (!prod) continue;
    const precio = num((prod.variants || [])[0]?.price);
    const rinde = modo === "comer" ? regla.comer : regla.piccar;
    if (rinde > 0 && precio > 0) {
      unidades.push({
        nombre: prod.name?.es,
        tamano: modo === "comer" ? `comen ${regla.comer}` : `piccan ${regla.piccar}`,
        comer: regla.comer, piccar: regla.piccar, rinde, precio,
      });
    }
  }
  return unidades;
}

// Unidades de la piccada vegetariana del nivel
function unidadesVeg(productos, nivel, modo) {
  const cfg = VEG[nivel];
  if (!cfg) return [];
  const unidades = [];
  if (cfg.variant) {
    const prod = productos.find(p => p.published !== false && sinAcentos(p.name?.es) === cfg.match);
    if (prod) {
      for (const v of (prod.variants || [])) {
        const label = (v.values || []).map(x => x?.es).filter(Boolean).join(" ");
        if (!/piccan/i.test(label)) continue;
        const comer = num((label.match(/come?n?\s*(\d+)/i) || [])[1]);
        const piccar = num((label.match(/piccan\s*(\d+)/i) || [])[1]);
        const rinde = modo === "comer" ? comer : piccar;
        const precio = num(v.price);
        if (rinde > 0 && precio > 0) unidades.push({ nombre: prod.name.es, tamano: label, comer, piccar, rinde, precio });
      }
    }
  } else {
    for (const sz of cfg.sizes) {
      const prod = productos.find(p => {
        const n = sinAcentos(p.name?.es);
        return p.published !== false && n.includes(cfg.match) && n.includes(sz.match);
      });
      if (!prod) continue;
      const precio = num((prod.variants || [])[0]?.price);
      const rinde = modo === "comer" ? sz.comer : sz.piccar;
      if (rinde > 0 && precio > 0)
        unidades.push({ nombre: prod.name.es, tamano: `${sz.match} (come ${sz.comer} / piccan ${sz.piccar})`, comer: sz.comer, piccar: sz.piccar, rinde, precio });
    }
  }
  return unidades;
}

// Combinación de MENOR COSTO que cubra >= objetivo porciones (DP)
function cubrirMenorCosto(unidades, objetivo) {
  if (objetivo <= 0 || unidades.length === 0) return { items: [], total: 0 };
  const costo = new Array(objetivo + 1).fill(Infinity);
  const elegido = new Array(objetivo + 1).fill(-1);
  costo[0] = 0;
  for (let j = 1; j <= objetivo; j++) {
    for (let u = 0; u < unidades.length; u++) {
      const prev = Math.max(0, j - unidades[u].rinde);
      if (costo[prev] + unidades[u].precio < costo[j]) {
        costo[j] = costo[prev] + unidades[u].precio;
        elegido[j] = u;
      }
    }
  }
  const conteo = {};
  let j = objetivo;
  while (j > 0 && elegido[j] >= 0) {
    const u = elegido[j];
    conteo[u] = (conteo[u] || 0) + 1;
    j = Math.max(0, j - unidades[u].rinde);
  }
  const items = Object.entries(conteo).map(([u, cant]) => {
    const un = unidades[u];
    return {
      nombre: un.nombre, tamano: un.tamano, cantidad: cant,
      precioUnitario: un.precio, subtotal: un.precio * cant, rinde: un.rinde * cant,
    };
  });
  const total = items.reduce((a, i) => a + i.subtotal, 0);
  return { items, total };
}

function bebidasDisponibles(productos) {
  return productos
    .filter(p => p.published !== false && catIds(p).includes(CAT_BEBIDAS))
    .map(p => ({ id: p.id, nombre: p.name?.es, precio: num((p.variants || [])[0]?.price) }))
    .filter(b => b.precio > 0);
}

// ─── Router ──────────────────────────────────────────────────────────
export function cotizadorRouter(pool) {
  const router = express.Router();

  // Calcular las 3 opciones
  router.post("/cotizador/calcular", async (req, res) => {
    try {
      const personas = parseInt(req.body.personas, 10);
      const vegetarianos = Math.max(0, Math.min(parseInt(req.body.vegetarianos, 10) || 0, personas || 0));
      const modo = req.body.modo === "comer" ? "comer" : "piccar";
      const mixKey = MIX[req.body.mix] ? req.body.mix : "equilibrado";
      if (!personas || personas < 1)
        return res.status(400).json({ error: "Cantidad de personas inválida" });

      const productos = await getProductos();
      const mix = MIX[mixKey];
      const noVeg = personas - vegetarianos;                 // a estos los cubre la comida regular
      const objPiccada = Math.ceil(noVeg * mix.piccada);
      const objSandwich = Math.ceil(noVeg * mix.sandwich);

      const opciones = [];
      for (const nivel of ["economica", "intermedia", "premium"]) {
        const piccada  = cubrirMenorCosto(unidadesPiccada(productos, PICCADA[nivel], modo), objPiccada);
        const sandwich = cubrirMenorCosto(unidadesSandwich(productos, nivel, modo), objSandwich);
        const veg = vegetarianos > 0
          ? cubrirMenorCosto(unidadesVeg(productos, nivel, modo), vegetarianos)
          : { items: [], total: 0 };
        const total = piccada.total + sandwich.total + veg.total;
        opciones.push({
          nivel, etiqueta: ETIQUETAS[nivel],
          piccadas: piccada.items, sandwiches: sandwich.items, vegetarianas: veg.items,
          total, porPersona: personas ? Math.round(total / personas) : 0,
        });
      }

      res.json({
        personas, vegetarianos, modo, mix: mixKey,
        objetivoPiccada: objPiccada, objetivoSandwich: objSandwich,
        opciones, bebidas: bebidasDisponibles(productos),
      });
    } catch (err) {
      console.error("Error /cotizador/calcular:", err.response?.data || err.message);
      res.status(500).json({ error: "Error al calcular la cotización", detalle: err.message });
    }
  });

  // Guardar una cotización (lo que el cliente eligió + canal)
  router.post("/cotizaciones", async (req, res) => {
    try {
      const b = req.body || {};
      const canal = b.canal === "whatsapp" ? "whatsapp" : "solicitar";
      const q = await pool.query(
        `INSERT INTO cotizaciones
          (cliente_nombre, empresa, email, telefono,
           personas, modo, mix, fecha_evento, zona,
           nivel_elegido, opciones, total_elegido, con_bebidas, canal, estado, notas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pendiente',$15)
         RETURNING id, creada_en`,
        [
          b.cliente_nombre || null, b.empresa || null, b.email || null, b.telefono || null,
          b.personas || null, b.modo || null, b.mix || null, b.fecha_evento || null, b.zona || null,
          b.nivel_elegido || null, b.opciones ? JSON.stringify(b.opciones) : null,
          b.total_elegido || null, !!b.con_bebidas, canal, b.notas || null,
        ]
      );
      res.json({ ok: true, id: q.rows[0].id, creada_en: q.rows[0].creada_en });
    } catch (err) {
      console.error("Error guardando cotización:", err.message);
      res.status(500).json({ error: "Error al guardar la cotización" });
    }
  });

  // Listar cotizaciones (para el panel)
  router.get("/cotizaciones", async (req, res) => {
    try {
      const q = await pool.query("SELECT * FROM cotizaciones ORDER BY creada_en DESC LIMIT 500");
      res.json(q.rows);
    } catch (err) {
      console.error("Error listando cotizaciones:", err.message);
      res.status(500).json({ error: "Error al listar cotizaciones" });
    }
  });

  return router;
}