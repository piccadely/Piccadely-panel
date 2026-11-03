// ─────────────────────────────────────────────────────────────────────────
// Normalización de nombres de producto a una clave canónica ÚNICA.
// COMPARTIDO por el BACKEND (server.js) y el FRONT (src/App.jsx) para que
// cocina, análisis de producción y el STOCK (stock_lotes.clave_producto:
// producir / descontar / descartar) agrupen y descuenten con la MISMA clave.
//
// El mismo producto físico entra con dos formatos de nombre según el canal:
//   LARGO (canónico): "La Piccada Mundial (XL - Comen 6 - Piccan 12)"   ← web/TN
//   CORTO:            "La Piccada Mundial XL"                            ← call center
// La tabla de alias mapea CORTO -> LARGO (canónico). Para ampliar, sumá acá.
// ─────────────────────────────────────────────────────────────────────────

// Sufijos de tamaño LITERALES del catálogo TN.
// ⚠️ Espaciado/guiones IRREGULARES a propósito — copiados tal cual del catálogo.
// (Chica dice "Come 1"; el resto "Comen 2/4/6"; "Grande Comen 4- Piccan 9" NO
//  lleva guion después de "Grande".) NO "corregir".
export const SUFIJOS_TAMANO = {
  "Chica":   "(Chica - Come 1 - Piccan 3)",
  "Mediana": "(Mediana - Comen 2- Piccan 5)",
  "Grande":  "(Grande Comen 4- Piccan 9)",
  "XL":      "(XL - Comen 6 - Piccan 12)",
};

// Productos que tienen los 4 tamaños (nombre base tal cual el catálogo).
const PRODUCTOS_4_TAMANOS = [
  "Comilona",
  "La Piccada Mundial",
  "La Fausta",
  "Suttile",
  "Giovane",
  "Anita de Baires",
  "HD (Hiper Divina)",
  "Magnolia",
  "Amistad",
  "Esquesitos",
  "Incontro",
  "Quesos del Gourmet",
  "MegaPromo Divertida",
  "La Gourmet",
];

// Alias de formatos con unidades (corto -> largo canónico). Incluye las dos
// variantes de espaciado ("x24" y "x 24") porque ambas aparecen en la base.
const ALIAS_UNIDADES = {
  "PiccaChips x 30": "PiccaChips (x 30 Unidades)",
  "PiccaChips x 6":  "PiccaChips (x 6 Unidades)",
  "PiccaChips x 12": "PiccaChips (x 12 Unidades)",
  "Caja Pinchos Premium x 24": "Caja Pinchos Premium (x 24 Unidades)",
  "Caja Pinchos Premium x 60": "Caja Pinchos Premium (x 60 Unidades)",
  "PiccaCuadraditos x24":  "PiccaCuadraditos (x 24 Unidades)",
  "PiccaCuadraditos x 24": "PiccaCuadraditos (x 24 Unidades)",
  "PiccaCuadraditos x6":   "PiccaCuadraditos (x 6 Unidades)",
  "PiccaCuadraditos x 6":  "PiccaCuadraditos (x 6 Unidades)",
  "PiccaCuadraditos x12":  "PiccaCuadraditos (x 12 Unidades)",
  "PiccaCuadraditos x 12": "PiccaCuadraditos (x 12 Unidades)",
};

