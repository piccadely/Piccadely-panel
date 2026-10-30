// ─────────────────────────────────────────────────────────────────────────
// Renglones de un pedido para FACTURAR en TusFacturas (producto, cantidad, precio
// unitario, subtotal). COMPARTIDO por el BACKEND (server.js: vista previa y emisión)
// y el FRONT (src/App.jsx: alta manual, Editar productos y modal de facturación).
//
// Renglón: { nombre, cantidad, precio, tipo, codigo?, origen? }
//   precio = unitario CON IVA, en pesos (lo que paga el cliente). Negativo solo en descuentos.
//   tipo   = "producto" | "envio" | "descuento".
//   origen = de dónde salió el precio (solo informativo, para la vista previa):
//            guardado · tn · zona · catalogo · calculado · diferencia · editado · falta.
//
// Reglas de la factura (ver detalleTusFacturas):
//   - un renglón por producto y uno por el envío, con su cantidad real;
//   - TusFacturas NO acepta renglones negativos: los descuentos van juntos como
//     bonificación general del comprobante (monto sin IVA);
//   - el total facturado es EXACTAMENTE el total del pedido.
// ─────────────────────────────────────────────────────────────────────────
import { calcularEnvioTN } from "./productos-normalizacion.js";

// Zonas de envío para el alta manual. El ítem que se suma al carrito se llama
// "Envío {nombre}" (queda excluido de cocina/producción/reporte por esExcluidoProduccion).
export const ZONAS_ENVIO = [
  { nombre: "CABA", precio: 2500 },
  { nombre: "Olivos · San Isidro", precio: 5000 },
  { nombre: "San Martín · San Fernando", precio: 8000 },
  { nombre: "Tigre · Malvinas Argentinas", precio: 13000 },
  { nombre: "Pilar · Escobar", precio: 25000 },
  { nombre: "Tres de Febrero", precio: 7500 },
  { nombre: "San Miguel · José C. Paz", precio: 15000 },
  { nombre: "General Rodríguez", precio: 25000 },
  { nombre: "Morón · Hurlingham", precio: 12000 },
  { nombre: "Ituzaingó · Moreno · Merlo", precio: 17000 },
  { nombre: "La Matanza", precio: 20000 },
  { nombre: "Marcos Paz", precio: 25000 },
  { nombre: "Avellaneda · Lanús", precio: 6000 },
  { nombre: "Lomas de Zamora · Quilmes", precio: 11000 },
  { nombre: "Pdte. Perón · Berazategui · Florencio Varela · Ezeiza", precio: 25000 },
  { nombre: "La Plata", precio: 35000 },
];

export const TIPOS_RENGLON = ["producto", "envio", "descuento"];
export const NOMBRE_DESCUENTO_RETIRO = "Descuento 10% Retiro";
const PCT_DESCUENTO_RETIRO = 0.10;

const aCentavos = (n) => Math.round(Number(n) * 100);
const deCentavos = (c) => c / 100;
const norm = (s) => String(s || "").trim().toLowerCase();
const esNombreEnvio = (nombre) => /^env[ií]o(\s|$)/i.test(String(nombre || "").trim());

// Código del producto en TusFacturas (hasta 20 caracteres). Se usa el id de la variante de TN,
// que es único y estable; el envío es "ENVIO" y lo que no viene del catálogo, "VARIOS".
// Se emite siempre con actualiza_precio "N", así que el código no pisa nada en TusFacturas.
export function codigoRenglon(r) {
  if (r.codigo) return String(r.codigo).slice(0, 20);
  if (r.tipo === "envio") return "ENVIO";
  return "VARIOS";
}
const codigoTN = (variantId, sku) => (sku ? String(sku) : (variantId ? `TN${variantId}` : "")).slice(0, 20) || undefined;

// Lista de renglones que llega de afuera (body de un POST) → renglones limpios, o null si algo
// no cierra (nombre, cantidad entera, precio finito, tipo válido, signo coherente con el tipo).
export function sanitizarRenglones(lista) {
  if (!Array.isArray(lista) || lista.length === 0 || lista.length > 200) return null;
  const out = [];
  for (const r of lista) {
    if (!r || typeof r !== "object") return null;
    const nombre = String(r.nombre || "").trim().slice(0, 200);
    const cantidad = Number(r.cantidad);
    const precio = Number(r.precio);
    const tipo = TIPOS_RENGLON.includes(r.tipo) ? r.tipo : null;
    if (!nombre || !tipo || !Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100000) return null;
    if (!Number.isFinite(precio) || Math.abs(precio) > 1e9) return null;
    if (tipo === "descuento" ? precio > 0 : precio < 0) return null;
    const limpio = { nombre, cantidad, precio: deCentavos(aCentavos(precio)), tipo };
    if (r.codigo) limpio.codigo = String(r.codigo).slice(0, 20);
    out.push(limpio);
  }
  return out;
}

