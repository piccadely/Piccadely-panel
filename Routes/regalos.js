// ─────────────────────────────────────────────────────────────────────
//  Routes/regalos.js  ·  Cotizador de Regalos Empresariales (public/regalos.html)
//  Montar en server.js:  app.use("/api/regalos", regalosRouter(pool, mailTransporter));
//    GET  /api/regalos/catalogo   → SELECCIÓN CURADA (data/regalos_config.json) con precio/foto/stock en vivo + tarifas de envío de REFERENCIA
//    POST /api/regalos/calcular   → recalcula TODO server-side (precios de TN, descuento, total). El ENVÍO NO SE SUMA:
//                                   la entrega se guarda solo como dato del lead y las tarifas van aparte, como referencia
//    POST /api/regalos/propuesta  → recalcula, guarda el lead en `cotizaciones` (origen 'regalos') y avisa por mail
//    /calcular y /propuesta con { modo: "calendario", fechas: [...] } → Calendario anual: varias fechas, precios de
//    HOY congelados para todas, descuento por el total de regalos del año (lead con opciones.tipo = "calendario")
//  Catálogo: Routes/tnCatalogo.js (el mismo caché que el cotizador de eventos). Precio = promocional si
//  existe y es menor que price (lo que cobra TN en el checkout); si no, price.
//  Envío: tarifas de referencia de data/localidades_cobertura.json (la misma tabla del bot). NO se suma al total.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import fs from "fs";
import { getCatalogoTN, limpiarDescripcion } from "./tnCatalogo.js";
import { clienteKeyDe } from "./cotizador.js";
import { esBot, ipDe, crearLimitador } from "./antispam.js";
import { crearEsperaPdf, enviarMailCliente, mailPropuestaRegalos } from "./mailCliente.js";
export { ipDe };   // antes vivía acá; se mantiene el export

// Descuento por volumen según la cantidad de REGALOS (las bebidas no cuentan para el tramo, pero se descuentan).
export const TRAMOS_REGALOS = [{ min: 5, pct: 5 }, { min: 15, pct: 10 }, { min: 25, pct: 15 }];
// Versión del CONTRATO entre esta API y public/regalos.html (/catalogo y /calcular la mandan; el front verifica
// que la soporta). REGLA para cambios de formato: la API sigue sirviendo el formato viejo Y el nuevo durante al
// menos un deploy (compatibilidad hacia atrás), así no importa si termina primero Vercel (front) o Railway (API).
// v1 = estilos[].items (hasta 99ad508) · v2 = estilos[].grupos[].tarjetas[].variantes (selección curada).
export const API_VERSION = 2;

export const TEXTO_SIN_ENVIO = "NO INCLUYE COSTO DE ENVÍO. El costo de envío se calcula de acuerdo a las áreas de entrega.";
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
  const partidos = [...porPartido].filter(([p]) => p !== "CABA").map(([partido, costo]) => ({ partido, costo }))
    .sort((a, b) => a.partido.localeCompare(b.partido, "es"));
  const costosAmba = partidos.map((p) => p.costo);
  return {
    caba: porPartido.get("CABA"), partidos, porPartido,
    referencia: { caba: porPartido.get("CABA"), ambaDesde: Math.min(...costosAmba), ambaHasta: Math.max(...costosAmba) },
  };
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
    return { clave: it.clave, titulo: it.titulo, producto: it.nombre || it.titulo, descripcion: it.descripcion || "", foto: "", ...(it.foco ? { foco: it.foco } : {}), virtual: true, montoLibre: libre, minimo,
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
        digital: !!e.digital, extra: !!e.extra, ...(e.en_caja_regalo ? { enCajaRegalo: true } : {}), foto, precio: pr.precio, precio_antes: pr.antes });
    }
    if (!variantes.length) { avisos.push(`"${txt(p.name)}" (${e.nombre} · ${it.titulo}) no tiene variantes${e.tamano ? " " + e.tamano : ""} con precio y stock: se omite`); return null; }
    return { clave: it.clave, titulo: it.titulo, producto: txt(p.name), product_id: p.id, descripcion: limpiarDescripcion(txt(p.description)),
      foto: variantes[0].foto || fotoDe(p), ...(it.foco ? { foco: it.foco } : {}), variantes };
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
    return { id: e.id, nombre: e.nombre, digital: !!e.digital, extra: false, ...(e.en_caja_regalo ? { enCajaRegalo: true } : {}), grupos };
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

