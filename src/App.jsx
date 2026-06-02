import { useState, useEffect, useRef, useMemo } from "react";
    import axios from "axios";
    import * as XLSX from "xlsx";
    import jsPDF from "jspdf";
    import autoTable from "jspdf-autotable";
    import Login from "./Login";
    import Usuarios from "./Usuarios";
    import { getUsuarioGuardado, validarSesion, cerrarSesion, ROL_LABELS } from "./auth-utils";

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

    const REPARTIDORES_DEFAULT = ["Sin asignar"];
    const MEDIOS_PAGO = ["Mercado Pago", "Efectivo", "Transferencia", "Rappi", "Pedidos Ya", "Pedidos Ya Efectivo", "Otro"];

    const TABS = [
      { id: "retiro-at",    label: "🏪 Retiro A. Thomas" },
      { id: "retiro-fr",   label: "🏪 Retiro French" },
      { id: "delivery-at", label: "🚚 Delivery A. Thomas" },
      { id: "delivery-fr", label: "🚚 Delivery French" },
      { id: "nuevo",       label: "➕ Nuevo pedido" },
    ];

    const TN_CODE_FRENCH = "01KQ7S2Z0799JKAT5A1VTH12EQ";
    const TN_CODE_AT = "01KQ7TFQPTTZQ7CFFKCKVWEZQV";

    function clasificarPedido(p) {
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
      cliente: "", telefono: "", email: "", direccion: "", entreCalles: "", barrio: "", zona: "",
      fecha: fechaArgentina(), franjaInicio: "", franjaFin: "", nota: "", medioPago: "Efectivo",
      seccion: "delivery-at", cobrar: true,
    };

    function fechaArgentina(d = new Date()) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    }

    const HOY = fechaArgentina();
    function guardarEstadoDB(id, estado, usuario) {
    axios.post(`${API}/api/estados/${id}`, { ...estado, usuario }).catch(console.error);
  }

    function fmt(n) { return `$${Number(n).toLocaleString("es-AR")}`; }
    function sumar(arr) { return arr.reduce((a, p) => a + p.totalNum, 0); }

    function fechaTagArchivo(desde, hasta) {
      if (desde && hasta) return `${desde}_a_${hasta}`;
      if (desde) return `desde_${desde}`;
      if (hasta) return `hasta_${hasta}`;
      return new Date().toISOString().split("T")[0];
    }

    function exportarExcel(filename, hojas) {
      const wb = XLSX.utils.book_new();
      hojas.forEach(({ name, data }) => {
        const ws = XLSX.utils.json_to_sheet(data);
        XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
      });
      XLSX.writeFile(wb, filename);
    }

    function exportarPDF(filename, titulo, columnas, filas, totalLinea = null, subtitulo = null) {
      const doc = new jsPDF();
      doc.setFontSize(14);
      doc.setTextColor(42, 122, 75);
      doc.text("Piccadely — " + titulo, 14, 15);
      doc.setFontSize(9);
      doc.setTextColor(120, 120, 120);
      let y = 22;
      if (subtitulo) { doc.text(subtitulo, 14, y); y += 5; }
      doc.text(`Generado: ${new Date().toLocaleString("es-AR")}`, 14, y);
      y += 5;
      autoTable(doc, {
        startY: y + 2,
        head: [columnas],
        body: filas,
        styles: { fontSize: 8, cellPadding: 2 },
        headStyles: { fillColor: [42, 122, 75], textColor: 255, fontStyle: "bold" },
        alternateRowStyles: { fillColor: [249, 249, 247] },
      });
      if (totalLinea) {
        const finalY = doc.lastAutoTable.finalY + 8;
        doc.setFontSize(11);
        doc.setTextColor(42, 122, 75);
        doc.setFont(undefined, "bold");
        doc.text(totalLinea, 14, finalY);
      }
      doc.save(filename);
    }

    const btnExportar = (color) => ({
      fontSize: 12, padding: "6px 12px", borderRadius: 6,
      border: `1px solid ${color}`, background: "#fff", color,
      cursor: "pointer", fontWeight: 500,
    });

    function reproducirBeep() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.25].forEach(delay => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.type = "sine";
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.3, ctx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + delay + 0.2);
          osc.start(ctx.currentTime + delay);
          osc.stop(ctx.currentTime + delay + 0.2);
        });
      } catch (e) { console.warn("No se pudo reproducir el beep:", e); }
    }

    function InputBlur({ initialValue, onCommit, style, placeholder, type = "text", ...rest }) {
      const [value, setValue] = useState(initialValue ?? "");
      const [focused, setFocused] = useState(false);
      useEffect(() => { if (!focused) setValue(initialValue ?? ""); }, [initialValue, focused]);
      return (
        <input
          type={type} style={style} placeholder={placeholder} value={value}
          onFocus={() => setFocused(true)}
          onChange={e => setValue(e.target.value)}
          onBlur={() => { setFocused(false); if (value !== (initialValue ?? "")) onCommit(value); }}
          {...rest}
        />
      );
    }

    // ─── TEXTAREA CON COMMIT ON BLUR ─────────────────────────────────────
    function TextareaBlur({ initialValue, onCommit, style, placeholder }) {
      const [value, setValue] = useState(initialValue ?? "");
      const [focused, setFocused] = useState(false);
      useEffect(() => { if (!focused) setValue(initialValue ?? ""); }, [initialValue, focused]);
      return (
        <textarea
          style={style} placeholder={placeholder} value={value}
          onFocus={() => setFocused(true)}
          onChange={e => setValue(e.target.value)}
          onBlur={() => { setFocused(false); if (value !== (initialValue ?? "")) onCommit(value); }}
        />
      );
    }

    // ─── BTN FACTURAR ────────────────────────────────────────────────────
    function BtnFacturar({ p, version, onAbrir }) {
      const [tieneFactura, setTieneFactura] = useState(null);
      const [pdfUrl, setPdfUrl] = useState(null);
const [facturaLabel, setFacturaLabel] = useState(null);
      useEffect(() => {
        axios.get(`${API}/api/facturas/${p.id}`)
          .then(res => {
            const activas = res.data.filter(f => !f.tipo.includes("NOTA DE CREDITO"));
            const ncs = res.data.filter(f => f.tipo.includes("NOTA DE CREDITO"));
            const hayFactura = activas.length > ncs.length;
            setTieneFactura(hayFactura);
            setPdfUrl(hayFactura ? (activas[activas.length - 1]?.pdf_url || null) : null);
            setFacturaLabel(hayFactura ? `${activas[activas.length - 1]?.tipo || ""} Nº ${activas[activas.length - 1]?.numero || ""}` : null);
          })
          .catch(() => setTieneFactura(false));
      }, [p.id, version]);

      if (tieneFactura === null) return null;
      const btnBase = { marginTop: 0, padding: "7px 14px", fontSize: 12, borderRadius: 6, cursor: "pointer" };

      return (
        <div style={{ display: "flex", gap: 6, marginLeft: 8 }}>
          {tieneFactura ? (
            <>
             {facturaLabel && (
                <span style={{ fontSize: 11, color: "#F68B32", fontWeight: 600, padding: "7px 0", whiteSpace: "nowrap" }}>
                  🧾 {facturaLabel}
                </span>
              )}
              <button style={{ ...btnBase, border: "1px solid #c0392b", color: "#c0392b", background: "#fdecea" }}
                onClick={e => { e.stopPropagation(); onAbrir(p); }}>
                🗑 Anular factura
              </button>
            </>
          ) : (
            <button style={{ ...btnBase, border: "1px solid #F68B32", color: "#F68B32", background: "#f0faf4", fontWeight: 600 }}
              onClick={e => { e.stopPropagation(); onAbrir(p); }}>
              🧾 Facturar
            </button>
          )}
        </div>
      );
    }

    // ─── BTN MERCADO PAGO ────────────────────────────────────────────────
    function BtnPagoMP({ p, onEmailRequerido }) {
      const [loading, setLoading] = useState(false);
      const [linkGenerado, setLinkGenerado] = useState(null);
      const [copiado, setCopiado] = useState(false);

      async function generarLink() {
        if (!p.email || !p.email.trim()) {
          onEmailRequerido(p);
          return;
        }
        setLoading(true);
        try {
          const res = await axios.post(`${API}/api/mp/create-preference`, { pedidoId: p.id });
          if (res.data.init_point) {
            setLinkGenerado(res.data.init_point);
          } else {
            alert("Error al generar el link de pago");
          }
        } catch (err) {
          alert("Error al conectar con Mercado Pago");
          console.error(err);
        }
        setLoading(false);
      }

      async function copiarLink() {
        if (!linkGenerado) return;
        await navigator.clipboard.writeText(linkGenerado);
        setCopiado(true);
        setTimeout(() => setCopiado(false), 2000);
      }

      if (linkGenerado) {
        return (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <a
              href={linkGenerado}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 12, padding: "7px 12px", borderRadius: 6, border: "1px solid #009ee3", background: "#e8f7fc", color: "#009ee3", textDecoration: "none", fontWeight: 600 }}
              onClick={e => e.stopPropagation()}
            >
              🔗 Abrir link MP
            </a>
            <button
              style={{ fontSize: 12, padding: "7px 12px", borderRadius: 6, border: "1px solid #009ee3", background: copiado ? "#009ee3" : "#fff", color: copiado ? "#fff" : "#009ee3", cursor: "pointer", fontWeight: 600 }}
              onClick={e => { e.stopPropagation(); copiarLink(); }}
            >
              {copiado ? "✅ Copiado" : "📋 Copiar link"}
            </button>
          </div>
        );
      }

      return (
        <button
          style={{ fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "1px solid #009ee3", background: "#fff", color: "#009ee3", cursor: loading ? "default" : "pointer", fontWeight: 600, opacity: loading ? 0.6 : 1 }}
          onClick={e => { e.stopPropagation(); generarLink(); }}
          disabled={loading}
        >
          {loading ? "Generando..." : "💳 Enviar link de pago"}
        </button>
      );
    }

    // ─── AGENTE IA FLOTANTE ──────────────────────────────────────────────
    function AgenteIA() {
      const [abierto, setAbierto] = useState(false);
      const [messages, setMessages] = useState([
        { role: "assistant", content: "¡Hola! Soy el asistente de Piccadely 🧀 ¿En qué te puedo ayudar?" }
      ]);
      const [input, setInput] = useState("");
      const [cargando, setCargando] = useState(false);
      const bottomRef = useRef(null);

      useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, [messages, abierto]);

      async function enviar() {
        const texto = input.trim();
        if (!texto || cargando) return;
        const nuevos = [...messages, { role: "user", content: texto }];
        setMessages(nuevos);
        setInput("");
        setCargando(true);
        try {
          const res = await axios.post(`${API}/api/agente`, {
            messages: nuevos.filter(m => m.role !== "assistant" || nuevos.indexOf(m) > 0)
              .map(m => ({ role: m.role, content: m.content }))
          });
          setMessages([...nuevos, { role: "assistant", content: res.data.reply }]);
        } catch {
          setMessages([...nuevos, { role: "assistant", content: "Tuve un problema para responder. Intentá de nuevo." }]);
        }
        setCargando(false);
      }

      return (
        <>
          {/* Botón flotante */}
          <button
            onClick={() => setAbierto(a => !a)}
            style={{
              position: "fixed", bottom: 24, right: 24, zIndex: 2000,
              width: 52, height: 52, borderRadius: "50%",
              background: NARANJA_AGENT, border: "none", cursor: "pointer",
              boxShadow: "0 4px 16px rgba(246,139,50,0.4)",
              fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center",
              transition: "transform 0.2s",
            }}
            title="Asistente Piccadely"
          >
            {abierto ? "✕" : "💬"}
          </button>

          {/* Ventana de chat */}
          {abierto && (
            <div style={{
              position: "fixed", bottom: 88, right: 24, zIndex: 2000,
              width: 340, height: 480, background: "#fff",
              borderRadius: 14, boxShadow: "0 8px 40px rgba(0,0,0,0.18)",
              display: "flex", flexDirection: "column", overflow: "hidden",
              border: "1px solid #eee",
            }}>
              {/* Header */}
              <div style={{ background: NARANJA_AGENT, padding: "12px 16px", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ fontSize: 20 }}>🧀</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#fff" }}>Asistente Piccadely</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.8)" }}>Preguntame lo que quieras sobre el panel</div>
                </div>
              </div>

              {/* Mensajes */}
              <div style={{ flex: 1, overflowY: "auto", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
                {messages.map((m, i) => (
                  <div key={i} style={{
                    display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                  }}>
                    <div style={{
                      maxWidth: "82%", padding: "8px 12px", borderRadius: m.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                      background: m.role === "user" ? NARANJA_AGENT : "#f0f0ee",
                      color: m.role === "user" ? "#fff" : "#333",
                      fontSize: 12, lineHeight: 1.5,
                    }}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {cargando && (
                  <div style={{ display: "flex", justifyContent: "flex-start" }}>
                    <div style={{ background: "#f0f0ee", borderRadius: "12px 12px 12px 2px", padding: "8px 14px", fontSize: 18, color: "#aaa" }}>
                      ···
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div style={{ padding: "10px 12px", borderTop: "1px solid #eee", display: "flex", gap: 8 }}>
                <input
                  style={{ flex: 1, fontSize: 12, padding: "8px 10px", borderRadius: 8, border: "1px solid #ddd", outline: "none" }}
                  placeholder="Escribí tu pregunta..."
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && enviar()}
                  disabled={cargando}
                />
                <button
                  style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: cargando ? "#ddd" : NARANJA_AGENT, color: "#fff", cursor: cargando ? "default" : "pointer", fontSize: 14 }}
                  onClick={enviar}
                  disabled={cargando}
                >
                  ➤
                </button>
              </div>
            </div>
          )}
        </>
      );
    }
    const NARANJA_AGENT = "#F68B32";

    // ─── MODAL PEDIR EMAIL PARA MP ───────────────────────────────────────
    function ModalEmailMP({ pedido, onConfirmar, onCerrar }) {
      const [email, setEmail] = useState("");
      const [guardando, setGuardando] = useState(false);

      async function confirmar() {
        if (!email.trim()) return;
        setGuardando(true);
        try {
          await axios.patch(`${API}/api/pedidos-manuales/${pedido.id}/email`, { email });
        } catch (e) {
          console.error(e);
        }
        setGuardando(false);
        onConfirmar(email);
      }

      return (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 28, width: 400, boxShadow: "0 8px 40px rgba(0,0,0,0.2)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#333", marginBottom: 8 }}>💳 Link de pago MP</div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 20 }}>
              El pedido <strong>{pedido.numero}</strong> no tiene email cargado.<br />
              Ingresalo para generar el link de pago.
            </div>
            <input
              type="email"
              autoFocus
              style={{ fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 16 }}
              placeholder="cliente@ejemplo.com"
              value={email}
              onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && confirmar()}
            />
            <div style={{ display: "flex", gap: 10 }}>
              <button
                style={{ flex: 1, padding: 10, borderRadius: 8, border: "none", background: guardando ? "#ccc" : "#009ee3", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                onClick={confirmar}
                disabled={guardando || !email.trim()}
              >
                {guardando ? "Guardando..." : "Guardar y generar link"}
              </button>
              <button
                style={{ padding: "10px 16px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", fontSize: 13, cursor: "pointer", color: "#555" }}
                onClick={onCerrar}
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ─── MODAL FACTURACIÓN ───────────────────────────────────────────────
    function ModalFacturacion({ p, onCerrar }) {
      const docRaw = p.identificacion || "";
      const docSinFormato = docRaw.replace(/[-\s]/g, "");
    const esCuit = p.esFacturaA || docSinFormato.length > 8;
      const [tipo, setTipo] = useState(esCuit ? "FACTURA A" : "FACTURA B");
      const [docTipo, setDocTipo] = useState(esCuit ? "CUIT" : "DNI");
      const [docNro, setDocNro] = useState(docSinFormato);
      const [razonSocial, setRazonSocial] = useState(p.razonSocialFactura || p.cliente || "");
      const [email, setEmail] = useState(p.email || "");
      const [domicilio, setDomicilio] = useState(p.direccion || "");
      const [emitiendo, setEmitiendo] = useState(false);
      const [resultado, setResultado] = useState(null);
      const [facturas, setFacturas] = useState([]);
      const [loadingFacturas, setLoadingFacturas] = useState(true);
      const requiereDoc = tipo === "FACTURA A" || tipo === "FACTURA B EXENTO";

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
        return { descripcion: match ? match[1] : prod, cantidad: match ? Number(match[2]) : 1, codigo: `PROD${i+1}` };
      });

      const totalLimpio = (() => {
        if (typeof p.totalNum === "number" && p.totalNum > 0) return p.totalNum;
        const raw = String(p.totalNum).trim();
        if (/^\d+(\.\d+)?$/.test(raw)) return Number(raw);
        return Number(raw.replace(/[$\s]/g, "").replace(/\./g, "").replace(",", "."));
      })();

      async function emitir() {
        if (requiereDoc && !docNro.trim()) { alert("Para Factura A es obligatorio el CUIT"); return; }
        if (!totalLimpio || totalLimpio <= 0) { alert("Error: no se pudo determinar el total"); return; }
        setEmitiendo(true); setResultado(null);
        try {
          const res = await axios.post(`${API}/api/facturar`, {
            pedidoId: p.id, tipo, cliente: p.cliente, documentoTipo: docTipo,
            documentoNro: docNro.trim(), razonSocial, domicilio, email,
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
          if (res.data.ok) { await cargarFacturas(); setResultado({ ok: true, data: res.data.data, esNC: true }); }
          else setResultado({ ok: false, error: res.data.error });
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
              <button style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#aaa" }} onClick={onCerrar}>✕</button>
            </div>
            {esCuit && !tieneFacturaActiva && (
              <div style={{ background: "#fef9e7", border: "1px solid #f39c12", borderRadius: 8, padding: "10px 14px", marginBottom: 14, fontSize: 12, color: "#856404" }}>
                ⚠️ Este cliente tiene <strong>CUIT</strong> — se sugiere <strong>Factura A</strong>
              </div>
            )}
            {!loadingFacturas && tieneFacturaActiva && facturaActiva && (
              <div style={{ background: "#eaf3de", border: "2px solid #F68B32", borderRadius: 10, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#F68B32", marginBottom: 8 }}>✅ Pedido facturado</div>
                <div style={{ fontSize: 13, color: "#333", marginBottom: 4 }}>{facturaActiva.tipo} Nº {facturaActiva.numero}</div>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 12 }}>{facturaActiva.fecha} · CAE: {facturaActiva.cae} · {fmt(facturaActiva.total)}</div>
                <div style={{ display: "flex", gap: 10 }}>
                  {facturaActiva.pdf_url && (
                    <a href={facturaActiva.pdf_url} target="_blank" rel="noreferrer"
                      style={{ flex: 1, padding: "9px 0", borderRadius: 8, border: "1px solid #F68B32", color: "#F68B32", textDecoration: "none", background: "#fff", fontWeight: 600, fontSize: 13, textAlign: "center" }}>
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
                        <div style={{ fontSize: 12, fontWeight: 600, color: esNC ? "#c0392b" : "#F68B32" }}>{esNC ? "✖ " : "✔ "}{f.tipo} Nº {f.numero}</div>
                        <div style={{ fontSize: 11, color: "#aaa" }}>{f.fecha} · CAE: {f.cae}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: esNC ? "#c0392b" : "#F68B32" }}>{esNC ? "-" : ""}{fmt(Math.abs(f.total))}</span>
                        {f.pdf_url && <a href={f.pdf_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, border: "1px solid #F68B32", color: "#F68B32", textDecoration: "none", background: "#eaf3de" }}>PDF</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {resultado && (
              <div style={{ borderRadius: 8, padding: "10px 14px", marginBottom: 14, background: resultado.ok ? "#eaf3de" : "#fdecea", border: `1px solid ${resultado.ok ? "#F68B32" : "#c0392b"}` }}>
                {resultado.ok ? (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#F68B32" }}>✅ {resultado.esNC ? "Comprobante anulado — ya podés volver a facturar" : "Comprobante emitido"}</div>
                    <div style={{ fontSize: 12, color: "#555", marginTop: 2 }}>Nº {resultado.data?.comprobante_nro} — CAE: {resultado.data?.cae}</div>
                    {resultado.data?.comprobante_pdf_url && <a href={resultado.data.comprobante_pdf_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: "#F68B32", textDecoration: "underline", display: "block", marginTop: 4 }}>📄 Descargar PDF</a>}
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
                      <button key={t} onClick={() => { setTipo(t); if (t === "FACTURA A") setDocTipo("CUIT"); else { setDocTipo("DNI"); setDocNro(""); } }}
                        style={{ fontSize: 11, padding: "5px 10px", borderRadius: 6, border: "1px solid", cursor: "pointer",
                          borderColor: tipo === t ? "#F68B32" : "#ddd", background: tipo === t ? "#eaf3de" : "#fff",
                          color: tipo === t ? "#F68B32" : "#555", fontWeight: tipo === t ? 600 : 400 }}>{t}</button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>
                      Documento {!requiereDoc && <span style={{ fontWeight: 400, color: "#aaa" }}>(opcional)</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <select style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: 72 }} value={docTipo} onChange={e => setDocTipo(e.target.value)}>
                        <option value="DNI">DNI</option><option value="CUIT">CUIT</option>
                      </select>
                      <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", flex: 1 }} value={docNro} onChange={e => setDocNro(e.target.value)} placeholder={requiereDoc ? "Obligatorio" : "Opcional"} />
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Nombre / Razón social</div>
                    <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }} value={razonSocial} onChange={e => setRazonSocial(e.target.value)} />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Email (opcional)</div>
                    <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }} value={email} onChange={e => setEmail(e.target.value)} placeholder="cliente@email.com" />
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4 }}>Domicilio</div>
                    <input style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box" }} value={domicilio} onChange={e => setDomicilio(e.target.value)} />
                  </div>
                </div>
                <div style={{ background: "#f9f9f7", borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, color: "#666" }}>Total a facturar</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>{p.total}</span>
                </div>
                <button style={{ width: "100%", padding: 11, borderRadius: 8, border: "none", background: emitiendo ? "#ccc" : "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: emitiendo ? "default" : "pointer" }}
                  onClick={emitir} disabled={emitiendo}>{emitiendo ? "Emitiendo..." : `Emitir ${tipo}`}</button>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ─── MODAL EDITAR PRODUCTOS ──────────────────────────────────────────
    function ModalEditarProductos({ p, productos, categorias, onGuardar, onCerrar }) {
      const [carrito, setCarrito] = useState(() => {
        return p.productos.split(", ").map(item => {
          const match = item.match(/^(.+) x(\d+)$/);
          if (!match) return null;
          const nombre = match[1].trim();
          const cantidad = Number(match[2]);
          const prod = productos.find(pr => pr.name?.es?.toLowerCase() === nombre.toLowerCase());
          const precio = prod ? Number(prod.variants[0].price) : 0;
          return { id: nombre, variantId: nombre, nombre, precio, cantidad, esVariable: !prod };
        }).filter(Boolean);
      });
      const [busqueda, setBusqueda] = useState("");
      const [categoriaFiltro, setCategoriaFiltro] = useState("");
      const [varNombre, setVarNombre] = useState("");
      const [varPrecio, setVarPrecio] = useState("");
      const [varCantidad, setVarCantidad] = useState("1");
      const [guardando, setGuardando] = useState(false);

      const total = carrito.reduce((a, i) => a + i.precio * i.cantidad, 0);

      const productosFiltrados = productos.filter(pr => {
        const nombre = pr.name?.es?.toLowerCase() || "";
        return (!busqueda || nombre.includes(busqueda.toLowerCase())) &&
          (!categoriaFiltro || pr.categories?.some(c => c.id === Number(categoriaFiltro) || c.parent === Number(categoriaFiltro)));
      });

      function agregar(prod) {
        const precio = Number(prod.variants[0].price);
        const variantId = String(prod.variants[0].id);
        const nombre = prod.name?.es;
        setCarrito(prev => {
          const existe = prev.find(i => i.variantId === variantId);
          if (existe) return prev.map(i => i.variantId === variantId ? { ...i, cantidad: i.cantidad + 1 } : i);
          return [...prev, { id: variantId, variantId, nombre, precio, cantidad: 1 }];
        });
      }

      async function guardar() {
        setGuardando(true);
        const productosStr = carrito.map(i => `${i.nombre} x${i.cantidad}`).join(", ");
        await axios.post(`${API}/api/pedidos/productos/${p.id}`, { productos: productosStr, totalNum: total });
        onGuardar(p.id, productosStr, total);
        setGuardando(false);
        onCerrar();
      }

      return (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, width: 720, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#333" }}>✏️ Editar productos</div>
                <div style={{ fontSize: 12, color: "#888" }}>{p.numero} — {p.cliente}</div>
              </div>
              <button style={{ border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#aaa" }} onClick={onCerrar}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 8 }}>Catálogo</div>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <input style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", flex: 1 }} placeholder="Buscar..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
                  <select style={{ fontSize: 12, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd" }} value={categoriaFiltro} onChange={e => setCategoriaFiltro(e.target.value)}>
                    <option value="">Todas</option>
                    {categorias.map(c => <option key={c.id} value={c.id}>{c.name?.es}</option>)}
                  </select>
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto", border: "1px solid #eee", borderRadius: 8, marginBottom: 12 }}>
                  {productosFiltrados.slice(0, 50).map(prod => (
                    <div key={prod.id} style={{ display: "flex", alignItems: "center", padding: "7px 10px", borderBottom: "1px solid #f5f5f5" }}>
                      <div style={{ flex: 1, fontSize: 12 }}>{prod.name?.es}</div>
                      <span style={{ fontSize: 12, fontWeight: 600, marginRight: 8, color: "#555" }}>${Number(prod.variants[0].price).toLocaleString("es-AR")}</span>
                      <button style={{ fontSize: 11, padding: "3px 8px", borderRadius: 5, border: "1px solid #F68B32", background: "#F68B32", color: "#fff", cursor: "pointer" }} onClick={() => agregar(prod)}>+ Agregar</button>
                    </div>
                  ))}
                </div>
                <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 10 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 6 }}>Producto variable</div>
                  <input style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 6 }} placeholder="Nombre" value={varNombre} onChange={e => setVarNombre(e.target.value)} />
                  <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                    <input type="number" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", flex: 1 }} placeholder="Precio" value={varPrecio} onChange={e => setVarPrecio(e.target.value)} />
                    <input type="number" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: 60 }} placeholder="Cant" value={varCantidad} onChange={e => setVarCantidad(e.target.value)} />
                  </div>
                  <button style={{ width: "100%", padding: "6px", fontSize: 12, borderRadius: 6, border: "1px solid #F68B32", background: "#F68B32", color: "#fff", cursor: "pointer" }}
                    onClick={() => {
                      if (!varNombre || !varPrecio) return;
                      const variantId = `var-${Date.now()}`;
                      setCarrito(prev => [...prev, { id: variantId, variantId, nombre: varNombre, precio: Number(varPrecio), cantidad: Number(varCantidad) || 1, esVariable: true }]);
                      setVarNombre(""); setVarPrecio(""); setVarCantidad("1");
                    }}>
                    + Agregar variable
                  </button>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#555", marginBottom: 8 }}>Productos del pedido</div>
                {carrito.length === 0 && <div style={{ fontSize: 12, color: "#aaa", padding: "16px 0" }}>Sin productos</div>}
                {carrito.map((item, i) => (
                  <div key={item.variantId} style={{ display: "flex", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #f5f5f5", gap: 6 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, color: "#333" }}>{item.nombre}</div>
                      <div style={{ fontSize: 11, color: item.precio === 0 ? "#c0392b" : "#888" }}>
                        {item.precio === 0 ? "⚠️ Sin precio — editá manualmente" : `$${item.precio.toLocaleString("es-AR")} c/u`}
                      </div>
                      {item.precio === 0 && (
                        <input type="number" style={{ fontSize: 11, padding: "3px 6px", borderRadius: 4, border: "1px solid #ddd", width: 100, marginTop: 2 }}
                          placeholder="Precio" onChange={e => setCarrito(prev => prev.map((x, j) => j === i ? { ...x, precio: Number(e.target.value) } : x))} />
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <button style={{ fontSize: 12, width: 22, height: 22, borderRadius: 4, border: "1px solid #ddd", background: "#f9f9f7", cursor: "pointer" }}
                        onClick={() => setCarrito(prev => prev.map((x, j) => j === i ? { ...x, cantidad: Math.max(1, x.cantidad - 1) } : x))}>−</button>
                      <span style={{ fontSize: 12, minWidth: 20, textAlign: "center" }}>{item.cantidad}</span>
                      <button style={{ fontSize: 12, width: 22, height: 22, borderRadius: 4, border: "1px solid #ddd", background: "#f9f9f7", cursor: "pointer" }}
                        onClick={() => setCarrito(prev => prev.map((x, j) => j === i ? { ...x, cantidad: x.cantidad + 1 } : x))}>+</button>
                      <button style={{ fontSize: 12, width: 22, height: 22, borderRadius: 4, border: "1px solid #c0392b", background: "#fdecea", cursor: "pointer", color: "#c0392b" }}
                        onClick={() => setCarrito(prev => prev.filter((_, j) => j !== i))}>✕</button>
                    </div>
                    <span style={{ fontSize: 12, fontWeight: 600, minWidth: 70, textAlign: "right" }}>${(item.precio * item.cantidad).toLocaleString("es-AR")}</span>
                  </div>
                ))}
                <div style={{ borderTop: "2px solid #eee", marginTop: 8, paddingTop: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>Total</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>${total.toLocaleString("es-AR")}</span>
                </div>
                <button style={{ width: "100%", marginTop: 12, padding: 10, borderRadius: 8, border: "none", background: guardando ? "#ccc" : "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                  onClick={guardar} disabled={guardando || carrito.length === 0}>
                  {guardando ? "Guardando..." : "✅ Guardar cambios"}
                </button>
              </div>
            </div>
          </div>
        </div>
      );
    }
    // ─── AUDITORIA INLINE ────────────────────────────────────────────────
  function AuditoriaInline({ pedidoId }) {
    const [registros, setRegistros] = useState([]);
    const [abierto, setAbierto] = useState(false);
    const [cargado, setCargado] = useState(false);

    function cargar() {
      if (cargado) { setAbierto(a => !a); return; }
      axios.get(`${API}/api/auditoria/${pedidoId}`)
        .then(res => { setRegistros(res.data); setCargado(true); setAbierto(true); })
        .catch(() => setCargado(true));
    }

   const ACCION_LABEL = {
      cambio_estado: "Cambió estado",
      anulacion: "Anuló pedido",
      creacion_manual: "Creó pedido",
      edicion_datos: "Editó datos",
      facturacion: "Facturó",
      nota_credito: "Nota de crédito",
      cambio_fecha: "Cambió fecha",
      cambio_franja: "Cambió horario",
      impresion_comanda: "Imprimió comanda",
    };

    function detalleTexto(r) {
      const d = typeof r.detalle === "string" ? JSON.parse(r.detalle) : (r.detalle || {});
      if (r.accion === "cambio_estado") return `${d.anterior || "—"} → ${d.nuevo || "—"}`;
      if (r.accion === "cambio_fecha") return `${d.anterior || "sin fecha"} → ${d.nuevo || "—"}`;
      if (r.accion === "cambio_franja") return `${d.anterior || "sin franja"} → ${d.nuevo || "—"}`;
      if (r.accion === "facturacion") return `${d.tipo} Nº ${d.numero} · $${d.total}`;
      if (r.accion === "nota_credito") return `Anuló ${d.factura_numero}`;
      if (r.accion === "creacion_manual") return `${d.numero} — ${d.cliente}`;
      if (r.accion === "edicion_datos") {
        const campos = Object.entries(d).filter(([k, v]) => v && k !== "esManual").map(([k]) => k);
        return campos.length > 0 ? `Campos: ${campos.join(", ")}` : "";
      }
      return "";
    }

    return (
      <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 8 }}>
        <button onClick={e => { e.stopPropagation(); cargar(); }}
          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: registros.length > 0 ? "#f9f9f7" : "#fff", cursor: "pointer", color: "#888" }}>
          📜 Historial {cargado && `(${registros.length})`} {abierto ? "▲" : "▼"}
        </button>
        {abierto && (
          <div style={{ marginTop: 8, maxHeight: 200, overflowY: "auto" }}>
            {registros.length === 0 && <div style={{ fontSize: 11, color: "#aaa", padding: "4px 0" }}>Sin registros</div>}
            {registros.map(r => (
              <div key={r.id} style={{ display: "flex", gap: 8, padding: "5px 0", borderBottom: "1px solid #f5f5f5", fontSize: 11, alignItems: "flex-start" }}>
                <span style={{ color: "#aaa", minWidth: 110, flexShrink: 0 }}>{new Date(r.created_at).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</span>
                            <span style={{ color: "#F68B32", fontWeight: 600, minWidth: 80, flexShrink: 0 }}>{r.usuario}</span>
                <span style={{ color: "#555" }}><strong>{ACCION_LABEL[r.accion] || r.accion}</strong>{detalleTexto(r) ? ` — ${detalleTexto(r)}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
    // ─── MAPA DE PEDIDOS ─────────────────────────────────────────────────
    function VistaMapa({ onVolver }) {
      const [fecha, setFecha] = useState(HOY);
      const [pedidos, setPedidos] = useState([]);
      const [loading, setLoading] = useState(false);
      const [filtroFranja, setFiltroFranja] = useState("");
      const [mapLoaded, setMapLoaded] = useState(false);
      const mapRef = useRef(null);
      const mapInstanceRef = useRef(null);
      const markersRef = useRef([]);
      const infoRef = useRef(null);

      useEffect(() => {
        if (window.google && window.google.maps) { setMapLoaded(true); return; }
        const existing = document.getElementById("google-maps-script");
        if (existing) { existing.addEventListener("load", () => setMapLoaded(true)); return; }
        const script = document.createElement("script");
        script.id = "google-maps-script";
        script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyCCI2iY5HLqq65lQe49dzKhrOONrMRa6Ak&language=es&region=AR`;
        script.async = true;
        script.onload = () => setMapLoaded(true);
        document.head.appendChild(script);
      }, []);

      useEffect(() => {
        if (!mapLoaded || !mapRef.current || mapInstanceRef.current) return;
        mapInstanceRef.current = new window.google.maps.Map(mapRef.current, {
          center: { lat: -34.6037, lng: -58.3816 },
          zoom: 12,
          styles: [
            { featureType: "poi", stylers: [{ visibility: "off" }] },
            { featureType: "transit", stylers: [{ visibility: "simplified" }] },
          ],
        });
        infoRef.current = new window.google.maps.InfoWindow();
      }, [mapLoaded]);

      useEffect(() => {
        if (!fecha) return;
        setLoading(true);
        axios.get(`${API}/api/mapa/pedidos/${fecha}`)
          .then(res => { setPedidos(res.data); setLoading(false); })
          .catch(() => { setPedidos([]); setLoading(false); });
      }, [fecha]);

      useEffect(() => {
        if (!mapInstanceRef.current || !mapLoaded) return;
        markersRef.current.forEach(m => m.setMap(null));
        markersRef.current = [];
        if (pedidosFiltrados.length === 0) return;

        const bounds = new window.google.maps.LatLngBounds();
        const ESTADO_PIN = { "Por empaquetar": "#888", "Listo": "#F68B32", "En camino": "#0c447c" };

        pedidosFiltrados.forEach(p => {
          const pos = { lat: p.lat, lng: p.lng };
          bounds.extend(pos);
          const color = ESTADO_PIN[p.estado] || "#888";
          const marker = new window.google.maps.Marker({
            position: pos,
            map: mapInstanceRef.current,
            title: `${p.numero} — ${p.franjaDisplay}`,
            icon: {
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: 14,
              fillColor: color,
              fillOpacity: 0.9,
              strokeColor: "#fff",
              strokeWeight: 2,
            },
            label: { text: p.numero.replace("#", ""), color: "#fff", fontSize: "9px", fontWeight: "bold" },
          });
          marker.addListener("click", () => {
            infoRef.current.setContent(`
              <div style="font-family:system-ui;min-width:200px;max-width:280px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <span style="font-weight:700;color:#F68B32;font-size:14px;">${p.numero}</span>
                  <span style="font-size:11px;background:${color};color:#fff;padding:2px 8px;border-radius:4px;">${p.estado}</span>
                </div>
                <div style="font-size:13px;font-weight:600;color:#333;margin-bottom:4px;">${p.cliente}</div>
                <div style="font-size:12px;color:#555;margin-bottom:2px;">📍 ${p.direccion}${p.barrio ? ", " + p.barrio : ""}</div>
                <div style="font-size:12px;color:#555;margin-bottom:2px;">🕐 ${p.franjaDisplay}</div>
                <div style="font-size:12px;color:#555;margin-bottom:2px;">📦 ${p.productos.length > 60 ? p.productos.substring(0, 60) + "..." : p.productos}</div>
                <div style="font-size:12px;color:#555;margin-bottom:2px;">💰 $${Number(p.total).toLocaleString("es-AR")}${p.cobrar ? ' <span style="color:#c0392b;font-weight:700;">⚠ COBRAR</span>' : ""}</div>
                <div style="font-size:11px;color:#888;margin-top:4px;">🚚 ${p.repartidor} · ${p.local}</div>
              </div>
            `);
            infoRef.current.open(mapInstanceRef.current, marker);
          });
          markersRef.current.push(marker);
        });
        mapInstanceRef.current.fitBounds(bounds, 60);
      }, [pedidos, mapLoaded, filtroFranja]);

      const franjasDisponibles = [...new Set(pedidos.map(p => p.franjaDisplay).filter(Boolean))].sort();
    const pedidosFiltrados = filtroFranja ? pedidos.filter(p => p.franjaDisplay === filtroFranja) : pedidos;
    const porEstado = { "Por empaquetar": 0, "Listo": 0, "En camino": 0 };
    pedidosFiltrados.forEach(p => { if (porEstado[p.estado] !== undefined) porEstado[p.estado]++; });

      return (
        <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f7f7f5" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #eee" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button style={{ fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" }} onClick={onVolver}>← Volver</button>
              <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🗺️ Mapa de pedidos</h2>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <input type="date" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
                value={fecha} onChange={e => setFecha(e.target.value)} />
              <select style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
              value={filtroFranja} onChange={e => setFiltroFranja(e.target.value)}>
              <option value="">Todas las franjas</option>
              {franjasDisponibles.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
              <div style={{ display: "flex", gap: 8 }}>
                {[["Por empaquetar", "#888"], ["Listo", "#F68B32"], ["En camino", "#0c447c"]].map(([est, col]) => (
                  <span key={est} style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 10, height: 10, borderRadius: "50%", background: col, display: "inline-block" }} />
                    {est} ({porEstado[est]})
                  </span>
                ))}
              </div>
  <span style={{ fontSize: 13, fontWeight: 600, color: "#F68B32" }}>{pedidosFiltrados.length} pedidos</span>
            </div>
          </div>
          {loading && <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10, background: "#fff", padding: "12px 24px", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.15)", fontSize: 13, color: "#555" }}>Cargando pedidos...</div>}
          {!loading && pedidos.length === 0 && fecha && mapLoaded && (
            <div style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 10, background: "#fff", padding: "16px 28px", borderRadius: 10, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", fontSize: 13, color: "#888", textAlign: "center" }}>
              No hay pedidos delivery para esta fecha.
            </div>
          )}
          <div ref={mapRef} style={{ width: "100%", height: "calc(100vh - 120px)" }} />
        </div>
      );
    }
    // ─── COMPONENTE CAJA ─────────────────────────────────────────────────
    function VistaCaja({ pedidosFinalizados, onVolver, usuario }) {
            const HOY_CAJA = fechaArgentina();
      const localesPermitidos = usuario.rol === "admin"
        ? ["A. Thomas", "French", "Administración"]
        : usuario.rol === "a_thomas" ? ["A. Thomas"] : ["French"];
      const [localSeleccionado, setLocalSeleccionado] = useState(localesPermitidos[0]);
      const [estadoCaja, setEstadoCaja] = useState(null);
      const [loadingCaja, setLoadingCaja] = useState(false);
      const [montoApertura, setMontoApertura] = useState("");
      const [ajuste, setAjuste] = useState({ tipo: "entrada", concepto: "", monto: "" });
      const [montoCierre, setMontoCierre] = useState("");
      const [mostrarAjuste, setMostrarAjuste] = useState(false);
       const [mostrarSobre, setMostrarSobre] = useState(false);
      const [sobre, setSobre] = useState({ monto: "", concepto: "" });
      const [guardando, setGuardando] = useState(false);
      const [historial, setHistorial] = useState([]);
      const [loadingHistorial, setLoadingHistorial] = useState(false);
      const [diaExpandido, setDiaExpandido] = useState(null);
      const [filtroHistorial, setFiltroHistorial] = useState("");

      async function cargarEstado() {
        setLoadingCaja(true);
        try {
const res = await axios.get(`${API}/api/caja/estado/${encodeURIComponent(localSeleccionado)}/${HOY_CAJA}`);          setEstadoCaja(res.data);
        } catch (e) { console.error(e); }
        setLoadingCaja(false);
      }

      async function cargarHistorial() {
        setLoadingHistorial(true);
        try {
          const res = await axios.get(`${API}/api/caja/historial/${encodeURIComponent(localSeleccionado)}`);
          setHistorial(res.data.filter(h => h.apertura.fecha !== HOY_CAJA));
        } catch(e) { console.error(e); }
        setLoadingHistorial(false);
      }

      useEffect(() => { cargarEstado(); cargarHistorial(); }, [localSeleccionado]);
      useEffect(() => {
        if (localSeleccionado === "Administración" && estadoCaja !== null && !estadoCaja?.apertura && !loadingCaja) {
          axios.post(`${API}/api/caja/apertura`, { local: "Administración", fecha: HOY_CAJA, montoInicial: 0 })
            .then(() => cargarEstado())
            .catch(console.error);
        }
      }, [localSeleccionado, estadoCaja, loadingCaja]);
  function generarPDFCierre(local, fecha, montoIni, ventasPorMedioData, ajustesList, saldoEsp, montoCierreVal) {
        const doc = new jsPDF();
        const fechaLabel = new Date(fecha + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
        doc.setFontSize(16); doc.setTextColor(246, 139, 50);
        doc.text("Piccadely — Cierre Z", 14, 18);
        doc.setFontSize(11); doc.setTextColor(80, 80, 80);
        doc.text(`${local} · ${fechaLabel}`, 14, 26);
        doc.text(`Generado: ${new Date().toLocaleString("es-AR")}`, 14, 32);
        const filas = [["Monto inicial", `$${Number(montoIni).toLocaleString("es-AR")}`]];
        let totalVentasPDF = 0;
        MEDIOS_PAGO.forEach(medio => {
          const monto = ventasPorMedioData[medio] || 0;
          if (monto > 0) { filas.push([`Ventas ${medio}`, `$${monto.toLocaleString("es-AR")}`]); totalVentasPDF += monto; }
        });
        filas.push(["Total ventas", `$${totalVentasPDF.toLocaleString("es-AR")}`]);
        ajustesList.forEach(a => {
          filas.push([`${Number(a.monto) >= 0 ? "↑" : "↓"} ${a.concepto}`, `$${Math.abs(Number(a.monto)).toLocaleString("es-AR")}`]);
        });
        filas.push(["Saldo esperado (efectivo)", `$${Number(saldoEsp).toLocaleString("es-AR")}`]);
        filas.push(["Efectivo contado al cierre", `$${Number(montoCierreVal).toLocaleString("es-AR")}`]);
        const diff = Number(montoCierreVal) - Number(saldoEsp);
        filas.push(["Diferencia", `$${diff.toLocaleString("es-AR")}`]);
        autoTable(doc, {
          startY: 38, body: filas,
          styles: { fontSize: 11, cellPadding: 4 },
          columnStyles: { 0: { fontStyle: "bold", textColor: [80, 80, 80] }, 1: { halign: "right" } },
          alternateRowStyles: { fillColor: [249, 249, 247] },
          didParseCell: (data) => {
            if (data.row.index === filas.length - 3) { data.cell.styles.fillColor = [246, 139, 50]; data.cell.styles.textColor = 255; data.cell.styles.fontStyle = "bold"; }
            if (data.row.index === filas.length - 1) { data.cell.styles.textColor = diff >= 0 ? [42, 122, 75] : [192, 57, 43]; data.cell.styles.fontStyle = "bold"; }
          },
        });
        doc.save(`cierre_z_${local.replace(/[\s.]/g, "_")}_${fecha}.pdf`);
      }
      async function abrirCaja() {
        if (!montoApertura) return;
        setGuardando(true);
        await axios.post(`${API}/api/caja/apertura`, { local: localSeleccionado, fecha: HOY_CAJA, montoInicial: Number(montoApertura) });
        setMontoApertura(""); await cargarEstado(); setGuardando(false);
      }
async function registrarSobre() {
        if (!sobre.monto) return;
        setGuardando(true);
        try {
          await axios.post(`${API}/api/caja/sobre`, { localOrigen: localSeleccionado, fecha: HOY_CAJA,
            monto: Number(sobre.monto), concepto: sobre.concepto,
            usuario: usuario.nombre_completo
          });
          setSobre({ monto: "", concepto: "" });
          setMostrarSobre(false);
          await cargarEstado();
        } catch (err) { alert("Error registrando sobre: " + err.message); }
        setGuardando(false);
      }
      async function registrarAjuste() {
        if (!ajuste.concepto || !ajuste.monto) return;
        setGuardando(true);
        const monto = ajuste.tipo === "salida" ? -Math.abs(Number(ajuste.monto)) : Math.abs(Number(ajuste.monto));
await axios.post(`${API}/api/caja/ajuste`, { local: localSeleccionado, fecha: HOY_CAJA, tipo: ajuste.tipo, concepto: ajuste.concepto, monto });        setAjuste({ tipo: "entrada", concepto: "", monto: "" }); setMostrarAjuste(false); await cargarEstado(); setGuardando(false);
      }

       async function cerrarCaja() {
      if (!montoCierre) return;
      setGuardando(true);
await axios.post(`${API}/api/caja/cierre`, { local: localSeleccionado, fecha: HOY_CAJA, montoCierre: Number(montoCierre), usuario: usuario.nombre_completo });      const ventasPorMedioPDF = {};
      MEDIOS_PAGO.forEach(m => { ventasPorMedioPDF[m] = sumar(ventasPorMedio[m] || []); });
generarPDFCierre(localSeleccionado, HOY_CAJA, montoInicial, ventasPorMedioPDF, ajustes, saldoEsperado, Number(montoCierre));      setMontoCierre(""); await cargarEstado(); await cargarHistorial(); setGuardando(false);
    }
const ventasLocal = pedidosFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === HOY_CAJA);
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
              {localesPermitidos.length > 1 && localesPermitidos.map(l => (
                <button key={l} onClick={() => setLocalSeleccionado(l)}
                  style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer",
                    borderColor: localSeleccionado === l ? "#F68B32" : "#ddd", background: localSeleccionado === l ? "#F68B32" : "#fff",
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
                  <button style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
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
                        <span style={{ fontSize: 14, fontWeight: 600, color: "#F68B32" }}>{fmt(sumar(pedidos))}</span>
                      </div>
                    );
                  })}
                  {localSeleccionado === "Administración" ? <div style={{ fontSize: 12, color: "#888", padding: "12px 0", fontStyle: "italic" }}>Esta caja solo registra movimientos manuales.</div> : ventasLocal.length === 0 && <div style={{ fontSize: 12, color: "#aaa" }}>Sin ventas registradas</div>}
                  <div style={{ borderTop: "2px solid #eee", marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between" }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Total ventas</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>{fmt(totalVentas)}</span>
                  </div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>
                    🏦 Estado de caja {cerrada && <span style={{ fontSize: 11, background: "#c0392b", color: "#fff", padding: "2px 8px", borderRadius: 4, marginLeft: 8 }}>CERRADA</span>}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}><span style={{ fontSize: 13, color: "#666" }}>Monto inicial</span><span style={{ fontSize: 13, fontWeight: 500 }}>{fmt(montoInicial)}</span></div>
                  {localSeleccionado !== "Administración" && <div style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}><span style={{ fontSize: 13, color: "#666" }}>Ventas efectivo</span><span style={{ fontSize: 13, fontWeight: 500 }}>{fmt(totalEfectivo)}</span></div>}
                  {ajustes.map((a, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5" }}>
                      <span style={{ fontSize: 12, color: Number(a.monto) >= 0 ? "#F68B32" : "#c0392b" }}>{Number(a.monto) >= 0 ? "↑" : "↓"} {a.concepto}</span>
                      <span style={{ fontSize: 12, fontWeight: 500, color: Number(a.monto) >= 0 ? "#F68B32" : "#c0392b" }}>{fmt(Math.abs(a.monto))}</span>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0 6px", borderTop: "2px solid #eee", marginTop: 4 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>Saldo esperado</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>{fmt(saldoEsperado)}</span>
                  </div>
                 {cerrada && estadoCaja.apertura.monto_cierre !== null && (
                    <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 12, marginTop: 10 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 13, color: "#666" }}>Efectivo contado al cierre</span><span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(estadoCaja.apertura.monto_cierre)}</span></div>
                      <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 13, color: "#666" }}>Diferencia</span><span style={{ fontSize: 13, fontWeight: 600, color: (estadoCaja.apertura.monto_cierre - saldoEsperado) >= 0 ? "#F68B32" : "#c0392b" }}>{fmt(estadoCaja.apertura.monto_cierre - saldoEsperado)}</span></div>
                    </div>
                  )}
                  {cerrada && (
                    <div style={{ marginTop: 14, padding: "12px 0", borderTop: "1px solid #eee" }}>
                      <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>¿Necesitás abrir la caja de nuevo hoy?</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input type="number" style={{ fontSize: 13, padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", flex: 1 }} placeholder="Monto inicial $0" value={montoApertura} onChange={e => setMontoApertura(e.target.value)} />
                        <button style={{ padding: "7px 14px", borderRadius: 6, border: "none", background: "#F68B32", color: "#fff", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                          onClick={async () => {
                            setGuardando(true);
                            try {
                              await axios.post(`${API}/api/caja/reabrir`, { local: localSeleccionado, fecha: HOY_CAJA, montoInicial: Number(montoApertura) || 0, usuario: usuario.nombre_completo });
                              setMontoApertura("");
                              await cargarEstado();
                            } catch (err) { alert("Error al reabrir la caja: " + err.message); }
                            setGuardando(false);
                          }}
                          disabled={guardando}>
                          🔓 Abrir nuevo día
                        </button>
                      </div>
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>📋 Movimientos del día</div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!cerrada && <button style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #F68B32", background: "none", color: "#F68B32", cursor: "pointer" }} onClick={() => setMostrarAjuste(m => !m)}>+ Ajuste</button>}
                      {!cerrada && localSeleccionado !== "Administración" && <button style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #7c3aed", background: "none", color: "#7c3aed", cursor: "pointer" }} onClick={() => setMostrarSobre(m => !m)}>💼 Sobre</button>}
                    </div>
                  </div>
                  {mostrarSobre && !cerrada && localSeleccionado !== "Administración" && (
                    <div style={{ background: "#f5f3ff", border: "1px solid #7c3aed", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#7c3aed", marginBottom: 8 }}>💼 Enviar sobre a Administración</div>
                      <input style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 6 }} placeholder="Concepto (opcional)" value={sobre.concepto} onChange={e => setSobre(s => ({...s, concepto: e.target.value}))} />
                      <input type="number" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 8 }} placeholder="Monto" value={sobre.monto} onChange={e => setSobre(s => ({...s, monto: e.target.value}))} />
                      <button style={{ width: "100%", padding: "7px", borderRadius: 6, border: "none", background: "#7c3aed", color: "#fff", fontSize: 12, cursor: "pointer" }} onClick={registrarSobre} disabled={guardando}>Registrar sobre</button>
                    </div>
                  )}
                  {mostrarAjuste && !cerrada && (
                    <div style={{ background: "#f9f9f7", borderRadius: 8, padding: 12, marginBottom: 12 }}>
                      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                        <button onClick={() => setAjuste(a => ({...a, tipo: "entrada"}))} style={{ flex: 1, padding: "6px", borderRadius: 6, border: "1px solid", cursor: "pointer", fontSize: 12, borderColor: ajuste.tipo === "entrada" ? "#F68B32" : "#ddd", background: ajuste.tipo === "entrada" ? "#eaf3de" : "#fff", color: ajuste.tipo === "entrada" ? "#F68B32" : "#555" }}>↑ Entrada</button>
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
                      <span style={{ fontSize: 13, fontWeight: 500, color: m.tipo === "salida" ? "#c0392b" : "#F68B32" }}>{m.tipo === "salida" ? "-" : "+"}{fmt(Math.abs(m.monto))}</span>
                    </div>
                  ))}
                </div>
                 {!cerrada && localSeleccionado !== "Administración" && (
                  <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>🔒 Cierre Z</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Saldo esperado: <strong>{fmt(saldoEsperado)}</strong></div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>EFECTIVO CONTADO AL CIERRE</div>
                    <input type="number" style={{ fontSize: 14, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 10 }} placeholder="$0" value={montoCierre} onChange={e => setMontoCierre(e.target.value)} />
                    {montoCierre && <div style={{ background: "#f9f9f7", borderRadius: 6, padding: "8px 12px", marginBottom: 10, fontSize: 12 }}>Diferencia: <strong style={{ color: (Number(montoCierre) - saldoEsperado) >= 0 ? "#F68B32" : "#c0392b" }}>{fmt(Number(montoCierre) - saldoEsperado)}</strong></div>}
                    <button style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#c0392b", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={cerrarCaja} disabled={guardando || !montoCierre}>{guardando ? "Cerrando..." : "Ejecutar cierre Z"}</button>
                  </div>
                )}
                <div style={{ gridColumn: "span 2", marginTop: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>📅 Historial de cierres</div>
                    <input type="date" style={{ fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
                      value={filtroHistorial} onChange={e => setFiltroHistorial(e.target.value)} />
                    {filtroHistorial && <button style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#888" }} onClick={() => setFiltroHistorial("")}>✕ Limpiar</button>}
                    {historial.length > 0 && (
                      <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                        <button style={btnExportar("#F68B32")} onClick={() => {
                          const histFiltrado = historial.filter(h => !filtroHistorial || h.apertura.fecha === filtroHistorial);
                          const resumen = histFiltrado.map(h => {
                            const a = h.apertura;
                            const ajustesH = h.movimientos.filter(m => m.tipo === "entrada" || m.tipo === "salida");
                            const totalAjustesH = ajustesH.reduce((acc, m) => acc + Number(m.monto), 0);
                            const saldoEsperadoH = Number(a.monto_inicial) + totalAjustesH;
                            const diferencia = a.monto_cierre !== null ? Number(a.monto_cierre) - saldoEsperadoH : null;
                            return { "Fecha": a.fecha, "Monto inicial": Number(a.monto_inicial), "Total ajustes": totalAjustesH, "Saldo esperado": saldoEsperadoH, "Monto cierre": a.monto_cierre !== null ? Number(a.monto_cierre) : "", "Diferencia": diferencia !== null ? diferencia : "", "Estado": a.cerrada ? "Cerrada" : "Sin cerrar" };
                          });
                          const movimientosDetalle = [];
                          histFiltrado.forEach(h => { h.movimientos.forEach(m => { movimientosDetalle.push({ "Fecha": h.apertura.fecha, "Hora": new Date(m.created_at).toLocaleTimeString("es-AR"), "Tipo": m.tipo, "Concepto": m.concepto, "Monto": Number(m.monto) }); }); });
                          exportarExcel(`caja_${localSeleccionado}_${filtroHistorial || "todas"}.xlsx`, [{ name: "Resumen por día", data: resumen }, { name: "Movimientos detalle", data: movimientosDetalle }]);
                        }}>📊 Excel</button>
                        <button style={btnExportar("#c0392b")} onClick={() => {
                          const histFiltrado = historial.filter(h => !filtroHistorial || h.apertura.fecha === filtroHistorial);
                          const filas = histFiltrado.map(h => {
                            const a = h.apertura;
                            const ajustesH = h.movimientos.filter(m => m.tipo === "entrada" || m.tipo === "salida");
                            const totalAjustesH = ajustesH.reduce((acc, m) => acc + Number(m.monto), 0);
                            const saldoEsperadoH = Number(a.monto_inicial) + totalAjustesH;
                            const diferencia = a.monto_cierre !== null ? Number(a.monto_cierre) - saldoEsperadoH : null;
                            return [a.fecha, fmt(a.monto_inicial), fmt(totalAjustesH), fmt(saldoEsperadoH), a.monto_cierre !== null ? fmt(a.monto_cierre) : "—", diferencia !== null ? fmt(diferencia) : "—", a.cerrada ? "Cerrada" : "Sin cerrar"];
                          });
                          exportarPDF(`caja_${localSeleccionado}_${filtroHistorial || "todas"}.pdf`, `Historial de Caja — ${localSeleccionado}`, ["Fecha", "Inicial", "Ajustes", "Esperado", "Contado", "Diferencia", "Estado"], filas, null, filtroHistorial ? `Fecha: ${filtroHistorial}` : "Todas las fechas");
                        }}>📄 PDF</button>
                      </div>
                    )}
                  </div>
                  {loadingHistorial ? <div style={{ fontSize: 12, color: "#aaa" }}>Cargando historial...</div>
                  : historial.length === 0 ? <div style={{ fontSize: 12, color: "#aaa" }}>Sin cierres anteriores</div>
                  : historial.filter(h => !filtroHistorial || h.apertura.fecha === filtroHistorial).map(h => {
                    const a = h.apertura;
                    const movs = h.movimientos;
                    const ajustesH = movs.filter(m => m.tipo === "entrada" || m.tipo === "salida");
                    const totalAjustesH = ajustesH.reduce((acc, m) => acc + Number(m.monto), 0);
                    const saldoEsperadoH = Number(a.monto_inicial) + totalAjustesH;
                    const diferencia = a.monto_cierre !== null ? Number(a.monto_cierre) - saldoEsperadoH : null;
                    const abierto = diaExpandido === a.id;
                    const fechaLabel = new Date(a.fecha + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
                    return (
                      <div key={a.id} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", cursor: "pointer", background: abierto ? "#f9f9f7" : "#fff" }}
                          onClick={() => setDiaExpandido(abierto ? null : a.id)}>
                          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                            <span style={{ fontSize: 13, fontWeight: 600, color: "#333", textTransform: "capitalize" }}>{fechaLabel}</span>
                            {a.cerrada ? <span style={{ fontSize: 11, background: "#eaf3de", color: "#F68B32", padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>✓ Cerrada</span>
                              : <span style={{ fontSize: 11, background: "#fef9e7", color: "#856404", padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>Sin cerrar</span>}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
                            {diferencia !== null && <span style={{ fontSize: 12, color: diferencia >= 0 ? "#F68B32" : "#c0392b", fontWeight: 600 }}>{diferencia >= 0 ? "+" : ""}{fmt(diferencia)} diferencia</span>}
                            <span style={{ fontSize: 14, fontWeight: 700, color: "#F68B32" }}>{fmt(a.monto_cierre || saldoEsperadoH)}</span>
                            <span style={{ fontSize: 11, color: "#aaa" }}>{abierto ? "▲" : "▼"}</span>
                          </div>
                        </div>
                        {abierto && (
                          <div style={{ padding: "12px 16px", borderTop: "1px solid #eee", background: "#fafaf8" }}>
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
                              <div><div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", fontWeight: 600, marginBottom: 2 }}>Monto inicial</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(a.monto_inicial)}</div></div>
                              <div><div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", fontWeight: 600, marginBottom: 2 }}>Saldo esperado</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(saldoEsperadoH)}</div></div>
                              {a.monto_cierre !== null && <>
                                <div><div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", fontWeight: 600, marginBottom: 2 }}>Efectivo contado</div><div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(a.monto_cierre)}</div></div>
                                <div><div style={{ fontSize: 10, color: "#aaa", textTransform: "uppercase", fontWeight: 600, marginBottom: 2 }}>Diferencia</div><div style={{ fontSize: 13, fontWeight: 600, color: diferencia >= 0 ? "#F68B32" : "#c0392b" }}>{diferencia >= 0 ? "+" : ""}{fmt(diferencia)}</div></div>
                              </>}
                            </div>
                            {movs.length > 0 && (
                              <div>
                                {!a.cerrada && (
                              <div style={{ marginBottom: 12, background: "#fef9e7", border: "1px solid #f39c12", borderRadius: 8, padding: 12 }}>
                                <div style={{ fontSize: 12, color: "#856404", marginBottom: 8 }}>⚠️ Este día quedó sin cerrar. Podés cerrarlo ahora.</div>
                                <button style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "none", background: "#f39c12", color: "#fff", cursor: "pointer", fontWeight: 600 }}
                                  onClick={async () => {
                                    if (!window.confirm(`¿Cerrar la caja del ${a.fecha}?`)) return;
                                    await axios.post(`${API}/api/caja/cerrar-historico`, { local: localSeleccionado, fecha: a.fecha, usuario: usuario.nombre_completo });
                                    await cargarHistorial();
                                  }}>
                                  🔒 Cerrar este día
                                </button>
                              </div>
                            )}
                                {a.cerrada && (
                              <button style={{ marginTop: 12, fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "1px solid #c0392b", background: "#fff", color: "#c0392b", cursor: "pointer", fontWeight: 500 }}
                                onClick={() => {
                                  const ventasDelDia = pedidosFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === a.fecha);
                                  const ventasPorMedioPDF = {};
                                  MEDIOS_PAGO.forEach(m => { ventasPorMedioPDF[m] = ventasDelDia.filter(p => p.medioPago === m).reduce((acc, p) => acc + p.totalNum, 0); });
                                  generarPDFCierre(localSeleccionado, a.fecha, a.monto_inicial, ventasPorMedioPDF, ajustesH, saldoEsperadoH, a.monto_cierre);
                                }}>
                                📄 Descargar PDF Cierre Z
      
                            
                              </button>
                            )}
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 6 }}>Movimientos</div>
                                {movs.map((m, i) => (
                                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #f0f0ee", fontSize: 12 }}>
                                    <div><span style={{ color: "#555" }}>{m.concepto}</span><span style={{ fontSize: 11, color: "#aaa", marginLeft: 8 }}>{new Date(m.created_at).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })}</span></div>
                                    <span style={{ fontWeight: 600, color: m.tipo === "salida" ? "#c0392b" : "#F68B32" }}>{m.tipo === "salida" ? "-" : "+"}{fmt(Math.abs(m.monto))}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // ─── PANEL PRINCIPAL ─────────────────────────────────────────────────
    function PanelApp({ usuario }) {
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
      const [pedidoEmailMP, setPedidoEmailMP] = useState(null);
      const [facturaVersion, setFacturaVersion] = useState(0);
      const [rvDesde, setRvDesde] = useState("");
      const [rvHasta, setRvHasta] = useState("");
      const [rvMedio, setRvMedio] = useState("");
      const [rvRepartidor, setRvRepartidor] = useState("");
      const [tabFin, setTabFin] = useState("entregados");
      const [rpDesde, setRpDesde] = useState("");
      const [rpHasta, setRpHasta] = useState("");
      const [prodFecha, setProdFecha] = useState(HOY);
      const [prodLocal, setProdLocal] = useState("todos");
      const [editandoProductos, setEditandoProductos] = useState(null);
      const [productosOverride, setProductosOverride] = useState({});
      const [pedidosDatosOverride, setPedidosDatosOverride] = useState({});
      const menuRef = useRef(null);
const [facturasMap, setFacturasMap] = useState({});
      const [productos, setProductos] = useState([]);
      const [categorias, setCategorias] = useState([]);
      const [loadingProductos, setLoadingProductos] = useState(false);
      const [busqueda, setBusqueda] = useState("");
      const [categoriaFiltro, setCategoriaFiltro] = useState("");
      const [carrito, setCarrito] = useState([]);
      const [form, setForm] = useState(FORM_INICIAL);
      const [pedidoCreado, setPedidoCreado] = useState(false);
      const [comandasImpresas, setComandasImpresas] = useState({});
      const [repartidoresLista, setRepartidoresLista] = useState(REPARTIDORES_DEFAULT);
      const [varNombre, setVarNombre] = useState("");
      const [varPrecio, setVarPrecio] = useState("");
      const [varCantidad, setVarCantidad] = useState("1");

      async function cargarProductosOverride(ids) {
        const overrides = {};
        await Promise.all(ids.map(async id => {
          try {
            const res = await axios.get(`${API}/api/pedidos/productos/${id}`);
            if (res.data) overrides[String(id)] = res.data;
          } catch(e) {}
        }));
        setProductosOverride(overrides);
      }

      async function asegurarCatalogo() {
        if (productos.length === 0) {
          setLoadingProductos(true);
          try {
            const [resP, resC] = await Promise.all([axios.get(`${API}/api/products`), axios.get(`${API}/api/categories`)]);
            setProductos(resP.data.filter(p => p.variants?.[0]?.price));
            setCategorias(resC.data.filter(c => c.parent === null));
          } catch(e) {}
          setLoadingProductos(false);
        }
      }

      useEffect(() => {
        Promise.all([
          axios.get(`${API}/api/orders`),
          axios.get(`${API}/api/estados`),
          axios.get(`${API}/api/pedidos-manuales`),
        ]).then(async ([resOrders, resEstados, resManuales]) => {
          setPedidosRaw(resOrders.data);
          const locales = {};
          resOrders.data.forEach(p => {
            locales[p.id] = resEstados.data[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.payment_status !== "paid" };
          });
          resManuales.data.forEach(p => {
            locales[p.id] = resEstados.data[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar };
          });
          setPedidosLocales(locales);
          setPedidosManuales(resManuales.data);

          // Inicializar overrides de datos desde estados
          const datosInit = {};
          Object.entries(resEstados.data).forEach(([id, est]) => {
            const ov = {};
            if (est.clienteOverride) ov.cliente = est.clienteOverride;
            if (est.telefonoOverride) ov.telefono = est.telefonoOverride;
            if (est.direccionOverride) ov.direccion = est.direccionOverride;
            if (est.barrioOverride) ov.barrio = est.barrioOverride;
            if (est.zonaOverride) ov.zona = est.zonaOverride;
            if (est.medioPagoOverride) ov.medioPago = est.medioPagoOverride;
            if (est.notaOverride !== undefined && est.notaOverride !== null) ov.nota = est.notaOverride;
            if (est.codigoPagoOverride) ov.codigoPago = est.codigoPagoOverride;
            if (Object.keys(ov).length > 0) datosInit[id] = ov;
          });
setPedidosDatosOverride(datosInit);
          // Inicializar contador de comandas impresas desde la base
          const comandasInit = {};
          Object.entries(resEstados.data).forEach(([id, est]) => {
            if (est.comandasImpresas && est.comandasImpresas > 0) comandasInit[id] = est.comandasImpresas;
          });
          setComandasImpresas(comandasInit);    try { const resRep = await axios.get(`${API}/api/repartidores`); setRepartidoresLista(resRep.data.map(r => r.nombre)); } catch(e) {}
          setLoading(false);
          axios.get(`${API}/api/facturas-all`).then(resF => {
            const grouped = {};
            resF.data.forEach(f => { if (!grouped[f.pedido_id]) grouped[f.pedido_id] = []; grouped[f.pedido_id].push(f); });
            const map = {};
            Object.entries(grouped).forEach(([pid, facturas]) => {
              const emitidas = facturas.filter(f => !f.tipo.includes("NOTA DE CREDITO"));
              const ncs = facturas.filter(f => f.tipo.includes("NOTA DE CREDITO"));
              if (emitidas.length > ncs.length) { const a = emitidas[emitidas.length - 1]; map[pid] = `${a.tipo} Nº ${a.numero}`; }
            });
            setFacturasMap(map);
          }).catch(console.error);
          const ids = [...resOrders.data.map(p => String(p.id)), ...resManuales.data.map(p => p.id)];
          cargarProductosOverride(ids);
        }).catch(() => { setError("Error conectando con Tienda Nube"); setLoading(false); });
      }, []);

      useEffect(() => {
        const refrescar = async () => {
          try {
            const [resOrders, resManuales, resEstados] = await Promise.all([
              axios.get(`${API}/api/orders`),
              axios.get(`${API}/api/pedidos-manuales`),
              axios.get(`${API}/api/estados`),
            ]);
            setPedidosRaw(resOrders.data);
            setPedidosManuales(resManuales.data);
            const comandasRefresh = {};
            Object.entries(resEstados.data).forEach(([id, est]) => {
              if (est.comandasImpresas && est.comandasImpresas > 0) comandasRefresh[id] = est.comandasImpresas;
            });
            setComandasImpresas(prev => ({ ...prev, ...comandasRefresh }));
            setPedidosLocales(prev => {
              const nuevo = { ...prev };
              resOrders.data.forEach(p => { if (!nuevo[p.id]) nuevo[p.id] = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.payment_status !== "paid" }; });
              resManuales.data.forEach(p => { if (!nuevo[p.id]) nuevo[p.id] = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar }; });
              return nuevo;
            });
          } catch (err) { console.warn("Auto-refresh falló:", err.message); }
        };
        const interval = setInterval(refrescar, 30000);
        return () => clearInterval(interval);
      }, []);

      const idsPedidosVistosRef = useRef(null);
      useEffect(() => {
        if (loading) return;
        const idsActuales = new Set([...pedidosRaw.map(p => String(p.id)), ...pedidosManuales.map(p => String(p.id))]);
        if (idsPedidosVistosRef.current === null) { idsPedidosVistosRef.current = idsActuales; return; }
        const nuevos = [...idsActuales].filter(id => !idsPedidosVistosRef.current.has(id));
        if (nuevos.length > 0) { reproducirBeep(); document.title = `🔔 ${nuevos.length} nuevo${nuevos.length > 1 ? "s" : ""} - Piccadely`; }
        idsPedidosVistosRef.current = idsActuales;
      }, [pedidosRaw, pedidosManuales, loading]);

      useEffect(() => {
        function restaurarTitulo() { document.title = "Piccadely Panel"; }
        window.addEventListener("focus", restaurarTitulo);
        window.addEventListener("click", restaurarTitulo);
        return () => { window.removeEventListener("focus", restaurarTitulo); window.removeEventListener("click", restaurarTitulo); };
      }, []);

      useEffect(() => {
        if (tab === "nuevo" && productos.length === 0) {
          setLoadingProductos(true);
          Promise.all([axios.get(`${API}/api/products`), axios.get(`${API}/api/categories`)]).then(([resP, resC]) => {
            setProductos(resP.data.filter(p => p.variants?.[0]?.price));
            setCategorias(resC.data.filter(c => c.parent === null));
            setLoadingProductos(false);
          }).catch(() => setLoadingProductos(false));
        }
      }, [tab]);

      useEffect(() => {
        function handleClick(e) { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuAbierto(false); }
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
      }, []);

      const pedidosProcesados = useMemo(() => [
        ...pedidosRaw.map(p => {
          const zona = p.fulfillments?.[0]?.shipping?.option?.name || "Sin zona";
          const { fecha, franja } = parsearFranja(p.owner_note);
          const prods = p.products.map(pr => `${pr.name} x${pr.quantity}`).join(", ");
          const local = pedidosLocales[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: false };
          const tabAuto = clasificarPedido(p);
          const tabActual = local.tabManual || tabAuto;
          const totalNum = Number(p.total);
          const ov = productosOverride[String(p.id)];
          const ovDatos = pedidosDatosOverride[String(p.id)] || {};
          const direccionOriginal = `${p.shipping_address?.address || ""} ${p.shipping_address?.number || ""}${p.shipping_address?.floor ? ` ${p.shipping_address.floor}` : ""}`.trim();
          return {
            id: p.id, numero: `#${p.number}`,
            cliente: ovDatos.cliente || p.contact_name,
            telefono: ovDatos.telefono || p.contact_phone,
            direccion: ovDatos.direccion || direccionOriginal,
            barrio: ovDatos.barrio || p.shipping_address?.locality || p.shipping_address?.city || "",
            zona: ovDatos.zona || zona,
            fecha, franja, fechaDisplay: local.fechaManual || fecha, franjaDisplay: local.franjaManual || franja || "Sin franja",
            productos: ov ? ov.productos : prods,
            totalNum: ov ? Number(ov.total_num) : totalNum,
            total: ov ? `$${Number(ov.total_num).toLocaleString("es-AR")}` : `$${totalNum.toLocaleString("es-AR")}`,
            pago: p.payment_status === "paid" ? "Pagado" : "Pendiente",
            medioPago: ovDatos.medioPago || medioPagoLabel(p.gateway), gateway: p.gateway,
            esTakeaway: p.fulfillments?.[0]?.shipping?.type === "pickup",
            estado: local.estado, repartidor: local.repartidor, cobrar: local.cobrar,
            tabActual, local: localLabel(tabActual),
            nota: ovDatos.nota !== undefined ? ovDatos.nota : (p.note || ""),
            esManual: false, entreCalles: "",
            transaccionMP: p.gateway_id || p.transactions?.[0]?.id || null,
            codigoPago: ovDatos.codigoPago !== undefined ? ovDatos.codigoPago : (p.gateway_id ? String(p.gateway_id) : (p.transactions?.[0]?.id ? String(p.transactions[0].id) : "")),
            identificacion: p.contact_identification || p.identification?.number || "", razonSocialFactura: p.billing_business_name || "", esFacturaA: p.billing_customer_type === "company" && p.billing_document_type === "cuit", email: ovDatos.email !== undefined ? ovDatos.email : (p.contact_email || ""),
          };
        }),
        ...pedidosManuales.map(p => {
          const local = pedidosLocales[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar };
          const tabActual = local.tabManual || p.tabActual;
          const ov = productosOverride[String(p.id)];
          const ovDatos = pedidosDatosOverride[String(p.id)] || {};
          return {
            ...p,
            cliente: ovDatos.cliente !== undefined ? ovDatos.cliente : p.cliente,
            telefono: ovDatos.telefono !== undefined ? ovDatos.telefono : p.telefono,
            direccion: ovDatos.direccion !== undefined ? ovDatos.direccion : p.direccion,
            barrio: ovDatos.barrio !== undefined ? ovDatos.barrio : p.barrio,
            zona: ovDatos.zona !== undefined ? ovDatos.zona : p.zona,
            medioPago: ovDatos.medioPago !== undefined ? ovDatos.medioPago : p.medioPago,
            nota: ovDatos.nota !== undefined ? ovDatos.nota : (p.nota || ""),
            email: ovDatos.email !== undefined ? ovDatos.email : (p.email || ""),
            estado: local.estado, repartidor: local.repartidor,
            cobrar: local.cobrar !== undefined ? local.cobrar : p.cobrar,
            tabActual, local: localLabel(tabActual),
            fechaDisplay: local.fechaManual || p.fecha, franjaDisplay: local.franjaManual || p.franja || "Sin franja",
            identificacion: p.identificacion || "", email: p.email || "",
            codigoPago: ovDatos.codigoPago !== undefined ? ovDatos.codigoPago : (p.codigoPago || ""),
            productos: ov ? ov.productos : p.productos,
            totalNum: ov ? Number(ov.total_num) : p.totalNum,
            total: ov ? `$${Number(ov.total_num).toLocaleString("es-AR")}` : p.total,
          };
        }),
      ], [pedidosRaw, pedidosManuales, pedidosLocales, productosOverride, pedidosDatosOverride]);

      const pedidosActivos = pedidosProcesados.filter(p => {
        const estado = pedidosLocales[p.id]?.estado || p.estado;
        if (estado === "Entregado" || estado === "Anulado") return false;
        if (!p.fechaDisplay) return true;
        return p.fechaDisplay >= HOY;
      });

      const pedidosFinalizados = pedidosProcesados.filter(p => {
        const est = pedidosLocales[p.id]?.estado || p.estado;
        return est === "Entregado" || est === "Anulado";
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
    const franjas = Object.keys(porFranja).sort((a, b) => {
      const aSinFecha = a.startsWith("sin-fecha");
      const bSinFecha = b.startsWith("sin-fecha");
      if (aSinFecha && !bSinFecha) return -1;
      if (!aSinFecha && bSinFecha) return 1;
      return a.localeCompare(b);
    });
      function actualizarLocal(id, cambios) {
      setPedidosLocales(prev => { const nuevo = { ...prev, [id]: { ...prev[id], ...cambios } }; guardarEstadoDB(id, nuevo[id], usuario.nombre_completo); return nuevo; });
    }
      function actualizarLocalSinGuardar(id, cambios) {
        setPedidosLocales(prev => ({ ...prev, [id]: { ...prev[id], ...cambios } }));
      }
      function guardarLocalEnDB(id) {
      setPedidosLocales(prev => { if (prev[id]) guardarEstadoDB(id, prev[id], usuario.nombre_completo); return prev; });
    }
      function cambiarEstado(p, e) {
      e.stopPropagation();
      const id = p.id;
      const requiereCodigo = ["Mercado Pago", "Rappi", "Pedidos Ya"].includes(p.medioPago);
      const sinCodigo = !p.codigoPago || !String(p.codigoPago).trim();
      if (requiereCodigo && sinCodigo) {
        const seguir = window.confirm(`⚠️ FALTA CÓDIGO\n\nEl pedido ${p.numero} (${p.medioPago}) no tiene código de pago cargado.\nVerificá que el pago esté confirmado antes de continuar.\n\n¿Cambiar el estado igual?`);
        if (!seguir) return;
      }
      setPedidosLocales(prev => {
        const nuevoEstado = nextEstado(prev[id]?.estado || "Por empaquetar");
        const nuevo = { ...prev, [id]: { ...prev[id], estado: nuevoEstado } };
        guardarEstadoDB(id, nuevo[id], usuario.nombre_completo); return nuevo;
      });
    }

      async function anularPedido(p, e) {
        e.stopPropagation();
        try {
          const factRes = await axios.get(`${API}/api/facturas/${p.id}`);
          const activas = factRes.data.filter(f => !f.tipo.includes("NOTA DE CREDITO"));
          const ncs = factRes.data.filter(f => f.tipo.includes("NOTA DE CREDITO"));
          if (activas.length > ncs.length) { alert("⚠️ Este pedido tiene una factura activa. Primero anulá la factura con nota de crédito desde el botón 🧾 Facturar."); return; }
        } catch(err) { console.error(err); }
        if (!window.confirm(`¿Seguro que querés anular el pedido ${p.numero}?`)) return;
        actualizarLocal(p.id, { estado: "Anulado" });
      }

      function cambiarRepartidor(id, valor) { actualizarLocal(id, { repartidor: valor }); }
      function cambiarTab(id, valor) { actualizarLocal(id, { tabManual: valor }); }
      function cambiarCobrar(id, valor) { actualizarLocal(id, { cobrar: valor }); }
      function toggleExpandido(id) { setExpandido(prev => prev === id ? null : id); }
// ─── CORREGIR / REABRIR PEDIDO FINALIZADO ──────────────────────────
      async function cajaCerradaDe(p) {
        if (!p.local || p.local === "—" || !p.fechaDisplay) return false;
        try {
          const res = await axios.get(`${API}/api/caja/estado/${encodeURIComponent(p.local)}/${p.fechaDisplay}`);
          return !!res.data?.apertura?.cerrada;
        } catch { return false; }
      }
      async function corregirMedioFinalizado(p, valor) {
        if (await cajaCerradaDe(p)) {
          if (!window.confirm(`⚠️ La caja de ${p.local} del ${p.fechaDisplay} ya está cerrada.\n\nCambiar el medio de pago puede modificar ese cierre (ventas por medio de pago y saldo esperado del día).\n\n¿Continuar igual?`)) return;
        }
        actualizarDato(p, "medioPago", valor);
      }
      async function reabrirPedido(p, e) {
        e.stopPropagation();
        const cerrada = await cajaCerradaDe(p);
        const msg = cerrada
          ? `⚠️ La caja de ${p.local} del ${p.fechaDisplay} ya está cerrada.\n\nReabrir el pedido ${p.numero} puede modificar ese cierre. Vuelve al panel en estado "En camino".\n\n¿Reabrir igual?`
          : `¿Reabrir el pedido ${p.numero}? Vuelve al panel en estado "En camino".`;
        if (!window.confirm(msg)) return;
        actualizarLocal(p.id, { estado: "En camino" });
      }
      // ─── ACTUALIZAR DATO DE PEDIDO (cliente, telefono, dirección, etc.) ──
      function actualizarDato(p, campo, valor) {
        const id = String(p.id);
        const actualOverrides = pedidosDatosOverride[id] || {};
        const nuevosOverrides = { ...actualOverrides, [campo]: valor };
        setPedidosDatosOverride(prev => ({ ...prev, [id]: nuevosOverrides }));
        if (p.esManual) {
          const campoMap = { medioPago: "medioPago" };
          const k = campoMap[campo] || campo;
          setPedidosManuales(prev => prev.map(m => String(m.id) === id ? { ...m, [k]: valor } : m));
        }
        const datosDB = {
          esManual: p.esManual,
          cliente: nuevosOverrides.cliente ?? p.cliente,
          telefono: nuevosOverrides.telefono ?? p.telefono,
          direccion: nuevosOverrides.direccion ?? p.direccion,
          barrio: nuevosOverrides.barrio ?? p.barrio,
          zona: nuevosOverrides.zona ?? p.zona,
          medioPago: nuevosOverrides.medioPago ?? p.medioPago,
          nota: nuevosOverrides.nota !== undefined ? nuevosOverrides.nota : (p.nota || ""),
          email: nuevosOverrides.email !== undefined ? nuevosOverrides.email : (p.email || ""),
          codigoPago: nuevosOverrides.codigoPago !== undefined ? nuevosOverrides.codigoPago : (p.codigoPago || ""),
        };
        axios.patch(`${API}/api/pedidos/${id}/datos`, { ...datosDB, usuario: usuario.nombre_completo }).catch(console.error);

        // Si se carga/borra el código MKP, ajustar el estado de cobro
        if (campo === "codigoPago") {
          const requiereCodigo = ["Mercado Pago", "Rappi", "Pedidos Ya"].includes(p.medioPago);
          if (valor && valor.trim()) {
            actualizarLocal(p.id, { cobrar: false });
          } else if (requiereCodigo) {
            actualizarLocal(p.id, { cobrar: true });
          }
        }
      }

      function agregarAlCarrito(prod) {
        const precio = Number(prod.variants[0].price);
        const variantId = prod.variants[0].id;
        setCarrito(prev => {
          const existe = prev.find(i => i.variantId === variantId);
          if (existe) return prev.map(i => i.variantId === variantId ? { ...i, cantidad: i.cantidad + 1 } : i);
          return [...prev, { id: prod.id, variantId, nombre: prod.name.es, precio, cantidad: 1 }];
        });
      }
      function cambiarCantidad(variantId, delta) { setCarrito(prev => prev.map(i => i.variantId === variantId ? { ...i, cantidad: Math.max(1, i.cantidad + delta) } : i)); }
      function quitarDelCarrito(variantId) { setCarrito(prev => prev.filter(i => i.variantId !== variantId)); }
      const totalCarrito = carrito.reduce((a, i) => a + i.precio * i.cantidad, 0);

      async function crearPedido() {
        if (!form.cliente || carrito.length === 0) return;
        const id = `manual-${Date.now()}`;
        const productosStr = carrito.map(i => `${i.nombre} x${i.cantidad}`).join(", ");
        const nuevoPedido = {
         id, numero: "", cliente: form.cliente, telefono: form.telefono,
          email: form.email || "",
          direccion: form.direccion, barrio: form.barrio, entreCalles: form.entreCalles || "",
          zona: form.zona || "Sin zona", fecha: form.fecha, franja: (form.franjaInicio && form.franjaFin) ? `${form.franjaInicio} – ${form.franjaFin}` : "",
          fechaDisplay: form.fecha, franjaDisplay: (form.franjaInicio && form.franjaFin) ? `${form.franjaInicio} – ${form.franjaFin}` : "Sin franja",
          productos: productosStr, totalNum: totalCarrito, total: `$${totalCarrito.toLocaleString("es-AR")}`,
          pago: ["Efectivo", "Pedidos Ya Efectivo", "Mercado Pago", "Rappi", "Pedidos Ya"].includes(form.medioPago) ? "Pendiente" : "Pagado",
          medioPago: form.medioPago, cobrar: form.cobrar, tabActual: form.seccion, local: localLabel(form.seccion),
          nota: form.nota, esManual: true, estado: "Por empaquetar", repartidor: "Sin asignar",
        };
let numeroAsignado = "";
        try {
          const respManual = await axios.post(`${API}/api/pedidos-manuales`, { ...nuevoPedido, usuario: usuario.nombre_completo });
          numeroAsignado = respManual.data?.numero || "";
        } catch (e) { console.error(e); }
        nuevoPedido.numero = numeroAsignado;
                const estadoInicial = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: form.fecha, franjaManual: (form.franjaInicio && form.franjaFin) ? `${form.franjaInicio} – ${form.franjaFin}` : "", cobrar: form.cobrar };
        await axios.post(`${API}/api/estados/${id}`, estadoInicial).catch(console.error);
        setPedidosManuales(prev => [...prev, nuevoPedido]);
        setPedidosLocales(prev => ({ ...prev, [id]: estadoInicial }));
        setCarrito([]); setForm(FORM_INICIAL); setPedidoCreado(true);
        setTimeout(() => setPedidoCreado(false), 3000);
      }

      const productosFiltrados = productos.filter(p => {
        const nombre = p.name?.es?.toLowerCase() || "";
        return (!busqueda || nombre.includes(busqueda.toLowerCase())) &&
          (!categoriaFiltro || p.categories?.some(c => c.id === Number(categoriaFiltro) || c.parent === Number(categoriaFiltro)));
      });

      async function imprimirComanda(p) {
        try {
          const res = await axios.post(`${API}/api/pedidos/${p.id}/imprimir`, { usuario: usuario.nombre_completo });
          setComandasImpresas(prev => ({ ...prev, [p.id]: res.data.comandasImpresas }));
        } catch (e) {
          setComandasImpresas(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }));
        }
        const estadoActual = pedidosLocales[p.id]?.estado || "Por empaquetar";
        const repartidorActual = pedidosLocales[p.id]?.repartidor || "Sin asignar";
        const cobrar = pedidosLocales[p.id]?.cobrar;

        const lineas = [
          "\x1B\x40",
          "\x1B\x74\x12",
          "\x1B\x61\x01",
          "\x1B\x21\x30",
          "PICCADELY\n",
          "\x1B\x21\x00",
          "comanda de pedido\n",
          "--------------------------------\n",
          "\x1B\x61\x00",
          `${p.numero}  ${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "-"}\n`,
          `${p.franjaDisplay}  ${p.zona || ""}\n`,
          "--------------------------------\n",
          "\x1B\x21\x08",
          "CLIENTE\n",
          "\x1B\x21\x00",
          `${p.cliente}\n`,
          `${p.telefono}\n`,
          "\x1B\x21\x08",
          "DIRECCION\n",
          "\x1B\x21\x00",
          `${p.direccion}${p.barrio ? ", " + p.barrio : ""}\n`,
          p.entreCalles ? `${p.entreCalles}\n` : "",
          "--------------------------------\n",
          "\x1B\x21\x08",
          "PRODUCTOS\n",
          "\x1B\x21\x00",
          ...p.productos.split(", ").map(pr => `- ${pr}\n`),
          p.nota ? "--------------------------------\n" : "",
          p.nota ? `\x1B\x21\x08NOTA\n\x1B\x21\x00${p.nota}\n` : "",
          "--------------------------------\n",
          `Medio de pago: ${p.medioPago}\n`,
          "\x1B\x21\x10",
          `TOTAL: ${p.total}\n`,
          "\x1B\x21\x00",
          cobrar ? "\x1B\x21\x30** COBRAR EN ENTREGA **\n\x1B\x21\x00" : "",
          "--------------------------------\n",
          `Repartidor: ${repartidorActual}\n`,
          `Estado: ${estadoActual}\n`,
          "--------------------------------\n",
          "\x1B\x61\x01",
          "Piccadely - juntadely\n",
          "\x1B\x61\x00",
          "\n\n\n",
          "\x1D\x56\x00",
        ].filter(Boolean);

        const cert = `-----BEGIN CERTIFICATE-----
    MIIDxjCCAq6gAwIBAgIULtqv2WPbBo0q7Q6bEWuASwCee9swDQYJKoZIhvcNAQEL
    BQAwdDELMAkGA1UEBhMCQVIxFTATBgNVBAgMDEJ1ZW5vcyBBaXJlczEVMBMGA1UE
    BwwMQnVlbm9zIEFpcmVzMRIwEAYDVQQKDAlQaWNjYWRlbHkxIzAhBgNVBAMMGnBp
    Y2NhZGVseS1wYW5lbC52ZXJjZWwuYXBwMB4XDTI2MDUyNjEyMzEyNVoXDTM2MDUy
    MzEyMzEyNVowdDELMAkGA1UEBhMCQVIxFTATBgNVBAgMDEJ1ZW5vcyBBaXJlczEV
    MBMGA1UEBwwMQnVlbm9zIEFpcmVzMRIwEAYDVQQKDAlQaWNjYWRlbHkxIzAhBgNV
    BAMMGnBpY2NhZGVseS1wYW5lbC52ZXJjZWwuYXBwMIIBIjANBgkqhkiG9w0BAQEF
    AAOCAQ8AMIIBCgKCAQEAmqmVNJBdUV9Sl2oFON2XsgePgsQtRrinz89gvk2f+BxR
    1Lv0iH1TPbmlpHO90XCzz1Uj1AEup/V2X1oCHZFypvWqnaZv/aCSFCZ4q4ZMvgeZ
    nVcKAdGkSn6QPc9yme1AeB5IgQdd31GYoZrUERZklzsvxZqHTIHZ4t6d8d/G980D
    VHMMUkgE4bC7VIcahdwpzeX9oFjWyM5wSCYiRff1JWAb3LZqK6KnxQEJUJYx75K2
    sauEncJlz9K3VTJA9UH4ORQMbmwg8IfF4U2Dr+yQNXCj925jGEG/iowwO3Ay3sCu
    EdhZ/8+dTg0Zublpuhh/UWLxQ1e9zQ7a/2qL/bSkSQIDAQABo1AwTjAdBgNVHQ4E
    FgQUl59WmV6sRU+YOdD/INdS7fnpfGYwHwYDVR0jBBgwFoAUl59WmV6sRU+YOdD/
    INdS7fnpfGYwDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAESMHJGp9
    ztKSMkTPqLYiBkvR787KIqBCYLmKxFtNK3XVHWb8NXj8miEv6p+Hpa9FbYOw3n2r
    Ck/zs1a9VLHec+5a0h6MK54r7QKahznu/sGD6mqBBhjjXWNMny7Oz9Iqts5wxnRY
    VPFp9eEg/mNHYhUaOWQu5umRBcXeBOE3AMgwwQHYtvmxbDreI1AN/+9d+erY/8hX
    1D3lN91XK4Z/A1aSi4EKPGIzqR9hq3BiVPlBWUGl8SG/qy1jJPFKlOJlff6V+fAN
    YS60+SQ0STaXRIWey1dmndFFpI0ryGRdX+LXhT1YoipwlLFzMCI4WRiz2rIB7nfg
    63hs+bW8Ny9XiA==
    -----END CERTIFICATE-----`;

        const privateKeyPem = `-----BEGIN PRIVATE KEY-----
    MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCaqZU0kF1RX1KX
    agU43ZeyB4+CxC1GuKfPz2C+TZ/4HFHUu/SIfVM9uaWkc73RcLPPVSPUAS6n9XZf
    WgIdkXKm9aqdpm/9oJIUJnirhky+B5mdVwoB0aRKfpA9z3KZ7UB4HkiBB13fUZih
    mtQRFmSXOy/FmodMgdni3p3x38b3zQNUcwxSSAThsLtUhxqF3CnN5f2gWNbIznBI
    JiJF9/UlYBvctmoroqfFAQlQljHvkraxq4SdwmXP0rdVMkD1Qfg5FAxubCDwh8Xh
    TYOv7JA1cKP3bmMYQb+KjDA7cDLewK4R2Fn/z51ODRm5uWm6GH9RYvFDV73NDtr/
    aov9tKRJAgMBAAECggEAApZj4bio6Feu/vZTXDTwLivhtayYsaZHtRqRUgW5midG
    eDJlICkb7NGvs31gjNc07uWhVJE+KamvNLUBtDhuzFvE97UP379MClcYGDiGN/yn
    utc4r+NFEMj8Gp30mx4kwLhdpVOio/3juY+991jiTxm6o3SXHwt3bMv6z6Uwg+Ht
    EQa7W3dhDkqwXYX28jOk+liowVAlThaS5xLySNWrKRZAGaYSuzivm4uWbk2i8Ej7
    9P/uaVZ6RVg4NyHK/QgnlR+a+ifdzIpZ5RHc2CY0h/0emOENL+nlETd24dAQhLhf
    OaOo72ilrmeFSPgvup1JBU7O4UfeaeZs2Qx8C9mXbQKBgQDX1JpwvvjKIauLGyyz
    OadLq7Giluqqzt/HYWQcKU3lBAWbifo+DcWzKfUESqsI8RTpV0yOy5j2mnzA18kb
    IO8XY+4+6QCbTYz+TevAAM3xbKfylg6RthZkMmP15LLnakqlDFTyOVONmGUXKZbP
    Y8tSMizr+QzZK82zkSJPdX9KVQKBgQC3cpWauz0082iFLvuxQUoNv3IvzyPRNi5T
    hu1KhEQbluCJuaStKqp2+V6QKx/uJ22dkc+8dM/iyZVXPzQoJZVCZ48fC3WInavv
    JqIXRRrDtTuqZUAgO5D8o5X2reuzcjrH7yUPEqQLarzEApICElpqI0dVLkE8W8pj
    EtU9rgVOJQKBgQCbfqCF+hBkED32ym058p+E9P3VlcUbqk+u5YuqfleQV4VyucWA
    T4vPuLq9jM4McyQNuMd/WU+q20Jl7REGaoPW5jgPOu8k9IpP7POcMPgup4mYTGPS
    ts0LAwLhdRMvhnSg1HGe0Y5QxSqPtXbhk5Q4c83JdHS9QcHBTR7bAFvkwQKBgEOl
    nmNjnmtzQtyx+aBgqhUtvsbAhL22VBj7DW/IHHFsDrra2U3+CMQ8qtFRBcJFidds
    GIWvMaW4njiBFxOi4EqPc6iICjxpoChdP7KDCh6XKzxnf+Ei9hEjpb5EXkFa4zAt
    EKZhQlrvblJ9fCgFao/vGHPhza6bTqOAI2BOVqh9AoGAV8i88hyPMoQw8u66HR7h
    vMkAdO1s9xnxHIEBWZYIOdmdWA5ZU0BnGfkZbkTx2/Y0nF1fvWsGxViXvrZLoh8A
    N9jZK5dYdBuAelL0yCIViH1A8FVTZXAqVMUUJmsS+WKOQKZr07QHM6gaX/cUBj4u
    yNvfREM3VsoSbEMGnHUweT0=
    -----END PRIVATE KEY-----`;

        const fallback = () => {
          const ventana = window.open("", "_blank", "width=400,height=600");
          ventana.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comanda ${p.numero}</title>
            <style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family:'Courier New',monospace; font-size:12px; width:80mm; padding:4mm; color:#000; } .centro { text-align:center; } .titulo { font-size:18px; font-weight:bold; margin-bottom:2px; } .linea { border-top:1px dashed #000; margin:6px 0; } .fila { display:flex; justify-content:space-between; margin:2px 0; } .label { font-weight:bold; font-size:10px; text-transform:uppercase; color:#555; margin-top:6px; margin-bottom:1px; } .valor { font-size:12px; } .total { font-size:15px; font-weight:bold; text-align:right; margin-top:4px; } .cobrar { text-align:center; font-size:16px; font-weight:bold; border:2px solid #000; padding:6px; margin:8px 0; } @media print { body { width:80mm; } @page { margin:0; size:80mm auto; } }</style></head><body>
            <div class="centro"><div class="titulo">Piccadely</div><div style="font-size:11px;">comanda de pedido</div></div>
            <div class="linea"></div>
            <div class="fila"><span><b>${p.numero}</b></span><span>${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "-"}</span></div>
            <div class="fila"><span>${p.franjaDisplay}</span><span>${p.zona || ""}</span></div>
            <div class="linea"></div>
            <div class="label">Cliente</div><div class="valor">${p.cliente}</div><div class="valor">${p.telefono}</div>
            <div class="label">Direccion</div><div class="valor">${p.direccion}${p.barrio ? ", "+p.barrio : ""}</div>
            <div class="linea"></div>
            <div class="label">Productos</div>${p.productos.split(", ").map(pr => `<div>- ${pr}</div>`).join("")}
            ${p.nota ? `<div class="linea"></div><div class="label">Nota</div><div style="font-style:italic;">${p.nota}</div>` : ""}
            <div class="linea"></div>
            <div class="fila"><span class="label">Medio de pago</span><span>${p.medioPago}</span></div>
            <div class="total">${p.total}</div>
            ${cobrar ? `<div class="cobrar">** COBRAR EN ENTREGA **</div>` : ""}
            <div class="linea"></div>
            <div class="fila"><span class="label">Repartidor</span><span>${repartidorActual}</span></div>
            <div style="text-align:center;font-size:11px;border:1px solid #000;padding:3px;">${estadoActual}</div>
            <div class="linea"></div>
            <div class="centro" style="font-size:10px;color:#888;">Piccadely - juntadely</div>
            <script>window.onload=function(){window.print();}<\/script></body></html>`);
          ventana.document.close();
        };

        try {
          if (typeof qz === "undefined") { fallback(); return; }

          qz.security.setCertificatePromise(resolve => resolve(cert));
          qz.security.setSignaturePromise(toSign => async (resolve, reject) => {
            try {
              const pemContents = privateKeyPem
                .replace("-----BEGIN PRIVATE KEY-----", "")
                .replace("-----END PRIVATE KEY-----", "")
                .replace(/\s/g, "");
              const binaryDer = atob(pemContents);
              const binaryArray = new Uint8Array(binaryDer.length);
              for (let i = 0; i < binaryDer.length; i++) binaryArray[i] = binaryDer.charCodeAt(i);
              const key = await window.crypto.subtle.importKey(
                "pkcs8", binaryArray.buffer,
                { name: "RSASSA-PKCS1-v1_5", hash: "SHA-1" },
                false, ["sign"]
              );
              const signature = await window.crypto.subtle.sign(
                "RSASSA-PKCS1-v1_5", key,
                new TextEncoder().encode(toSign)
              );
              resolve(btoa(String.fromCharCode(...new Uint8Array(signature))));
            } catch (e) { reject(e); }
          });

          if (!qz.websocket.isActive()) await qz.websocket.connect();
          const printers = await qz.printers.find();
          const nombreImpresora = 
      printers.find(pr => pr.includes("GP-80160")) ||
      printers.find(pr => pr.includes("POS-80") || pr.includes("POS-90") || pr.includes("Thermal") || pr.includes("Receipt")) ||
      printers.find(pr => pr.includes("POS Printer") || pr.includes("203DPI")) ||
      printers[0];
          const config = qz.configs.create(nombreImpresora, { encoding: "IBM858" });
          await qz.print(config, [{ type: "raw", format: "command", data: lineas.join("") }]);
        } catch (err) {
          console.error("Error QZ Tray:", err);
          fallback();
        }
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

      // Helper para el modal de email MP (reutilizable en todas las vistas)
      const modalEmailMPNode = pedidoEmailMP && (
        <ModalEmailMP
          pedido={pedidoEmailMP}
          onCerrar={() => setPedidoEmailMP(null)}
          onConfirmar={(emailNuevo) => {
            setPedidosManuales(prev =>
              prev.map(p => p.id === pedidoEmailMP.id ? { ...p, email: emailNuevo } : p)
            );
            setPedidoEmailMP(null);
          }}
        />
      );

      const Header = () => (
        <div style={s.header}>
          <div style={s.brand}>
            <img src="/Piccadely_Logotipo-Centrado-Negro.svg" alt="Piccadely" style={{ height: 36, objectFit: "contain" }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={s.fechaHoy}>{new Date().toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}</span>
            <div style={{ display: "flex", alignItems: "center", gap: 10, paddingLeft: 12, borderLeft: "1px solid #eee" }}>
              <div style={{ textAlign: "right", lineHeight: 1.2 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#333" }}>{usuario.nombre_completo}</div>
                <div style={{ fontSize: 11, color: "#888" }}>{ROL_LABELS[usuario.rol] || usuario.rol}</div>
              </div>
              <button style={s.btnLogout} onClick={() => { if (window.confirm("¿Cerrar sesión?")) cerrarSesion(); }} title="Cerrar sesión">⎋</button>
            </div>
            <div style={{ position: "relative" }} ref={menuRef}>
              <button style={s.hamburger} onClick={() => setMenuAbierto(m => !m)}>
                <div style={s.hambLine} /><div style={s.hambLine} /><div style={s.hambLine} />
              </button>
              {menuAbierto && (
                <div style={s.dropdown}>
    {usuario.rol === "admin" && <button style={s.dropItem} onClick={() => { setVista("usuarios"); setMenuAbierto(false); }}>👥 Usuarios</button>}
    {usuario.rol === "admin" && <button style={s.dropItem} onClick={() => { setVista("repartidores"); setMenuAbierto(false); }}>🚚 Repartidores</button>}
                  {usuario.rol === "admin" && (
      <button style={s.dropItem} onClick={async () => {
        setMenuAbierto(false);
        if (!window.confirm("¿Resincronizar TODOS los pedidos desde Tienda Nube? Puede tardar 1-2 minutos.")) return;
        try {
          const res = await axios.post(`${API}/api/admin/backfill-orders`);
          alert(`✅ Resincronización completa: ${res.data.totalSynced} pedidos actualizados en ${res.data.totalPages} páginas.`);
          window.location.reload();
        } catch (err) {
          alert("❌ Error: " + (err.response?.data?.error || err.message));
        }
      }}>🔄 Resincronizar TN</button>
    )}
                  <button style={s.dropItem} onClick={() => { setVista("caja"); setMenuAbierto(false); }}>💰 Caja</button>
                  <button style={s.dropItem} onClick={() => { setVista("finalizados"); setMenuAbierto(false); }}>📋 Pedidos finalizados</button>
                  <button style={s.dropItem} onClick={() => { setVista("reporteVentas"); setMenuAbierto(false); }}>📊 Reporte de ventas</button>
                  <button style={s.dropItem} onClick={() => { setVista("reporteProductos"); setMenuAbierto(false); }}>📦 Productos vendidos</button>
                  <button style={s.dropItem} onClick={() => { setVista("produccion"); setMenuAbierto(false); }}>🔧 Análisis de producción</button>
                  <button style={s.dropItem} onClick={() => { setVista("mapa"); setMenuAbierto(false); }}>🗺️ Mapa de pedidos</button>
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
    if (vista === "repartidores") {
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24, maxWidth: 500 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🚚 Repartidores</h2>
              </div>
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <input id="nuevoRep" style={{ ...s.formInput, flex: 1 }} placeholder="Nombre del nuevo repartidor" onKeyDown={e => { if (e.key === "Enter") document.getElementById("btnAddRep").click(); }} />
                  <button id="btnAddRep" style={{ fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "none", background: "#F68B32", color: "#fff", cursor: "pointer", fontWeight: 600 }}
                    onClick={async () => {
                      const input = document.getElementById("nuevoRep");
                      const nombre = input.value.trim();
                      if (!nombre) return;
                      try {
                        await axios.post(`${API}/api/repartidores`, { nombre });
                        input.value = "";
                        const res = await axios.get(`${API}/api/repartidores`);
                        setRepartidoresLista(res.data.map(r => r.nombre));
                      } catch (err) { alert("Error: " + (err.response?.data?.error || err.message)); }
                    }}>+ Agregar</button>
                </div>
                {repartidoresLista.map((nombre, i) => (
                  <div key={nombre} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f5f5f5" }}>
                    <span style={{ fontSize: 13, color: "#333", fontWeight: nombre === "Sin asignar" ? 400 : 500 }}>{nombre}</span>
                    {nombre !== "Sin asignar" && (
                      <button style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid #c0392b", background: "#fdecea", color: "#c0392b", cursor: "pointer" }}
                        onClick={async () => {
                          if (!window.confirm(`¿Eliminar a ${nombre}?`)) return;
                          try {
                            const resAll = await axios.get(`${API}/api/repartidores`);
                            const rep = resAll.data.find(r => r.nombre === nombre);
                            if (rep) await axios.delete(`${API}/api/repartidores/${rep.id}`);
                            const res = await axios.get(`${API}/api/repartidores`);
                            setRepartidoresLista(res.data.map(r => r.nombre));
                          } catch (err) { alert("Error: " + (err.response?.data?.error || err.message)); }
                        }}>✕ Eliminar</button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      }
      if (vista === "usuarios") {
        return <div style={s.wrap}><Header /><Usuarios onVolver={() => setVista("panel")} /></div>;
      }
      if (vista === "caja") {
        return <div style={s.wrap}><Header /><VistaCaja pedidosFinalizados={pedidosFinalizados} onVolver={() => setVista("panel")} usuario={usuario} /></div>;
      }

      if (vista === "reporteVentas") {
        const ventasFiltradas = pedidosFinalizados.filter(p => {
          const est = pedidosLocales[p.id]?.estado || p.estado;
          if (est === "Anulado") return false;
          if (rvDesde && p.fechaDisplay && p.fechaDisplay < rvDesde) return false;
          if (rvHasta && p.fechaDisplay && p.fechaDisplay > rvHasta) return false;
          if (rvMedio && p.medioPago !== rvMedio) return false;
          if (rvRepartidor && (pedidosLocales[p.id]?.repartidor || "Sin asignar") !== rvRepartidor) return false;
          return true;
        }).sort((a, b) => { if (!a.fechaDisplay) return 1; if (!b.fechaDisplay) return -1; return b.fechaDisplay.localeCompare(a.fechaDisplay); });
        const totalVentasRv = ventasFiltradas.reduce((acc, p) => acc + p.totalNum, 0);
        const porMedio = MEDIOS_PAGO.reduce((acc, m) => { acc[m] = ventasFiltradas.filter(p => p.medioPago === m).reduce((a, p) => a + p.totalNum, 0); return acc; }, {});
        const tag = fechaTagArchivo(rvDesde, rvHasta);
        const exportarVentasExcel = () => {
          const datos = ventasFiltradas.map(p => ({ "Nº": p.numero, "Cliente": p.cliente, "Productos": p.productos, "Medio de pago": p.medioPago, "Repartidor": pedidosLocales[p.id]?.repartidor || "Sin asignar", "Fecha": p.fechaDisplay || "", "Local": p.local, "Total": p.totalNum }));
          const resumen = MEDIOS_PAGO.filter(m => porMedio[m] > 0).map(m => ({ "Medio de pago": m, "Pedidos": ventasFiltradas.filter(p => p.medioPago === m).length, "Total": porMedio[m] }));
          resumen.push({ "Medio de pago": "TOTAL GENERAL", "Pedidos": ventasFiltradas.length, "Total": totalVentasRv });
          exportarExcel(`ventas_${tag}.xlsx`, [{ name: "Ventas", data: datos }, { name: "Resumen", data: resumen }]);
        };
        const exportarVentasPDF = () => {
          const filas = ventasFiltradas.map(p => [p.numero, p.cliente, p.productos.length > 50 ? p.productos.substring(0, 50) + "..." : p.productos, p.medioPago, p.fechaDisplay || "—", p.local, fmt(p.totalNum)]);
          const subt = (rvDesde || rvHasta) ? `Desde ${rvDesde || "inicio"} hasta ${rvHasta || "hoy"}` : "Todas las fechas";
          exportarPDF(`ventas_${tag}.pdf`, "Reporte de Ventas", ["Nº", "Cliente", "Productos", "Medio pago", "Fecha", "Local", "Total"], filas, `Total: ${fmt(totalVentasRv)}  ·  ${ventasFiltradas.length} pedidos`, subt);
        };
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>📊 Reporte de ventas</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rvDesde} onChange={e => setRvDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rvHasta} onChange={e => setRvHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={rvMedio} onChange={e => setRvMedio(e.target.value)}>
                    <option value="">Todos los medios</option>
                    {MEDIOS_PAGO.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select style={{ ...s.select, padding: "5px 8px" }} value={rvRepartidor} onChange={e => setRvRepartidor(e.target.value)}>
                    <option value="">Todos los repartidores</option>
                    {repartidoresLista.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {(rvDesde || rvHasta || rvMedio || rvRepartidor) && (
                    <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setRvDesde(""); setRvHasta(""); setRvMedio(""); setRvRepartidor(""); }}>✕ Limpiar</button>
                  )}
                  {ventasFiltradas.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarVentasExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarVentasPDF}>📄 PDF</button></>)}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                {MEDIOS_PAGO.filter(m => porMedio[m] > 0).map(m => (
                  <div key={m} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>{m}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>{fmt(porMedio[m])}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{ventasFiltradas.filter(p => p.medioPago === m).length} pedidos</div>
                  </div>
                ))}
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "#a8d5b5", marginBottom: 4 }}>TOTAL</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{fmt(totalVentasRv)}</div>
                  <div style={{ fontSize: 11, color: "#a8d5b5" }}>{ventasFiltradas.length} pedidos</div>
                </div>
              </div>
              <div style={s.lista}>
                <div style={s.cabecera}>
                  <span style={{ ...s.col, flex: 0.6 }}>Nº</span><span style={{ ...s.col, flex: 1.5 }}>Cliente</span>
                  <span style={{ ...s.col, flex: 1 }}>Productos</span><span style={{ ...s.col, flex: 0.8 }}>Medio de pago</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Fecha</span><span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Local</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "right" }}>Monto</span>
                </div>
                {ventasFiltradas.length === 0 && <div style={s.empty}>No hay ventas en ese rango.</div>}
                {ventasFiltradas.map(p => (
                  <div key={p.id} style={s.fila}>
                    <div style={{ ...s.filaTop, cursor: "default" }}>
                      <span style={{ ...s.cel, flex: 0.6 }}><span style={s.numero}>{p.numero}</span></span>
                      <span style={{ ...s.cel, flex: 1.5 }}>{p.cliente}</span>
                      <span style={{ ...s.cel, flex: 1, color: "#666" }}>{p.productos}</span>
                      <span style={{ ...s.cel, flex: 0.8 }}>{p.medioPago}</span>
                      <span style={{ ...s.cel, flex: 0.7, textAlign: "center", color: "#555" }}>{p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"short"}) : "—"}</span>
                      <span style={{ ...s.cel, flex: 0.7, textAlign: "center" }}><span style={{ fontSize: 11, background: "#eaf3de", color: "#27500a", padding: "2px 7px", borderRadius: 4 }}>{p.local}</span></span>
                      <span style={{ ...s.cel, flex: 0.7, textAlign: "right", fontWeight: 600 }}>{p.total}</span>
                    </div>
                  </div>
                ))}
                {ventasFiltradas.length > 0 && <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 14px", borderTop: "2px solid #eee", fontWeight: 700, fontSize: 14, color: "#F68B32" }}>Total: {fmt(totalVentasRv)}</div>}
              </div>
            </div>
          </div>
        );
      }

      if (vista === "reporteProductos") {
        const pedidosBase = pedidosFinalizados.filter(p => {
          const est = pedidosLocales[p.id]?.estado || p.estado;
          if (est === "Anulado") return false;
          if (rpDesde && p.fechaDisplay && p.fechaDisplay < rpDesde) return false;
          if (rpHasta && p.fechaDisplay && p.fechaDisplay > rpHasta) return false;
          return true;
        });
        const productosMap = {};
        pedidosBase.forEach(p => {
          p.productos.split(", ").forEach(item => {
            const match = item.match(/^(.+) x(\d+)$/);
            if (!match) return;
            const nombre = match[1].trim();
            const cantidad = Number(match[2]);
            if (!productosMap[nombre]) productosMap[nombre] = { nombre, cantidad: 0 };
            productosMap[nombre].cantidad += cantidad;
          });
        });
        const listaProductos = Object.values(productosMap).sort((a, b) => b.cantidad - a.cantidad);
        const totalUnidades = listaProductos.reduce((a, p) => a + p.cantidad, 0);
        const tagRp = fechaTagArchivo(rpDesde, rpHasta);
        const exportarProdExcel = () => {
          const datos = listaProductos.map((prod, i) => ({ "Ranking": i + 1, "Producto": prod.nombre, "Unidades vendidas": prod.cantidad, "% del total": totalUnidades > 0 ? `${((prod.cantidad / totalUnidades) * 100).toFixed(1)}%` : "0%" }));
          datos.push({ "Ranking": "", "Producto": "TOTAL", "Unidades vendidas": totalUnidades, "% del total": "100%" });
          exportarExcel(`productos_vendidos_${tagRp}.xlsx`, [{ name: "Productos", data: datos }]);
        };
        const exportarProdPDF = () => {
          const filas = listaProductos.map((prod, i) => [i + 1, prod.nombre, prod.cantidad, totalUnidades > 0 ? `${((prod.cantidad / totalUnidades) * 100).toFixed(1)}%` : "0%"]);
          const subt = (rpDesde || rpHasta) ? `Desde ${rpDesde || "inicio"} hasta ${rpHasta || "hoy"}` : "Todas las fechas";
          exportarPDF(`productos_vendidos_${tagRp}.pdf`, "Productos Vendidos", ["#", "Producto", "Unidades", "% del total"], filas, `Total: ${totalUnidades} unidades  ·  ${pedidosBase.length} pedidos`, subt);
        };
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>📦 Productos vendidos</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rpDesde} onChange={e => setRpDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rpHasta} onChange={e => setRpHasta(e.target.value)} />
                  {(rpDesde || rpHasta) && <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setRpDesde(""); setRpHasta(""); }}>✕ Limpiar</button>}
                  {listaProductos.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarProdExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarProdPDF}>📄 PDF</button></>)}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#a8d5b5", marginBottom: 4 }}>TOTAL UNIDADES</div><div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>{totalUnidades}</div><div style={{ fontSize: 11, color: "#a8d5b5" }}>{pedidosBase.length} pedidos</div></div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>PRODUCTOS DISTINTOS</div><div style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{listaProductos.length}</div></div>
              </div>
              <div style={s.lista}>
                <div style={s.cabecera}>
                  <span style={{ ...s.col, flex: 0.5, textAlign: "center" }}>#</span><span style={{ ...s.col, flex: 3 }}>Producto</span>
                  <span style={{ ...s.col, flex: 1, textAlign: "center" }}>Unidades vendidas</span><span style={{ ...s.col, flex: 1, textAlign: "center" }}>% del total</span>
                </div>
                {listaProductos.length === 0 && <div style={s.empty}>No hay ventas en ese rango.</div>}
                {listaProductos.map((prod, i) => (
                  <div key={prod.nombre} style={s.fila}>
                    <div style={{ ...s.filaTop, cursor: "default" }}>
                      <span style={{ ...s.cel, flex: 0.5, textAlign: "center", color: "#aaa", fontWeight: 600 }}>{i + 1}</span>
                      <span style={{ ...s.cel, flex: 3, fontWeight: i < 3 ? 600 : 400 }}>{i === 0 && <span style={{ marginRight: 6 }}>🥇</span>}{i === 1 && <span style={{ marginRight: 6 }}>🥈</span>}{i === 2 && <span style={{ marginRight: 6 }}>🥉</span>}{prod.nombre}</span>
                      <span style={{ ...s.cel, flex: 1, textAlign: "center", fontWeight: 600, color: "#F68B32", fontSize: 14 }}>{prod.cantidad}</span>
                      <span style={{ ...s.cel, flex: 1, textAlign: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center" }}>
                          <div style={{ width: 80, height: 6, background: "#eee", borderRadius: 3, overflow: "hidden" }}><div style={{ width: `${Math.round((prod.cantidad / listaProductos[0].cantidad) * 100)}%`, height: "100%", background: "#F68B32", borderRadius: 3 }} /></div>
                          <span style={{ fontSize: 11, color: "#888" }}>{Math.round((prod.cantidad / totalUnidades) * 100)}%</span>
                        </div>
                      </span>
                    </div>
                  </div>
                ))}
                {listaProductos.length > 0 && <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 14px", borderTop: "2px solid #eee", fontWeight: 700, fontSize: 14, color: "#F68B32" }}>Total unidades: {totalUnidades}</div>}
              </div>
            </div>
          </div>
        );
      }

      if (vista === "produccion") {
        const pedidosProduccion = pedidosProcesados.filter(p => {
          const est = pedidosLocales[p.id]?.estado || p.estado;
          if (est === "Entregado" || est === "Anulado") return false;
          if (p.fechaDisplay !== prodFecha) return false;
          if (prodLocal !== "todos" && p.local !== prodLocal) return false;
          return true;
        });
        const productosMap = {};
        pedidosProduccion.forEach(p => {
          p.productos.split(", ").forEach(item => {
            const match = item.match(/^(.+) x(\d+)$/);
            if (!match) return;
            const nombre = match[1].trim();
            const cantidad = Number(match[2]);
            if (!productosMap[nombre]) productosMap[nombre] = { nombre, cantidad: 0, pedidos: [] };
            productosMap[nombre].cantidad += cantidad;
            productosMap[nombre].pedidos.push({ numero: p.numero, cliente: p.cliente, cantidad, franja: p.franjaDisplay });
          });
        });
        const listaProduccion = Object.values(productosMap).sort((a, b) => b.cantidad - a.cantidad);
        const totalUnidades = listaProduccion.reduce((a, p) => a + p.cantidad, 0);
        const localTag = prodLocal === "todos" ? "todos" : prodLocal.toLowerCase().replace(/[.\s]/g, "");
        const localLabel2 = prodLocal === "todos" ? "Ambos locales" : prodLocal;
        const exportarProduccionExcel = () => {
          const datos = listaProduccion.map(prod => ({ "Producto": prod.nombre, "Cantidad a producir": prod.cantidad }));
          datos.push({ "Producto": "TOTAL", "Cantidad a producir": totalUnidades });
          exportarExcel(`produccion_${prodFecha}_${localTag}.xlsx`, [{ name: "Producción", data: datos }]);
        };
        const exportarProduccionPDF = () => {
          const filas = listaProduccion.map(prod => [prod.nombre, prod.cantidad]);
          const fechaLabel = new Date(prodFecha + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" });
          exportarPDF(`produccion_${prodFecha}_${localTag}.pdf`, "Análisis de Producción", ["Producto", "Cantidad"], filas, `Total a producir: ${totalUnidades} unidades  ·  ${pedidosProduccion.length} pedidos`, `Fecha: ${fechaLabel}  ·  Local: ${localLabel2}`);
        };
        const fechasDisponibles = [...new Set(pedidosProcesados.filter(p => { const est = pedidosLocales[p.id]?.estado || p.estado; return est !== "Entregado" && est !== "Anulado" && p.fechaDisplay && p.fechaDisplay >= HOY; }).map(p => p.fechaDisplay))].sort();
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🔧 Análisis de producción</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Fecha</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={prodFecha} onChange={e => setProdFecha(e.target.value)} />
                  {fechasDisponibles.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {fechasDisponibles.map(f => (
                        <button key={f} onClick={() => setProdFecha(f)}
                          style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: prodFecha === f ? "#F68B32" : "#ddd", background: prodFecha === f ? "#F68B32" : "#fff", color: prodFecha === f ? "#fff" : "#555" }}>
                          {new Date(f + "T12:00:00").toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" })}
                        </button>
                      ))}
                    </div>
                  )}
                  {listaProduccion.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarProduccionExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarProduccionPDF}>📄 PDF</button></>)}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Sucursal:</span>
                {[{ id: "todos", label: "🏭 Ambos" }, { id: "A. Thomas", label: "📍 A. Thomas" }, { id: "French", label: "📍 French" }].map(opt => (
                  <button key={opt.id} onClick={() => setProdLocal(opt.id)}
                    style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: prodLocal === opt.id ? "#F68B32" : "#ddd", background: prodLocal === opt.id ? "#F68B32" : "#fff", color: prodLocal === opt.id ? "#fff" : "#555", fontWeight: prodLocal === opt.id ? 600 : 400 }}>
                    {opt.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#a8d5b5", marginBottom: 4 }}>UNIDADES A PRODUCIR</div><div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>{totalUnidades}</div><div style={{ fontSize: 11, color: "#a8d5b5" }}>{pedidosProduccion.length} pedidos</div></div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>PRODUCTOS DISTINTOS</div><div style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{listaProduccion.length}</div></div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>FECHA</div><div style={{ fontSize: 14, fontWeight: 700, color: "#333", textTransform: "capitalize" }}>{new Date(prodFecha + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })}</div></div>
              </div>
              {pedidosProduccion.length === 0 ? (
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 40, textAlign: "center", color: "#aaa", fontSize: 13 }}>No hay pedidos activos para esta fecha.</div>
              ) : (
                <div style={s.lista}>
                  <div style={s.cabecera}>
                    <span style={{ ...s.col, flex: 0.5, textAlign: "center" }}>#</span><span style={{ ...s.col, flex: 3 }}>Producto</span>
                    <span style={{ ...s.col, flex: 0.8, textAlign: "center" }}>Total</span><span style={{ ...s.col, flex: 3 }}>Detalle por pedido</span>
                  </div>
                  {listaProduccion.map((prod, i) => (
                    <div key={prod.nombre} style={s.fila}>
                      <div style={{ ...s.filaTop, cursor: "default", alignItems: "flex-start", paddingTop: 10, paddingBottom: 10 }}>
                        <span style={{ ...s.cel, flex: 0.5, textAlign: "center", color: "#aaa", fontWeight: 600, paddingTop: 2 }}>{i + 1}</span>
                        <span style={{ ...s.cel, flex: 3, fontWeight: 600, paddingTop: 2 }}>{prod.nombre}</span>
                        <span style={{ ...s.cel, flex: 0.8, textAlign: "center" }}><span style={{ fontSize: 18, fontWeight: 700, color: "#F68B32" }}>{prod.cantidad}</span></span>
                        <div style={{ flex: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
                          {prod.pedidos.map((pd, j) => (
                            <span key={j} style={{ fontSize: 11, background: "#f0f0ee", color: "#555", padding: "2px 8px", borderRadius: 4, whiteSpace: "nowrap" }}>{pd.numero} · {pd.cliente} · x{pd.cantidad} · {pd.franja}</span>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 14px", borderTop: "2px solid #eee", fontWeight: 700, fontSize: 14, color: "#F68B32" }}>Total a producir: {totalUnidades} unidades</div>
                </div>
              )}
            </div>
          </div>
        );
      }
    if (vista === "mapa") {
        return <div style={s.wrap}><Header /><VistaMapa onVolver={() => setVista("panel")} /></div>;
      }
      if (vista === "finalizados") {
        const finalizadosOrdenados = [...pedidosFinalizados]
          .filter(p => {
            if (filtroFinDesde && p.fechaDisplay && p.fechaDisplay < filtroFinDesde) return false;
            if (filtroFinHasta && p.fechaDisplay && p.fechaDisplay > filtroFinHasta) return false;
            if (filtroRepartidor && (pedidosLocales[p.id]?.repartidor || "Sin asignar") !== filtroRepartidor) return false;
            return true;
          })
          .sort((a, b) => { if (!a.fechaDisplay) return 1; if (!b.fechaDisplay) return -1; return b.fechaDisplay.localeCompare(a.fechaDisplay); });
        const entregados = finalizadosOrdenados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "Entregado");
        const anulados = finalizadosOrdenados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "Anulado");
        const listaMostrada = tabFin === "entregados" ? entregados : anulados;
        const tagFin = fechaTagArchivo(filtroFinDesde, filtroFinHasta);
        const exportarFinalizadosExcel = () => {
         const datos = listaMostrada.map(p => ({ "Nº": p.numero, "Cliente": p.cliente, "Email": p.email || "", "Teléfono": p.telefono, "Dirección": p.direccion + (p.barrio ? `, ${p.barrio}` : ""), "Productos": p.productos, "Medio de pago": p.medioPago, "Total": p.totalNum, "Fecha": p.fechaDisplay || "", "Local": p.local, "Factura": facturasMap[String(p.id)] || "", "Estado": pedidosLocales[p.id]?.estado || p.estado, "Repartidor": pedidosLocales[p.id]?.repartidor || "Sin asignar" }));
          exportarExcel(`pedidos_${tabFin}_${tagFin}.xlsx`, [{ name: tabFin === "entregados" ? "Entregados" : "Anulados", data: datos }]);
        };
        const exportarFinalizadosPDF = () => {
          const filas = listaMostrada.map(p => [p.numero, p.cliente, p.telefono, (p.productos.length > 40 ? p.productos.substring(0, 40) + "..." : p.productos), p.medioPago, fmt(p.totalNum), p.fechaDisplay || "—", p.local, facturasMap[String(p.id)] || "—"]);
          const totalSum = listaMostrada.reduce((a, p) => a + p.totalNum, 0);
          const subt = (filtroFinDesde || filtroFinHasta) ? `Desde ${filtroFinDesde || "inicio"} hasta ${filtroFinHasta || "hoy"}` : "Todas las fechas";
          exportarPDF(`pedidos_${tabFin}_${tagFin}.pdf`, tabFin === "entregados" ? "Pedidos Entregados" : "Pedidos Anulados", ["Nº", "Cliente", "Teléfono", "Productos", "Pago", "Total", "Fecha", "Local", "Factura"], filas, `Total: ${fmt(listaMostrada.reduce((a, p) => a + p.totalNum, 0))}  ·  ${listaMostrada.length} pedidos`, subt);
        };
        return (
          <div style={s.wrap}>
            <Header />
            {facturando && <ModalFacturacion p={facturando} onCerrar={cerrarModal} />}
            {modalEmailMPNode}
            <div style={{ padding: "24px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>📋 Pedidos finalizados</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={filtroFinDesde} onChange={e => setFiltroFinDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={filtroFinHasta} onChange={e => setFiltroFinHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={filtroRepartidor} onChange={e => setFiltroRepartidor(e.target.value)}>
                    <option value="">Todos los repartidores</option>
                    {repartidoresLista.map(r => <option key={r} value={r}>{r}</option>)} 
                  </select>
                  {(filtroFinDesde || filtroFinHasta || filtroRepartidor) && <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setFiltroFinDesde(""); setFiltroFinHasta(""); setFiltroRepartidor(""); }}>✕ Limpiar</button>}
                  {listaMostrada.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarFinalizadosExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarFinalizadosPDF}>📄 PDF</button></>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={() => setTabFin("entregados")} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: tabFin === "entregados" ? "#F68B32" : "#ddd", background: tabFin === "entregados" ? "#F68B32" : "#fff", color: tabFin === "entregados" ? "#fff" : "#555", fontWeight: tabFin === "entregados" ? 600 : 400 }}>✅ Entregados ({entregados.length})</button>
                <button onClick={() => setTabFin("anulados")} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: tabFin === "anulados" ? "#c0392b" : "#ddd", background: tabFin === "anulados" ? "#c0392b" : "#fff", color: tabFin === "anulados" ? "#fff" : "#555", fontWeight: tabFin === "anulados" ? 600 : 400 }}>🚫 Anulados ({anulados.length})</button>
              </div>
              <div style={s.lista}>
                <div style={s.cabecera}>
                  <span style={{ ...s.col, flex: 0.6 }}>Nº</span><span style={{ ...s.col, flex: 1.2 }}>Cliente</span>
                  <span style={{ ...s.col, flex: 1 }}>Teléfono</span><span style={{ ...s.col, flex: 1.5 }}>Dirección</span>
                  <span style={{ ...s.col, flex: 1 }}>Productos</span><span style={{ ...s.col, flex: 0.8 }}>Medio pago</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "right" }}>Total</span><span style={{ ...s.col, flex: 0.8, textAlign: "center" }}>Fecha</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Local</span>
                  <span style={{ ...s.col, flex: 1.3 }}>Factura</span>
                </div>
                {listaMostrada.length === 0 && <div style={s.empty}>No hay pedidos en esta sección.</div>}
                {listaMostrada.map(p => (
                  <div key={p.id} style={{ ...s.fila, ...(expandido === p.id ? s.filaAbierta : {}) }}>
                    <div style={s.filaTop} onClick={() => toggleExpandido(p.id)}>
                      <span style={{ ...s.cel, flex: 0.6 }}><span style={s.numero}>{p.numero}</span></span>
                      <span style={{ ...s.cel, flex: 1.2 }}>{p.cliente}{p.esManual && <span style={{ ...s.cobrarBadge, background: "#7c3aed", marginLeft: 6 }}>MANUAL</span>}</span>
                      <span style={{ ...s.cel, flex: 1, color: "#555" }}>{p.telefono}</span>
                      <span style={{ ...s.cel, flex: 1.5 }}>{p.direccion}</span>
                      <span style={{ ...s.cel, flex: 1, color: "#666" }}>{p.productos}</span>
                      <span style={{ ...s.cel, flex: 0.8 }}>{p.medioPago}</span>
                      <span style={{ ...s.cel, flex: 0.7, textAlign: "right", fontWeight: 600 }}>{p.total}</span>
                      <span style={{ ...s.cel, flex: 0.8, textAlign: "center", color: "#555" }}>{p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"short"}) : "—"}</span>
                      <span style={{ ...s.cel, flex: 0.7, textAlign: "center" }}><span style={{ fontSize: 11, background: "#eaf3de", color: "#27500a", padding: "2px 7px", borderRadius: 4 }}>{p.local}</span></span>
                      <span style={{ ...s.cel, flex: 1.3, fontSize: 11, color: "#F68B32", fontWeight: 600 }}>{facturasMap[String(p.id)] || "—"}</span>
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
                         <div style={s.detalleBloque}><div style={s.detalleLabel}>Email</div><div style={s.detalleVal}>{p.email || "—"}</div></div>
                          <div style={s.detalleBloque}>
                            <div style={s.detalleLabel}>Medio de pago</div>
                            <select style={s.inputField} value={p.medioPago}
                              onChange={e => { e.stopPropagation(); corregirMedioFinalizado(p, e.target.value); }}
                              onClick={e => e.stopPropagation()}>
                              {MEDIOS_PAGO.map(m => <option key={m}>{m}</option>)}
                            </select>
                          </div>
                          <div style={s.detalleBloque}>
                            <div style={s.detalleLabel}>Cobrar en entrega</div>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!pedidosLocales[p.id]?.cobrar} onChange={e => { e.stopPropagation(); cambiarCobrar(p.id, e.target.checked); }} onClick={e => e.stopPropagation()} />
                              <span style={{ fontSize: 12, color: pedidosLocales[p.id]?.cobrar ? "#c0392b" : "#888" }}>{pedidosLocales[p.id]?.cobrar ? "⚠️ COBRAR" : "Ya cobrado"}</span>
                            </label>
                          </div>
                        {p.transaccionMP && <div style={s.detalleBloque}><div style={s.detalleLabel}>ID Transacción MP</div><div style={{ ...s.detalleVal, fontFamily: "monospace", fontSize: 12 }}>{p.transaccionMP}</div></div>}
                       <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Código MKP</div>
                                <InputBlur style={s.inputField} initialValue={p.codigoPago || ""} placeholder="MP, Rappi, PedidosYa..."
                                  onCommit={v => actualizarDato(p, "codigoPago", v)} onClick={e => e.stopPropagation()} />
                              </div>
                        </div>
                        <AuditoriaInline pedidoId={String(p.id)} />
                        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                          <button style={s.btnImprimir} onClick={e => { e.stopPropagation(); imprimirComanda(p); }}>
                            🖨️ Imprimir comanda {comandasImpresas[p.id] ? <span style={{ marginLeft: 4, background: "#f39c12", color: "#fff", borderRadius: 99, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>{comandasImpresas[p.id]}</span> : null}
                          </button>
                          <button style={{ ...s.btnImprimir, borderColor: "#0c447c", color: "#0c447c", background: "#e6f1fb" }}
                            onClick={e => reabrirPedido(p, e)}>
                            🔄 Reabrir pedido
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
                  <div style={{ background: "#eaf3de", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 16px", marginBottom: 16, color: "#27500a", fontWeight: 600, fontSize: 13 }}>
                    ✅ Pedido creado correctamente
                  </div>
                )}
                <div style={s.formCard}>
                  <div style={s.formCardTitle}>👤 Datos del cliente</div>
                  <div style={s.formGrid}>
                    <div style={s.formBloque}><label style={s.formLabel}>Nombre *</label><input style={s.formInput} value={form.cliente} onChange={e => setForm(f => ({...f, cliente: e.target.value}))} placeholder="Nombre completo" /></div>
                    <div style={s.formBloque}><label style={s.formLabel}>Teléfono</label><input style={s.formInput} value={form.telefono} onChange={e => setForm(f => ({...f, telefono: e.target.value}))} placeholder="+54 11..." /></div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Email (opcional, se envía confirmación automática)</label><input type="email" style={s.formInput} value={form.email || ""} onChange={e => setForm(f => ({...f, email: e.target.value}))} placeholder="cliente@ejemplo.com" /></div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Dirección</label><input style={s.formInput} value={form.direccion} onChange={e => setForm(f => ({...f, direccion: e.target.value}))} placeholder="Calle y número" /></div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Entre calles</label><input style={s.formInput} value={form.entreCalles || ""} onChange={e => setForm(f => ({...f, entreCalles: e.target.value}))} placeholder="ej: Entre Gorriti y Cabrera" /></div>
                    <div style={s.formBloque}><label style={s.formLabel}>Barrio</label><input style={s.formInput} value={form.barrio} onChange={e => setForm(f => ({...f, barrio: e.target.value}))} placeholder="Barrio" /></div>
                    <div style={s.formBloque}><label style={s.formLabel}>Zona de entrega</label><input style={s.formInput} value={form.zona} onChange={e => setForm(f => ({...f, zona: e.target.value}))} placeholder="ej: CABA, Zona Norte 1..." /></div>
                    <div style={s.formBloque}><label style={s.formLabel}>Fecha de entrega</label><input type="date" style={s.formInput} value={form.fecha} onChange={e => setForm(f => ({...f, fecha: e.target.value}))} /></div>
    <div style={s.formBloque}><label style={s.formLabel}>Horario</label><div style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="time" style={{ ...s.formInput, flex: 1 }} value={form.franjaInicio} onChange={e => setForm(f => ({...f, franjaInicio: e.target.value}))} /><span style={{ color: "#888", fontSize: 14 }}>–</span><input type="time" style={{ ...s.formInput, flex: 1 }} value={form.franjaFin} onChange={e => setForm(f => ({...f, franjaFin: e.target.value}))} /></div></div>
                    <div style={s.formBloque}><label style={s.formLabel}>Medio de pago</label><select style={s.formInput} value={form.medioPago} onChange={e => { const m = e.target.value; setForm(f => ({...f, medioPago: m, cobrar: ["Efectivo", "Pedidos Ya Efectivo", "Mercado Pago", "Rappi", "Pedidos Ya"].includes(m)})); }}>{MEDIOS_PAGO.map(m => <option key={m}>{m}</option>)}</select></div>
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
                      <span style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>${totalCarrito.toLocaleString("es-AR")}</span>
                    </div>
                  </>
                )}
                <div style={{ borderTop: "1px solid #eee", paddingTop: 12, marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 8 }}>+ Producto variable</div>
                  <input style={{ ...s.formInput, marginBottom: 6 }} placeholder="Nombre del producto" value={varNombre} onChange={e => setVarNombre(e.target.value)} />
                  <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                    <input type="number" style={{ ...s.formInput, flex: 1 }} placeholder="Precio" value={varPrecio} onChange={e => setVarPrecio(e.target.value)} />
                    <input type="number" style={{ ...s.formInput, width: 60 }} placeholder="Cant" value={varCantidad} onChange={e => setVarCantidad(e.target.value)} />
                  </div>
                  <button style={{ ...s.btnAgregar, width: "100%", padding: "7px", fontSize: 12 }}
                    onClick={() => {
                      if (!varNombre || !varPrecio) return;
                      const variantId = `var-${Date.now()}`;
                      setCarrito(prev => [...prev, { id: variantId, variantId, nombre: varNombre, precio: Number(varPrecio), cantidad: Number(varCantidad) || 1, esVariable: true }]);
                      setVarNombre(""); setVarPrecio(""); setVarCantidad("1");
                    }}>
                    + Agregar variable
                  </button>
                </div>
                <button style={{ ...s.btnCrear, opacity: (!form.cliente || carrito.length === 0) ? 0.4 : 1, marginTop: 12 }} disabled={!form.cliente || carrito.length === 0} onClick={crearPedido}>✅ Crear pedido</button>
              </div>
            </div>
          </div>
        );
      }

      // ─── PANEL PRINCIPAL (tabs activas) ──────────────────────────────
      return (
        <div style={s.wrap}>
          {facturando && <ModalFacturacion p={facturando} onCerrar={cerrarModal} />}
          {editandoProductos && productos.length > 0 && (
            <ModalEditarProductos
              p={editandoProductos}
              productos={productos}
              categorias={categorias}
              onCerrar={() => setEditandoProductos(null)}
              onGuardar={(id, productosStr, totalNum) => {
                setProductosOverride(prev => ({ ...prev, [String(id)]: { productos: productosStr, total_num: totalNum } }));
                setEditandoProductos(null);
              }}
            />
          )}
          {modalEmailMPNode}
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
                    const ec = ESTADO_COLORS[estadoActual] || { bg: "#f0f0e8", text: "#555" };
                    const ahora = new Date();
                    const fechaPedido = p.fechaDisplay || "";
                    const franjaMatch = (p.franjaDisplay || "").match(/(\d{1,2}):(\d{2})/);
                    const horaInicio = franjaMatch ? new Date(`${fechaPedido}T${String(franjaMatch[1]).padStart(2,"0")}:${franjaMatch[2]}:00`) : null;
                    const minutosVencido = horaInicio ? Math.floor((ahora - horaInicio) / 60000) : 0;
                    const estaProximo = horaInicio && ahora >= new Date(horaInicio.getTime() - 60 * 60000) && ahora < horaInicio && fechaPedido === HOY && estadoActual !== "En camino" && estadoActual !== "Entregado";
const estaVencido = horaInicio && ahora >= horaInicio && fechaPedido === HOY && estadoActual !== "En camino" && estadoActual !== "Entregado";
                    return (
                      <div key={p.id} style={{ ...s.fila, ...(abierto ? s.filaAbierta : {}), ...(estaVencido ? { background: "#f5b7b1", borderLeft: "4px solid #922b21" } : estaProximo ? { background: "#fdecea", borderLeft: "4px solid #c0392b" } : {}) }}>
                        <div style={s.filaTop} onClick={() => toggleExpandido(p.id)}>
                          <span style={{ ...s.cel, flex: 1.2 }}>
                            <span style={s.numero}>{p.numero}</span>{!comandasImpresas[p.id] && <span style={s.nuevoBadge}>● NUEVO</span>} {p.cliente}
                            {cobrar && <span style={s.cobrarBadge}>COBRAR</span>}
                            {p.esManual && <span style={{ ...s.cobrarBadge, background: "#7c3aed" }}>MANUAL</span>}
                            {productosOverride[String(p.id)] && <span style={{ ...s.cobrarBadge, background: "#7c3aed" }}>EDITADO</span>}
                            {p.esFacturaA && <span style={{ ...s.cobrarBadge, background: "#009ee3" }}>FACTURA A</span>}
                          </span>
                          <span style={{ ...s.cel, flex: 1, color: "#555" }}>{p.telefono}</span>
                          <span style={{ ...s.cel, flex: 2 }}>{p.direccion}</span>
                          <span style={{ ...s.cel, flex: 1, color: "#666" }}>{p.barrio}</span>
                          <span style={{ ...s.cel, flex: 1.2 }}><span style={s.zonaTag}>{p.zona}</span></span>
                          <span style={{ ...s.cel, flex: 0.8, textAlign: "right", fontWeight: 600 }}>{p.total}</span>
                          <span style={{ ...s.cel, flex: 1, textAlign: "center", color: "#555" }}>{p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"short"}) : "—"}</span>
                          <span style={{ ...s.cel, flex: 0.9, textAlign: "center" }}><span style={s.franjaTag}>{p.franjaDisplay}</span></span>
                          <span style={{ ...s.cel, flex: 0.8, textAlign: "center" }}><span style={{ ...s.estadoTag, background: ec.bg, color: ec.text }}>{estadoActual}</span></span>
                          <span style={s.chevron}>{abierto ? "▲" : "▼"}</span>
                        </div>
                        {abierto && (
                          <div style={s.detalle}>
                            {/* DATOS EDITABLES */}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#F68B32", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                              📋 Datos del pedido <span style={{ color: "#aaa", fontWeight: 400 }}>(guardado automático al salir del campo)</span>
                            </div>
                            <div style={{ ...s.detalleGrid, marginBottom: 14 }}>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Cliente</div>
                                <InputBlur style={s.inputField} initialValue={p.cliente} placeholder="Nombre"
                                  onCommit={v => actualizarDato(p, "cliente", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Teléfono</div>
                                <InputBlur style={s.inputField} initialValue={p.telefono} placeholder="Teléfono"
                                  onCommit={v => actualizarDato(p, "telefono", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Dirección</div>
                                <InputBlur style={s.inputField} initialValue={p.direccion} placeholder="Dirección"
                                  onCommit={v => actualizarDato(p, "direccion", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Barrio</div>
                                <InputBlur style={s.inputField} initialValue={p.barrio} placeholder="Barrio"
                                  onCommit={v => actualizarDato(p, "barrio", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Zona</div>
                                <InputBlur style={s.inputField} initialValue={p.zona} placeholder="Zona"
                                  onCommit={v => actualizarDato(p, "zona", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Email</div>
                                <InputBlur style={s.inputField} initialValue={p.email || ""} placeholder="cliente@ejemplo.com"
                                  onCommit={v => actualizarDato(p, "email", v)} onClick={e => e.stopPropagation()} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Medio de pago</div>
                                <select style={s.inputField} value={p.medioPago}
                                  onChange={e => { e.stopPropagation(); actualizarDato(p, "medioPago", e.target.value); }}
                                  onClick={e => e.stopPropagation()}>
                                  {MEDIOS_PAGO.map(m => <option key={m}>{m}</option>)}
                                </select>
                              </div>
                              <div style={{ ...s.detalleBloque, gridColumn: "span 2" }}>
                                <div style={s.detalleLabel}>Nota</div>
                                <TextareaBlur
                                  style={{ ...s.inputField, height: 56, resize: "vertical", width: "100%", boxSizing: "border-box" }}
                                  initialValue={p.nota || ""} placeholder="Nota del pedido..."
                                  onCommit={v => actualizarDato(p, "nota", v)} />
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Productos</div>
                                <div style={s.detalleVal}>{p.productos}</div>
                              </div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Pago</div>
                                <div style={{ ...s.detalleVal, color: p.pago === "Pagado" ? "#F68B32" : "#c0392b", fontWeight: 600 }}>{p.pago}</div>
                              </div>
                              {p.transaccionMP && <div style={s.detalleBloque}><div style={s.detalleLabel}>ID Transacción MP</div><div style={{ ...s.detalleVal, fontFamily: "monospace", fontSize: 12 }}>{p.transaccionMP}</div></div>}
<div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Código MKP</div>
                                <InputBlur style={s.inputField} initialValue={p.codigoPago || ""} placeholder="MP, Rappi, PedidosYa..."
                                  onCommit={v => actualizarDato(p, "codigoPago", v)} onClick={e => e.stopPropagation()} />
                              </div>                            </div>
                            {/* OPERACIONES */}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#555", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8, borderTop: "1px solid #eee", paddingTop: 10 }}>⚙️ Operaciones</div>
                            <div style={s.detalleGrid}>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Cobrar en entrega</div>
                                <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                                  <input type="checkbox" checked={!!cobrar} onChange={e => cambiarCobrar(p.id, e.target.checked)} onClick={e => e.stopPropagation()} />
                                  <span style={{ fontSize: 12, color: cobrar ? "#c0392b" : "#888", fontWeight: cobrar ? 600 : 400 }}>{cobrar ? "⚠️ COBRAR" : "Ya cobrado"}</span>
                                </label>
                              </div>
                              <div style={s.detalleBloque}><div style={s.detalleLabel}>Repartidor</div><select style={s.inputField} value={repartidorActual} onChange={e => cambiarRepartidor(p.id, e.target.value)}>{repartidoresLista.map(r => <option key={r}>{r}</option>)}</select></div>
                              <div style={s.detalleBloque}>
                                <div style={s.detalleLabel}>Estado</div>
                                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                  <span style={{ ...s.estadoTag, background: ec.bg, color: ec.text }}>{estadoActual}</span>
                                  {estadoActual !== "Entregado" && <button style={s.btnEstado} onClick={e => cambiarEstado(p, e)}>→ {nextEstado(estadoActual)}</button>}
                                </div>
                              </div>
                              <div style={s.detalleBloque}><div style={s.detalleLabel}>Fecha de entrega</div><InputBlur type="date" style={s.inputField} initialValue={fechaManual} onCommit={v => { actualizarLocalSinGuardar(p.id, { fechaManual: v }); guardarLocalEnDB(p.id); }} onClick={e => e.stopPropagation()} /></div>
                              <div style={s.detalleBloque}><div style={s.detalleLabel}>Horario de entrega</div><InputBlur type="text" placeholder="ej: 14:00 – 16:00" style={s.inputField} initialValue={franjaManual} onCommit={v => { actualizarLocalSinGuardar(p.id, { franjaManual: v }); guardarLocalEnDB(p.id); }} onClick={e => e.stopPropagation()} /></div>
                              <div style={s.detalleBloque}><div style={s.detalleLabel}>Mover a sección</div><select style={s.inputField} value={tabActual} onChange={e => cambiarTab(p.id, e.target.value)}>{TABS.filter(t => t.id !== "nuevo").map(t => <option key={t.id} value={t.id}>{t.label.replace(/🏪|🚚/g, "").trim()}</option>)}</select></div>
                            </div>
                            <AuditoriaInline pedidoId={String(p.id)} />
                            <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                              <button style={s.btnImprimir} onClick={e => { e.stopPropagation(); imprimirComanda(p); }}>
                                🖨️ Imprimir comanda {comandasImpresas[p.id] ? <span style={{ marginLeft: 4, background: "#f39c12", color: "#fff", borderRadius: 99, fontSize: 10, padding: "1px 6px", fontWeight: 700 }}>{comandasImpresas[p.id]}</span> : null}
                              </button>
                              <button style={{ ...s.btnImprimir, borderColor: "#7c3aed", color: "#7c3aed", background: "#f5f3ff" }}
                                onClick={async e => { e.stopPropagation(); await asegurarCatalogo(); setEditandoProductos(p); }}>
                                ✏️ Editar productos
                              </button>
                              <BtnFacturar p={p} version={facturaVersion} onAbrir={setFacturando} />
                              <BtnPagoMP p={p} onEmailRequerido={setPedidoEmailMP} />
                              <button style={{ ...s.btnImprimir, borderColor: "#c0392b", color: "#c0392b", background: "#fdecea" }}
                                onClick={e => anularPedido(p, e)}>
                                🚫 Anular pedido
                              </button>
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

    // ─── WRAPPER DE AUTENTICACIÓN ────────────────────────────────────────
    export default function App() {
      const [usuario, setUsuario] = useState(getUsuarioGuardado());
      const [validandoSesion, setValidandoSesion] = useState(true);

      useEffect(() => {
        validarSesion().then(user => { setUsuario(user); setValidandoSesion(false); });
      }, []);

      if (validandoSesion) {
        return (
          <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", color: "#888", fontSize: 14, background: "#f7f7f5" }}>
            Validando sesión...
          </div>
        );
      }

      if (!usuario) return <Login onLogin={setUsuario} />;
      return (
        <>
          <PanelApp usuario={usuario} />
          <AgenteIA />
        </>
      );
    }

    // ─── ESTILOS ─────────────────────────────────────────────────────────
    const s = {
      wrap: { fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f7f7f5" },
      loading: { padding: 40, textAlign: "center", color: "#666" },
      error: { padding: 40, textAlign: "center", color: "red" },
      header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #eee" },
      brand: { display: "flex", alignItems: "center", gap: 8 },
      fechaHoy: { fontSize: 13, color: "#888", textTransform: "capitalize" },
      btnLogout: { fontSize: 14, padding: "5px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#888" },
      hamburger: { width: 32, height: 32, border: "1px solid #ddd", borderRadius: 6, background: "#fff", cursor: "pointer", display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 4, padding: 0 },
      hambLine: { width: 16, height: 2, background: "#555", borderRadius: 1 },
      dropdown: { position: "absolute", top: "100%", right: 0, marginTop: 6, background: "#fff", border: "1px solid #eee", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.08)", minWidth: 220, zIndex: 100, overflow: "hidden" },
      dropItem: { display: "block", width: "100%", textAlign: "left", padding: "10px 14px", border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "#333", borderBottom: "1px solid #f5f5f5" },
      btnVolver: { fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" },
      tabs: { display: "flex", padding: "0 24px", background: "#fff", borderBottom: "1px solid #eee", gap: 4 },
      tab: { padding: "12px 16px", border: "none", background: "transparent", cursor: "pointer", fontSize: 13, color: "#888", display: "flex", alignItems: "center", gap: 8, borderBottom: "2px solid transparent", marginBottom: -1 },
      tabActive: { color: "#F68B32", borderBottom: "2px solid #F68B32", fontWeight: 600 },
      tabCount: { background: "#f0f0e8", color: "#888", fontSize: 11, padding: "1px 7px", borderRadius: 99, fontWeight: 600 },
      tabCountActive: { background: "#F68B32", color: "#fff" },
      stats: { display: "flex", gap: 12, padding: "16px 24px", background: "#fff", borderBottom: "1px solid #eee" },
      stat: { background: "#f9f9f7", borderRadius: 8, padding: "10px 16px", minWidth: 110 },
      statLabel: { fontSize: 10, color: "#888", textTransform: "uppercase", fontWeight: 600, letterSpacing: 0.5 },
      statVal: { fontSize: 20, fontWeight: 700, marginTop: 2 },
      filters: { display: "flex", gap: 10, padding: "12px 24px", background: "#fff", borderBottom: "1px solid #eee" },
      select: { fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" },
      lista: { padding: 24 },
      cabecera: { display: "flex", padding: "10px 14px", background: "#f9f9f7", borderRadius: 8, marginBottom: 10, fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.3 },
      col: { padding: "0 6px" },
      fila: { background: "#fff", border: "1px solid #eee", borderRadius: 8, marginBottom: 6, overflow: "hidden", transition: "all 0.15s" },
      filaAbierta: { borderColor: "#F68B32", boxShadow: "0 2px 8px rgba(42,122,75,0.1)" },
      filaTop: { display: "flex", alignItems: "center", padding: "10px 14px", cursor: "pointer", fontSize: 13 },
      cel: { padding: "0 6px", color: "#333" },
      numero: { fontWeight: 700, color: "#F68B32", marginRight: 6 },
      zonaTag: { fontSize: 11, background: "#f0f0e8", color: "#555", padding: "2px 8px", borderRadius: 4 },
      franjaTag: { fontSize: 11, background: "#f5f0e8", color: "#7d5a2c", padding: "2px 8px", borderRadius: 4 },
      estadoTag: { fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 4, textTransform: "uppercase", letterSpacing: 0.3 },
      cobrarBadge: { fontSize: 9, fontWeight: 700, background: "#c0392b", color: "#fff", padding: "2px 6px", borderRadius: 3, marginLeft: 6, letterSpacing: 0.5 },
      nuevoBadge: { fontSize: 10, fontWeight: 800, background: "#16a34a", color: "#fff", padding: "2px 8px", borderRadius: 4, marginRight: 6, letterSpacing: 0.5, textTransform: "uppercase", boxShadow: "0 0 0 2px rgba(22,163,74,0.25)" },
      chevron: { fontSize: 10, color: "#aaa", marginLeft: 4 },
      detalle: { padding: "14px 18px", borderTop: "1px solid #eee", background: "#fafaf8" },
      detalleGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 },
      detalleBloque: { display: "flex", flexDirection: "column", gap: 4 },
      detalleLabel: { fontSize: 10, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.3 },
      detalleVal: { fontSize: 13, color: "#333" },
      inputField: { fontSize: 12, padding: "5px 8px", borderRadius: 5, border: "1px solid #ddd", background: "#fff", color: "#333" },
      btnEstado: { fontSize: 11, padding: "3px 10px", borderRadius: 5, border: "1px solid #F68B32", background: "#F68B32", color: "#fff", cursor: "pointer", fontWeight: 600 },
      btnImprimir: { fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555", fontWeight: 500 },
      franjaHeader: { display: "flex", alignItems: "center", gap: 12, padding: "11px 14px", background: "#eaf3de", borderRadius: 8, marginBottom: 6, marginTop: 14 },
      franjaFecha: { fontSize: 13, fontWeight: 700, color: "#27500a", textTransform: "capitalize" },
      franjaHora: { fontSize: 12, color: "#27500a", fontWeight: 600 },
      franjaCount: { fontSize: 11, color: "#F68B32", marginLeft: "auto", fontWeight: 600 },
      empty: { padding: 40, textAlign: "center", color: "#aaa", fontSize: 13 },
      formCard: { background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 },
      formCardTitle: { fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 },
      formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
      formBloque: { display: "flex", flexDirection: "column", gap: 4 },
      formLabel: { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase" },
      formInput: { fontSize: 13, padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#333", outline: "none" },
      prodFila: { display: "flex", alignItems: "center", padding: "8px 12px", borderBottom: "1px solid #f5f5f5" },
      btnAgregar: { fontSize: 11, padding: "4px 10px", borderRadius: 5, border: "1px solid #F68B32", background: "#F68B32", color: "#fff", cursor: "pointer", fontWeight: 600 },
      carritoFila: { display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f5f5f5", gap: 6 },
      btnCant: { fontSize: 12, width: 22, height: 22, borderRadius: 4, border: "1px solid #ddd", background: "#f9f9f7", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
      btnCrear: { width: "100%", padding: 11, borderRadius: 8, border: "none", background: "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" },
    };