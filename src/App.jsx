import { useState, useEffect, useRef } from "react";
import axios from "axios";

const API = "https://piccadely-panel-production.up.railway.app";

function parsearFranja(ownerNote) {
  if (!ownerNote) return { fecha: null, franja: null };
  const match = ownerNote.match(/(\d+\/\d+\/\d+), entre las (\d+:\d+) y las (\d+:\d+)/);
  if (!match) return { fecha: null, franja: null };
  const [, fecha, inicio, fin] = match;
  const [dia, mes, anio] = fecha.split("/");
  return {
    fecha: `${anio}-${mes.padStart(2,"0")}-${dia.padStart(2,"0")}`,
    franja: `${inicio} – ${fin}`
  };
}

function nextEstado(e) {
  const seq = ["Por empaquetar", "Listo", "En camino", "Entregado"];
  const i = seq.indexOf(e);
  return i < seq.length - 1 ? seq[i + 1] : e;
}

const ESTADO_COLORS = {
  "Por empaquetar": { bg: "#f0f0e8", text: "#555" },
  "Listo":          { bg: "#faeeda", text: "#633806" },
  "En camino":      { bg: "#e6f1fb", text: "#0c447c" },
  "Entregado":      { bg: "#eaf3de", text: "#27500a" },
};

const REPARTIDORES = ["Sin asignar", "Carlessy", "Paul", "Julio", "Ramón", "eventual", "Cabify"];
const MEDIOS_PAGO = ["Mercado Pago", "Efectivo", "Transferencia", "Rappi", "Pedidos Ya", "Otro"];

const TABS = [
  { id: "retiro-at",    label: "🏪 Retiro A. Thomas" },
  { id: "retiro-fr",   label: "🏪 Retiro French" },
  { id: "delivery-at", label: "🚚 Delivery A. Thomas" },
  { id: "delivery-fr", label: "🚚 Delivery French" },
  { id: "nuevo",       label: "➕ Nuevo pedido" },
];

function clasificarPedido(p) {
  const location = p.fulfillments?.[0]?.assigned_location?.name || "";
  const tipo = p.fulfillments?.[0]?.shipping?.type || "";
  const esPickup = tipo === "pickup";
  const esAT = location === "Recoleta";
  const esFR = location === "Villa Ortuzar";
  if (esPickup && esAT) return "retiro-at";
  if (esPickup && esFR) return "retiro-fr";
  if (!esPickup && esAT) return "delivery-at";
  if (!esPickup && esFR) return "delivery-fr";
  return "delivery-at";
}

function medioPagoLabel(gateway) {
  if (!gateway) return "Otro";
  if (gateway.includes("mercado-pago")) return "Mercado Pago";
  if (gateway.includes("offline") || gateway.includes("efectivo")) return "Efectivo";
  if (gateway.includes("transfer")) return "Transferencia";
  if (gateway === "not-provided") return "Efectivo";
  return "Otro";
}

function localLabel(tabActual) {
  if (tabActual === "retiro-at" || tabActual === "delivery-at") return "A. Thomas";
  if (tabActual === "retiro-fr" || tabActual === "delivery-fr") return "French";
  return "—";
}

const FORM_INICIAL = {
  cliente: "", telefono: "", direccion: "", entreCalles: "", barrio: "", zona: "",
  fecha: "", franja: "", nota: "", medioPago: "Mercado Pago",
  seccion: "delivery-at", cobrar: false,
};

const HOY = new Date().toISOString().split("T")[0];

function guardarEstadoDB(id, estado) {
  axios.post(`${API}/api/estados/${id}`, estado).catch(console.error);
}

function fmt(n) { return `$${Number(n).toLocaleString("es-AR")}`; }
function sumar(arr) { return arr.reduce((a, p) => a + p.totalNum, 0); }

// ─── BTN FACTURAR — fuera de App para que React no lo destruya en cada render ──
function BtnFacturar({ p, version, onAbrir }) {
  const [tieneFactura, setTieneFactura] = useState(null);
  const [pdfUrl, setPdfUrl] = useState(null);

  useEffect(() => {
    axios.get(`${API}/api/facturas/${p.id}`)
      .then(res => {
        const activas = res.data.filter(f => !f.tipo.includes("NOTA DE CREDITO"));
        const ncs = res.data.filter(f => f.tipo.includes("NOTA DE CREDITO"));
        const hayFactura = activas.length > ncs.length;
        setTieneFactura(hayFactura);
        setPdfUrl(hayFactura ? (activas[activas.length - 1]?.pdf_url || null) : null);
      })
      .catch(() => setTieneFactura(false));
  }, [p.id, version]);

  if (tieneFactura === null) return null;

  const btnBase = { marginTop: 0, padding: "7px 14px", fontSize: 12, borderRadius: 6, cursor: "pointer" };

  return (
    <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
      {tieneFactura ? (
        <>
          {pdfUrl && (
            <a href={pdfUrl} target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ ...btnBase, border: "1px solid #2a7a4b", color: "#2a7a4b", background: "#eaf3de", textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              📄 PDF
            </a>
          )}
          <button
            style={{ ...btnBase, border: "1px solid #c0392b", color: "#c0392b", background: "#fdecea" }}
            onClick={e => { e.stopPropagation(); onAbrir(p); }}>
            🗑 Anular factura
          </button>
        </>
      ) : (
        <button
          style={{ ...btnBase, border: "1px solid #2a7a4b", color: "#2a7a4b", background: "#f0faf4", fontWeight: 600 }}
          onClick={e => { e.stopPropagation(); onAbrir(p); }}>
          🧾 Facturar
        </button>
      )}
    </div>
  );
}

