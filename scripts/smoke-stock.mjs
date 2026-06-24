// Smoke test AISLADO del feature de stock (server.js cbbc983).
//
// Corre TODO dentro de una sola transacción y hace ROLLBACK al final: no
// persiste nada en la base. Reproduce textualmente las queries commiteadas
// (claim atómico, FIFO FOR UPDATE, parseo de productos, label de local) para
// validar el comportamiento sin tocar datos reales ni levantar el server HTTP.
//
// Uso (el secreto NO queda en el repo ni en el historial):
//   DATABASE_URL="postgresql://...sslmode=require" node scripts/smoke-stock.mjs
//
// Salida esperada: una serie de pasos con [OK]/[FAIL] y un resumen final.
// Si algo da [FAIL], NO construyas la UI encima todavía.

import pg from "pg";

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error("Falta DATABASE_URL en el entorno. Ej:\n  DATABASE_URL=\"postgresql://...\" node scripts/smoke-stock.mjs");
  process.exit(1);
}

// ── Helpers replicados VERBATIM de server.js ──────────────────────────
function parsearProductosBackend(productosStr) {
  const out = [];
  (productosStr || "").split(", ").forEach(item => {
    const m = item.match(/^(.+) x(\d+)$/);
    if (!m) return;
    out.push({ clave: m[1].trim(), cantidad: Number(m[2]) });
  });
  return out;
}
function localLabelBackend(tabActual) {
  if (tabActual === "retiro-at" || tabActual === "delivery-at") return "A. Thomas";
  if (tabActual === "retiro-fr" || tabActual === "delivery-fr") return "French";
  return "—";
}
const TN_CODE_FRENCH = "01KQ7S2Z0799JKAT5A1VTH12EQ";
const TN_CODE_AT = "01KQ7TFQPTTZQ7CFFKCKVWEZQV";
function clasificarPedidoBackend(p) {
  const ff = p.fulfillments?.[0];
  const tipo = ff?.shipping?.type || "";
  const optionName = (ff?.shipping?.option?.name || "").toLowerCase();
  const optionCode = ff?.shipping?.option?.code || "";
  const esPickup = tipo === "pickup" || optionName.includes("retiro") || optionName.includes("pickup") || optionName.includes("local");
  let esFrench;
  if (optionCode === TN_CODE_FRENCH) esFrench = true;
  else if (optionCode === TN_CODE_AT) esFrench = false;
  else esFrench = optionName.includes("recoleta");
  if (esPickup) return esFrench ? "retiro-fr" : "retiro-at";
  return esFrench ? "delivery-fr" : "delivery-at";
}

// productosStringDePedido — mirror VERBATIM de server.js (override > TN > manual).
// Devuelve también la fuente para el logging del diagnóstico.
async function productosStringDePedido(id, client) {
  const ov = await client.query("SELECT productos FROM pedidos_productos WHERE pedido_id=$1", [id]);
  if (ov.rows[0]) return { productos: ov.rows[0].productos || "", fuente: "override(pedidos_productos)" };
  const tn = await client.query("SELECT data FROM pedidos_tn WHERE id::text=$1", [id]);
  if (tn.rows[0]) return { productos: (tn.rows[0].data.products || []).map(pr => `${pr.name} x${pr.quantity}`).join(", "), fuente: "TN aplanado(data.products)" };
  const man = await client.query("SELECT productos FROM pedidos_manuales WHERE id=$1", [id]);
  if (man.rows[0]) return { productos: man.rows[0].productos || "", fuente: "manual(pedidos_manuales.productos)" };
  return { productos: "", fuente: "ninguna(pedido no encontrado)" };
}

// localDePedido — mirror VERBATIM de server.js (tab_manual override > auto).
async function localDePedido(id, client) {
  const est = await client.query("SELECT tab_manual FROM pedidos_estados WHERE id=$1", [id]);
  const tabManual = est.rows[0]?.tab_manual || null;
  const tn = await client.query("SELECT data FROM pedidos_tn WHERE id::text=$1", [id]);
  if (tn.rows[0]) return localLabelBackend(tabManual || clasificarPedidoBackend(tn.rows[0].data));
  const man = await client.query("SELECT tab_actual FROM pedidos_manuales WHERE id=$1", [id]);
  if (man.rows[0]) return localLabelBackend(tabManual || man.rows[0].tab_actual);
  return null;
}

