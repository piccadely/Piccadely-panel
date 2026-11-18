# Piccadely panel

## Entornos

| | Staging (rama `staging`) | Producción (rama `main`) |
|---|---|---|
| Backend (Railway) | https://piccadely-staging-production.up.railway.app | https://piccadely-panel-production.up.railway.app |
| Front (Vercel) | https://piccadely-panel-git-staging-piccadely-s-projects.vercel.app | https://cotizador.piccadely.com · https://piccadely-panel.vercel.app |

- Front de producción (panel) = https://piccadely-panel.vercel.app. La raíz https://cotizador.piccadely.com/ es pública: sirve el cotizador unificado (`public/cotizador.html`, Eventos + Regalos; `?tipo=eventos|regalos` saltea la elección) por el rewrite de `vercel.json`. El resto de las rutas de ese dominio todavía cargan el panel (retorno de Mercado Pago, favoritos del equipo); sacarlo de ahí queda para cuando haya `panel.piccadely.com` y la URL de retorno de MP cambiada.
- La preview de Vercel de staging tiene Vercel SSO (redirige a login). Para probar el front de staging sin login: servir la rama `staging` en local (`npx vite`) y abrir la página con `?api=<backend staging>`, por ejemplo `/cotizador.html?tipo=regalos&api=https://piccadely-staging-production.up.railway.app`.
- Probá siempre en staging antes de mergear a main.
- Al verificar producción no mandar propuestas ni leads ni usar botones que guarden o envíen.

## Manual del panel

- `docs/manual_panel.md` es el manual de uso del panel y la única fuente de conocimiento del asistente 💬 (`/api/agente` lo lee al arrancar el server).
- Toda feature que agregue o cambie una pantalla, botón o flujo actualiza `docs/manual_panel.md` en el mismo commit, con los nombres exactos que aparecen en pantalla y quién lo ve. Sin datos sensibles (claves, CUIT/CBU, montos de sueldos, endpoints).
