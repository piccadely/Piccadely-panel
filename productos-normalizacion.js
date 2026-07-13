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
const SUFIJOS_TAMANO = {
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
  s = s.replace(/\bnueva!?(?=\s|$)/gi, " ").replace(/\s+/g, " ").trim();
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
]);
export function esExcluidoProduccion(nombre) {
  return EXCLUIDOS_PRODUCCION.has(_clave(nombre));
}