// Carrito del alta manual / de Editar productos → renglones para guardar con el pedido.
// Ítems del carrito: { nombre, precio, cantidad, esEnvio?, variantId? }. Un precio negativo
// (p. ej. un "producto variable" Descuento Empresa) es un descuento.
export function renglonesDeCarrito(carrito, { descuentoRetiro = 0 } = {}) {
  const out = (carrito || []).map((i) => {
    const precio = Number(i.precio) || 0;
    const tipo = i.tipo && TIPOS_RENGLON.includes(i.tipo) ? i.tipo
      : precio < 0 ? "descuento" : (i.esEnvio || esNombreEnvio(i.nombre)) ? "envio" : "producto";
    const r = { nombre: String(i.nombre || "").trim(), cantidad: Number(i.cantidad) || 1, precio, tipo };
    const codigo = i.codigo || (/^\d+$/.test(String(i.variantId || "")) ? `TN${i.variantId}` : undefined);
    if (codigo) r.codigo = String(codigo).slice(0, 20);
    return r;
  });
  if (descuentoRetiro > 0) out.push({ nombre: NOMBRE_DESCUENTO_RETIRO, cantidad: 1, precio: -descuentoRetiro, tipo: "descuento" });
  return out;
}

// Descuento 10% Retiro: el mismo cálculo que el alta manual (10% de los productos, sin el envío, redondeado al peso).
export const montoDescuentoRetiro = (subtotalProductos) => Math.round(subtotalProductos * PCT_DESCUENTO_RETIRO);

// Totales de una lista de renglones contra el total del pedido (en centavos, sin errores de coma flotante).
// cierra = todos tienen precio y productos + envío − descuentos = total, al centavo.
export function resumenRenglones(renglones, total) {
  let subtotal = 0, descuento = 0, faltan = 0;
  for (const r of renglones || []) {
    if (r.precio === null || r.precio === undefined || !Number.isFinite(Number(r.precio))) { faltan++; continue; }
    const c = aCentavos(r.precio) * Number(r.cantidad);
    if (c < 0) descuento -= c; else subtotal += c;
  }
  const diferencia = aCentavos(total) - (subtotal - descuento);
  return {
    subtotal: deCentavos(subtotal), descuento: deCentavos(descuento), total: deCentavos(subtotal - descuento),
    diferencia: deCentavos(diferencia), faltan, cierra: faltan === 0 && diferencia === 0,
  };
}

// Si queda UN solo renglón sin precio, su precio sale de la diferencia con el total del pedido
// (el caso típico: el "Descuento Empresa" cargado como producto variable con precio negativo).
// Diferencia negativa → descuento; positiva → precio de ese renglón (si se divide justo por la cantidad).
export function conciliar(renglones, total) {
  const lista = (renglones || []).map((r) => ({ ...r }));
  const sinPrecio = lista.filter((r) => r.precio === null || r.precio === undefined);
  if (sinPrecio.length === 1) {
    const f = sinPrecio[0];
    const conocidos = lista.filter((r) => r !== f);
    const dif = aCentavos(total) - aCentavos(resumenRenglones(conocidos, 0).total);
    const porUnidad = dif / f.cantidad;
    if (Number.isInteger(porUnidad)) {
      if (dif < 0) { f.precio = deCentavos(porUnidad); f.tipo = "descuento"; f.origen = "diferencia"; }
      else if (dif > 0 && f.tipo !== "descuento") { f.precio = deCentavos(porUnidad); f.origen = "diferencia"; }
    }
  }
  return { renglones: lista, ...resumenRenglones(lista, total) };
}

// Precio de un renglón "nombre xN" cuando el pedido no tiene renglones guardados.
// Orden: línea real del pedido de TN (por nombre) → zona de envío → catálogo de hoy (por nombre) → falta.
function precioReconstruido(nombre, { lineasTN, catalogo }) {
  const linea = lineasTN.find((pr) => norm(pr?.name) === norm(nombre));
  if (linea && Number(linea.price) > 0) return { precio: Number(linea.price), origen: "tn", codigo: codigoTN(linea.variant_id, linea.sku) };
  if (esNombreEnvio(nombre)) {
    const zona = ZONAS_ENVIO.find((z) => norm(`Envío ${z.nombre}`) === norm(nombre));
    if (zona) return { precio: zona.precio, origen: "zona" };
  }
  const prod = catalogo.find((pr) => norm(pr?.name?.es ?? pr?.name) === norm(nombre));
  const v = prod?.variants?.[0];
  if (v && Number(v.price) > 0) return { precio: Number(v.price), origen: "catalogo", codigo: codigoTN(v.id, v.sku) };
  return { precio: null, origen: "falta" };
}

