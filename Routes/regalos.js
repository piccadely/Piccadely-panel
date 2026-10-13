// ─────────────────────────────────────────────────────────────────────
//  Routes/regalos.js  ·  Cotizador de Regalos Empresariales (public/regalos.html)
//  Montar en server.js:  app.use("/api/regalos", regalosRouter(pool, mailTransporter));
//    GET  /api/regalos/catalogo   → productos publicados con stock, agrupados por estilo + tarifas de envío
//    POST /api/regalos/calcular   → recalcula TODO server-side (precios de TN, descuento, envío, total)
//    POST /api/regalos/propuesta  → recalcula, guarda el lead en `cotizaciones` (origen 'regalos') y avisa por mail
//  Catálogo: Routes/tnCatalogo.js (el mismo caché que el cotizador de eventos). Precio = promocional si
//  existe y es menor que price (lo que cobra TN en el checkout); si no, price.
//  Envío: tabla por partido de data/localidades_cobertura.json (la misma del bot). Nada hardcodeado en el front.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import fs from "fs";
import { getCatalogoTN, limpiarDescripcion } from "./tnCatalogo.js";
import { clienteKeyDe } from "./cotizador.js";

// Descuento por volumen según la cantidad de REGALOS (las bebidas no cuentan para el tramo, pero se descuentan).
export const TRAMOS_REGALOS = [{ min: 5, pct: 5 }, { min: 15, pct: 10 }, { min: 25, pct: 15 }];
const REGALOS_POR_VIAJE = 15;                 // 'uno': un envío cada 15 regalos físicos
const PARTIDO_GBA_REFERENCIA = "San Isidro";  // 'varios': tarifa de referencia para GBA (= Vicente López, $5.000)
const MAX_CANTIDAD = 10000;

// Estilos → categoría de TN (por NOMBRE, sin tildes ni mayúsculas).
const ESTILOS = [
  { id: "giftcard", nombre: "GiftCards", cat: "giftcards", digital: true },
  { id: "desayuno", nombre: "Desayunos", cat: "desayunos", padre: "desayunos y dulces" },
  { id: "caja", nombre: "Cajas de regalo", cat: "cajas de regalos" },
  { id: "chica", nombre: "Piccadas chicas", cat: "piccadas para regalar", tamano: "chica" },
  { id: "mediana", nombre: "Piccadas medianas", cat: "piccadas para regalar", tamano: "mediana" },
  { id: "bebida", nombre: "Bebidas", cat: "bebidas para regalar", extra: true },
];

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
const txt = (x) => (x && typeof x === "object" ? x.es || x.pt || Object.values(x)[0] : x) || "";
const pesos = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-AR");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── Tarifas de envío (CABA + partidos con cobertura) desde la tabla del bot ──
function cargarTarifas() {
  const datos = JSON.parse(fs.readFileSync(new URL("../data/localidades_cobertura.json", import.meta.url), "utf8"));
  const porPartido = new Map();
  for (const v of Object.values(datos)) for (const o of (Array.isArray(v) ? v : [v])) if (o.cobertura) porPartido.set(o.partido, o.costo);
  if (!porPartido.has("CABA")) throw new Error("La tabla de cobertura no tiene CABA");
  if (!porPartido.has(PARTIDO_GBA_REFERENCIA)) throw new Error(`La tabla de cobertura no tiene ${PARTIDO_GBA_REFERENCIA}`);
  const partidos = [...porPartido].filter(([p]) => p !== "CABA").map(([partido, costo]) => ({ partido, costo }))
    .sort((a, b) => a.partido.localeCompare(b.partido, "es"));
  return { caba: porPartido.get("CABA"), partidos, porPartido, gbaReferencia: { partido: PARTIDO_GBA_REFERENCIA, costo: porPartido.get(PARTIDO_GBA_REFERENCIA) } };
}
let _tarifas = null;
const tarifas = () => (_tarifas ||= cargarTarifas());

