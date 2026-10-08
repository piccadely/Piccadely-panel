// ─────────────────────────────────────────────────────────────────────
//  whatsappAjustes.js  ·  Interruptores de WhatsApp guardados en la base (sin redeploy)
//    wa_activo  : apagado → el webhook guarda lo entrante pero NO responde ni dispara el bot,
//                 y la bandeja no envía nada (ni respuestas, ni plantillas, ni archivos).
//    bot_activo : apagado → todo lo entrante va directo a pendiente_agente, sin respuesta del bot.
//  Default SEGURO: si no hay fila en la base (DB nueva, p. ej. producción) o la base falla → apagado.
//  Cada cambio queda en wa_ajustes_historial y en el log, con quién lo hizo.
//  Cache corta en memoria (una sola réplica); un cambio desde el panel la invalida al instante.
// ─────────────────────────────────────────────────────────────────────
export const AJUSTES_WA = {
  wa_activo: "WhatsApp activo (responder y enviar)",
  bot_activo: "Bot activo (responde solo)",
};
const TTL_MS = 10000;
let cache = null, cacheAt = 0;

export async function leerAjustesWA(pool, { fresco = false } = {}) {
  if (!fresco && cache && Date.now() - cacheAt < TTL_MS) return cache;
  const out = { wa_activo: false, bot_activo: false };
  try {
    const { rows } = await pool.query("SELECT clave, valor FROM wa_ajustes WHERE clave = ANY($1)", [Object.keys(AJUSTES_WA)]);
    for (const r of rows) out[r.clave] = r.valor === true;
  } catch (e) {
    console.error("WhatsApp ajustes: no se pudieron leer (quedan APAGADOS):", e.message);
    return out;   // sin cachear: se reintenta en la próxima lectura
  }
  cache = out; cacheAt = Date.now();
  return out;
}

export async function cambiarAjusteWA(pool, clave, valor, usuario) {
  if (!(clave in AJUSTES_WA)) throw new Error("Ajuste inválido");
  const quien = usuario?.nombre_completo || usuario?.username || "desconocido";
  const prev = (await leerAjustesWA(pool, { fresco: true }))[clave];
  await pool.query(
    `INSERT INTO wa_ajustes (clave, valor, updated_at, updated_by_id, updated_by)
     VALUES ($1, $2, NOW(), $3, $4)
     ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW(), updated_by_id = EXCLUDED.updated_by_id, updated_by = EXCLUDED.updated_by`,
    [clave, !!valor, usuario?.id ?? null, quien]
  );
  await pool.query(
    "INSERT INTO wa_ajustes_historial (clave, valor_anterior, valor, usuario_id, usuario) VALUES ($1, $2, $3, $4, $5)",
    [clave, prev, !!valor, usuario?.id ?? null, quien]
  );
  cache = null;
  console.log(`WhatsApp ajustes: ${clave} ${prev ? "ON" : "OFF"} → ${valor ? "ON" : "OFF"} por ${quien} (usuario ${usuario?.id ?? "?"})`);
  return leerAjustesWA(pool, { fresco: true });
}

export async function historialAjustesWA(pool, limite = 20) {
  const { rows } = await pool.query(
    "SELECT clave, valor_anterior, valor, usuario, created_at FROM wa_ajustes_historial ORDER BY id DESC LIMIT $1", [limite]);
  return rows;
}
