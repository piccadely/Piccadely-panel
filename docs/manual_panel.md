# Manual del Panel de Piccadely

Manual de uso del panel interno (pedidos, caja, stock, compras, etc.). Es también la fuente de conocimiento del asistente 💬 del panel.
Regla: toda feature que agregue o cambie una pantalla, botón o flujo actualiza este manual en el mismo commit.

Convenciones: lo que está entre comillas es el texto exacto que aparece en pantalla. "☰" es el menú de tres rayitas arriba a la derecha. "Tarjeta del pedido" es el detalle que se abre al tocar la fila de un pedido.

---

## 1. Roles y qué ve cada uno

Debajo del nombre, arriba a la derecha, se ve el rol: "Superadmin", "Admin", "Encargado", "Solo lectura", "Comercial", "A. Thomas" o "French".

| Rol | Qué puede hacer |
|---|---|
| Superadmin | Todo. Es el único que ve 🏦 Tesorería, 📒 Contable (libros de ventas y compras), 👥 RRHH (empleados, liquidaciones, sueldos, adelantos), la caja "Administración" y la bandeja "Sobres". Es el único que crea o edita usuarios admin y superadmin. |
| Admin | Todo lo operativo + 🛠️ Administración (usuarios, repartidores, resincronizar TN), 🛒 Compras, 📦 Stock completo (incluye 🧾 Insumos y editar recetas), reportes de plata (dashboard, ventas, vendido/por vender, pedidos por zona), 👥 Clientes, 💼 Ventas a realizar, 📥 Importar pedidos, ⚙️ Configuración WhatsApp, "🔄 Transferir" entre cajas. No ve Tesorería, Contable ni RRHH. |
| Encargado | Pedidos, caja de los dos locales, 📦 Stock (ver stock, ingreso de mercadería, recuento; recetas solo para ver), cocina, producción, tandas, WhatsApp, reportes de reservas y productos vendidos. |
| Solo lectura | Puede VER pedidos, caja, stock y reportes, pero no puede modificar nada. No ve la pestaña "➕ Nuevo pedido" ni los botones de acción de los pedidos. Algunos botones (en caja, cocina y en los campos de la tarjeta del pedido) se ven pero al usarlos no guardan. |
| Comercial (crm) | Solo "📋 Pedidos" (ver), "➕ Nuevo pedido", "👥 Clientes" y "💼 Ventas a realizar". No puede facturar, imprimir, generar links de pago, editar productos ni anular. En cualquier otra pantalla ve "Sin acceso". |
| Operario de sucursal (A. Thomas / French) | Pedidos de las 4 pestañas (cargar, avanzar estados, imprimir comandas, facturar, link de pago, anular, tandas), la caja de SU local y el fondo fijo de su local, 🍳 Tablero de cocina, 🔧 Análisis de producción, mapa, pedidos finalizados, WhatsApp, reportes de reservas y productos vendidos. No ve 📦 Stock, Compras, RRHH, Tesorería ni Administración. |

Sesión de emergencia: si el sistema de mail está caído y no llega el código de ingreso, se puede entrar en "modo solo lectura" de emergencia: solo se ven los pedidos, sin menú ☰. Aparece la franja "🔒 MODO SOLO LECTURA — el sistema de mail está caído. Solo podés ver los pedidos. Facturación, caja y reportes no están disponibles." (El rol Solo lectura también ve esa franja, aunque el mail funcione.)

### Menú ☰ (según rol)
- "🛠️ Administración" (admin y superadmin): "👥 Usuarios", "🚚 Repartidores", "🏦 Tesorería" (solo superadmin), "🔄 Resincronizar TN", "🗓️ Corregir pedidos sin fecha", "🗑️ Anular pedidos viejos".
- "📊 Reportes": "📈 Dashboard ejecutivo" (admin), "📊 Reporte de ventas" (admin), "📅 Reporte de reservas", "📦 Productos vendidos", "🧾 Vendido / Por vender" (admin), "📍 Pedidos por zona" (admin).
- "📒 Contable" (superadmin): "📕 Libro de ventas", "📗 Libro de compras".
- "👥 RRHH" (superadmin): "🧑‍🍳 Empleados", "🧾 Liquidaciones", "➕ Novedades", "📊 Costo de personal".
- "🛒 Compras" (admin y superadmin): "📋 Órdenes de compra", "🧾 Facturas de compra", "💳 Cuentas por pagar", "💸 Pagos", "🏭 Proveedores", "🏷️ Categorías de gasto", "🧾 Gastos comunes", "🏷️ Categorías de gastos comunes".
- "📦 Stock" (admin, superadmin, encargado, solo lectura): "📦 Stock actual", "📥 Ingreso de mercadería" (admin/encargado), "📋 Recuento" (admin/encargado), "📖 Recetas", "🧮 Productos necesarios", "📦 Productos utilizados", "🧾 Insumos" (admin).
- "💬 WhatsApp", "📋 Plantillas de WhatsApp", "⚙️ Configuración WhatsApp" (admin).
- "👥 Clientes" y "💼 Ventas a realizar" (admin; el comercial los tiene en su menú).
- "🚚 Tandas activas", "💰 Caja", "📥 Importar pedidos" (admin), "📋 Pedidos finalizados", "🔧 Análisis de producción", "🍳 Tablero de cocina", "🗺️ Mapa de pedidos", "← Volver al panel".

---

## 2. Pedidos

### 2.1 Pestañas y en qué pestaña cae cada pedido
Pestañas: "🏪 Retiro A. Thomas", "🏪 Retiro French", "🚚 Delivery A. Thomas", "🚚 Delivery French", "➕ Nuevo pedido". Cada una muestra cuántos pedidos activos tiene. Las pestañas de A. Thomas son del local A. Thomas y las de French del local French: ese local es el que usan caja, stock, comandas en lote, tandas y facturación.

Reglas de Tienda Nube (TN):
- Todo DELIVERY de Tienda Nube va a "🚚 Delivery A. Thomas": el delivery sale siempre de Álvarez Thomas. Si un pedido mezcla envío y retiro, cuenta como delivery.
- Los RETIROS van al local del punto de retiro que eligió el cliente (A. Thomas o French). Si no se reconoce el punto, va a "🏪 Retiro A. Thomas".
- Si alguien cambia la sección a mano con "Mover a sección", eso manda sobre la regla.
- Pedido manual: va a la sección elegida en "ELEGIR SUCURSAL" al cargarlo.

Los pedidos de Tienda Nube entran solos (el panel se refresca cada 30 segundos). Cuando entra uno nuevo suena un doble beep y el título de la pestaña del navegador muestra "🔔 1 nuevo - Piccadely". El refresco automático trae pedidos nuevos, pero NO los cambios de estado que hace otra persona: si trabajan dos a la vez, recargá la página para ver lo que cambió el otro.

### 2.2 La lista de pedidos
- Filtros: "Todas las fechas" y "Todas las zonas". No hay buscador por nombre: para encontrar un pedido usá los filtros, revisá la otra pestaña/local o buscalo en "📋 Pedidos finalizados".
- Arriba: "Total", "Pendientes", "En camino", "Listos".
- Los pedidos se agrupan por fecha y franja horaria; los "Sin fecha" van primero y el grupo de hoy tiene encabezado verde oscuro.
- Botones de la barra (no para solo lectura ni comercial): "🖨️ IMPRIMIR COMANDAS", "📦 Armar tanda", "🚚 Tandas activas".

