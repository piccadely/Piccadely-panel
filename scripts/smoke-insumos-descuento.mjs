// Smoke test del descuento automático de insumos por recetas (Stock Fase 2b).
//
// Corre el CÓDIGO REAL de server.js (lo extrae del archivo, no lo copia) dentro de UNA transacción y hace ROLLBACK al
// final: no persiste nada. Crea sus propios insumos, recetas, pedidos y configuración de locales (prefijo SMOKE2B) y
// también aplica adentro de la transacción la migración de la Fase 2b (IF NOT EXISTS), así que sirve antes del deploy.
//
// Uso (el secreto NO queda en el repo ni en el historial):
//   DATABASE_URL="postgresql://...sslmode=require" node scripts/smoke-insumos-descuento.mjs
//
// Cubre: receta anidada + desperdicio, idempotencia, local inactivo / activo_desde futuro, producto sin receta e insumo
// sin peso por unidad (auditoría, no falla), anulación (devuelve exacto, también de un Entregado), reapertura + nuevo
// despacho, reabrir finalizado (Entregado → En camino: nada) y anulado (Anulado → En camino: descuenta), disparos
// desordenados, simulación sin escritura y el envoltorio best-effort (un error nunca llega al despacho).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── Extracción del código real de server.js ──────────────────────────────────────────────────────────────────
function extraerFuncion(src, nombre) {
  const m = new RegExp(`\\n(async )?function ${nombre}\\(`).exec(src);
  if (!m) throw new Error(`No encontré function ${nombre} en server.js`);
  const inicio = m.index + 1;
  // La firma ocupa una línea que termina en ") {" (con o sin comentario después): ahí abre el cuerpo.
  const finLinea = src.indexOf("\n", inicio), abre = src.lastIndexOf(") {", finLinea);
  if (abre < inicio) throw new Error(`Firma inesperada de ${nombre}`);
  let i = abre + 2, d = 0;
  for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}") { d--; if (d === 0) break; } }
  return src.slice(inicio, i + 1);
}
function extraerConst(src, nombre) {
  const m = new RegExp(`\\nconst ${nombre} = [^\\n]*`).exec(src);
  if (!m) throw new Error(`No encontré const ${nombre} en server.js`);
  return m[0].trim();
}
function extraerMigracion(src) {
  const i = src.indexOf("// STOCK Fase 2b:"), f = src.indexOf("// WhatsApp Cloud API", i);
  if (i < 0 || f < 0) throw new Error("No encontré la migración de la Fase 2b en server.js");
  return src.slice(i, f);
}

const FUNCIONES = ["fechaArgentinaISO", "clasificarPedidoBackend", "localLabelBackend", "productosStringDePedido", "localDePedido",
  "cargarRecetasIndex", "cargarInsumosIndex", "explotarReceta", "explotarDemandaInsumos", "numeroDePedido", "consumoInsumosDePedido",
  "descuentoInsumosVigente", "descontarInsumosDePedido", "devolverInsumosDePedido", "insumosPedidoTx"];
const CONSTANTES = ["TN_CODE_FRENCH", "TN_CODE_AT", "INSUMO_LOCALES", "ESTADOS_DESPACHADO", "redondearInsumo", "claveVinculo"];

export async function cargarCodigoReal(client) {
  const src = fs.readFileSync(path.join(RAIZ, "server.js"), "utf8").replace(/\r\n/g, "\n");
  const norm = await import(pathToFileURL(path.join(RAIZ, "productos-normalizacion.js")).href);
  const codigo = CONSTANTES.map((c) => extraerConst(src, c)).join("\n") + "\n" + FUNCIONES.map((f) => extraerFuncion(src, f)).join("\n\n")
    + `\nreturn { ${[...FUNCIONES, ...CONSTANTES].join(", ")} };`;
  // pool = el client de la transacción: todo lo que usa "exec = pool" queda adentro del ROLLBACK.
  const fns = new Function("pool", "normalizarProducto", "claveProducto", "esExcluidoProduccion", "esBasuraVenta", "tabReglaLocalTN", "console", codigo)(
    client, norm.normalizarProducto, norm.claveProducto, norm.esExcluidoProduccion, norm.esBasuraVenta, norm.tabReglaLocalTN, { ...console, error: () => {} });
  const migracion = new Function("pool", `return (async () => {\n${extraerMigracion(src)}\n})();`);
  return { fns, migrar: () => migracion(client), norm };
}

