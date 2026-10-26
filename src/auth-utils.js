// ─────────────────────────────────────────────────────────────────────
// auth-utils.js — Helpers de sesión + interceptor global de axios
//
// Importar este archivo en App.jsx (basta con `import "./auth-utils";`)
// para que los interceptors se registren globalmente.
// ─────────────────────────────────────────────────────────────────────

import axios from "axios";

const API = import.meta.env.VITE_API_URL || "https://piccadely-panel-production.up.railway.app";
const TOKEN_KEY = "piccadely_token";
const USER_KEY = "piccadely_user";

// ── Interceptor de REQUEST: agrega el token JWT a cada llamada ──
axios.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Sesión vencida: el login muestra el aviso y, al volver a entrar el MISMO usuario, el panel
// vuelve a la vista en la que estaba. sessionStorage = por pestaña (otro local / otra pestaña no se mezcla).
const VENCIDA_KEY = "piccadely_sesion_vencida";
const VISTA_KEY = "piccadely_ultima_vista";   // { username, vista, tab }
const leerSesion = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
const escribirSesion = (k, v) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* sin storage */ } };
let recargando = false;   // varias llamadas dan 401 a la vez (refresco de 30 s, WhatsApp…): se recarga una sola vez

// ── Interceptor de RESPONSE: si el server devuelve 401 (token vencido),
//    borra la sesión, marca "sesión vencida" y recarga para mostrar el login con el aviso. ──
axios.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      const url = err.config?.url || "";
      // 401 que NO son de sesión: credenciales / código 2FA del login y "contraseña actual incorrecta".
      if (!url.includes("/api/login") && !url.includes("/api/cambiar-password") && !recargando) {
        recargando = true;
        escribirSesion(VENCIDA_KEY, "1");
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        window.location.reload();
      }
    }
    return Promise.reject(err);
  }
);

export function sesionVencida() {
  return leerSesion(VENCIDA_KEY) === "1";
}

export function guardarVistaActual(username, vista, tab) {
  escribirSesion(VISTA_KEY, JSON.stringify({ username, vista, tab }));
}

// Al entrar al panel: si la sesión había vencido y vuelve el mismo usuario → { vista, tab } donde estaba.
// Consume la marca (una sola vez).
export function tomarVistaPrevia(username) {
  if (!sesionVencida()) return null;
  escribirSesion(VENCIDA_KEY, null);
  try {
    const v = JSON.parse(leerSesion(VISTA_KEY) || "null");
    return v && v.username === username ? { vista: v.vista, tab: v.tab } : null;
  } catch { return null; }
}

// ── Helpers de sesión ──

export function guardarSesion(token, user) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUsuarioGuardado() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function cerrarSesion() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  window.location.reload();
}

// Valida con el backend que el token guardado sigue siendo válido.
// Devuelve el user actualizado, o null si no hay token o expiró.
export async function validarSesion() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  try {
    const res = await axios.get(`${API}/api/me`);
    return res.data.user;
  } catch {
    return null;
  }
}

// Etiquetas legibles para los roles
export const ROL_LABELS = {
  superadmin: "Superadmin",
  admin: "Admin",
  encargado: "Encargado",
  solo_lectura: "Solo lectura",
  crm: "Comercial",
  a_thomas: "A. Thomas",
  french: "French",
};
