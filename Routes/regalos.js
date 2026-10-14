// ─────────────────────────────────────────────────────────────────────
//  Routes/regalos.js  ·  Cotizador de Regalos Empresariales (public/regalos.html)
//  Montar en server.js:  app.use("/api/regalos", regalosRouter(pool, mailTransporter));
//    GET  /api/regalos/catalogo   → SELECCIÓN CURADA (data/regalos_config.json) con precio/foto/stock en vivo + tarifas de envío
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

// ── Selección curada (data/regalos_config.json): QUÉ se muestra. Precio, foto y stock salen en vivo de TN ──
// Estilos con tarjetas (una por opción de la config); cada tarjeta tiene sus variantes de TN (selector de
// tamaño si hay más de una). Ítems virtuales (sin producto en TN): precio fijo o monto libre validado acá.
// Bebidas: siguen saliendo por categoría de TN ("Bebidas para Regalar"), como add-on.
const MAX_MONTO_LIBRE = 5000000;   // tope de cordura para la giftcard de monto libre
let _config = null;
export const configRegalos = () => (_config ||= JSON.parse(fs.readFileSync(new URL("../data/regalos_config.json", import.meta.url), "utf8")));

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

const precioDe = (v) => {
  const ok = (x) => x !== null && x !== undefined && String(x).trim() !== "" && Number(x) > 0;
  if (!ok(v.price)) return null;
  const p = Number(v.price);
  return ok(v.promotional_price) && Number(v.promotional_price) < p ? { precio: Number(v.promotional_price), antes: p } : { precio: p, antes: null };
};
const conStock = (v) => !v.stock_management || Number(v.stock) > 0;
const etiquetaDe = (v) => (v.values || []).map(txt).filter(Boolean).join(" / ");
const fotoDe = (p, v) => (v?.image_id && (p.images || []).find((i) => i.id === v.image_id)?.src) || p.images?.[0]?.src || "";

