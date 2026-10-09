// ─────────────────────────────────────────────────────────────────────
//  scripts/generar_localidades.js  ·  Genera data/localidades_cobertura.json (se corre a mano, una vez)
//    node scripts/generar_localidades.js
//  Fuente oficial: API Georef (apis.datos.gob.ar/georef), del Gobierno de la Nación:
//    - localidades de la provincia de Buenos Aires (provincia=06), con su partido (departamento);
//    - barrios de CABA (provincia=02: Georef los publica como localidades).
//  Se incluyen TODAS las localidades de la provincia: las de partidos fuera de la tabla quedan con
//  cobertura:false, así el bot puede decir "no llegamos" solo cuando la zona es conocida y está afuera.
//  Costos y modalidad: copia de la tabla "Cobertura y costos de envío por partido" del SYSTEM_BOT
//  (Routes/botWhatsapp.js). Si cambia la tabla, actualizar COBERTURA y volver a correr el script.
//  Formato: { "santos lugares": { nombre, partido, costo, modalidad, cobertura }, ... }
//  Si un nombre existe en más de un partido, el valor es un ARRAY con una entrada por partido.
// ─────────────────────────────────────────────────────────────────────
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { normalizarZona } from "../Routes/zonaCobertura.js";

const GEOREF = "https://apis.datos.gob.ar/georef/api";
const SALIDA = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "localidades_cobertura.json");

// Tabla de envíos (nombre como lo dice la tabla → nombre del departamento en Georef cuando difiere).
const CABA = { partido: "CABA", costo: 2500, modalidad: "en el día" };
const COBERTURA = [
  ["Vicente López", 5000], ["San Isidro", 5000], ["San Martín", 8000, "General San Martín"], ["San Fernando", 8000],
  ["Malvinas Argentinas", 13000], ["Tigre", 13000], ["Pilar", 25000], ["Escobar", 25000], ["Tres de Febrero", 7500],
  ["San Miguel", 15000], ["José C. Paz", 15000], ["General Rodríguez", 25000], ["Morón", 12000], ["Hurlingham", 12000],
  ["Ituzaingó", 17000], ["Moreno", 17000], ["Merlo", 17000], ["La Matanza", 20000], ["Marcos Paz", 25000],
  ["Avellaneda", 6000], ["Lanús", 6000], ["Lomas de Zamora", 11000], ["Quilmes", 11000], ["Berazategui", 25000],
  ["Florencio Varela", 25000], ["Presidente Perón", 25000], ["Ezeiza", 25000], ["La Plata", 35000],
].map(([partido, costo, georef]) => ({ partido, costo, modalidad: "1 día", georef: georef || partido }));

// Alias comunes que Georef no trae o escribe distinto (se suman a lo de Georef; si el nombre ya existe en
// otro partido, queda ambiguo y el bot pregunta).
const ALIAS = {
  "CABA": ["capital", "caba", "capital federal", "ciudad de buenos aires", "ciudad autonoma de buenos aires", "buenos aires capital"],
  "Vicente López": ["vicente lopez", "olivos", "florida", "florida oeste", "munro", "villa martelli", "la lucila", "carapachay", "villa adelina"],
  "San Isidro": ["martinez", "acassuso", "beccar", "boulogne", "villa adelina", "lomas de san isidro"],
  "San Martín": ["san martin", "general san martin", "villa ballester", "san andres", "villa maipu", "jose leon suarez"],
  "Tres de Febrero": ["caseros", "ciudadela", "santos lugares", "saenz pena", "villa bosch", "el palomar", "palomar", "ciudad jardin", "martin coronado"],
  "Morón": ["haedo", "castelar", "el palomar", "palomar", "moron"],
  "La Matanza": ["ramos", "ramos mejia", "san justo", "san justo la matanza", "isidro casanova", "villa luzuriaga", "lomas del mirador", "tablada", "la tablada"],
  "Lomas de Zamora": ["lomas", "banfield", "temperley", "turdera"],
  "San Miguel": ["bella vista", "muñiz", "muniz"],
  "Tigre": ["nordelta", "benavidez", "don torcuato", "pacheco", "general pacheco", "el talar"],
  "Avellaneda": ["wilde", "sarandi", "dock sud", "gerli"],
  "Lanús": ["lanus", "lanus este", "lanus oeste", "gerli", "remedios de escalada"],
  "Quilmes": ["bernal", "quilmes oeste", "ezpeleta", "don bosco"],
  "Escobar": ["garin", "ingeniero maschwitz", "maschwitz"],
  "Pilar": ["del viso", "derqui", "presidente derqui"],
  "La Plata": ["city bell", "gonnet", "tolosa", "villa elisa"],
  "Ezeiza": ["canning", "tristan suarez"],
  "Hurlingham": ["william morris", "villa tesei"],
  "José C. Paz": ["jose c paz", "jose c. paz"],
};

