// ─────────────────────────────────────────────────────────────────────
//  Routes/mailCliente.js  ·  Mail AL CLIENTE con su propuesta (cotizador de regalos y de eventos)
//
//  Flujo en dos pasos (el PDF lleva el N° de propuesta, que recién existe al guardar):
//    1) POST /propuesta (o /cotizaciones) guarda el lead y devuelve { id, tokenPdf }.
//    2) El navegador arma el PDF con el N° y lo manda a POST …/:id/pdf con ese token (un solo uso).
//       Ahí sale el mail con el PDF adjunto. Si el PDF no llega en ESPERA_PDF_MS (se cerró la página,
//       falló la red), el mail sale igual, sin adjunto. Si el PDF no es válido, también sale sin adjunto.
//  El resultado queda en el lead (opciones.mailCliente) y se ve en Ventas a realizar. Un error al mandar
//  NUNCA afecta la propuesta guardada ni el mail interno.
//  HTML de mail: tablas + estilos en línea (Gmail / Outlook), ancho máx. 600 px y 100 % en celular.
// ─────────────────────────────────────────────────────────────────────
import crypto from "crypto";

export const WA_CORPORATIVO = "5491162393921";
export const MAIL_EQUIPO = "yus@piccadely.com";   // Reply-To: el mail que hoy recibe las notificaciones internas
export const MAX_PDF_BYTES = 5 * 1024 * 1024;
export const ESPERA_PDF_MS = 60 * 1000;
const LOGO_URL = "https://cotizador.piccadely.com/Piccadely_Logotipo_Izquierda_Negro.png";
const TEXTO_ENVIO = "No incluye costo de envío. El costo de envío se calcula de acuerdo a las áreas de entrega.";
const C = { naranja: "#F68B32", naranjaHondo: "#D96E14", tinta: "#2B1D14", tinta2: "#6B5A4E", linea: "#E8DFD7", fondo: "#F7F3EF", ok: "#3F7F39" };
const FUENTE = "Figtree,'Segoe UI',Helvetica,Arial,sans-serif";
const FUENTE_TIT = "'Bricolage Grotesque',Figtree,'Segoe UI',Helvetica,Arial,sans-serif";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pesos = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("es-AR");
const ddmm = (iso) => (iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}` : "");
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const mesDe = (iso) => `${MESES[Number(String(iso).slice(5, 7)) - 1]} ${String(iso).slice(0, 4)}`;

// ── PDF adjunto: data URI o base64 → Buffer, solo si es un PDF real (magic bytes %PDF) de menos de 5 MB ──
export function pdfValido(entrada) {
  if (typeof entrada !== "string" || !entrada) return null;
  const i = entrada.indexOf("base64,");
  const b64 = (i >= 0 ? entrada.slice(i + 7) : entrada).replace(/\s+/g, "");
  if (!b64 || b64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 5 || buf.length > MAX_PDF_BYTES) return null;
  return buf.subarray(0, 4).toString("latin1") === "%PDF" ? buf : null;
}

// ── Espera del PDF (paso 2). Un token por propuesta, de un solo uso; a los `esperaMs` sale sin adjunto. ──
// `enviar(id, datos, adjunto, motivoSinAdjunto)` manda el mail y devuelve { enviado, adjunto, error }.
export function crearEsperaPdf({ enviar, esperaMs = ESPERA_PDF_MS }) {
  const pendientes = new Map();   // id → { token, timer, datos }
  const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); };
  return {
    programar(id, datos) {
      const token = crypto.randomBytes(24).toString("hex");
      const timer = setTimeout(() => {
        pendientes.delete(String(id));
        Promise.resolve(enviar(id, datos, null, "no llegó el PDF a tiempo")).catch((e) => console.error("Mail al cliente: error en el envío sin PDF:", e.message));
      }, esperaMs);
      timer.unref?.();
      pendientes.set(String(id), { token, timer, datos });
      return token;
    },
    // null = no hay nada pendiente con ese id y token (ya se mandó, venció o el token no es)
    async conPdf(id, token, pdf) {
      const p = pendientes.get(String(id));
      if (!p || !igual(p.token, token)) return null;
      clearTimeout(p.timer); pendientes.delete(String(id));
      const adjunto = pdfValido(pdf);
      return enviar(id, p.datos, adjunto, adjunto ? null : "el PDF no es válido o pesa más de 5 MB");
    },
    pendientes: () => pendientes.size,
  };
}

// ── Envío + registro en el lead ──
export async function registrarMailCliente(pool, id, resultado) {
  try {
    await pool.query(
      `UPDATE cotizaciones SET opciones = opciones || jsonb_build_object('mailCliente', $2::jsonb)
       WHERE id = $1 AND jsonb_typeof(opciones) = 'object'`, [id, JSON.stringify(resultado)]);
  } catch (e) { console.error(`Mail al cliente: no se pudo registrar el resultado en la propuesta #${id}:`, e.message); }
}
export async function enviarMailCliente({ mailTransporter, pool, id, to, mail, adjunto, nombrePdf, motivoSinAdjunto }) {
  const resultado = { enviado: false, adjunto: !!adjunto, email: to, fecha: new Date().toISOString(), error: null, ...(motivoSinAdjunto ? { sinAdjunto: motivoSinAdjunto } : {}) };
  try {
    if (!mailTransporter) throw new Error("SMTP no configurado");
    await mailTransporter.sendMail({
      from: `Piccadely <${process.env.GMAIL_USER}>`, to, replyTo: MAIL_EQUIPO,
      subject: mail.asunto, html: mail.html, text: mail.texto,
      attachments: adjunto ? [{ filename: nombrePdf, content: adjunto, contentType: "application/pdf" }] : [],
    });
    resultado.enviado = true;
    console.log(`Mail al cliente: propuesta #${id} enviada${adjunto ? " con PDF" : " sin PDF"}${motivoSinAdjunto ? ` (${motivoSinAdjunto})` : ""}.`);
  } catch (e) {
    resultado.error = String(e.message || e).slice(0, 300);
    console.error(`Mail al cliente: falló el envío de la propuesta #${id}:`, resultado.error);
  }
  await registrarMailCliente(pool, id, resultado);
  return resultado;
}