Etiquetas de la fila:
- "T3" (violeta): el pedido está en la tanda #3.
- "⚠️ REVISAR PAGO" (rojo): pedido de Tienda Nube con el pago NO aprobado. Verificá antes de entregar. Cuando TN aprueba el pago pasa solo a "Pagado".
- "● NUEVO" (verde): nunca se imprimió su comanda (no quiere decir que llegó recién). Desaparece al imprimir.
- "COBRAR" (rojo): está marcado "Cobrar en entrega".
- "MANUAL": cargado a mano en el panel. "EDITADO": se le editaron los productos.
- "FACTURA A": el cliente de Tienda Nube pidió factura con CUIT.
- "📅 SIN FECHA: cargala": no tiene fecha de entrega. Si tiene nota del cliente, se muestra debajo ("📝 Nota del cliente: …"), que suele traer el día y horario.
- Ícono de sobre al final: tarjeta de regalo (tarjeta con mensaje). Cada toque cambia: gris "No lleva tarjeta" → rojo "Lleva tarjeta — pendiente" → verde "Tarjeta hecha".

Colores de alerta (solo pedidos de HOY en "Por empaquetar" o "Listo"; se mide contra la hora de INICIO de la franja):
- Rojo fuerte con borde bordó: ya pasó la hora de inicio de la franja.
- Rosado con borde rojo: falta 1 hora o menos.
- Violeta clarito: pedido corporativo (manual).
- Un pedido sin franja o sin fecha no tiene alerta.

### 2.3 Tarjeta del pedido (tocar la fila)
Sección "📋 Datos del pedido (guardado automático al salir del campo)": no hay botón Guardar; los textos se guardan al salir del campo y los desplegables al cambiar.
- Campos: "Cliente", "Teléfono", "Dirección", "Barrio", "Zona", "Área (opcional)" (Área 1 a Área 10, para el reporte por zona), "Email", "Medio de pago" (si elegís "Otro" aparece "¿Cuál? (ej: Cheque, Canje)"), "Nota", "Código MKP".
- Solo lectura: "Productos" (para cambiarlos: "✏️ Editar productos"), "Pago" (Pagado / Pendiente), "🎟️ Cupón", "ID Transacción MP".
- Solo en pedidos manuales: "Tipo de pedido" → "🏢 Pedido corporativo".
- En pedidos de Tienda Nube, lo que edites queda en el panel; en Tienda Nube no cambia nada.

Sección "⚙️ Operaciones":
- "Cobrar en entrega" (al marcarlo dice "⚠️ COBRAR").
- "Repartidor" (la lista la carga un admin en 🛠️ Administración → "🚚 Repartidores").
- "Estado" + botón para avanzar.
- "Fecha de entrega" y "Horario de entrega" (texto, ej: "14:00 – 16:00"; empezalo con la hora para que funcionen las alertas y los turnos).
- "Mover a sección": "Retiro A. Thomas", "Retiro French", "Delivery A. Thomas", "Delivery French". Cambia la pestaña y el local del pedido.
- Ojo: si vaciás la fecha, el horario o la sección, NO se borra lo que estaba; solo se puede cambiar por otro valor.

Botones (no para solo lectura ni comercial): "🖨️ Imprimir comanda", "✏️ Editar productos", "🧾 Facturar" (o "🗑 Anular factura" si ya tiene factura), "💳 Enviar link de pago", "🚫 Anular pedido". Y "📜 Historial" (quién hizo qué).

Código MKP: es el código del pago (Mercado Pago, Rappi, PedidosYa…). Al cargarlo se desmarca "Cobrar en entrega"; si lo borrás y el medio es Mercado Pago, Rappi, MP Delivery o Pedidos Ya, se vuelve a marcar.

### 2.4 Estados
Orden: "Por empaquetar" → "Listo" → "En camino" → "Entregado".
1. Abrí la tarjeta del pedido.
2. En "⚙️ Operaciones", tocá el botón "→ Listo" / "→ En camino" / "→ Entregado".
- Si el medio de pago es Mercado Pago, Rappi, MP Delivery o Pedidos Ya y no tiene "Código MKP", aparece "⚠️ FALTA CÓDIGO … ¿Cambiar el estado igual?". Cargá el código o aceptá si ya verificaste el pago.
- Al pasar a "Entregado" el pedido sale de la lista y va a "📋 Pedidos finalizados".
- No se puede volver a un estado anterior desde la lista (por ejemplo de "Listo" a "Por empaquetar"). La única vuelta atrás es "🔄 Reabrir pedido" desde Pedidos finalizados, que lo deja en "En camino".
- Al pasar a "En camino" o "Entregado" se descuenta el stock de cocina del local y, si el local tiene activo el descuento automático, los insumos por receta (ver 📦 Stock).

### 2.5 Anular un pedido
1. Abrí la tarjeta del pedido → "🚫 Anular pedido".
2. Si el pedido tiene una factura activa, aparece "⚠️ Este pedido tiene una factura activa. Primero anulá la factura con nota de crédito desde el botón 🧾 Facturar." No se anula: primero tocá "🗑 Anular factura" (emite la nota de crédito, ver 4.3) y después volvé a "🚫 Anular pedido".
3. Escribí el "Motivo de la anulación:" (obligatorio, texto libre). Si lo dejás vacío o cancelás, no se anula.
4. El pedido pasa a "Anulado" y queda en "📋 Pedidos finalizados" → "🚫 Anulados", con su "Motivo de anulación".
Reglas:
- Si es un pedido manual con email, el cliente recibe un mail de cancelación. A los de Tienda Nube no se les manda.
- Anular NO devuelve plata en Mercado Pago, NO cancela el pedido en Tienda Nube y NO toca la caja: eso se hace aparte.
- Si se habían descontado insumos por receta, se devuelven solos. El stock de cocina (picadas hechas) no se devuelve solo: si vuelven a estar disponibles, cargalas con "Marcar realizadas" en el Tablero de cocina.
- Pedido CANCELADO EN TIENDA NUBE: en el panel sigue activo. Hay que anularlo también en el panel con "🚫 Anular pedido".

### 2.6 Reabrir un pedido entregado o anulado
1. ☰ → "📋 Pedidos finalizados" → pestaña "✅ Entregados" o "🚫 Anulados".
2. Tocá el pedido → "🔄 Reabrir pedido".
3. Confirmá. Si la caja de ese local y día ya está cerrada, avisa que reabrir puede modificar ese cierre.
4. El pedido vuelve al panel en estado "En camino".

### 2.7 Pedidos finalizados
☰ → "📋 Pedidos finalizados" (todos menos comercial).
- Filtros "Desde" / "Hasta" (por defecto últimos 7 días), atajos "Esta semana", "Últimos 7 días", "Este mes", "Mes pasado", "Todos los repartidores", "Todos los locales", "✕ Limpiar" (toda la historia), "📊 Excel", "📄 PDF".
- Pestañas "✅ Entregados" y "🚫 Anulados".
- En la tarjeta se pueden corregir "Medio de pago", "Cobrar en entrega" y "Código MKP" (si la caja de ese día está cerrada, pide confirmación porque cambia el cierre), y están "🖨️ Imprimir comanda", "🔄 Reabrir pedido" y "🧾 Facturar".

### 2.8 Tandas de reparto
Una tanda es un grupo de pedidos de UN local que sale con UN repartidor. Un pedido solo puede estar en una tanda.

Armar una tanda desde la lista:
1. Entrá a la pestaña del local (por ejemplo "🚚 Delivery A. Thomas").
2. Tocá "📦 Armar tanda". Aparece una casilla al lado de cada pedido de ese local que no esté en otra tanda.
3. Marcá los pedidos.
4. Abajo aparece la barra "N pedido(s) de … seleccionado(s)". Tocá "Crear tanda nueva (N)" (o elegí una tanda existente en "Agregar a tanda…" para sumarlos a una que todavía no salió).
5. En "📦 Nueva tanda", elegí el "Repartidor *" (obligatorio) y si querés un "Nombre (opcional)" (ej: "Recorrido centro").
6. Tocá "Crear tanda". Los pedidos muestran la etiqueta "T" con el número de tanda. Todavía no cambian de estado.

