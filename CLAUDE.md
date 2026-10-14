# Piccadely panel

## Entornos

| | Staging (rama `staging`) | Producción (rama `main`) |
|---|---|---|
| Backend (Railway) | https://piccadely-staging-production.up.railway.app | https://piccadely-panel-production.up.railway.app |
| Front (Vercel) | https://piccadely-panel-git-staging-piccadely-s-projects.vercel.app | https://cotizador.piccadely.com · https://piccadely-panel.vercel.app |

- La preview de Vercel de staging tiene Vercel SSO (redirige a login). Para probar el front de staging sin login: servir la rama `staging` en local (`npx vite`) y abrir la página con `?api=<backend staging>`, por ejemplo `/regalos.html?api=https://piccadely-staging-production.up.railway.app`.
- Probá siempre en staging antes de mergear a main.
- Al verificar producción no mandar propuestas ni leads ni usar botones que guarden o envíen.