// ── Plantilla común (marca) ──
const fila = (izq, der, { negrita = false, color = C.tinta, tam = 15, borde = true } = {}) =>
  `<tr><td style="padding:8px 0;${borde ? `border-bottom:1px solid ${C.linea};` : ""}font-family:${FUENTE};font-size:${tam}px;line-height:1.4;color:${color};${negrita ? "font-weight:700;" : ""}">${izq}</td>
   <td align="right" style="padding:8px 0 8px 12px;${borde ? `border-bottom:1px solid ${C.linea};` : ""}font-family:${FUENTE};font-size:${tam}px;line-height:1.4;color:${color};white-space:nowrap;${negrita ? "font-weight:700;" : ""}">${der}</td></tr>`;
const tabla = (filas) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${filas}</table>`;
const subtitulo = (t) => `<p style="margin:22px 0 6px;font-family:${FUENTE_TIT};font-size:18px;font-weight:700;color:${C.tinta}">${t}</p>`;
const parrafo = (t, extra = "") => `<p style="margin:0 0 12px;font-family:${FUENTE};font-size:15px;line-height:1.5;color:${C.tinta};${extra}">${t}</p>`;
const avisoEnvio = () => `<p style="margin:14px 0 0;padding:12px 14px;border:2px solid ${C.naranja};border-radius:10px;background:#FDEBDB;font-family:${FUENTE};font-size:14px;line-height:1.45;color:${C.tinta}"><strong style="color:${C.naranjaHondo}">No incluye costo de envío.</strong> El costo de envío se calcula de acuerdo a las áreas de entrega.</p>`;

function plantilla({ titulo, numero, saludo, cuerpo, waTexto, tarjetaPropia, preheader }) {
  const wa = `https://wa.me/${WA_CORPORATIVO}?text=${encodeURIComponent(waTexto)}`;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:${C.fondo};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.fondo}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.fondo}" style="background:${C.fondo}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#FFFFFF;border-radius:16px;overflow:hidden">
  <tr><td style="padding:22px 28px 18px"><img src="${LOGO_URL}" width="122" height="36" alt="Piccadely" style="display:block;border:0;width:122px;height:36px"></td></tr>
  <tr><td bgcolor="${C.naranja}" style="background:${C.naranja};padding:18px 28px">
    <p style="margin:0;font-family:${FUENTE_TIT};font-size:24px;line-height:1.2;font-weight:800;color:#FFFFFF">${esc(titulo)}</p>
    <p style="margin:4px 0 0;font-family:${FUENTE};font-size:14px;color:#FFFFFF">Propuesta N° ${esc(numero)}</p>
  </td></tr>
  <tr><td style="padding:24px 28px 8px">
    ${parrafo(saludo, "font-size:17px;font-weight:600")}
    ${cuerpo}
    ${tarjetaPropia ? parrafo(`<strong>Tu tarjeta personal:</strong> respondé este mail con el diseño de tu tarjeta y la imprimimos sin cargo.`, `margin-top:18px;padding:12px 14px;background:${C.fondo};border-radius:10px`) : ""}
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto 10px"><tr>
      <td align="center" bgcolor="${C.naranja}" style="background:${C.naranja};border-radius:12px">
        <a href="${esc(wa)}" target="_blank" style="display:inline-block;padding:16px 34px;font-family:${FUENTE};font-size:17px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:12px">Confirmar por WhatsApp</a>
      </td></tr></table>
    ${parrafo("Respondé este mail si querés ajustar algo.", `text-align:center;color:${C.tinta2};font-size:14px`)}
  </td></tr>
  <tr><td bgcolor="${C.fondo}" style="background:${C.fondo};padding:16px 28px;font-family:${FUENTE};font-size:12px;line-height:1.5;color:${C.tinta2}">
    Piccadely · Regalos y eventos corporativos<br>Corporativo: 11 6239-3921 · corporativo@piccadely.com
  </td></tr>
