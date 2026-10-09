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
- Si el nombre del producto ya empieza con artículo (La Gourmet, El ...), no le agregues otro: 'La Gourmet Grande sale...', nunca 'la La Gourmet'.

# CÓMO SONAR HUMANO
- Nada de listas, viñetas ni párrafos largos salvo en el RESUMEN final del pedido.
- No repitas lo que dijo el cliente ni le expliques el proceso ("primero vamos a..., después...").
- No justifiques cada cosa. Si recomendás, una razón corta alcanza.
- Una sola pregunta por mensaje.
- Si alcanza con una palabra, usá una palabra ("¡Dale!", "Perfecto", "Sí, llegamos").
Ejemplos:
Cliente: "¿llegan a Palermo?" → MAL: "¡Hola! Sí, llegamos a Palermo, que está dentro de CABA en la Comuna 14. El envío tiene un costo de $2.500 y podemos entregarte en el día..." → BIEN: "¡Sí! El envío a Palermo sale $2.500. ¿Para cuándo lo querés?"
Cliente: "somos 6 para piccar" → MAL: explicar los 4 tamaños → BIEN: "Para 6 te va perfecta la *Mediana*. En promo tenemos la *[promo en Mediana]* ($[precio]) y si querés algo un poquito mejor, está la *[Il Paradiso en Mediana]* ($[precio])." (nombres y precios, siempre del catálogo)

# REGLAS DURAS (no las rompas)
- PRECIOS DE PRODUCTOS: usá SIEMPRE los del catálogo en vivo que está más abajo. NUNCA inventes ni estimes precios. Si algo no está en el catálogo, decí que lo consultás.
- COSTOS DE ENVÍO: usá EXACTAMENTE la tabla por partido de abajo. Si el partido no está en la tabla, NO hay cobertura: avisá con tacto que a esa zona no llegamos.
- NO confirmes ni cobres vos el pedido. Cuando esté completo, hacé un RESUMEN claro (productos, tamaño, subtotal, envío, total, datos del cliente, fecha y rango) y avisá que un asesor lo confirma y manda el link de pago. Si el cliente quiere cerrar ya o se complica, derivá a una persona escribiendo [HANDOFF] al final de tu mensaje.
- No prometas cosas fuera de estas reglas (zonas, horarios imposibles, descuentos inexistentes).
- Copiá los precios TAL CUAL figuran en el catálogo, del tamaño/variante exacta que pidió el cliente. Si hay precio promo, usá el promo. En el resumen, mostrá cada ítem con su precio y después el total.
- Si el cliente dice un precio ('¿la grande está $X?'), NO lo confirmes por las dudas: buscalo en el catálogo y decí el precio real. Si el producto que menciona no está en el catálogo, NO inventes precios ni tamaños: decí que lo chequeás y derivá con [HANDOFF].

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
- REGLA OBLIGATORIA: si el cliente dice para cuántas personas es y NO aclaró si es para comer o para piccar, preguntá SIEMPRE primero "¿Es para comer o para piccar?" (ej.: "¡Genial! ¿Es para comer o para piccar 5?"), ANTES de recomendar tamaño o variedad. Si ya lo aclaró ("para cenar", "como comida", "para picar antes", "de entrada"), no lo preguntes de nuevo. Si no dijo cuántos son, preguntalo.
- La recomendación depende de esa respuesta: para comer va un tamaño más grande que para piccar. Recomendá UN solo tamaño (no le muestres la tabla entera).
Para COMER (es la comida):
- Chica: 1 persona.
- Mediana: 2 personas.
- Grande: 4 personas.
- XL: 6 personas.
Para PICCAR (picada antes / de entrada):
- Chica: 3 personas.
- Mediana: de 4 a 6 personas.
- Grande: de 8 a 10 personas.
- XL: 12 personas.
- Más de 12 que piccan: Combinados.
Si la cantidad queda entre dos tamaños (ej.: 7 u 11 que piccan), recomendá el más grande: mejor que sobre a que falte.
Más de 6 que COMEN: combiná tamaños hasta cubrir la cantidad, con la menor cantidad de piccadas posible: 7 = XL + Chica · 8 = XL + Mediana · 9 o 10 = XL + Grande · 11 o 12 = 2 XL.
Los ingredientes son los mismos en todos los tamaños; cambia la cantidad.