async function traer(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Georef ${r.status} en ${url}`);
  return r.json();
}

const datos = {};
const partidosTabla = new Set();   // claves que son el nombre de un partido de la tabla: no se vuelven ambiguas
function agregar(nombre, info) {
  const k = normalizarZona(nombre);
  if (k.length < 3) return;
  const previo = datos[k];
  if (!previo) { datos[k] = { nombre, ...info }; return; }
  if (partidosTabla.has(k)) return;   // "Malvinas Argentinas" es el partido, no la localidad de Almirante Brown
  const lista = Array.isArray(previo) ? previo : [previo];
  if (lista.some((x) => x.partido === info.partido)) return;   // mismo partido: no duplicar
  datos[k] = [...lista, { nombre, ...info }];
}

const pba = await traer(`${GEOREF}/localidades?provincia=06&max=5000&campos=nombre,departamento.nombre`);
const caba = await traer(`${GEOREF}/localidades?provincia=02&max=200&campos=nombre`);
const deptos = await traer(`${GEOREF}/departamentos?provincia=06&max=200&campos=nombre`);
console.log(`Georef: ${pba.total} localidades de Buenos Aires, ${caba.total} barrios de CABA, ${deptos.total} partidos.`);

const porGeoref = new Map(COBERTURA.map((c) => [c.georef, c]));
const faltan = COBERTURA.filter((c) => !deptos.departamentos.some((d) => d.nombre === c.georef));
if (faltan.length) throw new Error("Partidos de la tabla que Georef no reconoce: " + faltan.map((c) => c.georef).join(", "));
const infoDe = (deptoGeoref) => {
  const c = porGeoref.get(deptoGeoref);
  return c ? { partido: c.partido, costo: c.costo, modalidad: c.modalidad, cobertura: true }
           : { partido: deptoGeoref, costo: null, modalidad: null, cobertura: false };
};

for (const b of caba.localidades) agregar(b.nombre, { ...CABA, cobertura: true });
for (const c of COBERTURA) {                                                           // partidos de la tabla primero
  agregar(c.partido, infoDe(c.georef)); agregar(c.georef, infoDe(c.georef));
  partidosTabla.add(normalizarZona(c.partido)); partidosTabla.add(normalizarZona(c.georef));
}
for (const d of deptos.departamentos) agregar(d.nombre, infoDe(d.nombre));            // nombres de partidos
for (const l of pba.localidades) agregar(l.nombre, infoDe(l.departamento.nombre));
for (const [partido, alias] of Object.entries(ALIAS)) {
  const info = partido === "CABA" ? { ...CABA, cobertura: true } : infoDe(COBERTURA.find((c) => c.partido === partido).georef);
  for (const a of alias) agregar(a.replace(/\b\w/g, (x) => x.toUpperCase()), info);
}

const ordenado = Object.fromEntries(Object.keys(datos).sort().map((k) => [k, datos[k]]));
fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
fs.writeFileSync(SALIDA, JSON.stringify(ordenado, null, 1) + "\n");
const ambiguos = Object.values(ordenado).filter(Array.isArray).length;
const conCob = Object.values(ordenado).filter((v) => (Array.isArray(v) ? v : [v]).some((x) => x.cobertura)).length;
console.log(`OK: ${Object.keys(ordenado).length} nombres (${conCob} con cobertura, ${ambiguos} ambiguos) → ${path.relative(process.cwd(), SALIDA)}`);