// ─── MODAL FACTURACIÓN ───────────────────────────────────────────────
function ModalFacturacion({ p, onCerrar }) {
  const docRaw = p.identificacion || "";
  const docSinFormato = docRaw.replace(/[-\s]/g, "");
  const esCuit = docSinFormato.length > 8;
  const docLimpio = docSinFormato;

  const [tipo, setTipo] = useState(esCuit ? "FACTURA A" : "FACTURA B");
  const [docTipo, setDocTipo] = useState(esCuit ? "CUIT" : "DNI");
  const [docNro, setDocNro] = useState(docLimpio);
  const [razonSocial, setRazonSocial] = useState(p.cliente || "");
  const [email, setEmail] = useState(p.email || "");
  const [domicilio, setDomicilio] = useState(p.direccion || "");
  const [emitiendo, setEmitiendo] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [facturas, setFacturas] = useState([]);
  const [loadingFacturas, setLoadingFacturas] = useState(true);

  const esFacturaA = tipo === "FACTURA A";
  const requiereDoc = tipo === "FACTURA A";

  useEffect(() => { cargarFacturas(); }, []);

  async function cargarFacturas() {
    setLoadingFacturas(true);
    try {
      const res = await axios.get(`${API}/api/facturas/${p.id}`);
      setFacturas(res.data);
    } catch(e) {}
    setLoadingFacturas(false);
  }

  const productosFactura = p.productos.split(", ").map((prod, i) => {
    const match = prod.match(/^(.+) x(\d+)$/);
    const descripcion = match ? match[1] : prod;
    const cantidad = match ? Number(match[2]) : 1;
    return { descripcion, cantidad, codigo: `PROD${i+1}` };
  });

  const totalLimpio = (() => {
    if (typeof p.totalNum === "number" && p.totalNum > 0) return p.totalNum;
    const raw = String(p.totalNum).trim();
    if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
    return Number(raw.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", "."));
  })();

  async function emitir() {
    if (requiereDoc && !docNro.trim()) { alert("Para Factura A es obligatorio el CUIT"); return; }
    if (!totalLimpio || totalLimpio <= 0) { alert("Error: no se pudo determinar el total del pedido"); return; }
    setEmitiendo(true);
    setResultado(null);
    try {
      const res = await axios.post(`${API}/api/facturar`, {
        pedidoId: p.id, tipo, cliente: p.cliente,
        documentoTipo: docTipo, documentoNro: docNro.trim(),
        razonSocial, domicilio, email,
        total: totalLimpio, productos: productosFactura,
      });
      setResultado(res.data);
      if (res.data.ok) await cargarFacturas();
    } catch (e) { setResultado({ ok: false, error: e.message }); }
    setEmitiendo(false);
  }

  async function emitirNC(facturaId) {
    if (!window.confirm("¿Anular este comprobante con nota de crédito?")) return;
    setEmitiendo(true);
    try {
      const res = await axios.post(`${API}/api/nota-credito`, { facturaId, pedidoId: p.id });
      if (res.data.ok) {
        await cargarFacturas();
        setResultado({ ok: true, data: res.data.data, esNC: true });
      } else {
        setResultado({ ok: false, error: res.data.error });
      }
    } catch (e) { setResultado({ ok: false, error: e.message }); }
    setEmitiendo(false);
  }

  const facturasActivas = facturas.filter(f => !f.tipo.includes("NOTA DE CREDITO"));
  const notasCredito = facturas.filter(f => f.tipo.includes("NOTA DE CREDITO"));
  const tieneFacturaActiva = facturasActivas.length > notasCredito.length;
  const facturaActiva = facturasActivas[facturasActivas.length - 1];

  return (
    <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 540, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#333" }}>🧾 Facturación</div>
            <div style={{ fontSize: 12, color: "#888" }}>{p.numero} — {p.cliente} — {p.total}</div>
          </div>
          <button style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#aaa", lineHeight: 1 }} onClick={onCerrar}>✕</button>
        </div>

        {esCuit && !tieneFacturaActiva && (
          <div style={{ background: "#fef9e7", border: "1px solid #f39c12", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#856404" }}>
            ⚠️ Este cliente tiene <strong>CUIT</strong> registrado — se sugiere emitir <strong>Factura A</strong>
          </div>
        )}

        {!loadingFacturas && tieneFacturaActiva && facturaActiva && (
          <div style={{ background: "#eaf3de", border: "2px solid #2a7a4b", borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#2a7a4b", marginBottom: 8 }}>✅ Pedido facturado</div>
            <div style={{ fontSize: 13, color: "#333", marginBottom: 4 }}>{facturaActiva.tipo} Nº {facturaActiva.numero}</div>
            <div style={{ fontSize: 11, color: "#888", marginBottom: 12 }}>{facturaActiva.fecha} · CAE: {facturaActiva.cae} · {fmt(facturaActiva.total)}</div>
            <div style={{ display: "flex", gap: 10 }}>
              {facturaActiva.pdf_url && (
                <a href={facturaActiva.pdf_url} target="_blank" rel="noreferrer"
                  style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "1px solid #2a7a4b", color: "#2a7a4b", textDecoration: "none", background: "#fff", fontWeight: 600, fontSize: 13, textAlign: "center" }}>
                  📄 Descargar PDF
                </a>
              )}
              <button onClick={() => emitirNC(facturaActiva.id)} disabled={emitiendo}
                style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "none", background: "#c0392b", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}>
                {emitiendo ? "Anulando..." : "🗑 Anular factura"}
              </button>
            </div>
          </div>
        )}

        {!loadingFacturas && facturas.some(f => f.tipo.includes("NOTA DE CREDITO")) && (
          <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 14, marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 8 }}>Historial</div>
            {facturas.map(f => {
              const esNC = f.tipo.includes("NOTA DE CREDITO");
              return (
                <div key={f.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #eee" }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: esNC ? "#c0392b" : "#2a7a4b" }}>
                      {esNC ? "✖ " : "✔ "}{f.tipo} Nº {f.numero}
                    </div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{f.fecha} · CAE: {f.cae}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: esNC ? "#c0392b" : "#2a7a4b" }}>
                      {esNC ? "-" : ""}{fmt(Math.abs(f.total))}
                    </span>
                    {f.pdf_url && (
                      <a href={f.pdf_url} target="_blank" rel="noreferrer"
                        style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid #2a7a4b", color: "#2a7a4b", textDecoration: "none", background: "#eaf3de" }}>
                        PDF
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {resultado && (
          <div style={{ borderRadius: 8, padding: "10px 14px", marginBottom: 14, background: resultado.ok ? "#eaf3de" : "#fdecea", border: `1px solid ${resultado.ok ? "#2a7a4b" : "#c0392b"}` }}>
            {resultado.ok ? (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#2a7a4b" }}>
                  ✅ {resultado.esNC ? "Comprobante anulado — ya podés volver a facturar" : "Comprobante emitido"}
                </div>
                <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Nº {resultado.data?.comprobante_nro} — CAE: {resultado.data?.cae}</div>
                {resultado.data?.comprobante_pdf_url && (
                  <a href={resultado.data.comprobante_pdf_url} target="_blank" rel="noreferrer"
                    style={{ fontSize: 12, color: "#2a7a4b", textDecoration: "underline", display: "block", marginTop: 4 }}>
                    📄 Descargar PDF
                  </a>
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#c0392b" }}>❌ Error: {typeof resultado.error === "string" ? resultado.error : JSON.stringify(resultado.error)}</div>
            )}
          </div>
        )}

        {!loadingFacturas && !tieneFacturaActiva && (
          <div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 6 }}>Tipo de comprobante</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {["FACTURA B", "FACTURA A", "FACTURA B EXENTO", "TICKET X"].map(t => (
                  <button key={t}
                    onClick={() => { setTipo(t); if (t === "FACTURA A") { setDocTipo("CUIT"); } else { setDocTipo("DNI"); setDocNro(""); } }}
                    style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: "1px solid", cursor: "pointer",
                      borderColor: tipo === t ? "#2a7a4b" : "#ddd", background: tipo === t ? "#eaf3de" : "#fff",
                      color: tipo === t ? "#2a7a4b" : "#555", fontWeight: tipo === t ? 600 : 400 }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>
                  Documento {!requiereDoc && <span style={{ fontWeight: 400, color: "#aaa" }}>(opcional)</span>}
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <select style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: 72 }}
                    value={docTipo} onChange={e => setDocTipo(e.target.value)}>
                    <option value="DNI">DNI</option>
                    <option value="CUIT">CUIT</option>
                  </select>
                  <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", flex: 1 }}
                    value={docNro} onChange={e => setDocNro(e.target.value)}
                    placeholder={requiereDoc ? "Obligatorio" : "Opcional"} />
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Nombre / Razón social</div>
                <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }}
                  value={razonSocial} onChange={e => setRazonSocial(e.target.value)} />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Email (opcional)</div>
                <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }}
                  value={email} onChange={e => setEmail(e.target.value)} placeholder="cliente@email.com" />
              </div>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Domicilio</div>
                <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }}
                  value={domicilio} onChange={e => setDomicilio(e.target.value)} />
              </div>
            </div>
            <div style={{ background: "#f9f9f7", borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, color: "#666" }}>Total a facturar</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: "#2a7a4b" }}>{p.total}</span>
            </div>
            <button
              style={{ width: "100%", padding: 11, borderRadius: 8, border: "none",
                background: emitiendo ? "#ccc" : "#2a7a4b", color: "#fff", fontSize: 13, fontWeight: 600,
                cursor: emitiendo ? "default" : "pointer" }}
              onClick={emitir} disabled={emitiendo}>
              {emitiendo ? "Emitiendo..." : `Emitir ${tipo}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── COMPONENTE CAJA ─────────────────────────────────────────────────
function VistaCaja({ pedidosFinalizados, onVolver }) {
  const [localSeleccionado, setLocalSeleccionado] = useState("A. Thomas");
  const [estadoCaja, setEstadoCaja] = useState(null);
  const [loadingCaja, setLoadingCaja] = useState(false);
  const [montoApertura, setMontoApertura] = useState("");
  const [ajuste, setAjuste] = useState({ tipo: "entrada", concepto: "", monto: "" });
  const [montoCierre, setMontoCierre] = useState("");
  const [mostrarAjuste, setMostrarAjuste] = useState(false);
  const [guardando, setGuardando] = useState(false);

  async function cargarEstado() {
    setLoadingCaja(true);
    try {
      const res = await axios.get(`${API}/api/caja/estado/${encodeURIComponent(localSeleccionado)}/${HOY}`);
      setEstadoCaja(res.data);
    } catch (e) { console.error(e); }
    setLoadingCaja(false);
  }

  useEffect(() => { cargarEstado(); }, [localSeleccionado]);

  async function abrirCaja() {
    if (!montoApertura) return;
    setGuardando(true);
    await axios.post(`${API}/api/caja/apertura`, { local: localSeleccionado, fecha: HOY, montoInicial: Number(montoApertura) });
    setMontoApertura("");
    await cargarEstado();
    setGuardando(false);
  }

  async function registrarAjuste() {
    if (!ajuste.concepto || !ajuste.monto) return;
    setGuardando(true);
    const monto = ajuste.tipo === "salida" ? -Math.abs(Number(ajuste.monto)) : Math.abs(Number(ajuste.monto));
    await axios.post(`${API}/api/caja/ajuste`, { local: localSeleccionado, fecha: HOY, tipo: ajuste.tipo, concepto: ajuste.concepto, monto });
    setAjuste({ tipo: "entrada", concepto: "", monto: "" });
    setMostrarAjuste(false);
    await cargarEstado();
    setGuardando(false);
  }

  async function cerrarCaja() {
    if (!montoCierre) return;
    setGuardando(true);
    await axios.post(`${API}/api/caja/cierre`, { local: localSeleccionado, fecha: HOY, montoCierre: Number(montoCierre) });
    setMontoCierre("");
    await cargarEstado();
    setGuardando(false);
  }

  const ventasLocal = pedidosFinalizados.filter(p => p.local === localSeleccionado);
  const ventasPorMedio = MEDIOS_PAGO.reduce((acc, m) => { acc[m] = ventasLocal.filter(p => p.medioPago === m); return acc; }, {});
  const totalVentas = sumar(ventasLocal);
  const totalEfectivo = sumar(ventasPorMedio["Efectivo"] || []);
  const montoInicial = estadoCaja?.apertura?.monto_inicial || 0;
  const ajustes = estadoCaja?.movimientos?.filter(m => m.tipo === "entrada" || m.tipo === "salida") || [];
  const totalAjustes = ajustes.reduce((a, m) => a + Number(m.monto), 0);
  const saldoEsperado = Number(montoInicial) + totalEfectivo + totalAjustes;
  const cerrada = estadoCaja?.apertura?.cerrada;

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f7f7f5" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #eee" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" }} onClick={onVolver}>← Volver</button>
          <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>💰 Caja</h2>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {["A. Thomas", "French"].map(l => (
            <button key={l} onClick={() => setLocalSeleccionado(l)}
              style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer",
                borderColor: localSeleccionado === l ? "#2a7a4b" : "#ddd",
                background: localSeleccionado === l ? "#2a7a4b" : "#fff",
                color: localSeleccionado === l ? "#fff" : "#555", fontWeight: localSeleccionado === l ? 600 : 400 }}>
              📍 {l}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: 24 }}>
        {loadingCaja ? <div style={{ color: "#aaa", fontSize: 13 }}>Cargando caja...</div>
        : !estadoCaja?.apertura ? (
          <div style={{ maxWidth: 400 }}>
            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 24 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "#333", marginBottom: 16 }}>🔓 Apertura de caja — {localSeleccionado}</div>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>EFECTIVO INICIAL EN CAJA</div>
              <input type="number" style={{ fontSize: 14, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 12 }}
                placeholder="$0" value={montoApertura} onChange={e => setMontoApertura(e.target.value)} />
              <button style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#2a7a4b", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                onClick={abrirCaja} disabled={guardando}>{guardando ? "Abriendo..." : "Abrir caja"}</button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>📊 Ventas del día — {localSeleccionado}</div>
              {MEDIOS_PAGO.map(medio => {
                const pedidos = ventasPorMedio[medio] || [];
                if (pedidos.length === 0) return null;
                return (
                  <div key={medio} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f5f5f5" }}>
                    <div><div style={{ fontSize: 13, color: "#333", fontWeight: 500 }}>{medio}</div><div style={{ fontSize: 11, color: "#aaa" }}>{pedidos.length} pedido{pedidos.length > 1 ? "s" : ""}</div></div>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "#2a7a4b" }}>{fmt(sumar(pedidos))}</span>
                  </div>
                );
              })}
              {ventasLocal.length === 0 && <div style={{ fontSize: 12, color: "#aaa" }}>Sin ventas registradas</div>}
              <div style={{ borderTop: "2px solid #eee", marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Total ventas</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#2a7a4b" }}>{fmt(totalVentas)}</span>
              </div>
            </div>
            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>
                🏦 Estado de caja {cerrada && <span style={{ fontSize: 11, background: "#c0392b", color: "#fff", padding: "2px 8px", borderRadius: 4, marginLeft: 8 }}>CERRADA</span>}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}><span style={{ fontSize: 13, color: "#666" }}>Monto inicial</span><span style={{ fontSize: 13, fontWeight: 500 }}>{fmt(montoInicial)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}><span style={{ fontSize: 13, color: "#666" }}>Ventas efectivo</span><span style={{ fontSize: 13, fontWeight: 500 }}>{fmt(totalEfectivo)}</span></div>
              {ajustes.map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}>
                  <span style={{ fontSize: 12, color: Number(a.monto) >= 0 ? "#2a7a4b" : "#c0392b" }}>{Number(a.monto) >= 0 ? "↑" : "↓"} {a.concepto}</span>
                  <span style={{ fontSize: 12, fontWeight: 500, color: Number(a.monto) >= 0 ? "#2a7a4b" : "#c0392b" }}>{fmt(Math.abs(a.monto))}</span>
                </div>
              ))}
              <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 6px", borderTop: "2px solid #eee", marginTop: 4 }}>
                <span style={{ fontSize: 14, fontWeight: 600 }}>Saldo esperado</span>
                <span style={{ fontSize: 16, fontWeight: 700, color: "#2a7a4b" }}>{fmt(saldoEsperado)}</span>
              </div>
              {cerrada && estadoCaja.apertura.monto_cierre !== null && (
                <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 12, marginTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 13, color: "#666" }}>Efectivo contado al cierre</span><span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(estadoCaja.apertura.monto_cierre)}</span></div>
                  <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 13, color: "#666" }}>Diferencia</span><span style={{ fontSize: 13, fontWeight: 600, color: (estadoCaja.apertura.monto_cierre - saldoEsperado) >= 0 ? "#2a7a4b" : "#c0392b" }}>{fmt(estadoCaja.apertura.monto_cierre - saldoEsperado)}</span></div>
                </div>
              )}
            </div>
            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>📋 Movimientos del día</div>
                {!cerrada && <button style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #2a7a4b", background: "none", color: "#2a7a4b", cursor: "pointer" }} onClick={() => setMostrarAjuste(m => !m)}>+ Ajuste</button>}
              </div>
              {mostrarAjuste && !cerrada && (
                <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                    <button onClick={() => setAjuste(a => ({...a, tipo: "entrada"}))} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid", cursor: "pointer", fontSize: 12, borderColor: ajuste.tipo === "entrada" ? "#2a7a4b" : "#ddd", background: ajuste.tipo === "entrada" ? "#eaf3de" : "#fff", color: ajuste.tipo === "entrada" ? "#2a7a4b" : "#555" }}>↑ Entrada</button>
                    <button onClick={() => setAjuste(a => ({...a, tipo: "salida"}))} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid", cursor: "pointer", fontSize: 12, borderColor: ajuste.tipo === "salida" ? "#c0392b" : "#ddd", background: ajuste.tipo === "salida" ? "#fdecea" : "#fff", color: ajuste.tipo === "salida" ? "#c0392b" : "#555" }}>↓ Salida</button>
                  </div>
                  <input style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 6 }} placeholder="Concepto" value={ajuste.concepto} onChange={e => setAjuste(a => ({...a, concepto: e.target.value}))} />
                  <input type="number" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 8 }} placeholder="Monto" value={ajuste.monto} onChange={e => setAjuste(a => ({...a, monto: e.target.value}))} />
                  <button style={{ width: "100%", padding: "7px", borderRadius: 6, border: "none", background: "#333", color: "#fff", fontSize: 12, cursor: "pointer" }} onClick={registrarAjuste} disabled={guardando}>Registrar ajuste</button>
                </div>
              )}
              {estadoCaja?.movimientos?.length === 0 && <div style={{ fontSize: 12, color: "#aaa" }}>Sin movimientos</div>}
              {estadoCaja?.movimientos?.map((m, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}>
                  <div><div style={{ fontSize: 12, color: "#333" }}>{m.concepto}</div><div style={{ fontSize: 11, color: "#aaa" }}>{new Date(m.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</div></div>
                  <span style={{ fontSize: 13, fontWeight: 500, color: m.tipo === "salida" ? "#c0392b" : "#2a7a4b" }}>{m.tipo === "salida" ? "-" : "+"}{fmt(Math.abs(m.monto))}</span>
                </div>
              ))}
            </div>
            {!cerrada && (
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>🔒 Cierre Z</div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Saldo esperado: <strong>{fmt(saldoEsperado)}</strong></div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>EFECTIVO CONTADO AL CIERRE</div>
                <input type="number" style={{ fontSize: 14, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 10 }} placeholder="$0" value={montoCierre} onChange={e => setMontoCierre(e.target.value)} />
                {montoCierre && <div style={{ background: "#f9f9f7", borderRadius: 6, padding: "8px 12px", marginBottom: 10, fontSize: 12 }}>Diferencia: <strong style={{ color: (Number(montoCierre) - saldoEsperado) >= 0 ? "#2a7a4b" : "#c0392b" }}>{fmt(Number(montoCierre) - saldoEsperado)}</strong></div>}
                <button style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#c0392b", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={cerrarCaja} disabled={guardando || !montoCierre}>{guardando ? "Cerrando..." : "Ejecutar cierre Z"}</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── APP PRINCIPAL ───────────────────────────────────────────────────
export default function App() {
  const [pedidosRaw, setPedidosRaw] = useState([]);
  const [pedidosLocales, setPedidosLocales] = useState({});
  const [pedidosManuales, setPedidosManuales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("retiro-at");
  const [vista, setVista] = useState("panel");
  const [filtroFecha, setFiltroFecha] = useState("");
  const [filtroZona, setFiltroZona] = useState("");
  const [expandido, setExpandido] = useState(null);
  const [menuAbierto, setMenuAbierto] = useState(false);
  const [filtroFinDesde, setFiltroFinDesde] = useState("");
  const [filtroFinHasta, setFiltroFinHasta] = useState("");
  const [filtroRepartidor, setFiltroRepartidor] = useState("");
  const [facturando, setFacturando] = useState(null);
  const [facturaVersion, setFacturaVersion] = useState(0);
  const menuRef = useRef(null);

  const [productos, setProductos] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [loadingProductos, setLoadingProductos] = useState(false);
  const [busqueda, setBusqueda] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState("");
  const [carrito, setCarrito] = useState([]);
  const [form, setForm] = useState(FORM_INICIAL);
  const [pedidoCreado, setPedidoCreado] = useState(false);
const [comandasImpresas, setComandasImpresas] = useState({});
  useEffect(() => {
    Promise.all([
      axios.get(`${API}/api/orders`),
      axios.get(`${API}/api/estados`),
      axios.get(`${API}/api/pedidos-manuales`),
    ]).then(([resOrders, resEstados, resManuales]) => {
      setPedidosRaw(resOrders.data);
      const locales = {};
      resOrders.data.forEach(p => {
        locales[p.id] = resEstados.data[p.id] || {
          estado: "Por empaquetar", repartidor: "Sin asignar",
          tabManual: null, fechaManual: null, franjaManual: null,
          cobrar: p.payment_status !== "paid",
        };
      });
      resManuales.data.forEach(p => {
        locales[p.id] = resEstados.data[p.id] || {
          estado: "Por empaquetar", repartidor: "Sin asignar",
          tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar,
        };
      });
      setPedidosLocales(locales);
      setPedidosManuales(resManuales.data);
      setLoading(false);
    }).catch(() => { setError("Error conectando con Tienda Nube"); setLoading(false); });
  }, []);

  useEffect(() => {
    if (tab === "nuevo" && productos.length === 0) {
      setLoadingProductos(true);
      Promise.all([
        axios.get(`${API}/api/products`),
        axios.get(`${API}/api/categories`),
      ]).then(([resP, resC]) => {
        setProductos(resP.data.filter(p => p.variants?.[0]?.price));
        setCategorias(resC.data.filter(c => c.parent === null));
        setLoadingProductos(false);
      }).catch(() => setLoadingProductos(false));
    }
  }, [tab]);

  useEffect(() => {
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuAbierto(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const pedidosProcesados = [
    ...pedidosRaw.map(p => {
      const zona = p.fulfillments?.[0]?.shipping?.option?.name || "Sin zona";
      const { fecha, franja } = parsearFranja(p.owner_note);
      const prods = p.products.map(pr => `${pr.name} x${pr.quantity}`).join(", ");
      const local = pedidosLocales[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: false };
      const tabAuto = clasificarPedido(p);
      const tabActual = local.tabManual || tabAuto;
      const fechaDisplay = local.fechaManual || fecha;
      const franjaDisplay = local.franjaManual || franja || "Sin franja";
      const medioPago = medioPagoLabel(p.gateway);
      const totalNum = Number(p.total);
      return {
        id: p.id, numero: `#${p.number}`, cliente: p.contact_name, telefono: p.contact_phone,
        direccion: `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}${p.shipping_address?.floor ? ` ${p.shipping_address.floor}` : ""}`.trim(),
        barrio: p.shipping_address?.locality || p.shipping_address?.city || "",
        zona, fecha, franja, fechaDisplay, franjaDisplay,
        productos: prods, totalNum,
        total: `$${totalNum.toLocaleString("es-AR")}`,
        pago: p.payment_status === "paid" ? "Pagado" : "Pendiente",
        medioPago, gateway: p.gateway,
        esTakeaway: p.fulfillments?.[0]?.shipping?.type === "pickup",
        estado: local.estado, repartidor: local.repartidor, cobrar: local.cobrar,
        tabActual, local: localLabel(tabActual), nota: p.note || "", esManual: false, entreCalles: "",
        identificacion: p.identification?.number || "",
        email: p.contact_email || "",
      };
    }),
    ...pedidosManuales.map(p => {
      const local = pedidosLocales[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar };
      const tabActual = local.tabManual || p.tabActual;
      return {
        ...p, estado: local.estado, repartidor: local.repartidor,
        cobrar: local.cobrar !== undefined ? local.cobrar : p.cobrar,
        tabActual, local: localLabel(tabActual),
        fechaDisplay: local.fechaManual || p.fecha,
        franjaDisplay: local.franjaManual || p.franja || "Sin franja",
        identificacion: p.identificacion || "",
        email: p.email || "",
      };
    }),
  ];

  const pedidosActivos = pedidosProcesados.filter(p => {
    const estado = pedidosLocales[p.id]?.estado || p.estado;
    if (estado === "Entregado") return false;
    if (!p.fechaDisplay) return true;
    return p.fechaDisplay >= HOY;
  });

  const pedidosFinalizados = pedidosProcesados.filter(p => {
    const estado = pedidosLocales[p.id]?.estado || p.estado;
    return estado === "Entregado";
  });

  const fechas = [...new Set(pedidosActivos.filter(p => p.fechaDisplay).map(p => p.fechaDisplay))].sort();
  const zonas = [...new Set(pedidosActivos.map(p => p.zona))].sort();

  const filtrados = pedidosActivos.filter(p => {
    if (p.tabActual !== tab) return false;
    if (filtroFecha && p.fechaDisplay !== filtroFecha) return false;
    if (filtroZona && p.zona !== filtroZona) return false;
    return true;
  });

  const porFranja = {};
  filtrados.forEach(p => {
    const key = p.fechaDisplay ? `${p.fechaDisplay}|${p.franjaDisplay}` : `sin-fecha|${p.franjaDisplay}`;
    if (!porFranja[key]) porFranja[key] = [];
    porFranja[key].push(p);
  });
  const franjas = Object.keys(porFranja).sort();

  function actualizarLocal(id, cambios) {
    setPedidosLocales(prev => {
      const nuevo = { ...prev, [id]: { ...prev[id], ...cambios } };
      guardarEstadoDB(id, nuevo[id]);
      return nuevo;
    });
  }

  function cambiarEstado(id, e) {
    e.stopPropagation();
    setPedidosLocales(prev => {
      const estadoActual = prev[id]?.estado || "Por empaquetar";
      const nuevoEstado = nextEstado(estadoActual);
      const nuevo = { ...prev, [id]: { ...prev[id], estado: nuevoEstado } };
      guardarEstadoDB(id, nuevo[id]);
      return nuevo;
    });
  }
  function cambiarRepartidor(id, valor) { actualizarLocal(id, { repartidor: valor }); }
  function cambiarTab(id, valor) { actualizarLocal(id, { tabManual: valor }); }
  function cambiarFecha(id, valor) { actualizarLocal(id, { fechaManual: valor }); }
  function cambiarFranja(id, valor) { actualizarLocal(id, { franjaManual: valor }); }
  function cambiarCobrar(id, valor) { actualizarLocal(id, { cobrar: valor }); }
  function toggleExpandido(id) { setExpandido(prev => prev === id ? null : id); }

  function agregarAlCarrito(prod) {
    const precio = Number(prod.variants[0].price);
    const variantId = prod.variants[0].id;
    setCarrito(prev => {
      const existe = prev.find(i => i.variantId === variantId);
      if (existe) return prev.map(i => i.variantId === variantId ? { ...i, cantidad: i.cantidad + 1 } : i);
      return [...prev, { id: prod.id, variantId, nombre: prod.name.es, precio, cantidad: 1 }];
    });
  }
  function cambiarCantidad(variantId, delta) {
    setCarrito(prev => prev.map(i => i.variantId === variantId ? { ...i, cantidad: Math.max(1, i.cantidad + delta) } : i));
  }
  function quitarDelCarrito(variantId) {
    setCarrito(prev => prev.filter(i => i.variantId !== variantId));
  }
  const totalCarrito = carrito.reduce((a, i) => a + i.precio * i.cantidad, 0);

  async function crearPedido() {
    if (!form.cliente || carrito.length === 0) return;
    const id = `manual-${Date.now()}`;
    const productosStr = carrito.map(i => `${i.nombre} x${i.cantidad}`).join(", ");
    const nuevoPedido = {
      id, numero: `#M${Date.now().toString().slice(-4)}`,
      cliente: form.cliente, telefono: form.telefono,
      direccion: form.direccion, barrio: form.barrio, entreCalles: form.entreCalles || "",
      zona: form.zona || "Sin zona", fecha: form.fecha, franja: form.franja,
      fechaDisplay: form.fecha, franjaDisplay: form.franja || "Sin franja",
      productos: productosStr, totalNum: totalCarrito,
      total: `$${totalCarrito.toLocaleString("es-AR")}`,
      pago: form.medioPago === "Efectivo" ? "Pendiente" : "Pagado",
      medioPago: form.medioPago, cobrar: form.cobrar,
      tabActual: form.seccion, local: localLabel(form.seccion),
      nota: form.nota, esManual: true, estado: "Por empaquetar", repartidor: "Sin asignar",
    };
    await axios.post(`${API}/api/pedidos-manuales`, nuevoPedido).catch(console.error);
    const estadoInicial = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: form.fecha, franjaManual: form.franja, cobrar: form.cobrar };
    await axios.post(`${API}/api/estados/${id}`, estadoInicial).catch(console.error);
    setPedidosManuales(prev => [...prev, nuevoPedido]);
    setPedidosLocales(prev => ({ ...prev, [id]: estadoInicial }));
    setCarrito([]);
    setForm(FORM_INICIAL);
    setPedidoCreado(true);
    setTimeout(() => setPedidoCreado(false), 3000);
  }

  const productosFiltrados = productos.filter(p => {
    const nombre = p.name?.es?.toLowerCase() || "";
    const matchBusqueda = !busqueda || nombre.includes(busqueda.toLowerCase());
    const matchCategoria = !categoriaFiltro || p.categories?.some(c => c.id === Number(categoriaFiltro) || c.parent === Number(categoriaFiltro));
    return matchBusqueda && matchCategoria;
  });

  function imprimirComanda(p) {
    setComandasImpresas(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }));
    const ventana = window.open("", "_blank", "width=400,height=600");
    const estadoActual = pedidosLocales[p.id]?.estado || "Por empaquetar";
    const repartidorActual = pedidosLocales[p.id]?.repartidor || "Sin asignar";
    const cobrar = pedidosLocales[p.id]?.cobrar;
    ventana.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comanda ${p.numero}</title>
      <style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family:'Courier New',monospace; font-size:12px; width:80mm; padding:4mm; color:#000; } .centro { text-align:center; } .titulo { font-size:18px; font-weight:bold; margin-bottom:2px; } .subtitulo { font-size:11px; color:#555; margin-bottom:6px; } .linea { border-top:1px dashed #000; margin:6px 0; } .fila { display:flex; justify-content:space-between; margin:2px 0; } .label { font-weight:bold; font-size:10px; text-transform:uppercase; color:#555; margin-top:6px; margin-bottom:1px; } .valor { font-size:12px; } .producto { padding:2px 0; } .total { font-size:15px; font-weight:bold; text-align:right; margin-top:4px; } .cobrar { text-align:center; font-size:16px; font-weight:bold; border:2px solid #000; padding:6px; margin:8px 0; letter-spacing:2px; } .estado { text-align:center; font-size:11px; margin-top:6px; padding:3px; border:1px solid #000; } .nota { font-style:italic; font-size:11px; color:#333; } @media print { body { width:80mm; } @page { margin:0; size:80mm auto; } }</style></head><body>
      <div class="centro"><div class="titulo">Piccadely</div><div class="subtitulo">comanda de pedido</div></div>
      <div class="linea"></div>
      <div class="fila"><span><b>${p.numero}</b></span><span>${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "—"}</span></div>
      <div class="fila"><span>${p.franjaDisplay}</span><span>${p.zona}</span></div>
      <div class="linea"></div>
      <div class="label">Cliente</div><div class="valor">${p.cliente}</div><div class="valor">${p.telefono}</div>
      <div class="label">Dirección</div><div class="valor">${p.direccion}${p.barrio ? `, ${p.barrio}` : ""}</div>${p.entreCalles ? `<div class="valor" style="font-style:italic;color:#555;">${p.entreCalles}</div>` : ""}
      <div class="linea"></div>
      <div class="label">Productos</div>${p.productos.split(", ").map(pr => `<div class="producto">• ${pr}</div>`).join("")}
      ${p.nota ? `<div class="linea"></div><div class="label">Nota</div><div class="nota">${p.nota}</div>` : ""}
      <div class="linea"></div>
      <div class="fila"><span class="label">Medio de pago</span><span class="valor">${p.medioPago}</span></div>
      <div class="total">${p.total}</div>
      ${cobrar ? `<div class="cobrar">★ COBRAR ★</div>` : ""}
      <div class="linea"></div>
      <div class="fila"><span class="label">Repartidor</span><span class="valor">${repartidorActual}</span></div>
      <div class="estado">${estadoActual}</div>
      <div class="linea"></div>
      <div class="centro" style="font-size:10px;color:#888;margin-top:4px;">Piccadely — juntadely</div>
      <script>window.onload=function(){window.print();}</script></body></html>`);
    ventana.document.close();
  }

  const conteos = {};
  TABS.forEach(t => { conteos[t.id] = pedidosActivos.filter(p => p.tabActual === t.id).length; });

  const totalFiltrados = filtrados.length;
  const totalEnCamino = filtrados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "En camino").length;
  const totalPendientes = filtrados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) !== "Entregado").length;
  const totalListos = filtrados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "Listo").length;

  if (loading) return <div style={s.loading}>Cargando pedidos...</div>;
  if (error) return <div style={s.error}>{error}</div>;

  const cerrarModal = () => { setFacturando(null); setFacturaVersion(v => v + 1); };

  const Header = () => (
    <div style={s.header}>
      <div style={s.brand}>
        <img src="/Piccadely_Logotipo-Centrado-Negro.svg" alt="Piccadely" style={{ height: 36, objectFit: "contain" }} />
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={s.fechaHoy}>{new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}</span>
        <div style={{ position: "relative" }} ref={menuRef}>
          <button style={s.hamburger} onClick={() => setMenuAbierto(m => !m)}>
            <div style={s.hambLine} /><div style={s.hambLine} /><div style={s.hambLine} />
          </button>
          {menuAbierto && (
            <div style={s.dropdown}>
              <button style={s.dropItem} onClick={() => { setVista("caja"); setMenuAbierto(false); }}>💰 Caja</button>
              <button style={s.dropItem} onClick={() => { setVista("finalizados"); setMenuAbierto(false); }}>📋 Pedidos finalizados</button>
              <button style={{ ...s.dropItem, borderTop: "1px solid #eee", color: "#888" }} onClick={() => { setVista("panel"); setMenuAbierto(false); }}>← Volver al panel</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const TabBar = () => (
    <div style={s.tabs}>
      {TABS.map(t => (
        <button key={t.id} style={{ ...s.tab, ...(tab === t.id ? s.tabActive : {}) }}
          onClick={() => { setTab(t.id); setVista("panel"); setFiltroFecha(""); setFiltroZona(""); }}>
          {t.label}
          <span style={{ ...s.tabCount, ...(tab === t.id ? s.tabCountActive : {}) }}>{conteos[t.id] || 0}</span>
        </button>
      ))}
    </div>
  );

  if (vista === "caja") {
    return (
      <div style={s.wrap}>
        <Header />
        <VistaCaja pedidosFinalizados={pedidosFinalizados} onVolver={() => setVista("panel")} />
      </div>
    );
  }

  if (vista === "finalizados") {
    const finalizadosOrdenados = [...pedidosFinalizados]
  .filter(p => {
    if (filtroFinDesde && p.fechaDisplay && p.fechaDisplay < filtroFinDesde) return false;
    if (filtroFinHasta && p.fechaDisplay && p.fechaDisplay > filtroFinHasta) return false;
    if (filtroRepartidor && (pedidosLocales[p.id]?.repartidor || "Sin asignar") !== filtroRepartidor) return false;
    return true;
  })
      .sort((a, b) => {
        if (!a.fechaDisplay) return 1;
        if (!b.fechaDisplay) return -1;
        return b.fechaDisplay.localeCompare(a.fechaDisplay);
      });

    return (
      <div style={s.wrap}>
        <Header />
        {facturando && <ModalFacturacion p={facturando} onCerrar={cerrarModal} />}
        <div style={{ padding: "24px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
            <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>
              📋 Pedidos finalizados <span style={{ fontSize: 13, color: "#aaa", fontWeight: 400 }}>({finalizadosOrdenados.length})</span>
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
              <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={filtroFinDesde} onChange={e => setFiltroFinDesde(e.target.value)} />
              <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
              <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={filtroFinHasta} onChange={e => setFiltroFinHasta(e.target.value)} />
              {(filtroFinDesde || filtroFinHasta) && (
                <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setFiltroFinDesde(""); setFiltroFinHasta(""); }}>✕ Limpiar</button>
              )}
            </div>
          </div>
          <div style={s.lista}>
            <div style={s.cabecera}>
              <span style={{ ...s.col, flex: 0.6 }}>Nº</span>
              <span style={{ ...s.col, flex: 1.2 }}>Cliente</span>
              <span style={{ ...s.col, flex: 1 }}>Teléfono</span>
              <span style={{ ...s.col, flex: 1.5 }}>Dirección</span>
              <span style={{ ...s.col, flex: 1 }}>Productos</span>
              <span style={{ ...s.col, flex: 0.8 }}>Medio pago</span>
              <span style={{ ...s.col, flex: 0.7, textAlign: "right" }}>Total</span>
              <span style={{ ...s.col, flex: 0.8, textAlign: "center" }}>Fecha</span>
              <span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Local</span>
            </div>
            {finalizadosOrdenados.length === 0 && <div style={s.empty}>No hay pedidos finalizados en ese rango.</div>}
            {finalizadosOrdenados.map(p => (
              <div key={p.id} style={{ ...s.fila, ...(expandido === p.id ? s.filaAbierta : {}) }}>
                <div style={s.filaTop} onClick={() => toggleExpandido(p.id)}>
                  <span style={{ ...s.cel, flex: 0.6 }}><span style={s.numero}>{p.numero}</span></span>
                  <span style={{ ...s.cel, flex: 1.2 }}>{p.cliente}{p.esManual && <span style={{ ...s.cobrarBadge, background: "#7c3aed", marginLeft: 6 }}>MANUAL</span>}</span>
                  <span style={{ ...s.cel, flex: 1, color: "#555" }}>{p.telefono}</span>
                  <span style={{ ...s.cel, flex: 1.5 }}>{p.direccion}</span>
                  <span style={{ ...s.cel, flex: 1, color: "#666" }}>{p.productos}</span>
                  <span style={{ ...s.cel, flex: 0.8 }}>{p.medioPago}</span>
                  <span style={{ ...s.cel, flex: 0.7, textAlign: "right", fontWeight: 600 }}>{p.total}</span>
                  <span style={{ ...s.cel, flex: 0.8, textAlign: "center", color: "#555" }}>
                    {p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"short"}) : "—"}
                  </span>
                  <span style={{ ...s.cel, flex: 0.7, textAlign: "center" }}>
                    <span style={{ fontSize: 11, background: "#eaf3de", color: "#27500a", padding: "2px 7px", borderRadius: 4 }}>{p.local}</span>
                  </span>
                  <span style={s.chevron}>{expandido === p.id ? "▲" : "▼"}</span>
                </div>
                {expandido === p.id && (
                  <div style={s.detalle}>
                    <div style={s.detalleGrid}>
                      <div style={s.detalleBloque}><div style={s.detalleLabel}>Productos</div><div style={s.detalleVal}>{p.productos}</div></div>
                      {p.nota && <div style={s.detalleBloque}><div style={s.detalleLabel}>Nota</div><div style={{ ...s.detalleVal, color: "#666", fontStyle: "italic" }}>{p.nota}</div></div>}
                      <div style={s.detalleBloque}><div style={s.detalleLabel}>Dirección completa</div><div style={s.detalleVal}>{p.direccion}{p.barrio ? `, ${p.barrio}` : ""}{p.entreCalles ? ` (${p.entreCalles})` : ""}</div></div>
                      <div style={s.detalleBloque}><div style={s.detalleLabel}>Zona</div><div style={s.detalleVal}>{p.zona}</div></div>
                      <div style={s.detalleBloque}><div style={s.detalleLabel}>Horario</div><div style={s.detalleVal}>{p.franjaDisplay}</div></div>
                      <div style={s.detalleBloque}><div style={s.detalleLabel}>Repartidor</div><div style={s.detalleVal}>{pedidosLocales[p.id]?.repartidor || "Sin asignar"}</div></div>
                    </div>
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button style={s.btnImprimir} onClick={e => { e.stopPropagation(); imprimirComanda(p); }}>
  🖨️ Imprimir comanda {comandasImpresas[p.id] ? <span style={{ marginLeft: 4, background: "#f39c12", color: "#fff", borderRadius: 99, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>{comandasImpresas[p.id]}</span> : null}
</button>
                      <BtnFacturar p={p} version={facturaVersion} onAbrir={setFacturando} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (tab === "nuevo") {
    return (
      <div style={s.wrap}>
        <Header />
        <TabBar />
        <div style={{ padding: 24, display: "grid", gridTemplateColumns: "1fr 380px", gap: 20, alignItems: "start" }}>
          <div>
            {pedidoCreado && (
              <div style={{ background: "#eaf3de", border: "1px solid #2a7a4b", borderRadius: 8, padding: "12px 16px", marginBottom: 16, color: "#27500a", fontWeight: 600, fontSize: 13 }}>
                ✅ Pedido creado correctamente
              </div>
            )}
            <div style={s.formCard}>
              <div style={s.formCardTitle}>👤 Datos del cliente</div>
              <div style={s.formGrid}>
                <div style={s.formBloque}><label style={s.formLabel}>Nombre *</label><input style={s.formInput} value={form.cliente} onChange={e => setForm(f => ({...f, cliente: e.target.value}))} placeholder="Nombre completo" /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Teléfono</label><input style={s.formInput} value={form.telefono} onChange={e => setForm(f => ({...f, telefono: e.target.value}))} placeholder="+54 11..." /></div>
                <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Dirección</label><input style={s.formInput} value={form.direccion} onChange={e => setForm(f => ({...f, direccion: e.target.value}))} placeholder="Calle y número" /></div>
                <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Entre calles</label><input style={s.formInput} value={form.entreCalles || ""} onChange={e => setForm(f => ({...f, entreCalles: e.target.value}))} placeholder="ej: Entre Gorriti y Cabrera" /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Barrio</label><input style={s.formInput} value={form.barrio} onChange={e => setForm(f => ({...f, barrio: e.target.value}))} placeholder="Barrio" /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Zona de entrega</label><input style={s.formInput} value={form.zona} onChange={e => setForm(f => ({...f, zona: e.target.value}))} placeholder="ej: CABA, Zona Norte 1..." /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Fecha de entrega</label><input type="date" style={s.formInput} value={form.fecha} onChange={e => setForm(f => ({...f, fecha: e.target.value}))} /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Horario</label><input style={s.formInput} value={form.franja} onChange={e => setForm(f => ({...f, franja: e.target.value}))} placeholder="ej: 14:00 – 16:00" /></div>
                <div style={s.formBloque}><label style={s.formLabel}>Medio de pago</label><select style={s.formInput} value={form.medioPago} onChange={e => setForm(f => ({...f, medioPago: e.target.value}))}>{MEDIOS_PAGO.map(m => <option key={m}>{m}</option>)}</select></div>
                <div style={s.formBloque}><label style={s.formLabel}>Sección</label><select style={s.formInput} value={form.seccion} onChange={e => setForm(f => ({...f, seccion: e.target.value}))}>{TABS.filter(t => t.id !== "nuevo").map(t => <option key={t.id} value={t.id}>{t.label.replace(/🏪|🚚/g, "").trim()}</option>)}</select></div>
                <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Nota</label><textarea style={{ ...s.formInput, height: 60, resize: "vertical" }} value={form.nota} onChange={e => setForm(f => ({...f, nota: e.target.value}))} placeholder="Nota adicional..." /></div>
                <div style={{ ...s.formBloque, gridColumn: "span 2" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                    <input type="checkbox" checked={form.cobrar} onChange={e => setForm(f => ({...f, cobrar: e.target.checked}))} />
                    <span style={{ color: form.cobrar ? "#c0392b" : "#666", fontWeight: form.cobrar ? 600 : 400 }}>{form.cobrar ? "⚠️ Marcar como COBRAR en entrega" : "Cobrar en entrega"}</span>
                  </label>
                </div>
              </div>
            </div>
            <div style={{ ...s.formCard, marginTop: 16 }}>
              <div style={s.formCardTitle}>🛒 Catálogo de productos</div>
              {loadingProductos ? <div style={{ padding: "20px 0", color: "#888", fontSize: 13 }}>Cargando productos...</div> : (
                <>
                  <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                    <input style={{ ...s.formInput, flex: 1 }} placeholder="Buscar producto..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
                    <select style={{ ...s.formInput, width: 180 }} value={categoriaFiltro} onChange={e => setCategoriaFiltro(e.target.value)}>
                      <option value="">Todas las categorías</option>
                      {categorias.map(c => <option key={c.id} value={c.id}>{c.name?.es}</option>)}
                    </select>
                  </div>
                  <div style={{ maxHeight: 400, overflowY: "auto", border: "1px solid #eee", borderRadius: 8 }}>
                    {productosFiltrados.slice(0, 50).map(prod => {
                      const precio = Number(prod.variants[0].price);
                      const cat = prod.categories?.[prod.categories.length - 1]?.name?.es || "";
                      return (
                        <div key={prod.id} style={s.prodFila}>
                          <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 12, fontWeight: 500, color: "#333" }}>{prod.name?.es}</div>
                            {cat && <div style={{ fontSize: 11, color: "#aaa" }}>{cat}</div>}
                          </div>
                          <span style={{ fontSize: 12, fontWeight: 600, color: "#333", marginRight: 10 }}>${precio.toLocaleString("es-AR")}</span>
                          <button style={s.btnAgregar} onClick={() => agregarAlCarrito(prod)}>+ Agregar</button>
                        </div>
                      );
                    })}
                    {productosFiltrados.length === 0 && <div style={{ padding: 16, color: "#aaa", fontSize: 13 }}>Sin resultados</div>}
                  </div>
                </>
              )}
            </div>
          </div>
          <div style={{ ...s.formCard, position: "sticky", top: 20 }}>
            <div style={s.formCardTitle}>🧾 Pedido</div>
            {carrito.length === 0 ? <div style={{ color: "#aaa", fontSize: 13, padding: "16px 0" }}>Agregá productos del catálogo</div> : (
              <>
                {carrito.map(item => (
                  <div key={item.variantId} style={s.carritoFila}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#333" }}>{item.nombre}</div>
                      <div style={{ fontSize: 11, color: "#888" }}>${item.precio.toLocaleString("es-AR")} c/u</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button style={s.btnCant} onClick={() => cambiarCantidad(item.variantId, -1)}>−</button>
                      <span style={{ fontSize: 12, minWidth: 20, textAlign: "center" }}>{item.cantidad}</span>
                      <button style={s.btnCant} onClick={() => cambiarCantidad(item.variantId, 1)}>+</button>
                      <button style={{ ...s.btnCant, color: "#c0392b", marginLeft: 4 }} onClick={() => quitarDelCarrito(item.variantId)}>✕</button>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, marginLeft: 8, minWidth: 70, textAlign: "right" }}>${(item.precio * item.cantidad).toLocaleString("es-AR")}</span>
                  </div>
                ))}
                <div style={{ borderTop: "1px solid #eee", marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#2a7a4b" }}>${totalCarrito.toLocaleString("es-AR")}</span>
                </div>
              </>
            )}
            <button style={{ ...s.btnCrear, opacity: (!form.cliente || carrito.length === 0) ? 0.4 : 1 }} disabled={!form.cliente || carrito.length === 0} onClick={crearPedido}>✅ Crear pedido</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={s.wrap}>
      {facturando && <ModalFacturacion p={facturando} onCerrar={cerrarModal} />}
      <Header />
      <TabBar />
      <div style={s.stats}>
        {[["Total", totalFiltrados, "#333"], ["Pendientes", totalPendientes, "#333"], ["En camino", totalEnCamino, "#0c447c"], ["Listos", totalListos, "#633806"]].map(([label, val, color]) => (
          <div key={label} style={s.stat}>
            <div style={s.statLabel}>{label}</div>
            <div style={{ ...s.statVal, color }}>{val}</div>
          </div>
        ))}
      </div>
      <div style={s.filters}>
        <select style={s.select} value={filtroFecha} onChange={e => setFiltroFecha(e.target.value)}>
          <option value="">Todas las fechas</option>
          {fechas.map(f => <option key={f} value={f}>{new Date(f+"T12:00:00").toLocaleDateString("es-AR",{weekday:"short",day:"numeric",month:"short"})}</option>)}
        </select>
        <select style={s.select} value={filtroZona} onChange={e => setFiltroZona(e.target.value)}>
          <option value="">Todas las zonas</option>
          {zonas.map(z => <option key={z} value={z}>{z}</option>)}
        </select>
      </div>
      <div style={s.lista}>
        <div style={s.cabecera}>
          <span style={{ ...s.col, flex: 1.2 }}>Cliente</span>
          <span style={{ ...s.col, flex: 1 }}>Teléfono</span>
          <span style={{ ...s.col, flex: 2 }}>Dirección</span>
          <span style={{ ...s.col, flex: 1 }}>Barrio</span>
          <span style={{ ...s.col, flex: 1.2 }}>Zona</span>
          <span style={{ ...s.col, flex: 0.8, textAlign: "right" }}>Monto</span>
          <span style={{ ...s.col, flex: 1, textAlign: "center" }}>Fecha</span>
          <span style={{ ...s.col, flex: 0.9, textAlign: "center" }}>Horario</span>
          <span style={{ ...s.col, flex: 0.8, textAlign: "center" }}>Estado</span>
        </div>
        {franjas.length === 0 && <div style={s.empty}>No hay pedidos en esta sección.</div>}
        {franjas.map(key => {
          const [fecha] = key.split("|");
          const grupo = porFranja[key];
          const fechaLabel = fecha !== "sin-fecha" ? new Date(fecha+"T12:00:00").toLocaleDateString("es-AR",{weekday:"long",day:"numeric",month:"long"}) : "Sin fecha";
          return (
            <div key={key}>
              <div style={s.franjaHeader}>
                <span style={s.franjaFecha}>{fechaLabel}</span>
                <span style={s.franjaHora}>{key.split("|")[1]}</span>
                <span style={s.franjaCount}>{grupo.length} pedido{grupo.length > 1 ? "s" : ""}</span>
              </div>
              {grupo.map(p => {
                const estadoActual = pedidosLocales[p.id]?.estado || "Por empaquetar";
                const repartidorActual = pedidosLocales[p.id]?.repartidor || "Sin asignar";
                const tabActual = pedidosLocales[p.id]?.tabManual || p.tabActual;
                const fechaManual = pedidosLocales[p.id]?.fechaManual || p.fecha || "";
                const franjaManual = pedidosLocales[p.id]?.franjaManual || p.franja || "";
                const cobrar = pedidosLocales[p.id]?.cobrar;
                const abierto = expandido === p.id;
                const ec = ESTADO_COLORS[estadoActual];
                const ahora = new Date();
const fechaPedido = p.fechaDisplay || "";
const franjaMatch = (p.franjaDisplay || "").match(/(\d{1,2}):(\d{2})/);
const horaInicio = franjaMatch
  ? new Date(`${fechaPedido}T${String(franjaMatch[1]).padStart(2,"0")}:${franjaMatch[2]}:00`)
  : null;
  if (horaInicio) console.log(p.numero, "horaInicio:", horaInicio, "minutosVencido:", Math.floor((new Date() - horaInicio) / 60000));
const minutosVencido = horaInicio ? Math.floor((ahora - horaInicio) / 60000) : 0;
const estaVencido = horaInicio && ahora >= horaInicio &&
  fechaPedido === HOY &&
  estadoActual !== "En camino" &&
  estadoActual !== "Entregado";
const estaMuyVencido = estaVencido && minutosVencido >= 120;
                return (
                  <div key={p.id} style={{ ...s.fila, ...(abierto ? s.filaAbierta : {}), ...(estaMuyVencido ? { background: "#f5b7b1", borderLeft: "4px solid #922b21" } : estaVencido ? { background: "#fdecea", borderLeft: "4px solid #c0392b" } : {}) }}>
                    <div style={s.filaTop} onClick={() => toggleExpandido(p.id)}>
                      <span style={{ ...s.cel, flex: 1.2 }}>
                        <span style={s.numero}>{p.numero}</span> {p.cliente}
                        {cobrar && <span style={s.cobrarBadge}>COBRAR</span>}
                        {p.esManual && <span style={{ ...s.cobrarBadge, background: "#7c3aed" }}>MANUAL</span>}
                      </span>
                      <span style={{ ...s.cel, flex: 1, color: "#555" }}>{p.telefono}</span>
                      <span style={{ ...s.cel, flex: 2 }}>{p.direccion}</span>
                      <span style={{ ...s.cel, flex: 1, color: "#666" }}>{p.barrio}</span>
                      <span style={{ ...s.cel, flex: 1.2 }}><span style={s.zonaTag}>{p.zona}</span></span>
                      <span style={{ ...s.cel, flex: 0.8, textAlign: "right", fontWeight: 600 }}>{p.total}</span>
                      <span style={{ ...s.cel, flex: 1, textAlign: "center", color: "#555" }}>
                        {p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"short"}) : "—"}
                      </span>
                      <span style={{ ...s.cel, flex: 0.9, textAlign: "center" }}><span style={s.franjaTag}>{p.franjaDisplay}</span></span>
                      <span style={{ ...s.cel, flex: 0.8, textAlign: "center" }}>
                        <span style={{ ...s.estadoTag, background: ec.bg, color: ec.text }}>{estadoActual}</span>
                      </span>
                      <span style={s.chevron}>{abierto ? "▲" : "▼"}</span>
                    </div>
                    {abierto && (
                      <div style={s.detalle}>
                        <div style={s.detalleGrid}>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Productos</div><div style={s.detalleVal}>{p.productos}</div></div>
                          {p.nota && <div style={s.detalleBloque}><div style={s.detalleLabel}>Nota</div><div style={{ ...s.detalleVal, color: "#666", fontStyle: "italic" }}>{p.nota}</div></div>}
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Medio de pago</div><div style={s.detalleVal}>{p.medioPago}</div></div>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Pago</div><div style={{ ...s.detalleVal, color: p.pago === "Pagado" ? "#2a7a4b" : "#c0392b", fontWeight: 600 }}>{p.pago}</div></div>
                          <div style={s.detalleBloque}>
                            <div style={s.detalleLabel}>Cobrar en entrega</div>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!cobrar} onChange={e => cambiarCobrar(p.id, e.target.checked)} onClick={e => e.stopPropagation()} />
                              <span style={{ fontSize: 12, color: cobrar ? "#c0392b" : "#888", fontWeight: cobrar ? 600 : 400 }}>{cobrar ? "⚠️ COBRAR" : "Ya cobrado"}</span>
                            </label>
                          </div>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Repartidor</div><select style={s.inputField} value={repartidorActual} onChange={e => cambiarRepartidor(p.id, e.target.value)}>{REPARTIDORES.map(r => <option key={r}>{r}</option>)}</select></div>
                          <div style={s.detalleBloque}>
                            <div style={s.detalleLabel}>Estado</div>
                            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                              <span style={{ ...s.estadoTag, background: ec.bg, color: ec.text }}>{estadoActual}</span>
                              {estadoActual !== "Entregado" && <button style={s.btnEstado} onClick={e => cambiarEstado(p.id, e)}>→ {nextEstado(estadoActual)}</button>}
                            </div>
                          </div>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Fecha de entrega</div><input type="date" style={s.inputField} value={fechaManual} onChange={e => cambiarFecha(p.id, e.target.value)} onClick={e => e.stopPropagation()} /></div>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Horario de entrega</div><input type="text" placeholder="ej: 14:00 – 16:00" style={s.inputField} value={franjaManual} onChange={e => cambiarFranja(p.id, e.target.value)} onClick={e => e.stopPropagation()} /></div>
                          <div style={s.detalleBloque}><div style={s.detalleLabel}>Mover a sección</div><select style={s.inputField} value={tabActual} onChange={e => cambiarTab(p.id, e.target.value)}>{TABS.filter(t => t.id !== "nuevo").map(t => <option key={t.id} value={t.id}>{t.label.replace(/🏪|🚚/g, "").trim()}</option>)}</select></div>
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                          <button style={s.btnImprimir} onClick={e => { e.stopPropagation(); imprimirComanda(p); }}>
  🖨️ Imprimir comanda {comandasImpresas[p.id] ? <span style={{ marginLeft: 4, background: "#f39c12", color: "#fff", borderRadius: 99, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>{comandasImpresas[p.id]}</span> : null}
</button>
                          <BtnFacturar p={p} version={facturaVersion} onAbrir={setFacturando} />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const s = {
  wrap: { fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f7f7f5" },
  loading: { padding: 40, textAlign: "center", color: "#666" },
  error: { padding: 40, textAlign: "center", color: "red" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #eee" },
  brand: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 9, height: 9, borderRadius: "50%", background: "#2a7a4b" },
  brandName: { fontWeight: 600, fontSize: 14 },
  fechaHoy: { fontSize: 13, color: "#888", textTransform: "capitalize" },
  hamburger: { background: "none", border: "1px solid #ddd", borderRadius: 6, padding: "6px 8px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 4 },
  hambLine: { width: 18, height: 2, background: "#555", borderRadius: 2 },
  dropdown: { position: "absolute", right: 0, top: "calc(100% + 8px)", background: "#fff", border: "1px solid #eee", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.1)", zIndex: 100, minWidth: 200, overflow: "hidden" },
  dropItem: { display: "block", width: "100%", padding: "11px 16px", border: "none", background: "none", cursor: "pointer", textAlign: "left", fontSize: 13, color: "#333" },
  btnVolver: { fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" },
  tabs: { display: "flex", padding: "0 24px", background: "#fff", borderBottom: "1px solid #eee", gap: 4, overflowX: "auto" },
  tab: { padding: "10px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 12, color: "#888", borderBottom: "2px solid transparent", marginBottom: -1, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" },
  tabActive: { color: "#2a7a4b", borderBottomColor: "#2a7a4b", fontWeight: 600 },
  tabCount: { fontSize: 11, background: "#eee", color: "#888", padding: "1px 7px", borderRadius: 99, fontWeight: 600 },
  tabCountActive: { background: "#2a7a4b", color: "#fff" },
  stats: { display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, padding: "14px 24px", background: "#f7f7f5" },
  stat: { background: "#fff", borderRadius: 8, padding: "10px 14px", border: "1px solid #eee" },
  statLabel: { fontSize: 11, color: "#aaa", marginBottom: 2 },
  statVal: { fontSize: 20, fontWeight: 600 },
  filters: { display: "flex", gap: 8, padding: "0 24px 14px", background: "#f7f7f5" },
  select: { fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" },
  lista: { margin: "0 24px 24px", background: "#fff", borderRadius: 10, border: "1px solid #eee", overflow: "hidden" },
  cabecera: { display: "flex", alignItems: "center", padding: "8px 14px", background: "#f0f0ee", borderBottom: "1px solid #e5e5e3" },
  col: { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em" },
  franjaHeader: { display: "flex", alignItems: "center", gap: 10, padding: "10px 14px", background: "#f9f9f7", borderTop: "1px solid #eee", borderBottom: "1px solid #eee" },
  franjaFecha: { fontSize: 12, fontWeight: 600, color: "#333", textTransform: "capitalize" },
  franjaHora: { fontSize: 11, background: "#faeeda", color: "#633806", padding: "2px 8px", borderRadius: 4, fontWeight: 500 },
  franjaCount: { fontSize: 11, background: "#ebebeb", color: "#888", padding: "2px 8px", borderRadius: 99 },
  fila: { borderBottom: "1px solid #f0f0ee" },
  filaAbierta: { background: "#fafaf8" },
  filaTop: { display: "flex", alignItems: "center", padding: "9px 14px", cursor: "pointer" },
  cel: { fontSize: 12, color: "#333", paddingRight: 8, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  numero: { fontWeight: 600, color: "#2a7a4b", marginRight: 4 },
  cobrarBadge: { fontSize: 10, background: "#c0392b", color: "#fff", padding: "1px 6px", borderRadius: 4, marginLeft: 6, fontWeight: 600 },
  zonaTag: { fontSize: 11, background: "#e6f1fb", color: "#0c447c", padding: "2px 7px", borderRadius: 4 },
  franjaTag: { fontSize: 11, background: "#faeeda", color: "#633806", padding: "2px 7px", borderRadius: 4 },
  estadoTag: { fontSize: 11, padding: "2px 8px", borderRadius: 4, fontWeight: 500, whiteSpace: "nowrap" },
  chevron: { fontSize: 10, color: "#bbb", marginLeft: 8, flexShrink: 0 },
  detalle: { padding: "12px 14px 14px", borderTop: "1px solid #ebebeb", background: "#fafaf8" },
  detalleGrid: { display: "flex", gap: 24, flexWrap: "wrap" },
  detalleBloque: { minWidth: 160 },
  detalleLabel: { fontSize: 10, fontWeight: 600, color: "#aaa", textTransform: "uppercase", marginBottom: 4 },
  detalleVal: { fontSize: 13, color: "#333" },
  inputField: { fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", width: "100%" },
  btnEstado: { fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#333" },
  btnImprimir: { marginTop: 0, padding: "7px 14px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#333" },
  empty: { padding: "20px 14px", color: "#aaa", fontSize: 13 },
  formCard: { background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: "16px 20px" },
  formCardTitle: { fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 },
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  formBloque: {},
  formLabel: { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 4 },
  formInput: { fontSize: 12, padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", width: "100%", boxSizing: "border-box" },
  prodFila: { display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f5f5f5" },
  btnAgregar: { fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #2a7a4b", background: "#2a7a4b", color: "#fff", cursor: "pointer", whiteSpace: "nowrap" },
  carritoFila: { display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f5f5f5" },
  btnCant: { fontSize: 12, width: 24, height: 24, borderRadius: 4, border: "1px solid #ddd", background: "#f9f9f7", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#333" },
  btnCrear: { marginTop: 16, padding: "10px", fontSize: 13, borderRadius: 8, border: "none", background: "#2a7a4b", color: "#fff", cursor: "pointer", width: "100%", fontWeight: 600 },
};