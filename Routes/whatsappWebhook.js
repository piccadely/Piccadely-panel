// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappWebhook.js  ·  Webhook de WhatsApp Cloud API (Meta)
//  Montar en server.js:
//     import { whatsappWebhookRouter } from "./Routes/whatsappWebhook.js";
//     app.use("/api/whatsapp", whatsappWebhookRouter(pool));
//  Endpoints resultantes:
//     GET  /api/whatsapp/webhook  → verificación de Meta (hub.mode / hub.verify_token / hub.challenge)
//     POST /api/whatsapp/webhook  → eventos (mensajes entrantes, statuses). Valida X-Hub-Signature-256.
//  Usa: process.env.WA_VERIFY_TOKEN   (el mismo texto que se carga en Meta > Webhooks > Verify token)
//       process.env.WA_APP_SECRET     (App Secret de la app de Meta, para validar la firma del POST)
//       process.env.WA_TOKEN          (token de acceso para enviar por la Cloud API)
//       process.env.WA_PHONE_NUMBER_ID (ID del número emisor en la Cloud API)
//       process.env.WA_GRAPH_VERSION  (opcional, default v25.0)
//  Requiere que server.js deje el body crudo en req.rawBody (express.json({ verify })).
//
//  Flujo del POST: valida la firma → responde 200 YA (Meta corta a los pocos segundos y reintenta)
//  → recién después procesa: guarda el mensaje (ignora duplicados por message.id), arma el historial
//  desde la base, llama al MISMO bot que usa Botmaker (responderBot), envía la respuesta por la Cloud
//  API y la guarda como saliente. Si el bot pide [HANDOFF], la conversación pasa a "pendiente_agente"
//  y el bot deja de contestar solo. Los statuses (sent/delivered/read/failed) se registran aparte.
//  /api/bot/whatsapp (Botmaker) no se toca.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import crypto from "crypto";
import axios from "axios";
import { responderBot } from "./botWhatsapp.js";

const NL = String.fromCharCode(10);
const HISTORIAL_MAX = 30;             // mensajes que se leen de la base (el bot después usa los últimos 14)
const ORDEN_STATUS = ["accepted", "sent", "delivered", "read"];   // 'failed' gana siempre