Armar una tanda desde el mapa: ☰ → "🗺️ Mapa de pedidos" → elegí la sucursal (no funciona con "Ambas sucursales") → tocá los pins de los pedidos → "📦 Armar tanda (N)" → repartidor → "Crear tanda".

Despachar y cerrar la tanda: ☰ → "🚚 Tandas activas" (o el botón "🚚 Tandas activas" de la lista), elegí el local ("A. Thomas" / "French"):
- "🛵 Despachar": la tanda pasa a "En reparto" y TODOS sus pedidos pasan a "En camino" con el repartidor de la tanda.
- "✅ Marcar entregada": todos sus pedidos pasan a "Entregado".
- "↩️ Deshacer": deshace la tanda; los pedidos quedan sueltos y conservan su estado.
- "✕ Quitar de la tanda": saca un pedido.
- A una tanda ya despachada no se le pueden agregar pedidos ("La tanda ya fue despachada; no se le pueden agregar pedidos.").

### 2.9 Comandas
- Individual: tarjeta del pedido → "🖨️ Imprimir comanda". El círculo naranja dice cuántas veces se imprimió. No cambia el estado.
- En lote: "🖨️ IMPRIMIR COMANDAS" en la barra de la lista. Imprime los pedidos de HOY del local de la pestaña (retiro y delivery de ese local) cuya comanda nunca se imprimió. Pide "¿Imprimir N comanda(s)?". Si está gris es porque no hay pendientes de hoy (los pedidos sin fecha no entran).
- Imprime directo en la térmica si la PC tiene QZ Tray abierto. Si no, abre una ventana del navegador para imprimir; si sale "El navegador bloqueó la ventana de impresión…", habilitá las ventanas emergentes (pop-ups) para el panel.
- La comanda dice "** COBRAR EN ENTREGA **" si el pedido tiene marcado cobrar.

### 2.10 Mapa de pedidos
☰ → "🗺️ Mapa de pedidos" (todos menos comercial). Muestra los pedidos de DELIVERY activos de la fecha elegida cuya dirección se pudo ubicar. Gris = Por empaquetar, naranja = Listo, azul = En camino, violeta "T" = en tanda. Tocá un pin para ver el detalle. Los retiros no aparecen.

### 2.11 Menú 🛠️ Administración (admin y superadmin)
- "🔄 Resincronizar TN": vuelve a traer todos los pedidos de Tienda Nube (1-2 minutos). Sirve si falta un pedido o un pago no se actualizó. No toca estados, repartidores ni lo editado en el panel.
- "🗓️ Corregir pedidos sin fecha": a los pedidos MANUALES sin fecha les pone su fecha de creación (los de Tienda Nube se saltean). Ojo: los suma a la caja de ese día.
- "🗑️ Anular pedidos viejos": anula todos los pedidos activos con fecha hasta la que indiques (formato AAAA-MM-DD). No manda mails, no toca la caja y NO revisa facturas: usalo con cuidado. Se pueden reabrir uno por uno.

---

## 3. Nuevo pedido manual

Pestaña "➕ Nuevo pedido" (todos menos solo lectura; el comercial también).
1. "👤 Datos del cliente": "Nombre *" (obligatorio), "Teléfono", "Email (opcional, se envía confirmación automática)", "Dirección", "Entre calles", "Barrio", "Zona de entrega" (texto), "Área (opcional)", "Fecha de entrega" (hoy por defecto), "Horario" (desde – hasta; si no cargás los dos queda "Sin franja"), "Medio de pago", "ELEGIR SUCURSAL" (Retiro/Delivery A. Thomas/French), "Nota".
   - Al escribir el teléfono (8 dígitos o más) o el email, busca el cliente: "Cliente encontrado: …". Tocá "📋 Traer datos de … (completa solo lo vacío)" para completar lo que falta. Si hay varios con ese teléfono, elegí cuál.
2. Checkbox "Cobrar en entrega" (se marca solo con Efectivo, Pedidos Ya Efectivo, Mercado Pago, Rappi, MP Delivery y Pedidos Ya; se puede cambiar) y "🏢 Pedido corporativo".
3. "🛒 Catálogo de productos": buscá en "Buscar producto..." (o filtrá por categoría) y tocá "+ Agregar". Agregar dos veces suma cantidad.
4. En "🧾 Pedido": ajustá con "−" / "+" / "✕".
   - "Agregar envío": elegí la zona de envío con su precio (uno solo por pedido).
   - "🏷️ 10% OFF Retiro": descuento del 10% sobre los productos (sin el envío).
   - "+ Producto variable": para algo que no está en el catálogo: "Nombre del producto", "Precio", "Cant" → "+ Agregar variable". Un precio negativo funciona como descuento.
5. Tocá "✅ Crear pedido" (se habilita con nombre y al menos un producto; mientras guarda dice "Creando pedido…"). Sale "✅ Pedido #M… creado correctamente" y el pedido aparece en la pestaña elegida, con etiqueta "MANUAL".
- Si no se pudo guardar, sale en rojo "⚠️ El pedido NO se creó: …" y lo que cargaste queda en el formulario: revisalo y tocá "✅ Crear pedido" de nuevo (no se duplica: si dio error, no quedó nada guardado).
- "📄 Crear cotización": arma un PDF con lo cargado ("Válida hasta", "Empresa (opcional)" → "Descargar PDF"). No crea el pedido.

### Editar productos de un pedido
Tarjeta del pedido → "✏️ Editar productos" → agregá del catálogo o producto variable, ajustá cantidades → "✅ Guardar cambios". El pedido queda "EDITADO" y el nuevo total se usa para el link de pago y la factura. Si el pedido ya estaba facturado, la factura no cambia: anulala con nota de crédito y volvé a facturar.

### Importar pedidos (admin)
☰ → "📥 Importar pedidos" → subí la plantilla .xlsx de Piccadely (solapa «Pedidos») → revisá la vista previa (las filas en rojo no se importan: "falta cliente", "sucursal inválida", "falta producto", "precio inválido", "falta fecha", "fecha inválida") → "✓ Confirmar e importar N". Solo acepta las sucursales "Delivery A. Thomas" y "Delivery French", un producto por fila. Al terminar dice cuántos se crearon y lista los que "No se pudieron crear" con el motivo: esos no quedaron cargados (volvé a importar solo esas filas).

---

## 4. Pagos y facturación

### 4.1 Medios de pago
"Mercado Pago", "Efectivo", "Transferencia", "Rappi", "MP Delivery", "Pedidos Ya", "Pedidos Ya Efectivo", "Otro". Para la caja, solo "Efectivo" y "Pedidos Ya Efectivo" cuentan como efectivo.
No hay "gift card" como medio de pago en el panel (las giftcards son un producto del cotizador de Regalos). Si un cliente paga con algo fuera de la lista, usá "Otro" y escribí cuál en "¿Cuál?".

### 4.2 Link de pago de Mercado Pago
1. Tarjeta del pedido → "💳 Enviar link de pago".
2. Si el pedido no tiene email, se abre "💳 Link de pago MP": escribilo y tocá "Guardar y generar link"; después tocá de nuevo "💳 Enviar link de pago". (En pedidos de Tienda Nube, cargá el email en el campo "Email" de la tarjeta y después generá el link.)
3. El link se genera por el total del pedido y le llega por mail al cliente. Con "📋 Copiar link" lo copiás para mandarlo por WhatsApp, o "🔗 Abrir link MP".
4. Cuando el cliente paga, se marca solo: el pedido queda pagado, se carga el "Código MKP" y el cliente recibe el mail de pago confirmado. En pedidos manuales revisá que se haya desmarcado "Cobrar en entrega"; si sigue "COBRAR", desmarcalo a mano.
Errores: "Error al generar el link de pago" / "Error al conectar con Mercado Pago".

