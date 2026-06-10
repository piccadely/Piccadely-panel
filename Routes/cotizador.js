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

// Sándwiches por nivel. Cada regla es una unidad que puede combinarse.
// Se busca por nombre (match, sin acentos) o por id de producto.
const SANDWICH = {
  economica: [
    { match: "comilona juntadely piccan 24", excluir: "combinada", comer: 12, piccar: 24 },
    { match: "comilona juntadely piccan 12", excluir: "combinada", comer: 6,  piccar: 12 },
    { id: 343790843, comer: 5, piccar: 15 },   // PiccaSandwiches de Miga (corpo)
  ],
  intermedia: [
    { match: "caja sandwichs clasicos x 12", comer: 4, piccar: 12 },
    { id: 343790843, comer: 5, piccar: 15 },   // PiccaSandwiches de Miga (corpo)
  ],
  premium: [
    { match: "caja sandwichs premium x 12", comer: 4, piccar: 12 },
    { id: 343791893, comer: 5, piccar: 15 },   // PiccaSandwiches Combinados (corpo)
  ],
};

// Piccada vegetariana por nivel (se suma SOLO si hay vegetarianos)
const VEG = {
  economica:  { variant: true,  match: "esquesitos" },
  premium:    { variant: true,  match: "quesos del gourmet" },
  intermedia: { variant: false, match: "piccada vegetariana",
    sizes: [ { match: "chica", comer: 1, piccar: 3 }, { match: "mediana", comer: 2, piccar: 5 } ] },
};

