// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappBandeja.js  ·  Bandeja multiagente de WhatsApp (API del panel)
//  Montar en server.js (después de setupAuth):
//     import { whatsappBandejaRouter } from "./Routes/whatsappBandeja.js";
//     app.use("/api/whatsapp", whatsappBandejaRouter(pool, { requireAuth, requireRole }));
//
//  Permisos: ver = admin / superadmin / encargado / solo_lectura · operar = admin / superadmin / encargado.
//  Una conversación en estado 'agente' es de UNA persona (agente_id): solo esa persona responde.
//  Liberar / devolver al bot / cerrar: la dueña, cualquiera si no tiene dueña, o un admin/superadmin.
//  Estados: bot → (handoff) pendiente_agente → (tomar) agente → liberar / devolver-bot / cerrar.
//  Regla del webhook: si el estado NO es 'bot', los entrantes se guardan pero el bot no contesta.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import { enviarTexto, sincronizarEstado } from "./whatsappWebhook.js";

const ESTADOS = ["bot", "pendiente_agente", "agente", "cerrada"];
const MAX_TEXTO = 4096;   // límite de la Cloud API para un mensaje de texto

// Conversación + agente + último mensaje + flags calculados para el usuario que consulta ($1).
const SELECT_CONV = `
  SELECT c.id, c.wa_id, c.nombre, c.estado, c.agente_id, u.nombre_completo AS agente_nombre,
         c.asignada_at, c.handoff_at, c.ultimo_mensaje_at, c.ultimo_entrante_at, c.no_leidos,
         (c.ultimo_entrante_at IS NOT NULL AND c.ultimo_entrante_at > NOW() - INTERVAL '24 hours') AS ventana_abierta,
         (c.agente_id IS NOT NULL AND c.agente_id = $1) AS es_mia,
         lm.texto AS ultimo_texto, lm.tipo AS ultimo_tipo, lm.direccion AS ultimo_direccion,
         lm.autor AS ultimo_autor, lm.created_at AS ultimo_at
  FROM wa_conversaciones c
  LEFT JOIN usuarios u ON u.id = c.agente_id
  LEFT JOIN LATERAL (
    SELECT texto, tipo, direccion, autor, created_at FROM wa_mensajes
    WHERE conversacion_id = c.id ORDER BY id DESC LIMIT 1
  ) lm ON true`;

const COLS_MENSAJE = "id, direccion, autor, tipo, texto, estado, error, usuario_id, usuario_nombre, wa_timestamp, created_at";