// ── Catálogo de regalos (se rearma cuando cambia el caché de TN) ──
const precioDe = (v) => {
  const ok = (x) => x !== null && x !== undefined && String(x).trim() !== "" && Number(x) > 0;
  if (!ok(v.price)) return null;
  const p = Number(v.price);
  return ok(v.promotional_price) && Number(v.promotional_price) < p ? { precio: Number(v.promotional_price), antes: p } : { precio: p, antes: null };
};
const conStock = (v) => !v.stock_management || Number(v.stock) > 0;
const etiquetaDe = (v) => (v.values || []).map(txt).filter(Boolean).join(" / ");
const fotoDe = (p, v) => (v.image_id && (p.images || []).find((i) => i.id === v.image_id)?.src) || p.images?.[0]?.src || "";

let _armado = { ts: -1, catalogo: null };
export function armarCatalogoRegalos({ productos, categorias }) {
  const nombreCat = (id) => norm(txt(categorias.find((c) => c.id === id)?.name));
  const items = [], avisos = [];
  const estilos = ESTILOS.map((e) => {
    let ids = categorias.filter((c) => norm(txt(c.name)) === e.cat && (!e.padre || nombreCat(c.parent) === e.padre)).map((c) => c.id);
    if (!ids.length && e.padre) ids = categorias.filter((c) => norm(txt(c.name)) === e.cat).map((c) => c.id);   // sin padre: por nombre solo
    if (!ids.length) avisos.push(`categoría "${e.cat}" no encontrada en Tienda Nube`);
    const propios = [];
    for (const p of productos) {
      if (p.published === false || !(p.categories || []).some((c) => ids.includes(c.id))) continue;
      for (const v of p.variants || []) {
        const pr = precioDe(v);
        if (!pr || !conStock(v)) continue;
        const variante = etiquetaDe(v);
        if (e.tamano && !norm(variante).startsWith(e.tamano)) continue;
        propios.push({
          product_id: p.id, variant_id: v.id, estilo: e.id,
          nombre: txt(p.name), variante,
          descripcion: limpiarDescripcion(txt(p.description)),
          precio: pr.precio, precio_antes: pr.antes, foto: fotoDe(p, v),
          digital: !!e.digital, extra: !!e.extra,
        });
      }
    }
    if (ids.length && !propios.length) avisos.push(`"${e.nombre}" no tiene productos publicados con precio y stock`);
    items.push(...propios);
    return { id: e.id, nombre: e.nombre, extra: !!e.extra, digital: !!e.digital, items: propios };
  });
  return { estilos, porVariante: new Map(items.map((i) => [String(i.variant_id), i])), avisos };
}

async function catalogoRegalos() {
  const tn = await getCatalogoTN();
  if (_armado.ts !== tn.ts) {
    _armado = { ts: tn.ts, catalogo: armarCatalogoRegalos(tn) };
    for (const a of _armado.catalogo.avisos) console.warn("Regalos:", a);
  }
  return _armado.catalogo;
}

// ── Cálculo (server-side, nunca con precios del front) ──
const entero = (x, max = MAX_CANTIDAD) => { const n = Number(x); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; };

