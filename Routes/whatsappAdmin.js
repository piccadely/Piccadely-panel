// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappAdmin.js  ·  Configuración WhatsApp y corte de número (solo admin / superadmin)
//  Montar en server.js:  app.use("/api/whatsapp", whatsappAdminRouter(pool, { requireAuth }));
//    GET  /api/whatsapp/admin/estado      → datos del número, apps suscriptas a la WABA, interruptores,
//                                           variables presentes (sí/no, nunca valores) y URL del webhook.
//    POST /api/whatsapp/admin/ajustes     → { clave: wa_activo|bot_activo, valor: true|false }
//    POST /api/whatsapp/admin/suscribir   → suscribe nuestra app a la WABA con override_callback_uri =
//                                           webhook de ESTE ambiente (el número real va a producción y el
//                                           de prueba sigue en staging). Meta verifica la URL al momento.
//    POST /api/whatsapp/admin/desuscribir → quita la suscripción de nuestra app a la WABA (rollback).
//  URL del webhook de este ambiente: WA_WEBHOOK_URL, o si no está, https://{RAILWAY_PUBLIC_DOMAIN}/api/whatsapp/webhook.
//  /api/bot/whatsapp (Botmaker) no se toca.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import { graph, waConfig, errorMeta, detalleErrorMeta } from "./whatsappMeta.js";
import { leerAjustesWA, cambiarAjusteWA, historialAjustesWA, AJUSTES_WA } from "../whatsappAjustes.js";
import { estadoR2 } from "../r2Storage.js";

export function urlWebhookAmbiente() {
  const explicita = String(process.env.WA_WEBHOOK_URL || "").trim();
  if (explicita) return explicita;
  const dominio = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  return dominio ? `https://${dominio}/api/whatsapp/webhook` : null;
}

