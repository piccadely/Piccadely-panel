// ─────────────────────────────────────────────────────────────────────
//  r2Storage.js  ·  Archivos en Cloudflare R2 (API compatible con S3)
//  Usa: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
//  El bucket es PRIVADO: los archivos se sirven por el backend o con URLs firmadas de corta duración.
//
//  autotestR2() corre al arrancar el servidor: sube un archivo chiquito, lo lee, genera una URL firmada,
//  verifica que SIN firma no se pueda descargar y lo borra. Deja en el log "R2: OK" o "R2: ERROR <motivo>"
//  (nunca imprime credenciales). Si falla, el resto del servidor sigue normal y los archivos de WhatsApp
//  quedan deshabilitados: r2Habilitado() devuelve false y los helpers tiran un error claro.
// ─────────────────────────────────────────────────────────────────────
import axios from "axios";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const VARS = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"];
const TIMEOUT_AUTOTEST_MS = 20000;

// Estado compartido: hasta que el autotest pase, los archivos están deshabilitados.
const estado = { habilitado: false, motivo: "autotest de R2 todavía no corrió", probadoAt: null };
export const r2Habilitado = () => estado.habilitado;
export const estadoR2 = () => ({ ...estado });

let cliente = null;
function s3() {
  if (!cliente) {
    cliente = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
    });
  }
  return cliente;
}
const bucket = () => process.env.R2_BUCKET;

// Mensaje de error sin credenciales (por si alguna librería las incluyera en el texto).
function limpiar(msg) {
  let m = String(msg || "error desconocido");
  for (const v of VARS) { const val = process.env[v]; if (val && val.length >= 4) m = m.split(val).join(`<${v}>`); }
  return m.slice(0, 300);
}
function exigirHabilitado() {
  if (!estado.habilitado) throw new Error(`Archivos deshabilitados: ${estado.motivo}`);
}

// ── Helpers (los usa el autotest y después los archivos de WhatsApp) ──
export async function r2Subir(key, body, contentType) {
  await s3().send(new PutObjectCommand({ Bucket: bucket(), Key: key, Body: body, ContentType: contentType || "application/octet-stream" }));
  return key;
}
export async function r2Leer(key) {
  const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
  return { body: Buffer.from(await r.Body.transformToByteArray()), contentType: r.ContentType || "application/octet-stream" };
}
// nombreDescarga (opcional): fuerza la descarga con ese nombre (documentos).
export async function r2UrlFirmada(key, segundos = 300, nombreDescarga = null) {
  const extra = {};
  if (nombreDescarga) {
    const ascii = String(nombreDescarga).replace(/[^A-Za-z0-9._ -]/g, "_");
    extra.ResponseContentDisposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nombreDescarga)}`;
  }
  return getSignedUrl(s3(), new GetObjectCommand({ Bucket: bucket(), Key: key, ...extra }), { expiresIn: segundos });
}
export async function r2Borrar(key) {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
// Versiones "seguras" para el resto del backend: fallan con aviso claro si R2 no pasó el autotest.
export const archivos = {
  subir: async (...a) => { exigirHabilitado(); return r2Subir(...a); },
  leer: async (...a) => { exigirHabilitado(); return r2Leer(...a); },
  urlFirmada: async (...a) => { exigirHabilitado(); return r2UrlFirmada(...a); },
  borrar: async (...a) => { exigirHabilitado(); return r2Borrar(...a); },
};

// ── Autotest de arranque ──
async function correrAutotest() {
  const faltan = VARS.filter(v => !process.env[v]);
  if (faltan.length) throw new Error(`faltan variables: ${faltan.join(", ")}`);

  const key = `_autotest/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const contenido = `autotest R2 piccadely ${new Date().toISOString()} ñ`;
  let subido = false;
  try {
    await r2Subir(key, contenido, "text/plain; charset=utf-8");
    subido = true;

    const leido = (await r2Leer(key)).body.toString("utf-8");
    if (leido !== contenido) throw new Error("lo leído no coincide con lo subido");

    const url = await r2UrlFirmada(key, 60);
    const conFirma = await axios.get(url, { responseType: "text", timeout: 10000, validateStatus: () => true });
    if (conFirma.status !== 200 || conFirma.data !== contenido) throw new Error(`la URL firmada no devolvió el archivo (HTTP ${conFirma.status})`);

    const sinFirma = await axios.get(url.split("?")[0], { timeout: 10000, validateStatus: () => true });
    if (sinFirma.status === 200) throw new Error("el archivo se puede descargar SIN firma: el bucket no es privado");
  } finally {
    if (subido) {
      await r2Borrar(key);
      try {
        await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: key }));
        throw new Error("el archivo de prueba sigue existiendo después de borrarlo");
      } catch (e) {
        if (!(e.name === "NotFound" || e.$metadata?.httpStatusCode === 404)) throw e;
      }
    }
  }
}

// Nunca tira: cualquier falla queda en el log y deshabilita los archivos, el servidor sigue.
export async function autotestR2() {
  try {
    await Promise.race([
      correrAutotest(),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout de ${TIMEOUT_AUTOTEST_MS / 1000} s`)), TIMEOUT_AUTOTEST_MS)),
    ]);
    Object.assign(estado, { habilitado: true, motivo: null, probadoAt: new Date().toISOString() });
    console.log("R2: OK (subir, leer, URL firmada, sin firma bloqueado, borrar) — archivos de WhatsApp habilitados.");
  } catch (e) {
    const motivo = limpiar(e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message);
    Object.assign(estado, { habilitado: false, motivo, probadoAt: new Date().toISOString() });
    console.error(`R2: ERROR ${motivo} — los archivos de WhatsApp quedan DESHABILITADOS (el resto del servidor funciona normal).`);
  }
  return estadoR2();
}