// Formato v1 (front anterior a la selección curada): una entrada por variante. Los virtuales de monto libre
// no existían en v1, así que no se publican ahí. Sacarlo cuando ningún front v1 pueda seguir en uso.
function itemsV1(e) {
  return (e.grupos || []).flatMap((g) => g.tarjetas).flatMap((t) => t.variantes.filter((v) => v.precio != null).map((v) => ({
    variant_id: v.variant_id, product_id: t.product_id ?? null, estilo: e.id, nombre: t.producto, variante: v.etiqueta,
    descripcion: t.descripcion, precio: v.precio, precio_antes: v.precio_antes, foto: v.foto || t.foto, digital: !!e.digital, extra: !!e.extra,
  })));
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

// Líneas de un pedido (items del front → precios de TN de HOY). Compartido por el modo simple y el calendario.
function lineasDe(catalogo, items, errores) {
  const acumulado = new Map();   // variant_id (+ monto si es libre) → { item, precio, cantidad }
  for (const it of (Array.isArray(items) ? items : []).slice(0, 200)) {
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
  return [...acumulado.values()].map(({ item: i, precio, cantidad }) => ({
    variant_id: i.variant_id, product_id: i.product_id, opcion: i.opcion, nombre: i.nombre,
    variante: i.montoLibre ? pesos(precio) : i.variante, variante_mostrar: i.montoLibre ? pesos(precio) : (i.variante_mostrar || i.variante), estilo: i.estilo, digital: i.digital, extra: i.extra, foto: i.foto,
    ...(i.sinProductoTN ? { sinProductoTN: true } : {}), ...(i.montoLibre ? { monto: precio } : {}), ...(i.enCajaRegalo ? { enCajaRegalo: true } : {}),
    cantidad, precio, precio_antes: i.precio_antes, subtotal: precio * cantidad,
  }));
}
// Entrega: SOLO dato para el lead (no suma al total). Las tarifas van aparte, como referencia.
function entregaDe(e = {}, tar, errores) {
  const modo = e.modo === "varios" ? "varios" : "uno";
  if (modo === "uno") {
    const zona = String(e.zona || "CABA");
    if (zona !== "CABA" && !tar.porPartido.has(zona)) errores.push(`Zona de entrega no reconocida: ${zona}`);
    return { modo, zona };
  }
  return { modo, nCaba: entero(e.nCaba) ?? 0, nGba: entero(e.nGba) ?? 0 };
}
const tramoPara = (regalos) => [...TRAMOS_REGALOS].sort((a, b) => b.min - a.min).find((t) => regalos >= t.min) || null;

export function calcularRegalos(catalogo, body, tar = tarifas()) {
  const errores = [];
  const lineas = lineasDe(catalogo, body?.items, errores);
  const regalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.cantidad, 0);
  const fisicos = lineas.filter((l) => !l.extra && !l.digital).reduce((a, l) => a + l.cantidad, 0);
  const subtotalRegalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.subtotal, 0);
  const subtotalBebidas = lineas.filter((l) => l.extra).reduce((a, l) => a + l.subtotal, 0);
  const tramo = tramoPara(regalos);
  const descuento = tramo ? Math.round((subtotalRegalos + subtotalBebidas) * tramo.pct / 100) : 0;
  const envioDetalle = entregaDe(body?.entrega || {}, tar, errores);
  const total = subtotalRegalos + subtotalBebidas - descuento;   // sin envío
  const cantidadRegalos = entero(body?.cantidadRegalos) ?? regalos;
  return {
    lineas, regalos, fisicos, cantidadRegalos,
    faltan: Math.max(0, cantidadRegalos - regalos), sobran: Math.max(0, regalos - cantidadRegalos),
    subtotalRegalos, subtotalBebidas, tramo, descuento,
    incluyeEnvio: false, envioDetalle, envioReferencia: tar.referencia, avisoEnvio: TEXTO_SIN_ENVIO,
    total, porRegalo: regalos ? Math.round(total / regalos) : 0,
    ...(errores.length ? { errores } : {}),
  };
}