## Qué piccada recomendar (SIEMPRE 2 opciones del tamaño que corresponda)
- Una de la subcategoría "PiccaPromos - 10 Ingredientes" (la promo) y otra de "Il Paradiso - 12 Ingredientes" (un poquito mejor). Las dos tienen que tener ese tamaño en el catálogo.
- Orden por defecto (la primera que tenga ese tamaño en el catálogo):
  · Promo: MegaPromo Divertida → Piccada Spring Break → Comilona.
  · Il Paradiso: Magnolia → Anita de Baires → Amistad → HD (Hiper Divina).
  · Quesos del Gourmet NO se ofrece por defecto: solo si el cliente pide algo vegetariano o de quesos.
- Adaptate al cliente: si menciona ingredientes, gustos o restricciones ("sin cerdo", "mucho queso", "con jamón crudo", "vegetariana"), mirá la Descripción/ingredientes de cada producto en el catálogo, elegí las opciones que mejor encajen aunque te salgas del orden, y decí en pocas palabras qué tiene cada una que coincide con lo que pidió. Solo ingredientes que figuran en el catálogo: si un producto no tiene descripción o no dice algo, no lo afirmes.
- Productos de tamaño único (Tablón Supreme, Comilona Juntadely, Libre Bancheto): ofrecelos SOLO si el cliente los nombra o pregunta por ellos.
- Formato: "En promo tenemos la *[nombre promo]* ($precio) y si querés algo un poquito mejor, está la *[nombre Il Paradiso]* ($precio)."
- Si es una combinación (más de 6 que comen), cada opción es el mismo producto en los tamaños de la combinación, con el total: "En promo tenemos la *[promo]* en XL + Chica ($total) y si querés algo un poquito mejor, la *[Il Paradiso]* en XL + Chica ($total)."
- Nombres, tamaños y precios SIEMPRE del catálogo en vivo (secciones "## Piccadas > PiccaPromos - 10 Ingredientes" y "## Piccadas > Il Paradiso - 12 Ingredientes"). Nunca inventes productos ni precios.
- Si en ese tamaño no hay ninguna de una de esas dos subcategorías, ofrecé la más cercana que SÍ esté en el catálogo en ese tamaño, sin decir que existe algo que no está.

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

// Tienda Nube: productos y categorías paginados (per_page=200, page=1,2,… hasta que venga vacío;
// TN responde 404 "Last page is N" cuando se pide una página de más: también corta ahí).
const TN_PER_PAGE = 200;
const TN_MAX_PAGINAS = 50;
async function tnPaginado(recurso) {
  const out = [];
  for (let page = 1; page <= TN_MAX_PAGINAS; page++) {
    let r;
    try {
      r = await axios.get(`https://api.tiendanube.com/2025-03/${STORE_ID}/${recurso}`, {
        headers: tnHeaders, params: { per_page: TN_PER_PAGE, page }, timeout: 20000,
      });
    } catch (e) {
      if (page > 1 && e.response?.status === 404) break;
      throw e;
    }
    const data = Array.isArray(r.data) ? r.data : [];
    if (!data.length) break;
    out.push(...data);
  }
  return out;
}

const tnTexto = (x) => (x && typeof x === "object" ? x.es || x.pt || Object.values(x)[0] : x) || "";
const pesos = (n) => `$${Number(n).toLocaleString("es-AR")}`;
const numValido = (x) => x !== null && x !== undefined && String(x).trim() !== "" && Number.isFinite(Number(x)) && Number(x) > 0;

// Etiqueta de variante de TN "Mediana - Comen 2- Piccan 5" → "Mediana (comen 2, piccan 5)".
// Si no tiene ese patrón, queda tal cual.
const RE_PERSONAS = /^\s*(.+?)\s*-\s*(comen?)\s*(\d+)\s*-\s*(piccan?)\s*(\d+)\s*$/i;
const etiquetaVariante = (s) => {
  const m = String(s).match(RE_PERSONAS);
  return m ? `${m[1]} (${m[2].toLowerCase()} ${m[3]}, ${m[4].toLowerCase()} ${m[5]})` : String(s).trim();
};

// Línea de una variante ("  · Mediana (comen 2, piccan 5): $68.000"); null = sin precio → se saltea.
//   promo menor que el precio → "$PROMO (precio promo, antes $PRICE)"; stock 0 con stock_management → "SIN STOCK".
function precioVariante(v) {
  if (!numValido(v.price)) return null;
  const precio = Number(v.price);
  let txt = numValido(v.promotional_price) && Number(v.promotional_price) < precio
    ? `${pesos(v.promotional_price)} (precio promo, antes ${pesos(precio)})`
    : pesos(precio);
  if (v.stock_management && Number(v.stock) === 0) txt += " SIN STOCK";
  const etiqueta = (v.values || []).map(tnTexto).filter(Boolean).map(etiquetaVariante).join(" / ");
  return `  · ${etiqueta ? `${etiqueta}: ${txt}` : txt}`;
}

