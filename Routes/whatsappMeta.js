// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappMeta.js  ·  Helpers de la Graph API de Meta (WhatsApp Cloud API)
//  Sin Express: lo usan el webhook (media entrante, estados de plantillas) y la bandeja
//  (envío de plantillas y archivos, alta y sincronización de plantillas).
//  Usa: WA_TOKEN, WA_PHONE_NUMBER_ID, WA_WABA_ID, WA_GRAPH_VERSION (default v25.0).
// ─────────────────────────────────────────────────────────────────────
import axios from "axios";
import crypto from "crypto";

const NL = String.fromCharCode(10);
const CRLF = String.fromCharCode(13, 10);
export const MAX_ARCHIVO_SALIENTE = 10 * 1024 * 1024;   // 10 MB (imagen o PDF desde el panel)
export const MIMES_SALIENTES = ["image/jpeg", "image/png", "application/pdf"];
export const TIPOS_MEDIA = ["image", "audio", "video", "document", "sticker"];

export function waConfig() {
  return {
    token: process.env.WA_TOKEN,
    phoneId: process.env.WA_PHONE_NUMBER_ID,
    wabaId: process.env.WA_WABA_ID,
    version: process.env.WA_GRAPH_VERSION || "v25.0",
  };
}

// Error legible de Meta (code · título · mensaje para el usuario), sin tokens.
export function errorMeta(e) {
  const er = e?.response?.data?.error;
  if (!er) return String(e?.message || e || "error desconocido").slice(0, 300);
  return [er.code, er.error_user_title, er.error_user_msg || er.message].filter(Boolean).join(" · ").slice(0, 500);
}

export async function graph(method, ruta, { data, params, headers, responseType } = {}) {
  const { token, version } = waConfig();
  if (!token) throw new Error("Falta WA_TOKEN");
  return axios({
    method,
    url: ruta.startsWith("http") ? ruta : `https://graph.facebook.com/${version}/${ruta}`,
    data, params, responseType,
    timeout: 30000,
    maxContentLength: 110 * 1024 * 1024,   // media entrante: Meta permite hasta ~100 MB (video)
    maxBodyLength: 20 * 1024 * 1024,
    headers: { Authorization: `Bearer ${token}`, ...(headers || {}) },
  });
}

// ── Media ──
// Entrante: GET /{media_id} → url temporal; GET url (con el token) → binario.
export async function descargarMediaMeta(mediaId) {
  const info = (await graph("get", String(mediaId))).data;
  const bin = await graph("get", info.url, { responseType: "arraybuffer" });
  const buffer = Buffer.from(bin.data);
  return { buffer, mime: (info.mime_type || bin.headers?.["content-type"] || "").split(";")[0] || null, bytes: Number(info.file_size) || buffer.length };
}

// multipart/form-data armado a mano (sin dependencias nuevas).
function multipart(campos, archivo) {
  const boundary = "----piccadely" + crypto.randomBytes(12).toString("hex");
  const nombre = String(archivo.nombre || "archivo").replace(/[^A-Za-z0-9._ -]/g, "_");
  const partes = [];
  for (const [k, v] of Object.entries(campos)) {
    partes.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`));
  }
  partes.push(Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${nombre}"${CRLF}Content-Type: ${archivo.mime}${CRLF}${CRLF}`));
  partes.push(archivo.buffer);
  partes.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
  return { body: Buffer.concat(partes), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Saliente: POST /{phone_id}/media → id para usar en el mensaje.
export async function subirMediaMeta(buffer, mime, nombre) {
  const { phoneId } = waConfig();
  if (!phoneId) throw new Error("Falta WA_PHONE_NUMBER_ID");
  const mp = multipart({ messaging_product: "whatsapp", type: mime }, { buffer, mime, nombre });
  const r = await graph("post", `${phoneId}/media`, { data: mp.body, headers: { "Content-Type": mp.contentType } });
  if (!r.data?.id) throw new Error("Meta no devolvió el id del archivo");
  return r.data.id;
}

// Envía cualquier mensaje (template, image, document…). `to` ya convertido con numeroParaEnviar.
export async function enviarMensajeMeta(to, payload) {
  const { phoneId } = waConfig();
  if (!phoneId) return { error: "Falta WA_PHONE_NUMBER_ID" };
  try {
    const r = await graph("post", `${phoneId}/messages`, { data: { messaging_product: "whatsapp", recipient_type: "individual", to, ...payload } });
    return { id: r.data?.messages?.[0]?.id || null };
  } catch (e) { return { error: errorMeta(e) }; }
}

const EXT_POR_MIME = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/ogg": "ogg", "audio/mpeg": "mp3",
  "audio/mp4": "m4a", "audio/aac": "aac", "audio/amr": "amr", "video/mp4": "mp4", "video/3gpp": "3gp", "application/pdf": "pdf",
};
// Clave en R2: wa/{conversación}/{mensaje}-{aleatorio}.{ext}
export function claveArchivo(conversacionId, mensajeId, mime, nombre) {
  const m = String(mime || "").split(";")[0].trim();
  let ext = EXT_POR_MIME[m];
  if (!ext && nombre && nombre.includes(".")) ext = nombre.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return `wa/${conversacionId}/${mensajeId}-${crypto.randomBytes(4).toString("hex")}.${ext || "bin"}`;
}