// ── Calendario anual (modo "calendario") ──
// Varias fechas en el año, cada una con sus regalos y su entrega. Precios de TN de HOY congelados para TODAS las
// fechas (pagando el año por adelantado). Descuento por volumen según el TOTAL de regalos del año, sobre el total anual.
export const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const esISO = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) && !Number.isNaN(Date.parse(s + "T12:00:00Z")) && new Date(s + "T12:00:00Z").toISOString().slice(0, 10) === s;
const sumarDias = (iso, n) => new Date(Date.parse(iso + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const sumarMeses = (iso, n) => {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1, 12));
  const ultimo = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();   // 29/02 → 28/02
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, ultimo), 12)).toISOString().slice(0, 10);
};
export const ddmm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const DIAS = ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"];
export const diaSemana = (iso) => DIAS[new Date(iso + "T12:00:00Z").getUTCDay()];
// Fecha comercial que cae fin de semana → se propone entregar el viernes anterior (sáb −1, dom −2).
export const entregaHabil = (iso) => { const d = new Date(iso + "T12:00:00Z").getUTCDay(); return d === 6 ? sumarDias(iso, -1) : d === 0 ? sumarDias(iso, -2) : iso; };

// Reglas del calendario para el front (y para validar): ocasiones, rango de fechas, próximas fechas comerciales, validez.
export function reglasCalendario(hoy = hoyAR(), config = configRegalos()) {
  const cal = config.calendario || {};
  const fechaMin = sumarDias(hoy, 2), fechaMax = sumarMeses(hoy, 12);
  const validezDias = Number(config.validez_propuesta_dias) > 0 ? Number(config.validez_propuesta_dias) : 7;
  // De cada fecha comercial, la próxima dentro del rango (si no hay ninguna cargada en el rango, no se ofrece).
  // `fecha` = la de ENTREGA propuesta (si el día cae fin de semana, el viernes anterior); `fechaOcasion` = el día real.
  const fechasComerciales = (cal.fechas_comerciales || [])
    .map((fc) => {
      const real = (fc.fechas || []).filter(esISO).sort().find((f) => { const e = entregaHabil(f); return e >= fechaMin && e <= fechaMax; });
      return real ? { ocasion: fc.ocasion, fecha: entregaHabil(real), fechaOcasion: real } : null;
    })
    .filter(Boolean).sort((a, b) => a.fecha.localeCompare(b.fecha));
  return {
    ocasiones: cal.ocasiones || [], fechasComerciales, fechaMin, fechaMax, maxFechas: Number(cal.max_fechas) > 0 ? Number(cal.max_fechas) : 24,
    condicion: cal.condicion || "", validezDias, fechaPropuesta: hoy, validaHasta: sumarDias(hoy, validezDias),
  };
}