### 4.3 Facturar
1. Tarjeta del pedido (o en Pedidos finalizados) → "🧾 Facturar".
2. Elegí el tipo: "FACTURA B" (consumidor final) o "FACTURA A" (cliente con CUIT). Si el pedido trae CUIT, sugiere sola "⚠️ Este cliente tiene CUIT — se sugiere Factura A". "FACTURA B EXENTO" y "TICKET X": consultá con administración antes de usarlos.
3. Completá "Documento" (DNI/CUIT; para Factura A el CUIT es obligatorio), "Nombre / Razón social", "Email (opcional)" (con documento cargado, le llega la factura por mail), "Domicilio".
4. Revisá el "Detalle de la factura": tiene que decir "✓ Coincide con el total del pedido". Si no coincide, tocá "Editar precios" y ajustá los unitarios. Último recurso: "Facturar en un renglón (sin detalle, por $…)".
5. Tocá "Emitir FACTURA B" (o el tipo elegido). Sale "✅ Comprobante emitido" con el número y "📄 Descargar PDF".
Reglas:
- El punto de venta sale del local de la sección actual del pedido: si hay que moverlo de sección, hacelo ANTES de facturar.
- Un pedido no se puede facturar dos veces mientras tenga una factura activa ("Este pedido ya tiene una factura activa.").
- Los productos editados con "✏️ Editar productos" son los que se facturan.

Anular una factura (nota de crédito):
1. Tarjeta del pedido → "🗑 Anular factura" (abre la facturación) → "🗑 Anular factura".
2. Confirmá "¿Anular este comprobante con nota de crédito?". Se emite la nota de crédito A o B según la factura, por el total, con el punto de venta de la factura original.
3. Sale "✅ Comprobante anulado — ya podés volver a facturar". En "Historial" quedan la factura y la nota de crédito con sus PDF.

Anular un pedido que ya facturé: primero anulá la factura (nota de crédito, arriba) y después "🚫 Anular pedido" con el motivo (ver 2.5).

---

## 5. Caja

☰ → "💰 Caja" (todos menos comercial). Arriba a la derecha elegís la caja ("📍 …"):
- Superadmin: "A. Thomas", "French", "Administración", "Fondo Fijo A. Thomas", "Fondo Fijo French", "Sobres".
- Admin, encargado y solo lectura: las de A. Thomas y French con sus fondos fijos.
- Operario A. Thomas: "A. Thomas" y "Fondo Fijo A. Thomas". Operario French: "French" y "Fondo Fijo French".
Las cajas de local (A. Thomas, French) son diarias: se abren y se cierran cada día. Los fondos fijos y Administración tienen saldo acumulado, sin apertura ni cierre.

### 5.1 Apertura
1. Elegí la caja del local. Si el día no está abierto aparece "🔓 Apertura de caja — …".
2. En "EFECTIVO INICIAL EN CAJA" poné el efectivo con el que arrancás (puede ser 0).
3. Tocá "Abrir caja".

### 5.2 Durante el día
- "📊 Ventas del día": ventas por medio de pago de los pedidos entregados de hoy del local.
- "🏦 Estado de caja": "Monto inicial", "Ventas efectivo" (Efectivo + Pedidos Ya Efectivo), ajustes y "Saldo esperado" = monto inicial + ventas en efectivo + entradas − salidas.
- "+ Ajuste": "↑ Entrada" o "↓ Salida", "Concepto", "Monto" → "Registrar ajuste". Un gasto pagado con efectivo de la caja se carga como "↓ Salida". Un ajuste no se puede borrar: si te equivocaste, cargá otro ajuste en sentido contrario. El concepto se puede corregir con "✎".
- "💼 Sobre" (enviar plata a Administración): "Concepto (opcional)", "Monto" → "Registrar sobre". Sale de la caja del local y queda "en tránsito" hasta que el superadmin lo recibe.
- "📋 Movimientos del día" lista todo; los movimientos automáticos tienen "🔒" y no se editan.

### 5.3 Cierre de caja
1. Antes de cerrar, todos los pedidos del local de hoy (y de días anteriores) tienen que estar "Entregado" o "Anulado". Si no, aparece "No se puede cerrar la caja todavía. Tenés N pedido(s) activo(s)…": finalizalos o pasalos a otra fecha.
2. Contá el efectivo físico y escribilo en "EFECTIVO CONTADO AL CIERRE". Abajo aparece "Diferencia" (contado − esperado: positivo es sobrante, negativo es faltante).
3. Tocá "Cerrar caja y emitir informe de ventas". Se descarga el PDF "Cierre Z" con el resumen del día.
- "🔓 Abrir nuevo día" (aparece con la caja cerrada) NO abre el día siguiente: reabre la caja de HOY y reemplaza el monto inicial. El día siguiente se abre solo con la apertura normal.
- "📅 Historial de cierres": días anteriores, con "📊 Excel", "📄 PDF" y "📄 Descargar PDF Cierre Z" por día. Un día "Sin cerrar" muestra "🔒 Cerrar este día" (lo cierra sin arqueo, tomando el monto inicial).

### 5.4 Fondo fijo y Administración
Elegí "📍 Fondo Fijo …" (o "Administración", solo superadmin). Se ve el "SALDO ACTUAL". En "➕ Registrar movimiento" elegí "↓ Gasto / salida" o "↑ Reposición / entrada", "Concepto (ej: compra de servilletas)", monto → "Registrar movimiento".

### 5.5 Sobres (solo superadmin)
"📍 Sobres" muestra la plata "EN TRÁNSITO · SOBRES PENDIENTES".
- Recibir varios: marcá los sobres, elegí "Caja destino…" → "Recibir N · $…" → confirmar.
- "Recibir (ajustar)": cuando el monto real no coincide con lo declarado: caja destino + "Monto real" → "Confirmar recepción". La diferencia se le devuelve o se le descuenta al local.
- "Rechazar": el sobre vuelve a la caja del local.
- "Anular (duplicado)": si el local cargó el mismo sobre dos veces. Pide "MOTIVO (OBLIGATORIO)" y deja sin efecto la salida original (si ese día ya estaba cerrado, cambia la diferencia de ese cierre).

### 5.6 Transferir entre cajas (admin y superadmin)
"🔄 Transferir" → "Desde", "Hacia", "Monto", "Concepto (obligatorio)" → "Transferir" → confirmar. Con la caja Administración, solo superadmin. "Sobres" no es una caja (da "Caja de origen o destino inválida.").

---

## 6. 🏦 Tesorería (solo superadmin)

☰ → "🛠️ Administración" → "🏦 Tesorería". Cuentas de banco y billeteras (Mercado Pago, etc.).
- "+ Nueva cuenta": "Nombre", "Tipo" (Banco / Billetera), "Saldo inicial", "Al día", "Notas (opcional)" → "Guardar".
- Cada cuenta muestra "Saldo según sistema", "Conciliado" y "Sin conciliar".
- En la cuenta: "+ Nuevo ingreso", "− Nuevo egreso" ("Fecha (la del banco)", "Monto", "Concepto"), "⇄ Transferencia" (entre cuentas, depositar efectivo de una caja en la cuenta, o retirar de la cuenta a una caja), "✏️ Editar cuenta", "Desactivar" (solo con saldo 0), "📊 Excel".
- Conciliar: filtrá el período del extracto, marcá "Solo sin conciliar", tildá los movimientos que figuran en el extracto → "✓ Conciliar" (o tocá "Pendiente" en cada fila). Escribí el "Saldo según extracto" y verificá "✓ Cuadra con el extracto".
- Un movimiento conciliado no se edita ni se anula hasta desconciliarlo. Los movimientos que vienen de pagos, sueldos o gastos se anulan desde su módulo. Anular pide motivo.

