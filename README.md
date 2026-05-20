# Piccadely Panel

Sistema interno de gestión de delivery de Piccadely (picadas). Reemplaza el back-office estándar de Tienda Nube con funciones específicas del negocio: clasificación automática por sucursal, comandas imprimibles, caja con cierre Z, facturación AFIP integrada, reportes operativos y producción diaria.

---

## Índice

- [Resumen ejecutivo](#resumen-ejecutivo)
- [Arquitectura](#arquitectura)
- [Stack técnico](#stack-técnico)
- [Setup local](#setup-local)
- [Variables de entorno](#variables-de-entorno)
- [Servicios externos](#servicios-externos)
- [Estructura del repo](#estructura-del-repo)
- [Deploy](#deploy)
- [Base de datos](#base-de-datos)
- [Endpoints del API](#endpoints-del-api)
- [Operaciones comunes](#operaciones-comunes)
- [Troubleshooting](#troubleshooting)
- [Pendientes / roadmap](#pendientes--roadmap)

---

## Resumen ejecutivo

**¿Qué es?** Un panel web interno que gestiona la operación diaria de delivery de Piccadely. Reemplaza el back-office estándar de Tienda Nube y le agrega varias funcionalidades específicas que TN no provee.

**¿Qué hace?**

- **Recibe pedidos** automáticamente de Tienda Nube vía webhooks
- **Permite cargar pedidos manuales** (clientes que llaman por teléfono o WhatsApp)
- **Clasifica automáticamente** cada pedido en una de 4 secciones: Retiro A. Thomas, Retiro French, Delivery A. Thomas, Delivery French
- **Maneja el ciclo de vida** del pedido: Por empaquetar → Listo → En camino → Entregado
- **Imprime comandas** para cocina (ticket 80mm)
- **Factura automáticamente** vía AFIP usando TusFacturas (Factura A, B, B Exento, Ticket X, con notas de crédito)
- **Caja por sucursal** con apertura, ajustes, cierre Z, historial y diferencia esperada vs contada
- **Reportes** de ventas, productos vendidos, producción del día, pedidos finalizados
- **Exportación** a Excel y PDF de todos los reportes
- **Notificación sonora** cuando entra un pedido nuevo
- **Autenticación** con JWT, 3 roles (admin, a_thomas, french), 12 usuarios iniciales
- **Filtrado por rol**: cada empleado ve solo lo de su sucursal

**¿Quién lo usa?** Empleados de Piccadely en las 2 sucursales (A. Thomas en Villa Ortuzar, French en Recoleta) y administración.

**¿Para qué se construyó?** Tienda Nube provee un back-office genérico, pero no maneja correctamente:
- Distinguir entre las 2 sucursales de retiro
- Imprimir comandas en formato cocina
- Caja con cierre Z al estilo POS argentino
- Facturación AFIP automática
- Reportes operativos específicos del negocio (qué se va a producir hoy, etc.)

---

## Arquitectura

```
┌─────────────────────────┐
│  Cliente final          │
│  (sitio TN público)     │
└────────────┬────────────┘
             │ compra
             ▼
┌─────────────────────────┐
│  Tienda Nube            │
│  (orden creada)         │
└────────────┬────────────┘
             │ webhook
             ▼
┌─────────────────────────┐         ┌──────────────────────┐
│  Backend (Railway)      │◄────────┤  Empleados           │
│  Express + Node 22      │  HTTPS  │  (browser)           │
│  /api/...               │────────►│  Panel React         │
└────────────┬────────────┘  JSON   │  (Vercel)            │
             │                      └──────────────────────┘
             │ SQL
             ▼
┌─────────────────────────┐
│  Neon Postgres          │
│  (DB managed)           │
└─────────────────────────┘

         Servicios externos:
         ─────────────────────
         - TusFacturas (facturación AFIP)
         - UptimeRobot (monitoreo)
         - GitHub Actions (backups diarios)
```

**Flujo de un pedido típico:**

1. Cliente compra en `reservas.piccadely.com` (sitio Tienda Nube)
2. TN crea la orden y dispara webhook `order/paid` o `order/created`
3. Backend recibe el webhook, valida firma HMAC, hace `GET /orders/{id}?aggregates=fulfillment_orders` a TN
4. Guarda el pedido en `pedidos_tn` (tabla en Neon)
5. Frontend en el panel hace polling cada 30s a `/api/orders`
6. Si detecta IDs nuevos respecto a la última consulta, suena un beep y cambia el título de la pestaña
7. El empleado abre el pedido, lo clasifica automáticamente, imprime la comanda
8. Va cambiando el estado a medida que avanza (Por empaquetar → Listo → En camino → Entregado)
9. Al cierre del día, se factura desde el panel y se hace cierre Z de caja

---

## Stack técnico

| Capa | Tecnología | Versión |
|---|---|---|
| Frontend | React + Vite | 18 |
| Backend | Node.js + Express | 22 |
| Base de datos | PostgreSQL (Neon) | 17 |
| Auth | JWT + bcrypt | - |
| Reportes | xlsx (SheetJS) + jsPDF | - |
| Hosting backend | Railway | - |
| Hosting frontend | Vercel | - |
| DB hosting | Neon (sa-east-1) | - |
| Repo | GitHub privado | - |
| CI/CD | Vercel + Railway auto-deploy desde GitHub | - |
| Backups | GitHub Actions (cron diario) | - |
| Monitoreo | UptimeRobot | - |
| Facturación AFIP | TusFacturas API v2 | - |

---

## Setup local

Requisitos previos:
- Node.js 22+
- npm
- Acceso al repo en GitHub
- Credenciales (pedirlas al admin)

```bash
# Clonar
git clone https://github.com/piccadely/Piccadely-panel.git
cd Piccadely-panel

# Instalar dependencias
npm install

# Configurar variables de entorno
cp .env.example .env
# Editar .env con los valores reales (pedirlos al admin)

# Correr backend
node server.js
# (corre en http://localhost:3001)

# Correr frontend (en otra terminal)
npm run dev
# (Vite abre en http://localhost:5173)
```

El frontend apunta por default a `https://piccadely-panel-production.up.railway.app`. Para apuntar al backend local, editar `src/App.jsx` línea 11:

```jsx
const API = "http://localhost:3001";
```

---

## Variables de entorno

Ver `.env.example` para la lista completa. Resumen:

| Variable | Tipo | Descripción |
|---|---|---|
| `DATABASE_URL` | crítica | Connection string completo de Neon |
| `TN_STORE_ID` | crítica | Store ID de Piccadely en Tienda Nube |
| `TN_ACCESS_TOKEN` | crítica | Token de acceso a la API de TN |
| `TN_CLIENT_SECRET` | crítica | Secret usado para verificar firmas HMAC de webhooks |
| `TF_APIKEY` | crítica | API key de TusFacturas |
| `TF_APITOKEN` | crítica | API token de TusFacturas |
| `TF_USERTOKEN` | crítica | User token de TusFacturas |
| `TF_PDV` | opcional | Punto de venta ARCA (default `00007`) |
| `TF_CUIT_EMISOR` | opcional | CUIT del emisor (default sandbox `30712271503`) |
| `JWT_SECRET` | crítica | Secret para firmar JWT — rotar invalida todas las sesiones |
| `ADMIN_SECRET` | crítica | Secret para autenticación admin vía header `x-admin-secret` |
| `WEBHOOK_URL` | opcional | URL pública del backend para recibir webhooks |
| `PORT` | opcional | Puerto del servidor (Railway lo setea solo) |
| `PASSWORD_INICIAL` | opcional | Password del seed inicial (default `Piccadely2026!`) |

**Las variables se configuran en:**
- **Local**: archivo `.env` en la raíz del repo (nunca commitear, está en `.gitignore`)
- **Producción**: Railway → Piccadely-panel service → Variables

Si falta alguna variable crítica, el server hace crash al arrancar con un mensaje claro indicando cuál falta.

---

## Servicios externos

### Tienda Nube
- **Store ID**: 7597872
- **Sitio público**: https://reservas.piccadely.com
- **API version**: 2025-03
- **Documentación**: https://tiendanube.github.io/api-documentation/
- **Webhooks configurados**: `order/created`, `order/paid`, `order/updated`, `order/cancelled`, `order/voided`
- **Setup de webhooks**: hacer POST a `/api/admin/webhooks/setup` (con header `x-admin-secret` o JWT admin)
- **Si se rota TN_CLIENT_SECRET**: contactar `socios@tiendanube.com`

**Opciones de envío configuradas en TN (importante):**
- ULID `01KQ7TFQPTTZQ7CFFKCKVWEZQV` → "Piccadely Villa Ortuzar" → sucursal **A. Thomas** (Alvarez Thomas 1558, barrio Villa Ortuzar)
- ULID `01KQ7S2Z0799JKAT5A1VTH12EQ` → "Recoleta" → sucursal **French** (calle French 2615, barrio Recoleta)

⚠️ **Importante**: los nombres son contraintuitivos. La sucursal "A. Thomas" está en barrio Villa Ortuzar (calle Alvarez Thomas), y la sucursal "French" está en barrio Recoleta (calle French). Esto está documentado en la función `clasificarPedido()` de `src/App.jsx`.

### TusFacturas (facturación AFIP)
- **Panel**: https://www.tusfacturas.app
- **API docs**: https://developers.tusfacturas.app
- **Modo actual**: sandbox (CUIT emisor 30712271503)
- **Para pasar a productivo**: cambiar `TF_CUIT_EMISOR` al CUIT real de Piccadely y dar de alta los PDVs en ARCA. Importante: los PDVs no se pueden compartir con Maxirest (sistema POS de las sucursales), hay que crear PDVs nuevos.

### Neon (PostgreSQL)
- **Región**: sa-east-1 (São Paulo)
- **Plan**: free tier (suficiente para el volumen actual)
- **Backups**: a partir de mayo 2026, snapshots diarios automáticos vía GitHub Actions (ver sección Backups)

### Railway (backend)
- **Servicio**: Piccadely-panel
- **URL**: https://piccadely-panel-production.up.railway.app
- **Plan**: Pro ($20/mes con $20 de uso incluido)
- **Auto-deploy**: cada push a `main` en GitHub
- **Logs**: Railway → Piccadely-panel → Deploy Logs / HTTP Logs

### Vercel (frontend)
- **URL**: https://piccadely-panel.vercel.app
- **Plan**: Hobby (gratis) — suficiente para uso interno
- **Auto-deploy**: cada push a `main` en GitHub

### UptimeRobot (monitoreo)
- **Plan**: Solo 10 (paid) o equivalente
- **Monitor activo**: `https://piccadely-panel-production.up.railway.app/api/health`
- **Intervalo**: 1 minuto
- **Alertas**: email a `chapa@piccadely.com`

### GitHub Actions (backups)
- **Workflow**: `.github/workflows/backup-db.yml`
- **Frecuencia**: diario, 07:00 UTC (04:00 Argentina)
- **Retención**: 90 días
- **Trigger manual**: GitHub → Actions → "Backup diario de Neon" → Run workflow
- **Secret necesario**: `DATABASE_URL` configurado en Settings → Secrets → Actions

---

## Estructura del repo

```
piccadely-panel/
├── .github/
│   └── workflows/
│       └── backup-db.yml      # Cron diario de backup de Neon
├── public/
│   ├── favicon.svg
│   ├── icons.svg
│   └── Piccadely_Logotipo*    # Assets del branding
├── src/
│   ├── App.jsx                # Componente principal del panel (~2100 líneas)
│   ├── App.css                # Estilos globales
│   ├── auth-utils.js          # Helpers de auth en el cliente (localStorage, validar sesión)
│   ├── Login.jsx              # Pantalla de login
│   ├── Usuarios.jsx           # CRUD de usuarios (admin)
│   ├── main.jsx               # Bootstrap de React
│   └── index.css
├── server.js                  # Backend Express completo
├── auth.js                    # Endpoints y middlewares de autenticación
├── package.json
├── package-lock.json
├── vite.config.js
├── eslint.config.js
├── index.html
├── .env.example               # Plantilla de variables de entorno
├── .gitignore
└── README.md                  # Este archivo
```

---

## Deploy

**Backend (Railway)**:
- `git push origin main` → Railway detecta el cambio → buildea con `node server.js` → deploy automático
- Logs: Railway → Piccadely-panel → Deploy Logs
- Si el deploy falla por variable faltante: el server hace crash en el arranque con mensaje `❌ FATAL: faltan variables de entorno: X, Y`. Solución: agregar la variable en Railway → Variables → restart automático.

**Frontend (Vercel)**:
- `git push origin main` → Vercel detecta cambio → buildea con `npm run build` → deploy automático
- Tiempo de deploy: ~1 minuto
- Si el usuario sigue viendo la versión vieja después de un deploy: hacer **Ctrl+Shift+R** (hard refresh) en el browser para limpiar el caché.

**Rollback**:
- Railway: pestaña Deployments → buscar deploy anterior funcional → click "Redeploy"
- Vercel: pestaña Deployments → buscar build anterior → "Promote to production"

---

## Base de datos

Todas las tablas se crean automáticamente al arrancar el backend (función `initDB()` en `server.js`).

### Tablas

**`pedidos_tn`** — Cache local de pedidos de Tienda Nube
- `id` (BIGINT PRIMARY KEY) — ID del pedido en TN
- `store_id` (TEXT)
- `numero` (TEXT) — número visible del pedido (ej: 316)
- `estado_tn`, `payment_status`, `total`, `contact_*`
- `data` (JSONB) — payload completo de la orden
- `tn_created_at`, `updated_at` (TIMESTAMP)

**`pedidos_estados`** — Estado interno de cada pedido (lo que mueve el panel)
- `id` (TEXT PRIMARY KEY) — ID del pedido (TN o manual)
- `estado` (TEXT) — "Por empaquetar" / "Listo" / "En camino" / "Entregado" / "Anulado"
- `repartidor`, `tab_manual`, `fecha_manual`, `franja_manual`, `cobrar`

**`pedidos_manuales`** — Pedidos cargados a mano (no vinieron de TN)
- `id` (TEXT PRIMARY KEY) — formato `manual-{timestamp}`
- Resto de campos del pedido (cliente, dirección, productos, etc.)

**`pedidos_productos`** — Override de productos de un pedido (si se editaron desde el panel)
- `pedido_id` (TEXT PRIMARY KEY)
- `productos`, `total_num`

**`caja_aperturas`** — Aperturas de caja por local y fecha
- `id`, `local`, `fecha`, `monto_inicial`, `cerrada`, `monto_cierre`

**`caja_movimientos`** — Movimientos individuales (apertura, ajustes, cierre)
- `id`, `local`, `tipo`, `concepto`, `monto`, `fecha`

**`facturas`** — Comprobantes emitidos
- `pedido_id`, `tipo`, `numero`, `cae`, `vencimiento_cae`, `cliente`, `documento_*`, `total`, `pdf_url`, `fecha`, `datos_raw` (JSONB)

**`usuarios`** — Usuarios del panel (auth)
- `id`, `username`, `password_hash` (bcrypt), `nombre_completo`, `rol` (admin/a_thomas/french), `activo`

**`webhook_events`** — Idempotencia de webhooks (evita procesar dos veces)
- `id`, `event_type`, `resource_id`, `signature`, `processed_at`
- UNIQUE constraint en (event_type, resource_id, signature)

### Acceso directo a Neon

Para consultas ad-hoc o debugging:
1. https://console.neon.tech → proyecto Piccadely → SQL Editor
2. O via CLI: `psql "$DATABASE_URL"`

---

## Endpoints del API

Base URL: `https://piccadely-panel-production.up.railway.app`

### Públicos / sin auth
- `GET /api/health` — health check (200 si todo OK, 503 si DB caída)
- `POST /api/login` — login (body: `{username, password}`, devuelve JWT)
- `GET /api/webhooks/tiendanube` — verificación del endpoint
- `POST /api/webhooks/tiendanube` — receptor de webhooks (requiere firma HMAC válida)

### Con autenticación (cualquier rol)
- `GET /api/orders` — pedidos de TN sincronizados
- `GET /api/products`, `GET /api/categories` — catálogo TN
- `GET /api/estados`, `POST /api/estados/:id` — estados internos
- `GET /api/pedidos-manuales`, `POST /api/pedidos-manuales` — pedidos manuales
- `GET /api/pedidos/productos/:id`, `POST /api/pedidos/productos/:id` — override de productos
- `POST /api/caja/apertura`, `GET /api/caja/estado/:local/:fecha`, `POST /api/caja/ajuste`, `POST /api/caja/cierre`, `GET /api/caja/historial/:local`
- `POST /api/facturar` — emitir comprobante
- `POST /api/nota-credito` — anular factura con NC
- `GET /api/facturas/:pedidoId` — historial de comprobantes de un pedido
- `GET /api/me` — info del usuario logueado
- `POST /api/cambiar-password` — cambiar la propia contraseña

### Solo admin
- `GET /api/usuarios`, `POST /api/usuarios`, `PATCH /api/usuarios/:id`, `DELETE /api/usuarios/:id`
- `POST /api/admin/backfill-orders` — re-importar todos los pedidos de TN
- `GET /api/admin/webhooks`, `POST /api/admin/webhooks/setup` — gestión de webhooks de TN

Auth se hace via header `Authorization: Bearer {JWT}` o, para scripts internos, `x-admin-secret: {ADMIN_SECRET}`.

---

## Operaciones comunes

### Agregar un usuario nuevo

**Opción A (via panel)**: login como admin → menú → Usuarios → Agregar usuario → llenar formulario.

**Opción B (via SQL directo)**:
```sql
INSERT INTO usuarios (username, password_hash, nombre_completo, rol)
VALUES ('nuevo_user', '$2b$10$HASH', 'Nombre Completo', 'a_thomas');
-- Para generar el hash: en Node, `await require('bcrypt').hash('password', 10)`
```

### Resetear la contraseña de un usuario olvidadizo

Como admin: menú → Usuarios → editar al usuario → setear nueva password → guardar.

### Re-sincronizar pedidos de TN (backfill)

Cuando se cambia algo en la lógica de procesamiento de webhooks, o cuando faltan pedidos en Neon:

```powershell
curl -X POST https://piccadely-panel-production.up.railway.app/api/admin/backfill-orders `
  -H "x-admin-secret: $ADMIN_SECRET"
```

O via panel: TODO — agregar botón de backfill en la UI.

### Descargar un backup de la DB

1. GitHub → repo `Piccadely-panel` → pestaña Actions
2. Click en "Backup diario de Neon" en el sidebar
3. Click en la corrida más reciente (o la del día que querés)
4. Scrolleá abajo → sección "Artifacts"
5. Click en el archivo `backup-{fecha}` → descarga un .zip

Para restaurar a una DB nueva:
```powershell
# Descomprimir
gzip -d piccadely_backup_2026-05-20.sql.gz

# Restaurar (DESTINO_URL es una DB vacía)
psql "$DESTINO_URL" < piccadely_backup_2026-05-20.sql
```

### Rotar credenciales (en caso de filtración)

1. **`JWT_SECRET`**: generar nuevo con `node -e "console.log(require('crypto').randomBytes(64).toString('base64'))"`. Reemplazar en Railway. **Efecto colateral**: todos los usuarios quedan deslogueados, tienen que volver a entrar.
2. **`ADMIN_SECRET`**: igual, con `randomBytes(32)`.
3. **`TN_ACCESS_TOKEN`**: contactar a `socios@tiendanube.com` o regenerar desde Partner Portal.
4. **`TN_CLIENT_SECRET`**: igual.
5. **Tokens de TusFacturas**: regenerar desde panel de TF.

Después de rotar, reemplazar la variable en Railway. Railway redeploya automáticamente.

### Ver logs en tiempo real

- **Backend**: Railway → Piccadely-panel → Deploy Logs (en vivo)
- **Frontend**: Vercel → Piccadely-panel → Logs (de cada request a Vercel)

---

## Troubleshooting

### Los empleados no pueden loguearse

1. ¿El backend está vivo? `curl https://piccadely-panel-production.up.railway.app/api/health`
   - Si responde 200 + `"healthy"` → el backend está OK
   - Si no responde o devuelve 503 → revisar Railway logs
2. ¿UptimeRobot está mostrando DOWN? Revisar mail.
3. ¿Cambió el `JWT_SECRET`? Si sí, los empleados tienen que entrar como si fuera la primera vez (su token viejo es inválido).

### Los pedidos no entran al panel

1. Verificar que el webhook de TN esté funcionando: `GET /api/admin/webhooks` debería listar 5 webhooks activos.
2. Revisar Railway logs por errores de "Webhook con firma inválida" → puede indicar que cambió el `TN_CLIENT_SECRET`.
3. Como workaround temporal: correr el backfill manual.

### Un pedido cae en la sucursal equivocada

Ver `clasificarPedido()` en `src/App.jsx`. La lógica:
- ULID `01KQ7TFQPTTZQ7CFFKCKVWEZQV` → A. Thomas
- ULID `01KQ7S2Z0799JKAT5A1VTH12EQ` → French
- Fallback por nombre: si contiene "recoleta" → French, sino → A. Thomas

Si TN cambia los ULIDs, hay que actualizarlos en `App.jsx`.

### El backup diario falla

GitHub Actions manda mail automático si falla. Revisar Actions → workflow "Backup diario de Neon" → ver logs del run que falló. Causas comunes:
- `DATABASE_URL` cambió y el secret de GitHub está viejo
- Neon caído (improbable, raro)
- Conflicto de versión de pg_dump (el workflow usa Postgres 17 client, igual que Neon)

### Una factura no se emitió pero el panel dice que sí

1. Revisar tabla `facturas` en Neon, columna `datos_raw` para ver la respuesta cruda de TusFacturas
2. Loguearse al panel de TusFacturas (https://www.tusfacturas.app) y buscar por `external_reference`
3. Si no aparece en TF, hay que volver a emitir manualmente

### Anular un pedido que ya tiene factura

1. El panel obliga a anular primero la factura con nota de crédito
2. Click en 🧾 Facturar → tab del comprobante → "Anular con nota de crédito"
3. Después sí, click en "Anular pedido"

---

## Pendientes / roadmap

### Seguridad
- [x] Mover credenciales a variables de entorno
- [x] Backup diario automático
- [x] Health check + monitoreo con alertas
- [ ] Validación backend de operaciones de caja (hoy se valida solo en frontend)
- [ ] Auditoría: agregar campos `creado_por` / `modificado_por` en cada tabla
- [ ] Tests automatizados del backend

### Funcionalidad
- [ ] TusFacturas productivo (hoy es sandbox)
- [ ] Dar de alta los 2 PDVs nuevos en ARCA (no compartibles con Maxirest)
- [ ] WhatsApp automático al cliente (Twilio o WhatsApp Business API)
- [ ] Histórico del cliente al abrir un pedido
- [ ] Comanda automática a impresora de cocina (sin el paso de imprimir manual)
- [ ] Mapa de ruta del día (Google Maps)
- [ ] CRM: cumpleaños, dormidos, fidelización
- [ ] Dashboard ejecutivo con KPIs
- [ ] Comparativa A. Thomas vs French
- [ ] Análisis de horarios pico
- [ ] Stock e ingredientes
- [ ] Asignación automática de repartidor
- [ ] Tracking de repartidor para el cliente
- [ ] Integración con Rappi / PedidosYa / Uber Eats
- [ ] CI/CD con tests automáticos

### Limpieza técnica
- [ ] Cambiar `sslmode=require` → `sslmode=verify-full` en DATABASE_URL
- [ ] Dar de baja la DB vieja en Railway Postgres (si todavía existe)
- [ ] Refactorear `src/App.jsx` (~2100 líneas) en componentes separados
- [ ] Migrar a TypeScript

---

## Contacto

- **Owner del proyecto**: Maximiliano Winschel
- **Email**: chapa@piccadely.com
- **Empresa**: Piccadely

Para emergencias operativas: revisar el dashboard de UptimeRobot y los Railway logs primero. La mayoría de los problemas son visibles ahí.