export function calcularCalendario(catalogo, body, tar = tarifas(), hoy = hoyAR()) {
  const reglas = reglasCalendario(hoy);
  const errores = [];
  const entrada = Array.isArray(body?.fechas) ? body.fechas : [];
  if (!entrada.length) errores.push("Sumá al menos una fecha al calendario");
  if (entrada.length > reglas.maxFechas) errores.push(`Hasta ${reglas.maxFechas} fechas por calendario`);
  const fechas = entrada.slice(0, reglas.maxFechas).map((f, idx) => {
    const errs = [];
    const fecha = esISO(f?.fecha) ? f.fecha : null;
    if (!fecha || fecha < reglas.fechaMin || fecha > reglas.fechaMax) errs.push(`la fecha tiene que estar entre el ${ddmm(reglas.fechaMin)} y el ${ddmm(reglas.fechaMax)}/${reglas.fechaMax.slice(0, 4)}`);
    const ocasion = reglas.ocasiones.includes(f?.ocasion) ? f.ocasion : null;
    const ocasionOtro = ocasion === "Otro" ? String(f?.ocasionOtro || "").trim().slice(0, 60) : "";
    if (!ocasion) errs.push("elegí la ocasión");
    else if (ocasion === "Otro" && !ocasionOtro) errs.push("contanos qué ocasión es");
    // Día real de la ocasión cuando la entrega se adelantó (atajo en fin de semana). Solo informativo.
    const fechaOcasion = esISO(f?.fechaOcasion) && f.fechaOcasion !== fecha ? f.fechaOcasion : null;
    const aQuien = String(f?.aQuien || "").trim().slice(0, 80);
    // Carga masiva de cumpleaños: solo lo que cargó el cliente (nombre + dd/mm). La dirección, si la cargó, va en la entrega.
    const cumpleaneros = (Array.isArray(f?.cumpleaneros) ? f.cumpleaneros : []).slice(0, 300)
      .map((c) => ({ nombre: String(c?.nombre || "").trim().slice(0, 80), cumple: /^\d{2}\/\d{2}$/.test(String(c?.cumple || "")) ? c.cumple : null }))
      .filter((c) => c.nombre);
    if (!aQuien) errs.push("indicá a quién va (una persona o un grupo)");
    const lineas = lineasDe(catalogo, f?.items, errs);
    const regalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.cantidad, 0);
    if (!regalos) errs.push("sumá al menos un regalo");
    const envioDetalle = { ...entregaDe(f?.entrega || {}, tar, errs), ...(f?.entrega?.direccion ? { direccion: String(f.entrega.direccion).trim().slice(0, 200) } : {}) };
    if (envioDetalle.modo === "varios" && envioDetalle.nCaba + envioDetalle.nGba === 0) errs.push("cargá cuántos destinatarios hay en CABA y en GBA");
    const subtotalRegalos = lineas.filter((l) => !l.extra).reduce((a, l) => a + l.subtotal, 0);
    const subtotalBebidas = lineas.filter((l) => l.extra).reduce((a, l) => a + l.subtotal, 0);
    if (errs.length) errores.push(`Fecha ${idx + 1}${fecha ? ` (${ddmm(fecha)})` : ""}: ${errs.join(", ")}`);
    return {
      idx, fecha, ...(fechaOcasion ? { fechaOcasion } : {}), ocasion, ocasionOtro, ocasionTexto: ocasion === "Otro" ? ocasionOtro : ocasion, aQuien, ...(cumpleaneros.length ? { cumpleaneros } : {}), lineas, regalos,
      fisicos: lineas.filter((l) => !l.extra && !l.digital).reduce((a, l) => a + l.cantidad, 0),
      subtotalRegalos, subtotalBebidas, subtotal: subtotalRegalos + subtotalBebidas, envioDetalle, ...(errs.length ? { errores: errs } : {}),
    };
  }).sort((a, b) => String(a.fecha || "9999").localeCompare(String(b.fecha || "9999")) || a.idx - b.idx);
  const regalos = fechas.reduce((a, f) => a + f.regalos, 0);
  const subtotalRegalos = fechas.reduce((a, f) => a + f.subtotalRegalos, 0);
  const subtotalBebidas = fechas.reduce((a, f) => a + f.subtotalBebidas, 0);
  const tramo = tramoPara(regalos);   // por el TOTAL de regalos del año
  const descuento = tramo ? Math.round((subtotalRegalos + subtotalBebidas) * tramo.pct / 100) : 0;
  const total = subtotalRegalos + subtotalBebidas - descuento;   // total anual, sin envío
  return {
    modo: "calendario", fechas, cantidadFechas: fechas.length, regalos, subtotalRegalos, subtotalBebidas, tramo, descuento, total,
    porRegalo: regalos ? Math.round(total / regalos) : 0,
    precioCongelado: true, condicion: reglas.condicion, fechaPropuesta: reglas.fechaPropuesta, validezDias: reglas.validezDias, validaHasta: reglas.validaHasta,
    incluyeEnvio: false, envioReferencia: tar.referencia, avisoEnvio: TEXTO_SIN_ENVIO,
    ...(errores.length ? { errores } : {}),
  };
}