export function calcularRegalos(catalogo, body, tar = tarifas()) {
  const errores = [];
  const cantidades = new Map();
  for (const it of (Array.isArray(body?.items) ? body.items : []).slice(0, 200)) {
    const id = String(it?.variant_id ?? "");
    const q = entero(it?.cantidad);
    if (!q) continue;
    if (!catalogo.porVariante.has(id)) { errores.push(`Producto ${id} no disponible`); continue; }
    cantidades.set(id, (cantidades.get(id) || 0) + q);
  }
  const lineas = [...cantidades].map(([id, cantidad]) => {
    const i = catalogo.porVariante.get(id);
    return { variant_id: i.variant_id, product_id: i.product_id, nombre: i.nombre, variante: i.variante, estilo: i.estilo,
      digital: i.digital, extra: i.extra, foto: i.foto, cantidad, precio: i.precio, precio_antes: i.precio_antes, subtotal: i.precio * cantidad };
  });
  const regalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.cantidad, 0);
  const fisicos = lineas.filter((l) => !l.extra && !l.digital).reduce((a, l) => a + l.cantidad, 0);
  const subtotalRegalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.subtotal, 0);
  const subtotalBebidas = lineas.filter((l) => l.extra).reduce((a, l) => a + l.subtotal, 0);
  const tramo = [...TRAMOS_REGALOS].sort((a, b) => b.min - a.min).find((t) => regalos >= t.min) || null;
  const descuento = tramo ? Math.round((subtotalRegalos + subtotalBebidas) * tramo.pct / 100) : 0;

  // Envío (las giftcards no suman: van por mail)
  const e = body?.entrega || {};
  const modo = e.modo === "varios" ? "varios" : "uno";
  let envio = 0, envioDetalle = null;
  if (fisicos > 0) {
    if (modo === "uno") {
      const zona = String(e.zona || "CABA");
      const tarifa = zona === "CABA" ? tar.caba : tar.porPartido.get(zona);
      if (tarifa == null) errores.push(`Zona de entrega no reconocida: ${zona}`);
      else {
        const viajes = Math.ceil(fisicos / REGALOS_POR_VIAJE);
        envio = tarifa * viajes;
        envioDetalle = { modo, zona, tarifa, viajes };
      }
    } else {
      const nCaba = entero(e.nCaba) ?? 0, nGba = entero(e.nGba) ?? 0;
      envio = nCaba * tar.caba + nGba * tar.gbaReferencia.costo;
      envioDetalle = { modo, nCaba, nGba, tarifaCaba: tar.caba, tarifaGba: tar.gbaReferencia.costo, partidoGbaReferencia: tar.gbaReferencia.partido };
    }
  }
  const total = subtotalRegalos + subtotalBebidas - descuento + envio;
  const cantidadRegalos = entero(body?.cantidadRegalos) ?? regalos;
  return {
    lineas, regalos, fisicos, cantidadRegalos,
    faltan: Math.max(0, cantidadRegalos - regalos), sobran: Math.max(0, regalos - cantidadRegalos),
    subtotalRegalos, subtotalBebidas, tramo, descuento,
    envio, envioEstimado: modo === "varios" && fisicos > 0, envioDetalle,
    total, porRegalo: regalos ? Math.round(total / regalos) : 0,
    ...(errores.length ? { errores } : {}),
  };
}

// ── Mail al equipo ──
async function notificarRegalos(mailTransporter, lead) {
  if (!mailTransporter) return;
  try {
    const c = lead.calculo, ent = c.envioDetalle;
    const entregaTxt = !ent ? "Sin envío (solo giftcards)"
      : ent.modo === "uno" ? `Todos a un mismo lugar · ${ent.zona}${lead.direccion ? " · " + lead.direccion : ""} · ${ent.viajes} viaje(s)`
      : `Cada uno a su casa · ${ent.nCaba} en CABA + ${ent.nGba} en GBA (estimado)`;
    const html = `
      <h2>🎁 Nueva propuesta de regalos empresariales #${lead.id}</h2>
      <p><b>${lead.canal === "whatsapp" ? "📲 Cerró por WhatsApp" : "📄 Pidió la propuesta"}</b></p>
      <p><b>Cliente:</b> ${esc(lead.cliente_nombre)}${lead.empresa ? " · " + esc(lead.empresa) : ""}${lead.cuit ? " · CUIT " + esc(lead.cuit) : ""}${lead.facturaA ? " · <b>Factura A</b>" : ""}<br>
         <b>Email:</b> ${esc(lead.email)} &nbsp;·&nbsp; <b>Tel:</b> ${esc(lead.telefono || "-")}</p>
      <p><b>${c.regalos} regalos</b>${c.cantidadRegalos !== c.regalos ? ` (pidió ${c.cantidadRegalos})` : ""}${lead.fecha ? " · 📅 " + esc(lead.fecha) : ""}<br>
         <b>Entrega:</b> ${esc(entregaTxt)}</p>
      <ul>${c.lineas.map((l) => `<li>${l.cantidad}× ${esc(l.nombre)}${l.variante ? " (" + esc(l.variante) + ")" : ""} · ${pesos(l.subtotal)}</li>`).join("")}</ul>
      <p>Regalos ${pesos(c.subtotalRegalos)}${c.subtotalBebidas ? " · Bebidas " + pesos(c.subtotalBebidas) : ""}${c.descuento ? ` · Descuento ${c.tramo.pct}% −${pesos(c.descuento)}` : ""} · Envío ${pesos(c.envio)}${c.envioEstimado ? " (estimado)" : ""}<br>
         <b>Total: ${pesos(c.total)}</b> (${pesos(c.porRegalo)} por regalo)</p>
      <p><b>Tarjeta:</b> ${lead.tarjeta?.conMensaje ? `con mensaje: “${esc(lead.tarjeta.mensaje || "")}”` : "sin mensaje"}${lead.tarjetaPropia ? " · <b>envía su tarjeta personal</b>" : ""}</p>
      <p style="color:#999;font-size:12px">Piccadely · Cotizador de Regalos Empresariales</p>`;
    await mailTransporter.sendMail({
      from: `Piccadely <${process.env.GMAIL_USER}>`,
      to: "yus@piccadely.com",
      subject: `🎁 Regalos empresariales #${lead.id} · ${lead.empresa || lead.cliente_nombre} · ${c.regalos} regalos · ${pesos(c.total)}`,
      html,
    });
  } catch (e) {
    console.error("Regalos: error enviando el mail:", e.message);
  }
}

