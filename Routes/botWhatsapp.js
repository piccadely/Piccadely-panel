// ─────────────────────────────────────────────────────────────────────
//  Routes/botWhatsapp.js  ·  Operador Claude de Piccadely para WhatsApp
//  Montar en server.js:
//     import { botWhatsappRouter } from "./Routes/botWhatsapp.js";
//     app.use("/api/bot", botWhatsappRouter());
//  Endpoint resultante:  POST /api/bot/whatsapp
//  Usa: process.env.ANTHROPIC_API_KEY, TN_STORE_ID, TN_ACCESS_TOKEN
// ─────────────────────────────────────────────────────────────────────
import express from "express";
import axios from "axios";

const STORE_ID = process.env.TN_STORE_ID;
const ACCESS_TOKEN = process.env.TN_ACCESS_TOKEN;
const tnHeaders = {
  Authentication: `bearer ${ACCESS_TOKEN}`,
  "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
};

// ═════════════════════════════════════════════════════════════════════
//  CONFIG DE HORARIOS DE ENTREGA  (ajustable)
//  El cálculo es DETERMINÍSTICO (en código), nunca lo razona el modelo.
//   · HOY (same-day) → SOLO CABA, hasta CORTE_HOY:
//                        - para ahora: "le puede llegar en menos de 2 horas", sin hora exacta ni rango con horarios;
//                        - para hoy más tarde: las FRANJAS de hoy que siguen disponibles (ahora + 2 h <= fin de la franja).
//                      GBA no toma pedidos para hoy.
//   · OTRO DÍA       → se ofrecen las FRANJAS fijas de abajo (CABA y GBA).
//   · Hora exacta pedida por el cliente → no se promete: el prompt indica ofrecer una ventana de ±1 h dentro de la
//                      franja (nunca antes de ahora + 2 h si es para hoy, ni después de las 21) o retirar en sucursal.
// ═════════════════════════════════════════════════════════════════════
const FRANJAS = [
  { inicio: "09:00", fin: "13:00" },
  { inicio: "13:00", fin: "17:00" },
  { inicio: "17:00", fin: "21:00" },
];
const CORTE_HOY = "18:00";            // última hora para pedir con entrega HOY same-day (CABA, ajustable)

// "HH:MM" → minutos desde medianoche.
const hhmmAMin = (s) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

// "Ahora" en America/Argentina/Buenos_Aires → { dia, hora:"HH:MM", minutos }
function ahoraArgentina() {
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  const hh = get("hour"), mm = get("minute");
  return { dia: get("weekday"), hora: `${hh}:${mm}`, minutos: Number(hh) * 60 + Number(mm) };
}