export function whatsappBandejaRouter(pool, { requireAuth, requireRole }) {
  const router = express.Router();
  const ver = [requireAuth, requireRole("admin", "superadmin", "encargado", "solo_lectura")];
  const operar = [requireAuth, requireRole("admin", "superadmin", "encargado")];
  const esAdmin = (u) => u?.rol === "admin" || u?.rol === "superadmin";
  const puedeOperar = (u) => ["admin", "superadmin", "encargado"].includes(u?.rol);
  const idValido = (v) => Number.isInteger(Number(v)) && Number(v) > 0;

  // Agrega puede_gestionar (liberar / devolver / cerrar) según quién consulta.
  const conFlags = (c, user) => ({
    ...c,
    puede_gestionar: puedeOperar(user) && (c.agente_id == null || c.agente_id === user.id || esAdmin(user)),
  });

  // ── GET /conversaciones?estado=&mias=1&abiertas=1&q= ──
  // Ordenadas por último mensaje. Devuelve también contadores por pestaña y una "firma" de pendientes
  // (cantidad + último entrante) para que el front detecte que entró algo nuevo y avise.
  router.get("/conversaciones", ver, async (req, res) => {
    const { estado, mias, abiertas, q } = req.query;
    const uid = req.user.id;
    const params = [uid];
    const where = [];
    if (estado) {
      if (!ESTADOS.includes(estado)) return res.status(400).json({ error: "Estado inválido." });
      params.push(estado); where.push(`c.estado = $${params.length}`);
    }
    if (mias === "1") where.push("c.agente_id = $1 AND c.estado = 'agente'");
    if (abiertas === "1") where.push("c.estado <> 'cerrada'");
    if (q && String(q).trim()) {
      params.push(`%${String(q).trim().toLowerCase()}%`);
      params.push(`%${String(q).replace(/[^0-9]/g, "") || "-"}%`);
      where.push(`(lower(coalesce(c.nombre, '')) LIKE $${params.length - 1} OR c.wa_id LIKE $${params.length})`);
    }
    try {
      const { rows } = await pool.query(
        `${SELECT_CONV} ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY c.ultimo_mensaje_at DESC NULLS LAST, c.id DESC LIMIT 200`,
        params
      );
      const cont = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE estado = 'pendiente_agente') AS pendientes,
           COUNT(*) FILTER (WHERE estado = 'agente' AND agente_id = $1) AS mias,
           COUNT(*) FILTER (WHERE estado = 'bot') AS bot,
           COUNT(*) FILTER (WHERE estado <> 'cerrada') AS todas,
           COUNT(*) FILTER (WHERE estado = 'cerrada') AS cerradas,
           COALESCE(SUM(no_leidos) FILTER (WHERE estado = 'agente' AND agente_id = $1), 0) AS no_leidos_mias,
           MAX(ultimo_entrante_at) FILTER (WHERE estado = 'pendiente_agente') AS pendientes_ultimo_entrante
         FROM wa_conversaciones`,
        [uid]
      );
      const k = cont.rows[0];
      res.json({
        conversaciones: rows.map(c => conFlags(c, req.user)),
        contadores: {
          pendientes: Number(k.pendientes), mias: Number(k.mias), bot: Number(k.bot),
          todas: Number(k.todas), cerradas: Number(k.cerradas), no_leidos_mias: Number(k.no_leidos_mias),
        },
        pendientes_firma: { cantidad: Number(k.pendientes), ultimo_entrante: k.pendientes_ultimo_entrante },
        puede_operar: puedeOperar(req.user),
      });
    } catch (err) {
      console.error("WhatsApp bandeja: error listando:", err.message);
      res.status(500).json({ error: "Error cargando conversaciones" });
    }
  });

  // ── GET /conversaciones/:id/mensajes?antes=<id>&despues=<id>&limit=50 ──
  // Sin params: los últimos `limit`. antes=<id>: página anterior (scroll hacia arriba).
  // despues=<id>: solo lo nuevo (polling). Al abrirla, marca como leídos (si quien mira puede operar).
  router.get("/conversaciones/:id/mensajes", ver, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: "Conversación inválida." });
    const id = Number(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    try {
      const conv = await pool.query(`${SELECT_CONV} WHERE c.id = $2`, [req.user.id, id]);
      if (conv.rows.length === 0) return res.status(404).json({ error: "Conversación no encontrada." });
      let mensajes, hayMas = false;
      if (idValido(req.query.despues)) {
        const r = await pool.query(
          `SELECT ${COLS_MENSAJE} FROM wa_mensajes WHERE conversacion_id = $1 AND id > $2 ORDER BY id ASC LIMIT 200`,
          [id, Number(req.query.despues)]
        );
        mensajes = r.rows;
      } else {
        const params = [id, limit + 1];
        let extra = "";
        if (idValido(req.query.antes)) { params.push(Number(req.query.antes)); extra = " AND id < $3"; }
        const r = await pool.query(
          `SELECT ${COLS_MENSAJE} FROM wa_mensajes WHERE conversacion_id = $1${extra} ORDER BY id DESC LIMIT $2`,
          params
        );
        hayMas = r.rows.length > limit;
        mensajes = r.rows.slice(0, limit).reverse();
      }
      if (puedeOperar(req.user) && conv.rows[0].no_leidos > 0) {
        await pool.query("UPDATE wa_conversaciones SET no_leidos = 0 WHERE id = $1", [id]);
        conv.rows[0].no_leidos = 0;
      }
      // Estados de los salientes recientes (los ticks cambian aunque no haya mensajes nuevos).
      const st = await pool.query(
        `SELECT id, estado, error FROM wa_mensajes WHERE conversacion_id = $1 AND direccion = 'out' ORDER BY id DESC LIMIT 30`,
        [id]
      );
      res.json({ conversacion: conFlags(conv.rows[0], req.user), mensajes, hay_mas: hayMas, estados_salientes: st.rows });
    } catch (err) {
      console.error("WhatsApp bandeja: error leyendo mensajes:", err.message);
      res.status(500).json({ error: "Error cargando mensajes" });
    }
  });

  // ── POST /conversaciones/:id/tomar ── atómico: un único UPDATE condicionado. Si dos agentes
  // tocan "Tomar" a la vez, Postgres re-evalúa el WHERE para el segundo y no lo encuentra → 409.
  router.post("/conversaciones/:id/tomar", operar, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: "Conversación inválida." });
    const id = Number(req.params.id);
    try {
      const r = await pool.query(
        `UPDATE wa_conversaciones SET estado = 'agente', agente_id = $2, asignada_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND (agente_id IS NULL OR agente_id = $2) RETURNING id`,
        [id, req.user.id]
      );
      if (r.rows.length === 0) {
        const c = await pool.query("SELECT u.nombre_completo FROM wa_conversaciones c LEFT JOIN usuarios u ON u.id = c.agente_id WHERE c.id = $1", [id]);
        if (c.rows.length === 0) return res.status(404).json({ error: "Conversación no encontrada." });
        return res.status(409).json({ error: `Ya la tomó ${c.rows[0].nombre_completo || "otro agente"}.` });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("WhatsApp bandeja: error tomando:", err.message);
      res.status(500).json({ error: "Error tomando la conversación" });
    }
  });

  // ── POST /conversaciones/:id/responder { texto } ── solo la dueña; dentro de la ventana de 24 h.
  router.post("/conversaciones/:id/responder", operar, async (req, res) => {
    if (!idValido(req.params.id)) return res.status(400).json({ error: "Conversación inválida." });
    const id = Number(req.params.id);
    const texto = String(req.body?.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "El mensaje está vacío." });
    if (texto.length > MAX_TEXTO) return res.status(400).json({ error: `El mensaje supera los ${MAX_TEXTO} caracteres.` });
    try {
      const c = await pool.query(
        `SELECT c.estado, c.agente_id, c.telefono_envio, u.nombre_completo AS agente_nombre,
                (c.ultimo_entrante_at IS NOT NULL AND c.ultimo_entrante_at > NOW() - INTERVAL '24 hours') AS ventana_abierta
         FROM wa_conversaciones c LEFT JOIN usuarios u ON u.id = c.agente_id WHERE c.id = $1`,
        [id]
      );
      const conv = c.rows[0];
      if (!conv) return res.status(404).json({ error: "Conversación no encontrada." });
      if (conv.estado !== "agente" || conv.agente_id !== req.user.id) {
        const quien = conv.estado === "agente" && conv.agente_nombre ? ` La tiene ${conv.agente_nombre}.` : "";
        return res.status(409).json({ error: `Para responder tenés que tomar la conversación.${quien}`, code: "no_es_tuya" });
      }
      if (!conv.ventana_abierta) {
        return res.status(422).json({ error: "Pasaron más de 24 h desde el último mensaje del cliente: requiere plantilla.", code: "requiere_plantilla" });
      }
      const envio = await enviarTexto(conv.telefono_envio, texto);
      const ins = await pool.query(
        `INSERT INTO wa_mensajes (conversacion_id, wa_message_id, direccion, autor, tipo, texto, estado, error, usuario_id, usuario_nombre)
         VALUES ($1, $2, 'out', 'agente', 'text', $3, $4, $5, $6, $7)
         RETURNING ${COLS_MENSAJE}`,
        [id, envio.id || null, texto, envio.error ? "failed" : "accepted", envio.error || null, req.user.id, req.user.nombre_completo || req.user.username || null]
      );
      await pool.query("UPDATE wa_conversaciones SET ultimo_mensaje_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
      if (envio.error) {
        console.error("WhatsApp bandeja: falló el envío del agente (conversación", id + "):", envio.error);
        return res.status(502).json({ error: `WhatsApp no aceptó el mensaje: ${envio.error}`, mensaje: ins.rows[0] });
      }
      await sincronizarEstado(pool, envio.id);
      res.json({ ok: true, mensaje: ins.rows[0] });
    } catch (err) {
      console.error("WhatsApp bandeja: error respondiendo:", err.message);
      res.status(500).json({ error: "Error enviando el mensaje" });
    }
  });

  // ── Liberar / devolver al bot / cerrar ── mismo patrón: UPDATE condicionado por permiso.
  function cambioDeEstado(nuevoEstado, mensajeOk) {
    return async (req, res) => {
      if (!idValido(req.params.id)) return res.status(400).json({ error: "Conversación inválida." });
      const id = Number(req.params.id);
      try {
        const r = await pool.query(
          `UPDATE wa_conversaciones SET estado = $2, agente_id = NULL, asignada_at = NULL, updated_at = NOW()
           WHERE id = $1 AND (agente_id IS NULL OR agente_id = $3 OR $4::boolean) RETURNING id`,
          [id, nuevoEstado, req.user.id, esAdmin(req.user)]
        );
        if (r.rows.length === 0) {
          const c = await pool.query("SELECT u.nombre_completo FROM wa_conversaciones c LEFT JOIN usuarios u ON u.id = c.agente_id WHERE c.id = $1", [id]);
          if (c.rows.length === 0) return res.status(404).json({ error: "Conversación no encontrada." });
          return res.status(409).json({ error: `La tiene ${c.rows[0].nombre_completo || "otro agente"}: solo esa persona o un admin puede hacerlo.` });
        }
        res.json({ ok: true, mensaje: mensajeOk });
      } catch (err) {
        console.error(`WhatsApp bandeja: error pasando a ${nuevoEstado}:`, err.message);
        res.status(500).json({ error: "Error actualizando la conversación" });
      }
    };
  }
  router.post("/conversaciones/:id/liberar", operar, cambioDeEstado("pendiente_agente", "Conversación liberada: vuelve a Pendientes."));
  router.post("/conversaciones/:id/devolver-bot", operar, cambioDeEstado("bot", "El bot vuelve a responder esta conversación."));
  router.post("/conversaciones/:id/cerrar", operar, cambioDeEstado("cerrada", "Conversación cerrada."));

  return router;
}