---

## 7. 📦 Stock, insumos y recetas

Hay dos stocks distintos:
1. Stock de INSUMOS (materia prima: fiambres, quesos, pan, packaging). Se ve en "📦 Stock actual". Sube con ingresos, se ajusta con recuentos y baja con el consumo automático por receta (si el local lo tiene activo).
2. Stock de COCINA (picadas ya armadas, por lote). Se maneja en "🍳 Tablero de cocina" (ver sección 8).
Locales de stock: A. Thomas y French. Los insumos por peso se ven en kg; los por unidad en "u".

### 7.1 Stock actual (admin, superadmin, encargado, solo lectura)
☰ → "📦 Stock" → "📦 Stock actual". Columnas "Cód.", "Insumo", "Categoría", "A. Thomas", "French", "Total", "Mínimo". Filtros "Buscar insumo…", categoría y "Mínimo sobre el total / en A. Thomas / en French". Arriba, en rojo, los insumos bajo el mínimo ("BAJO MÍN."). "📜" abre el historial del insumo, filtrable por "Ingreso", "Ajuste" o "Consumo" (los consumos automáticos dicen "Pedido #N"). "📊 Excel" descarga la tabla.

### 7.2 Ingreso de mercadería (admin, superadmin, encargado)
☰ → "📦 Stock" → "📥 Ingreso de mercadería".
1. "Insumo": buscá por nombre o código y elegilo.
2. "Local": A. Thomas o French.
3. "Cantidad" y "Unidad" (kg o g para insumos por peso; unidad para los demás).
4. "Fecha" y "Nota (opcional)" (proveedor, remito).
5. "Registrar ingreso" → "Ingreso registrado".
Un ingreso no se borra: si te equivocaste, corregilo con un recuento.

### 7.3 Recuento de stock (admin, superadmin, encargado)
☰ → "📦 Stock" → "📋 Recuento".
1. Elegí el local (A. Thomas / French) y, si querés, una categoría.
2. "Fecha" (hoy). Hacé el recuento y cargalo el mismo día: se compara contra el stock actual.
3. En la columna "Contado" cargá lo que contaste (insumos por peso en kg). Dejá vacío lo que no contaste.
4. Tocá "Revisar diferencias". Se abre "Confirmar recuento" con "Sistema", "Contado" y "Ajuste" de cada insumo.
5. Tocá "Confirmar ajustes" (o "Volver a editar"). Sale "Recuento guardado: N ajuste(s)".
- Si todo coincide: "No hay diferencias para ajustar". Cambiar de local o categoría borra lo cargado.

### 7.4 Insumos y descuento automático (solo admin y superadmin)
☰ → "📦 Stock" → "🧾 Insumos".
- "+ Nuevo insumo" / "Editar": "Código", "Unidad de control" ("Peso (gramos / kg)" o "Unidad"), "Nombre *", "Categoría", "Peso por feta/porción (g)" (necesario si las recetas lo usan por unidades), "Precio sin IVA", "Precio con IVA", "Stock mínimo" → "Guardar". "Baja" / "Reactivar". No cambies la unidad de control de un insumo que ya tiene movimientos.
- "⚙️ Descuento automático": un interruptor por local. Activado, cada pedido de ese local que pasa a "En camino" o "Entregado" descuenta sus insumos según la receta (una sola vez por pedido); si el pedido se anula o vuelve atrás, se devuelven. Rige desde el momento en que se activa (no es retroactivo). Muestra "Activo desde … · quién" o "Apagado". Pide confirmación al prender y al apagar.
- Productos sin receta no descuentan nada. El stock puede quedar negativo si no se cargaron los ingresos.

### 7.5 Recetas
☰ → "📦 Stock" → "📖 Recetas". Crear y editar: solo admin y superadmin. Encargado y solo lectura las ven con "Ver".
Tipos: "Producto" (algo que se vende, se vincula a productos de venta), "Módulo" (sub-receta que no se vende, ej. una base, un pan, un packaging; se usa dentro de otras) y "Combo".

Crear una receta de producto:
1. "+ Nueva receta" → "Nombre" → "Tipo": "Producto".
2. En "Composición", "+ Insumo" por cada ingrediente: "Elegir insumo…", modo "unidades" o "gramos", "cant.", y "% desp" (desperdicio, 8% por defecto; para packaging se pone 0).
   - Modo "gramos": la cantidad son gramos.
   - Modo "unidades" (fetas, porciones): usa el "peso g" de la línea o, si está vacío, el "Peso por feta/porción (g)" del insumo. Si no hay ninguno aparece "⚠️ Falta peso por unidad de …" y ese insumo no se cuenta.
3. "+ Componente" para usar un módulo u otra receta (con su "cant.").
4. "Productos de venta vinculados": escribí el nombre EXACTO del producto como se vende (Tienda Nube o pedido manual) en "Nombre exacto del producto de venta…" → "+ Vincular". Un producto se vincula a una sola receta. No distingue mayúsculas ni "Nueva!"/"MKP", pero SÍ distingue tildes: "Sándwich" y "Sandwich" son productos distintos, así que cada forma en que se escribe el producto necesita su propio vínculo.
5. Revisá "Costo estimado (sin IVA)" y tocá "Guardar receta".

Cargar la receta de un COMBINADO DE TABLAS (un producto que se arma con otras recetas):
1. Las recetas de cada tabla tienen que existir antes (si falta alguna, creala primero).
2. ☰ → "📦 Stock" → "📖 Recetas" → "+ Nueva receta".
3. "Nombre": el del combinado. "Tipo": dejá "Producto" (hoy elegir "Combo" da el error "Tipo inválido (producto o modulo)." al guardar).
4. En "Composición" tocá "+ Componente" → en "Elegir componente…" elegí la primera tabla (están agrupadas en "Módulos", "Productos", "Combos") → en "cant." poné cuántas lleva.
5. Repetí "+ Componente" por cada tabla distinta.
6. Si lleva cosas sueltas (caja, bolsa, salsa), sumalas con "+ Insumo" (packaging con 0% de desperdicio).
7. Vinculá el producto de venta: "Nombre exacto del producto de venta…" → "+ Vincular" (repetí si se vende con más de un nombre).
8. "Guardar receta" → "Receta guardada".
9. Verificá en "🧮 Productos necesarios" que el combinado ya no figure en "⚠️ … producto(s) sin receta".
- El desperdicio de cada tabla ya está dentro de su receta: en la línea del componente no se vuelve a sumar.
- Para editar un combo importado (etiqueta "COMBO"), cambiá su "Tipo" a "Producto" antes de "Guardar receta"; si no, sale "Tipo inválido.".
- Una línea sin insumo/componente o sin cantidad se descarta al guardar: revisá que todas tengan cantidad.

Otros botones:
- "Duplicar": copia la receta con otro nombre (no copia los productos vinculados).
- "Baja": la saca de la lista y sus productos pasan a "sin receta". No hay reactivación desde la pantalla.
- "+ Módulo": crea un módulo (sin productos vinculados).
- "Importar recetas iniciales", "Importar combos", "Importar vínculos": herramientas de carga inicial; no hace falta usarlas en el día a día.
- "⚠️" al lado del nombre: la receta tiene avisos (falta peso, sin precio, etc.); pasá el mouse para verlos.

