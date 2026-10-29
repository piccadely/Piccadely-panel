// ─────────────────────────────────────────────────────────────────────
//  Routes/antispam.js  ·  Protección de los formularios PÚBLICOS que guardan un lead y mandan mail
//  (cotizador de regalos y cotizador de eventos).
//    · Rate limit en memoria (una sola réplica): máx. `limite` leads GUARDADOS por IP cada `ventanaMs`
//      (un error de validación no consume intentos).
//    · Honeypot: campo oculto en el formulario; una persona nunca lo completa.
// ─────────────────────────────────────────────────────────────────────

export const CAMPO_HONEYPOT = "sitio_web";

// IP: el ÚLTIMO valor de X-Forwarded-For (lo agrega el proxy de Railway; los anteriores los puede inventar
// el cliente), o la del socket si no hay proxy.
export function ipDe(req) {
  const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket?.remoteAddress || "desconocida");
}

export const esBot = (body) => !!String(body?.[CAMPO_HONEYPOT] || "").trim();

export function crearLimitador({ limite = 5, ventanaMs = 10 * 60 * 1000 } = {}) {
  const porIp = new Map();   // ip → [timestamps]
  const recientes = (ip, ahora = Date.now()) => {
    const lista = (porIp.get(ip) || []).filter((t) => ahora - t < ventanaMs);
    if (lista.length) porIp.set(ip, lista); else porIp.delete(ip);
    return lista;
  };
  setInterval(() => { for (const ip of [...porIp.keys()]) recientes(ip); }, ventanaMs).unref();
  return {
    limite,
    excedido: (ip) => recientes(ip).length >= limite,
    registrar: (ip) => porIp.set(ip, [...recientes(ip), Date.now()]),
  };
}
