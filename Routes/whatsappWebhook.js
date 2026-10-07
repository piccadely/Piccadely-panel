// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappWebhook.js  ·  Webhook de WhatsApp Cloud API (Meta)
//  Montar en server.js:
//     import { whatsappWebhookRouter } from "./Routes/whatsappWebhook.js";
//     app.use("/api/whatsapp", whatsappWebhookRouter());
//  Endpoints resultantes:
//     GET  /api/whatsapp/webhook  → verificación de Meta (hub.mode / hub.verify_token / hub.challenge)
//     POST /api/whatsapp/webhook  → eventos (mensajes entrantes, estados). Valida X-Hub-Signature-256.
//  Usa: process.env.WA_VERIFY_TOKEN (el mismo texto que se carga en Meta > Webhooks > Verify token)
//       process.env.WA_APP_SECRET   (App Secret de la app de Meta, para validar la firma del POST)
//  Requiere que server.js deje el body crudo en req.rawBody (express.json({ verify })).
//
//  Fase actual: solo recibe y ACKea. Todavía NO responde con el bot ni guarda conversaciones
//  (eso va con la bandeja multiagente). Botmaker sigue usando /api/bot/whatsapp sin cambios.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import crypto from "crypto";

// Firma de Meta: "sha256=" + HMAC-SHA256(body crudo, App Secret). Comparación en tiempo constante.
function firmaValida(rawBody, header, secret) {
  if (!rawBody || !header || !secret) return false;
  const esperado = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(String(header)), b = Buffer.from(esperado);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function whatsappWebhookRouter() {
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

    // Log mínimo, SIN datos personales (ni teléfonos ni textos): solo qué tipo de eventos llegaron.
    try {
      const resumen = { mensajes: 0, estados: 0, tipos: {} };
      for (const entry of req.body?.entry || []) {
        for (const change of entry.changes || []) {
          const v = change.value || {};
          for (const m of v.messages || []) { resumen.mensajes++; resumen.tipos[m.type] = (resumen.tipos[m.type] || 0) + 1; }
          resumen.estados += (v.statuses || []).length;
        }
      }
      console.log("WhatsApp webhook:", JSON.stringify(resumen));
    } catch (e) { console.error("WhatsApp webhook: error leyendo el evento:", e.message); }

    return res.sendStatus(200);
  });

  return router;
}