// ── Anti-spam de /propuesta (público y manda mail) ──
// Rate limit en memoria (una sola réplica): máx. LIMITE_PROPUESTAS leads guardados por IP cada VENTANA_MS.
// IP: el ÚLTIMO valor de X-Forwarded-For (lo agrega el proxy de Railway; los anteriores los puede inventar
// el cliente), o la del socket si no hay proxy.
const LIMITE_PROPUESTAS = 5;
const VENTANA_MS = 10 * 60 * 1000;
const _propuestasPorIp = new Map();   // ip → [timestamps]
export function ipDe(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket?.remoteAddress || "desconocida");
}
function propuestasRecientes(ip, ahora = Date.now()) {
  const lista = (_propuestasPorIp.get(ip) || []).filter((t) => ahora - t < VENTANA_MS);
  if (lista.length) _propuestasPorIp.set(ip, lista); else _propuestasPorIp.delete(ip);
  return lista;
}
// Se cuentan solo las propuestas GUARDADAS (un error de validación no consume intentos).
const registrarPropuesta = (ip) => _propuestasPorIp.set(ip, [...propuestasRecientes(ip), Date.now()]);
setInterval(() => { for (const ip of [..._propuestasPorIp.keys()]) propuestasRecientes(ip); }, VENTANA_MS).unref();
// Honeypot: campo oculto en el formulario; una persona nunca lo completa.
const CAMPO_HONEYPOT = "sitio_web";