// Pedido viejo (sin renglones guardados): se reconstruye desde el texto "nombre xN, ...".
// lineasTN = líneas crudas del pedido de TN (+ ítem "Envío" con su costo), o [] si es manual.
export function reconstruirRenglones({ productos, total, lineasTN = [], catalogo = [] }) {
  const items = String(productos || "").split(", ").map((s) => s.trim()).filter(Boolean);
  const renglones = items.map((item) => {
    const m = item.match(/^(.+) x(\d+)$/);
    const nombre = m ? m[1].trim() : item;
    const cantidad = m ? Number(m[2]) : 1;
    if (norm(nombre) === norm(NOMBRE_DESCUENTO_RETIRO)) return { nombre, cantidad, precio: null, tipo: "descuento", origen: "falta", retiro: true };
    const { precio, origen, codigo } = precioReconstruido(nombre, { lineasTN: Array.isArray(lineasTN) ? lineasTN : [], catalogo: Array.isArray(catalogo) ? catalogo : [] });
    const r = { nombre, cantidad, precio, tipo: esNombreEnvio(nombre) ? "envio" : "producto", origen };
    if (codigo) r.codigo = codigo;
    return r;
  });
  // El 10% de retiro se calcula como en el alta, si se conocen todos los precios de los productos.
  const productosR = renglones.filter((r) => r.tipo === "producto");
  if (productosR.every((r) => r.precio !== null)) {
    const sub = productosR.reduce((a, r) => a + r.precio * r.cantidad, 0);
    for (const r of renglones) if (r.retiro) { r.precio = -montoDescuentoRetiro(sub); r.origen = "calculado"; }
  }
  for (const r of renglones) delete r.retiro;
  return conciliar(renglones, total);
}

// Líneas crudas de un pedido de TN, con el envío como ítem "Envío" (misma fórmula que el panel).
export function lineasCrudasTN(data) {
  const lineas = Array.isArray(data?.products) ? [...data.products] : [];
  const envio = calcularEnvioTN(data);
  if (envio > 0) lineas.push({ name: "Envío", price: envio, quantity: 1 });
  return lineas;
}

// Pedido de TN sin editar: todo sale del pedido crudo. Productos con su precio unitario real,
// el envío (calcularEnvioTN) y los descuentos (cupón y medio de pago). Si TN informa algo que no
// cierra contra el total, la vista previa lo muestra como diferencia.
export function renglonesDeTN(data) {
  const renglones = (Array.isArray(data?.products) ? data.products : []).map((pr) => {
    const r = { nombre: String(pr.name || "").trim(), cantidad: Number(pr.quantity) || 1, precio: Number(pr.price) || 0, tipo: "producto", origen: "tn" };
    const codigo = codigoTN(pr.variant_id, pr.sku);
    if (codigo) r.codigo = codigo;
    return r;
  });
  const envio = calcularEnvioTN(data);
  if (envio > 0) renglones.push({ nombre: "Envío", cantidad: 1, precio: envio, tipo: "envio", origen: "tn" });
  const cupon = Number(data?.discount) || 0;
  const medioPago = Number(data?.discount_gateway) || 0;
  const codigoCupon = data?.coupon?.[0]?.code;
  if (cupon > 0) renglones.push({ nombre: codigoCupon ? `Descuento cupón ${codigoCupon}` : "Descuento", cantidad: 1, precio: -cupon, tipo: "descuento", origen: "tn" });
  if (medioPago > 0) renglones.push({ nombre: "Descuento por medio de pago", cantidad: 1, precio: -medioPago, tipo: "descuento", origen: "tn" });
  return conciliar(renglones, Number(data?.total) || 0);
}

// ─── Armado para TusFacturas ─────────────────────────────────────────────
// TusFacturas: precio unitario sin IVA con 3 decimales, montos con 2, sin negativos.
// Se trabaja en enteros: unitarios en milésimos de peso, bonificación en centavos.
// Control (el mismo que corren los tests): (Σ cantidad × unitario − bonificación) × 1,21
// redondeado al centavo = total del pedido.
const IVA_X100 = 121;

// División entera con redondeo al par (el que usa TusFacturas: "round half even").
function divPar(num, den) {
  const q = Math.floor(num / den), r = num - q * den;
  if (2 * r > den) return q + 1;
  if (2 * r < den) return q;
  return q % 2 === 0 ? q : q + 1;
}

// Neto (milésimos) → total con IVA (centavos). null si cae justo en el medio (no se usa, para no depender del redondeo).
function totalDeNeto(netoMil) {
  const x = netoMil * IVA_X100;   // centavos × 1000
  if (x % 1000 === 500 || x % 1000 === -500) return null;
  return Math.round(x / 1000);
}

