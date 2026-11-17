-- ═══════════════════════════════════════════════════════════════════════════════════════════════
-- Fix de recetas (correr A MANO en Neon → SQL Editor, contra PRODUCCIÓN).
--   1. Vínculos que faltan: "el lomazo" y "lomazo" → receta "Sandwich Lomazo" (ex "Sandwich #1")
--                           "sandwich el gourmet ahumado" → receta "Sandwich Gourmet" (ex "Sandwich #2")
--      (ya corrido en producción el 17/11/2026; vinculos_seed.json tiene los mismos 3 vínculos)
--   2. Pesos mal cargados: Bocconcinos (208) en "Tablita picca tu festejo" y Pepato (211) en
--      "Tablita picca tu encuentro" → modo 'gramos', 32 g, sin peso por unidad, 8 % de desperdicio.
-- recetas_seed.json ya tiene los mismos cambios (nombres nuevos y las dos líneas en gramos).
--
-- CLAVE DEL PRODUCTO: es la misma que arma el server, claveProducto(normalizarProducto(nombre)) de
-- productos-normalizacion.js: saca "Nueva"/"Nueva!" y "MKP", colapsa espacios, corrige "Sutille" →
-- "Suttile" y pasa a minúsculas. La tabla de alias (tamaños de picadas, PiccaChips, etc.) no se aplica
-- acá porque ningún sándwich está en esa tabla. El bloque 1 la muestra para cada nombre encontrado.
--
-- CÓMO CORRERLO
--   a) Bloque 1 solo (son SELECT, no cambian nada). Revisá que los nombres encontrados sean los
--      sándwiches y no otra cosa.
--   b) Bloque 2: termina SIN COMMIT. Ojo: en el SQL Editor de Neon cada ejecución puede ser una sesión
--      aparte, y un COMMIT corrido después por separado puede no encontrar la transacción. Lo seguro:
--      correr el bloque 2 entero con "ROLLBACK;" al final para ver los RETURNING y la verificación;
--      si coincide, volver a correrlo entero con "COMMIT;" al final.
--   Se puede correr dos veces: el rename solo aplica si sigue el nombre viejo, los vínculos tienen
--   ON CONFLICT (producto_clave) DO NOTHING y las líneas solo se tocan si siguen en unidades × 80 g.
-- ═══════════════════════════════════════════════════════════════════════════════════════════════


-- ───────────────────────────── BLOQUE 1: DIAGNÓSTICO (solo lectura) ─────────────────────────────

-- 1.a Nombres de producto en pedidos (TN, manuales y productos editados a mano) que parecen el sándwich
--     Lomazo o el Gourmet, con la clave que usa el server y si ya están vinculados a alguna receta.
--     Excluye las picadas "La Gourmet" y "Quesos del Gourmet".
WITH items AS (
  SELECT 'TN' AS origen, t.id::text AS pedido_id, p->>'name' AS nombre_crudo
    FROM pedidos_tn t
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.data->'products') = 'array' THEN t.data->'products' ELSE '[]'::jsonb END) p
  UNION ALL
  SELECT 'manual', m.id, substring(btrim(it) FROM '^(.+) x[0-9]+$')
    FROM pedidos_manuales m CROSS JOIN LATERAL regexp_split_to_table(COALESCE(m.productos, ''), ', ') it
  UNION ALL
  SELECT 'editado', pp.pedido_id, substring(btrim(it) FROM '^(.+) x[0-9]+$')
    FROM pedidos_productos pp CROSS JOIN LATERAL regexp_split_to_table(COALESCE(pp.productos, ''), ', ') it
), clasif AS (
  SELECT origen, pedido_id, btrim(nombre_crudo) AS nombre_crudo,
         lower(btrim(regexp_replace(
           regexp_replace(
             btrim(regexp_replace(
               regexp_replace(regexp_replace(btrim(nombre_crudo), '\ynueva!?(?=\s|$)', ' ', 'gi'), '\ymkp\y', ' ', 'gi'),
               '\s+', ' ', 'g')),
             '\ysutille\y', 'Suttile', 'gi'),
           '\s+', ' ', 'g'))) AS producto_clave,
         translate(lower(nombre_crudo), 'áéíóúü', 'aeiouu') AS n
    FROM items WHERE nombre_crudo IS NOT NULL
), candidatos AS (
  SELECT *, CASE WHEN n ~ 'lomazo' THEN 'Sandwich Lomazo'
                 WHEN n ~ 'sandwich' AND n ~ 'gourmet' AND n !~ '(la gourmet|quesos del gourmet)' THEN 'Sandwich Gourmet' END AS receta_destino
    FROM clasif
)
SELECT c.receta_destino, c.nombre_crudo, c.producto_clave,
       string_agg(DISTINCT c.origen, ', ') AS origen, COUNT(DISTINCT c.pedido_id) AS pedidos,
       r.nombre AS ya_vinculado_a
  FROM candidatos c
  LEFT JOIN receta_productos rp ON rp.producto_clave = c.producto_clave
  LEFT JOIN recetas r ON r.id = rp.receta_id
 WHERE c.receta_destino IS NOT NULL
 GROUP BY 1, 2, 3, 6
 ORDER BY 1, 2;

-- 1.b Las recetas de sándwich (nombre viejo o nuevo) y sus vínculos actuales.
SELECT r.id, r.nombre, r.tipo, r.activo, rp.producto_nombre, rp.producto_clave
  FROM recetas r LEFT JOIN receta_productos rp ON rp.receta_id = r.id
 WHERE r.nombre IN ('Sandwich #1', 'Sandwich #2', 'Sandwich Lomazo', 'Sandwich Gourmet')
 ORDER BY r.nombre, rp.producto_nombre;