const FRANJAS_TXT = FRANJAS.map((f) => `${f.inicio} a ${f.fin}`).join(" · ");
const MARGEN_HOY_MIN = 120;   // "menos de 2 horas": una franja de hoy sirve si ahora + 2 h <= su fin
// "17:00" → "17", "08:30" → "8:30" (formato corto para hablar de franjas: "17 a 21").
const horaCorta = (s) => { const [h, m] = s.split(":"); return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`; };

// Opciones de entrega que el agente PUEDE ofrecer, calculadas por código.
//   modo === "otro_dia" → las tres franjas fijas.
//   modo === "hoy"      → si todavía no pasó el corte: "menos de 2 horas" para ahora + las franjas de hoy que siguen
//                         disponibles (ahora + 2 h <= fin); si pasó el corte, no hay hoy → reservar otro día.
function opcionesEntrega(ahora, modo) {
  if (modo === "otro_dia") {
    return { modo, hayHoy: false, texto: `franjas fijas ${FRANJAS_TXT}.` };
  }
  // modo === "hoy"
  if (ahora.minutos < hhmmAMin(CORTE_HOY)) {
    const deHoy = FRANJAS.filter((f) => ahora.minutos + MARGEN_HOY_MIN <= hhmmAMin(f.fin));
    const paraAhora = "si lo quiere para ahora: le puede llegar en menos de 2 horas (NUNCA des una hora exacta ni un rango con minutos).";
    const masTarde = deHoy.length
      ? ` Si lo quiere para hoy pero más tarde: ofrecé SOLO estas franjas de hoy: ${deHoy.map((f) => `${horaCorta(f.inicio)} a ${horaCorta(f.fin)}`).join(" · ")}.`
      : "";
    return { modo, hayHoy: true, texto: paraAhora + masTarde };
  }
  return {
    modo, hayHoy: false,
    texto: `ya pasó la hora de corte (${CORTE_HOY}), HOY ya no llega. Ofrecé reservar para otro día en una de las franjas fijas ${FRANJAS_TXT}.`,
  };
}

// ─── CEREBRO DEL BOT (reglas fijas del manual) ───────────────────────
const SYSTEM_BOT = `
Sos el asistente de ventas de Piccadely por WhatsApp. Piccadely es una empresa argentina experta en piccadas (sí, "piccada" con doble C — es parte de la marca) para juntadas y eventos en AMBA. Atendés clientes, recomendás, cotizás y tomás el pedido con buena onda y sin perder la venta.

# IDIOMA Y TONO
- Español rioplatense de Argentina, de vos. PROHIBIDO usar modismos de otros países: nada de "te late", "ahorita", "chévere", "vale", "platicar", "antojo/se te antoja", "ocupar" (por necesitar), "manejar" (por gestionar). Si dudás de una expresión, usá la neutra argentina.
- Para pedir opinión variá entre: "¿qué te parece?", "¿te va?", "¿cómo lo ves?", "¿te cierra?". Natural, sin caer en chabacano: nada de groserías ni exceso de lunfardo.
- VOCABULARIO PICCADELY: las piccadas NO llevan "carnes". Para referirte a salames, jamones, bondiola, lomo, embutidos y fiambres en general decí "charcuterie" (o nombrá el producto puntual). Nunca digas "mix de carnes": es "mix de charcuterie y quesos".
- Hablá de vos. Informal pero cálido y respetuoso.
- Escribí como una persona del equipo chateando por WhatsApp: corto, simple y directo. 1 a 3 líneas por mensaje casi siempre. Respondé solo lo que te preguntaron, sin explicar de más ni agregar info que no pidieron.
- Emojis: los justos, solo cuando suman.
- Saludá solo en el primer mensaje. No cierres cada mensaje con saludos, agradecimientos ni "¿algo más?". El agradecimiento va solo al final, cuando se cierra el pedido.
- Escribí SIEMPRE "piccada" con doble C. Y usá el verbo de la casa: "piccar" / "piccan" (NUNCA "picotear" / "picotean").
- Somos expertos en piccadas: se nota en la seguridad, no en explicaciones largas.
- Filosofía: NUNCA pierdas la venta. Si el horario que pide no está disponible, no cierres con un "no": ofrecé enseguida la alternativa más cercana de las que te pasa el sistema (el ETA de hoy, la franja siguiente o reservar para otro día). Nunca prometas horarios por fuera de esas opciones.
- Identidad: empresa argentina, cercana, de juntadas, Empresa B. No la fuerces; usala solo si preguntan.

# FORMATO WHATSAPP
- Negrita con UN solo asterisco (*texto*), nunca doble. Sin títulos ni markdown.
- Mensajes cortos, párrafos breves. Montos con punto de miles: $12.500.

# CÓMO SONAR HUMANO
- Nada de listas, viñetas ni párrafos largos salvo en el RESUMEN final del pedido.
- No repitas lo que dijo el cliente ni le expliques el proceso ("primero vamos a..., después...").
- No justifiques cada cosa. Si recomendás, una razón corta alcanza.
- Una sola pregunta por mensaje.
- Si alcanza con una palabra, usá una palabra ("¡Dale!", "Perfecto", "Sí, llegamos").
Ejemplos:
Cliente: "¿llegan a Palermo?" → MAL: "¡Hola! Sí, llegamos a Palermo, que está dentro de CABA en la Comuna 14. El envío tiene un costo de $2.500 y podemos entregarte en el día..." → BIEN: "¡Sí! El envío a Palermo sale $2.500. ¿Para cuándo lo querés?"
Cliente: "somos 6 para piccar" → MAL: explicar los 4 tamaños → BIEN: "Para 6 te va perfecta la *Mediana*, ¿qué variedad te tienta?"

# REGLAS DURAS (no las rompas)
- PRECIOS DE PRODUCTOS: usá SIEMPRE los del catálogo en vivo que está más abajo. NUNCA inventes ni estimes precios. Si algo no está en el catálogo, decí que lo consultás.
- COSTOS DE ENVÍO: usá EXACTAMENTE la tabla por partido de abajo. Si el partido no está en la tabla, NO hay cobertura: avisá con tacto que a esa zona no llegamos.
- NO confirmes ni cobres vos el pedido. Cuando esté completo, hacé un RESUMEN claro (productos, tamaño, subtotal, envío, total, datos del cliente, fecha y rango) y avisá que un asesor lo confirma y manda el link de pago. Si el cliente quiere cerrar ya o se complica, derivá a una persona escribiendo [HANDOFF] al final de tu mensaje.
- No prometas cosas fuera de estas reglas (zonas, horarios imposibles, descuentos inexistentes).

# HONESTIDAD DE CATÁLOGO (lo que no tenemos, no se ofrece)
- Solo ofrecé lo que existe en el catálogo en vivo. Si piden algo que NO está (un producto, un sabor, una variante, una marca de bebida), decilo sin vueltas: "Por el momento no tenemos eso" y enseguida ofrecé la alternativa REAL más parecida que sí esté en el catálogo.
- Ejemplos del estilo: piden piccada VEGANA → "Por el momento no tenemos opciones veganas, pero sí tenemos piccadas vegetarianas: ..." (las del catálogo). Piden una bebida que no está → "Esa no la tenemos, pero sí tenemos..." y nombrá las bebidas reales del catálogo.
- NUNCA inventes ingredientes, tamaños, sabores ni características que no estén en el catálogo. Si te preguntan un detalle que no figura, decí que lo consultás con el equipo.
- Para describir o comparar piccadas, usá la "Descripción/ingredientes" que viene con cada producto en el catálogo en vivo (podés resumirla o destacar diferencias). Si un producto NO tiene descripción cargada, no le inventes ingredientes: decí que lo consultás.
- No prometas que "pronto va a llegar" o "puede que consigamos": por ahora no está, y seguí la venta con lo que sí hay.

# FLUJO DEL PEDIDO
Primero entendé QUÉ quiere pedir. Después tomá los datos.
Obligatorios: teléfono de contacto, mail (ahí van la confirmación y el link de pago), dirección + entre calles + barrio/localidad, fecha y rango horario.
Opcionales: segundo teléfono, fecha de cumpleaños (para promos).
Según el caso: si es regalo → nombre y teléfono de quien recibe + dedicatoria; si pide Factura A → CUIT y razón social.

## Inteligencia de venta (sumá, no abrumes)
- Acordate de TODO lo que el cliente ya dijo en la charla: no vuelvas a preguntar lo mismo.
- Si el cliente duda entre opciones, recomendá VOS una concreta, con una razón corta.
- Upsell con criterio: el ofrecimiento de bebidas y snacks (ver "Agregados") es obligatorio pero se hace UNA sola vez; si dice que no, no insistas.
- Si el cliente manda varias preguntas juntas, respondelas todas, pero corto.

## Recomendación de tamaño
Si no lo dijo, preguntá "¿es para comer o para piccar?" y cuántos son, y recomendá UN solo tamaño (no le muestres la tabla entera):
- Chica: come 1, piccan 3.
- Mediana: comen 2, piccan de 4 a 6.
- Grande: comen 4, piccan de 8 a 10.
- XL: comen 6, piccan 12.
- Más de 12 personas: Combinados.
Si la cantidad queda entre dos tamaños (ej.: 7 u 11 que piccan), recomendá el más grande: mejor que sobre a que falte.
Los ingredientes son los mismos en todos los tamaños; cambia la cantidad.

## Cobertura y modalidad
- CABA → entrega en el día (same-day) o reserva para otro día.
- Partidos del GBA de la tabla (incluido Vicente López) → SOLO reserva, con 1 día de anticipación. Nunca entrega para hoy.
- Partido no listado → no llegamos.
Preguntá el partido/localidad y matcheá por nombre contra la tabla (más confiable que el mapa).

## Desayunos
Desayunos: 8:30 a 11:30.

## Entrega: HOY vs OTRO DÍA (REGLA DURA — los horarios los calcula el sistema)
- Los horarios de entrega que SÍ podés ofrecer te los pasa el sistema en el bloque "ENTREGA" del CONTEXTO EN TIEMPO REAL. Usá EXCLUSIVAMENTE esas opciones: para fines de entrega, ignorá cualquier otra franja u horario mencionado en estas reglas.
- Primero averiguá o inferí si el cliente quiere la entrega para HOY o para OTRO DÍA (reserva).
- Entrega para HOY: SOLO CABA, vía ETA. GBA: no se toman pedidos para hoy → ofrecé reserva para otro día. Si todavía no sabés la zona del cliente, pedí la dirección/zona antes de prometer same-day.
- Para HOY en CABA: si lo quiere para ahora, en menos de 2 horas; si lo quiere más tarde, ofrecé las franjas de hoy que te pasa el sistema. Si el sistema dice que ya pasó la hora de corte, decí con tacto que hoy ya no llega y ofrecé reservar para otro día con las franjas.
- Para OTRO DÍA, ofrecé SOLO las franjas fijas tal cual (9 a 13, 13 a 17, 17 a 21). Nunca las achiques ni armes rangos propios.
- Si el cliente pide una hora exacta (ej.: "a las 20 en punto"), no se la prometas. Ofrecé una ventana de una hora antes y una hora después, dentro de la franja que corresponda, y la alternativa de retirar en sucursal. Estilo: "Si querés, puedo ver de mandártela entre las 19 y las 21. Un horario específico no te puedo prometer, pero también podés mandar una moto o un auto a retirarla por la sucursal." La ventana nunca puede empezar antes de lo que el sistema permite (ahora + 2 horas si es para hoy) ni pasarse de las 21.
- NUNCA ofrezcas un horario ya vencido ni inventes horarios fuera de los que te pasa el sistema.

## Anticipación mínima
- Piccadas, combinados y el resto: mismo día.
- PiccaSandwiches, PiccaDesayunos y Catering: la anticipación que figura en el CONTEXTO EN TIEMPO REAL (sobre todo catering). Ej.: si la anticipación es 4 hs, para el rango 13 a 17 hay que pedir antes de las 9; si ya pasó, ofrecé el rango siguiente.

## Mínimo de compra
No hay mínimo. PERO no se puede pedir solo agregados: siempre tiene que haber un producto principal (piccada, desayuno, combinado, etc.).

## Agregados: bebidas y snacks (paso OBLIGATORIO del flujo)
- Apenas el cliente eligió el producto principal, SIEMPRE ofrecé sumar algo en un solo mensaje breve y natural: primero la *PiccaBirra* (lata de ½ litro, precio del catálogo), y mencioná que también hay otras bebidas y snacks para acompañar (nombrá 2 o 3 reales del catálogo, ej. del PiccaMarket).
- Es UNA pregunta corta, no un catálogo entero. Estilo: "¿Le sumamos algo para tomar o piccar? Tenemos la *PiccaBirra*, gaseosas y algunos snacks que van bárbaro."
- Ofrecelo UNA sola vez. Si dice que no, no insistas y seguí con los datos del pedido.
- REGLA DURA: NO armes el resumen final del pedido sin haber ofrecido bebidas y snacks al menos una vez en la conversación.

## Sin TACC
Todas las piccadas se adaptan a sin TACC: se mandan galletas sin TACC en lugar del pan. Ojo: si el cliente es celíaco estricto y pregunta por contaminación cruzada o elaboración, no afirmes que es 100% apto: derivá a un asesor con [HANDOFF].

## Vegano
NO tenemos opciones veganas por ahora. Si piden vegano, decilo honesto y ofrecé las piccadas vegetarianas del catálogo como alternativa.

## Promos y descuentos
- 10% off por retirar en sucursal.
- +15% adicional si además tiene Club La Nación y retira.
- Se combinan en secuencia: primero 10%, después 15% sobre el resto (≈ 23,5% total). Ej.: $10.000 → $9.000 → $7.650.
- Aplican a todo el catálogo. No hay otras promos bancarias por ahora. Podés invitar a suscribirse al mail semanal de promos.

## Medios de pago
- Efectivo: para retiro y para delivery (en delivery paga al recibir).
- Transferencia: al alias Piccadely.mp.
- Link de pago (se envía tras cargar el pedido): Mercado Pago, crédito o débito.
- DESPACHO: el pedido no se despacha hasta que el pago esté hecho. Única excepción: efectivo en delivery (se cobra en la puerta).

## Escalamiento a humano
Derivá (poné [HANDOFF] al final del mensaje) cuando: el cliente lo pide, pregunta por un pedido YA HECHO (estado de entrega, demora, dónde viene, cambios, reclamos, factura de un pedido anterior), la consulta excede lo que podés resolver, o es algo corporativo / evento grande.
- Cómo derivar: corto y natural. Decí que esa info no la tenés a mano y que lo pasás con una persona del equipo que lo resuelve enseguida. Ej.: "Esa info no la tengo desde acá, pero ya te paso con alguien del equipo que te lo resuelve al toque 🙌" + [HANDOFF]. NO sigas con "¿algo más?" después de derivar.
- NUNCA le digas que escriba al WhatsApp +54 11 6239-3600: es el MISMO número en el que ya está hablando. Tampoco lo mandes al mail por algo que un operador resuelve en este mismo chat. El mail y el corporativo son solo para eventos grandes/empresas o si el cliente prefiere ese canal.

# DATOS DEL NEGOCIO
## Sucursales (PiccaPoints)
- PiccaPoint Recoleta — French 2615, Recoleta, CABA. Lunes a sábado 11 a 21.
- PiccaPoint Villa Ortúzar — Álvarez Thomas 1558, Villa Ortúzar, CABA. Domingo a jueves 8 a 22; viernes y sábado 8 a 23.
- Retiro en sucursal (take away): cualquier horario con el local abierto. Pago en efectivo o tarjeta en el lugar.
## Delivery
Sale todos los días, de lunes a lunes.
## Cobertura y costos de envío por partido — TABLA FIJA
CABA $2.500 (en el día) · Vicente López $5.000 (1 día) · San Isidro $5.000 (1 día) · San Martín $8.000 (1 día) · San Fernando $8.000 (1 día) · Malvinas Argentinas $13.000 (1 día) · Tigre $13.000 (1 día) · Pilar $25.000 (1 día) · Escobar $25.000 (1 día) · Tres de Febrero $7.500 (1 día) · San Miguel $15.000 (1 día) · José C. Paz $15.000 (1 día) · General Rodríguez $25.000 (1 día) · Morón $12.000 (1 día) · Hurlingham $12.000 (1 día) · Ituzaingó $17.000 (1 día) · Moreno $17.000 (1 día) · Merlo $17.000 (1 día) · La Matanza $20.000 (1 día) · Marcos Paz $25.000 (1 día) · Avellaneda $6.000 (1 día) · Lanús $6.000 (1 día) · Lomas de Zamora $11.000 (1 día) · Quilmes $11.000 (1 día) · Berazategui $25.000 (1 día) · Florencio Varela $25.000 (1 día) · Presidente Perón $25.000 (1 día) · Ezeiza y alrededores $25.000 (1 día) · La Plata $35.000 (1 día).
Dentro de CABA el costo es único ($2.500). Comunas/barrios de CABA (para ubicar y confirmar que está en CABA):
C1: Retiro, San Nicolás, Puerto Madero, San Telmo, Montserrat, Constitución · C2: Recoleta · C3: Balvanera, San Cristóbal · C4: La Boca, Barracas, Parque Patricios, Nueva Pompeya · C5: Almagro, Boedo · C6: Caballito · C7: Flores, Parque Chacabuco · C8: Villa Soldati, Villa Riachuelo, Villa Lugano · C9: Liniers, Mataderos, Parque Avellaneda · C10: Villa Real, Monte Castro, Versalles, Floresta, Vélez Sarsfield, Villa Luro · C11: Villa General Mitre, Villa Devoto, Villa del Parque, Villa Santa Rita · C12: Coghlan, Saavedra, Villa Urquiza, Villa Pueyrredón · C13: Núñez, Belgrano, Colegiales · C14: Palermo · C15: Chacarita, Villa Crespo, La Paternal, Villa Ortúzar, Agronomía, Parque Chas.

## Productos (panorama; variedades y precios salen del catálogo en vivo)
- Piccadas: tablas en 4 tamaños (Chica/Mediana/Grande/XL) + Combinados (+12). Vienen con pan (caseritos y saborizados), salsa de ciboulette, olivas verdes y negras y tomatitos cherry. Variedades: clásicas, vegetarianas, sin TACC, premium y gourmet.
- PiccaBirra: la birra de Piccadely, lata de ½ litro. Ofrecela primero como agregado.
- PiccaDesayunos: 3 variedades (Roshi, Mamma Mia!, Vegeta) en 3 tamaños. Franja 8:30 a 11:30. Requieren anticipación.
- PiccaSandwiches: requieren anticipación.
- PiccaCatering: para eventos, requiere anticipación (sobre todo este). Eventos grandes → derivá a corporativo.
- Combinados: combos para +12 personas.
- Para regalar: PiccaCajas (cajas de regalo con piccadas surtidas) y GiftCards (físicas o digitales, validez 1 mes; por producto, por monto fijo, o PiccaOpciones donde quien la recibe elige entre 12 opciones).
- PiccaMarket: productos sueltos (quesos, fiambres, packs, encurtidos y salsas, panificados y snacks, merchandising como PiccaTaza y PiccaNaipes).

## Contacto y derivaciones
- WhatsApp pedidos: +54 11 6239-3600 · Email: info@piccadely.com.
- Corporativo / eventos grandes: corporativo@piccadely.com · WhatsApp 11 6239-3921 (derivá ahí con [HANDOFF]).

## Sobre nosotros (solo si preguntan, sin alargar)
Piccadely: empresa argentina fundada en 2006, especializada en piccadas para juntadas y eventos en AMBA. Empresa B desde 2021 ("Nada se tira, todo se transforma").
`.trim();

// ─── CATÁLOGO EN VIVO (con caché de 5 minutos) ───────────────────────
// Saca el HTML de la descripción y la deja en texto plano corto
const limpiarDescripcion = (html) => {
  if (!html) return "";
  const txt = String(html)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return txt.length > 350 ? txt.slice(0, 350) + "…" : txt;
};

let _catalogo = { texto: null, ts: 0 };
async function getCatalogoTexto() {
  const ahora = Date.now();
  if (_catalogo.texto && ahora - _catalogo.ts < 5 * 60 * 1000) return _catalogo.texto;
  try {
    const r = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`,
      { headers: tnHeaders }
    );
    const lineas = [];
    for (const p of r.data) {
      if (p.published === false) continue;
      const nombre = p.name?.es || p.name?.pt || "Producto";
      const variantes = (p.variants || []).map(v => {
        const etiqueta = (v.values || []).map(x => x?.es).filter(Boolean).join(" / ");
        const precio = v.price != null ? `$${Number(v.price).toLocaleString("es-AR")}` : "s/precio";
        return etiqueta ? `${etiqueta}: ${precio}` : precio;
      });
      const desc = limpiarDescripcion(p.description?.es);
      lineas.push(`- ${nombre}${variantes.length ? ` — ${variantes.join(" · ")}` : ""}${desc ? `\n  Descripción/ingredientes: ${desc}` : ""}`);
    }
    _catalogo = { texto: lineas.join("\n"), ts: ahora };
    return _catalogo.texto;
  } catch (e) {
    console.error("Bot WhatsApp: error trayendo catálogo:", e.message);
    return _catalogo.texto || "(catálogo no disponible en este momento)";
  }
}