// Control independiente del armado: total que resulta de lo que se le manda a TusFacturas.
export function totalFacturado({ lineas, bonificacion }) {
  const neto = lineas.reduce((a, l) => a + l.cantidad * Math.round(l.precioSinIva * 1000), 0) - Math.round(bonificacion * 100) * 10;
  return deCentavos(Math.round(neto * IVA_X100 / 1000));
}

// renglones (que cierran contra total) → { lineas: [{ cantidad, codigo, descripcion, precioSinIva }], bonificacion }.
// Los unitarios se redondean al milésimo y los descuentos van a la bonificación. Los centavos que
// mueve el redondeo se absorben en la bonificación o, si hace falta, en un milésimo del unitario
// de un renglón (primero el envío, después el de menor cantidad), para que el total dé exacto.
export function detalleTusFacturas(renglones, total, separado = false) {
  const totalC = aCentavos(total);
  const items = renglones.filter((r) => r.tipo !== "descuento");
  const descuentoC = -renglones.filter((r) => r.tipo === "descuento").reduce((a, r) => a + aCentavos(r.precio) * r.cantidad, 0);
  if (!items.length || totalC <= 0) return null;
  const pu = items.map((r) => divPar(aCentavos(r.precio) * 1000, IVA_X100));   // milésimos sin IVA: centavos × 1000 / 121
  const S = items.reduce((a, r, i) => a + r.cantidad * pu[i], 0);
  const bObjetivo = divPar(descuentoC * 100, IVA_X100);   // centavos sin IVA
  // Netos (milésimos) que dan exactamente el total.
  const base = divPar(totalC * 1000, IVA_X100);
  const ventana = [];
  for (let m = base - 12; m <= base + 12; m++) if (totalDeNeto(m) === totalC) ventana.push(m);
  // Orden de los renglones que pueden absorber un milésimo: envío primero, después menor cantidad.
  const orden = items.map((r, i) => i).sort((a, b) => (items[b].tipo === "envio") - (items[a].tipo === "envio") || items[a].cantidad - items[b].cantidad);
  const buscar = (soloSinBonif) => {
    for (let d = 0; d <= 50; d++) {   // hasta 5 centavos por unidad (sin IVA): alcanza siempre que haya un renglón de cantidad chica
      for (const delta of d === 0 ? [0] : [d, -d]) {
        for (const j of delta === 0 ? [-1] : orden) {
          if (j >= 0 && pu[j] + delta < 0) continue;
          const Sp = S + (j >= 0 ? items[j].cantidad * delta : 0);
          let mejor = null;
          for (const m of ventana) {
            const diff = Sp - m;
            if (diff % 10 !== 0) continue;
            const b = diff / 10;
            if (b < 0 || (soloSinBonif && b !== 0)) continue;
            if (mejor === null || Math.abs(b - bObjetivo) < Math.abs(mejor - bObjetivo)) mejor = b;
          }
          if (mejor !== null) return { j, delta, b: mejor };
        }
      }
    }
    return null;
  };
  // Sin descuento, se prefiere no mostrar una bonificación de centavos.
  const ajuste = (descuentoC === 0 && buscar(true)) || buscar(false);
  if (!ajuste) {
    // Todas las cantidades múltiplo de 10 (p. ej. 20 + 30): ningún milésimo llega. Último recurso:
    // una unidad del renglón de menor cantidad va en su propio renglón (mismo producto) y absorbe el ajuste.
    if (separado) return null;
    const j = orden.find((i) => items[i].cantidad > 1);
    if (j === undefined) return null;
    const idx = renglones.indexOf(items[j]);
    const partido = [...renglones.slice(0, idx), { ...items[j], cantidad: items[j].cantidad - 1 }, { ...items[j], cantidad: 1 }, ...renglones.slice(idx + 1)];
    return detalleTusFacturas(partido, total, true);
  }
  if (ajuste.j >= 0) pu[ajuste.j] += ajuste.delta;
  return {
    lineas: items.map((r, i) => ({ cantidad: r.cantidad, codigo: codigoRenglon(r), descripcion: r.nombre.slice(0, 200), precioSinIva: pu[i] / 1000 })),
    bonificacion: ajuste.b / 100,
  };
}

// Último recurso ("Facturar en un renglón"): un solo renglón por el total, con las cantidades en la descripción.
export function renglonUnico(productos, total) {
  const descripcion = String(productos || "").split(", ").filter(Boolean).join(", ").slice(0, 200) || "Venta";
  return [{ nombre: descripcion, cantidad: 1, precio: Number(total), tipo: "producto", codigo: "VENTA" }];
}