// Clave TOLERANTE para comparar contra la tabla: minúsculas + espacios colapsados + trim.
function _clave(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Versión pública de _clave: para indexar mapas externos (ej. nombre→categoría del catálogo TN)
// con EXACTAMENTE la misma normalización tolerante que usa la tabla de alias.
export function claveProducto(s) { return _clave(s); }

// Tabla final de alias: clave tolerante -> valor canónico EXACTO.
const ALIAS = {};
for (const base of PRODUCTOS_4_TAMANOS) {
  for (const tam of Object.keys(SUFIJOS_TAMANO)) {
    ALIAS[_clave(`${base} ${tam}`)] = `${base} ${SUFIJOS_TAMANO[tam]}`;
  }
}
for (const corto of Object.keys(ALIAS_UNIDADES)) {
  ALIAS[_clave(corto)] = ALIAS_UNIDADES[corto];
}

// Nombre -> clave canónica. Reglas:
//  - "Nueva"/"Nueva!" es solo rótulo comercial (mismo producto) -> se quita.
//  - "Sutille" es typo de "Suttile".
//  - Match contra la tabla es tolerante (case-insensitive, espacios colapsados);
//    el valor devuelto es la clave canónica EXACTA de la tabla.
//  - Si NO está en la tabla, se devuelve tal cual (ya con Nueva/typo normalizados).
export function normalizarProducto(nombre) {
  let s = String(nombre || "");
  // Rótulo "Nueva"/"Nueva!" (con o sin "!"), en cualquier posición -> fuera.
  s = s.replace(/\bnueva!?(?=\s|$)/gi, " ");
  // Sufijo "MKP" (marketplace), en cualquier posición -> fuera (igual que "Nueva").
  s = s.replace(/\bmkp\b/gi, " ");
  s = s.replace(/\s+/g, " ").trim();
  // Typo Sutille -> Suttile.
  s = s.replace(/\bsutille\b/gi, "Suttile");
  const canon = ALIAS[_clave(s)];
  return canon || s;
}

// ─── EXCLUIDOS de cocina/producción (NO son productos a fabricar) ──────────
// Se cuelan como líneas del pedido (envíos, medios de pago, descuentos, etc.).
// Match EXACTO tras normalizar espacios (case-insensitive). Para ampliar, sumá acá.
const EXCLUIDOS_PRODUCCION = new Set([
  "envio", "envío", "envios", "envíos",
  "descuento", "retiro", "retira",
  "rappi", "peya", "pedidos ya", "pedido ya",
  "mercado pago", "mp", "efectivo", "transferencia",
  "ajuste", "var", "variable",
  // Medios de pago (variantes que faltaban). Un medio de pago nunca es producto ni algo a fabricar.
  "pedidoya", "ped ya", "mp delivery", "mp app", "pedido mp",
]);
export function esExcluidoProduccion(nombre) {
  const k = _clave(nombre);
  if (EXCLUIDOS_PRODUCCION.has(k)) return true;
  // Prefijos: cubre "Envío {zona}", "Descuento 10% Retiro" y los "Envio"/"Descuento"
  // sueltos que se cargan a mano. Ningún producto real del catálogo empieza con estas palabras.
  return k.startsWith("envio") || k.startsWith("envío") || k.startsWith("descuento");
}

// ─── BASURA del reporte de VENTAS (NO son productos) ───────────────────────
// SOLO para el reporte de "Productos vendidos" (NO cocina/producción). Blacklist en 3 capas,
// pensada para filtrar la basura SIN perder ventas reales cargadas a mano (piccadas con typos, etc.):
//   (a) frases/marcas inequívocas (substring/regex, case-insensitive),
//   (b) códigos/cupones (regex estructural),
//   (c) SET EXACTO para palabras cortas ambiguas (nunca substring, o se comería productos).
const BASURA_FRASES = /rappi|peya|pedido ?ya|pedidoya|ped ya|mp delivery|mp app|pedido mp|abonado|pago en pedido|autorizado por|reenv[ií]o|regalo de|pre-?compra|no entregado|club la naci[oó]n|sport club|fanbag|\d+ ?% ?(off|mas|más)|\b\d+ ?x ?\d+\b/i;
const BASURA_EXACTA = new Set(["variable", "var", "e", "desc", "pan", "vai"]);
export function esBasuraVenta(nombre) {
  const original = String(nombre || "").trim();
  const k = _clave(original);
  if (k === "") return true;                          // vacío
  if (BASURA_EXACTA.has(k)) return true;              // (c) palabra corta exacta
  if (BASURA_FRASES.test(original)) return true;      // (a) frase/marca
  // (b) código/cupón: número puro, o token único en MAYÚSCULAS con al menos un dígito,
  //     sin espacios y de largo >= 4 (ej. "10AGOURB", "URBSEP15", "BON14ENE", "10GCM651").
  if (/^\d+$/.test(original)) return true;
  if (!/\s/.test(original) && original.length >= 4 && /\d/.test(original) &&
      /[A-ZÁÉÍÓÚÑ]/.test(original) && original === original.toUpperCase()) return true;
  return false;
}

// ─── COSTO DE ENVÍO de un pedido de Tienda Nube ────────────────────────────
// TN NO manda el costo de envío en ningún campo; se calcula por DIFERENCIA (fórmula
// verificada contra la tabla de zonas en 40 pedidos reales, incluidos los que tienen cupón):
//   envio = data.total − Σ(products[].price × quantity) + discount + discount_gateway
// (discount/discount_gateway vienen como string, o vacío -> 0). Solo aplica a ENVÍOS
// (fulfillments[0].shipping.type === "ship") y con envio > 0; retiros -> 0.
// COMPARTIDA por front (src/App.jsx) y backend (server.js) para que el ítem "Envío" y el
// total cierren IGUAL en todas las vistas. Devuelve un entero (>= 0).
export function calcularEnvioTN(data) {
  if (!data) return 0;
  if ((data.fulfillments?.[0]?.shipping?.type || "") !== "ship") return 0;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const sumaProductos = (Array.isArray(data.products) ? data.products : [])
    .reduce((a, p) => a + num(p.price) * num(p.quantity), 0);
  const envio = num(data.total) - sumaProductos + num(data.discount) + num(data.discount_gateway);
  return envio > 0 ? Math.round(envio) : 0;
}

// ─── LOCAL DE LOS PEDIDOS DE TIENDA NUBE ───────────────────────────────────
// COMPARTIDO por front (clasificarPedido) y backend (clasificarPedidoBackend).
//
// Regla para pedidos de TN CREADOS desde REGLA_LOCAL_TN_DESDE (los anteriores conservan su local, para
// no mover los reportes por local ya cerrados). Solo importa si es delivery o retiro, y dónde retira:
//   - DELIVERY (cualquier opción de envío) → delivery-at. Delivery sale SIEMPRE de Álvarez Thomas.
//     Un pedido con envío y retiro mezclados cuenta como delivery.
//   - RETIRO → el local del punto de retiro que ELIGIÓ el cliente, según PUNTOS_DE_RETIRO (código, nombre
//     o dirección del punto, en la opción de envío / pickup_details). Si no se reconoce → retiro-at.
//     NUNCA se usa assigned_location (es de dónde sale el stock, y eso lo decide TN internamente).
// Que TN haya partido el pedido en varios envíos (fulfillments) no cambia nada.
// El tab_manual que cargue el operador sigue mandando (lo aplica quien llama). Los manuales no pasan por acá.
//
// ⚠️ FECHA DE CORTE = el momento del merge a main (hora de Argentina, formato ISO con -03:00). Se edita acá,
// justo antes del merge: así ningún pedido que ya esté en preparación cambia de local.
export const REGLA_LOCAL_TN_DESDE = "2026-11-03T09:08:00-03:00";

// TABLA ÚNICA de puntos de retiro → pestaña. Se reconoce por el código de la opción de TN, o por un texto
// (sin tildes, en minúsculas) en el nombre o la dirección del punto. Gana la primera fila que coincide.
//
// PARA SUMAR UN TERCER LOCAL (ej. "Retiro en Palermo" → retiro-pa), sin cambiar delivery (sigue en A. Thomas):
//   1. Esta tabla: una fila { tab: "retiro-pa", codigos: [<código de la opción de TN>], textos: ["palermo", <calle y número>] }.
//   2. Pestañas y local: el tab "retiro-pa" en TABS (src/App.jsx) y "Palermo" en localLabel (App.jsx) y
//      localLabelBackend (server.js), que es lo que usan panel, cocina, comandas, tandas, reportes y stock.
//   3. Comandas en lote y cocina: filtran por p.local === localLabel(tab), así que andan solas con el paso 2.
//   4. Caja: la caja "Palermo" (y su "Fondo Fijo Palermo") en CAJAS_TRANSFERIBLES (server.js) y en las listas
//      de cajas del front (cajas por rol, gastos, tesorería, pagos, adelantos, RRHH_LOCALES); rol de usuario del local.
//   5. Stock: INSUMO_LOCALES (server.js), STOCK_LOCALES (App.jsx) y los filtros "A. Thomas / French / Ambos"
//      de reportes y stock (server.js y App.jsx).
//   6. Facturación: credenciales y punto de venta de TusFacturas del local (getTFCredentials y TF_ENV en server.js).
//   7. Textos: dirección del local en los mails (DIRECCION_* en server.js, Routes/mp.js), en LOCALES_RETIRO de la
//      cotización (App.jsx) y en el bot de WhatsApp (Routes/botWhatsapp.js, Routes/zonaCobertura.js); punto en el mapa.
export const PUNTOS_DE_RETIRO = [
  { tab: "retiro-at", local: "A. Thomas", codigos: ["01KQ7TFQPTTZQ7CFFKCKVWEZQV"], textos: ["villa ortuzar", "alvarez thomas"] },
  { tab: "retiro-fr", local: "French",    codigos: ["01KQ7S2Z0799JKAT5A1VTH12EQ"], textos: ["recoleta", "french 2615"] },
];
const TAB_RETIRO_SI_NO_SE_RECONOCE = "retiro-at";

const sinTildes = (t) => String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const esRetiroTN = (ff) => {
  const tipo = ff?.shipping?.type || "";
  const nombre = (ff?.shipping?.option?.name || "").toLowerCase();
  return tipo === "pickup" || nombre.includes("retiro") || nombre.includes("pickup") || nombre.includes("local");
};
// Fila de PUNTOS_DE_RETIRO del punto que eligió el cliente en un envío, o null si no se reconoce.
// Solo mira la opción de envío y pickup_details (código, nombre, dirección); assigned_location NO.
export function puntoDeRetiroTN(ff) {
  const op = ff?.shipping?.option || {}, pd = ff?.shipping?.pickup_details || {};
  const porCodigo = PUNTOS_DE_RETIRO.find((p) => op.code && p.codigos.includes(op.code));
  if (porCodigo) return porCodigo;
  const texto = sinTildes(`${op.name || ""} ${pd.name || ""} ${typeof pd.address === "string" ? pd.address : JSON.stringify(pd.address || "")}`);
  return PUNTOS_DE_RETIRO.find((p) => p.textos.some((t) => texto.includes(t))) || null;
}

// → "delivery-at" | pestaña de retiro si aplica la regla; null si el pedido es anterior al corte (o no trae
// created_at / envíos), y entonces se clasifica como siempre.
export function tabReglaLocalTN(data) {
  const envios = Array.isArray(data?.fulfillments) ? data.fulfillments : [];
  const creado = Date.parse(data?.created_at);
  if (!envios.length || !Number.isFinite(creado) || creado < Date.parse(REGLA_LOCAL_TN_DESDE)) return null;
  if (!envios.every(esRetiroTN)) return "delivery-at";   // algún envío a domicilio → delivery (Álvarez Thomas)
  for (const ff of envios) { const punto = puntoDeRetiroTN(ff); if (punto) return punto.tab; }
  return TAB_RETIRO_SI_NO_SE_RECONOCE;
}