// ── Escenarios ───────────────────────────────────────────────────────────────────────────────────────────────
export async function correrSmoke(client, log = console.log) {
  let fallas = 0;
  const ok = (cond, msg) => { log(`${cond ? "[OK]  " : "[FAIL]"} ${msg}`); if (!cond) fallas++; };
  const q = (sql, p) => client.query(sql, p);
  const casi = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

  const { fns, migrar, norm } = await cargarCodigoReal(client);
  const { descontarInsumosDePedido: descontar, devolverInsumosDePedido: devolver, consumoInsumosDePedido, insumosPedidoTx } = fns;
  await migrar();

  // Insumos: queso (g, por gramos), jamón (g, por feta de 20 g), caja (unidad)
  const ins = async (nombre, unidad, peso) => (await q("INSERT INTO insumos (nombre, categoria, unidad, peso_unidad_g) VALUES ($1,'SMOKE2B',$2,$3) RETURNING id", [nombre, unidad, peso])).rows[0].id;
  const QUESO = await ins("SMOKE2B Queso", "g", null), JAMON = await ins("SMOKE2B Jamón", "g", 20), CAJA = await ins("SMOKE2B Caja", "unidad", null);
  const ACEITUNA = await ins("SMOKE2B Aceituna", "g", null);   // por gramos y SIN peso por unidad: en "unidades" no se puede descontar
  // Módulo: 3 fetas de jamón (+10%) + 50 g de queso (0%) → 66 g jamón, 50 g queso
  const rec = async (nombre, tipo) => (await q("INSERT INTO recetas (nombre, tipo) VALUES ($1,$2) RETURNING id", [nombre, tipo])).rows[0].id;
  const MOD = await rec("SMOKE2B Módulo fiambre", "modulo"), PICADA = await rec("SMOKE2B Picada", "producto");
  const lin = (r, o, campos) => q("INSERT INTO receta_lineas (receta_id, orden, insumo_id, subreceta_id, modo, cantidad, desperdicio_pct) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [r, o, campos.insumo ?? null, campos.sub ?? null, campos.modo || "unidades", campos.cant, campos.desp ?? 0]);
  await lin(MOD, 1, { insumo: JAMON, modo: "unidades", cant: 3, desp: 10 });
  await lin(MOD, 2, { insumo: QUESO, modo: "gramos", cant: 50, desp: 0 });
  // Picada: 2 módulos (anidada) + 100 g de queso (+8%) + 1 caja → por picada: jamón 132, queso 208, caja 1
  await lin(PICADA, 1, { sub: MOD, cant: 2 });
  await lin(PICADA, 2, { insumo: QUESO, modo: "gramos", cant: 100, desp: 8 });
  await lin(PICADA, 3, { insumo: CAJA, modo: "unidades", cant: 1, desp: 0 });
  await lin(PICADA, 4, { insumo: ACEITUNA, modo: "unidades", cant: 5, desp: 0 });   // sin peso → auditoría insumos_sin_peso, no se descuenta
  const NOMBRE_PICADA = "SMOKE2B Picada";
  await q("INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave) VALUES ($1,$2,$3)", [PICADA, NOMBRE_PICADA, norm.claveProducto(norm.normalizarProducto(NOMBRE_PICADA))]);
  const ESPERADO = { [JAMON]: 264, [QUESO]: 416, [CAJA]: 2 };   // pedido con 2 picadas

  // Locales: French activo desde hace una hora; A. Thomas apagado
  const config = (local, activo, desdeSql) => q(`INSERT INTO insumos_config_local (local, descuento_activo, activo_desde) VALUES ($1,$2,${desdeSql})
    ON CONFLICT (local) DO UPDATE SET descuento_activo = EXCLUDED.descuento_activo, activo_desde = EXCLUDED.activo_desde`, [local, activo]);
  await config("French", true, "now() - interval '1 hour'");
  await config("A. Thomas", false, "NULL");

  const PRODUCTOS = `${NOMBRE_PICADA} x2, SMOKE2B Producto sin receta x1, Envío a domicilio x1`;
  const pedido = async (id, tab, numero) => {
    await q("INSERT INTO pedidos_manuales (id, numero, cliente, productos, tab_actual) VALUES ($1,$2,'Smoke',$3,$4)", [id, numero, PRODUCTOS, tab]);
    await q("INSERT INTO pedidos_estados (id, estado) VALUES ($1,'Por empaquetar')", [id]);
  };
  const estado = (id, e) => q("UPDATE pedidos_estados SET estado = $2 WHERE id = $1", [id, e]);
  const movs = async (id) => (await q("SELECT insumo_id, local, cantidad, nota, pedido_ref, tipo FROM insumos_movimientos WHERE pedido_ref = $1 ORDER BY id", [id])).rows;
  const neto = async (id) => { const r = {}; for (const m of await movs(id)) r[m.insumo_id] = (r[m.insumo_id] || 0) + Number(m.cantidad); return r; };
  // SELECT *: stock_descontado (cocina) existe en Neon pero no lo crea initDB (pendiente conocido); si no está, no se mira.
  const flag = async (id) => (await q("SELECT * FROM pedidos_estados WHERE id = $1", [id])).rows[0];

  // 1) Descuento con receta anidada + desperdicio
  await pedido("SMOKE2B-1", "delivery-fr", "S2B-1");
  ok(fns.localLabelBackend("delivery-fr") === "French" && fns.localLabelBackend("retiro-at") === "A. Thomas", "mapeo de local: delivery-fr → French, retiro-at → A. Thomas");
  const antesSim = (await q("SELECT COUNT(*)::int n FROM insumos_movimientos")).rows[0].n;
  const sim = await consumoInsumosDePedido("SMOKE2B-1");
  ok((await q("SELECT COUNT(*)::int n FROM insumos_movimientos")).rows[0].n === antesSim, "simulación: no escribe movimientos");
  ok(sim.items.length === 3 && sim.items.every((it) => casi(it.cantidad, ESPERADO[it.insumo_id])), `simulación: jamón 264 g, queso 416 g, caja 2 → ${sim.items.map((i) => `${i.nombre} ${i.cantidad}`).join(", ")}`);
  ok(sim.sinReceta.length === 1 && sim.sinReceta[0].producto.includes("sin receta"), `simulación: el envío no cuenta; queda 1 producto sin receta (${sim.sinReceta.map((s) => s.producto).join(", ")})`);
  ok(sim.sinPeso.length === 1 && sim.sinPeso[0].insumo_id === ACEITUNA && /picada/i.test(sim.sinPeso[0].producto) && !sim.items.some((i) => i.insumo_id === ACEITUNA),
    `simulación: la aceituna (sin peso) se informa y no se descuenta (${JSON.stringify(sim.sinPeso[0])})`);

  ok((await descontar(client, "SMOKE2B-1")).resultado === "no_corresponde", "Por empaquetar → no descuenta (todavía no salió)");
  await estado("SMOKE2B-1", "En camino");
  const r1 = await descontar(client, "SMOKE2B-1");
  ok(r1.resultado === "descontado" && r1.local === "French", `En camino → descontado en ${r1.local}`);
  let m1 = await movs("SMOKE2B-1");
  ok(m1.length === 3 && m1.every((m) => m.tipo === "consumo" && m.local === "French" && m.nota === "Pedido #S2B-1" && Number(m.cantidad) < 0), "un movimiento 'consumo' negativo por insumo, con pedido_ref y nota 'Pedido #S2B-1'");
  const n1 = await neto("SMOKE2B-1");
  ok(Object.keys(ESPERADO).every((k) => casi(n1[k], -ESPERADO[k])), `cantidades exactas: ${JSON.stringify(n1)}`);
  ok((await flag("SMOKE2B-1")).insumos_descontado === true && (await flag("SMOKE2B-1")).stock_descontado !== true, "flag insumos_descontado = true; el de cocina (stock_descontado) no se toca");

  // 2) Idempotencia: segunda transición (Entregado) y repetición
  await estado("SMOKE2B-1", "Entregado");
  ok((await descontar(client, "SMOKE2B-1")).resultado === "no_corresponde" && (await descontar(client, "SMOKE2B-1")).resultado === "no_corresponde", "En camino → Entregado (y otro disparo): no vuelve a descontar");
  ok((await movs("SMOKE2B-1")).length === 3, "siguen siendo 3 movimientos");
  ok((await devolver(client, "SMOKE2B-1")).resultado === "no_corresponde", "devolución con el pedido despachado: no hace nada");

  // 3) Producto sin receta → auditoría, sin frenar
  const aud = (await q("SELECT detalle FROM auditoria WHERE accion = 'insumos_sin_receta' AND entidad_id = 'SMOKE2B-1'")).rows;
  const det = aud.map((a) => (typeof a.detalle === "string" ? JSON.parse(a.detalle) : a.detalle));
  ok(aud.length === 1 && det[0].producto.includes("sin receta") && det[0].local === "French", `auditoría insumos_sin_receta con el producto: ${JSON.stringify(det[0])}`);

  // 3b) Insumo sin peso por unidad → auditoría insumos_sin_peso (insumo + producto + pedido), una sola vez
  const audP = (await q("SELECT detalle FROM auditoria WHERE accion = 'insumos_sin_peso' AND entidad_id = 'SMOKE2B-1'")).rows.map((a) => (typeof a.detalle === "string" ? JSON.parse(a.detalle) : a.detalle));
  ok(audP.length === 1 && audP[0].insumo === "SMOKE2B Aceituna" && audP[0].insumo_id === ACEITUNA && /picada/i.test(audP[0].producto) && audP[0].numero === "S2B-1" && audP[0].local === "French",
    `auditoría insumos_sin_peso con insumo, producto y pedido: ${JSON.stringify(audP[0])}`);
  ok(!(await movs("SMOKE2B-1")).some((m) => m.insumo_id === ACEITUNA), "la aceituna no generó movimiento");

  // 4) Local inactivo / activo_desde en el futuro
  await pedido("SMOKE2B-2", "retiro-at", "S2B-2"); await estado("SMOKE2B-2", "En camino");
  ok((await descontar(client, "SMOKE2B-2")).resultado === "local_inactivo" && (await movs("SMOKE2B-2")).length === 0 && (await flag("SMOKE2B-2")).insumos_descontado === false, "A. Thomas apagado → no descuenta ni marca el flag");
  await config("French", true, "now() + interval '1 hour'");
  await pedido("SMOKE2B-3", "delivery-fr", "S2B-3"); await estado("SMOKE2B-3", "En camino");
  ok((await descontar(client, "SMOKE2B-3")).resultado === "local_inactivo" && (await movs("SMOKE2B-3")).length === 0, "French con activo_desde en el futuro → no descuenta");
  await config("French", true, "now() - interval '1 hour'");

  // 5) Anulación → devuelve exacto
  await estado("SMOKE2B-1", "Anulado");
  const d1 = await devolver(client, "SMOKE2B-1");
  ok(d1.resultado === "devuelto" && d1.movimientos === 3, "Anulado → devuelto (3 movimientos)");
  m1 = await movs("SMOKE2B-1");
  ok(m1.slice(3).every((m) => Number(m.cantidad) > 0 && m.nota === "Devolución pedido #S2B-1" && m.local === "French"), "devoluciones positivas con nota 'Devolución pedido #S2B-1'");
  const n1b = await neto("SMOKE2B-1");
  ok(Object.keys(ESPERADO).every((k) => casi(n1b[k], 0)), `neto del pedido = 0: ${JSON.stringify(n1b)}`);
  ok((await flag("SMOKE2B-1")).insumos_descontado === false, "flag vuelve a false");
  ok((await devolver(client, "SMOKE2B-1")).resultado === "no_corresponde", "segunda devolución: no hace nada");

  // 6) Reapertura + nuevo despacho
  await pedido("SMOKE2B-4", "delivery-fr", "S2B-4"); await estado("SMOKE2B-4", "En camino");
  await descontar(client, "SMOKE2B-4");
  await estado("SMOKE2B-4", "Por empaquetar");
  ok((await devolver(client, "SMOKE2B-4")).resultado === "devuelto", "reabierto (Por empaquetar) → devuelto");
  await estado("SMOKE2B-4", "Entregado");
  ok((await descontar(client, "SMOKE2B-4")).resultado === "descontado", "vuelve a salir (Entregado) → descuenta de nuevo");
  const n4 = await neto("SMOKE2B-4");
  ok((await movs("SMOKE2B-4")).length === 9 && Object.keys(ESPERADO).every((k) => casi(n4[k], -ESPERADO[k])), `9 movimientos y neto = un solo descuento: ${JSON.stringify(n4)}`);

  // 6b) Reabrir un FINALIZADO (Entregado → En camino, botón "Reabrir pedido"): sigue despachado → ni devuelve ni repite
  const movs4 = (await movs("SMOKE2B-4")).length;
  await estado("SMOKE2B-4", "En camino");
  ok((await devolver(client, "SMOKE2B-4")).resultado === "no_corresponde" && (await descontar(client, "SMOKE2B-4")).resultado === "no_corresponde" && (await movs("SMOKE2B-4")).length === movs4,
    "reabrir finalizado (Entregado → En camino): ni devuelve ni descuenta de nuevo");
  // Reabrir un ANULADO (Anulado → En camino): vuelve a salir → descuenta de nuevo
  await estado("SMOKE2B-1", "En camino");
  ok((await descontar(client, "SMOKE2B-1")).resultado === "descontado", "reabrir anulado (Anulado → En camino): descuenta de nuevo");
  const n1c = await neto("SMOKE2B-1");
  ok(Object.keys(ESPERADO).every((k) => casi(n1c[k], -ESPERADO[k])), `neto = un solo descuento: ${JSON.stringify(n1c)}`);
  ok((await q("SELECT COUNT(*)::int n FROM auditoria WHERE accion = 'insumos_sin_peso' AND entidad_id = 'SMOKE2B-1'")).rows[0].n === 2, "el nuevo descuento vuelve a auditar el insumo sin peso (uno por descuento)");
  // Entregado → Anulado (anular un finalizado): devuelve
  await estado("SMOKE2B-1", "Entregado"); await descontar(client, "SMOKE2B-1");
  await estado("SMOKE2B-1", "Anulado");
  ok((await devolver(client, "SMOKE2B-1")).resultado === "devuelto" && Object.values(await neto("SMOKE2B-1")).every((v) => casi(v, 0)), "anular un Entregado: devuelve exacto");

  // 7) Disparos desordenados: el descuento llega después de que el pedido ya volvió atrás → no descuenta
  await pedido("SMOKE2B-5", "delivery-fr", "S2B-5"); await estado("SMOKE2B-5", "En camino"); await estado("SMOKE2B-5", "Listo");
  ok((await devolver(client, "SMOKE2B-5")).resultado === "no_corresponde" && (await descontar(client, "SMOKE2B-5")).resultado === "no_corresponde" && (await movs("SMOKE2B-5")).length === 0, "despacho y reapertura desordenados: queda sin descontar, como el último estado");

  // 8) Envoltorio best-effort: un error nunca sale al despacho
  const salida = await fns.insumosPedidoTx.call(null, async () => { throw new Error("boom"); }, "X", "test").catch(() => "PROPAGÓ");
  ok(salida !== "PROPAGÓ", "insumosPedidoTx no propaga errores");

  log(fallas ? `\n${fallas} FALLA(S)` : "\nTODO OK");
  return fallas;
}

// ── Ejecución directa contra la base (con ROLLBACK) ─────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { DATABASE_URL } = process.env;
  if (!DATABASE_URL) { console.error('Falta DATABASE_URL. Ej:\n  DATABASE_URL="postgresql://..." node scripts/smoke-insumos-descuento.mjs'); process.exit(1); }
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: DATABASE_URL, ssl: DATABASE_URL.includes("sslmode=") ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  let fallas = 1;
  try {
    await client.query("BEGIN");
    fallas = await correrSmoke(client);
  } catch (e) {
    console.error("[FAIL] excepción:", e.stack || e.message);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    console.log("ROLLBACK: no quedó nada guardado.");
    await client.end();
  }
  process.exit(fallas ? 1 : 0);
}