### 7.6 Productos necesarios y Productos utilizados (admin, superadmin, encargado, solo lectura)
- "🧮 Productos necesarios": cuánto insumo hace falta para los pedidos POR PRODUCIR ("Por empaquetar" y "Listo") entre "Desde" y "Hasta" (por defecto, mañana), por local. Columnas "Insumo", "Necesario", "Stock", "Faltante". "📊 Excel".
- "📦 Productos utilizados": cuánto se consumió según lo ENTREGADO en el período, "Prom. diario", "Stock actual", "Alcanza para" y "Proyección" de N días.
- "Sin receta": las dos pantallas muestran "⚠️ N producto(s) sin receta (no se explotan a insumos)". Por producto: "Vincular a receta existente" (buscás la receta → "Vincular") o "Crear receta" (la crea vacía y vinculada; después cargale las líneas en Recetas). Esos botones son solo para admin.

---

## 8. Cocina y producción

### 8.1 🍳 Tablero de cocina (todos menos comercial)
☰ → "🍳 Tablero de cocina". Muestra por producto la "Demanda" (pedidos en "Por empaquetar" y "Listo" del rango), lo que hay "En stock" (por lote: "de ayer", "de hoy") y lo que falta, "Para producir".
- Elegí "Desde" / "Hasta", turno y la sucursal ("📍 A. Thomas" o "📍 French"). Con "🏭 Ambos" es solo lectura.
- Producir: en la fila, ajustá la cantidad y tocá "Marcar realizadas". Se suma al stock como lote de hoy.
- Descartar (picadas hechas que no se vendieron): "Sacar de stock" → cantidad → lote ("Más viejo (FIFO)" o uno puntual) → "Descartar" → confirmar. No se puede deshacer.
- Al despachar un pedido ("En camino" / "Entregado") se descuenta solo de este stock (lote más viejo primero). Si después se anula o reabre, no se devuelve solo: reponelo con "Marcar realizadas".

### 8.2 🔧 Análisis de producción (todos menos comercial)
☰ → "🔧 Análisis de producción". Cuánto producir de cada producto para una "Fecha", por "Sucursal" y "Turno" (Mañana 6 a 12, Mediodía 12 a 17, Tarde 17 a 23, "Fuera de horario", "Sin horario"). Cuenta los pedidos no entregados ni anulados de esa fecha. "📊 Excel" y "📄 PDF".

---

## 9. 🛒 Compras y proveedores (admin y superadmin)

En todos los pagos y gastos se elige el "Origen de la plata": "Externo (no toca caja ni cuenta)", "Sale de caja" (genera una salida en esa caja con fecha de hoy) o "Sale de una cuenta (banco / billetera)" (genera un egreso en la cuenta de Tesorería con la fecha del pago). La caja "Administración" solo la puede elegir un superadmin.

### 9.1 Proveedores
☰ → "🛒 Compras" → "🏭 Proveedores" → "+ Nuevo proveedor": "Razón social *", "CUIT" (11 dígitos, opcional), "Condición frente al IVA", "Email", "Teléfono" → "Guardar". Si la razón social ya existe pregunta si crearlo igual; un CUIT repetido no se puede cargar. "✎ Editar", "✕ Eliminar" (queda inactivo; se ve con el filtro "Inactivos"). "📊 Excel".

### 9.2 Categorías
- "🏷️ Categorías de gasto": las de órdenes y facturas de compra (ej. Mercadería, Insumos, Servicios). Escribí en "Nueva categoría" → "+ Agregar".
- "🏷️ Categorías de gastos comunes": las de gastos sin factura (ej. Librería, Limpieza, Viáticos). Con "Es retiro" se marca una categoría de retiro de socios/gerencia (se totaliza aparte).

### 9.3 Órdenes de compra
"📋 Órdenes de compra" → "+ Nueva orden": "Proveedor *", "Categoría de gasto *", "Fecha *", "Descripción *", "Monto total *", "Nota" → "Guardar". Estados: Pendiente → Aprobada ("✓ Aprobar") → Recibida (pasa sola al cargar su factura con "+ Desde orden"). "✎ Editar" solo en pendientes. "✕ Anular" (pendiente o aprobada) pide motivo.

### 9.4 Facturas de compra
"🧾 Facturas de compra":
1. "+ Desde orden" (elegís una "Orden aprobada *": completa proveedor y categoría) o "+ Factura suelta".
2. "Proveedor *", "Categoría de gasto *", "Clase *" (Factura, Nota de Crédito, Nota de Débito), "Letra *" (A, B, C), "Punto de venta", "Número *", "Fecha *", "CAE", "Fecha de contabilización" (se sugiere sola: si la factura es de un mes anterior, hoy).
3. "IVA por alícuota": cargá el neto de cada alícuota (10,5%, 21%, 27%) y el IVA se calcula solo; percepciones, no gravado, exentas, otros tributos.
4. "Total factura *": tiene que coincidir con el calculado ("✓"); si no ("✗ no coincide"), no deja guardar.
5. "Guardar factura".
- La categoría de una factura se cambia tocándola en la lista. "⧉ Duplicar" abre una factura nueva con los mismos datos.
- "💵 Registrar pago" (en una pendiente): origen, caja o cuenta, "Medio de pago *", "Fecha de pago" → "Confirmar pago". Paga el total de la factura (no hay pago parcial de factura).
- "✕ Anular" solo en pendientes. Para anular una factura pagada, primero anulá el pago en "💸 Pagos".
- No deja cargar dos veces el mismo comprobante del proveedor (mismo tipo y número).

### 9.5 Cuentas por pagar y pagos
- "💳 Cuentas por pagar": deuda por proveedor ("DEUDA TOTAL A PROVEEDORES", "A FAVOR NUESTRO"), con el detalle de facturas y pagos al desplegar. Solo consulta. "📊 Excel".
- "💸 Pagos" (pantalla "💸 Pagos a proveedores"): todos los pagos "Contra factura" y "Pago a cuenta". "+ Pago sin factura" (anticipo a un proveedor): "Proveedor *", "Fecha *", "Monto *", "Concepto *", origen, "Medio de pago *" → "Registrar pago a cuenta". "✕ Anular" pide motivo: repone la caja o anula el egreso en la cuenta, y la factura vuelve a pendiente.

### 9.6 Gastos comunes (gastos sin factura)
"🧾 Gastos comunes" → "+ Nuevo gasto": "Fecha", "Descripción", "Monto", "Categoría", "Origen del dinero" → "Registrar gasto". "Anular" pide motivo y repone la caja o la cuenta. Arriba se ven los totales de "Gastos", "Retiros" y "Por categoría".

---

## 10. 📒 Contable (solo superadmin)
- "📗 Libro de compras (AFIP)": "Desde", "Hasta", proveedor, categoría → "Generar" → "📊 Exportar Excel". Imputa por fecha de contabilización y excluye anuladas.
- "📕 Libro de ventas (AFIP)": "Desde", "Hasta", "Local / PDV" ("Ambos", A. Thomas o French) → "Generar" → "📊 Exportar Excel".

---

## 11. 👥 RRHH (solo superadmin)

Todo RRHH lo ve y lo usa SOLO el superadmin. Admin, encargado, solo lectura, comercial y los operarios de sucursal (A. Thomas / French) no pueden ver liquidaciones ni pagar sueldos o adelantos. El panel no calcula sueldos: se cargan los números que manda el estudio contable.

### 11.1 Empleados
☰ → "👥 RRHH" → "🧑‍🍳 Empleados" → "+ Nuevo empleado": "Nombre completo *", "DNI", "CUIL (11 dígitos)", "Fecha de nacimiento", "Teléfono", "Domicilio", "Email", "Contacto de emergencia", "Local", "Puesto", "Categoría de convenio", "Jornada", "Fecha de ingreso", "CBU / Alias" → "Guardar". "Ver" abre la ficha; "Baja" pide la fecha de egreso; "Reactivar".

