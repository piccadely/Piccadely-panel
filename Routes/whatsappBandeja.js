// ─────────────────────────────────────────────────────────────────────
//  Routes/whatsappBandeja.js  ·  Bandeja multiagente de WhatsApp (API del panel)
//  Montar en server.js (después de setupAuth):
//     import { whatsappBandejaRouter } from "./Routes/whatsappBandeja.js";
//     app.use("/api/whatsapp", whatsappBandejaRouter(pool, { requireAuth }));
//
//  Permisos: CUALQUIER usuario logueado del panel ve y opera (sin lista de roles: alcanza con requireAuth;
//  un rol nuevo entra solo). Excepción: la sesión de emergencia (modoLectura) no opera; además el gate
//  global de auth.js ya la limita a los GET del panel de pedidos.
//  Una conversación en estado 'agente' es de UNA persona (agente_id): solo esa persona responde.
//  Liberar / devolver al bot / cerrar: la dueña, cualquiera si no tiene dueña, o un admin/superadmin.
//  Estados: bot → (handoff) pendiente_agente → (tomar) agente → liberar / devolver-bot / cerrar.
//  Regla del webhook: si el estado NO es 'bot', los entrantes se guardan pero el bot no contesta.
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import { enviarTexto, sincronizarEstado, numeroParaEnviar, normalizarWaId } from "./whatsappWebhook.js";
import {
  waConfig, errorMeta, detalleErrorMeta, enviarMensajeMeta, subirMediaMeta, claveArchivo, MAX_ARCHIVO_SALIENTE, MIMES_SALIENTES,
  armarNuevaPlantilla, crearPlantillaMeta, listarPlantillasMeta, soportadaParaEnvio, renderPlantilla,
  componentesEnvio, validarVariables, variablesDe, partesPlantilla,
} from "./whatsappMeta.js";
import { r2Habilitado, estadoR2, archivos } from "../r2Storage.js";
import { leerAjustesWA } from "../whatsappAjustes.js";

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

const COLS_MENSAJE = `id, direccion, autor, tipo, texto, estado, error, usuario_id, usuario_nombre, wa_timestamp, created_at,
  media_mime, media_nombre, media_bytes, media_estado, caption, plantilla_nombre, (media_key IS NOT NULL) AS tiene_archivo`;