const CAMPOS_NUMERO = "display_phone_number,verified_name,quality_rating,status,platform_type,code_verification_status,name_status";
const VARIABLES = ["WA_TOKEN", "WA_PHONE_NUMBER_ID", "WA_WABA_ID", "WA_APP_SECRET", "WA_VERIFY_TOKEN", "WA_GRAPH_VERSION", "WA_WEBHOOK_URL",
  "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "WA_RETENCION_TEXTO_DIAS", "WA_RETENCION_ARCHIVOS_DIAS"];
const quien = (u) => `${u?.nombre_completo || u?.username || "desconocido"} (usuario ${u?.id ?? "?"})`;

export function whatsappAdminRouter(pool, { requireAuth }) {
  const router = express.Router();
  const soloAdmin = (req, res, next) =>
    req.user && !req.user.modoLectura && ["admin", "superadmin"].includes(req.user.rol)
      ? next()
      : res.status(403).json({ error: "Solo admin o superadmin." });
  const adm = [requireAuth, soloAdmin];

  // Llamada a Meta que no corta el estado si falla: devuelve { data } o { error }.
  async function intentar(nombre, fn) {
    try { return { data: await fn() }; }
    catch (e) {
      console.error(`WhatsApp admin: ${nombre} falló:`, JSON.stringify(detalleErrorMeta(e)));
      return { error: errorMeta(e) };
    }
  }

  router.get("/admin/estado", adm, async (req, res) => {
    try {
      const { token, phoneId, wabaId, version } = waConfig();
      const [ajustes, historial] = await Promise.all([leerAjustesWA(pool, { fresco: true }), historialAjustesWA(pool, 15)]);
      const out = {
        ambiente: {
          phone_number_id: phoneId || null,
          waba_id: wabaId || null,
          graph_version: version,
          webhook_url: urlWebhookAmbiente(),
          variables: Object.fromEntries(VARIABLES.map(v => [v, !!String(process.env[v] || "").trim()])),   // solo sí/no
          r2: estadoR2(),
        },
        ajustes, historial, etiquetas: AJUSTES_WA,
      };
      if (token && phoneId) {
        const r = await intentar("GET número", async () => (await graph("get", phoneId, { params: { fields: CAMPOS_NUMERO } })).data);
        out.numero = r.data || null; out.numero_error = r.error || null;
      } else out.numero_error = "Faltan WA_TOKEN o WA_PHONE_NUMBER_ID.";
      if (token) {
        const r = await intentar("GET app del token", async () => (await graph("get", "app", { params: { fields: "id,name" } })).data);
        out.app = r.data || null;   // para marcar cuál de las apps suscriptas es la nuestra
      }
      if (token && wabaId) {
        const r = await intentar("GET subscribed_apps", async () => (await graph("get", `${wabaId}/subscribed_apps`)).data?.data || []);
        out.apps = r.data ? r.data.map(a => {
          const d = a.whatsapp_business_api_data || {};
          return { id: d.id || null, nombre: d.name || null, link: d.link || null, override_callback_uri: a.override_callback_uri || null, es_nuestra: !!(out.app?.id && d.id === out.app.id) };
        }) : null;
        out.apps_error = r.error || null;
      } else out.apps_error = "Faltan WA_TOKEN o WA_WABA_ID.";
      res.json(out);
    } catch (e) {
      console.error("WhatsApp admin: error armando el estado:", e.message);
      res.status(500).json({ error: "No se pudo armar el estado." });
    }
  });

  router.post("/admin/ajustes", adm, async (req, res) => {
    const { clave, valor } = req.body || {};
    if (!(clave in AJUSTES_WA) || typeof valor !== "boolean") return res.status(400).json({ error: "Ajuste inválido." });
    try {
      const ajustes = await cambiarAjusteWA(pool, clave, valor, req.user);
      res.json({ ok: true, ajustes, historial: await historialAjustesWA(pool, 15) });
    } catch (e) {
      console.error("WhatsApp admin: no se pudo cambiar el ajuste:", e.message);
      res.status(500).json({ error: "No se pudo guardar el ajuste." });
    }
  });

  router.post("/admin/suscribir", adm, async (req, res) => {
    const { wabaId, token } = waConfig();
    const url = urlWebhookAmbiente(), verify = process.env.WA_VERIFY_TOKEN;
    if (!token || !wabaId) return res.status(503).json({ error: "Faltan WA_TOKEN o WA_WABA_ID en este ambiente." });
    if (!url) return res.status(503).json({ error: "No se conoce la URL pública de este ambiente: cargá WA_WEBHOOK_URL." });
    if (!verify) return res.status(503).json({ error: "Falta WA_VERIFY_TOKEN en este ambiente." });
    if (!process.env.WA_APP_SECRET) return res.status(503).json({ error: "Falta WA_APP_SECRET: el webhook rechazaría todos los eventos." });
    try {
      // Meta llama en el momento a GET {url}?hub.verify_token=… : este mismo servidor lo contesta.
      const r = await graph("post", `${wabaId}/subscribed_apps`, { data: { override_callback_uri: url, verify_token: verify } });
      console.log(`WhatsApp admin: app suscripta a la WABA …${String(wabaId).slice(-4)} con callback ${url} por ${quien(req.user)}.`);
      res.json({ ok: true, respuesta: r.data, webhook_url: url });
    } catch (e) {
      console.error(`WhatsApp admin: suscribir falló (pedido por ${quien(req.user)}):`, JSON.stringify(detalleErrorMeta(e)));
      res.status(502).json({ error: `Meta no aceptó la suscripción: ${errorMeta(e)}` });
    }
  });

  router.post("/admin/desuscribir", adm, async (req, res) => {
    const { wabaId, token } = waConfig();
    if (!token || !wabaId) return res.status(503).json({ error: "Faltan WA_TOKEN o WA_WABA_ID en este ambiente." });
    try {
      const r = await graph("delete", `${wabaId}/subscribed_apps`);
      console.log(`WhatsApp admin: app DESUSCRIPTA de la WABA …${String(wabaId).slice(-4)} por ${quien(req.user)}.`);
      res.json({ ok: true, respuesta: r.data });
    } catch (e) {
      console.error(`WhatsApp admin: desuscribir falló (pedido por ${quien(req.user)}):`, JSON.stringify(detalleErrorMeta(e)));
      res.status(502).json({ error: `Meta no aceptó la desuscripción: ${errorMeta(e)}` });
    }
  });

  return router;
}