</table></td></tr></table></body></html>`;
}
const saludoDe = (nombre, empresa, que) => `¡Hola ${esc(String(nombre || "").trim().split(/\s+/)[0] || "")}! Acá está ${que}${empresa ? ` para ${esc(empresa)}` : ""}.`;

// ── Regalos (una entrega) y calendario anual ──
const nombreLinea = (l) => `${l.opcion && !l.digital && l.opcion !== l.nombre ? esc(l.opcion) + " · " : ""}${esc(l.nombre)}${(l.variante_mostrar || l.variante) ? ` (${esc(l.variante_mostrar || l.variante)})` : ""}${l.extra ? " · bebida" : ""}${l.enCajaRegalo ? " · 🎁 en caja de regalo" : ""}`;
const lineasRegalos = (lineas) => lineas.map((l) => fila(`${l.cantidad} × ${nombreLinea(l)}`, pesos(l.subtotal))).join("");
const totales = (c, anual) => [
  fila(anual ? "Regalos del año" : "Regalos", pesos(c.subtotalRegalos), { borde: false }),
  c.subtotalBebidas ? fila("Bebidas", pesos(c.subtotalBebidas), { borde: false }) : "",
  c.descuento ? fila(`Descuento por volumen${anual ? " anual" : ""} (${c.tramo?.pct}%)`, "−" + pesos(c.descuento), { color: C.ok, borde: false }) : "",
  fila(anual ? "Total anual sin envío" : "Total sin envío", pesos(c.total), { negrita: true, tam: 19, borde: false }),
  c.porRegalo ? fila("", `${pesos(c.porRegalo)} por regalo`, { color: C.tinta2, tam: 13, borde: false }) : "",
].join("");

export function mailPropuestaRegalos({ id, lead, calculo: c }) {
  const empresa = lead.empresa || "";
  if (c.fechas) {   // calendario anual
    const anios = [...new Set(c.fechas.map((f) => String(f.fecha || "").slice(0, 4)).filter(Boolean))].sort();
    const anio = anios.length ? (anios.length === 1 ? anios[0] : `${anios[0]}-${anios[anios.length - 1]}`) : "";
    const porMes = new Map();
    for (const f of c.fechas) { const m = mesDe(f.fecha); if (!porMes.has(m)) porMes.set(m, []); porMes.get(m).push(f); }
    const cuerpo = [
      parrafo(`<strong>${c.cantidadFechas} ${c.cantidadFechas === 1 ? "fecha" : "fechas"} · ${c.regalos} regalos en el año</strong>`),
      ...[...porMes].map(([mes, fs]) => subtitulo(esc(mes.charAt(0).toUpperCase() + mes.slice(1))) + tabla(fs.map((f) =>
        fila(`<strong>${ddmm(f.fecha)} · ${esc(f.ocasionTexto || f.ocasion || "")}${f.aQuien ? " · " + esc(f.aQuien) : ""}</strong><br>
          <span style="font-size:13px;color:${C.tinta2}">${f.lineas.map((l) => `${l.cantidad} × ${nombreLinea(l)}`).join("<br>")}</span>`, pesos(f.subtotal))).join(""))),
      `<div style="height:10px"></div>`, tabla(totales(c, true)),
      parrafo(`🔒 <strong>Precio congelado.</strong> ${esc(c.condicion || "Pagando el año por adelantado, te congelamos los precios de hoy.")}`, "margin-top:16px"),
      parrafo(`<strong>Propuesta válida hasta el ${ddmm(c.validaHasta)}.</strong>`),
      avisoEnvio(),
    ].join("");
    return {
      asunto: `Tu calendario de regalos ${anio} · Piccadely`.replace("  ", " "),
      html: plantilla({ titulo: `Tu calendario de regalos${anio ? " " + anio : ""}`, numero: id, saludo: saludoDe(lead.cliente_nombre, empresa, "tu calendario de regalos"), cuerpo,
        waTexto: `¡Hola! Quiero confirmar el calendario anual de regalos, propuesta N° #${id}${empresa ? ` (${empresa})` : ""}.`, tarjetaPropia: lead.tarjetaPropia,
        preheader: `${c.cantidadFechas} fechas · ${c.regalos} regalos · total anual ${pesos(c.total)} sin envío` }),
      texto: textoPlano(`Tu calendario de regalos · Propuesta N° ${id}`, lead, `${c.cantidadFechas} fechas · ${c.regalos} regalos en el año\nTotal anual sin envío: ${pesos(c.total)}\nPropuesta válida hasta el ${ddmm(c.validaHasta)}.\n${TEXTO_ENVIO}`, id, "el calendario anual de regalos"),
    };
  }
  const ent = c.envioDetalle || {};
  const entrega = ent.modo === "varios" ? `Cada uno a su casa (${ent.nCaba || 0} en CABA, ${ent.nGba || 0} en GBA)` : ent.zona ? `Todos a un mismo lugar (${esc(ent.zona)}${lead.direccion ? " · " + esc(lead.direccion) : ""})` : "";
  const cuerpo = [
    parrafo(`<strong>${c.regalos} ${c.regalos === 1 ? "regalo" : "regalos"}</strong>${lead.fecha ? ` · entrega ${ddmm(lead.fecha)}` : ""}${entrega ? `<br><span style="color:${C.tinta2};font-size:14px">${entrega}</span>` : ""}`),
    tabla(lineasRegalos(c.lineas)), `<div style="height:10px"></div>`, tabla(totales(c, false)), avisoEnvio(),
  ].join("");
  return {
    asunto: "Tu propuesta de regalos · Piccadely",
    html: plantilla({ titulo: "Tu propuesta de regalos", numero: id, saludo: saludoDe(lead.cliente_nombre, empresa, "la propuesta"), cuerpo,
      waTexto: `¡Hola! Quiero confirmar la propuesta de regalos N° #${id}${empresa ? ` (${empresa})` : ""}.`, tarjetaPropia: lead.tarjetaPropia,
      preheader: `${c.regalos} regalos · total ${pesos(c.total)} sin envío` }),
    texto: textoPlano(`Tu propuesta de regalos · N° ${id}`, lead, `${c.lineas.map((l) => `${l.cantidad} x ${l.nombre}${l.variante ? ` (${l.variante})` : ""}${l.enCajaRegalo ? " · en caja de regalo" : ""} · ${pesos(l.subtotal)}`).join("\n")}\n${c.descuento ? `Descuento por volumen (${c.tramo?.pct}%): -${pesos(c.descuento)}\n` : ""}Total sin envío: ${pesos(c.total)}\n${TEXTO_ENVIO}`, id, "la propuesta de regalos"),
  };
}