### 11.2 Liquidaciones y pago de sueldos (superadmin)
1. ☰ → "👥 RRHH" → "🧾 Liquidaciones" → elegí el "Período" (mes).
2. En la fila del empleado cargá Bruto, No rem., Deduc., Neto y Contrib. → "Guardar" (si el neto no cierra con bruto + no remunerativo − deducciones, avisa "⚠️ neto no cierra").
3. Tocá "💵 Pago" en esa fila.
4. Elegí "Pago simple" o "Pago dividido (banco + efectivo)".
5. Pago simple: "Fecha", "Monto" (viene con el saldo), "Origen del dinero" (Externo / Sale de caja → elegí la caja / Sale de una cuenta → elegí la cuenta), "Medio de pago".
   Pago dividido: parte "🏦 Banco" (monto y cuenta o externo) + parte "💵 Efectivo" (monto y caja o externo).
6. "Confirmar pago" → "Pago registrado". Se permiten pagos parciales (estado "Pago parcial").
- Si sale de una caja, el pago ya genera la salida en esa caja ("Pago sueldo: …"): no hace falta (ni hay que) cargar un ajuste aparte en Caja.
- "Anular" en el detalle del pago (▸) pide motivo y repone la caja o la cuenta.
- Saldo por pagar = neto − pagos. Los adelantos NO se restan del saldo.

### 11.3 Novedades (adelantos, horas extra, bonos, descuentos)
☰ → "👥 RRHH" → "➕ Novedades" → "+ Novedad": "Empleado", "Tipo" ("Adelanto", "Hora extra", "Bono", "Descuento", "Otro"), "Fecha", "Monto", "Concepto (opcional)", origen del dinero y medio → "Registrar". "Descuento" es solo registro (no mueve plata). Horas extra, bonos y otros son adicionales fuera del recibo: suman al costo de personal pero no cambian la liquidación.

### 11.4 Costo de personal
"📊 Costo de personal": costo laboral, adelantos, sueldos pagados y pendiente, por mes, por local y por empleado. "📊 Excel".

---

## 12. 👥 Clientes y 💼 Ventas a realizar (admin, superadmin y comercial)

### 12.1 Clientes
☰ → "👥 Clientes".
- "📞 Seguimientos": notas con próximo contacto pendiente (en rojo los vencidos). Tocá uno para abrir la ficha.
- Temperatura según la última compra entregada: "🔴 CALIENTE" (hasta 30 días), "🟡 TIBIO" (hasta 180), "🔵 FRÍO" (hasta 365), "⚫ DORMIDO" (más).
- "Corporativo": cliente con alguna compra con Factura A o pedido manual marcado corporativo.
- Filtros, orden y "Buscar por nombre, email o teléfono…". "📊 Exportar Excel" (no para comercial).
- Ficha del cliente (tocá la fila): datos, métricas, "🛒 Compra siempre", "🗒️ Notas y seguimiento" (elegí tipo: "📝 Nota", "📞 Llamada", "💬 WhatsApp", "✉️ Mail", "🤝 Reunión"; "Próximo contacto"; texto → "Guardar nota"; marcá "Hecho" cuando lo hiciste; "Anular" solo el autor o un superadmin), "💼 Oportunidades" y "📦 Pedidos".

### 12.2 Ventas a realizar (oportunidades y cotizaciones)
☰ → "💼 Ventas a realizar". Etapas: "Nueva", "Contactado", "Cotizado", "Ganada", "Perdida".
- De dónde salen: el cotizador web de Eventos ("formulario"), el de Regalos empresariales ("Regalos" o "Regalos · Calendario anual") y las cargadas a mano ("manual"). Las del cotizador web llegan solas en etapa "Nueva".
- Mover de etapa: cambiá el selector de la tarjeta. Para "Perdida" pide el "Motivo de la pérdida:" (obligatorio).
- "Ver detalle ▾": muestra lo que cotizó el cliente (opción elegida, productos, personas, fecha, zona; en regalos, cantidades, entrega y tarjeta) y si se le mandó la propuesta por mail.
- "+ Nueva oportunidad": "Buscar cliente existente", "Cliente *", "Empresa", "Personas", "Email", "Teléfono", "Fecha del evento", "Zona", "Monto cotizado", "Etapa", "Notas" → "Crear oportunidad".
- Desde la pantalla se cambia solo la etapa; los datos de una oportunidad ya creada no se editan.

---

## 13. 📊 Reportes
- "📈 Dashboard ejecutivo" (admin): ventas del período vs período anterior, ticket promedio, por medio de cobro y por local. Filtro "Origen:" Todos / Online (web) / Manual.
- "📊 Reporte de ventas" (admin): pedidos entregados con filtros de fechas, medio de pago, repartidor, local y tipo (retiro/delivery). "📊 Excel" y "📄 PDF".
- "📅 Reporte de reservas" (todos): pedidos activos de hoy en adelante, con filtro de "Turno". Excel y PDF.
- "📦 Productos vendidos" (todos): ranking de productos por unidades, por local y categoría. Excel y PDF.
- "🧾 Vendido / Por vender" (admin): lo entregado vs lo que falta entregar en el período.
- "📍 Pedidos por zona" (admin): pedidos de delivery entregados por repartidor y área (Área 1 a 10), con "💲 Costos por área" ("Guardar costos"). "Sin coord" = no se pudo ubicar; "Dudosa" = revisar a mano.
- Todos excluyen los pedidos anulados. Si "Desde" queda vacío toma toda la historia.

---

## 14. 💬 WhatsApp

Lo usan todos los roles salvo el comercial y la sesión de emergencia (el rol Solo lectura también puede atender WhatsApp).
- Botón "💬 WhatsApp" en el encabezado con los contadores "Activas" y "Por responder" (se pone naranja y suena un beep cuando hay mensajes esperando). Abre la bandeja como panel lateral, así podés seguir usando el panel.
- Pestañas: "Pendientes", "Mías", "Bot", "Todas", "Cerradas". "Buscar por nombre o número…".
- Para responder: abrí la conversación → "✋ Tomar" (te la asigna y pausa el bot) → escribí y "Enviar" (Enter envía, Shift+Enter hace salto de línea). "📎" adjunta imagen JPG/PNG o PDF de hasta 10 MB.
- "Liberar" la suelta; "🤖 Devolver al bot" vuelve a dejarla al bot; "Cerrar" la cierra (si el cliente vuelve a escribir, la retoma el bot). Solo quien la tiene (o un admin) puede gestionarla; si la tiene otro, aparece "La está atendiendo …".
- "🧾 Cargar pedido": abre "➕ Nuevo pedido" con el nombre y teléfono del cliente.
- Si pasaron más de 24 h desde el último mensaje del cliente, solo se le puede escribir con una plantilla aprobada: "📋 Enviar plantilla". Para escribirle a un número nuevo: "+ Nueva conversación" → "Número", "Plantilla" (y sus variables) → "Enviar plantilla".
- "📋 Plantillas de WhatsApp": todos ven la lista y pueden "🔄 Sincronizar". "+ Nueva plantilla" (admin) la manda a Meta para aprobación; hasta que la aprueben queda "Pendiente".
- "⚙️ Configuración WhatsApp" (admin): interruptores "WhatsApp activo" y "Bot activo" (apagar el bot manda todo a Pendientes). El resto de esa pantalla es técnico: no tocar.

---

## 15. Usuarios y acceso