// ── Mail al equipo ──
async function notificarRegalos(mailTransporter, lead) {
  if (!mailTransporter) return;
  try {
    const c = lead.calculo, ent = c.envioDetalle;
    const entregaTxt = ent.modo === "uno" ? `Todos a un mismo lugar · ${ent.zona}${lead.direccion ? " · " + lead.direccion : ""}`
      : `Cada uno a su casa · ${ent.nCaba} en CABA + ${ent.nGba} en GBA`;
    const html = `
      <h2>🎁 Nueva propuesta de regalos empresariales #${lead.id}</h2>
      <p><b>${lead.canal === "whatsapp" ? "📲 Cerró por WhatsApp" : "📄 Pidió la propuesta"}</b></p>
      <p><b>Cliente:</b> ${esc(lead.cliente_nombre)}${lead.empresa ? " · " + esc(lead.empresa) : ""}${lead.cuit ? " · CUIT " + esc(lead.cuit) : ""}${lead.facturaA ? " · <b>Factura A</b>" : ""}<br>
         <b>Email:</b> ${esc(lead.email)} &nbsp;·&nbsp; <b>Tel:</b> ${esc(lead.telefono || "-")}</p>
      <p><b>${c.regalos} regalos</b>${c.cantidadRegalos !== c.regalos ? ` (pidió ${c.cantidadRegalos})` : ""}${lead.fecha ? " · 📅 " + esc(lead.fecha) : ""}<br>
         <b>Entrega:</b> ${esc(entregaTxt)}</p>
      <ul>${c.lineas.map((l) => `<li>${l.cantidad}× ${l.opcion && l.opcion !== l.nombre ? esc(l.opcion) + " · " : ""}${esc(l.nombre)}${l.variante ? " (" + esc(l.variante) + ")" : ""}${l.enCajaRegalo ? " · 🎁 <b>en caja de regalo</b>" : ""} · ${pesos(l.subtotal)}${l.sinProductoTN ? " <i>(sin producto en TN)</i>" : ""}</li>`).join("")}</ul>
      <p>Regalos ${pesos(c.subtotalRegalos)}${c.subtotalBebidas ? " · Bebidas " + pesos(c.subtotalBebidas) : ""}${c.descuento ? ` · Descuento ${c.tramo.pct}% −${pesos(c.descuento)}` : ""}<br>
         <b>Total estimado sin envío: ${pesos(c.total)}</b> (${pesos(c.porRegalo)} por regalo)<br>
         <b style="color:#c0392b">${esc(TEXTO_SIN_ENVIO)}</b></p>
      <p><b>Tarjeta:</b> ${lead.tarjeta?.conMensaje ? `con mensaje: “${esc(lead.tarjeta.mensaje || "")}”` : "sin mensaje"}${lead.tarjetaPropia ? " · <b>Tarjeta personal: imprimir diseño del cliente</b>" : ""}</p>
      <p style="color:#999;font-size:12px">Piccadely · Cotizador de Regalos Empresariales</p>`;
    await mailTransporter.sendMail({
      from: `Piccadely <${process.env.GMAIL_USER}>`,
      to: "yus@piccadely.com",
      subject: `🎁 Regalos empresariales #${lead.id} · ${lead.empresa || lead.cliente_nombre} · ${c.regalos} regalos · ${pesos(c.total)} sin envío`,
      html,
    });
  } catch (e) {
    console.error("Regalos: error enviando el mail:", e.message);
  }
}

