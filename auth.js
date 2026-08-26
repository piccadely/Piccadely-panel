// ─────────────────────────────────────────────────────────────────────
// auth.js — Sistema de autenticación de Piccadely
//
// Exporta dos funciones:
//   - initAuthDB(pool):  crea la tabla usuarios y seedea los 12 iniciales
//   - setupAuth(app, pool):  monta los endpoints de login/usuarios y
//                            devuelve los middlewares { requireAuth, requireAdmin, requireRole }
//
// Variables de entorno requeridas (validadas en server.js):
//   - JWT_SECRET:  secret para firmar JWT
//   - ADMIN_SECRET: secret para autenticación admin vía header x-admin-secret
//
// Variable de entorno opcional:
//   - PASSWORD_INICIAL: contraseña usada en el primer seed (default "Piccadely2026!")
// ─────────────────────────────────────────────────────────────────────

import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SECRET = process.env.ADMIN_SECRET;
const JWT_EXPIRES_IN = "14h";
const CODIGO_2FA_TTL_MIN = 10;              // vencimiento del código 2FA de 6 dígitos (minutos)
const CHALLENGE_2FA_EXPIRES_IN = "10m";     // vencimiento del challengeToken (paso 2 del login)
const REENVIO_2FA_MIN_MS = 30 * 1000;       // no reenviar el código más de 1 vez cada 30s
const MODO_LECTURA_EXPIRES_IN = "4h";       // duración del token de emergencia (modo solo-lectura)
const PASSWORD_INICIAL = process.env.PASSWORD_INICIAL || "Piccadely2026!";

// ─── INIT DB: tabla + seed ───────────────────────────────────────────
export async function initAuthDB(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nombre_completo TEXT NOT NULL,
      rol TEXT NOT NULL CHECK (rol IN ('admin', 'a_thomas', 'french', 'encargado')),
      activo BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // 2FA por email (parte 1): columnas opcionales. email_2fa NULL = usuario sin 2FA (entra normal).
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email_2fa TEXT;`);
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_2fa TEXT;`);
  await pool.query(`ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS codigo_2fa_expira TIMESTAMP;`);

  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM usuarios");
  if (rows[0].n > 0) {
    console.log(`Auth: ${rows[0].n} usuarios ya cargados, skip seed`);
    return;
  }

  const hash = await bcrypt.hash(PASSWORD_INICIAL, 10);
  const usuariosIniciales = [
    // Admin
    { username: "administracion", nombre: "Administración",     rol: "admin" },
    { username: "compras",        nombre: "Compras",            rol: "admin" },
    { username: "operaciones",    nombre: "Operaciones",        rol: "admin" },
    { username: "chapa",          nombre: "Chapa",              rol: "admin" },
    // A. Thomas
    { username: "yus",            nombre: "Yus",                rol: "a_thomas" },
    { username: "cristian",       nombre: "Cristian",           rol: "a_thomas" },
    { username: "carmen",         nombre: "Carmen",             rol: "a_thomas" },
    { username: "rocio",          nombre: "Rocio",              rol: "a_thomas" },
    { username: "general_at",     nombre: "General A. Thomas",  rol: "a_thomas" },
    // French
    { username: "cristina",       nombre: "Cristina",           rol: "french" },
    { username: "leandro",        nombre: "Leandro",            rol: "french" },
    { username: "general_fr",     nombre: "General French",     rol: "french" },
  ];

  for (const u of usuariosIniciales) {
    await pool.query(
      "INSERT INTO usuarios (username, password_hash, nombre_completo, rol) VALUES ($1, $2, $3, $4)",
      [u.username, hash, u.nombre, u.rol]
    );
  }

  console.log(`Auth: seed completo — ${usuariosIniciales.length} usuarios creados con password inicial`);
}