// Mismo descuento que server.js, pero recibe el client de la txn de test.
async function descontarStockDePedido(id, client) {
  const claim = await client.query(
    `INSERT INTO pedidos_estados (id, stock_descontado, updated_at)
     VALUES ($1, true, NOW())
     ON CONFLICT (id) DO UPDATE SET stock_descontado = true, updated_at = NOW()
     WHERE pedidos_estados.stock_descontado = false`,
    [id]
  );
  if (claim.rowCount === 0) return { noop: true };

  const local = await localDePedido(id, client);
  const { productos: productosStr, fuente } = await productosStringDePedido(id, client);
  const lineas = parsearProductosBackend(productosStr);

  // ── LOGGING TEMPORAL (diagnóstico) ──────────────────────────────────
  console.log(`   [diag pedido=${id}]`);
  console.log(`     (a) string="${productosStr}"  | fuente=${fuente}`);
  console.log(`     (b) lineas=${JSON.stringify(lineas.map(l => ({ clave_producto: l.clave, cantidad: l.cantidad })))}`);
  console.log(`     (c) local=${JSON.stringify(local)}`);

  const demanda = {};
  for (const { clave, cantidad } of lineas) demanda[clave] = (demanda[clave] || 0) + cantidad;

  const consumo = [], faltantes = [];
  if (local) {
    for (const clave of Object.keys(demanda)) {
      let restante = demanda[clave];
      const lotes = await client.query(
        `SELECT id, cantidad_disponible FROM stock_lotes
         WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0
         ORDER BY fecha_produccion ASC, id ASC
         FOR UPDATE`,
        [local, clave]
      );
      for (const lote of lotes.rows) {
        if (restante <= 0) break;
        const usar = Math.min(restante, Number(lote.cantidad_disponible));
        await client.query("UPDATE stock_lotes SET cantidad_disponible = cantidad_disponible - $1 WHERE id=$2", [usar, lote.id]);
        restante -= usar;
      }
      consumo.push({ clave, cantidad: demanda[clave], descontado: demanda[clave] - restante });
      if (restante > 0) faltantes.push({ clave, falto: restante });
    }
  }
  return { noop: false, local, consumo, faltantes };
}

// GET /api/stock?local= (misma query/agrupado que el endpoint)
async function getStock(client, local) {
  const params = [];
  let filtro = "cantidad_disponible > 0";
  if (local) { params.push(local); filtro += ` AND local = $${params.length}`; }
  const r = await client.query(
    `SELECT clave_producto, local,
            to_char(fecha_produccion, 'YYYY-MM-DD') AS fecha_produccion,
            SUM(cantidad_disponible)::int AS cantidad
     FROM stock_lotes WHERE ${filtro}
     GROUP BY clave_producto, local, fecha_produccion
     ORDER BY clave_producto ASC, fecha_produccion ASC`,
    params
  );
  const map = {};
  for (const row of r.rows) {
    if (!map[row.clave_producto]) map[row.clave_producto] = { clave_producto: row.clave_producto, total_disponible: 0, porFecha: [] };
    map[row.clave_producto].total_disponible += Number(row.cantidad);
    map[row.clave_producto].porFecha.push({ fecha_produccion: row.fecha_produccion, local: row.local, cantidad: Number(row.cantidad) });
  }
  return Object.values(map);
}

// POST /api/stock/descartar — mirror del endpoint (FIFO; fecha opcional = lote puntual).
async function descartarStock(client, local, clave, cantidad, fecha) {
  const params = [local, clave];
  let filtroFecha = "";
  if (fecha) { params.push(fecha); filtroFecha = ` AND fecha_produccion = $${params.length}`; }
  const lotes = await client.query(
    `SELECT id, cantidad_disponible FROM stock_lotes
     WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0${filtroFecha}
     ORDER BY fecha_produccion ASC, id ASC
     FOR UPDATE`,
    params
  );
  let restante = cantidad;
  for (const lote of lotes.rows) {
    if (restante <= 0) break;
    const usar = Math.min(restante, Number(lote.cantidad_disponible));
    await client.query("UPDATE stock_lotes SET cantidad_disponible = cantidad_disponible - $1 WHERE id=$2", [usar, lote.id]);
    restante -= usar;
  }
  const tot = await client.query(
    `SELECT COALESCE(SUM(cantidad_disponible),0)::int AS total FROM stock_lotes
     WHERE local=$1 AND clave_producto=$2 AND cantidad_disponible > 0`,
    [local, clave]
  );
  return { descartado: cantidad - restante, total: tot.rows[0].total };
}