### 15.1 Ingresar
"Usuario" y "Contraseña" → "Ingresar". Si el usuario tiene verificación en 2 pasos, llega un "Código de 6 dígitos" al mail (vence en 10 minutos; "Reenviar código" después de 30 segundos). La sesión dura 14 horas; al vencer aparece "⏰ Tu sesión venció, volvé a entrar." y al volver a entrar quedás en la misma pantalla. Cerrar sesión: botón "⎋" arriba a la derecha.
Si el mail está caído y no llega el código, aparece la opción "Entrar en modo solo lectura" (sesión de emergencia de 4 horas, solo para ver pedidos).

### 15.2 Usuarios (admin y superadmin)
☰ → "🛠️ Administración" → "👥 Usuarios".
- "+ Nuevo usuario": "Username" (minúsculas, no se puede cambiar después), "Nombre completo", "Rol", "Email para 2FA (opcional)" (con mail, se le pide código al ingresar), "Contraseña inicial" (mínimo 6 caracteres) → "Crear usuario".
- Por usuario: "✏️ Editar", "🔑 Password" (cambiarle la contraseña), "⊘ Desactivar" / "✓ Activar", "🗑" (borrar; mejor desactivar). "🔐 Probar 2FA" en tu propia fila.
- Solo un superadmin crea, edita, desactiva o borra usuarios admin y superadmin. Un admin gestiona los demás roles.
- No hay pantalla para que cada uno cambie su propia contraseña: se la cambia un admin (o un superadmin, si es admin) con "🔑 Password". Si olvidaste la contraseña, pedile a un admin que te la cambie.

### 15.3 Repartidores (admin)
☰ → "🛠️ Administración" → "🚚 Repartidores": "Nombre del nuevo repartidor" → "+ Agregar"; "✕ Eliminar". Son los nombres que aparecen en "Repartidor" de los pedidos y tandas (no son usuarios del panel).

---

## 16. Reglas de negocio que conviene saber
- Delivery de Tienda Nube: siempre a A. Thomas. Retiros: al local del punto de retiro que eligió el cliente.
- Pedido cancelado en Tienda Nube: hay que anularlo también en el panel ("🚫 Anular pedido").
- Para anular un pedido facturado: primero la nota de crédito ("🗑 Anular factura"), después anular el pedido.
- Anular un pedido no devuelve la plata en Mercado Pago ni toca la caja.
- La caja de un local no se puede cerrar con pedidos de ese local (de hoy o anteriores) sin entregar o anular.
- Para la caja, el efectivo es "Efectivo" y "Pedidos Ya Efectivo".
- El punto de venta de la factura sale del local de la sección del pedido: mové el pedido de sección antes de facturar.
- Recetas: desperdicio 8% por defecto (0% para packaging). Un producto de venta se vincula a una sola receta.
- Descuento automático de insumos: por local, solo desde que se activa, al pasar a "En camino" o "Entregado"; se devuelve si el pedido se anula o vuelve atrás.
- Stock de cocina: se descuenta al despachar y NO se devuelve solo al anular.
- Adelantos de sueldo: no se restan del saldo de la liquidación.
- Pagos y gastos que salen de una caja se registran con fecha de hoy en esa caja; los que salen de una cuenta, con la fecha del pago.

---

## 17. Problemas frecuentes

Pedidos
- "No encuentro un pedido": no hay buscador; revisá los filtros de fecha/zona, la otra pestaña o local, y "📋 Pedidos finalizados".
- "No veo el cambio que hizo un compañero": recargá la página (el refresco automático solo trae pedidos nuevos).
- "No me deja anular": tiene factura activa → "🗑 Anular factura" primero.
- "Toqué anular y no pasó nada": el motivo es obligatorio.
- "Me sale ⚠️ FALTA CÓDIGO": cargá el "Código MKP" del pago, o aceptá si ya lo verificaste.
- "Quiero volver de Listo a Por empaquetar": no se puede desde el panel.
- "Borré la fecha o el horario y volvió": vaciar no borra; poné otro valor.
- "Cambié un dato y al recargar volvió" (rol Solo lectura): ese rol no puede guardar cambios.
- "⚠️ El pedido NO se creó: …" al cargar un pedido: no se guardó nada; lo cargado sigue en el formulario, reintentá con "✅ Crear pedido". Si dice "Sin conexión con el servidor.", revisá internet.
- "La fila está roja": ya pasó la hora de inicio de la franja (o falta menos de 1 h) y no salió, o el pago de Tienda Nube no está aprobado ("⚠️ REVISAR PAGO").
- "Dice ● NUEVO un pedido viejo": nunca se imprimió su comanda.
- "No imprime / no aparece la ventana": abrí QZ Tray o habilitá las ventanas emergentes (pop-ups) del navegador.
- "🖨️ IMPRIMIR COMANDAS está gris": no hay pedidos de hoy de ese local sin comanda impresa.
- "No puedo agregar pedidos a la tanda": la tanda ya salió, o el pedido es de otro local o ya está en otra tanda.
- "Un pedido no aparece en el mapa": es retiro, no es de esa fecha o la dirección no se pudo ubicar.
- "Un pedido manual pagado por link sigue con COBRAR": desmarcá "Cobrar en entrega" a mano.

Facturación
- "Emitir está gris": el detalle no suma el total → "Editar precios" o "Facturar en un renglón".
- "Para Factura A es obligatorio el CUIT": cargá el CUIT.
- "Este pedido ya tiene una factura activa.": anulala con nota de crédito antes de volver a facturar.
- "Request failed with status code 403" al facturar: tu rol no puede facturar.

Caja
- "No se puede cerrar la caja todavía…": hay pedidos activos del local; entregalos, anulalos o cambiales la fecha.
- Un botón queda en "Abriendo..." / "Cerrando..." o "+ Ajuste" no responde: la acción no se guardó (típico del rol Solo lectura o de un corte de conexión). Recargá la página.
- "La caja Administración es solo para superadmin.": esa caja solo la usa el superadmin.
- Sobre cargado dos veces: el superadmin lo resuelve con "Anular (duplicado)", no con "Rechazar".
- Concepto con "🔒": es un movimiento automático y no se edita.

Stock y recetas
- "Tipo inválido (producto o modulo)." al guardar una receta: elegiste "Combo"; usá "Producto" con "+ Componente".
- "Tipo inválido." al guardar un combo importado: cambiale el "Tipo" a "Producto" y guardá.
- "⚠️ Falta peso por unidad de …": cargá el "Peso por feta/porción (g)" en Insumos, el "peso g" en la línea, o usá modo "gramos".
- "Sin precio: …" / costo $0: cargá el precio sin IVA del insumo en Insumos.
- Un producto aparece en "sin receta": vinculalo a una receta (admin) en Recetas o con "Vincular a receta existente".
- "Ese producto ya está vinculado a la receta …": desvinculalo ("✕") en esa receta primero.
- "Los módulos no se venden…": vinculá el producto a una receta de tipo Producto.
- "Requiere rol admin": esa acción la hace un admin.
- "No aparece Marcar realizadas" en cocina: elegí la sucursal (no "🏭 Ambos").
- Stock de insumos negativo: faltó cargar ingresos; corregilo con un recuento.
- Los insumos no se descuentan al despachar: revisá que el local tenga activo "⚙️ Descuento automático", que el producto tenga receta y que no falte el peso por unidad.

Acceso
- "Usuario o contraseña incorrectos": revisá los datos; si el usuario fue desactivado sale el mismo mensaje. Pedile a un admin que lo revise o te cambie la contraseña.
- "Código incorrecto o vencido": pedí "Reenviar código" (vence a los 10 minutos).
- "Sin acceso" / "Esta sección es solo para administradores": tu rol no tiene esa pantalla.
