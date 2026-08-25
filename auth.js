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
export function setupAuth(app, pool) {
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
        "SELECT id, username, nombre_completo, rol, activo, created_at FROM usuarios ORDER BY rol, nombre_completo"
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post("/api/usuarios", requireAdmin, async (req, res) => {
    try {
      const { username, password, nombre_completo, rol } = req.body;
      if (!username || !password || !nombre_completo || !rol) return res.status(400).json({ error: "Faltan campos" });
      if (!["admin", "a_thomas", "french", "encargado"].includes(rol)) return res.status(400).json({ error: "Rol inválido" });
      if (password.length < 4) return res.status(400).json({ error: "La contraseña es muy corta" });

      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO usuarios (username, password_hash, nombre_completo, rol)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, nombre_completo, rol, activo`,
        [String(username).toLowerCase().trim(), hash, nombre_completo, rol]
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
      const { nombre_completo, rol, activo, password } = req.body;

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

      if (updates.length === 0) return res.status(400).json({ error: "Nada para actualizar" });

      updates.push(`updated_at = NOW()`);
      valores.push(id);

      const sql = `UPDATE usuarios SET ${updates.join(", ")} WHERE id = $${i}
                   RETURNING id, username, nombre_completo, rol, activo`;
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