// Mail del calendario anual: línea de tiempo por mes, total anual, condición de pago adelantado y validez.
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
export const mesDe = (iso) => `${MESES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const entregaTexto = (ent) => ent.modo === "uno" ? `todos a ${ent.zona}${ent.direccion ? " · " + ent.direccion : ""}` : `cada uno a su casa (${ent.nCaba} CABA + ${ent.nGba} GBA)`;
async function notificarCalendario(mailTransporter, lead) {
  if (!mailTransporter) return;
  try {
    const c = lead.calculo;
    const porMes = new Map();
    for (const f of c.fechas) { const m = mesDe(f.fecha); if (!porMes.has(m)) porMes.set(m, []); porMes.get(m).push(f); }
    const linea = (l) => `${l.cantidad}× ${l.opcion && l.opcion !== l.nombre ? esc(l.opcion) + " · " : ""}${esc(l.nombre)}${l.variante ? " (" + esc(l.variante) + ")" : ""}${l.enCajaRegalo ? " · 🎁 <b>en caja de regalo</b>" : ""} · ${pesos(l.precio)} c/u`;
    const html = `
      <h2>📅 Nuevo calendario anual de regalos #${lead.id}</h2>
      <p><b>${lead.canal === "whatsapp" ? "📲 Cerró por WhatsApp" : "📄 Pidió la propuesta"}</b></p>
      <p><b>Cliente:</b> ${esc(lead.cliente_nombre)}${lead.empresa ? " · " + esc(lead.empresa) : ""}${lead.cuit ? " · CUIT " + esc(lead.cuit) : ""}${lead.facturaA ? " · <b>Factura A</b>" : ""}<br>
         <b>Email:</b> ${esc(lead.email)} &nbsp;·&nbsp; <b>Tel:</b> ${esc(lead.telefono || "-")}</p>
      <p><b>${c.cantidadFechas} fechas · ${c.regalos} regalos en el año</b></p>
      ${[...porMes].map(([mes, fs]) => `<h3 style="margin:14px 0 4px;text-transform:capitalize">${esc(mes)}</h3>${fs.map((f) => `
        <p style="margin:4px 0"><b>${ddmm(f.fecha)} · ${esc(f.ocasionTexto)}${f.fechaOcasion ? ` (es el ${diaSemana(f.fechaOcasion)} ${ddmm(f.fechaOcasion)})` : ""} · ${esc(f.aQuien)}</b> — ${f.regalos} regalos · ${pesos(f.subtotal)}<br>
        <span style="color:#666">Entrega: ${esc(entregaTexto(f.envioDetalle))}</span>${f.cumpleaneros ? `<br><span style="color:#666">🎂 Cumpleañeros: ${f.cumpleaneros.map((c) => `${esc(c.nombre)}${c.cumple ? ` (${c.cumple})` : ""}`).join(", ")}</span>` : ""}</p>
        <ul style="margin:2px 0 8px">${f.lineas.map((l) => `<li>${linea(l)}</li>`).join("")}</ul>`).join("")}`).join("")}
      <p>Regalos ${pesos(c.subtotalRegalos)}${c.subtotalBebidas ? " · Bebidas " + pesos(c.subtotalBebidas) : ""}${c.descuento ? ` · Descuento por volumen anual ${c.tramo.pct}% −${pesos(c.descuento)}` : ""}<br>
         <b>Total anual estimado sin envío: ${pesos(c.total)}</b> (${pesos(c.porRegalo)} por regalo)<br>
         <b>🔒 Precio congelado:</b> ${esc(c.condicion)}<br>
         Propuesta del ${ddmm(c.fechaPropuesta)}/${c.fechaPropuesta.slice(0, 4)}, válida hasta el ${ddmm(c.validaHasta)}/${c.validaHasta.slice(0, 4)}.<br>
         <b style="color:#c0392b">${esc(TEXTO_SIN_ENVIO)}</b></p>
      <p><b>Tarjeta:</b> ${lead.tarjeta?.conMensaje ? `con mensaje: “${esc(lead.tarjeta.mensaje || "")}”` : "sin mensaje"}${lead.tarjetaPropia ? " · <b>Tarjeta personal: imprimir diseño del cliente</b>" : ""}</p>
      <p style="color:#999;font-size:12px">Piccadely · Cotizador de Regalos Empresariales · Calendario anual</p>`;
    await mailTransporter.sendMail({
      from: `Piccadely <${process.env.GMAIL_USER}>`,
      to: "yus@piccadely.com",
      subject: `📅 Calendario anual de regalos #${lead.id} · ${lead.empresa || lead.cliente_nombre} · ${c.cantidadFechas} fechas · ${c.regalos} regalos · ${pesos(c.total)} sin envío`,
      html,
    });
  } catch (e) {
    console.error("Regalos: error enviando el mail del calendario:", e.message);
  }
}

