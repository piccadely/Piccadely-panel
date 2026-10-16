// Teléfonos argentinos → clave comparable (solo dígitos, sin prefijos).
// "+54 9 11 15-5555-1234", "011 15 5555 1234", "11 5555-1234" → "1155551234"; "15 5555 1234" → "55551234" (sin código de área).

export function normalizarTelefonoAR(tel) {
  let d = String(tel || "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);                        // 0054… (discado internacional)
  let internacional = false;
  if (d.startsWith("54") && d.length >= 12) { d = d.slice(2); internacional = true; }
  if (d.startsWith("9") && (internacional || d.length === 11)) d = d.slice(1);   // 9 de celular
  if (d.startsWith("0")) d = d.slice(1);                         // 0 de larga distancia
  // 15 después del código de área (11 → 2 dígitos; si no, probamos 3, 4 y 2): queda área + número = 10 dígitos
  if (d.length === 12) {
    for (const a of d.startsWith("11") ? [2] : [3, 4, 2]) {
      if (d.slice(a, a + 2) === "15") { d = d.slice(0, a) + d.slice(a + 2); break; }
    }
  }
  if (d.length === 10 && d.startsWith("15")) d = d.slice(2);    // 15 al inicio, sin código de área
  return d;
}

// Mismo teléfono: con código de área en ambos se comparan los 10 dígitos; si alguno viene
// sin código de área (8 dígitos) se comparan los últimos 8.
export function mismoTelefonoAR(a, b) {
  const x = normalizarTelefonoAR(a), y = normalizarTelefonoAR(b);
  if (x.length < 8 || y.length < 8) return false;
  const n = Math.min(x.length, y.length) >= 10 ? 10 : 8;
  return x.slice(-n) === y.slice(-n);
}