// ── Plantillas ──
// Variables {{n}} de un texto (únicas y ordenadas).
export function variablesDe(texto) {
  const nums = [...String(texto || "").matchAll(/{{([0-9]+)}}/g)].map(m => Number(m[1]));
  return [...new Set(nums)].sort((a, b) => a - b);
}
const reemplazar = (texto, valores) => String(texto || "").replace(/{{([0-9]+)}}/g, (t, n) => (valores?.[Number(n) - 1] ?? t));

export function partesPlantilla(componentes) {
  const c = Array.isArray(componentes) ? componentes : [];
  const tipo = (t) => c.find(x => String(x.type).toUpperCase() === t);
  return { header: tipo("HEADER"), body: tipo("BODY"), footer: tipo("FOOTER"), botones: tipo("BUTTONS")?.buttons || [] };
}

// Se puede mandar desde el panel: header solo de texto (o sin header) y botones sin variables.
export function soportadaParaEnvio(componentes) {
  const { header, body, botones } = partesPlantilla(componentes);
  if (!body) return false;
  if (header && String(header.format || "TEXT").toUpperCase() !== "TEXT") return false;
  if (botones.some(b => String(b.url || "").includes("{{"))) return false;
  const conocidos = ["HEADER", "BODY", "FOOTER", "BUTTONS"];
  return (componentes || []).every(x => conocidos.includes(String(x.type).toUpperCase()));
}

// Texto que ve el cliente, con las variables ya completadas (para guardarlo en el chat).
export function renderPlantilla(componentes, variables = [], variablesHeader = []) {
  const { header, body, footer, botones } = partesPlantilla(componentes);
  const lineas = [];
  if (header?.text) lineas.push(`*${reemplazar(header.text, variablesHeader)}*`);
  if (body?.text) lineas.push(reemplazar(body.text, variables));
  if (footer?.text) lineas.push(`_${footer.text}_`);
  if (botones.length) lineas.push(botones.map(b => `[${b.text}]`).join(" "));
  return lineas.join(NL + NL);
}

// Componentes de envío (parámetros de header y body). Meta no acepta saltos de línea ni tabs en parámetros.
export function componentesEnvio(componentes, variables = [], variablesHeader = []) {
  const { header, body } = partesPlantilla(componentes);
  const limpio = (v) => String(v ?? "").replace(/[ ]*[\r\n\t]+[ ]*/g, " ").replace(/ {4,}/g, "   ").trim();
  const out = [];
  if (header?.text && variablesDe(header.text).length) out.push({ type: "header", parameters: variablesHeader.map(v => ({ type: "text", text: limpio(v) })) });
  if (body?.text && variablesDe(body.text).length) out.push({ type: "body", parameters: variables.map(v => ({ type: "text", text: limpio(v) })) });
  return out;
}

// Valida que se completaron todas las variables. Devuelve mensaje de error o null.
export function validarVariables(componentes, variables = [], variablesHeader = []) {
  const { header, body } = partesPlantilla(componentes);
  const nb = variablesDe(body?.text).length, nh = variablesDe(header?.text).length;
  if ((variables || []).length !== nb || (variables || []).some(v => !String(v ?? "").trim())) return `Completá las ${nb} variable(s) del cuerpo.`;
  if ((variablesHeader || []).length !== nh || (variablesHeader || []).some(v => !String(v ?? "").trim())) return `Completá la variable del encabezado.`;
  return null;
}