// Firma de Meta: "sha256=" + HMAC-SHA256(body crudo, App Secret). Comparación en tiempo constante.
function firmaValida(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(String(header)), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Número AR canónico para que un cliente no quede en dos conversaciones: 549 + 10 dígitos.
// Meta puede mandar 5491112345678 (con 9) o 541112345678 (sin 9) según el caso.
export function normalizarWaId(raw) {
  let d = String(raw || "").replace(/[^0-9]/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54") && !d.startsWith("549") && d.length === 12) d = "549" + d.slice(2);
  return d;
}

// Texto legible de un mensaje entrante (null si no tiene texto: audio, imagen, sticker, etc.).
function textoDe(m) {
  if (m.type === "text") return m.text?.body ?? null;
  if (m.type === "button") return m.button?.text ?? null;
  if (m.type === "interactive") return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
  return null;
}

const tsMeta = (s) => (s ? new Date(Number(s) * 1000) : null);

// Cola en memoria por conversación: los mensajes de un mismo cliente se procesan de a uno, en orden.
const colas = new Map();
function encolar(clave, tarea) {
  const previa = colas.get(clave) || Promise.resolve();
  const siguiente = previa.then(tarea).catch((e) => console.error("WhatsApp: error procesando:", e.message)).finally(() => {
    if (colas.get(clave) === siguiente) colas.delete(clave);
  });
  colas.set(clave, siguiente);
  return siguiente;
}

// Número al que se ENVÍA por la Cloud API. Meta manda el wa_id argentino con el 9 (549XXXXXXXXXX),
// pero para enviar hay que usarlo sin el 9 (54XXXXXXXXXX); si no, da 131030 "recipient not in
// allowed list". Solo afecta el envío: la clave interna de la conversación sigue siendo 549….
export function numeroParaEnviar(raw) {
  const d = String(raw || "").replace(/[^0-9]/g, "");
  return (d.startsWith("549") && d.length === 13) ? "54" + d.slice(3) : d;
}

// Envía un texto por la Cloud API. Devuelve { id } o { error }. Lo usan el bot y la bandeja de agentes.
export async function enviarTexto(destino, body) {
  const to = numeroParaEnviar(destino);
  const token = process.env.WA_TOKEN, phoneId = process.env.WA_PHONE_NUMBER_ID;
  if (!token || !phoneId) return { error: "Faltan WA_TOKEN o WA_PHONE_NUMBER_ID" };
  const version = process.env.WA_GRAPH_VERSION || "v25.0";
  try {
    const r = await axios.post(
      `https://graph.facebook.com/${version}/${phoneId}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15000 }
    );
    return { id: r.data?.messages?.[0]?.id || null };
  } catch (e) {
    const err = e.response?.data?.error;
    return { error: err ? `${err.code || ""} ${err.message || ""}`.trim() : e.message };
  }
}

// Historial para el bot: roles alternados user/assistant, arrancando y terminando en user.
async function armarHistorial(pool, conversacionId) {
  const { rows } = await pool.query(
    `SELECT direccion, tipo, texto, estado FROM wa_mensajes
     WHERE conversacion_id = $1 AND tipo <> 'reaction'
     ORDER BY id DESC LIMIT ${HISTORIAL_MAX}`,
    [conversacionId]
  );
  const msgs = [];
  for (const r of rows.reverse()) {
    let role, content;
    if (r.direccion === "in") {
      role = "user";
      content = r.texto || `[El cliente mandó un ${r.tipo} que no podés ver ni escuchar. Pedile con buena onda que lo escriba.]`;
    } else {
      if (r.estado === "failed" || !r.texto) continue;   // lo que no le llegó al cliente no cuenta como dicho
      role = "assistant"; content = r.texto;
    }
    const ult = msgs[msgs.length - 1];
    if (ult && ult.role === role) ult.content += NL + content;   // Claude exige roles alternados
    else msgs.push({ role, content });
  }
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

// Debounce por conversación: cada mensaje entrante reinicia la espera; se responde UNA vez cuando el
// cliente deja de escribir (si manda 3 mensajes seguidos, sale una sola respuesta con todo el historial).
// En memoria: asume una sola instancia del backend (Railway con 1 réplica).
const DEBOUNCE_MS = Number(process.env.WA_DEBOUNCE_MS) || 2500;
const timers = new Map();
function programarRespuesta(pool, conversacionId) {
  clearTimeout(timers.get(conversacionId));
  timers.set(conversacionId, setTimeout(() => {
    timers.delete(conversacionId);
    encolar(conversacionId, () => responderUltimo(pool, conversacionId));
  }, DEBOUNCE_MS));
}

// Responde al último mensaje entrante de la conversación, si todavía no tiene respuesta.
async function responderUltimo(pool, conversacionId) {
  const ult = await pool.query(
    `SELECT MAX(id) FILTER (WHERE direccion = 'in' AND tipo <> 'reaction') AS ult_in,
            MAX(id) FILTER (WHERE direccion = 'out') AS ult_out
     FROM wa_mensajes WHERE conversacion_id = $1`,
    [conversacionId]
  );
  const { ult_in, ult_out } = ult.rows[0] || {};
  if (!ult_in || (ult_out && ult_out > ult_in)) return;   // nada nuevo del cliente desde la última respuesta
  const conv = await pool.query("SELECT estado, telefono_envio FROM wa_conversaciones WHERE id = $1", [conversacionId]);
  if (!conv.rows[0] || conv.rows[0].estado !== "bot") return;   // ya la tiene un agente

  const historial = await armarHistorial(pool, conversacionId);
  if (!historial.length) return;
  let res;
  try { res = await responderBot(historial, {}); }
  catch (e) { console.error("WhatsApp: el bot no pudo responder (conversación", conversacionId + "):", e.message); return; }
  const { reply, handoff } = res;

  if (reply) {
    const envio = await enviarTexto(conv.rows[0].telefono_envio, reply);
    await pool.query(
      `INSERT INTO wa_mensajes (conversacion_id, wa_message_id, direccion, autor, tipo, texto, estado, error)
       VALUES ($1, $2, 'out', 'bot', 'text', $3, $4, $5)`,
      [conversacionId, envio.id || null, reply, envio.error ? "failed" : "accepted", envio.error || null]
    );
    if (envio.error) console.error("WhatsApp: falló el envío (conversación", conversacionId + "):", envio.error);
    else await sincronizarEstado(pool, envio.id);   // por si el status llegó antes de guardar el saliente
    await pool.query("UPDATE wa_conversaciones SET ultimo_mensaje_at = NOW(), updated_at = NOW() WHERE id = $1", [conversacionId]);
  }
  if (handoff) {
    await pool.query(
      "UPDATE wa_conversaciones SET estado = 'pendiente_agente', handoff_at = NOW(), updated_at = NOW() WHERE id = $1 AND estado = 'bot'",
      [conversacionId]
    );
    console.log("WhatsApp: conversación", conversacionId, "derivada a agente.");
  }
}

// Mensaje entrante: guarda (idempotente por message.id) y encola la respuesta.
async function procesarEntrante(pool, m, nombre) {
  if (!m?.id || !m?.from) return;
  const waId = normalizarWaId(m.from);
  const conv = await pool.query(
    `INSERT INTO wa_conversaciones (wa_id, telefono_envio, nombre, ultimo_mensaje_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (wa_id) DO UPDATE SET
       telefono_envio = EXCLUDED.telefono_envio,
       nombre = COALESCE(EXCLUDED.nombre, wa_conversaciones.nombre),
       -- una conversación cerrada que vuelve a escribir se reabre con el bot (sin agente);
       -- 'pendiente_agente' y 'agente' se respetan (el bot no contesta)
       estado = CASE WHEN wa_conversaciones.estado = 'cerrada' THEN 'bot' ELSE wa_conversaciones.estado END,
       agente_id = CASE WHEN wa_conversaciones.estado = 'cerrada' THEN NULL ELSE wa_conversaciones.agente_id END,
       asignada_at = CASE WHEN wa_conversaciones.estado = 'cerrada' THEN NULL ELSE wa_conversaciones.asignada_at END,
       ultimo_mensaje_at = NOW(), updated_at = NOW()
     RETURNING id`,
    [waId, String(m.from), nombre || null]
  );
  const conversacionId = conv.rows[0].id;
  const ins = await pool.query(
    `INSERT INTO wa_mensajes (conversacion_id, wa_message_id, direccion, autor, tipo, texto, wa_timestamp)
     VALUES ($1, $2, 'in', 'cliente', $3, $4, $5)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [conversacionId, m.id, m.type || "unknown", textoDe(m), tsMeta(m.timestamp)]
  );
  if (ins.rows.length === 0) return;          // duplicado: Meta reintentó un mensaje ya guardado
  // Ventana de 24 h (cuenta desde el último mensaje del cliente) + no leídos para la bandeja.
  // Va DESPUÉS del insert para que un reintento de Meta no sume un no leído de más.
  await pool.query(
    `UPDATE wa_conversaciones SET
       ultimo_entrante_at = GREATEST(COALESCE(ultimo_entrante_at, $2), $2),
       no_leidos = no_leidos + $3
     WHERE id = $1`,
    [conversacionId, tsMeta(m.timestamp) || new Date(), m.type === "reaction" ? 0 : 1]
  );
  if (m.type === "reaction") return;           // las reacciones se guardan pero no se contestan
  programarRespuesta(pool, conversacionId);    // responderUltimo() solo contesta si estado = 'bot'
}

// Pone en el mensaje saliente el status más avanzado registrado (failed gana siempre).
export async function sincronizarEstado(pool, waMessageId) {
  if (!waMessageId) return;
  await pool.query(
    `UPDATE wa_mensajes m SET estado = s.status, error = COALESCE(s.error, m.error)
     FROM (SELECT status, error FROM wa_statuses WHERE wa_message_id = $1
           ORDER BY CASE status WHEN 'failed' THEN 9 WHEN 'read' THEN 3 WHEN 'delivered' THEN 2 WHEN 'sent' THEN 1 ELSE 0 END DESC
           LIMIT 1) s
     WHERE m.wa_message_id = $1`,
    [waMessageId]
  );
}

// Status de un mensaje saliente (sent / delivered / read / failed). Idempotente por (id, status).
async function procesarStatus(pool, s) {
  if (!s?.id || !s?.status) return;
  const e = s.errors?.[0];
  const error = e ? `${e.code || ""} ${e.title || e.message || ""}`.trim() : null;
  const ins = await pool.query(
    `INSERT INTO wa_statuses (wa_message_id, status, wa_timestamp, error) VALUES ($1, $2, $3, $4)
     ON CONFLICT (wa_message_id, status) DO NOTHING RETURNING id`,
    [s.id, s.status, tsMeta(s.timestamp), error]
  );
  if (ins.rows.length === 0) return;   // status repetido
  // Solo avanza (accepted < sent < delivered < read); failed pisa todo.
  await pool.query(
    `UPDATE wa_mensajes SET estado = $2, error = COALESCE($3, error)
     WHERE wa_message_id = $1
       AND ($2 = 'failed' OR COALESCE(array_position($4::text[], estado), 0) < COALESCE(array_position($4::text[], $2), 0))`,
    [s.id, s.status, error, ORDEN_STATUS]
  );
}

// Procesa el payload completo del webhook (después de haber respondido 200).
async function procesarEvento(pool, body) {
  const resumen = { mensajes: 0, estados: 0, tipos: {} };
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const nombres = {};
      for (const c of v.contacts || []) if (c.wa_id) nombres[c.wa_id] = c.profile?.name || null;
      for (const m of v.messages || []) {
        resumen.mensajes++; resumen.tipos[m.type] = (resumen.tipos[m.type] || 0) + 1;
        try { await procesarEntrante(pool, m, nombres[m.from]); }
        catch (e) { console.error("WhatsApp: error guardando mensaje entrante:", e.message); }
      }
      for (const s of v.statuses || []) {
        resumen.estados++;
        try { await procesarStatus(pool, s); }
        catch (e) { console.error("WhatsApp: error guardando status:", e.message); }
      }
    }
  }
  // Log mínimo, SIN datos personales (ni teléfonos ni textos).
  console.log("WhatsApp webhook:", JSON.stringify(resumen));
}

// TODO(huérfanos del debounce): si el backend se reinicia (deploy, crash) durante la espera del debounce,
// el último mensaje del cliente queda guardado pero sin respuesta, porque el timer vivía en memoria.
// Por ahora SOLO se reporta al arrancar. Falta decidir qué hacer: responderlos automáticamente (ojo:
// pueden ser viejos y el cliente ya no espera) o pasarlos a la bandeja como pendientes para un agente.
// También aparecen acá las conversaciones donde el bot falló al responder (error de Anthropic o de envío).
export async function revisarHuerfanosWhatsApp(pool) {
  try {
    const { rows } = await pool.query(`
      SELECT c.id
      FROM wa_conversaciones c
      JOIN LATERAL (
        SELECT MAX(id) FILTER (WHERE direccion = 'in' AND tipo <> 'reaction') AS ult_in,
               MAX(id) FILTER (WHERE direccion = 'out') AS ult_out,
               MAX(created_at) FILTER (WHERE direccion = 'in' AND tipo <> 'reaction') AS ult_in_at
        FROM wa_mensajes m WHERE m.conversacion_id = c.id
      ) u ON true
      WHERE c.estado = 'bot' AND u.ult_in IS NOT NULL AND (u.ult_out IS NULL OR u.ult_out < u.ult_in)
      ORDER BY u.ult_in_at DESC
      LIMIT 50`);
    if (rows.length) {
      // Solo ids de conversación (sin teléfonos ni textos).
      console.warn(`WhatsApp: ${rows.length === 50 ? "50+" : rows.length} conversación(es) en modo bot con el último mensaje del cliente SIN responder al arrancar (ids: ${rows.map(r => r.id).join(", ")}). Posible reinicio durante el debounce o fallo del bot: revisar.`);
    } else {
      console.log("WhatsApp: sin mensajes entrantes huérfanos al arrancar.");
    }
  } catch (e) { console.error("WhatsApp: no se pudo revisar mensajes huérfanos:", e.message); }
}

export function whatsappWebhookRouter(pool) {
  const router = express.Router();

  // GET /api/whatsapp/webhook — verificación de suscripción.
  // Meta llama con ?hub.mode=subscribe&hub.verify_token=XXX&hub.challenge=NNN y espera el challenge
  // tal cual, en texto plano y con 200. Cualquier otra cosa → 403.
  router.get("/webhook", (req, res) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const esperado = process.env.WA_VERIFY_TOKEN;
    if (!esperado) {
      console.error("WhatsApp webhook: falta WA_VERIFY_TOKEN en las variables de entorno.");
      return res.status(500).type("text/plain").send("WA_VERIFY_TOKEN no configurado");
    }
    if (mode === "subscribe" && token === esperado && challenge != null) {
      return res.status(200).type("text/plain").send(String(challenge));
    }
    console.warn("WhatsApp webhook: verificación rechazada (mode/token inválidos).");
    return res.status(403).type("text/plain").send("Forbidden");
  });

  // POST /api/whatsapp/webhook — eventos. Meta exige 200 rápido; si no, reintenta.
  router.post("/webhook", (req, res) => {
    // Fail-closed: sin App Secret no se aceptan eventos (nunca se procesa algo sin validar la firma).
    const secret = process.env.WA_APP_SECRET;
    if (!secret) {
      console.error("WhatsApp webhook: falta WA_APP_SECRET, evento rechazado.");
      return res.status(500).type("text/plain").send("WA_APP_SECRET no configurado");
    }
    // La firma se calcula sobre los BYTES ORIGINALES del request (req.rawBody), nunca sobre
    // JSON.stringify(req.body): Meta firma el payload con tildes y emojis escapados en unicode y
    // re-serializarlo cambia los bytes → los mensajes reales darían 401.
    if (!firmaValida(req.rawBody, req.headers["x-hub-signature-256"], secret)) {
      console.warn("WhatsApp webhook: firma inválida, evento descartado.");
      return res.sendStatus(401);
    }

    // 200 inmediato; el procesamiento (base + bot + envío) corre después, fuera del ciclo del request.
    res.sendStatus(200);
    const body = req.body;
    setImmediate(() => {
      procesarEvento(pool, body).catch((e) => console.error("WhatsApp webhook: error procesando evento:", e.message));
    });
  });

  return router;
}
