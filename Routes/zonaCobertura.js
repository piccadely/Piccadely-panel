// ─────────────────────────────────────────────────────────────────────
//  Routes/zonaCobertura.js  ·  Zona de entrega resuelta por CÓDIGO (no por el modelo)
//  Busca en los mensajes del cliente localidades / barrios / partidos de data/localidades_cobertura.json
//  (generado con scripts/generar_localidades.js desde la API Georef) y arma las líneas "ZONA DETECTADA"
//  que van al CONTEXTO EN TIEMPO REAL del bot.
//  Coincidencia por frase completa, la más larga primero ("villa del parque" gana sobre "parque").
//  Se descartan menciones que son calles ("Av. Rivadavia", "Moreno 1500").
// ─────────────────────────────────────────────────────────────────────
import fs from "fs";

// minúsculas, sin tildes, solo letras/números separados por un espacio ("Ramos Mejía!" → "ramos mejia").
export function normalizarZona(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

let _datos = null, _claves = null;
function cargar() {
  if (_datos) return;
  try {
    _datos = JSON.parse(fs.readFileSync(new URL("../data/localidades_cobertura.json", import.meta.url), "utf8"));
  } catch (e) {
    console.error("Zona de cobertura: no se pudo leer data/localidades_cobertura.json:", e.message);
    _datos = {};
  }
  _claves = Object.keys(_datos).sort((a, b) => b.length - a.length);   // la más larga primero
}

// Palabras antes / después que indican que es una CALLE y no una zona.
const PREFIJOS_CALLE = new Set(["av", "avda", "avenida", "calle", "pasaje", "pje", "diagonal", "diag", "bv", "boulevard", "bulevar", "ruta", "esquina"]);
// Una zona de UNA sola palabra ("Caseros", "Olivos") se toma solo si viene después de una de estas palabras
// ("en Caseros", "llegan a Olivos", "zona Belgrano") o si el mensaje es muy corto (la respuesta a "¿qué zona?").
// Así no se confunden nombres y apellidos ("soy Paula Gómez") con localidades.
const PISTAS_LUGAR = new Set(["en", "a", "de", "del", "para", "desde", "hasta", "por", "zona", "barrio", "localidad", "partido", "cerca", "llegan", "llega", "vivo", "envio"]);
const MAX_PALABRAS_MENSAJE_CORTO = 4;
// Localidades de una palabra que también son nombres, apellidos o palabras comunes: sin pista, no cuentan.
const NOMBRES_COMUNES = new Set([
  "paula", "irene", "elvira", "estela", "ernestina", "veronica", "agustina", "ariel", "marisol", "hortensia", "fatima",
  "dolores", "mercedes", "victoria", "magdalena", "libertad", "porvenir", "america", "monte", "faro", "azul", "lima",
  "flores", "boca", "salto", "pila", "cascada", "bosques", "espigas", "oriente", "colon", "lincoln", "lopez", "gomez",
  "torres", "smith", "todd", "pereyra", "salazar", "valdes", "vasquez", "rivera", "olivera", "navarro", "pardo",
  "castilla", "roberts", "pearson", "franklin", "barker", "zelaya", "solis", "acevedo", "bermudez", "aparicio",
  "altamirano", "martinez", "ramos", "moreno", "suarez",
]);

// Zonas mencionadas en UN texto → [{ clave, opciones: [{ nombre, partido, costo, modalidad, cobertura }] }]
export function zonasEnTexto(texto) {
  cargar();
  const norm = normalizarZona(texto);
  const corto = norm.split(" ").filter(Boolean).length <= MAX_PALABRAS_MENSAJE_CORTO;
  let t = ` ${norm} `;
  const out = [];
  for (const k of _claves) {
    const aguja = ` ${k} `;
    let i = t.indexOf(aguja);
    while (i !== -1) {
      const antes = t.slice(0, i).trim().split(" ").pop();
      const despues = t.slice(i + aguja.length).trim().split(" ");
      // Calle: "av rivadavia", "moreno 1500", "cabildo y juramento", "cabildo esquina juramento".
      const esCalle = PREFIJOS_CALLE.has(antes) || /^[0-9]+$/.test(despues[0] || "")
        || ((despues[0] === "y" || despues[0] === "esquina") && despues[1] && !PISTAS_LUGAR.has(despues[1]));
      const unaPalabra = !k.includes(" ");
      const conPista = PISTAS_LUGAR.has(antes);
      const valida = !esCalle && (!unaPalabra || conPista || (corto && !NOMBRES_COMUNES.has(k)));
      // Se "tapa" lo encontrado para que una frase más corta no vuelva a coincidir adentro.
      t = t.slice(0, i + 1) + "#".repeat(k.length) + t.slice(i + 1 + k.length);
      if (valida && !out.some((o) => o.clave === k)) {
        const v = _datos[k];
        out.push({ clave: k, opciones: Array.isArray(v) ? v : [v] });
      }
      i = t.indexOf(aguja, i + 1);
    }
  }
  return out;
}

// Mensajes de la charla → zonas del mensaje del CLIENTE más reciente que mencione alguna.
export function detectarZonas(messages) {
  const delCliente = (messages || []).filter((m) => m?.role === "user");
  for (let i = delCliente.length - 1; i >= 0; i--) {
    const c = delCliente[i].content;
    const texto = typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text || "").join(" ") : "";
    const zonas = zonasEnTexto(texto);
    if (zonas.length) return zonas;
  }
  return [];
}

const pesos = (n) => `$${Number(n).toLocaleString("es-AR")}`;
function describir(o) {
  if (!o.cobertura) return `partido ${o.partido} → SIN COBERTURA (no está en la tabla de envíos)`;
  if (o.partido === "CABA") return `CABA → envío ${pesos(o.costo)} → entrega en el día o reserva para otro día`;
  return `partido ${o.partido} → envío ${pesos(o.costo)} → solo reserva, 1 día de anticipación`;
}

// Líneas para el CONTEXTO EN TIEMPO REAL ("" si no se detectó nada).
export function lineasZona(zonas) {
  return zonas.map(({ opciones }) => {
    if (opciones.length === 1) return `- ZONA DETECTADA: ${opciones[0].nombre} → ${describir(opciones[0])}.`;
    return `- ZONA DETECTADA (AMBIGUA): "${opciones[0].nombre}" existe en ${opciones.length} partidos: `
      + opciones.map((o) => describir(o)).join(" | ")
      + ". Preguntale al cliente en cuál de esos partidos es antes de cotizar el envío.";
  }).join("\n");
}