// Valida y arma la definición para POST /{waba_id}/message_templates. Devuelve { error } o { def }.
export function armarNuevaPlantilla(b) {
  const nombre = String(b.nombre || "").trim();
  if (!/^[a-z0-9_]{1,512}$/.test(nombre)) return { error: "Nombre inválido: solo minúsculas, números y guion bajo (ej. confirmacion_pedido)." };
  const categoria = String(b.categoria || "").toUpperCase();
  if (!["UTILITY", "MARKETING"].includes(categoria)) return { error: "Categoría inválida: Utility o Marketing." };
  const idioma = String(b.idioma || "es_AR");
  const cuerpo = String(b.cuerpo || "").trim();
  if (!cuerpo) return { error: "El cuerpo es obligatorio." };
  if (cuerpo.length > 1024) return { error: "El cuerpo no puede superar los 1024 caracteres." };
  const vars = variablesDe(cuerpo);
  if (vars.some((n, i) => n !== i + 1)) return { error: "Las variables del cuerpo tienen que ser consecutivas desde {{1}} ({{1}}, {{2}}, …)." };
  if (/^{{[0-9]+}}/.test(cuerpo) || /{{[0-9]+}}$/.test(cuerpo)) return { error: "Meta no acepta que el cuerpo empiece o termine con una variable." };
  const ejemplos = (b.ejemplos_cuerpo || []).map(x => String(x ?? "").trim());
  if (vars.length && (ejemplos.length !== vars.length || ejemplos.some(x => !x))) return { error: `Cargá un ejemplo para cada variable del cuerpo (${vars.length}). Meta los pide para aprobar.` };

  const componentes = [];
  const headerTexto = String(b.header_texto || "").trim();
  if (headerTexto) {
    if (headerTexto.length > 60) return { error: "El encabezado no puede superar los 60 caracteres." };
    const vh = variablesDe(headerTexto);
    if (vh.length > 1 || (vh.length === 1 && vh[0] !== 1)) return { error: "El encabezado admite como máximo una variable: {{1}}." };
    const h = { type: "HEADER", format: "TEXT", text: headerTexto };
    if (vh.length) {
      const ej = String(b.ejemplo_header || "").trim();
      if (!ej) return { error: "Cargá un ejemplo para la variable del encabezado." };
      h.example = { header_text: [ej] };
    }
    componentes.push(h);
  }
  const bodyComp = { type: "BODY", text: cuerpo };
  if (vars.length) bodyComp.example = { body_text: [ejemplos] };
  componentes.push(bodyComp);

  const botones = [];
  for (const bt of (b.botones || []).slice(0, 10)) {
    const texto = String(bt.texto || "").trim();
    if (!texto) continue;
    if (texto.length > 25) return { error: `El texto del botón "${texto}" supera los 25 caracteres.` };
    if (bt.tipo === "QUICK_REPLY") botones.push({ type: "QUICK_REPLY", text: texto });
    else if (bt.tipo === "URL") {
      const url = String(bt.url || "").trim();
      if (!/^https:[/][/][^ ]+$/.test(url)) return { error: `El botón "${texto}" necesita una URL que empiece con https://` };
      botones.push({ type: "URL", text: texto, url });
    } else if (bt.tipo === "PHONE_NUMBER") {
      const tel = String(bt.telefono || "").replace(/[^0-9+]/g, "");
      if (tel.replace(/[^0-9]/g, "").length < 8) return { error: `El botón "${texto}" necesita un teléfono válido (con código de país, ej. +5491162393600).` };
      botones.push({ type: "PHONE_NUMBER", text: texto, phone_number: tel.startsWith("+") ? tel : "+" + tel });
    } else return { error: "Tipo de botón inválido." };
  }
  if (botones.length) componentes.push({ type: "BUTTONS", buttons: botones });
  return { def: { name: nombre, category: categoria, language: idioma, components: componentes } };
}

export async function crearPlantillaMeta(def) {
  const { wabaId } = waConfig();
  if (!wabaId) throw new Error("Falta WA_WABA_ID");
  return (await graph("post", `${wabaId}/message_templates`, { data: def })).data;   // { id, status, category }
}

// Todas las plantillas de la cuenta (pagina con el cursor "after").
export async function listarPlantillasMeta() {
  const { wabaId } = waConfig();
  if (!wabaId) throw new Error("Falta WA_WABA_ID");
  const out = [];
  let after = null;
  for (let i = 0; i < 50; i++) {
    const r = await graph("get", `${wabaId}/message_templates`, {
      params: { fields: "id,name,status,category,language,components,rejected_reason", limit: 100, ...(after ? { after } : {}) },
    });
    out.push(...(r.data?.data || []));
    after = r.data?.paging?.cursors?.after;
    if (!r.data?.paging?.next || !after) break;
  }
  return out;
}