// ── Anti-spam de /propuesta (público y manda mail): Routes/antispam.js (mismo criterio que el cotizador de eventos).
// Máx. 5 propuestas GUARDADAS por IP cada 10 minutos + honeypot (campo CAMPO_HONEYPOT del formulario).
const limitador = crearLimitador({ limite: 5, ventanaMs: 10 * 60 * 1000 });

// ── Router ──
export function regalosRouter(pool, mailTransporter) {
  const router = express.Router();
  // Mail AL CLIENTE con su propuesta (solo si la pidió: canal "solicitar"). Espera el PDF del paso 2 (POST /propuesta/:id/pdf);
  // si no llega en 60 s, sale sin adjunto. Ver Routes/mailCliente.js.
  const esperaPdf = crearEsperaPdf({
    enviar: (id, { lead }, adjunto, motivoSinAdjunto) => enviarMailCliente({
      mailTransporter, pool, id, to: lead.email, mail: mailPropuestaRegalos({ id, lead, calculo: lead.calculo }), adjunto, motivoSinAdjunto,
      nombrePdf: `${lead.calculo.fechas ? "calendario" : "propuesta"}-regalos-piccadely-${id}.pdf`,
    }),
  });
  // Solo 3 rutas, ninguna devuelve leads: GET /catalogo, POST /calcular, POST /propuesta.

  router.get("/catalogo", async (req, res) => {
    try {
      const cat = await catalogoRegalos();
      const tar = tarifas();
      res.json({
        version: API_VERSION,
        // Compat v1: cada estilo también trae `items` planos (variantes) para un front anterior que siga cacheado.
        estilos: cat.estilos.map((e) => ({ ...e, items: itemsV1(e) })),
        tramos: TRAMOS_REGALOS,
        envio: { caba: tar.caba, partidos: tar.partidos, referencia: tar.referencia, aviso: TEXTO_SIN_ENVIO },
        calendario: reglasCalendario(),   // modo "Calendario anual" (campo nuevo: un front anterior lo ignora)
        estiloInicial: configRegalos().estilo_inicial || null,   // pestaña abierta al entrar (campo nuevo: un front anterior lo ignora)
      });
    } catch (e) {
      console.error("Regalos: error armando el catálogo:", e.message);
      res.status(502).json({ error: "No pudimos traer el catálogo. Probá de nuevo en un rato." });
    }
  });

  router.post("/calcular", async (req, res) => {
    try {
      const b = req.body || {};
      const cat = await catalogoRegalos();
      res.json({ version: API_VERSION, ...(b.modo === "calendario" ? calcularCalendario(cat, b) : calcularRegalos(cat, b)) });
    } catch (e) {
      console.error("Regalos: error calculando:", e.message);
      res.status(502).json({ error: "No pudimos calcular la propuesta." });
    }
  });

  // Calendario anual: recalcula todo server-side y guarda cada fecha con sus líneas y el precio unitario CONGELADO.
  async function guardarCalendario(req, res, b, ip, nombre, email) {
    const calculo = calcularCalendario(await catalogoRegalos(), b);
    if (calculo.errores) return res.status(400).json({ error: calculo.errores.join(". ") });
    const canal = b.canal === "whatsapp" ? "whatsapp" : "solicitar";
    const corto = (x, n) => (x == null ? null : String(x).trim().slice(0, n) || null);
    const lead = {
      cliente_nombre: nombre, email, telefono: corto(b.cliente?.telefono, 40),
      empresa: corto(b.empresa, 120), cuit: corto(b.cuit, 20), facturaA: !!b.facturaA,
      tarjeta: { conMensaje: !!b.tarjeta?.conMensaje, mensaje: corto(b.tarjeta?.mensaje, 500) },
      tarjetaPropia: !!b.tarjetaPropia, canal, calculo,
    };
    const opciones = {
      tipo: "calendario",
      fechas: calculo.fechas.map(({ idx, errores, ...f }) => f),   // cada fecha: ocasión, a quién, entrega, líneas con `precio` (unitario congelado)
      cantidadFechas: calculo.cantidadFechas, regalos: calculo.regalos,
      subtotalRegalos: calculo.subtotalRegalos, subtotalBebidas: calculo.subtotalBebidas, tramo: calculo.tramo, descuento: calculo.descuento,
      total: calculo.total, porRegalo: calculo.porRegalo,
      precioCongelado: true, condicion: calculo.condicion, fechaPropuesta: calculo.fechaPropuesta, validezDias: calculo.validezDias, validaHasta: calculo.validaHasta,
      incluyeEnvio: false, envioReferencia: calculo.envioReferencia,
      tarjeta: lead.tarjeta, tarjetaPropia: lead.tarjetaPropia, empresa: lead.empresa, cuit: lead.cuit, facturaA: lead.facturaA,
    };
    const q = await pool.query(
      `INSERT INTO cotizaciones
        (cliente_nombre, empresa, email, telefono, personas, fecha_evento, zona,
         nivel_elegido, opciones, total_elegido, con_bebidas, canal, estado, cliente_key, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'regalos',$8,$9,$10,$11,'pendiente',$12,'regalos')
       RETURNING id, creada_en`,
      [lead.cliente_nombre, lead.empresa, lead.email, lead.telefono, calculo.regalos, calculo.fechas[0]?.fecha || null,
       `Calendario: ${calculo.cantidadFechas} fecha(s)`, JSON.stringify(opciones), calculo.total, calculo.subtotalBebidas > 0, canal,
       clienteKeyDe(lead.email, lead.telefono)]
    );
    const id = q.rows[0].id;
    limitador.registrar(ip);
    notificarCalendario(mailTransporter, { ...lead, id });
    const tokenPdf = canal === "solicitar" ? esperaPdf.programar(id, { lead }) : null;
    return res.json({ ok: true, id, calculo, ...(tokenPdf ? { tokenPdf } : {}) });
  }

  router.post("/propuesta", async (req, res) => {
    const b = req.body || {};
    // Honeypot lleno → bot: se responde OK y se descarta en silencio (sin guardar ni mandar mail).
    if (esBot(b)) {
      console.warn("Regalos: propuesta descartada por honeypot.");
      return res.json({ ok: true, id: null });
    }
    const ip = ipDe(req);
    if (limitador.excedido(ip)) {
      console.warn("Regalos: rate limit de propuestas alcanzado.");
      return res.status(429).json({ error: "Recibimos varias propuestas seguidas desde tu conexión. Esperá unos minutos o escribinos por WhatsApp." });
    }
    const nombre = String(b.cliente?.nombre || "").trim().slice(0, 120);
    const email = String(b.cliente?.email || "").trim().slice(0, 160);
    if (!nombre || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Completá tu nombre y un email válido." });
    try {
      if (b.modo === "calendario") return await guardarCalendario(req, res, b, ip, nombre, email);
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
        descuento: calculo.descuento, incluyeEnvio: false, envioReferencia: calculo.envioReferencia,   // el total NO incluye envío
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
      limitador.registrar(ip);
      notificarRegalos(mailTransporter, { ...lead, id });
      const tokenPdf = canal === "solicitar" ? esperaPdf.programar(id, { lead }) : null;
      res.json({ ok: true, id, calculo, ...(tokenPdf ? { tokenPdf } : {}) });
    } catch (e) {
      console.error("Regalos: error guardando la propuesta:", e.message);
      res.status(500).json({ error: "No pudimos guardar la propuesta. Probá de nuevo." });
    }
  });

  // Paso 2: el PDF (con el N°) que armó el navegador → mail al cliente con el adjunto. Token de un solo uso.
  router.post("/propuesta/:id/pdf", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Propuesta inválida." });
    const r = await esperaPdf.conPdf(id, req.body?.token, req.body?.pdf);
    if (!r) return res.status(404).json({ error: "No hay una propuesta pendiente de envío con esos datos." });
    res.json({ ok: true, mailEnviado: r.enviado, adjunto: r.adjunto, email: r.email });
  });

  return router;
}
