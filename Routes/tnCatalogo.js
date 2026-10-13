// ─────────────────────────────────────────────────────────────────────
//  Routes/tnCatalogo.js  ·  Catálogo de Tienda Nube COMPARTIDO (cotizador de eventos + regalos)
//  Productos y categorías paginados (per_page=200, page=1,2,… hasta que venga vacío o TN responda
//  404 "Last page is N"), con caché de 5 minutos y una sola llamada en curso a la vez.
//  Devuelve los objetos TAL CUAL los manda TN: cada router decide qué precio usa
//  (el cotizador de eventos sigue con v.price; regalos usa el promocional si es menor).
//  El bot de WhatsApp tiene su propio catálogo (Routes/botWhatsapp.js) y no usa este módulo.
// ─────────────────────────────────────────────────────────────────────
import axios from "axios";

const STORE_ID = process.env.TN_STORE_ID;
const tnHeaders = {
  Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};
const PER_PAGE = 200;
const MAX_PAGINAS = 50;
const CACHE_MS = 5 * 60 * 1000;

async function paginado(recurso) {
  const out = [];
  for (let page = 1; page <= MAX_PAGINAS; page++) {
    let r;
    try {
      r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/${recurso}`, {
        headers: tnHeaders, params: { per_page: PER_PAGE, page }, timeout: 20000,
      });
    } catch (e) {
      if (page > 1 && e.response?.status === 404) break;   // "Last page is N"
      throw e;
    }
    const data = Array.isArray(r.data) ? r.data : [];
    if (!data.length) break;
    out.push(...data);
  }
  return out;
}

let _cache = { productos: null, categorias: null, ts: 0 };
let _enCurso = null;

// → { productos, categorias, ts }. Si TN falla y hay caché, se devuelve el caché (aunque esté vencido).
export async function getCatalogoTN() {
  if (_cache.productos && Date.now() - _cache.ts < CACHE_MS) return _cache;
  if (!_enCurso) {
    _enCurso = Promise.all([paginado("products"), paginado("categories")])
      .then(([productos, categorias]) => { _cache = { productos, categorias, ts: Date.now() }; })
      .catch((e) => {
        console.error("Catálogo TN: error trayendo productos/categorías:", e.response ? `HTTP ${e.response.status}` : e.message);
        if (!_cache.productos) throw e;
      })
      .finally(() => { _enCurso = null; });
  }
  await _enCurso;
  return _cache;
}

export async function getProductosTN() {
  return (await getCatalogoTN()).productos;
}

// Descripción de TN (HTML) → texto plano corto.
export function limpiarDescripcion(html, max = 220) {
  if (!html) return "";
  const txt = String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ").trim();
  return txt.length > max ? txt.slice(0, max).replace(/\s+\S*$/, "") + "…" : txt;
}