// Arma el texto del catálogo: índice de categorías arriba y productos agrupados por ruta completa
// ("Piccadas > Il Paradiso - 12 Ingredientes"). Categorías con visibility "hidden" (o con un ancestro oculto)
// se saltean. Un producto en varias categorías va en cada una: completo (con descripción) en la primera del índice
// y solo con precios en las demás, así ninguna categoría queda vacía y el texto no se duplica entero.
// Productos sin categoría visible → "## Otros".
export function armarCatalogoTexto(productos, categorias) {
  const porId = new Map(categorias.map((c) => [c.id, c]));
  const padreDe = (c) => (c.parent ? porId.get(c.parent) : null);
  const oculta = (c) => { for (let x = c, i = 0; x && i < 20; x = padreDe(x), i++) if (String(x.visibility || "").toLowerCase() === "hidden") return true; return false; };
  const ruta = (c) => { const r = []; for (let x = c, i = 0; x && i < 20; x = padreDe(x), i++) r.unshift(tnTexto(x.name)); return r.join(" > "); };
  // Orden del índice: recorrido del árbol (padre y después sus hijos), respetando el orden de TN.
  const visibles = categorias.filter((c) => !oculta(c));
  const hijos = (pid) => visibles.filter((c) => (c.parent || 0) === pid || (pid === 0 && c.parent && !porId.has(c.parent)));
  const orden = [], vistos = new Set();
  const recorrer = (pid, nivel) => { for (const c of hijos(pid)) { if (vistos.has(c.id)) continue; vistos.add(c.id); orden.push({ c, nivel }); recorrer(c.id, nivel + 1); } };
  recorrer(0, 0);
  const posicion = new Map(orden.map((o, i) => [o.c.id, i]));

  const grupos = new Map();   // id categoría (o "otros") → líneas
  for (const p of productos) {
    if (p.published === false) continue;
    const variantes = (p.variants || []).map(precioVariante).filter(Boolean);
    if (!variantes.length) continue;   // sin ningún precio: no se ofrece (el bot no puede cotizarlo)
    // Categorías visibles más específicas (si está en "Piccadas" y en "Piccadas > X", queda solo "X").
    let cats = (p.categories || []).map((c) => porId.get(c.id) || c).filter((c) => posicion.has(c.id));
    const ancestros = new Set();
    for (const c of cats) for (let x = padreDe(c); x; x = padreDe(x)) ancestros.add(x.id);
    cats = [...new Map(cats.filter((c) => !ancestros.has(c.id)).map((c) => [c.id, c])).values()]
      .sort((a, b) => posicion.get(a.id) - posicion.get(b.id));
    // Cada variante en su propia línea (Haiku mezcla productos de nombre parecido si van todos en una línea).
    const nombre = tnTexto(p.name) || "Producto";
    const desc = limpiarDescripcion(tnTexto(p.description));
    const conDesc = [`- ${nombre}`, ...variantes, ...(desc ? [`  Descripción/ingredientes: ${desc}`] : [])].join("\n");
    const agregar = (clave, linea) => { if (!grupos.has(clave)) grupos.set(clave, []); grupos.get(clave).push(linea); };
    if (!cats.length) { agregar("otros", conDesc); continue; }
    agregar(cats[0].id, conDesc);
    const corto = [`- ${nombre}${desc ? ` (descripción en: ${ruta(cats[0])})` : ""}`, ...variantes].join("\n");
    for (const c of cats.slice(1)) agregar(c.id, corto);
  }

  // Índice: solo las categorías con productos (o con descendientes con productos).
  const conProductos = new Set();
  for (const id of grupos.keys()) if (id !== "otros") for (let x = porId.get(id); x; x = padreDe(x)) conProductos.add(x.id);
  const indice = orden.filter((o) => conProductos.has(o.c.id)).map((o) => `${"  ".repeat(o.nivel)}- ${tnTexto(o.c.name)}`);
  if (grupos.has("otros")) indice.push("- Otros");

  const secciones = [];
  for (const { c } of orden) if (grupos.has(c.id)) secciones.push(`## ${ruta(c)}\n${grupos.get(c.id).join("\n")}`);
  if (grupos.has("otros")) secciones.push(`## Otros\n${grupos.get("otros").join("\n")}`);
  return `## Índice de categorías\n${indice.join("\n")}\n\n${secciones.join("\n\n")}`;
}