// Línea Desayuno / Merienda (solo Selección y Premium). comer = desayunan.
const DESAYUNO = {
  intermedia: { etiqueta: "Selección", items: [
    { id: 343789356, comer: 6, piccar: 10 },   // Combi Farina
    { id: 343792353, comer: 6, piccar: 10 },   // Combi Dulce
    { id: 343790843, comer: 5, piccar: 15 },   // PiccaSandwiches de Miga x40
  ]},
  premium: { etiqueta: "Premium", items: [
    { id: 343789356, comer: 6, piccar: 10 },   // Combi Farina
    { id: 343792353, comer: 6, piccar: 10 },   // Combi Dulce
    { id: 343792180, comer: 6, piccar: 10 },   // MediasLunas de Jamón y Queso
    { id: 343789644, comer: 6, piccar: 10 },   // Combi VeggieFit
    { id: 343790843, comer: 5, piccar: 15 },   // PiccaSandwiches de Miga x40
  ]},
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

function buscarProducto(productos, regla) {
  return productos.find(p => {
    if (p.published === false) return false;
    if (regla.id) return p.id === regla.id;
    const n = sinAcentos(p.name?.es);
    if (!n.includes(regla.match)) return false;
    if (regla.excluir && n.includes(regla.excluir)) return false;
    return true;
  });
}

// URL de la primera imagen del producto (Tienda Nube)
const imgDe = p => (p.images && p.images[0] && p.images[0].src) || "";

// Piccadas permitidas del nivel, agrupadas por producto (cada una con sus tamaños)
function piccadasDelNivel(productos, cfg, modo) {
  const porProducto = {};
  for (const p of productos) {
    if (p.published === false) continue;
    if (!catIds(p).includes(cfg.cat)) continue;
    const nombre = p.name?.es || "Piccada";
    if (cfg.allow && !cfg.allow.some(a => sinAcentos(nombre).includes(a))) continue;
    for (const v of (p.variants || [])) {
      const label = (v.values || []).map(x => x?.es).filter(Boolean).join(" ");
      if (!/piccan/i.test(label)) continue;
      const comer  = num((label.match(/come?n?\s*(\d+)/i) || [])[1]);
      const piccar = num((label.match(/piccan\s*(\d+)/i) || [])[1]);
      const rinde  = modo === "comer" ? comer : piccar;
      const precio = num(v.price);
      if (rinde > 0 && precio > 0) {
        (porProducto[nombre] = porProducto[nombre] || []).push({ nombre, tamano: label, comer, piccar, rinde, precio, imagen: imgDe(p) });
      }
    }
  }
  return Object.entries(porProducto).map(([nombre, unidades]) => ({ nombre, unidades }));
}

// Unidades de sándwich del nivel (se combinan por menor costo)
function unidadesSandwich(productos, nivel, modo) {
  const reglas = SANDWICH[nivel] || [];
  const unidades = [];
  for (const regla of reglas) {
    const prod = buscarProducto(productos, regla);
    if (!prod) continue;
    const precio = num((prod.variants || [])[0]?.price);
    const rinde = modo === "comer" ? regla.comer : regla.piccar;
    if (rinde > 0 && precio > 0) {
      unidades.push({
        nombre: prod.name?.es,
        tamano: modo === "comer" ? `comen ${regla.comer}` : `piccan ${regla.piccar}`,
        comer: regla.comer, piccar: regla.piccar, rinde, precio, imagen: imgDe(prod),
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
        if (rinde > 0 && precio > 0) unidades.push({ nombre: prod.name.es, tamano: label, comer, piccar, rinde, precio, imagen: imgDe(prod) });
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
        unidades.push({ nombre: prod.name.es, tamano: `${sz.match} (come ${sz.comer} / piccan ${sz.piccar})`, comer: sz.comer, piccar: sz.piccar, rinde, precio, imagen: imgDe(prod) });
    }
  }
  return unidades;
}

// Unidades de la línea Desayuno/Merienda del nivel
function unidadesDesayuno(productos, nivel, modo) {
  const cfg = DESAYUNO[nivel];
  if (!cfg) return [];
  const unidades = [];
  for (const it of cfg.items) {
    const prod = buscarProducto(productos, it);
    if (!prod) continue;
    const precio = num((prod.variants || [])[0]?.price);
    const rinde = modo === "comer" ? it.comer : it.piccar;
    if (rinde > 0 && precio > 0)
      unidades.push({
        nombre: prod.name?.es,
        tamano: modo === "comer" ? `desayunan ${it.comer}` : `piccan ${it.piccar}`,
        comer: it.comer, piccar: it.piccar, rinde, precio, imagen: imgDe(prod),
      });
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
    return { nombre: un.nombre, tamano: un.tamano, cantidad: cant, precioUnitario: un.precio, subtotal: un.precio * cant, rinde: un.rinde * cant, imagen: un.imagen };
  });
  const total = items.reduce((a, i) => a + i.subtotal, 0);
  return { items, total };
}

// Reparte el objetivo de piccadas entre VARIOS productos del nivel (variedad):
// un producto distinto cada ~12 porciones, mezclados al azar. Eventos chicos = 1 producto.
function repartirPiccadas(grupos, objetivo) {
  if (!grupos.length || objetivo <= 0) return { items: [], total: 0 };
  const pool = [...grupos].sort(() => Math.random() - 0.5);
  const K = Math.min(pool.length, Math.max(1, Math.ceil(objetivo / 12)));
  const elegidos = pool.slice(0, K);
  const base = Math.floor(objetivo / K);
  let resto = objetivo - base * K;
  let items = [], total = 0;
  for (const g of elegidos) {
    const obj = base + (resto > 0 ? 1 : 0);
    if (resto > 0) resto--;
    if (obj <= 0) continue;
    const r = cubrirMenorCosto(g.unidades, obj);
    items = items.concat(r.items);
    total += r.total;
  }
  return { items, total };
}

// Reparte el desayuno COMBINANDO varios productos (round-robin, mezclado)
function repartirDesayuno(unidades, objetivo) {
  if (!unidades.length || objetivo <= 0) return { items: [], total: 0 };
  const pool = [...unidades].sort(() => Math.random() - 0.5);
  const conteo = {};
  let cubierto = 0, k = 0, guard = 0;
  while (cubierto < objetivo && guard < 1000) {
    const i = k % pool.length;
    conteo[i] = (conteo[i] || 0) + 1;
    cubierto += (pool[i].rinde || 1);
    k++; guard++;
  }
  const items = Object.entries(conteo).map(([i, cant]) => {
    const u = pool[i];
    return { nombre: u.nombre, tamano: u.tamano, cantidad: cant, precioUnitario: u.precio, subtotal: u.precio * cant, rinde: u.rinde * cant, imagen: u.imagen };
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

// Notifica al equipo por mail cuando entra una cotización
async function notificarCotizacion(mailTransporter, cot) {
  if (!mailTransporter) return;
  try {
    const money = n => "$" + Number(n || 0).toLocaleString("es-AR");
    const elegida = (cot.opciones || []).find(o => o.nivel === cot.nivel_elegido);
    const items = elegida ? [...(elegida.piccadas || []), ...(elegida.sandwiches || []), ...(elegida.vegetarianas || [])] : [];
    const itemsHtml = items.map(i => `<li>${i.cantidad}× ${i.nombre} (${i.tamano})</li>`).join("");
    const canalTxt = cot.canal === "whatsapp" ? "📲 Cerró por WhatsApp" : "📞 Pidió que lo contacten";
    const html = `
      <h2>🎉 Nueva cotización de evento #${cot.id}</h2>
      <p><b>${canalTxt}</b></p>
      <p><b>Cliente:</b> ${cot.cliente_nombre || "-"}${cot.empresa ? " · " + cot.empresa : ""}<br>
         <b>Email:</b> ${cot.email || "-"} &nbsp;·&nbsp; <b>Tel:</b> ${cot.telefono || "-"}</p>
      <p><b>Evento:</b> ${cot.personas} personas (${cot.modo})${cot.mix ? " · " + cot.mix : ""}${cot.fecha_evento ? " · 📅 " + cot.fecha_evento : ""}${cot.zona ? " · 📍 " + cot.zona : ""}${cot.con_bebidas ? " · quiere bebidas 🥤" : ""}</p>
      <p><b>Opción elegida:</b> ${elegida ? elegida.etiqueta : (cot.nivel_elegido || "-")} &nbsp;·&nbsp; <b>${money(cot.total_elegido)}</b></p>
      ${items.length ? "<ul>" + itemsHtml + "</ul>" : ""}
      <p style="color:#999;font-size:12px">Piccadely · Cotizador de Eventos</p>`;
    await mailTransporter.sendMail({
      from: `Piccadely <${process.env.GMAIL_USER}>`,
      to: "yus@piccadely.com",
      subject: `🎉 Nueva cotización #${cot.id} · ${cot.cliente_nombre || "cliente"} · ${money(cot.total_elegido)}`,
      html,
    });
  } catch (e) {
    console.error("Error enviando mail de cotización:", e.message);
  }
}

// ─── Router ──────────────────────────────────────────────────────────
export function cotizadorRouter(pool, mailTransporter) {
  const router = express.Router();

  router.post("/cotizador/calcular", async (req, res) => {
    try {
      const personas = parseInt(req.body.personas, 10);
      const modo = req.body.modo === "comer" ? "comer" : "piccar";
      const tipo = req.body.tipo === "desayuno" ? "desayuno" : "evento";
      if (!personas || personas < 1)
        return res.status(400).json({ error: "Cantidad de personas inválida" });

      const productos = await getProductos();

      // ── Línea Desayuno / Merienda (Selección + Premium) ──
      if (tipo === "desayuno") {
        const opciones = ["intermedia", "premium"].map(nivel => {
          const cfg = DESAYUNO[nivel];
          const rep = repartirDesayuno(unidadesDesayuno(productos, nivel, modo), personas);
          return {
            nivel, etiqueta: cfg.etiqueta,
            piccadas: rep.items, sandwiches: [], vegetarianas: [],
            total: rep.total, porPersona: personas ? Math.round(rep.total / personas) : 0,
          };
        });
        return res.json({ personas, modo, tipo, opciones, bebidas: bebidasDisponibles(productos) });
      }

      // ── Línea Picadas / Evento (Clásica + Selección + Premium) ──
      const vegetarianos = Math.max(0, Math.min(parseInt(req.body.vegetarianos, 10) || 0, personas));
      const mixKey = MIX[req.body.mix] ? req.body.mix : "equilibrado";
      const mix = MIX[mixKey];
      const noVeg = personas - vegetarianos;
      const objPiccada = Math.ceil(noVeg * mix.piccada);
      const objSandwich = Math.ceil(noVeg * mix.sandwich);

      const niveles = ["economica", "intermedia", "premium"];
      const opciones = niveles.map(nivel => {
        const grupos = piccadasDelNivel(productos, PICCADA[nivel], modo);
        const piccada  = repartirPiccadas(grupos, objPiccada); // reparte entre varias piccadas (variedad)
        const sandwich = cubrirMenorCosto(unidadesSandwich(productos, nivel, modo), objSandwich);
        const veg = vegetarianos > 0 ? cubrirMenorCosto(unidadesVeg(productos, nivel, modo), vegetarianos) : { items: [], total: 0 };
        const total = piccada.total + sandwich.total + veg.total;
        return {
          nivel, etiqueta: ETIQUETAS[nivel],
          piccadas: piccada.items, sandwiches: sandwich.items, vegetarianas: veg.items,
          total, porPersona: personas ? Math.round(total / personas) : 0,
        };
      });

      res.json({
        personas, vegetarianos, modo, mix: mixKey, tipo,
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
      const nuevaId = q.rows[0].id;
      notificarCotizacion(mailTransporter, { ...b, id: nuevaId, canal });
      res.json({ ok: true, id: nuevaId, creada_en: q.rows[0].creada_en });
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

  // Actualizar estado / notas de una cotización (panel)
  router.patch("/cotizaciones/:id", async (req, res) => {
    try {
      const { estado, notas } = req.body || {};
      const campos = [], vals = [];
      let i = 1;
      if (estado !== undefined) { campos.push(`estado = $${i++}`); vals.push(estado); }
      if (notas !== undefined) { campos.push(`notas = $${i++}`); vals.push(notas); }
      if (campos.length === 0) return res.status(400).json({ error: "Nada para actualizar" });
      vals.push(req.params.id);
      const q = await pool.query(`UPDATE cotizaciones SET ${campos.join(", ")} WHERE id = $${i} RETURNING id`, vals);
      if (q.rowCount === 0) return res.status(404).json({ error: "No encontrada" });
      res.json({ ok: true });
    } catch (err) {
      console.error("Error actualizando cotización:", err.message);
      res.status(500).json({ error: "Error al actualizar la cotización" });
    }
  });

  // Proxy de imágenes de Tienda Nube → base64 (para el PDF, evita problemas de CORS)
  router.get("/cotizador/img", async (req, res) => {
    try {
      const u = String(req.query.u || "");
      if (!/^https:\/\/[\w.-]*mitiendanube\.com\//i.test(u)) {
        return res.status(400).json({ error: "URL no permitida" });
      }
      const img = await axios.get(u, { responseType: "arraybuffer", timeout: 8000 });
      const ct = img.headers["content-type"] || "image/jpeg";
      const b64 = Buffer.from(img.data).toString("base64");
      res.json({ dataUrl: `data:${ct};base64,${b64}` });
    } catch (err) {
      res.status(502).json({ error: "No se pudo cargar la imagen" });
    }
  });

  return router;
}