export function whatsappBandejaRouter(pool, { requireAuth }) {
  const router = express.Router();
  // Logueado = puede ver y operar. La sesión de emergencia (modoLectura) queda afuera de las escrituras.
  const soloSesionNormal = (req, res, next) => req.user?.modoLectura
    ? res.status(403).json({ error: "Modo solo lectura: acción no permitida." })
    : next();
  const ver = [requireAuth];
  const operar = [requireAuth, soloSesionNormal];
  const esAdmin = (u) => u?.rol === "admin" || u?.rol === "superadmin";
  const puedeOperar = (u) => !!u && !u.modoLectura;
  const idValido = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
  // Con wa_activo apagado (Configuración WhatsApp) la bandeja no envía nada: ni respuestas, ni plantillas, ni archivos.
  const waEncendido = async (req, res, next) => {
    if ((await leerAjustesWA(pool)).wa_activo) return next();
    res.status(423).json({ error: "WhatsApp está apagado en este ambiente (Configuración WhatsApp): no se envían mensajes.", code: "wa_apagado" });
  };

  // Agrega puede_gestionar (liberar / devolver / cerrar) según quién consulta.
  const conFlags = (c, user) => ({
    ...c,
    puede_gestionar: puedeOperar(user) && (c.agente_id == null || c.agente_id === user.id || esAdmin(user)),
  });

  // ── GET /contadores ── para el widget del header (polling cada 5 s desde todas las pantallas).
  // UNA sola consulta que devuelve solo números (no viaja ningún mensaje):
  //   activas       = todo lo que no está cerrada.
  //   por_responder = pendiente_agente / agente cuyo último mensaje es del cliente (o una respuesta que
  //                   falló y no le llegó): nadie le contestó. Las del bot NO cuentan (el bot las atiende).
  //   mias_nuevos   = tomadas por quien consulta con mensajes sin leer.
  // El LATERAL lee 1 fila por conversación abierta usando el índice (conversacion_id, id).
  router.get("/contadores", ver, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT
           COUNT(*) AS activas,
           COUNT(*) FILTER (WHERE c.estado IN ('pendiente_agente', 'agente')
                              AND (u.direccion = 'in' OR u.estado = 'failed')) AS por_responder,
           COUNT(*) FILTER (WHERE c.estado = 'agente' AND c.agente_id = $1 AND c.no_leidos > 0) AS mias_nuevos
         FROM wa_conversaciones c
         LEFT JOIN LATERAL (
           SELECT direccion, estado FROM wa_mensajes
           WHERE conversacion_id = c.id AND tipo <> 'reaction'
           ORDER BY id DESC LIMIT 1
         ) u ON true
         WHERE c.estado <> 'cerrada'`,
        [req.user.id]
      );
      const k = rows[0];
      res.json({ activas: Number(k.activas), por_responder: Number(k.por_responder), mias_nuevos: Number(k.mias_nuevos) });
    } catch (err) {
      console.error("WhatsApp bandeja: error en contadores:", err.message);
      res.status(500).json({ error: "Error cargando contadores" });
    }
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
        archivos_habilitados: r2Habilitado(),
        ajustes: await leerAjustesWA(pool),   // wa_activo / bot_activo, para el aviso en pantalla
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
      // Estados de los mensajes recientes: ticks de los salientes y estado de los archivos (un archivo
      // entrante pasa de 'pendiente' a 'ok' sin que llegue ningún mensaje nuevo).
      const st = await pool.query(
        `SELECT id, estado, error, media_estado, (media_key IS NOT NULL) AS tiene_archivo
         FROM wa_mensajes WHERE conversacion_id = $1 ORDER BY id DESC LIMIT 40`,
        [id]
      );
      res.json({ conversacion: conFlags(conv.rows[0], req.user), mensajes, hay_mas: hayMas, estados_salientes: st.rows, archivos_habilitados: r2Habilitado() });
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
  router.post("/conversaciones/:id/responder", operar, waEncendido, async (req, res) => {
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

  // ════════════════ Fase 3: plantillas y archivos ════════════════
  // Errores esperables se tiran como { _http, msg, code } y este wrapper los responde.
  const manejar = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (e) {
      if (e && e._http) return res.status(e._http).json({ error: e.msg, ...(e.code ? { code: e.code } : {}), ...(e.extra || {}) });
      console.error("WhatsApp bandeja:", e?.message || e);
      res.status(500).json({ error: "Error procesando el pedido" });
    }
  };
  const VENTANA_SQL = "(c.ultimo_entrante_at IS NOT NULL AND c.ultimo_entrante_at > NOW() - INTERVAL '24 hours')";

  // La conversación tiene que estar tomada por quien escribe (misma regla que "responder").
  async function convDelAgente(id, user) {
    const c = await pool.query(
      `SELECT c.id, c.estado, c.agente_id, c.telefono_envio, u.nombre_completo AS agente_nombre, ${VENTANA_SQL} AS ventana_abierta
       FROM wa_conversaciones c LEFT JOIN usuarios u ON u.id = c.agente_id WHERE c.id = $1`, [id]);
    const conv = c.rows[0];
    if (!conv) throw { _http: 404, msg: "Conversación no encontrada." };
    if (conv.estado !== "agente" || conv.agente_id !== user.id) {
      const quien = conv.estado === "agente" && conv.agente_nombre ? ` La tiene ${conv.agente_nombre}.` : "";
      throw { _http: 409, msg: `Para escribir tenés que tomar la conversación.${quien}`, code: "no_es_tuya" };
    }
    return conv;
  }

  // Plantilla lista para mandar: aprobada y con un formato que el panel sabe completar.
  async function plantillaAprobada(id) {
    if (!idValido(id)) throw { _http: 400, msg: "Elegí una plantilla." };
    const r = await pool.query("SELECT * FROM wa_plantillas WHERE id = $1", [Number(id)]);
    const p = r.rows[0];
    if (!p) throw { _http: 404, msg: "Plantilla no encontrada." };
    if (p.estado !== "APPROVED") throw { _http: 409, msg: `La plantilla "${p.nombre}" no está aprobada (${p.estado || "sin estado"}).` };
    if (!soportadaParaEnvio(p.componentes)) throw { _http: 409, msg: `"${p.nombre}" tiene encabezado multimedia o botones con variables: todavía no se puede enviar desde el panel.` };
    return p;
  }

  // Manda la plantilla y la guarda como saliente con el texto ya armado (para verla en el chat).
  async function enviarYGuardarPlantilla(conversacionId, telefono, p, variables, variablesHeader, user) {
    const err = validarVariables(p.componentes, variables, variablesHeader);
    if (err) throw { _http: 400, msg: err };
    const comps = componentesEnvio(p.componentes, variables, variablesHeader);
    const envio = await enviarMensajeMeta(numeroParaEnviar(telefono), {
      type: "template",
      template: { name: p.nombre, language: { code: p.idioma }, ...(comps.length ? { components: comps } : {}) },
    });
    const ins = await pool.query(
      `INSERT INTO wa_mensajes (conversacion_id, wa_message_id, direccion, autor, tipo, texto, estado, error, usuario_id, usuario_nombre, plantilla_nombre)
       VALUES ($1, $2, 'out', 'agente', 'template', $3, $4, $5, $6, $7, $8)
       RETURNING ${COLS_MENSAJE}`,
      [conversacionId, envio.id || null, renderPlantilla(p.componentes, variables, variablesHeader), envio.error ? "failed" : "accepted",
       envio.error || null, user.id, user.nombre_completo || user.username || null, p.nombre]
    );
    await pool.query("UPDATE wa_conversaciones SET ultimo_mensaje_at = NOW(), updated_at = NOW() WHERE id = $1", [conversacionId]);
    if (!envio.error) await sincronizarEstado(pool, envio.id);
    return { envio, mensaje: ins.rows[0] };
  }

  // Número escrito a mano → formato canónico 549XXXXXXXXXX (acepta 11 6239-3600, +54 9 11…, 011…).
  function normalizarNumeroIngresado(raw) {
    let d = String(raw || "").replace(/[^0-9]/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = d.slice(1);
    if (d.length === 10) d = "549" + d;          // número argentino sin código de país
    d = normalizarWaId(d);                       // 54XXXXXXXXXX → 549XXXXXXXXXX
    return d.length >= 8 && d.length <= 15 ? d : null;
  }

  // ── GET /plantillas?estado= ── las de la cuenta (copia local, se refresca con "Sincronizar" y el webhook).
  router.get("/plantillas", ver, manejar(async (req, res) => {
    const params = [];
    let sql = "SELECT * FROM wa_plantillas";
    if (req.query.estado) { params.push(String(req.query.estado).toUpperCase()); sql += " WHERE estado = $1"; }
    const { rows } = await pool.query(sql + " ORDER BY nombre, idioma", params);
    res.json({
      plantillas: rows.map(p => {
        const { header, body } = partesPlantilla(p.componentes);
        return { ...p, soportada: soportadaParaEnvio(p.componentes), variables_cuerpo: variablesDe(body?.text).length, variables_header: variablesDe(header?.text).length };
      }),
      puede_crear: esAdmin(req.user),
      waba_configurado: !!waConfig().wabaId,
    });
  }));

  // Códigos de Meta para el mensaje en pantalla (sirven para buscar el caso en el log o reportarlo a Meta).
  const trazaMeta = (e) => { const d = detalleErrorMeta(e); const p = [d.error_subcode && `subcode ${d.error_subcode}`, d.fbtrace_id && `fbtrace_id ${d.fbtrace_id}`].filter(Boolean); return p.length ? ` (${p.join(", ")})` : ""; };

  // ── POST /plantillas/sincronizar ── trae todas las de Meta y actualiza la copia local.
  router.post("/plantillas/sincronizar", operar, manejar(async (req, res) => {
    if (!waConfig().wabaId) throw { _http: 503, msg: "Falta configurar WA_WABA_ID en el servidor." };
    let lista;
    try { lista = await listarPlantillasMeta(); }
    catch (e) {
      console.error("WhatsApp plantillas: Meta rechazó la sincronización:", JSON.stringify(detalleErrorMeta(e)));
      throw { _http: 502, msg: `No se pudieron traer las plantillas de Meta: ${errorMeta(e)}${trazaMeta(e)}` };
    }
    for (const t of lista) {
      await pool.query(
        `INSERT INTO wa_plantillas (meta_id, nombre, idioma, categoria, estado, motivo, componentes, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (meta_id) DO UPDATE SET nombre = EXCLUDED.nombre, idioma = EXCLUDED.idioma, categoria = EXCLUDED.categoria,
           estado = EXCLUDED.estado, motivo = EXCLUDED.motivo, componentes = EXCLUDED.componentes, updated_at = NOW()`,
        [String(t.id), t.name, t.language, t.category || null, t.status || null,
         t.rejected_reason && t.rejected_reason !== "NONE" ? String(t.rejected_reason) : null, JSON.stringify(t.components || [])]
      );
    }
    const borradas = await pool.query("DELETE FROM wa_plantillas WHERE meta_id IS NOT NULL AND NOT (meta_id = ANY($1)) RETURNING id", [lista.map(t => String(t.id))]);
    res.json({ ok: true, total: lista.length, borradas: borradas.rowCount });
  }));

  // ── POST /plantillas ── crea en Meta (queda PENDING hasta que la revisen). Solo admin / superadmin.
  router.post("/plantillas", operar, manejar(async (req, res) => {
    if (!esAdmin(req.user)) throw { _http: 403, msg: "Solo admin o superadmin pueden crear plantillas." };
    if (!waConfig().wabaId) throw { _http: 503, msg: "Falta configurar WA_WABA_ID en el servidor." };
    const { error, def } = armarNuevaPlantilla(req.body || {});
    if (error) throw { _http: 400, msg: error };
    let r;
    try { r = await crearPlantillaMeta(def); }
    catch (e) {
      // Respuesta completa de Meta al log (sin token: solo el body del error) para diagnosticar.
      console.error("WhatsApp plantillas: Meta rechazó crear", JSON.stringify({ plantilla: def.name, categoria: def.category, idioma: def.language, ...detalleErrorMeta(e) }));
      throw { _http: 400, msg: `Meta rechazó la plantilla: ${errorMeta(e)}${trazaMeta(e)}. Mientras tanto podés crearla desde WhatsApp Manager (business.facebook.com > WhatsApp Manager > Plantillas de mensajes) y después tocar «Sincronizar» acá para traerla.` };
    }
    const ins = await pool.query(
      `INSERT INTO wa_plantillas (meta_id, nombre, idioma, categoria, estado, componentes, creada_por, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (meta_id) DO UPDATE SET estado = EXCLUDED.estado, componentes = EXCLUDED.componentes, updated_at = NOW()
       RETURNING *`,
      [String(r.id), def.name, def.language, r.category || def.category, r.status || "PENDING", JSON.stringify(def.components), req.user.nombre_completo || req.user.username || null]
    );
    res.json({ ok: true, plantilla: ins.rows[0] });
  }));

  // ── POST /conversaciones/:id/plantilla { plantilla_id, variables, variables_header } ──
  // Se puede mandar aunque hayan pasado las 24 h (para eso existen las plantillas). La ventana se vuelve a
  // abrir recién cuando el cliente responda.
  router.post("/conversaciones/:id/plantilla", operar, waEncendido, manejar(async (req, res) => {
    if (!idValido(req.params.id)) throw { _http: 400, msg: "Conversación inválida." };
    const id = Number(req.params.id);
    const conv = await convDelAgente(id, req.user);
    const p = await plantillaAprobada(req.body?.plantilla_id);
    const { envio, mensaje } = await enviarYGuardarPlantilla(id, conv.telefono_envio, p, req.body?.variables || [], req.body?.variables_header || [], req.user);
    if (envio.error) throw { _http: 502, msg: `WhatsApp no aceptó la plantilla: ${envio.error}`, extra: { mensaje } };
    res.json({ ok: true, mensaje });
  }));

  // ── POST /conversaciones/nueva { numero, plantilla_id, variables, variables_header } ──
  // Crea (o reusa) la conversación tomada por quien la inicia y le manda la plantilla. Atómico: si el número
  // ya tiene una conversación tomada por otra persona, 409.
  router.post("/conversaciones/nueva", operar, waEncendido, manejar(async (req, res) => {
    const waId = normalizarNumeroIngresado(req.body?.numero);
    if (!waId) throw { _http: 400, msg: "Número inválido. Escribilo con código de área, sin 0 ni 15 (ej. 11 6239 3600)." };
    const p = await plantillaAprobada(req.body?.plantilla_id);
    const variables = req.body?.variables || [], variablesHeader = req.body?.variables_header || [];
    const errV = validarVariables(p.componentes, variables, variablesHeader);
    if (errV) throw { _http: 400, msg: errV };
    const r = await pool.query(
      `INSERT INTO wa_conversaciones (wa_id, telefono_envio, estado, agente_id, asignada_at, ultimo_mensaje_at)
       VALUES ($1, $1, 'agente', $2, NOW(), NOW())
       ON CONFLICT (wa_id) DO UPDATE SET estado = 'agente', agente_id = $2,
         asignada_at = CASE WHEN wa_conversaciones.agente_id = $2 THEN wa_conversaciones.asignada_at ELSE NOW() END, updated_at = NOW()
       WHERE wa_conversaciones.agente_id IS NULL OR wa_conversaciones.agente_id = $2
       RETURNING id, telefono_envio`,
      [waId, req.user.id]
    );
    if (r.rows.length === 0) {
      const q = await pool.query("SELECT u.nombre_completo FROM wa_conversaciones c LEFT JOIN usuarios u ON u.id = c.agente_id WHERE c.wa_id = $1", [waId]);
      throw { _http: 409, msg: `Ese número ya tiene una conversación tomada por ${q.rows[0]?.nombre_completo || "otro agente"}.` };
    }
    const conv = r.rows[0];
    const { envio, mensaje } = await enviarYGuardarPlantilla(conv.id, conv.telefono_envio, p, variables, variablesHeader, req.user);
    if (envio.error) throw { _http: 502, msg: `WhatsApp no aceptó la plantilla: ${envio.error}`, extra: { conversacion_id: conv.id, mensaje } };
    res.json({ ok: true, conversacion_id: conv.id, mensaje });
  }));

  // ── GET /mensajes/:id/archivo ── URL firmada de 10 min (el bucket es privado; nunca hay URLs públicas).
  router.get("/mensajes/:id/archivo", ver, manejar(async (req, res) => {
    if (!idValido(req.params.id)) throw { _http: 400, msg: "Mensaje inválido." };
    const r = await pool.query("SELECT media_key, media_mime, media_nombre, media_estado, media_bytes FROM wa_mensajes WHERE id = $1", [Number(req.params.id)]);
    const m = r.rows[0];
    if (!m) throw { _http: 404, msg: "Mensaje no encontrado." };
    if (m.media_estado === "vencido") throw { _http: 410, msg: "El archivo venció y se borró por la política de retención." };
    if (!m.media_key) {
      if (m.media_estado === "pendiente") throw { _http: 409, msg: "El archivo todavía se está descargando." };
      if (m.media_estado === "deshabilitado") throw { _http: 503, msg: "Los archivos estaban deshabilitados cuando llegó este mensaje." };
      throw { _http: 404, msg: "No se pudo guardar este archivo." };
    }
    if (!r2Habilitado()) throw { _http: 503, msg: `Archivos deshabilitados: ${estadoR2().motivo}` };
    const mime = m.media_mime || "application/octet-stream";
    const esDocumento = !/^(image|audio|video)[/]/.test(mime);
    const url = await archivos.urlFirmada(m.media_key, 600, esDocumento ? (m.media_nombre || "archivo") : null);
    res.json({ url, mime, nombre: m.media_nombre, bytes: m.media_bytes, expira_en: 600 });
  }));

  // ── POST /conversaciones/:id/archivo?nombre=&caption= ── body = el archivo (imagen JPG/PNG o PDF, máx 10 MB).
  // Se sube a Meta, se envía y se guarda una copia en R2. Necesita la ventana de 24 h y ser la dueña.
  router.post("/conversaciones/:id/archivo", operar, waEncendido, express.raw({ type: () => true, limit: "11mb" }), manejar(async (req, res) => {
    if (!r2Habilitado()) throw { _http: 503, msg: `Archivos deshabilitados: ${estadoR2().motivo}` };
    if (!idValido(req.params.id)) throw { _http: 400, msg: "Conversación inválida." };
    const id = Number(req.params.id);
    const conv = await convDelAgente(id, req.user);
    if (!conv.ventana_abierta) throw { _http: 422, msg: "Pasaron más de 24 h desde el último mensaje del cliente: requiere plantilla.", code: "requiere_plantilla" };
    const buffer = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buffer || !buffer.length) throw { _http: 400, msg: "No llegó ningún archivo." };
    if (buffer.length > MAX_ARCHIVO_SALIENTE) throw { _http: 413, msg: "El archivo supera los 10 MB." };
    const mime = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (!MIMES_SALIENTES.includes(mime)) throw { _http: 415, msg: "Solo se pueden enviar imágenes JPG o PNG, o documentos PDF." };
    const esPdf = mime === "application/pdf";
    const nombre = String(req.query.nombre || (esPdf ? "documento.pdf" : "imagen")).slice(0, 200);
    const caption = String(req.query.caption || "").trim().slice(0, 1024) || null;

    let mediaId;
    try { mediaId = await subirMediaMeta(buffer, mime, nombre); }
    catch (e) { throw { _http: 502, msg: `WhatsApp no aceptó el archivo: ${errorMeta(e)}` }; }
    const payload = esPdf
      ? { type: "document", document: { id: mediaId, filename: nombre, ...(caption ? { caption } : {}) } }
      : { type: "image", image: { id: mediaId, ...(caption ? { caption } : {}) } };
    const envio = await enviarMensajeMeta(numeroParaEnviar(conv.telefono_envio), payload);
    const ins = await pool.query(
      `INSERT INTO wa_mensajes (conversacion_id, wa_message_id, direccion, autor, tipo, caption, estado, error, usuario_id, usuario_nombre,
                                media_id, media_mime, media_nombre, media_bytes, media_estado)
       VALUES ($1, $2, 'out', 'agente', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'pendiente') RETURNING id`,
      [id, envio.id || null, esPdf ? "document" : "image", caption, envio.error ? "failed" : "accepted", envio.error || null,
       req.user.id, req.user.nombre_completo || req.user.username || null, mediaId, mime, nombre, buffer.length]
    );
    const mensajeId = ins.rows[0].id;
    // Copia en R2 (para verlo en el chat aunque Meta ya no lo tenga). Si falla, el envío igual quedó hecho.
    try {
      const key = claveArchivo(id, mensajeId, mime, nombre);
      await archivos.subir(key, buffer, mime);
      await pool.query("UPDATE wa_mensajes SET media_key = $2, media_estado = 'ok' WHERE id = $1", [mensajeId, key]);
    } catch (e) {
      console.error("WhatsApp bandeja: no se pudo guardar la copia en R2 (mensaje", mensajeId + "):", e.message);
      await pool.query("UPDATE wa_mensajes SET media_estado = 'error' WHERE id = $1", [mensajeId]);
    }
    await pool.query("UPDATE wa_conversaciones SET ultimo_mensaje_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    if (!envio.error) await sincronizarEstado(pool, envio.id);
    const out = await pool.query(`SELECT ${COLS_MENSAJE} FROM wa_mensajes WHERE id = $1`, [mensajeId]);
    if (envio.error) throw { _http: 502, msg: `WhatsApp no aceptó el archivo: ${envio.error}`, extra: { mensaje: out.rows[0] } };
    res.json({ ok: true, mensaje: out.rows[0] });
  }));

  return router;
}