-- 1.c Líneas actuales de las dos tablitas.
SELECT r.nombre AS receta, rl.orden, i.codigo, COALESCE(i.nombre, '[módulo] ' || sr.nombre) AS insumo, i.unidad,
       rl.modo, rl.cantidad, rl.peso_g, i.peso_unidad_g, rl.desperdicio_pct, rl.id AS linea_id
  FROM recetas r JOIN receta_lineas rl ON rl.receta_id = r.id
  LEFT JOIN insumos i ON i.id = rl.insumo_id LEFT JOIN recetas sr ON sr.id = rl.subreceta_id
 WHERE r.nombre IN ('Tablita picca tu festejo', 'Tablita picca tu encuentro')
 ORDER BY r.nombre, rl.orden, rl.id;

-- 1.d OTRAS recetas con Bocconcinos (208) o Pepato (211) a 80 g por unidad (peso de la línea o, si
--     no tiene, el del insumo). Solo para revisar: este script NO las toca.
SELECT r.nombre AS receta, r.activo, i.codigo, i.nombre AS insumo, rl.modo, rl.cantidad, rl.peso_g,
       i.peso_unidad_g, COALESCE(rl.peso_g, i.peso_unidad_g) AS peso_efectivo, rl.id AS linea_id
  FROM receta_lineas rl JOIN recetas r ON r.id = rl.receta_id JOIN insumos i ON i.id = rl.insumo_id
 WHERE i.codigo IN (208, 211) AND rl.modo = 'unidades' AND COALESCE(rl.peso_g, i.peso_unidad_g) = 80
   AND r.nombre NOT IN ('Tablita picca tu festejo', 'Tablita picca tu encuentro')
 ORDER BY i.codigo, r.nombre;


-- ───────────────────────────── BLOQUE 2: CAMBIOS (en transacción) ───────────────────────────────
BEGIN;

-- 2.a Renombrar las recetas (solo si sigue el nombre viejo y el nuevo no está tomado).
UPDATE recetas SET nombre = 'Sandwich Lomazo'
 WHERE nombre = 'Sandwich #1' AND NOT EXISTS (SELECT 1 FROM recetas WHERE lower(nombre) = 'sandwich lomazo')
RETURNING id, nombre AS nombre_nuevo, 'Sandwich #1' AS nombre_viejo;

UPDATE recetas SET nombre = 'Sandwich Gourmet'
 WHERE nombre = 'Sandwich #2' AND NOT EXISTS (SELECT 1 FROM recetas WHERE lower(nombre) = 'sandwich gourmet')
RETURNING id, nombre AS nombre_nuevo, 'Sandwich #2' AS nombre_viejo;

-- 2.b Vínculos con claves FIJAS: las que devolvió 1.a en producción (corrido el 17/11/2026). Se dejó afuera a
--     propósito la fila mezclada "sandwiches a eleccion bondiola,gourmet" (no es un solo producto).
--     Clave = la que arma el server, claveProducto(normalizarProducto(nombre)).
--     Si la clave ya está vinculada (a esta u otra receta) no se toca.
INSERT INTO receta_productos (receta_id, producto_nombre, producto_clave)
SELECT r.id, v.clave, v.clave
  FROM (VALUES ('el lomazo', 'Sandwich Lomazo'),
               ('lomazo', 'Sandwich Lomazo'),
               ('sandwich el gourmet ahumado', 'Sandwich Gourmet')) AS v(clave, receta)
  JOIN recetas r ON r.nombre = v.receta
ON CONFLICT (producto_clave) DO NOTHING
RETURNING id, receta_id, producto_nombre, producto_clave;

-- 2.c Bocconcinos (208) en "Tablita picca tu festejo" y Pepato (211) en "Tablita picca tu encuentro":
--     de unidades × 80 g a 32 g. Solo si la línea sigue como estaba (unidades, peso 80).
UPDATE receta_lineas rl
   SET modo = 'gramos', cantidad = 32, peso_g = NULL, desperdicio_pct = 8
  FROM recetas r, insumos i
 WHERE r.id = rl.receta_id AND i.id = rl.insumo_id
   AND ((r.nombre = 'Tablita picca tu festejo' AND i.codigo = 208) OR (r.nombre = 'Tablita picca tu encuentro' AND i.codigo = 211))
   AND rl.modo = 'unidades' AND rl.peso_g = 80
RETURNING rl.id AS linea_id, r.nombre AS receta, i.codigo, i.nombre AS insumo, rl.modo, rl.cantidad, rl.peso_g, rl.desperdicio_pct;

-- 2.d Verificación: cómo queda todo (esperado: las dos recetas renombradas con sus vínculos; 208 y 211
--     en gramos, 32, peso NULL, 8 %).
SELECT 'receta' AS que, r.nombre AS receta, rp.producto_nombre AS detalle, rp.producto_clave AS clave_o_valor
  FROM recetas r LEFT JOIN receta_productos rp ON rp.receta_id = r.id
 WHERE r.nombre IN ('Sandwich #1', 'Sandwich #2', 'Sandwich Lomazo', 'Sandwich Gourmet')
UNION ALL
SELECT 'linea', r.nombre, i.codigo || ' ' || i.nombre,
       rl.modo || ' · ' || rl.cantidad || ' · peso ' || COALESCE(rl.peso_g::text, 'NULL') || ' · desp ' || rl.desperdicio_pct || '%'
  FROM receta_lineas rl JOIN recetas r ON r.id = rl.receta_id JOIN insumos i ON i.id = rl.insumo_id
 WHERE (r.nombre = 'Tablita picca tu festejo' AND i.codigo = 208) OR (r.nombre = 'Tablita picca tu encuentro' AND i.codigo = 211)
 ORDER BY 1 DESC, 2, 3;

-- si coincide: COMMIT; si no: ROLLBACK;