// Caché de 5 minutos. Si TN falla se sigue usando la última versión buena hasta 2 horas;
// sin caché o con caché de más de 2 h → el catálogo se marca NO disponible (el bot no da precios).
const CATALOGO_CACHE_MS = 5 * 60 * 1000;
const CATALOGO_VENCE_MS = 2 * 60 * 60 * 1000;
const CATALOGO_REINTENTO_MS = 60 * 1000;   // tras una falla, no se vuelve a llamar a TN por 1 minuto
let _catalogo = { texto: null, okAt: 0, falloAt: 0, error: null, productos: 0, categorias: 0 };
let _catalogoEnCurso = null;

async function refrescarCatalogo() {
  try {
    const [productos, categorias] = await Promise.all([tnPaginado("products"), tnPaginado("categories")]);
    _catalogo = { texto: armarCatalogoTexto(productos, categorias), okAt: Date.now(), falloAt: 0, error: null, productos: productos.length, categorias: categorias.length };
  } catch (e) {
    const detalle = e.response ? `HTTP ${e.response.status} ${JSON.stringify(e.response.data || "").slice(0, 200)}` : e.message;
    console.error("Bot WhatsApp: error trayendo el catálogo de Tienda Nube:", detalle);
    _catalogo = { ..._catalogo, falloAt: Date.now(), error: detalle };
  }
}

// → { texto, disponible, okAt, error, productos, categorias }. forzar = ignora el caché de 5 minutos.
export async function getCatalogo({ forzar = false } = {}) {
  const ahora = Date.now();
  const fresco = _catalogo.texto && ahora - _catalogo.okAt < CATALOGO_CACHE_MS;
  const enEspera = _catalogo.falloAt && ahora - _catalogo.falloAt < CATALOGO_REINTENTO_MS;
  if (forzar || (!fresco && !enEspera)) {
    _catalogoEnCurso = _catalogoEnCurso || refrescarCatalogo().finally(() => { _catalogoEnCurso = null; });
    await _catalogoEnCurso;
  }
  const disponible = !!_catalogo.texto && Date.now() - _catalogo.okAt <= CATALOGO_VENCE_MS;
  if (!disponible) console.error("Bot WhatsApp: CATÁLOGO NO DISPONIBLE (sin caché o caché de más de 2 h): el bot no va a dar precios.");
  return { ..._catalogo, disponible };
}

// Texto exacto del bloque de catálogo que recibe el modelo.
const bloqueCatalogo = (cat) => cat.disponible
  ? `# CATÁLOGO Y PRECIOS EN VIVO (usá SIEMPRE estos precios, nunca inventes)\n${cat.texto}`
  : "# CATÁLOGO Y PRECIOS EN VIVO\n(no disponible en este momento)";
const LINEA_SIN_CATALOGO = "- CATÁLOGO NO DISPONIBLE: no des ningún precio; si preguntan precios, derivá con [HANDOFF].";

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
      const catalogo = await getCatalogo();
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
          text: bloqueCatalogo(catalogo),
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `# CONTEXTO EN TIEMPO REAL
- Fecha y hora actual (Buenos Aires): ${ahoraBA}.
${catalogo.disponible ? "" : LINEA_SIN_CATALOGO + "\n"}- Anticipación mínima para PiccaSandwiches/PiccaDesayunos/Catering: ${cfg.anticipacionHoras} horas.
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
export function botWhatsappRouter({ requireAuth } = {}) {
  const router = express.Router();

  // GET /api/bot/catalogo[?refrescar=1] — debug (login del panel): el texto EXACTO del catálogo que recibe el
  // bot, cuándo se actualizó bien por última vez y si está disponible. No toca el contrato de /whatsapp (Botmaker).
  if (requireAuth) {
    router.get("/catalogo", requireAuth, async (req, res) => {
      const cat = await getCatalogo({ forzar: req.query.refrescar === "1" });
      res.json({
        disponible: cat.disponible,
        actualizado_at: cat.okAt ? new Date(cat.okAt).toISOString() : null,
        ultimo_error: cat.error,
        productos_tn: cat.productos, categorias_tn: cat.categorias,
        texto: bloqueCatalogo(cat),
        contexto_extra: cat.disponible ? null : LINEA_SIN_CATALOGO,
      });
    });
  }

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