let _armado = { ts: -1, catalogo: null };
export function armarCatalogoRegalos({ productos, categorias }, config = configRegalos()) {
  const avisos = [];
  const porVariante = new Map();   // variant_id (o "v:<clave>" para virtuales) → datos para calcular
  const publicados = productos.filter((p) => p.published !== false);
  // Nombres de variante para MOSTRAR (config.etiquetas_variantes, ej. "Extra Grande" → "XL"). El lead guarda el original.
  const mapaEtiquetas = new Map(Object.entries(config.etiquetas_variantes || {}).filter(([k]) => !k.startsWith("_")).map(([k, v]) => [norm(k), v]));
  const mostrar = (etiqueta) => mapaEtiquetas.get(norm(etiqueta)) || etiqueta;
  const tieneTamano = (p, tamano) => (p.variants || []).some((v) => norm(etiquetaDe(v)).startsWith(tamano));

  // Nombre "contiene" (sin tildes ni mayúsculas). Con tamaño, solo productos que lo tengan. Varios → exacto, si no el más corto.
  const buscar = (termino, tamano) => {
    const q = norm(termino);
    let cands = publicados.filter((p) => norm(txt(p.name)).includes(q));
    if (tamano) cands = cands.filter((p) => tieneTamano(p, tamano));
    if (!cands.length) return null;
    const exacto = cands.find((p) => norm(txt(p.name)) === q);
    if (exacto) return exacto;
    if (cands.length > 1) avisos.push(`"${termino}" coincide con varios productos (${cands.map((p) => txt(p.name)).join(", ")}): se usa el de nombre más corto`);
    return [...cands].sort((a, b) => txt(a.name).length - txt(b.name).length)[0];
  };

  const tarjetaVirtual = (e, it) => {
    const id = `v:${it.clave}`;
    const libre = !!it.montoLibre;
    if (!libre && !(Number(it.precio) > 0)) { avisos.push(`ítem virtual "${it.clave}" sin precio válido: se omite`); return null; }
    const minimo = libre && Number(it.minimo) > 0 ? Number(it.minimo) : null;
    porVariante.set(id, { variant_id: id, product_id: null, sinProductoTN: true, montoLibre: libre, minimo, opcion: it.titulo, nombre: it.nombre || it.titulo,
      variante: "", estilo: e.id, digital: !!e.digital, extra: false, foto: "", precio: libre ? null : Number(it.precio), precio_antes: null });
    return { clave: it.clave, titulo: it.titulo, producto: it.nombre || it.titulo, descripcion: it.descripcion || "", foto: "", virtual: true, montoLibre: libre, minimo,
      variantes: [{ variant_id: id, etiqueta: "", precio: libre ? null : Number(it.precio), precio_antes: null, foto: "" }] };
  };

  const tarjetaTN = (e, it, p) => {
    const variantes = [];
    for (const v of p.variants || []) {
      const pr = precioDe(v);
      if (!pr || !conStock(v)) continue;
      const etiqueta = etiquetaDe(v);
      if (e.tamano && !norm(etiqueta).startsWith(e.tamano)) continue;
      const id = String(v.id), foto = fotoDe(p, v);
      variantes.push({ variant_id: id, etiqueta, mostrar: mostrar(etiqueta), precio: pr.precio, precio_antes: pr.antes, foto });
      porVariante.set(id, { variant_id: id, product_id: p.id, opcion: it.titulo, nombre: txt(p.name), variante: etiqueta, variante_mostrar: mostrar(etiqueta), estilo: e.id,
        digital: !!e.digital, extra: !!e.extra, foto, precio: pr.precio, precio_antes: pr.antes });
    }
    if (!variantes.length) { avisos.push(`"${txt(p.name)}" (${e.nombre} · ${it.titulo}) no tiene variantes${e.tamano ? " " + e.tamano : ""} con precio y stock: se omite`); return null; }
    return { clave: it.clave, titulo: it.titulo, producto: txt(p.name), product_id: p.id, descripcion: limpiarDescripcion(txt(p.description)),
      foto: variantes[0].foto || fotoDe(p), variantes };
  };

  const estilos = (config.estilos || []).map((e) => {
    const grupos = (e.grupos || [{ titulo: null, items: e.items || [] }]).map((g) => ({
      titulo: g.titulo || null,
      tarjetas: (g.items || []).map((it) => {
        if (it.virtual) return tarjetaVirtual(e, it);
        const p = buscar(it.producto, e.tamano);
        if (!p) { avisos.push(`"${it.producto}" (${e.nombre} · ${it.titulo}) no está publicado en Tienda Nube${e.tamano ? " con tamaño " + e.tamano : ""}: se omite`); return null; }
        return tarjetaTN(e, it, p);
      }).filter(Boolean),
    })).filter((g) => g.tarjetas.length);
    return { id: e.id, nombre: e.nombre, digital: !!e.digital, extra: false, grupos };
  });

  // Bebidas: por categoría de TN (add-on, no cuentan como regalo).
  const b = config.bebidas;
  if (b) {
    const ids = (categorias || []).filter((c) => norm(txt(c.name)) === norm(b.categoria)).map((c) => c.id);
    if (!ids.length) avisos.push(`categoría "${b.categoria}" no encontrada en Tienda Nube`);
    const e = { id: b.id || "bebida", nombre: b.nombre || "Bebidas", extra: true };
    const tarjetas = publicados.filter((p) => (p.categories || []).some((c) => ids.includes(c.id)))
      .map((p) => tarjetaTN(e, { clave: `beb-${p.id}`, titulo: txt(p.name) }, p)).filter(Boolean);
    if (ids.length && !tarjetas.length) avisos.push(`"${b.categoria}" no tiene productos publicados con precio y stock`);
    estilos.push({ id: e.id, nombre: e.nombre, digital: false, extra: true, grupos: tarjetas.length ? [{ titulo: null, tarjetas }] : [] });
  }
  return { estilos, porVariante, avisos };
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
// Solo se aceptan variantes de la selección curada (+ bebidas) e ítems virtuales con su regla.
const entero = (x, max = MAX_CANTIDAD) => { const n = Number(x); return Number.isInteger(n) && n >= 0 && n <= max ? n : null; };

export function calcularRegalos(catalogo, body, tar = tarifas()) {
  const errores = [];
  const acumulado = new Map();   // variant_id (+ monto si es libre) → { item, precio, cantidad }
  for (const it of (Array.isArray(body?.items) ? body.items : []).slice(0, 200)) {
    const id = String(it?.variant_id ?? "");
    const q = entero(it?.cantidad);
    if (!q) continue;
    const item = catalogo.porVariante.get(id);
    if (!item) { errores.push(`Producto ${id} no disponible`); continue; }
    let precio = item.precio;
    if (item.montoLibre) {
      const m = Number(it?.monto);
      if (!Number.isInteger(m) || m <= 0 || m > MAX_MONTO_LIBRE || (item.minimo && m < item.minimo)) {
        errores.push(item.minimo ? `El monto de la ${item.nombre.toLowerCase()} tiene que ser un número entero de al menos ${pesos(item.minimo)}`
          : `El monto de la ${item.nombre.toLowerCase()} tiene que ser un número entero mayor a 0`);
        continue;
      }
      precio = m;
    }
    const clave = item.montoLibre ? `${id}|${precio}` : id;
    const prev = acumulado.get(clave);
    acumulado.set(clave, { item, precio, cantidad: (prev?.cantidad || 0) + q });
  }
  const lineas = [...acumulado.values()].map(({ item: i, precio, cantidad }) => ({
    variant_id: i.variant_id, product_id: i.product_id, opcion: i.opcion, nombre: i.nombre,
    variante: i.montoLibre ? pesos(precio) : i.variante, variante_mostrar: i.montoLibre ? pesos(precio) : (i.variante_mostrar || i.variante), estilo: i.estilo, digital: i.digital, extra: i.extra, foto: i.foto,
    ...(i.sinProductoTN ? { sinProductoTN: true } : {}), ...(i.montoLibre ? { monto: precio } : {}),
    cantidad, precio, precio_antes: i.precio_antes, subtotal: precio * cantidad,
  }));
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
      <ul>${c.lineas.map((l) => `<li>${l.cantidad}× ${l.opcion && l.opcion !== l.nombre ? esc(l.opcion) + " · " : ""}${esc(l.nombre)}${l.variante ? " (" + esc(l.variante) + ")" : ""} · ${pesos(l.subtotal)}${l.sinProductoTN ? " <i>(sin producto en TN)</i>" : ""}</li>`).join("")}</ul>
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
