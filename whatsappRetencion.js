// ─────────────────────────────────────────────────────────────────────
//  whatsappRetencion.js  ·  Job diario de retención de WhatsApp
//  WA_RETENCION_TEXTO_DIAS    (default 90; 0 = sin límite): borra mensajes más viejos que N días
//                              (y sus archivos en R2 y sus statuses) y las conversaciones que quedan vacías.
//  WA_RETENCION_ARCHIVOS_DIAS (default 90; 0 = sin límite): borra de R2 los archivos más viejos que N días;
//                              el mensaje queda, marcado como "archivo vencido".
//  ALCANCE: conversaciones cerradas y en estado bot (la mayoría de los clientes charlan con el bot y nunca
//  se cierran). Se saltean pendiente_agente y agente (hay alguien atendiendo). Se borra POR MENSAJE: en una
//  conversación activa con el bot solo se van los mensajes viejos; la conversación queda.
//  Solo las cerradas que quedan vacías se eliminan enteras.
//  Corre a los 10 min de arrancar y después cada 24 h. Trabaja en lotes para no cargar la base.
// ─────────────────────────────────────────────────────────────────────
import { r2Habilitado, archivos } from "./r2Storage.js";

const LOTE = 500;
const MAX_LOTES = 200;   // tope por corrida (100.000 filas); lo que quede sigue al día siguiente
const UN_DIA_MS = 24 * 60 * 60 * 1000;

// Días configurados: vacío / no definido → default; 0 → sin límite; inválido → default.
export function diasRetencion(valor, def = 90) {
  if (valor === undefined || valor === null || String(valor).trim() === "") return def;
  const n = Number(valor);
  return Number.isInteger(n) && n >= 0 ? n : def;
}

const ALCANCE = "c.estado IN ('cerrada', 'bot')";   // nunca pendiente_agente ni agente
const SOLO_CERRADAS = "c.estado = 'cerrada'";
const VIEJO = "m.created_at < NOW() - ($1::int * INTERVAL '1 day')";

// 1) Archivos vencidos: se borran de R2 y el mensaje queda como "vencido".
async function vencerArchivos(pool, dias) {
  let borrados = 0, errores = 0;
  for (let i = 0; i < MAX_LOTES; i++) {
    const { rows } = await pool.query(
      `SELECT m.id, m.media_key FROM wa_mensajes m JOIN wa_conversaciones c ON c.id = m.conversacion_id
       WHERE ${ALCANCE} AND m.media_key IS NOT NULL AND ${VIEJO} ORDER BY m.id LIMIT ${LOTE}`, [dias]);
    if (!rows.length) break;
    const ok = [];
    for (const r of rows) {
      try { await archivos.borrar(r.media_key); ok.push(r.id); }
      catch (e) { errores++; }
    }
    if (ok.length) await pool.query("UPDATE wa_mensajes SET media_key = NULL, media_estado = 'vencido' WHERE id = ANY($1)", [ok]);
    borrados += ok.length;
    if (ok.length === 0) break;   // R2 no responde: no insistir en esta corrida
  }
  return { borrados, errores };
}

// 2) Mensajes vencidos: primero su archivo en R2 (si tiene), después statuses y la fila.
async function borrarMensajes(pool, dias) {
  let mensajes = 0, errores = 0;
  for (let i = 0; i < MAX_LOTES; i++) {
    const { rows } = await pool.query(
      `SELECT m.id, m.wa_message_id, m.media_key FROM wa_mensajes m JOIN wa_conversaciones c ON c.id = m.conversacion_id
       WHERE ${ALCANCE} AND ${VIEJO} ORDER BY m.id LIMIT ${LOTE}`, [dias]);
    if (!rows.length) break;
    const ids = [], wamids = [];
    for (const r of rows) {
      if (r.media_key) {
        // Sin R2 no se puede borrar el archivo: el mensaje se conserva para no dejar archivos huérfanos.
        if (!r2Habilitado()) { errores++; continue; }
        try { await archivos.borrar(r.media_key); }
        catch (e) { errores++; continue; }
      }
      ids.push(r.id);
      if (r.wa_message_id) wamids.push(r.wa_message_id);
    }
    if (wamids.length) await pool.query("DELETE FROM wa_statuses WHERE wa_message_id = ANY($1)", [wamids]);
    if (ids.length) await pool.query("DELETE FROM wa_mensajes WHERE id = ANY($1)", [ids]);
    mensajes += ids.length;
    if (ids.length === 0) break;
  }
  // Solo las conversaciones CERRADAS que quedaron sin mensajes y sin actividad reciente se eliminan enteras.
  const conv = await pool.query(
    `DELETE FROM wa_conversaciones c WHERE ${SOLO_CERRADAS}
       AND COALESCE(c.ultimo_mensaje_at, c.created_at) < NOW() - ($1::int * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM wa_mensajes m WHERE m.conversacion_id = c.id)`, [dias]);
  // Statuses huérfanos viejos (de mensajes que ya no existen).
  const st = await pool.query(
    `DELETE FROM wa_statuses s WHERE s.created_at < NOW() - ($1::int * INTERVAL '1 day')
       AND NOT EXISTS (SELECT 1 FROM wa_mensajes m WHERE m.wa_message_id = s.wa_message_id)`, [dias]);
  return { mensajes, conversaciones: conv.rowCount, statuses: st.rowCount, errores };
}

let corriendo = false;
export async function correrRetencionWhatsApp(pool) {
  if (corriendo) return null;
  corriendo = true;
  const diasTexto = diasRetencion(process.env.WA_RETENCION_TEXTO_DIAS);
  const diasArchivos = diasRetencion(process.env.WA_RETENCION_ARCHIVOS_DIAS);
  const res = { diasTexto, diasArchivos };
  try {
    if (diasArchivos > 0) {
      if (r2Habilitado()) res.archivos = await vencerArchivos(pool, diasArchivos);
      else res.archivos = "salteado (R2 deshabilitado)";
    }
    if (diasTexto > 0) res.texto = await borrarMensajes(pool, diasTexto);
    console.log("WhatsApp retención:", JSON.stringify(res));
  } catch (e) {
    console.error("WhatsApp retención: error:", e.message);
  } finally { corriendo = false; }
  return res;
}

export function iniciarRetencionWhatsApp(pool) {
  setTimeout(() => correrRetencionWhatsApp(pool), 10 * 60 * 1000);
  setInterval(() => correrRetencionWhatsApp(pool), UN_DIA_MS);
  console.log(`WhatsApp retención: programada (texto ${diasRetencion(process.env.WA_RETENCION_TEXTO_DIAS) || "sin límite"} días, archivos ${diasRetencion(process.env.WA_RETENCION_ARCHIVOS_DIAS) || "sin límite"} días; conversaciones cerradas y con el bot, nunca las atendidas por un agente).`);
}
