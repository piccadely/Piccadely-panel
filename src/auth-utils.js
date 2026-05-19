// ─────────────────────────────────────────────────────────────────────
// auth-utils.js — Helpers de sesión + interceptor global de axios
//
// Importar este archivo en App.jsx (basta con `import "./auth-utils";`)
// para que los interceptors se registren globalmente.
// ─────────────────────────────────────────────────────────────────────

import axios from "axios";

const API = "https://piccadely-panel-production.up.railway.app";
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

// ── Interceptor de RESPONSE: si el server devuelve 401 (token expirado),
//    borra la sesión y recarga la página para mostrar el login. ──
axios.interceptors.response.use(
  res => res,
  err => {
    if (err.response?.status === 401) {
      const url = err.config?.url || "";
      // No matar la sesión si el 401 viene del propio /api/login
      // (eso es solo "credenciales incorrectas" en el form de login).
      if (!url.includes("/api/login")) {
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        window.location.reload();
      }
    }
    return Promise.reject(err);
  }
);

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
  admin: "Admin",
  a_thomas: "A. Thomas",
  french: "French",
};