// ── Router ──
export function regalosRouter(pool, mailTransporter) {
  const router = express.Router();
  // Solo 3 rutas, ninguna devuelve leads: GET /catalogo, POST /calcular, POST /propuesta.

  router.get("/catalogo", async (req, res) => {
    try {
      const cat = await catalogoRegalos();
      const tar = tarifas();
      res.json({
        estilos: cat.estilos,
        tramos: TRAMOS_REGALOS,
        envio: { caba: tar.caba, partidos: tar.partidos, gbaReferencia: tar.gbaReferencia, regalosPorViaje: REGALOS_POR_VIAJE },
      });
    } catch (e) {
      console.error("Regalos: error armando el catálogo:", e.message);
      res.status(502).json({ error: "No pudimos traer el catálogo. Probá de nuevo en un rato." });
    }
  });

  router.post("/calcular", async (req, res) => {
    try {
      res.json(calcularRegalos(await catalogoRegalos(), req.body || {}));
    } catch (e) {
      console.error("Regalos: error calculando:", e.message);
      res.status(502).json({ error: "No pudimos calcular la propuesta." });
    }
  });

  router.post("/propuesta", async (req, res) => {
    const b = req.body || {};
    // Honeypot lleno → bot: se responde OK y se descarta en silencio (sin guardar ni mandar mail).
    if (String(b[CAMPO_HONEYPOT] || "").trim()) {
      console.warn("Regalos: propuesta descartada por honeypot.");
      return res.json({ ok: true, id: null });
    }
    const ip = ipDe(req);
    if (propuestasRecientes(ip).length >= LIMITE_PROPUESTAS) {
      console.warn("Regalos: rate limit de propuestas alcanzado.");
      return res.status(429).json({ error: "Recibimos varias propuestas seguidas desde tu conexión. Esperá unos minutos o escribinos por WhatsApp." });
    }
    const nombre = String(b.cliente?.nombre || "").trim().slice(0, 120);
    const email = String(b.cliente?.email || "").trim().slice(0, 160);
    if (!nombre || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Completá tu nombre y un email válido." });
    try {
      const calculo = calcularRegalos(await catalogoRegalos(), b);
      if (!calculo.lineas.some((l) => !l.extra)) return res.status(400).json({ error: "Sumá al menos un regalo." });
      if (calculo.errores) return res.status(400).json({ error: calculo.errores.join(". ") });
      const canal = b.canal === "whatsapp" ? "whatsapp" : "solicitar";
      const corto = (x, n) => (x == null ? null : String(x).trim().slice(0, n) || null);
      const lead = {
        cliente_nombre: nombre, email, telefono: corto(b.cliente?.telefono, 40),
        empresa: corto(b.empresa, 120), cuit: corto(b.cuit, 20), facturaA: !!b.facturaA,
        fecha: corto(b.fecha, 20), direccion: corto(b.entrega?.direccion, 200),
        tarjeta: { conMensaje: !!b.tarjeta?.conMensaje, mensaje: corto(b.tarjeta?.mensaje, 500) },
        tarjetaPropia: !!b.tarjetaPropia, canal, calculo,
      };
      const ent = calculo.envioDetalle;
      const zona = !ent ? null : ent.modo === "uno" ? ent.zona : `Varios: ${ent.nCaba} CABA / ${ent.nGba} GBA`;
      // `opciones` lleva el detalle completo del lead (shape propio de regalos: { tipo: "regalos", ... }).
      const opciones = {
        tipo: "regalos", lineas: calculo.lineas, entrega: { ...(ent || { modo: b.entrega?.modo === "varios" ? "varios" : "uno" }), direccion: lead.direccion },
        cantidadRegalos: calculo.cantidadRegalos, regalos: calculo.regalos,
        subtotalRegalos: calculo.subtotalRegalos, subtotalBebidas: calculo.subtotalBebidas, tramo: calculo.tramo,
        descuento: calculo.descuento, envio: calculo.envio, envioEstimado: calculo.envioEstimado,
        total: calculo.total, porRegalo: calculo.porRegalo,
        tarjeta: lead.tarjeta, tarjetaPropia: lead.tarjetaPropia, empresa: lead.empresa, cuit: lead.cuit, facturaA: lead.facturaA,
      };
      const q = await pool.query(
        `INSERT INTO cotizaciones
          (cliente_nombre, empresa, email, telefono, personas, fecha_evento, zona,
           nivel_elegido, opciones, total_elegido, con_bebidas, canal, estado, cliente_key, origen)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'regalos',$8,$9,$10,$11,'pendiente',$12,'regalos')
         RETURNING id, creada_en`,
        [lead.cliente_nombre, lead.empresa, lead.email, lead.telefono, calculo.regalos, lead.fecha, zona,
         JSON.stringify(opciones), calculo.total, calculo.subtotalBebidas > 0, canal, clienteKeyDe(lead.email, lead.telefono)]
      );
      const id = q.rows[0].id;
      registrarPropuesta(ip);
      notificarRegalos(mailTransporter, { ...lead, id });
      res.json({ ok: true, id, calculo });
    } catch (e) {
      console.error("Regalos: error guardando la propuesta:", e.message);
      res.status(500).json({ error: "No pudimos guardar la propuesta. Probá de nuevo." });
    }
  });

  return router;
}