// ── Cotizador de eventos (la opción elegida) ──
export function mailPropuestaEventos({ id, cot }) {
  const ops = Array.isArray(cot.opciones) ? cot.opciones : [];
  const op = ops.find((o) => o.nivel === cot.nivel_elegido) || null;
  const items = op ? [...(op.piccadas || []), ...(op.sandwiches || []), ...(op.vegetarianas || [])] : [];
  const datos = [`${cot.personas} personas`, cot.modo === "comer" ? "comen" : cot.modo === "piccar" ? "piccan" : "", cot.fecha_evento ? `📅 ${ddmm(cot.fecha_evento)}` : "", cot.zona ? `📍 ${esc(cot.zona)}` : ""].filter(Boolean).join(" · ");
  const cuerpo = [
    parrafo(`<strong>${datos}</strong>`),
    op ? subtitulo(`Opción ${esc(op.etiqueta || op.nivel)}`) : "",
    tabla(items.map((i) => fila(`${i.cantidad} × ${esc(i.nombre)}${i.tamano ? ` <span style="color:${C.tinta2}">(${esc(i.tamano)})</span>` : ""}`, pesos(i.subtotal ?? (i.precioUnitario || 0) * (i.cantidad || 0)))).join("")),
    `<div style="height:10px"></div>`,
    tabla(fila("Total sin envío", pesos(cot.total_elegido ?? op?.total), { negrita: true, tam: 19, borde: false }) + (op?.porPersona ? fila("", `${pesos(op.porPersona)} por persona`, { color: C.tinta2, tam: 13, borde: false }) : "")),
    cot.con_bebidas ? parrafo("🥤 Pediste sumar bebidas: un asesor te las cotiza según lo que prefieras.", "margin-top:12px") : "",
    avisoEnvio(),
  ].join("");
  return {
    asunto: "Tu propuesta para tu evento · Piccadely",
    html: plantilla({ titulo: "Tu propuesta para tu evento", numero: id, saludo: saludoDe(cot.cliente_nombre, cot.empresa, "la propuesta"), cuerpo,
      waTexto: `¡Hola! Quiero confirmar la propuesta de evento N° #${id}${op ? ` (opción ${op.etiqueta || op.nivel})` : ""}.`, tarjetaPropia: false,
      preheader: `${cot.personas} personas · total ${pesos(cot.total_elegido ?? op?.total)} sin envío` }),
    texto: textoPlano(`Tu propuesta para tu evento · N° ${id}`, { cliente_nombre: cot.cliente_nombre, empresa: cot.empresa }, `${items.map((i) => `${i.cantidad} x ${i.nombre}${i.tamano ? ` (${i.tamano})` : ""}`).join("\n")}\nTotal sin envío: ${pesos(cot.total_elegido ?? op?.total)}\n${TEXTO_ENVIO}`, id, "la propuesta de evento"),
  };
}

// Versión de texto plano (clientes de mail sin HTML y filtros de spam).
function textoPlano(titulo, lead, detalle, id, que) {
  return `${titulo}\n\n¡Hola ${String(lead.cliente_nombre || "").trim().split(/\s+/)[0] || ""}! Acá está ${que}${lead.empresa ? ` para ${lead.empresa}` : ""}.\n\n${detalle}\n\n` +
    `Confirmar por WhatsApp: https://wa.me/${WA_CORPORATIVO}?text=${encodeURIComponent(`¡Hola! Quiero confirmar la propuesta N° #${id}.`)}\nRespondé este mail si querés ajustar algo.\n\nPiccadely · Corporativo: 11 6239-3921 · corporativo@piccadely.com`;
}
