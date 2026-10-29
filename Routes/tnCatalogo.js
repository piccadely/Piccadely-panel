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

// Entidades HTML de las descripciones de TN → caracteres. Antes cualquier entidad con nombre se borraba y quedaba
// "Jam n Crudo" (por "Jam&oacute;n"). Se decodifican las con nombre de uso común y las numéricas (&#243; / &#xF3;);
// una con nombre desconocido sigue siendo un espacio. &amp; va al final, para no decodificar dos veces.
const ENTIDADES = {
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú", Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü", iexcl: "¡", iquest: "¿", ordm: "º", ordf: "ª", deg: "°", middot: "·", bull: "•",
  quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", laquo: "«", raquo: "»", ndash: "–", mdash: "—", hellip: "…",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", euro: "€", times: "×", frac12: "½", frac14: "¼", copy: "©", reg: "®",
};
const codigo = (c) => (c > 0 && c < 0x110000 ? String.fromCodePoint(c) : " ");
export function decodificarEntidades(s) {
  return String(s)
    .replace(/&#(\d+);/g, (m, n) => codigo(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => codigo(parseInt(h, 16)))
    .replace(/&([a-z][a-z0-9]*);/gi, (m, n) => (n.toLowerCase() === "amp" ? m : ENTIDADES[n] ?? " "))
    .replace(/&amp;/gi, "&");
}

// Descripción de TN (HTML) → texto plano corto.
export function limpiarDescripcion(html, max = 220) {
  if (!html) return "";
  const txt = decodificarEntidades(String(html).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ").trim();
  return txt.length > max ? txt.slice(0, max).replace(/\s+\S*$/, "") + "…" : txt;
}