// ── Test harness ──────────────────────────────────────────────────────
let pass = 0, fail = 0;
function check(label, cond, extra = "") {
  if (cond) { pass++; console.log(`  [OK]   ${label}`); }
  else { fail++; console.log(`  [FAIL] ${label} ${extra}`); }
}

const PEDIDO = "__smoke_stock__";
const LOCAL = "A. Thomas";
const OTRO_LOCAL = "French";
const AYER = "2026-06-19";
const HOY = "2026-06-20";

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
const client = await pool.connect();

try {
  await client.query("BEGIN");
  console.log("== TXN abierta (todo se revierte al final) ==\n");

  // Limpieza defensiva por si una corrida previa abortó sin rollback.
  await client.query("DELETE FROM stock_lotes WHERE clave_producto IN ('Picada Premium','Vino Malbec') AND clave_producto LIKE '%' AND local IN ($1,$2) AND fecha_produccion IN ($3,$4) AND COALESCE(usuario_id,-1) = -1", [LOCAL, OTRO_LOCAL, AYER, HOY]).catch(() => {});
  await client.query("DELETE FROM pedidos_estados WHERE id=$1", [PEDIDO]);
  await client.query("DELETE FROM pedidos_manuales WHERE id=$1", [PEDIDO]);

  // 1) Seed: pedido manual + estado inicial (sin descontar)
  console.log("1) Seed pedido + producir lotes");
  await client.query(
    `INSERT INTO pedidos_manuales (id, numero, productos, total_num, total, tab_actual, local)
     VALUES ($1,'#SMOKE','Picada Premium x3, Vino Malbec x2', 0, '$0', 'delivery-at', 'A. Thomas')`,
    [PEDIDO]
  );
  await client.query("INSERT INTO pedidos_estados (id, estado, stock_descontado) VALUES ($1,'Por empaquetar', false)", [PEDIDO]);

  // Lotes: Picada Premium -> ayer x2, hoy x5 (FIFO debe gastar ayer primero)
  //        Vino Malbec    -> hoy x1 (demanda 2 -> faltante 1, best-effort)
  //        Picada Premium en OTRO local -> hoy x99 (no se debe tocar)
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,'Picada Premium',$2,2)", [LOCAL, AYER]);
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,'Picada Premium',$2,5)", [LOCAL, HOY]);
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,'Vino Malbec',$2,1)", [LOCAL, HOY]);
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,'Picada Premium',$2,99)", [OTRO_LOCAL, HOY]);

  // 2) GET /api/stock?local=A. Thomas  -> agrupado con porFecha
  console.log("\n2) GET /api/stock?local=A. Thomas (antes de descontar)");
  const antes = await getStock(client, LOCAL);
  console.log("   " + JSON.stringify(antes));
  const picAntes = antes.find(p => p.clave_producto === "Picada Premium");
  check("Picada Premium total = 7", picAntes?.total_disponible === 7, `got ${picAntes?.total_disponible}`);
  check("Picada Premium desglosada en 2 fechas", picAntes?.porFecha.length === 2);
  check("porFecha ordenada ayer->hoy", picAntes?.porFecha[0].fecha_produccion === AYER && picAntes?.porFecha[1].fecha_produccion === HOY);
  check("No aparece el lote de French (filtro local)", !antes.some(p => p.porFecha.some(f => f.local === OTRO_LOCAL)));

  // 3) Descontar (simula tanda->en_reparto / cambio a En camino)
  console.log("\n3) Descontar stock del pedido (despacho)");
  const r1 = await descontarStockDePedido(PEDIDO, client);
  console.log("   " + JSON.stringify(r1));
  check("local detectado = A. Thomas", r1.local === LOCAL, `got ${r1.local}`);
  check("Picada Premium descontó 3", r1.consumo.find(c => c.clave === "Picada Premium")?.descontado === 3);
  check("Vino Malbec descontó solo 1 (best-effort)", r1.consumo.find(c => c.clave === "Vino Malbec")?.descontado === 1);
  check("Faltante registrado: Vino Malbec falto 1", r1.faltantes.find(f => f.clave === "Vino Malbec")?.falto === 1);

  // 4) GET de nuevo -> FIFO gastó el lote viejo primero
  console.log("\n4) GET /api/stock?local=A. Thomas (después)");
  const despues = await getStock(client, LOCAL);
  console.log("   " + JSON.stringify(despues));
  const picDespues = despues.find(p => p.clave_producto === "Picada Premium");
  check("Picada Premium total 7 -> 4", picDespues?.total_disponible === 4, `got ${picDespues?.total_disponible}`);
  check("FIFO: lote de AYER agotado (desaparece)", !picDespues?.porFecha.some(f => f.fecha_produccion === AYER));
  check("FIFO: lote de HOY intacto en 5... menos lo extra", picDespues?.porFecha.find(f => f.fecha_produccion === HOY)?.cantidad === 4);
  check("Vino Malbec agotado (no aparece)", !despues.some(p => p.clave_producto === "Vino Malbec"));
  const flag = await client.query("SELECT stock_descontado FROM pedidos_estados WHERE id=$1", [PEDIDO]);
  check("stock_descontado = true tras descontar", flag.rows[0]?.stock_descontado === true);

  // 5) Idempotencia: segundo disparo no debe descontar otra vez
  console.log("\n5) Segundo disparo (idempotencia / claim atómico)");
  const r2 = await descontarStockDePedido(PEDIDO, client);
  console.log("   " + JSON.stringify(r2));
  check("Segundo descuento es no-op", r2.noop === true);
  const despues2 = await getStock(client, LOCAL);
  const picDespues2 = despues2.find(p => p.clave_producto === "Picada Premium");
  check("Stock NO cambió en el segundo disparo", picDespues2?.total_disponible === 4, `got ${picDespues2?.total_disponible}`);

  // 6) producir SIEMPRE inserta lote nuevo (no upsert)
  console.log("\n6) POST /api/stock/producir inserta lote nuevo");
  const cntPre = await client.query("SELECT COUNT(*)::int n FROM stock_lotes WHERE local=$1 AND clave_producto='Picada Premium'", [LOCAL]);
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,'Picada Premium',$2,10)", [LOCAL, HOY]);
  const cntPost = await client.query("SELECT COUNT(*)::int n FROM stock_lotes WHERE local=$1 AND clave_producto='Picada Premium'", [LOCAL]);
  check("Cantidad de lotes +1 (nuevo, no upsert)", cntPost.rows[0].n === cntPre.rows[0].n + 1);

  // 7) MISMA función de lectura/parseo contra un PEDIDO REAL reciente con productos.
  //    Solo se loguea el read+parse (a/b/c); NO se descuenta nada real (no hay lotes
  //    reales sembrados y de todos modos va a ROLLBACK).
  console.log("\n7) Pedido REAL reciente (comparación)");
  const reales = await client.query(
    `SELECT id::text AS id, data FROM pedidos_tn
     WHERE jsonb_array_length(COALESCE(data->'products','[]'::jsonb)) > 0
     ORDER BY tn_created_at DESC LIMIT 1`
  );
  if (!reales.rows[0]) {
    console.log("   (no hay pedidos_tn con products; salteo la comparación real)");
  } else {
    const realId = reales.rows[0].id;
    const localReal = await localDePedido(realId, client);
    const { productos: strReal, fuente: fuenteReal } = await productosStringDePedido(realId, client);
    const lineasReal = parsearProductosBackend(strReal);
    console.log(`   [diag pedido=${realId} (REAL)]`);
    console.log(`     (a) string="${strReal}"  | fuente=${fuenteReal}`);
    console.log(`     (b) lineas=${JSON.stringify(lineasReal.map(l => ({ clave_producto: l.clave, cantidad: l.cantidad })))}`);
    console.log(`     (c) local=${JSON.stringify(localReal)}`);
    check("Pedido real parsea al menos 1 línea", lineasReal.length > 0, `(si falla, el bug está en la función; si pasa, estaba en el seed/replica)`);
  }

  // ── DESCARTE de stock (merma de perecederos) ────────────────────────
  // Producto fresco para no interferir con los pasos de descuento anteriores.
  const CLAVE_D = "Tabla Descarte Test";
  console.log("\n8) Descarte — seed lotes frescos (ayer x2, hoy x5)");
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,$2,$3,2)", [LOCAL, CLAVE_D, AYER]);
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,$2,$3,5)", [LOCAL, CLAVE_D, HOY]);

  // 1) FIFO general: descartar 3 sin fecha -> gasta ayer(2) + hoy(1), queda hoy x4
  console.log("\n9) Descarte FIFO general (3 sin fecha)");
  const d1 = await descartarStock(client, LOCAL, CLAVE_D, 3, "");
  console.log("   " + JSON.stringify(d1));
  check("Descartó 3", d1.descartado === 3, `got ${d1.descartado}`);
  check("Total 7 -> 4", d1.total === 4, `got ${d1.total}`);
  const post1 = (await getStock(client, LOCAL)).find(p => p.clave_producto === CLAVE_D);
  check("FIFO: lote de AYER agotado (gastado primero)", !post1?.porFecha.some(f => f.fecha_produccion === AYER));
  check("FIFO: HOY queda en 4", post1?.porFecha.find(f => f.fecha_produccion === HOY)?.cantidad === 4);

  // 2) Fecha puntual: re-seed AYER x2 (vuelve a haber 2 fechas: ayer 2, hoy 4) y
  //    descartar 2 indicando HOY -> toca solo ese lote, no el de ayer.
  console.log("\n10) Descarte de fecha puntual (2 de HOY, no toca AYER)");
  await client.query("INSERT INTO stock_lotes (local, clave_producto, fecha_produccion, cantidad_disponible) VALUES ($1,$2,$3,2)", [LOCAL, CLAVE_D, AYER]);
  const d2 = await descartarStock(client, LOCAL, CLAVE_D, 2, HOY);
  console.log("   " + JSON.stringify(d2));
  check("Descartó 2", d2.descartado === 2, `got ${d2.descartado}`);
  const post2 = (await getStock(client, LOCAL)).find(p => p.clave_producto === CLAVE_D);
  check("AYER intacto en 2 (no se tocó)", post2?.porFecha.find(f => f.fecha_produccion === AYER)?.cantidad === 2);
  check("HOY bajó 4 -> 2", post2?.porFecha.find(f => f.fecha_produccion === HOY)?.cantidad === 2);

  // 3) Best-effort: pedir más de lo que hay (total 4) -> baja a 0, descarta solo 4.
  console.log("\n11) Descarte best-effort (pedir de más)");
  const d3 = await descartarStock(client, LOCAL, CLAVE_D, 99, "");
  console.log("   " + JSON.stringify(d3));
  check("Descartó solo lo disponible (4)", d3.descartado === 4, `got ${d3.descartado}`);
  check("Total queda en 0", d3.total === 0, `got ${d3.total}`);
  check("Producto desaparece del stock (>0)", !(await getStock(client, LOCAL)).some(p => p.clave_producto === CLAVE_D));

  // 4) Auditoria: el endpoint registra accion='stock_descarte'. Lo replicamos y verificamos.
  console.log("\n12) Auditoria stock_descarte");
  await client.query(
    "INSERT INTO auditoria (usuario, accion, entidad_tipo, entidad_id, detalle) VALUES ($1,$2,$3,$4,$5)",
    ["Smoke", "stock_descarte", "stock", CLAVE_D, JSON.stringify({ local: LOCAL, producto: CLAVE_D, cantidad: 4 })]
  );
  const aud = await client.query("SELECT 1 FROM auditoria WHERE accion='stock_descarte' AND entidad_id=$1 LIMIT 1", [CLAVE_D]);
  check("Quedó registro accion='stock_descarte'", aud.rowCount === 1);

  console.log(`\n== RESUMEN: ${pass} OK, ${fail} FAIL ==`);
} catch (e) {
  fail++;
  console.error("\nERROR inesperado:", e.message);
} finally {
  await client.query("ROLLBACK");
  console.log("== TXN revertida (ROLLBACK) — base intacta ==");
  client.release();
  await pool.end();
  process.exit(fail > 0 ? 1 : 0);
}
