// ─────────────────────────────────────────────────────────────────────
//  Routes/botHerramientas.js  ·  Herramientas (tool use) del bot: las CUENTAS salen del código
//    calcular_tamanos { personas, modo }        → combinación de tamaños, capacidad total y sobrante
//    calcular_total   { items: [{ producto, variante, cantidad }] } → precio unitario, subtotales y total
//  Las usa responderBot (Routes/botWhatsapp.js): el modelo las pide y el código hace la cuenta.
// ─────────────────────────────────────────────────────────────────────

// Capacidad por tamaño (personas). Piccar usa el máximo de cada rango del prompt.
export const CAPACIDAD = {
  comer: { Chica: 1, Mediana: 2, Grande: 4, XL: 6 },
  piccar: { Chica: 3, Mediana: 6, Grande: 10, XL: 12 },
};
export const GRUPO_GRANDE = 50;   // desde acá se arma la propuesta a medida con alguien del equipo
const MAX_PERSONAS = 2000;

const pesos = (n) => `$${Number(n).toLocaleString("es-AR")}`;
const normalizar = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, " ").trim();

// Algoritmo: tantas XL como entren completas; para el resto, el tamaño más chico que lo cubra.
export function calcularTamanos({ personas, modo } = {}) {
  const n = Number(personas);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERSONAS) return { error: `personas tiene que ser un entero entre 1 y ${MAX_PERSONAS}` };
  const cap = CAPACIDAD[modo];
  if (!cap) return { error: 'modo tiene que ser "comer" o "piccar"' };
  const xl = Math.floor(n / cap.XL);
  const resto = n - xl * cap.XL;
  const cant = { XL: xl };
  if (resto > 0) {
    const tam = ["Chica", "Mediana", "Grande", "XL"].find((t) => cap[t] >= resto);
    cant[tam] = (cant[tam] || 0) + 1;
  }
  const combinacion = ["XL", "Grande", "Mediana", "Chica"].filter((t) => cant[t]).map((t) => ({ tamano: t, cantidad: cant[t] }));
  const capacidad = combinacion.reduce((a, c) => a + cap[c.tamano] * c.cantidad, 0);
  const out = {
    personas: n, modo,
    combinacion,
    texto: combinacion.map((c) => `${c.cantidad} ${c.tamano}`).join(" + "),
    capacidad_total: capacidad,
    sobran: capacidad - n,
    grupo_grande: n >= GRUPO_GRANDE,
  };
  if (out.grupo_grande) out.instruccion = `Son ${GRUPO_GRANDE} personas o más: pasale esta combinación (y el total aproximado si ya eligió producto) y derivá con [HANDOFF] para que el equipo arme la propuesta a medida.`;
  return out;
}

// Precio de venta de una variante: promo si existe y es menor. null si no tiene precio.
function precioDe(v) {
  const ok = (x) => x !== null && x !== undefined && String(x).trim() !== "" && Number(x) > 0;
  if (!ok(v.price)) return null;
  const p = Number(v.price);
  return ok(v.promotional_price) && Number(v.promotional_price) < p ? { precio: Number(v.promotional_price), promo: true, antes: p } : { precio: p, promo: false };
}
const nombreDe = (x) => (x && typeof x === "object" ? x.es || x.pt || Object.values(x)[0] : x) || "";
const etiquetaDe = (v) => (v.values || []).map(nombreDe).filter(Boolean).join(" / ");

function buscarProducto(productos, nombre) {
  const q = normalizar(nombre).replace(/^(la|el|los|las) /, "");
  const nom = (p) => normalizar(nombreDe(p.name)).replace(/^(la|el|los|las) /, "");
  const exactos = productos.filter((p) => nom(p) === q);
  if (exactos.length === 1) return { producto: exactos[0] };
  const parecidos = productos.filter((p) => nom(p).includes(q) || q.includes(nom(p)));
  if (exactos.length === 0 && parecidos.length === 1) return { producto: parecidos[0] };
  const candidatos = (exactos.length ? exactos : parecidos).map((p) => nombreDe(p.name)).slice(0, 6);
  return { error: candidatos.length ? `"${nombre}" es ambiguo: ${candidatos.join(", ")}` : `"${nombre}" no está en el catálogo` };
}