// ─── SETUP: middlewares + endpoints ──────────────────────────────────
export function setupAuth(app, pool, mailTransporter) {
  // ─── GATE MODO SOLO-LECTURA (emergencia por mail caído) ────────────────
  // Un token con modoLectura:true SOLO puede hacer los GET del panel de pedidos activos
  // (allowlist explícita). Cualquier otra cosa — escrituras, reportes, caja, ABM, etc. — → 403.
  // Se monta ANTES de cualquier ruta, así cubre también los endpoints que hoy no tienen auth.
  const RUTAS_LECTURA_OK = [
    /^\/api\/orders$/, /^\/api\/estados$/, /^\/api\/pedidos-manuales$/,
    /^\/api\/pedidos\/productos-all$/, /^\/api\/repartidores$/,
    /^\/api\/tandas$/, /^\/api\/facturas-all$/, /^\/api\/me$/,
  ];
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return next(); // sin token → flujo normal
    let payload;
    try { payload = jwt.verify(authHeader.slice(7), JWT_SECRET); } catch { return next(); } // inválido → lo maneja el requireAuth de la ruta
    if (!payload.modoLectura) return next();  // token normal → sin restricción acá
    const permitido = req.method === "GET" && RUTAS_LECTURA_OK.some(re => re.test(req.path));
    if (permitido) return next();
    return res.status(403).json({ error: "Modo solo lectura: acción no permitida." });
  });

  function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Falta token" });
    }
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Token inválido o expirado" });
    }
  }

  function requireRole(...rolesPermitidos) {
    return (req, res, next) => {
      if (!req.user) return res.status(401).json({ error: "No autenticado" });
      if (!rolesPermitidos.includes(req.user.rol)) {
        return res.status(403).json({ error: "Permisos insuficientes" });
      }
      next();
    };
  }

  function requireAdmin(req, res, next) {
    const adminSecretHeader = req.headers["x-admin-secret"];
    if (adminSecretHeader && adminSecretHeader === ADMIN_SECRET) {
      req.user = { id: 0, username: "system", rol: "admin", nombre_completo: "Sistema" };
      return next();
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No autorizado" });
    }
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (payload.rol !== "admin") {
        return res.status(403).json({ error: "Requiere rol admin" });
      }
      req.user = payload;
      next();
    } catch (err) {
      return res.status(401).json({ error: "Token inválido o expirado" });
    }
  }

  // ─── 2FA POR EMAIL ───────────────────────────────────────────────────
  // Código de 6 dígitos al email_2fa del usuario. Se guarda HASHEADO (bcrypt), vence a
  // CODIGO_2FA_TTL_MIN, un solo uso. mailTransporter se inyecta desde server.js.
  async function generarYEnviarCodigo2FA(usuario) {
    if (!usuario?.email_2fa) return { ok: false, error: "El usuario no tiene 2FA configurado" };
    if (!mailTransporter) return { ok: false, error: "Mail no configurado en el servidor" };
    const codigo = String(Math.floor(100000 + Math.random() * 900000));
    const hash = await bcrypt.hash(codigo, 10);
    const expira = new Date(Date.now() + CODIGO_2FA_TTL_MIN * 60 * 1000);
    await pool.query("UPDATE usuarios SET codigo_2fa=$1, codigo_2fa_expira=$2 WHERE id=$3", [hash, expira, usuario.id]);
    try {
      await mailTransporter.sendMail({
        from: `Piccadely <${process.env.GMAIL_USER}>`,
        to: usuario.email_2fa,
        subject: "Código de acceso Piccadely Panel",
        text: `Código de acceso para ${usuario.nombre_completo}: ${codigo}. Vence en ${CODIGO_2FA_TTL_MIN} minutos. Si no fuiste vos, avisá al administrador.`,
      });
    } catch (err) {
      console.error("Error enviando código 2FA:", err.message);
      return { ok: false, error: "No se pudo enviar el mail" };
    }
    return { ok: true };
  }
  async function verificarCodigo2FA(usuario, codigo) {
    if (!usuario?.id || !codigo) return false;
    const { rows } = await pool.query("SELECT codigo_2fa, codigo_2fa_expira FROM usuarios WHERE id=$1", [usuario.id]);
    const u = rows[0];
    if (!u || !u.codigo_2fa || !u.codigo_2fa_expira) return false;
    if (new Date(u.codigo_2fa_expira).getTime() < Date.now()) return false; // vencido
    const ok = await bcrypt.compare(String(codigo).trim(), u.codigo_2fa);
    if (!ok) return false;
    await pool.query("UPDATE usuarios SET codigo_2fa=NULL, codigo_2fa_expira=NULL WHERE id=$1", [usuario.id]); // un solo uso
    return true;
  }

  app.post("/api/login", async (req, res) => {
    try {
      const { username, password } = req.body;
      if (!username || !password) return res.status(400).json({ error: "Faltan username o password" });

      const { rows } = await pool.query(
        "SELECT * FROM usuarios WHERE username = $1 AND activo = true",
        [String(username).toLowerCase().trim()]
      );
      if (rows.length === 0) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

      const user = rows[0];
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) return res.status(401).json({ error: "Usuario o contraseña incorrectos" });

      // 2FA: si el usuario tiene email_2fa, NO damos el token todavía — mandamos el código y
      // devolvemos un challengeToken corto (paso 2). Sin email_2fa entra directo, como siempre.
      if (user.email_2fa) {
        const envio = await generarYEnviarCodigo2FA(user);
        if (!envio.ok) {
          // Mail caído (user+pass YA validados): ofrecemos entrar en MODO SOLO-LECTURA.
          // OJO: esto NO es un bypass — solo se llega acá con credenciales correctas.
          const emergencyChallengeToken = jwt.sign({ emergencyPending: true, userId: user.id }, JWT_SECRET, { expiresIn: CHALLENGE_2FA_EXPIRES_IN });
          return res.json({ emergenciaDisponible: true, emergencyChallengeToken });
        }
        const challengeToken = jwt.sign({ pending2fa: true, userId: user.id }, JWT_SECRET, { expiresIn: CHALLENGE_2FA_EXPIRES_IN });
        return res.json({ requiere2FA: true, challengeToken });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, rol: user.rol, nombre_completo: user.nombre_completo },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );

      res.json({
        token,
        user: { id: user.id, username: user.username, nombre_completo: user.nombre_completo, rol: user.rol }
      });
    } catch (err) {
      console.error("Error /api/login:", err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  // Paso 2 del login: verifica el challengeToken + el código, y recién ahí da el JWT de sesión.
  app.post("/api/login/2fa", async (req, res) => {
    try {
      const { challengeToken, codigo } = req.body;
      if (!challengeToken || !codigo) return res.status(400).json({ error: "Faltan datos" });
      let payload;
      try { payload = jwt.verify(challengeToken, JWT_SECRET); } catch { return res.status(401).json({ error: "La verificación venció. Ingresá de nuevo." }); }
      if (!payload.pending2fa || !payload.userId) return res.status(401).json({ error: "Token de verificación inválido" });
      const { rows } = await pool.query("SELECT * FROM usuarios WHERE id=$1 AND activo=true", [payload.userId]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: "Usuario no encontrado o inactivo" });
      const valido = await verificarCodigo2FA(user, codigo);
      if (!valido) return res.status(401).json({ error: "Código incorrecto o vencido" });
      const token = jwt.sign(
        { id: user.id, username: user.username, rol: user.rol, nombre_completo: user.nombre_completo },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRES_IN }
      );
      res.json({
        token,
        user: { id: user.id, username: user.username, nombre_completo: user.nombre_completo, rol: user.rol }
      });
    } catch (err) {
      console.error("Error /api/login/2fa:", err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  // Reenvío del código (botón "reenviar"). Rate limit: 1 cada 30s (stateless, vía codigo_2fa_expira).
  app.post("/api/login/2fa/reenviar", async (req, res) => {
    try {
      const { challengeToken } = req.body;
      if (!challengeToken) return res.status(400).json({ error: "Falta challengeToken" });
      let payload;
      try { payload = jwt.verify(challengeToken, JWT_SECRET); } catch { return res.status(401).json({ error: "La verificación venció. Ingresá de nuevo." }); }
      if (!payload.pending2fa || !payload.userId) return res.status(401).json({ error: "Token de verificación inválido" });
      const { rows } = await pool.query("SELECT * FROM usuarios WHERE id=$1 AND activo=true", [payload.userId]);
      const user = rows[0];
      if (!user || !user.email_2fa) return res.status(400).json({ error: "El usuario no tiene 2FA" });
      // Antigüedad del último código = TTL - (expira - ahora). Si < 30s, todavía no se puede reenviar.
      if (user.codigo_2fa_expira) {
        const antiguedadMs = (CODIGO_2FA_TTL_MIN * 60 * 1000) - (new Date(user.codigo_2fa_expira).getTime() - Date.now());
        if (antiguedadMs < REENVIO_2FA_MIN_MS) return res.status(429).json({ error: "Esperá unos segundos antes de reenviar." });
      }
      const envio = await generarYEnviarCodigo2FA(user);
      if (!envio.ok) return res.status(503).json({ error: "No pudimos reenviar el código. Contactá al administrador." });
      res.json({ ok: true });
    } catch (err) {
      console.error("Error /api/login/2fa/reenviar:", err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  // Acceso de EMERGENCIA (modo solo-lectura) cuando el mail está caído. Requiere el
  // emergencyChallengeToken que devuelve /api/login al fallar el envío del código.
  app.post("/api/login/emergencia", async (req, res) => {
    try {
      const { emergencyChallengeToken } = req.body;
      if (!emergencyChallengeToken) return res.status(400).json({ error: "Falta el token de emergencia" });
      let payload;
      try { payload = jwt.verify(emergencyChallengeToken, JWT_SECRET); } catch { return res.status(401).json({ error: "El acceso de emergencia venció. Ingresá de nuevo." }); }
      if (!payload.emergencyPending || !payload.userId) return res.status(401).json({ error: "Token de emergencia inválido" });
      const { rows } = await pool.query("SELECT * FROM usuarios WHERE id=$1 AND activo=true", [payload.userId]);
      const user = rows[0];
      if (!user) return res.status(401).json({ error: "Usuario no encontrado o inactivo" });
      // Token de sesión ESPECIAL marcado modoLectura:true (el gate global lo restringe a los GET del panel).
      const token = jwt.sign(
        { id: user.id, username: user.username, rol: user.rol, nombre_completo: user.nombre_completo, modoLectura: true },
        JWT_SECRET,
        { expiresIn: MODO_LECTURA_EXPIRES_IN }
      );
      res.json({
        token,
        user: { id: user.id, username: user.username, nombre_completo: user.nombre_completo, rol: user.rol, modoLectura: true }
      });
    } catch (err) {
      console.error("Error /api/login/emergencia:", err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  // Endpoints de testing del 2FA (desde el ABM, sin tocar el login). Operan sobre el usuario logueado.
  app.post("/api/2fa/test-enviar", requireAuth, async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT id, nombre_completo, email_2fa FROM usuarios WHERE id=$1", [req.user.id]);
      const usuario = rows[0];
      if (!usuario) return res.status(404).json({ error: "Usuario no encontrado" });
      if (!usuario.email_2fa) return res.status(400).json({ error: "Tu usuario no tiene email 2FA configurado" });
      const r = await generarYEnviarCodigo2FA(usuario);
      if (!r.ok) return res.status(500).json({ error: r.error });
      res.json({ ok: true, enviadoA: usuario.email_2fa });
    } catch (err) { console.error("Error /api/2fa/test-enviar:", err.message); res.status(500).json({ error: "Error enviando código 2FA" }); }
  });
  app.post("/api/2fa/test-verificar", requireAuth, async (req, res) => {
    try {
      const valido = await verificarCodigo2FA({ id: req.user.id }, req.body?.codigo);
      res.json({ valido: !!valido });
    } catch (err) { console.error("Error /api/2fa/test-verificar:", err.message); res.status(500).json({ error: "Error verificando código 2FA" }); }
  });

  app.get("/api/me", requireAuth, (req, res) => {
    res.json({ user: req.user });
  });

  app.post("/api/cambiar-password", requireAuth, async (req, res) => {
    try {
      const { passwordActual, passwordNuevo } = req.body;
      if (!passwordActual || !passwordNuevo) return res.status(400).json({ error: "Faltan campos" });
      if (passwordNuevo.length < 4) return res.status(400).json({ error: "La nueva contraseña es muy corta" });

      const { rows } = await pool.query("SELECT password_hash FROM usuarios WHERE id = $1", [req.user.id]);
      if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

      const valido = await bcrypt.compare(passwordActual, rows[0].password_hash);
      if (!valido) return res.status(401).json({ error: "Contraseña actual incorrecta" });

      const nuevoHash = await bcrypt.hash(passwordNuevo, 10);
      await pool.query("UPDATE usuarios SET password_hash = $1, updated_at = NOW() WHERE id = $2", [nuevoHash, req.user.id]);
      res.json({ ok: true });
    } catch (err) {
      console.error("Error /api/cambiar-password:", err.message);
      res.status(500).json({ error: "Error en el servidor" });
    }
  });

  app.get("/api/usuarios", requireAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT id, username, nombre_completo, rol, activo, email_2fa, created_at FROM usuarios ORDER BY rol, nombre_completo"
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/usuarios", requireAdmin, async (req, res) => {
    try {
      const { username, password, nombre_completo, rol, email_2fa } = req.body;
      if (!username || !password || !nombre_completo || !rol) return res.status(400).json({ error: "Faltan campos" });
      if (!["admin", "a_thomas", "french", "encargado"].includes(rol)) return res.status(400).json({ error: "Rol inválido" });
      if (password.length < 4) return res.status(400).json({ error: "La contraseña es muy corta" });
      const email2fa = (email_2fa && String(email_2fa).trim()) ? String(email_2fa).trim() : null;
      if (email2fa && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email2fa)) return res.status(400).json({ error: "Email 2FA inválido" });

      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO usuarios (username, password_hash, nombre_completo, rol, email_2fa)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, username, nombre_completo, rol, activo, email_2fa`,
        [String(username).toLowerCase().trim(), hash, nombre_completo, rol, email2fa]
      );
      res.json(rows[0]);
    } catch (err) {
      if (err.code === "23505") return res.status(409).json({ error: "Ese username ya existe" });
      res.status(500).json({ error: err.message });
    }
  });

  app.patch("/api/usuarios/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      const { nombre_completo, rol, activo, password, email_2fa } = req.body;

      const updates = [];
      const valores = [];
      let i = 1;

      if (nombre_completo !== undefined) { updates.push(`nombre_completo = $${i++}`); valores.push(nombre_completo); }
      if (rol !== undefined) {
        if (!["admin", "a_thomas", "french", "encargado"].includes(rol)) return res.status(400).json({ error: "Rol inválido" });
        updates.push(`rol = $${i++}`); valores.push(rol);
      }
      if (activo !== undefined) { updates.push(`activo = $${i++}`); valores.push(activo); }
      if (password) {
        if (password.length < 4) return res.status(400).json({ error: "La contraseña es muy corta" });
        const hash = await bcrypt.hash(password, 10);
        updates.push(`password_hash = $${i++}`); valores.push(hash);
      }
      if (email_2fa !== undefined) {
        const email2fa = (email_2fa && String(email_2fa).trim()) ? String(email_2fa).trim() : null;
        if (email2fa && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email2fa)) return res.status(400).json({ error: "Email 2FA inválido" });
        updates.push(`email_2fa = $${i++}`); valores.push(email2fa);
      }

      if (updates.length === 0) return res.status(400).json({ error: "Nada para actualizar" });

      updates.push(`updated_at = NOW()`);
      valores.push(id);

      const sql = `UPDATE usuarios SET ${updates.join(", ")} WHERE id = $${i}
                   RETURNING id, username, nombre_completo, rol, activo, email_2fa`;
      const { rows } = await pool.query(sql, valores);

      if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/api/usuarios/:id", requireAdmin, async (req, res) => {
    try {
      const { id } = req.params;
      if (Number(id) === req.user.id) return res.status(400).json({ error: "No podés eliminarte a vos mismo" });
      const { rows } = await pool.query("DELETE FROM usuarios WHERE id = $1 RETURNING id", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  return { requireAuth, requireAdmin, requireRole };
}