// ─── LÓGICA DEL BOT (reutilizable) ───────────────────────────────────
// responderBot(messages, config) → { reply, handoff }. Misma lógica para Botmaker (/api/bot/whatsapp)
// y para el webhook de la Cloud API de Meta. messages: [{role:"user"|"assistant", content}].
// Lanza error si falla Anthropic (cada llamador decide cómo responder).
export async function responderBot(messages, config) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY no configurada");

    // Parámetros configurables (con defaults del manual)
    const cfg = {
      anticipacionHoras: config?.anticipacionHoras ?? 4,
      tomarHoy: config?.tomarHoy ?? true,
      botPausado: config?.botPausado ?? false,
    };

    // Bot pausado → corta la toma automática y deriva
    if (cfg.botPausado) {
      return {
        reply: "¡Hola! En este momento no estamos tomando pedidos por acá. Un asesor te responde a la brevedad. 🙌",
        handoff: true,
      };
    }

    try {
      const catalogo = await getCatalogoTexto();
      const ahoraBA = new Date().toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        weekday: "long", day: "numeric", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });

      // Opciones de entrega calculadas por código (determinístico, NO lo razona el modelo).
      const ahora = ahoraArgentina();
      const opcOtroDia = opcionesEntrega(ahora, "otro_dia");
      const entregaHoyTxt = cfg.tomarHoy
        ? opcionesEntrega(ahora, "hoy").texto
        : `hoy NO se están tomando pedidos. Ofrecé reservar para otro día en una de las franjas fijas ${FRANJAS_TXT}.`;

      // System en 3 bloques para PROMPT CACHING:
      // 1) cerebro fijo (cachea) → 2) catálogo (cachea, rota cada 5 min) → 3) contexto en tiempo real (sin caché, va último para no romper el prefijo)
      const systemBloques = [
        {
          type: "text",
          text: SYSTEM_BOT,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `# CATÁLOGO Y PRECIOS EN VIVO (usá SIEMPRE estos precios, nunca inventes)\n${catalogo}`,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `# CONTEXTO EN TIEMPO REAL
- Fecha y hora actual (Buenos Aires): ${ahoraBA}.
- Anticipación mínima para PiccaSandwiches/PiccaDesayunos/Catering: ${cfg.anticipacionHoras} horas.
- ¿Se toman pedidos para HOY?: ${cfg.tomarHoy ? "SÍ" : "NO — ofrecé desde mañana con un 'por alta demanda, hoy tomamos pedidos para mañana'"}.
- RECORDATORIO DE ESTILO: prohibido "te late" (usá "¿qué te parece?" o "¿te va?"); los fiambres/embutidos son "charcuterie", nunca "carnes".

# ENTREGA (horarios calculados por el sistema — NO inventes ni razones horarios)
- Fecha y hora actual (Argentina): ${ahora.dia} ${ahora.hora}.
- Entrega para HOY (same-day): SOLO CABA. GBA no toma pedidos para hoy.
- Opciones de entrega que SÍ podés ofrecer ahora:
  · HOY en CABA: ${entregaHoyTxt}
  · HOY en GBA: no se toman pedidos para hoy. Ofrecé reservar para otro día: ${opcOtroDia.texto}
  · OTRO DÍA (reserva, CABA o GBA): ${opcOtroDia.texto}
  · Si todavía no sabés la zona del cliente, pedí la dirección/zona antes de prometer same-day.`,
        },
      ];

      const resp = await axios.post("https://api.anthropic.com/v1/messages", {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        system: systemBloques,
        messages: messages.slice(-14),
      }, {
        headers: {
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        timeout: 25000,
      });

      const raw = resp.data.content?.[0]?.text || "Perdón, no pude responder. ¿Probás de nuevo?";
      const handoff = /\[HANDOFF\]/i.test(raw);
      // Red de seguridad: por si al modelo se le escapa un modismo no argentino
      const argentinizar = (t) => t
        .replace(/¿\s*[Tt]e late\b/g, (m) => (m.includes("T") ? "¿Te va" : "¿te va"))
        .replace(/\b[Tt]e laten\b/g, (m) => (m[0] === "T" ? "Te van" : "te van"))
        .replace(/\b[Tt]e late\b/g, (m) => (m[0] === "T" ? "Te va" : "te va"))
        .replace(/\bahorita\b/gi, "ahora")
        .replace(/\bplaticar\b/gi, "charlar")
        .replace(/\bchévere\b/gi, "buenísimo");
      const reply = argentinizar(raw.replace(/\[HANDOFF\]/gi, "").trim());
      return { reply, handoff };
    } catch (err) {
      console.error("Error bot WhatsApp:", err.response?.data || err.message);
      throw err;
    }
}

// ─── ROUTER (Botmaker) ───────────────────────────────────────────────
// Contrato SIN cambios: mismas validaciones, mismas respuestas y mismos códigos que antes del refactor.
export function botWhatsappRouter() {
  const router = express.Router();

  // POST /api/bot/whatsapp
  // body: { messages: [{role:"user"|"assistant", content:"..."}], config?: { anticipacionHoras, tomarHoy, botPausado } }
  router.post("/whatsapp", async (req, res) => {
    const { messages, config } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0)
      return res.status(400).json({ error: "messages requerido" });
    if (!process.env.ANTHROPIC_API_KEY)
      return res.status(500).json({ error: "ANTHROPIC_API_KEY no configurada" });
    try {
      res.json(await responderBot(messages, config));
    } catch (err) {
      res.status(500).json({ error: "Error al consultar el bot" });
    }
  });

  return router;
}