function buscarVariante(p, variante) {
  const vs = (p.variants || []).filter((v) => precioDe(v));
  if (!vs.length) return { error: `"${nombreDe(p.name)}" no tiene precio en el catálogo` };
  const q = normalizar(variante);
  if (vs.length === 1 && (!q || q === "unica" || q === "unico")) return { variante: vs[0] };
  const m = vs.filter((v) => { const e = normalizar(etiquetaDe(v)); return e === q || e.startsWith(q + " "); });
  if (m.length === 1) return { variante: m[0] };
  return { error: `"${nombreDe(p.name)}" no viene en "${variante}". Variantes: ${vs.map(etiquetaDe).join(" · ") || "única"}` };
}

// items: [{ producto, variante, cantidad }] contra la lista de productos del catálogo en vivo.
export function calcularTotal({ items } = {}, productos) {
  if (!Array.isArray(productos) || !productos.length) return { error: "Catálogo no disponible: no des precios, derivá con [HANDOFF]." };
  if (!Array.isArray(items) || !items.length) return { error: "items vacío" };
  const lineas = [], errores = [];
  for (const it of items.slice(0, 30)) {
    const cantidad = Number(it?.cantidad ?? 1);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 500) { errores.push(`cantidad inválida para "${it?.producto}"`); continue; }
    const bp = buscarProducto(productos.filter((p) => p.published !== false), it?.producto);
    if (bp.error) { errores.push(bp.error); continue; }
    const bv = buscarVariante(bp.producto, it?.variante);
    if (bv.error) { errores.push(bv.error); continue; }
    const v = bv.variante;
    if (v.stock_management && Number(v.stock) === 0) { errores.push(`"${nombreDe(bp.producto.name)} ${etiquetaDe(v)}" está SIN STOCK`); continue; }
    const pr = precioDe(v);
    lineas.push({
      producto: nombreDe(bp.producto.name), variante: etiquetaDe(v) || "única", cantidad,
      precio_unitario: pr.precio, precio_unitario_texto: pesos(pr.precio) + (pr.promo ? ` (precio promo, antes ${pesos(pr.antes)})` : ""),
      subtotal: pr.precio * cantidad, subtotal_texto: pesos(pr.precio * cantidad),
    });
  }
  const total = lineas.reduce((a, l) => a + l.subtotal, 0);
  const out = { lineas, total, total_texto: pesos(total) };
  if (errores.length) {
    out.errores = errores;
    out.aviso = "Hay ítems que no se pudieron cotizar: NO inventes su precio; decile al cliente cuál no está o preguntale cuál quiso decir. El total es SOLO de las líneas válidas.";
  }
  return out;
}

// Definición de las herramientas para la API de Anthropic.
export const HERRAMIENTAS = [
  {
    name: "calcular_tamanos",
    description: "Calcula qué tamaños de piccada hacen falta para una cantidad de personas. Usala SIEMPRE que haya que recomendar tamaño o cantidad de piccadas. Devuelve la combinación, la capacidad total y cuántos sobran.",
    input_schema: {
      type: "object",
      properties: {
        personas: { type: "integer", description: "Cantidad de personas" },
        modo: { type: "string", enum: ["comer", "piccar"], description: "comer = es la comida; piccar = picada de entrada" },
      },
      required: ["personas", "modo"],
    },
  },
  {
    name: "calcular_total",
    description: "Calcula precios unitarios, subtotales y total con los precios del catálogo en vivo (respeta precio promo). Usala SIEMPRE para cualquier subtotal o total. Si un producto o variante no existe, lo devuelve en errores.",
    input_schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              producto: { type: "string", description: "Nombre del producto tal cual el catálogo (ej.: La Gourmet)" },
              variante: { type: "string", description: "Tamaño o variante (ej.: Chica, Mediana, Grande, XL). Vacío si es de tamaño único." },
              cantidad: { type: "integer", description: "Cantidad (mínimo 1)" },
            },
            required: ["producto", "cantidad"],
          },
        },
      },
      required: ["items"],
    },
  },
];
