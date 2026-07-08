import { useState, useEffect, useRef, useMemo } from "react";
    import axios from "axios";
    import * as XLSX from "xlsx";
    import jsPDF from "jspdf";
    import autoTable from "jspdf-autotable";
    import Login from "./Login";
    import Usuarios from "./Usuarios";
    import { getUsuarioGuardado, validarSesion, cerrarSesion, ROL_LABELS } from "./auth-utils";

    const API = import.meta.env.VITE_API_URL || "https://piccadely-panel-production.up.railway.app";

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

    // Orden canónico de turnos (para mostrar/ordenar/desglosar).
    const TURNOS_ORDEN = ["Mañana", "Mediodía", "Tarde", "Fuera de horario", "Sin horario"];
    // Turno según la hora de INICIO de la franja. Reusa el mismo parseo que el panel
    // (primer HH:MM de franjaDisplay). Sin HH:MM -> "Sin horario".
    function turnoDe(franjaDisplay) {
      const m = String(franjaDisplay || "").match(/(\d{1,2}):(\d{2})/);
      if (!m) return "Sin horario";
      const min = Number(m[1]) * 60 + Number(m[2]);
      if (min < 360 || min >= 1380) return "Fuera de horario"; // <06:00 o >=23:00
      if (min < 720) return "Mañana";                          // 06:00–11:59
      if (min < 1020) return "Mediodía";                       // 12:00–16:59
      return "Tarde";                                          // 17:00–22:59
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
    // Medios que entran FÍSICAMENTE como efectivo a la caja → suman al efectivo/saldo esperado.
    // (El desglose "ventas por medio de pago" sigue mostrando cada uno por separado.)
    const EFECTIVO_CAJA = ["Efectivo", "Pedidos Ya Efectivo"];

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
      seccion: "delivery-at", cobrar: true, esCorporativo: false,
    };

    function fechaArgentina(d = new Date()) {
      return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    }

    const HOY = fechaArgentina();
    // Piso de fecha por defecto para reportes sin rango elegido (el endpoint
    // exige desde/hasta; este valor sólo aplica cuando el usuario no filtró).
    const REPORTE_FECHA_MIN = "2024-01-01";
    function restarDias(f, n) {
      const [y, m, d] = f.split("-").map(Number);
      const dt = new Date(y, m - 1, d);
      dt.setDate(dt.getDate() - n);
      return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    }
    function diasEntre(desde, hasta) {
      return Math.round((new Date(hasta + "T12:00:00") - new Date(desde + "T12:00:00")) / 86400000);
    }
    // Lunes (inicio de semana ISO) de la semana a la que pertenece "f" (YYYY-MM-DD).
    // getDay(): 0=domingo..6=sábado; (dia+6)%7 = cuántos días retroceder hasta el lunes.
    function lunesDeLaSemana(f) {
      const [y, m, d] = f.split("-").map(Number);
      const dia = new Date(y, m - 1, d).getDay();
      return restarDias(f, (dia + 6) % 7);
    }
    // Rango del período anterior para comparar contra el actual.
    // "semana": mismo tramo de la semana pasada, alineado por día (lunes→hoy vs lunes→mismo día).
    // "custom": misma duración inmediatamente anterior a dashDesde.
    function rangoAnterior(dashModo, dashDesde, dashHasta) {
      if (dashModo === "semana") {
        return { prevDesde: restarDias(dashDesde, 7), prevHasta: restarDias(dashHasta, 7) };
      }
      return { prevDesde: restarDias(dashDesde, diasEntre(dashDesde, dashHasta) + 1), prevHasta: restarDias(dashDesde, 1) };
    }
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

    // ─── COMANDA: ESC/POS + impresión por QZ Tray ────────────────────────
    // Compartido entre la impresión individual (imprimirComanda) y el lote
    // (imprimirComandasLote). El formato/template y la config de QZ son los
    // mismos; el lote sólo concatena varias comandas (con su corte de papel).
    function comandaLineasESCPOS(p, estadoActual, repartidorActual, cobrar) {
      return [
          "\x1B\x40",
          "\x1B\x74\x12",
          "\x1B\x61\x01",
          "\x1B\x21\x30",
          "PICCADELY\n",
          "\x1B\x21\x00",
          "comanda de pedido\n",
          "--------------------------------\n",
          "\x1B\x61\x00",
          "\x1B\x21\x10",
          `${p.numero}  ${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "-"}\n`,
          `${(p.franjaDisplay || "").replace(/[–—]/g, "a")}  ${p.zona || ""}\n`,
          "\x1B\x21\x00",
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
    }

    const QZ_CERT = `-----BEGIN CERTIFICATE-----
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

    const QZ_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
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

    async function imprimirRawQZ(data, fallbackFn) {
      try {
          if (typeof qz === "undefined") { fallbackFn(); return; }

          qz.security.setCertificatePromise(resolve => resolve(QZ_CERT));
          qz.security.setSignaturePromise(toSign => async (resolve, reject) => {
            try {
              const pemContents = QZ_PRIVATE_KEY
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
          await qz.print(config, [{ type: "raw", format: "command", data }]);
        } catch (err) {
          console.error("Error QZ Tray:", err);
          fallbackFn();
        }
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
            total: totalLimpio, productos: productosFactura, local: p.local,
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
    function VistaImportar({ usuario, onVolver }) {
      const [filas, setFilas] = useState([]);
      const [nombreArchivo, setNombreArchivo] = useState("");
      const [importando, setImportando] = useState(false);
      const [progreso, setProgreso] = useState(0);
      const [resultado, setResultado] = useState(null);
 
      const SECCIONES = { "Delivery A. Thomas": "delivery-at", "Delivery French": "delivery-fr" };
      const localDe = (sec) => sec === "delivery-at" ? "A. Thomas" : sec === "delivery-fr" ? "French" : "—";
      const fmtImp = (n) => "$" + Number(n || 0).toLocaleString("es-AR");
 
      function leerArchivo(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        setNombreArchivo(file.name);
        setResultado(null);
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const wb = XLSX.read(new Uint8Array(ev.target.result), { type: "array" });
            const hoja = wb.Sheets["Pedidos"] || wb.Sheets[wb.SheetNames[0]];
            const rows = XLSX.utils.sheet_to_json(hoja, { defval: "" });
            const parsed = rows.map((r, idx) => {
              const sucursal = String(r["Sucursal"] || "").trim();
              const seccion = SECCIONES[sucursal] || "";
              const precioProd = Number(r["Precio producto"]) || 0;
              const envioPrecio = Number(r["Envío (precio)"]) || 0;
              const errores = [];
              if (!String(r["Cliente"] || "").trim()) errores.push("falta cliente");
              if (!seccion) errores.push("sucursal inválida");
              if (!String(r["Producto"] || "").trim()) errores.push("falta producto");
              if (precioProd <= 0) errores.push("precio inválido");
              if (!String(r["Fecha"] || "").trim()) errores.push("falta fecha");
              return {
                idx: idx + 1,
                cliente: String(r["Cliente"] || "").trim(),
                telefono: String(r["Teléfono"] || "").trim(),
                direccion: String(r["Dirección"] || "").trim(),
                entreCalles: String(r["Entre calles"] || "").trim(),
                barrio: String(r["Barrio / Localidad"] || "").trim(),
                sucursal, seccion,
                producto: String(r["Producto"] || "").trim(),
                precioProd,
                envioNombre: String(r["Envío (nombre)"] || "Envío").trim() || "Envío",
                envioPrecio,
                medioPago: String(r["Medio de pago"] || "Efectivo").trim() || "Efectivo",
                fecha: String(r["Fecha"] || "").trim(),
                franja: String(r["Horario"] || "").trim(),
                nota: String(r["Nota adicional"] || "").trim(),
                total: precioProd + envioPrecio,
                errores,
              };
            });
            setFilas(parsed);
          } catch (err) {
            alert("No pude leer el archivo. Usá la plantilla y la solapa «Pedidos». (" + err.message + ")");
          }
        };
        reader.readAsArrayBuffer(file);
      }
 
      const validas = filas.filter(f => f.errores.length === 0);
      const conError = filas.filter(f => f.errores.length > 0);
 
      async function confirmarImportacion() {
        if (!validas.length) return;
        if (!window.confirm(`Vas a crear ${validas.length} pedido(s) reales en el sistema. ¿Confirmás?`)) return;
        setImportando(true); setProgreso(0);
        let ok = 0; const fallaron = [];
        for (let i = 0; i < validas.length; i++) {
          const f = validas[i];
          try {
            const id = `manual-${Date.now()}-${i}`;
            const items = [`${f.producto} x1`];
            if (f.envioPrecio > 0) items.push(`${f.envioNombre} x1`);
            const productosStr = items.join(", ");
            const esEfectivo = ["Efectivo", "Pedidos Ya Efectivo"].includes(f.medioPago);
            const pago = ["Efectivo", "Pedidos Ya Efectivo", "Mercado Pago", "Rappi", "Pedidos Ya"].includes(f.medioPago) ? "Pendiente" : "Pagado";
            const nuevoPedido = {
              id, numero: "", cliente: f.cliente, telefono: f.telefono, email: "",
              direccion: f.direccion, barrio: f.barrio, entreCalles: f.entreCalles,
              zona: "Sin zona", fecha: f.fecha, franja: f.franja,
              fechaDisplay: f.fecha, franjaDisplay: f.franja || "Sin franja",
              productos: productosStr, totalNum: f.total, total: fmtImp(f.total),
              pago, medioPago: f.medioPago, cobrar: esEfectivo,
              tabActual: f.seccion, local: localDe(f.seccion),
              nota: f.nota, esManual: true, estado: "Por empaquetar", repartidor: "Sin asignar",
            };
            await axios.post(`${API}/api/pedidos-manuales`, { ...nuevoPedido, usuario: usuario.nombre_completo });
            await axios.post(`${API}/api/estados/${id}`, { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: f.fecha, franjaManual: f.franja, cobrar: esEfectivo });
            ok++;
          } catch (err) {
            fallaron.push(`${f.cliente}: ${err.message}`);
          }
          setProgreso(Math.round(((i + 1) / validas.length) * 100));
        }
        setImportando(false);
        setResultado({ ok, fallaron });
        setFilas([]); setNombreArchivo("");
      }
 
      return (
        <div style={{ fontFamily: "system-ui, sans-serif", minHeight: "100vh", background: "#f7f7f5" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #eee" }}>
            <div style={{ fontSize: 18, fontWeight: 700, color: "#333" }}>📥 Importar pedidos</div>
            <button style={{ fontSize: 13, padding: "8px 16px", borderRadius: 8, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }} onClick={onVolver}>← Volver al panel</button>
          </div>
 
          <div style={{ padding: 24, maxWidth: 1100, margin: "0 auto" }}>
            {resultado ? (
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 24 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: "#2a7a4b", marginBottom: 8 }}>✅ Importación terminada</div>
                <div style={{ fontSize: 14, color: "#333" }}>Se crearon <b>{resultado.ok}</b> pedido(s) correctamente.</div>
                {resultado.fallaron.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#c0392b", marginBottom: 6 }}>No se pudieron crear {resultado.fallaron.length}:</div>
                    {resultado.fallaron.map((m, i) => <div key={i} style={{ fontSize: 12, color: "#c0392b" }}>• {m}</div>)}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "#888", marginTop: 16 }}>Los pedidos ya están en el panel (pueden tardar unos segundos en aparecer por el refresco automático).</div>
                <button style={{ marginTop: 16, fontSize: 13, padding: "9px 16px", borderRadius: 8, border: "none", background: "#F68B32", color: "#fff", fontWeight: 600, cursor: "pointer" }} onClick={() => setResultado(null)}>Importar otro archivo</button>
              </div>
            ) : importando ? (
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 30, textAlign: "center" }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: "#333", marginBottom: 14 }}>Creando pedidos… {progreso}%</div>
                <div style={{ height: 12, background: "#eee", borderRadius: 6, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${progreso}%`, background: "#F68B32", transition: "width .2s" }} />
                </div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 12 }}>No cierres esta pantalla hasta que termine.</div>
              </div>
            ) : (
              <>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20, marginBottom: 20 }}>
                  <div style={{ fontSize: 13, color: "#555", marginBottom: 14, lineHeight: 1.5 }}>
                    Subí la <b>plantilla de importación</b> de Piccadely (la solapa «Pedidos»). Vas a ver una vista previa para revisar antes de crear nada.
                  </div>
                  <input type="file" accept=".xlsx" onChange={leerArchivo} style={{ fontSize: 13 }} />
                  {nombreArchivo && <span style={{ fontSize: 12, color: "#888", marginLeft: 10 }}>· {nombreArchivo}</span>}
                </div>
 
                {filas.length > 0 && (
                  <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
                        Vista previa: {validas.length} pedido(s) listo(s)
                        {conError.length > 0 && <span style={{ color: "#c0392b" }}> · {conError.length} con problemas (no se importan)</span>}
                      </div>
                      <button onClick={confirmarImportacion} disabled={!validas.length}
                        style={{ fontSize: 14, padding: "10px 20px", borderRadius: 8, border: "none", background: validas.length ? "#2a7a4b" : "#ccc", color: "#fff", fontWeight: 700, cursor: validas.length ? "pointer" : "not-allowed" }}>
                        ✓ Confirmar e importar {validas.length}
                      </button>
                    </div>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: "#faf6f0", color: "#8a7a6b", textAlign: "left" }}>
                            <th style={{ padding: "8px 6px" }}>#</th>
                            <th style={{ padding: "8px 6px" }}>Cliente</th>
                            <th style={{ padding: "8px 6px" }}>Sucursal</th>
                            <th style={{ padding: "8px 6px" }}>Dirección</th>
                            <th style={{ padding: "8px 6px" }}>Producto</th>
                            <th style={{ padding: "8px 6px", textAlign: "right" }}>Total</th>
                            <th style={{ padding: "8px 6px" }}>Fecha</th>
                            <th style={{ padding: "8px 6px" }}>Estado</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filas.map((f) => (
                            <tr key={f.idx} style={{ borderBottom: "1px solid #f3f3f3", background: f.errores.length ? "#fdecea" : "#fff" }}>
                              <td style={{ padding: "8px 6px", color: "#aaa" }}>{f.idx}</td>
                              <td style={{ padding: "8px 6px", fontWeight: 600, color: "#333" }}>{f.cliente || "—"}</td>
                              <td style={{ padding: "8px 6px" }}>{f.sucursal || "—"}</td>
                              <td style={{ padding: "8px 6px", color: "#555" }}>{f.direccion}{f.barrio ? <span style={{ color: "#aaa" }}> · {f.barrio}</span> : ""}</td>
                              <td style={{ padding: "8px 6px", color: "#555" }}>{f.producto}{f.envioPrecio > 0 ? ` + ${f.envioNombre}` : ""}</td>
                              <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 600, color: "#333" }}>{fmtImp(f.total)}</td>
                              <td style={{ padding: "8px 6px", color: "#555" }}>{f.fecha}</td>
                              <td style={{ padding: "8px 6px" }}>
                                {f.errores.length ? <span style={{ color: "#c0392b", fontWeight: 600 }}>⚠ {f.errores.join(", ")}</span> : <span style={{ color: "#2a7a4b", fontWeight: 600 }}>✓ ok</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      );
    }
 
    function VistaMapa({ onVolver, repartidores = [], onCrearTanda }) {
      const [fecha, setFecha] = useState(HOY);
      const [pedidos, setPedidos] = useState([]);
      const [loading, setLoading] = useState(false);
      const [filtroFranja, setFiltroFranja] = useState("");
      const [filtroLocal, setFiltroLocal] = useState(""); // "" = ambas; armar tanda exige una sucursal
      const [mapLoaded, setMapLoaded] = useState(false);
      // Armado de tanda desde el mapa (Fase 2)
      const [seleccion, setSeleccion] = useState([]);      // ids de pedidos seleccionados (pins)
      const [confirmando, setConfirmando] = useState(false); // modal abierto
      const [repartidor, setRepartidor] = useState("");
      const [nombre, setNombre] = useState("");
      const [tandaError, setTandaError] = useState("");
      const mapRef = useRef(null);
      const mapInstanceRef = useRef(null);
      const markersRef = useRef([]);
      const localMarkersRef = useRef([]); // marcadores fijos de nuestros locales (referencia, persistentes)
      const infoRef = useRef(null);
      const toggleSeleccion = (id) => setSeleccion(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

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
          const enTanda = p.tandaId != null;
          // Seleccionable sólo si hay una sucursal filtrada, el pedido es de esa sucursal y no está en tanda.
          const seleccionable = !!filtroLocal && p.local === filtroLocal && !enTanda;
          const seleccionado = seleccion.includes(p.id);
          const marker = new window.google.maps.Marker({
            position: pos,
            map: mapInstanceRef.current,
            title: `${p.numero} — ${p.franjaDisplay}${enTanda ? ` · Tanda #${p.tandaId}` : ""}`,
            icon: {
              path: window.google.maps.SymbolPath.CIRCLE,
              scale: seleccionado ? 18 : 14,
              fillColor: enTanda ? "#7c3aed" : color,
              fillOpacity: 0.9,
              strokeColor: seleccionado ? "#7c3aed" : "#fff",
              strokeWeight: seleccionado ? 5 : 2,
            },
            label: { text: enTanda ? `T${p.tandaId}` : p.numero.replace("#", ""), color: "#fff", fontSize: "9px", fontWeight: "bold" },
            zIndex: seleccionado ? 999 : undefined,
          });
          marker.addListener("click", () => {
            if (seleccionable) { toggleSeleccion(p.id); return; }
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
                ${enTanda ? `<div style="font-size:12px;color:#7c3aed;font-weight:700;margin-top:4px;">📦 En tanda #${p.tandaId}</div>` : ""}
              </div>
            `);
            infoRef.current.open(mapInstanceRef.current, marker);
          });
          markersRef.current.push(marker);
        });
        mapInstanceRef.current.fitBounds(bounds, 60);
      }, [pedidos, mapLoaded, filtroFranja, filtroLocal, seleccion]);

      // Marcadores FIJOS de nuestros locales: siempre visibles, coords hardcodeadas
      // (sin geocoding), no clickeables (solo referencia). En su propio ref para que
      // el efecto de pins de pedidos no los borre. Se crean una sola vez al cargar el mapa.
      useEffect(() => {
        if (!mapInstanceRef.current || !mapLoaded || localMarkersRef.current.length) return;
        const LOCALES = [
          { nombre: "A. Thomas", lat: -34.5786992, lng: -58.4640355 },
          { nombre: "French", lat: -34.5896025, lng: -58.4010694 },
        ];
        // Estrella (forma claramente distinta de los círculos de pedido/tanda) en naranja de marca.
        const ESTRELLA = "M 0,-22 L 5.4,-7 L 22,-7 L 8.5,3 L 13.5,18 L 0,8.5 L -13.5,18 L -8.5,3 L -22,-7 L -5.4,-7 Z";
        localMarkersRef.current = LOCALES.map(loc => new window.google.maps.Marker({
          position: { lat: loc.lat, lng: loc.lng },
          map: mapInstanceRef.current,
          title: `Local Piccadely — ${loc.nombre}`,
          clickable: false, // referencia: no seleccionable, no entra en tandas
          zIndex: 1000,     // siempre por encima de los pins de pedido
          icon: {
            path: ESTRELLA,
            fillColor: "#F68B32",
            fillOpacity: 1,
            strokeColor: "#fff",
            strokeWeight: 2.5,
            scale: 1.1,
            anchor: new window.google.maps.Point(0, 0),
            labelOrigin: new window.google.maps.Point(0, 34),
          },
          label: { text: loc.nombre, color: "#5a3a00", fontSize: "12px", fontWeight: "bold" },
        }));
      }, [mapLoaded]);

      const franjasDisponibles = [...new Set(pedidos.map(p => p.franjaDisplay).filter(Boolean))].sort();
    const pedidosFiltrados = pedidos.filter(p => (!filtroFranja || p.franjaDisplay === filtroFranja) && (!filtroLocal || p.local === filtroLocal));
    const porEstado = { "Por empaquetar": 0, "Listo": 0, "En camino": 0 };
    pedidosFiltrados.forEach(p => { if (porEstado[p.estado] !== undefined) porEstado[p.estado]++; });

      const avisoTandaMapa = (msg) => { setTandaError(msg); setTimeout(() => setTandaError(""), 3500); };
      const cambiarFiltroLocal = (loc) => { setFiltroLocal(loc); setSeleccion([]); }; // cambiar de sucursal limpia la selección
      async function confirmarTandaMapa() {
        if (!repartidor) { avisoTandaMapa("Elegí un repartidor."); return; }
        if (seleccion.length === 0 || !filtroLocal) return;
        const ids = seleccion;
        try {
          const tanda = await onCrearTanda({ pedidoIds: ids, local: filtroLocal, repartidor, nombre });
          // optimista: los pins seleccionados pasan a mostrar su T{n} y dejan de ser seleccionables
          setPedidos(prev => prev.map(p => ids.includes(p.id) ? { ...p, tandaId: tanda.id } : p));
          setSeleccion([]); setConfirmando(false); setRepartidor(""); setNombre("");
        } catch (err) {
          avisoTandaMapa("No se pudo crear la tanda. Reintentá.");
        }
      }

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
              <select style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}
                value={filtroLocal} onChange={e => cambiarFiltroLocal(e.target.value)}>
                <option value="">Ambas sucursales</option>
                <option value="A. Thomas">A. Thomas</option>
                <option value="French">French</option>
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

          {/* Hint cuando hay sucursal filtrada y todavía no seleccionó nada */}
          {filtroLocal && seleccion.length === 0 && mapLoaded && pedidosFiltrados.length > 0 && (
            <div style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 40, background: "#2b2b2b", color: "#fff", padding: "8px 16px", borderRadius: 99, fontSize: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.25)" }}>
              Tocá los pins de {filtroLocal} (sin tanda) para armar una tanda
            </div>
          )}

          {/* Botón flotante "Armar tanda (N)" */}
          {filtroLocal && seleccion.length > 0 && (
            <button onClick={() => { setRepartidor(""); setNombre(""); setConfirmando(true); }}
              style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 50, fontSize: 14, fontWeight: 700, padding: "12px 24px", borderRadius: 99, border: "none", cursor: "pointer", background: "#7c3aed", color: "#fff", boxShadow: "0 4px 16px rgba(124,58,237,0.4)" }}>
              📦 Armar tanda ({seleccion.length}) — {filtroLocal}
            </button>
          )}

          {/* Modal: repartidor (obligatorio) + nombre (opcional) — mismo de la Fase 1 */}
          {confirmando && (
            <div onClick={() => setConfirmando(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
              <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, width: 380, boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#333", marginBottom: 4 }}>📦 Nueva tanda — {filtroLocal}</div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>{seleccion.length} pedido{seleccion.length > 1 ? "s" : ""}</div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ ...s.formLabel, display: "block", marginBottom: 4 }}>Repartidor *</label>
                  <select style={{ ...s.formInput, width: "100%" }} value={repartidor} onChange={e => setRepartidor(e.target.value)}>
                    <option value="">Elegí un repartidor…</option>
                    {repartidores.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ ...s.formLabel, display: "block", marginBottom: 4 }}>Nombre (opcional)</label>
                  <input style={{ ...s.formInput, width: "100%", boxSizing: "border-box" }} value={nombre} onChange={e => setNombre(e.target.value)} placeholder="ej: Recorrido centro" />
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmando(false)} style={{ fontSize: 13, padding: "8px 14px", borderRadius: 6, border: "1px solid #ddd", cursor: "pointer", background: "#fff", color: "#555" }}>Cancelar</button>
                  <button onClick={confirmarTandaMapa} disabled={!repartidor}
                    style={{ fontSize: 13, fontWeight: 700, padding: "8px 18px", borderRadius: 6, border: "none", cursor: repartidor ? "pointer" : "not-allowed", background: repartidor ? "#7c3aed" : "#ccc", color: "#fff" }}>
                    Crear tanda
                  </button>
                </div>
              </div>
            </div>
          )}

          {tandaError && (
            <div style={{ position: "fixed", bottom: 80, left: "50%", transform: "translateX(-50%)", background: "#fdecea", color: "#c0392b", border: "1px solid #f5b7b1", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 500 }}>
              {tandaError}
            </div>
          )}
        </div>
      );
    }
    function VistaCotizaciones({ onVolver }) {
      const [lista, setLista] = useState([]);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState("");
      const [filtro, setFiltro] = useState("todas");

      const cargar = async () => {
        setLoading(true);
        try { const r = await axios.get(`${API}/api/cotizaciones`); setLista(r.data || []); setError(""); }
        catch (e) { setError("No se pudieron cargar las cotizaciones."); }
        finally { setLoading(false); }
      };
      useEffect(() => { cargar(); }, []);

      const cambiarEstado = async (id, estado) => {
        try {
          await axios.patch(`${API}/api/cotizaciones/${id}`, { estado });
          setLista(l => l.map(c => c.id === id ? { ...c, estado } : c));
        } catch (e) { alert("Error al actualizar: " + (e.response?.data?.error || e.message)); }
      };

      const money = n => "$" + Number(n || 0).toLocaleString("es-AR");
      const fmtFecha = v => v ? new Date(v).toLocaleString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
      const wsp = t => { const d = String(t || "").replace(/\D/g, ""); if (!d) return null; const full = d.length <= 10 ? "549" + d : (d.startsWith("54") ? d : "54" + d); return "https://wa.me/" + full; };

      const estados = ["pendiente", "contactado", "ganada", "perdida"];
      const colorEstado = { pendiente: "#e8a33d", contactado: "#3d7de8", ganada: "#1ea05a", perdida: "#c0392b" };
      const filtradas = filtro === "todas" ? lista : lista.filter(c => c.estado === filtro);

      const btnVolver = { fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#555", cursor: "pointer", fontWeight: 600 };
      const card = { background: "#fff", border: "1px solid #eee", borderRadius: 12, padding: 16, marginBottom: 14 };
      const pill = (active, color) => ({ fontSize: 12, padding: "5px 12px", borderRadius: 20, border: "1px solid " + (active ? color : "#ddd"), background: active ? color : "#fff", color: active ? "#fff" : "#666", cursor: "pointer", fontWeight: 600 });

      return (
        <div style={{ padding: 24, maxWidth: 820, margin: "0 auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            <button style={btnVolver} onClick={onVolver}>← Volver</button>
            <h2 style={{ fontSize: 17, fontWeight: 600, color: "#333", margin: 0 }}>🎉 Cotizaciones de Eventos</h2>
            <span style={{ fontSize: 13, color: "#999" }}>{filtradas.length}</span>
            <button onClick={cargar} style={{ marginLeft: "auto", fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>↻ Actualizar</button>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 18, flexWrap: "wrap" }}>
            {["todas", ...estados].map(f => (
              <button key={f} style={pill(filtro === f, f === "todas" ? "#F68B32" : colorEstado[f])} onClick={() => setFiltro(f)}>
                {f === "todas" ? "Todas" : f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>

          {loading && <p style={{ color: "#999" }}>Cargando...</p>}
          {error && <p style={{ color: "#c0392b" }}>{error}</p>}
          {!loading && !error && filtradas.length === 0 && <p style={{ color: "#999" }}>No hay cotizaciones todavía.</p>}

          {filtradas.map(c => {
            const elegida = (c.opciones || []).find(o => o.nivel === c.nivel_elegido);
            const items = elegida ? [...(elegida.piccadas || []), ...(elegida.sandwiches || []), ...(elegida.vegetarianas || [])] : [];
            const link = wsp(c.telefono);
            return (
              <div key={c.id} style={{ ...card, borderLeft: "4px solid " + (colorEstado[c.estado] || "#ddd") }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, padding: "4px 10px", borderRadius: 6, background: c.canal === "whatsapp" ? "#e9f8ef" : "#fff4e8", color: c.canal === "whatsapp" ? "#1ea05a" : "#d9701c" }}>
                    {c.canal === "whatsapp" ? "📲 Cerró por WhatsApp" : "📞 Pidió que lo contacten"}
                  </span>
                  <span style={{ fontSize: 12, color: "#999" }}>#{c.id} · {fmtFecha(c.creada_en)}</span>
                  <select value={c.estado} onChange={e => cambiarEstado(c.id, e.target.value)}
                    style={{ marginLeft: "auto", fontSize: 12, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd", color: colorEstado[c.estado], fontWeight: 600 }}>
                    {estados.map(e => <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>)}
                  </select>
                </div>

                <div style={{ fontSize: 14, fontWeight: 600, color: "#333" }}>
                  {c.cliente_nombre || "Sin nombre"}{c.empresa ? <span style={{ color: "#888", fontWeight: 400 }}> · {c.empresa}</span> : null}
                </div>
                <div style={{ fontSize: 13, color: "#666", margin: "4px 0 10px" }}>
                  ✉️ {c.email || "-"} · 📱 {c.telefono || "-"}
                  {link && <a href={link} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: "#1ea05a", textDecoration: "none", fontWeight: 600 }}>Escribir ›</a>}
                </div>

                <div style={{ fontSize: 13, color: "#444", background: "#faf7f2", borderRadius: 8, padding: "10px 12px" }}>
                  <div style={{ marginBottom: 6 }}>
                    👥 <b>{c.personas}</b> personas ({c.modo}) · {c.mix}{c.fecha_evento ? " · 📅 " + c.fecha_evento : ""}{c.zona ? " · 📍 " + c.zona : ""}{c.con_bebidas ? " · 🥤 quiere bebidas" : ""}
                  </div>
                  <div style={{ fontWeight: 700, color: "#d9701c" }}>
                    {elegida ? elegida.etiqueta : (c.nivel_elegido || "—")} · {money(c.total_elegido)}
                  </div>
                  {items.length > 0 && (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "#666" }}>
                      {items.map((i, k) => <li key={k} style={{ fontSize: 12 }}>{i.cantidad}× {i.nombre} ({i.tamano})</li>)}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    // ─── COMPONENTE CAJA ─────────────────────────────────────────────────
    function VistaCaja({ pedidosActivos, onVolver, usuario }) {
            const HOY_CAJA = fechaArgentina();
      const localesPermitidos = usuario.rol === "admin"
        ? ["A. Thomas", "French", "Administración", "Fondo Fijo A. Thomas", "Fondo Fijo French"]
        : usuario.rol === "a_thomas" ? ["A. Thomas", "Fondo Fijo A. Thomas"] : ["French", "Fondo Fijo French"];
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
      const [fondo, setFondo] = useState(null);
      const [loadingFondo, setLoadingFondo] = useState(false);
      const [fondoMov, setFondoMov] = useState({ tipo: "salida", concepto: "", monto: "" });
      // Finalizados del rango [min(historial), HOY_CAJA] traídos por /api/reportes/pedidos
      // (NO de la ventana de 7 días). Fuente de ventas del día y del saldo del historial.
      const [cajaFinalizados, setCajaFinalizados] = useState([]);

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

      // Trae los finalizados por rango (HOY_CAJA + días del historial) desde el
      // endpoint histórico, así la caja del día y el saldo del historial no dependen
      // de la ventana de 7 días de /api/orders (pedidos cargados con anticipación).
      async function cargarFinalizadosCaja() {
        if (localSeleccionado.startsWith("Fondo Fijo") || localSeleccionado === "Administración") { setCajaFinalizados([]); return; }
        const fechas = historial.map(h => h.apertura?.fecha).filter(Boolean);
        const desde = fechas.length ? fechas.reduce((m, f) => (f < m ? f : m), HOY_CAJA) : HOY_CAJA;
        try {
          const res = await axios.get(`${API}/api/reportes/pedidos`, { params: { desde, hasta: HOY_CAJA } });
          setCajaFinalizados(res.data);
        } catch (e) { console.error("Caja: error trayendo finalizados por rango:", e.message); }
      }

      // Refetch "en vivo": SOLO el día de caja (1 día, barato). Reemplaza la porción
      // de HOY dentro de cajaFinalizados y deja intactos los días del historial (estáticos).
      async function cargarFinalizadosHoy() {
        if (localSeleccionado.startsWith("Fondo Fijo") || localSeleccionado === "Administración") return;
        try {
          const res = await axios.get(`${API}/api/reportes/pedidos`, { params: { desde: HOY_CAJA, hasta: HOY_CAJA } });
          setCajaFinalizados(prev => [...prev.filter(p => p.fechaDisplay !== HOY_CAJA), ...res.data]);
        } catch (e) { console.error("Caja: error refrescando ventas de hoy:", e.message); }
      }

      useEffect(() => { if (localSeleccionado.startsWith("Fondo Fijo")) { cargarFondo(); } else { cargarEstado(); cargarHistorial(); } }, [localSeleccionado]);
      useEffect(() => {
        if (localSeleccionado === "Administración" && estadoCaja !== null && !estadoCaja?.apertura && !loadingCaja) {
          axios.post(`${API}/api/caja/apertura`, { local: "Administración", fecha: HOY_CAJA, montoInicial: 0 })
            .then(() => cargarEstado())
            .catch(console.error);
        }
      }, [localSeleccionado, estadoCaja, loadingCaja]);
      // Rango completo (HOY + días del historial): SOLO al entrar/cambiar de local
      // o cuando cambia el historial (que es estático salvo reapertura). Acá está el
      // costo grande, pero no se repite cada 30s.
      useEffect(() => {
        if (localSeleccionado.startsWith("Fondo Fijo") || localSeleccionado === "Administración") { setCajaFinalizados([]); return; }
        cargarFinalizadosCaja();
      }, [localSeleccionado, historial]);
      // "En vivo": interval corto SOLO mientras la caja está montada (se limpia al
      // salir) que refetchea únicamente HOY (1 día). El historial no se re-trae. No
      // toca el poll global de 30s.
      useEffect(() => {
        if (localSeleccionado.startsWith("Fondo Fijo") || localSeleccionado === "Administración") return;
        const iv = setInterval(cargarFinalizadosHoy, 30000);
        return () => clearInterval(iv);
      }, [localSeleccionado]);
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
      const activosLocal = (pedidosActivos || []).filter(p => p.local === localSeleccionado && p.fechaDisplay && p.fechaDisplay <= HOY_CAJA);
      if (activosLocal.length > 0) {
        const lista = activosLocal.map(p => `${p.numero} (${p.fechaDisplay})`).join("\n");
        alert(`No se puede cerrar la caja todavía.\n\nTenés ${activosLocal.length} pedido(s) activo(s) en ${localSeleccionado} sin finalizar (de hoy o de días anteriores):\n\n${lista}\n\nFinalizalos (marcalos como Entregado) o pasalos a otra fecha, y después cerramos la caja.`);
        return;
      }
      setGuardando(true);
await axios.post(`${API}/api/caja/cierre`, { local: localSeleccionado, fecha: HOY_CAJA, montoCierre: Number(montoCierre), usuario: usuario.nombre_completo });      const ventasPorMedioPDF = {};
      MEDIOS_PAGO.forEach(m => { ventasPorMedioPDF[m] = sumar(ventasPorMedio[m] || []); });
generarPDFCierre(localSeleccionado, HOY_CAJA, montoInicial, ventasPorMedioPDF, ajustes, saldoEsperado, Number(montoCierre));      setMontoCierre(""); await cargarEstado(); await cargarHistorial(); setGuardando(false);
    }
const ventasLocal = cajaFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === HOY_CAJA);
      const ventasPorMedio = MEDIOS_PAGO.reduce((acc, m) => { acc[m] = ventasLocal.filter(p => p.medioPago === m); return acc; }, {});
      const totalVentas = sumar(ventasLocal);
    const totalEfectivo = EFECTIVO_CAJA.reduce((acc, m) => acc + sumar(ventasPorMedio[m] || []), 0);
      const montoInicial = estadoCaja?.apertura?.monto_inicial || 0;
      const ajustes = estadoCaja?.movimientos?.filter(m => m.tipo === "entrada" || m.tipo === "salida") || [];
      const totalAjustes = ajustes.reduce((a, m) => a + Number(m.monto), 0);
      const saldoEsperado = Number(montoInicial) + totalEfectivo + totalAjustes;
      const cerrada = estadoCaja?.apertura?.cerrada;

      async function cargarFondo() {
        setLoadingFondo(true);
        try { const res = await axios.get(`${API}/api/fondo-fijo/${encodeURIComponent(localSeleccionado)}`); setFondo(res.data); }
        catch (e) { console.error(e); }
        setLoadingFondo(false);
      }
      async function registrarMovimientoFondo() {
        if (!fondoMov.concepto || !fondoMov.monto) return;
        setGuardando(true);
        try {
          await axios.post(`${API}/api/fondo-fijo/movimiento`, {
            local: localSeleccionado,
            tipo: fondoMov.tipo, concepto: fondoMov.concepto, monto: Number(fondoMov.monto),
            fecha: HOY_CAJA, usuario: usuario.nombre_completo
          });
          setFondoMov({ tipo: "salida", concepto: "", monto: "" });
          await cargarFondo();
        } catch (err) { alert("Error registrando movimiento: " + err.message); }
        setGuardando(false);
      }
      function renderFondoFijo() {
        const saldo = fondo?.saldo || 0;
        const movs = fondo?.movimientos || [];
        return (
          <div style={{ maxWidth: 720 }}>
            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 24, marginBottom: 20 }}>
             <div style={{ fontSize: 12, color: "#888", marginBottom: 6, letterSpacing: 0.5 }}>SALDO ACTUAL · {localSeleccionado.toUpperCase()}</div>
              <div style={{ fontSize: 34, fontWeight: 700, color: saldo < 0 ? "#c0392b" : "#F68B32" }}>{loadingFondo ? "..." : fmt(saldo)}</div>
              <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>El saldo se mantiene día a día · fondo fijo del local</div>
            </div>

            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20, marginBottom: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>➕ Registrar movimiento</div>
              <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                {["salida", "entrada"].map(t => (
                  <button key={t} onClick={() => setFondoMov(f => ({ ...f, tipo: t }))}
                    style={{ flex: 1, padding: 9, borderRadius: 8, border: "1px solid", cursor: "pointer", fontSize: 13, fontWeight: 600,
                      borderColor: fondoMov.tipo === t ? (t === "salida" ? "#c0392b" : "#2a7a4b") : "#ddd",
                      background: fondoMov.tipo === t ? (t === "salida" ? "#fdecea" : "#eaf6ef") : "#fff",
                      color: fondoMov.tipo === t ? (t === "salida" ? "#c0392b" : "#2a7a4b") : "#777" }}>
                    {t === "salida" ? "↓ Gasto / salida" : "↑ Reposición / entrada"}
                  </button>
                ))}
              </div>
              <input type="text" placeholder="Concepto (ej: compra de servilletas)" value={fondoMov.concepto}
                onChange={e => setFondoMov(f => ({ ...f, concepto: e.target.value }))}
                style={{ fontSize: 14, padding: "9px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 10 }} />
              <input type="number" placeholder="$0" value={fondoMov.monto}
                onChange={e => setFondoMov(f => ({ ...f, monto: e.target.value }))}
                style={{ fontSize: 14, padding: "9px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 12 }} />
              <button onClick={registrarMovimientoFondo} disabled={guardando || !fondoMov.concepto || !fondoMov.monto}
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: (guardando || !fondoMov.concepto || !fondoMov.monto) ? 0.5 : 1 }}>
                {guardando ? "Guardando..." : "Registrar movimiento"}
              </button>
            </div>

            <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>📒 Movimientos</div>
              {loadingFondo ? <div style={{ color: "#aaa", fontSize: 13 }}>Cargando...</div>
                : movs.length === 0 ? <div style={{ color: "#aaa", fontSize: 13 }}>Todavía no hay movimientos.</div>
                : movs.map(m => {
                  const monto = Number(m.monto);
                  return (
                    <div key={m.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid #f5f5f5" }}>
                      <div>
                        <div style={{ fontSize: 13, color: "#333", fontWeight: 500 }}>{m.concepto || (monto >= 0 ? "Reposición" : "Gasto")}</div>
                        <div style={{ fontSize: 11, color: "#aaa" }}>{m.fecha}</div>
                      </div>
                      <span style={{ fontSize: 14, fontWeight: 600, color: monto >= 0 ? "#2a7a4b" : "#c0392b" }}>{monto >= 0 ? "+" : "−"}{fmt(Math.abs(monto))}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        );
      }

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
              {localSeleccionado.startsWith("Fondo Fijo") ? renderFondoFijo() : loadingCaja ? <div style={{ color: "#aaa", fontSize: 13 }}>Cargando caja...</div>
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
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#333", marginBottom: 14 }}>🔒 Cerrar caja</div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 6 }}>Saldo esperado: <strong>{fmt(saldoEsperado)}</strong></div>
                    <div style={{ fontSize: 12, color: "#888", marginBottom: 8 }}>EFECTIVO CONTADO AL CIERRE</div>
                    <input type="number" style={{ fontSize: 14, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", marginBottom: 10 }} placeholder="$0" value={montoCierre} onChange={e => setMontoCierre(e.target.value)} />
                    {montoCierre && <div style={{ background: "#f9f9f7", borderRadius: 6, padding: "8px 12px", marginBottom: 10, fontSize: 12 }}>Diferencia: <strong style={{ color: (Number(montoCierre) - saldoEsperado) >= 0 ? "#F68B32" : "#c0392b" }}>{fmt(Number(montoCierre) - saldoEsperado)}</strong></div>}
                    <button style={{ width: "100%", padding: 10, borderRadius: 8, border: "none", background: "#c0392b", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={cerrarCaja} disabled={guardando || !montoCierre}>{guardando ? "Cerrando..." : "Cerrar caja y emitir informe de ventas"}</button>
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
                            const saldoEsperadoH = Number(a.monto_inicial) + cajaFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === a.fecha && EFECTIVO_CAJA.includes(p.medioPago)).reduce((acc, p) => acc + p.totalNum, 0) + totalAjustesH;
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
                            const saldoEsperadoH = Number(a.monto_inicial) + cajaFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === a.fecha && EFECTIVO_CAJA.includes(p.medioPago)).reduce((acc, p) => acc + p.totalNum, 0) + totalAjustesH;
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
                    const saldoEsperadoH = Number(a.monto_inicial) + cajaFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === a.fecha && EFECTIVO_CAJA.includes(p.medioPago)).reduce((acc, p) => acc + p.totalNum, 0) + totalAjustesH;
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
                                  const ventasDelDia = cajaFinalizados.filter(p => p.local === localSeleccionado && p.estado !== "Anulado" && p.fechaDisplay === a.fecha);
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
      const [menuGrupo, setMenuGrupo] = useState("");
      const [filtroFinDesde, setFiltroFinDesde] = useState(restarDias(HOY, 7)); // rango de FETCH a /api/reportes/pedidos (default últimos 7 días)
      const [filtroFinHasta, setFiltroFinHasta] = useState(HOY);
      const [filtroRepartidor, setFiltroRepartidor] = useState("");
      const [filtroFinLocal, setFiltroFinLocal] = useState("");
      const [facturando, setFacturando] = useState(null);
      const [pedidoEmailMP, setPedidoEmailMP] = useState(null);
      const [facturaVersion, setFacturaVersion] = useState(0);
      const [rvDesde, setRvDesde] = useState("");
      const [rvHasta, setRvHasta] = useState("");
      const [rvMedio, setRvMedio] = useState("");
      const [rvRepartidor, setRvRepartidor] = useState("");
      const [rvLocal, setRvLocal] = useState("");
      const [rvTipo, setRvTipo] = useState(""); // "" = todos, "retiro" | "delivery" (por p.tabActual)
      // Reporte de reservas: pedidos activos a futuro (no cerrados). Default desde = HOY.
      const [rrDesde, setRrDesde] = useState(HOY);
      const [rrHasta, setRrHasta] = useState("");
      const [rrMedio, setRrMedio] = useState("");
      const [rrRepartidor, setRrRepartidor] = useState("");
      const [rrLocal, setRrLocal] = useState("");
      const [rrTipo, setRrTipo] = useState(""); // "" = todos, "retiro" | "delivery" (por p.tabActual)
      const [rrTurno, setRrTurno] = useState("");   // filtro turno en Reporte de reservas ("" = todos)
      const [tabFin, setTabFin] = useState("entregados");
      const [rpDesde, setRpDesde] = useState("");
      const [rpHasta, setRpHasta] = useState("");
      const [rpLocal, setRpLocal] = useState(""); // "" = ambos; mismo criterio que reporteVentas (p.local)
      // Reporte fusionado (vendido / por vender) — solo admin. Rango libre que cruza hoy.
      const [rfDesde, setRfDesde] = useState(restarDias(HOY, 7));   // una semana atrás
      const [rfHasta, setRfHasta] = useState(restarDias(HOY, -7));  // una semana adelante (n negativo = suma)
      const [rfLocal, setRfLocal] = useState("");                   // "" = ambos
      const [prodFecha, setProdFecha] = useState(HOY);
      const [prodLocal, setProdLocal] = useState("todos");
      const [prodTurno, setProdTurno] = useState(""); // filtro turno en Análisis de producción ("" = todos)
      // Tablero de cocina (demanda de produccion + stock por local)
      // Fecha como RANGO [desde, hasta]; default HOY..HOY (= comportamiento de un día).
      const [cocinaDesde, setCocinaDesde] = useState(HOY);
      const [cocinaHasta, setCocinaHasta] = useState(HOY);
      const [cocinaLocal, setCocinaLocal] = useState("todos");
      const [cocinaTurno, setCocinaTurno] = useState(""); // filtro turno en tablero de cocina ("" = todos)
      const [cocinaCant, setCocinaCant] = useState({});
      const [descartar, setDescartar] = useState(null); // { clave, cantidad, fecha } de la fila abierta
      const [stockData, setStockData] = useState([]);
      const [stockLoading, setStockLoading] = useState(false);
      const [stockError, setStockError] = useState(null);
      const [dashDesde, setDashDesde] = useState(lunesDeLaSemana(HOY));
      const [dashHasta, setDashHasta] = useState(HOY);
      const [dashModo, setDashModo] = useState("semana");
      const [dashOrigen, setDashOrigen] = useState("todos");
      const [editandoProductos, setEditandoProductos] = useState(null);
      const [productosOverride, setProductosOverride] = useState({});
      const [pedidosDatosOverride, setPedidosDatosOverride] = useState({});
      // Datos históricos para las vistas de reportes (leen toda la base por
      // rango de fechas vía /api/reportes/pedidos, sin la ventana de 7 días).
      const [repPedidos, setRepPedidos] = useState([]);
      const [repLoading, setRepLoading] = useState(false);
      const [repError, setRepError] = useState(null);
      // Reporte de pedidos por repartidor y zona (solo admin). Default últimos 30 días.
      const [zonasDesde, setZonasDesde] = useState(restarDias(HOY, 30));
      const [zonasHasta, setZonasHasta] = useState(HOY);
      const [zonasRepartidor, setZonasRepartidor] = useState(""); // "" = todos
      const [zonasArea, setZonasArea] = useState("");             // "" = todas ("1".."10")
      const [zonasData, setZonasData] = useState(null);           // { repartidores, totales, costoArea, pedidos }
      const [zonasLoading, setZonasLoading] = useState(false);
      const [zonasError, setZonasError] = useState(null);
      const [zonasRefetch, setZonasRefetch] = useState(0);        // bump para re-pedir el reporte tras guardar costos
      const [costosEdit, setCostosEdit] = useState({});           // inputs editables { "1".."10": string }
      const [costosGuardando, setCostosGuardando] = useState(false);
      const [costosMsg, setCostosMsg] = useState("");
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
      const [sobreError, setSobreError] = useState("");
      // Tandas de reparto (Fase 1)
      const [tandas, setTandas] = useState([]);            // metadata de tandas (GET /api/tandas)
      const [modoTandaLocal, setModoTandaLocal] = useState(null); // local fijado al entrar en "armar tanda" (null = modo off)
      const [seleccionTanda, setSeleccionTanda] = useState([]);   // ids de pedidos elegidos para la tanda
      const [confirmandoTanda, setConfirmandoTanda] = useState(false); // modal abierto
      const [tandaRepartidor, setTandaRepartidor] = useState("");
      const [tandaNombre, setTandaNombre] = useState("");
      const [tandaError, setTandaError] = useState("");
      const [tandaVistaLocal, setTandaVistaLocal] = useState("A. Thomas"); // local mostrado en la vista "Tandas activas"
      const [repartidoresLista, setRepartidoresLista] = useState(REPARTIDORES_DEFAULT);
      const [varNombre, setVarNombre] = useState("");
      const [varPrecio, setVarPrecio] = useState("");
      const [varCantidad, setVarCantidad] = useState("1");

      async function cargarProductosOverride() {
        // UNA sola llamada batch en vez de 1 GET por pedido (evita ERR_INSUFFICIENT_RESOURCES).
        // El backend devuelve { [id]: { productos, total_num } }, misma forma que se consumía.
        try {
          const res = await axios.get(`${API}/api/pedidos/productos-all`);
          setProductosOverride(res.data || {});
        } catch(e) {}
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
            locales[p.id] = resEstados.data[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.payment_status !== "paid", sobre: false, tarjeta: "no", tandaId: null };
          });
          resManuales.data.forEach(p => {
            locales[p.id] = resEstados.data[p.id] || { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar, sobre: false, tarjeta: "no", tandaId: null };
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
            if (est.medioPagoOtroOverride) ov.medioPagoOtro = est.medioPagoOtroOverride;
            if (Object.keys(ov).length > 0) datosInit[id] = ov;
          });
setPedidosDatosOverride(datosInit);
          // Inicializar contador de comandas impresas desde la base
          const comandasInit = {};
          Object.entries(resEstados.data).forEach(([id, est]) => {
            if (est.comandasImpresas && est.comandasImpresas > 0) comandasInit[id] = est.comandasImpresas;
          });
          setComandasImpresas(comandasInit);    try { const resRep = await axios.get(`${API}/api/repartidores`); setRepartidoresLista(resRep.data.map(r => r.nombre)); } catch(e) {}
          axios.get(`${API}/api/tandas`).then(r => setTandas(r.data)).catch(() => {});
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
          cargarProductosOverride();
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
              resOrders.data.forEach(p => { if (!nuevo[p.id]) nuevo[p.id] = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.payment_status !== "paid", sobre: false, tarjeta: "no" }; });
              resManuales.data.forEach(p => { if (!nuevo[p.id]) nuevo[p.id] = { estado: "Por empaquetar", repartidor: "Sin asignar", tabManual: null, fechaManual: null, franjaManual: null, cobrar: p.cobrar, sobre: false, tarjeta: "no" }; });
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

      // ─── REPORTES: traer datos históricos del backend por rango ──────────
      // Se dispara al entrar a una vista de reporte y al cambiar su rango.
      // El dashboard pide desde el inicio del período anterior (con un día de
      // margen) para que la comparación "vs anterior" tenga datos completos.
      useEffect(() => {
        if (vista !== "reporteVentas" && vista !== "reporteProductos" && vista !== "reporteFusionado" && vista !== "dashboard" && vista !== "finalizados") return;
        let desde, hasta;
        if (vista === "reporteVentas") { desde = rvDesde || REPORTE_FECHA_MIN; hasta = rvHasta || HOY; }
        else if (vista === "reporteProductos") { desde = rpDesde || REPORTE_FECHA_MIN; hasta = rpHasta || HOY; }
        else if (vista === "reporteFusionado") { desde = rfDesde || REPORTE_FECHA_MIN; hasta = rfHasta || restarDias(HOY, -30); }
        else if (vista === "finalizados") { desde = filtroFinDesde || REPORTE_FECHA_MIN; hasta = filtroFinHasta || HOY; }
        else { const { prevDesde } = rangoAnterior(dashModo, dashDesde, dashHasta); desde = restarDias(prevDesde, 1); hasta = dashHasta; }
        if (desde > hasta) { setRepPedidos([]); setRepError("El rango de fechas es inválido (desde es posterior a hasta)."); setRepLoading(false); return; }
        let cancelado = false;
        setRepLoading(true); setRepError(null);
        // Solo el reporte fusionado pide también los no finalizados (Por vender).
        const paramsRep = { desde, hasta };
        if (vista === "reporteFusionado") paramsRep.incluirActivos = 1;
        axios.get(`${API}/api/reportes/pedidos`, { params: paramsRep })
          .then(res => {
            if (cancelado) return;
            setRepPedidos(res.data); setRepLoading(false);
            // Finalizados lee por rango y puede traer pedidos fuera de la ventana de /api/orders
            // (no están en pedidosLocales). Sembramos su estado resuelto para que los handlers
            // de la card (cambiar cobrar, reabrir) manden el objeto completo y no corrompan estado.
            // tab/fecha/franja van vacíos: el COALESCE del backend conserva lo guardado.
            if (vista === "finalizados") {
              setPedidosLocales(prev => {
                const nuevo = { ...prev };
                res.data.forEach(p => {
                  if (!nuevo[p.id]) nuevo[p.id] = { estado: p.estado, repartidor: p.repartidor, cobrar: !!p.cobrar, tabManual: "", fechaManual: "", franjaManual: "" };
                });
                return nuevo;
              });
            }
          })
          .catch(() => { if (!cancelado) { setRepPedidos([]); setRepError("No se pudieron cargar los datos históricos. Reintentá o revisá la conexión."); setRepLoading(false); } });
        return () => { cancelado = true; };
      }, [vista, rvDesde, rvHasta, rpDesde, rpHasta, rfDesde, rfHasta, dashDesde, dashHasta, dashModo, filtroFinDesde, filtroFinHasta]);

      // ─── ZONAS: reporte por repartidor y área (GET /api/reportes/zonas) ──
      // Se carga al entrar a la vista y al cambiar el rango. Filtros repartidor/área
      // son client-side (solo acotan lo mostrado). El token JWT lo agrega el interceptor.
      useEffect(() => {
        if (vista !== "zonas") return;
        const desde = zonasDesde || REPORTE_FECHA_MIN;
        const hasta = zonasHasta || HOY;
        if (desde > hasta) { setZonasData(null); setZonasError("El rango de fechas es inválido (desde es posterior a hasta)."); setZonasLoading(false); return; }
        let cancelado = false;
        setZonasLoading(true); setZonasError(null);
        axios.get(`${API}/api/reportes/zonas`, { params: { desde, hasta } })
          .then(res => { if (!cancelado) { setZonasData(res.data); setZonasLoading(false); } })
          .catch(err => { if (!cancelado) { setZonasData(null); setZonasError(err.response?.data?.error || "No se pudo cargar el reporte de zonas. Reintentá."); setZonasLoading(false); } });
        return () => { cancelado = true; };
      }, [vista, zonasDesde, zonasHasta, zonasRefetch]);

      // Costos de área: al entrar a la vista, GET /api/costos-areas y poblá los inputs.
      useEffect(() => {
        if (vista !== "zonas") return;
        let cancelado = false;
        axios.get(`${API}/api/costos-areas`)
          .then(res => { if (!cancelado) { const e = {}; for (let n = 1; n <= 10; n++) e[n] = String(res.data?.[n] ?? 1); setCostosEdit(e); } })
          .catch(() => {});
        return () => { cancelado = true; };
      }, [vista]);

      // Guardar los 10 costos -> PATCH -> "Guardado ✓" + re-pedir el reporte (recalcula Total costo).
      async function guardarCostosAreas() {
        const costos = {};
        for (let n = 1; n <= 10; n++) {
          const v = Number(costosEdit[n]);
          if (!Number.isFinite(v) || v < 0) { setCostosMsg("⚠️ Todos los costos deben ser números ≥ 0."); setTimeout(() => setCostosMsg(""), 3000); return; }
          costos[n] = v;
        }
        setCostosGuardando(true); setCostosMsg("");
        try {
          await axios.patch(`${API}/api/costos-areas`, { costos });
          setCostosMsg("Guardado ✓");
          setZonasRefetch(x => x + 1); // recalcula Total costo con los nuevos valores
          setTimeout(() => setCostosMsg(""), 2500);
        } catch (e) {
          setCostosMsg("⚠️ " + (e.response?.data?.error || "No se pudo guardar."));
          setTimeout(() => setCostosMsg(""), 4000);
        } finally { setCostosGuardando(false); }
      }

      // ─── COCINA: stock por local (GET /api/stock) ────────────────────────
      // Se carga al entrar a la vista y al cambiar el local. El token JWT lo
      // agrega el interceptor global de axios (auth-utils), igual que repPedidos.
      useEffect(() => {
        if (vista !== "cocina") return;
        let cancelado = false;
        setStockLoading(true); setStockError(null);
        const params = cocinaLocal !== "todos" ? { local: cocinaLocal } : {};
        axios.get(`${API}/api/stock`, { params })
          .then(res => { if (!cancelado) { setStockData(res.data); setStockLoading(false); } })
          .catch(() => { if (!cancelado) { setStockData([]); setStockError("No se pudo cargar el stock. Reintentá o revisá la conexión."); setStockLoading(false); } });
        return () => { cancelado = true; };
      }, [vista, cocinaLocal]);

      // Refetch silencioso (sin spinner) para reconciliar tras producir.
      async function recargarStock() {
        try {
          const params = cocinaLocal !== "todos" ? { local: cocinaLocal } : {};
          const res = await axios.get(`${API}/api/stock`, { params });
          setStockData(res.data);
        } catch { /* dejamos el valor optimista si el refetch falla */ }
      }

      // Producir: optimista (suma al instante) + POST; si falla, revierte y avisa.
      async function producirCocina(clave, cantidadStr) {
        const cantidad = Number(cantidadStr);
        if (!Number.isFinite(cantidad) || cantidad <= 0) return;
        if (cocinaLocal === "todos") return; // el stock es por local
        const fecha = HOY;
        const snapshot = stockData;
        setStockData(curr => {
          const copia = curr.map(it => ({ ...it, porFecha: [...it.porFecha] }));
          let item = copia.find(it => it.clave_producto === clave);
          if (!item) { item = { clave_producto: clave, total_disponible: 0, porFecha: [] }; copia.push(item); }
          item.total_disponible += cantidad;
          const pf = item.porFecha.find(f => f.fecha_produccion === fecha && f.local === cocinaLocal);
          if (pf) pf.cantidad += cantidad;
          else item.porFecha.push({ fecha_produccion: fecha, local: cocinaLocal, cantidad });
          item.porFecha.sort((a, b) => (a.fecha_produccion < b.fecha_produccion ? -1 : 1));
          return copia;
        });
        setCocinaCant(prev => { const n = { ...prev }; delete n[clave]; return n; });
        try {
          await axios.post(`${API}/api/stock/producir`, { local: cocinaLocal, clave_producto: clave, cantidad });
          await recargarStock();
        } catch (e) {
          setStockData(snapshot); // revertir
          alert("No se pudo registrar la producción. " + (e.response?.data?.error || ""));
        }
      }

      // Descartar: baja stock por merma/perecedero (piccadas hechas que no se vendieron).
      // Confirma (destructivo), optimista (resta al instante) + POST; si falla, revierte.
      // fecha = "" -> FIFO general (lote más viejo); fecha concreta -> ese lote puntual.
      async function descartarStock(clave, cantidadStr, fecha) {
        const cantidad = Number(cantidadStr);
        if (!Number.isFinite(cantidad) || cantidad <= 0) return;
        if (cocinaLocal === "todos") return; // el stock es por local
        if (!window.confirm(`¿Descartar ${cantidad} ${cantidad === 1 ? "unidad" : "unidades"} de "${clave}"? Es para piccadas hechas que no se vendieron y no se puede deshacer.`)) return;
        const snapshot = stockData;
        setStockData(curr => {
          const copia = curr.map(it => ({ ...it, porFecha: it.porFecha.map(f => ({ ...f })) }));
          const item = copia.find(it => it.clave_producto === clave);
          if (!item) return curr;
          let restante = cantidad;
          // FIFO sobre los lotes candidatos (todos, o solo el de la fecha elegida).
          const lotes = item.porFecha
            .filter(f => !fecha || f.fecha_produccion === fecha)
            .sort((a, b) => (a.fecha_produccion < b.fecha_produccion ? -1 : 1));
          for (const f of lotes) {
            if (restante <= 0) break;
            const usar = Math.min(restante, f.cantidad);
            f.cantidad -= usar;
            restante -= usar;
          }
          item.porFecha = item.porFecha.filter(f => f.cantidad > 0);
          item.total_disponible = item.porFecha.reduce((a, f) => a + f.cantidad, 0);
          return copia;
        });
        setDescartar(null);
        try {
          await axios.post(`${API}/api/stock/descartar`, { local: cocinaLocal, clave_producto: clave, cantidad, fecha_produccion: fecha || undefined });
          await recargarStock();
        } catch (e) {
          setStockData(snapshot); // revertir
          alert("No se pudo descartar del stock. " + (e.response?.data?.error || ""));
        }
      }

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
            medioPago: ovDatos.medioPago || medioPagoLabel(p.gateway), medioPagoOtro: ovDatos.medioPagoOtro || "", gateway: p.gateway,
            esTakeaway: p.fulfillments?.[0]?.shipping?.type === "pickup",
            estado: local.estado, repartidor: local.repartidor, cobrar: local.cobrar, sobre: !!local.sobre, tarjeta: local.tarjeta || "no", tandaId: local.tandaId ?? null,
            tabActual, local: localLabel(tabActual),
            nota: ovDatos.nota !== undefined ? ovDatos.nota : (p.note || ""),
            esManual: false, esCorporativo: false, entreCalles: "",
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
            esCorporativo: ovDatos.esCorporativo !== undefined ? ovDatos.esCorporativo : (p.esCorporativo || false),
            cliente: ovDatos.cliente !== undefined ? ovDatos.cliente : p.cliente,
            telefono: ovDatos.telefono !== undefined ? ovDatos.telefono : p.telefono,
            direccion: ovDatos.direccion !== undefined ? ovDatos.direccion : p.direccion,
            barrio: ovDatos.barrio !== undefined ? ovDatos.barrio : p.barrio,
            zona: ovDatos.zona !== undefined ? ovDatos.zona : p.zona,
            medioPago: ovDatos.medioPago !== undefined ? ovDatos.medioPago : p.medioPago,
            medioPagoOtro: ovDatos.medioPagoOtro || "",
            nota: ovDatos.nota !== undefined ? ovDatos.nota : (p.nota || ""),
            email: ovDatos.email !== undefined ? ovDatos.email : (p.email || ""),
            estado: local.estado, repartidor: local.repartidor, sobre: !!local.sobre, tarjeta: local.tarjeta || "no", tandaId: local.tandaId ?? null,
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
        return true;
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
    // ─── ANULAR EN BLOQUE pedidos activos viejos ──────────────────────
      async function anularPasadosHasta() {
        setMenuAbierto(false);
        const corte = window.prompt("Anular todos los pedidos ACTIVOS con fecha hasta (incluida) esta fecha.\nFormato AAAA-MM-DD:", "2026-05-27");
        if (!corte) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(corte)) { alert("Fecha inválida. Usá AAAA-MM-DD, ej: 2026-05-27."); return; }
        const objetivo = pedidosActivos.filter(p => p.fechaDisplay && p.fechaDisplay <= corte);
        if (objetivo.length === 0) { alert(`No hay pedidos activos con fecha hasta ${corte}.`); return; }
        if (!window.confirm(`Vas a ANULAR ${objetivo.length} pedido(s) activo(s) con fecha hasta ${corte}.\n\n• NO se les manda mail al cliente.\n• La caja no se toca.\n• Quedan en la pestaña "Anulados" y se pueden reabrir.\n\n¿Confirmás?`)) return;
        let ok = 0, fail = 0;
        for (const p of objetivo) {
          const est = pedidosLocales[p.id] || {};
          try {
            await axios.post(`${API}/api/estados/${p.id}`, {
              estado: "Anulado", repartidor: est.repartidor || "Sin asignar",
              tabManual: est.tabManual ?? null, fechaManual: est.fechaManual ?? null,
              franjaManual: est.franjaManual ?? null, cobrar: est.cobrar ?? false,
              silencioso: true, motivoAnulacion: "Anulación masiva por antigüedad", usuario: usuario.nombre_completo,
            });
            ok++;
          } catch { fail++; }
        }
        alert(`✅ ${ok} pedido(s) anulado(s)${fail ? `, ${fail} fallaron` : ""}.\nRecargá para actualizar.`);
        window.location.reload();
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
        const motivo = window.prompt("Motivo de la anulación:");
        if (motivo === null || !motivo.trim()) return; // obligatorio: sin motivo no se anula
        actualizarLocal(p.id, { estado: "Anulado", motivoAnulacion: motivo.trim() });
      }

      function cambiarRepartidor(id, valor) { actualizarLocal(id, { repartidor: valor }); }
      function cambiarTab(id, valor) { actualizarLocal(id, { tabManual: valor }); }
      function cambiarCobrar(id, valor) { actualizarLocal(id, { cobrar: valor }); }
      // Marcador "tarjeta de regalo" (3 estados): no -> pendiente -> hecha -> no.
      // Ciclo optimista + PATCH dedicado. No pasa por /api/estados (no pisa estado/
      // repartidor) y sobrevive al poll de 30s, que no sobrescribe entradas existentes
      // de pedidosLocales. Si el PATCH falla, revierte y muestra el error.
      const TARJETA_SIGUIENTE = { no: "pendiente", pendiente: "hecha", hecha: "no" };
      async function ciclarTarjeta(id) {
        const previo = pedidosLocales[id]?.tarjeta || "no";
        const nuevo = TARJETA_SIGUIENTE[previo] || "pendiente";
        actualizarLocalSinGuardar(id, { tarjeta: nuevo });
        try {
          await axios.patch(`${API}/api/orders/${id}/tarjeta`, { tarjeta: nuevo });
        } catch (err) {
          actualizarLocalSinGuardar(id, { tarjeta: previo });
          setSobreError("No se pudo guardar la tarjeta. Reintentá.");
          setTimeout(() => setSobreError(""), 3000);
        }
      }

      // ─── TANDAS DE REPARTO (Fase 1) ──────────────────────────────────
      const avisoTanda = (msg) => { setTandaError(msg); setTimeout(() => setTandaError(""), 3500); };
      function entrarModoTanda() { setModoTandaLocal(localLabel(tab)); setSeleccionTanda([]); }
      function salirModoTanda() { setModoTandaLocal(null); setSeleccionTanda([]); }
      function toggleSeleccionTanda(id) {
        setSeleccionTanda(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
      }
      // Crea la tanda en el backend (POST /api/tandas) y la agrega a la lista local.
      // Reusada por el panel (confirmarTanda) y por el mapa (Fase 2). Devuelve la tanda creada.
      async function crearTanda({ pedidoIds, local, repartidor, nombre }) {
        const res = await axios.post(`${API}/api/tandas`, { nombre: nombre || null, repartidor, local, pedidoIds, usuario: usuario.nombre_completo });
        const tanda = res.data;
        setTandas(prev => [tanda, ...prev]);
        return tanda;
      }
      async function confirmarTanda() {
        if (!tandaRepartidor) { avisoTanda("Elegí un repartidor."); return; }
        if (seleccionTanda.length === 0) return;
        const ids = seleccionTanda;
        try {
          const tanda = await crearTanda({ pedidoIds: ids, local: modoTandaLocal, repartidor: tandaRepartidor, nombre: tandaNombre });
          ids.forEach(id => actualizarLocalSinGuardar(id, { tandaId: tanda.id })); // optimista: muestran su T{n}
          setConfirmandoTanda(false); setTandaNombre(""); setTandaRepartidor("");
          salirModoTanda();
        } catch (err) {
          avisoTanda("No se pudo crear la tanda. Reintentá.");
        }
      }
      // Agrega los pedidos seleccionados a una tanda 'armada' existente (inverso del quitar).
      // Optimista: les pone el tandaId al instante; si el backend rechaza alguno (carrera:
      // ya en tanda u otro local) lo revierte y avisa.
      async function agregarPedidosATanda(tandaId) {
        if (!tandaId || seleccionTanda.length === 0) return;
        const ids = [...seleccionTanda];
        ids.forEach(id => actualizarLocalSinGuardar(id, { tandaId }));
        salirModoTanda();
        try {
          const res = await axios.post(`${API}/api/tandas/${tandaId}/pedidos`, { pedidoIds: ids, usuario: usuario.nombre_completo });
          const rechazados = res.data?.rechazados || [];
          if (rechazados.length) {
            rechazados.forEach(r => actualizarLocalSinGuardar(r.id, { tandaId: null }));
            avisoTanda(`${rechazados.length} pedido(s) no se pudieron agregar (ya en tanda u otro local).`);
          }
        } catch (err) {
          ids.forEach(id => actualizarLocalSinGuardar(id, { tandaId: null }));
          avisoTanda("No se pudieron agregar los pedidos a la tanda. Reintentá.");
        }
      }
      // Optimista con revert: aplica cambios locales, dispara el PATCH y si falla revierte.
      async function patchTanda(t, body, aplicar, revertir) {
        aplicar();
        try {
          await axios.patch(`${API}/api/tandas/${t.id}`, { ...body, usuario: usuario.nombre_completo });
        } catch (err) {
          revertir();
          avisoTanda("No se pudo actualizar la tanda. Reintentá.");
        }
      }
      function despacharTanda(t) {
        const ids = pedidosProcesados.filter(p => p.tandaId === t.id).map(p => p.id);
        const previos = ids.map(id => ({ id, estado: pedidosLocales[id]?.estado, repartidor: pedidosLocales[id]?.repartidor }));
        patchTanda(t, { estado: "en_reparto" },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: "en_reparto" } : x)); ids.forEach(id => actualizarLocalSinGuardar(id, { estado: "En camino", repartidor: t.repartidor })); },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: "armada" } : x)); previos.forEach(pv => actualizarLocalSinGuardar(pv.id, { estado: pv.estado, repartidor: pv.repartidor })); });
      }
      function entregarTanda(t) {
        if (!window.confirm(`¿Marcar la Tanda #${t.id} como entregada? Sus pedidos pasan a Entregado.`)) return;
        const ids = pedidosProcesados.filter(p => p.tandaId === t.id).map(p => p.id);
        const previos = ids.map(id => ({ id, estado: pedidosLocales[id]?.estado }));
        patchTanda(t, { estado: "entregada" },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: "entregada" } : x)); ids.forEach(id => actualizarLocalSinGuardar(id, { estado: "Entregado" })); },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: "en_reparto" } : x)); previos.forEach(pv => actualizarLocalSinGuardar(pv.id, { estado: pv.estado })); });
      }
      function deshacerTanda(t) {
        if (!window.confirm(`¿Deshacer la Tanda #${t.id}? Sus pedidos vuelven al pool (no cambia su estado).`)) return;
        const ids = pedidosProcesados.filter(p => p.tandaId === t.id).map(p => p.id);
        patchTanda(t, { estado: "cancelada" },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: "cancelada" } : x)); ids.forEach(id => actualizarLocalSinGuardar(id, { tandaId: null })); },
          () => { setTandas(prev => prev.map(x => x.id === t.id ? { ...x, estado: t.estado } : x)); ids.forEach(id => actualizarLocalSinGuardar(id, { tandaId: t.id })); });
      }
      async function quitarDeTanda(id) {
        const previo = pedidosLocales[id]?.tandaId ?? null;
        actualizarLocalSinGuardar(id, { tandaId: null });
        try {
          await axios.patch(`${API}/api/orders/${id}/tanda`, { tandaId: null });
        } catch (err) {
          actualizarLocalSinGuardar(id, { tandaId: previo });
          avisoTanda("No se pudo quitar el pedido de la tanda. Reintentá.");
        }
      }
      // Card de pedido activo (reusada por el panel y por la vista "Tandas activas").
      // seleccionable = true sólo en modo "armar tanda" del panel (muestra checkbox).
      function renderCardPedidoActivo(p, seleccionable) {
                    const estadoActual = pedidosLocales[p.id]?.estado || "Por empaquetar";
                    const repartidorActual = pedidosLocales[p.id]?.repartidor || "Sin asignar";
                    const tabActual = pedidosLocales[p.id]?.tabManual || p.tabActual;
                    const fechaManual = pedidosLocales[p.id]?.fechaManual || p.fecha || "";
                    const franjaManual = pedidosLocales[p.id]?.franjaManual || p.franja || "";
                    const cobrar = pedidosLocales[p.id]?.cobrar;
                    const tarjetaActual = pedidosLocales[p.id]?.tarjeta || "no";
                    const tui = ({
                      no:        { stroke: "#9ca3af", bg: "transparent", title: "No lleva tarjeta" },
                      pendiente: { stroke: "#dc2626", bg: "#fde8e8",     title: "Lleva tarjeta — pendiente" },
                      hecha:     { stroke: "#499342", bg: "#eaf3de",     title: "Tarjeta hecha" },
                    })[tarjetaActual] || { stroke: "#9ca3af", bg: "transparent", title: "No lleva tarjeta" };
                    const abierto = expandido === p.id;
                    const esCorp = p.esManual && p.esCorporativo; // violeta clarito (solo manuales corporativos)
                    const ec = ESTADO_COLORS[estadoActual] || { bg: "#f0f0e8", text: "#555" };
                    const ahora = new Date();
                    const fechaPedido = p.fechaDisplay || "";
                    const franjaMatch = (p.franjaDisplay || "").match(/(\d{1,2}):(\d{2})/);
                    const horaInicio = franjaMatch ? new Date(`${fechaPedido}T${String(franjaMatch[1]).padStart(2,"0")}:${franjaMatch[2]}:00`) : null;
                    const minutosVencido = horaInicio ? Math.floor((ahora - horaInicio) / 60000) : 0;
                    const estaProximo = horaInicio && ahora >= new Date(horaInicio.getTime() - 60 * 60000) && ahora < horaInicio && fechaPedido === HOY && estadoActual !== "En camino" && estadoActual !== "Entregado";
const estaVencido = horaInicio && ahora >= horaInicio && fechaPedido === HOY && estadoActual !== "En camino" && estadoActual !== "Entregado";
                    return (
                      <div key={p.id} style={{ ...s.fila, ...(abierto ? s.filaAbierta : {}), ...(!abierto && esCorp && !estaVencido && !estaProximo ? { background: "#ede9fe" } : {}), ...(estaVencido ? { background: "#f5b7b1", borderLeft: "4px solid #922b21" } : estaProximo ? { background: "#fdecea", borderLeft: "4px solid #c0392b" } : {}) }}>
                        <div style={{ ...s.filaTop, ...(abierto && esCorp ? { background: "#ede9fe" } : {}) }} onClick={() => toggleExpandido(p.id)}>
                          {seleccionable && p.local === modoTandaLocal && !p.tandaId && (
                            <input type="checkbox" checked={seleccionTanda.includes(p.id)} onClick={e => e.stopPropagation()} onChange={() => toggleSeleccionTanda(p.id)} style={{ marginRight: 8, transform: "scale(1.25)", cursor: "pointer" }} />
                          )}
                          <span style={{ ...s.cel, flex: 1.2 }}>
                            <span style={s.numero}>{p.numero}</span>{p.tandaId && <span title={`En la tanda #${p.tandaId}`} style={{ fontSize: 11, fontWeight: 700, background: "#7c3aed", color: "#fff", padding: "1px 7px", borderRadius: 4, marginLeft: 6 }}>T{p.tandaId}</span>}{!comandasImpresas[p.id] && <span style={s.nuevoBadge}>● NUEVO</span>} {p.cliente}
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
                          <button title={tui.title} onClick={e => { e.stopPropagation(); ciclarTarjeta(p.id); }}
                            style={{ background: tui.bg, border: "none", borderRadius: 6, cursor: "pointer", padding: "4px 6px", marginLeft: 4, display: "inline-flex", alignItems: "center", lineHeight: 0 }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={tui.stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="2" y="4" width="20" height="16" rx="2" />
                              <path d="m22 7-10 5L2 7" />
                            </svg>
                          </button>
                          <span style={s.chevron}>{abierto ? "▲" : "▼"}</span>
                        </div>
                        {abierto && (
                          <div style={s.detalle}>
                            {/* DATOS EDITABLES */}
                            <div style={{ fontSize: 10, fontWeight: 700, color: "#F68B32", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
                              📋 Datos del pedido <span style={{ color: "#aaa", fontWeight: 400 }}>(guardado automático al salir del campo)</span>
                            </div>
                            <div style={{ ...s.detalleGrid, marginBottom: 14 }}>
                              {p.esManual && (
                                <div style={{ ...s.detalleBloque, gridColumn: "span 2" }}>
                                  <div style={s.detalleLabel}>Tipo de pedido</div>
                                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13 }} onClick={e => e.stopPropagation()}>
                                    <input type="checkbox" checked={!!p.esCorporativo} onChange={e => { e.stopPropagation(); actualizarDato(p, "esCorporativo", e.target.checked); }} onClick={e => e.stopPropagation()} />
                                    <span style={{ color: p.esCorporativo ? "#6d28d9" : "#888", fontWeight: p.esCorporativo ? 600 : 400 }}>🏢 Pedido corporativo</span>
                                  </label>
                                </div>
                              )}
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
                                {p.medioPago === "Otro" && (
                                  <InputBlur style={{ ...s.inputField, marginTop: 4 }} initialValue={p.medioPagoOtro || ""} placeholder="¿Cuál? (ej: Cheque, Canje)"
                                    onCommit={v => actualizarDato(p, "medioPagoOtro", v)} onClick={e => e.stopPropagation()} />
                                )}
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
                                  <span style={{ fontSize: 12, color: cobrar ? "#c0392b" : "#888", fontWeight: cobrar ? 600 : 400 }}>{cobrar ? "⚠️ COBRAR" : "Cobrar"}</span>
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
      }

      // ─── BACKFILL FECHAS: corregir pedidos sin fecha ───────────────────
      async function corregirPedidosSinFecha() {
        setMenuAbierto(false);
        const sinFecha = pedidosProcesados.filter(p => !p.fechaDisplay);
        if (sinFecha.length === 0) { alert("👍 No hay pedidos sin fecha."); return; }
        const conFecha = sinFecha.map(p => {
          const m = String(p.id).match(/^manual-(\d+)$/);
          return { ...p, fechaCreacion: m ? fechaArgentina(new Date(Number(m[1]))) : "" };
        });
        const porFecha = {};
        conFecha.forEach(p => { const f = p.fechaCreacion || "(no deducible)"; porFecha[f] = (porFecha[f] || 0) + 1; });
        const resumen = Object.entries(porFecha).sort().map(([f, n]) => `   ${f}: ${n}`).join("\n");
        const noDeducibles = conFecha.filter(p => !p.fechaCreacion).length;
        const msg = `Encontré ${sinFecha.length} pedido(s) sin fecha.\n\nFecha de creación de cada uno:\n${resumen}\n\nSe le asignará a cada pedido SU fecha de creación. Ojo: esto los suma a la caja de ese día; si esa caja ya estaba cerrada, su cierre va a cambiar.${noDeducibles ? `\n\n(${noDeducibles} no se pudieron deducir; se saltean.)` : ""}\n\n¿Aplicar?`;
        if (!window.confirm(msg)) return;
        let ok = 0, fail = 0;
        for (const p of conFecha) {
          if (!p.fechaCreacion) { fail++; continue; }
          const est = pedidosLocales[p.id] || {};
          try {
            await axios.post(`${API}/api/estados/${p.id}`, {
              estado: est.estado || "Entregado", repartidor: est.repartidor || "Sin asignar",
              tabManual: est.tabManual ?? null, fechaManual: p.fechaCreacion,
              franjaManual: est.franjaManual ?? null, cobrar: est.cobrar ?? false,
              usuario: usuario.nombre_completo,
            });
            ok++;
          } catch { fail++; }
        }
        alert(`✅ Listo: ${ok} con fecha asignada${fail ? `, ${fail} no se pudieron` : ""}.\nRecargá para ver los cambios.`);
        window.location.reload();
      }
      function toggleExpandido(id) { setExpandido(prev => prev === id ? null : id); }
      function repartidorReporte(p) {
        const r = p.repartidor;
        if (r && r !== "Sin asignar") return r;
        if (p.tabActual === "retiro-at" || p.tabActual === "retiro-fr") return "Retiro en sucursal";
        return "Sin asignar";
      }
      function medioPagoReporte(p) {
        return (p.medioPago === "Otro" && p.medioPagoOtro) ? `Otro — ${p.medioPagoOtro}` : p.medioPago;
      }
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
          medioPagoOtro: nuevosOverrides.medioPagoOtro !== undefined ? nuevosOverrides.medioPagoOtro : (p.medioPagoOtro || ""),
          esCorporativo: nuevosOverrides.esCorporativo !== undefined ? nuevosOverrides.esCorporativo : (p.esCorporativo || false),
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
          nota: form.nota, esManual: true, esCorporativo: form.esCorporativo, estado: "Por empaquetar", repartidor: "Sin asignar",
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

        const lineas = comandaLineasESCPOS(p, estadoActual, repartidorActual, cobrar);

        const fallback = () => {
          const ventana = window.open("", "_blank", "width=400,height=600");
          ventana.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comanda ${p.numero}</title>
            <style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family:'Courier New',monospace; font-size:12px; width:80mm; padding:4mm; color:#000; } .centro { text-align:center; } .titulo { font-size:18px; font-weight:bold; margin-bottom:2px; } .linea { border-top:1px dashed #000; margin:6px 0; } .fila { display:flex; justify-content:space-between; margin:2px 0; } .label { font-weight:bold; font-size:10px; text-transform:uppercase; color:#555; margin-top:6px; margin-bottom:1px; } .valor { font-size:12px; } .total { font-size:15px; font-weight:bold; text-align:right; margin-top:4px; } .cobrar { text-align:center; font-size:16px; font-weight:bold; border:2px solid #000; padding:6px; margin:8px 0; } @media print { body { width:80mm; } @page { margin:0; size:80mm auto; } }</style></head><body>
            <div class="centro"><div class="titulo">Piccadely</div><div style="font-size:11px;">comanda de pedido</div></div>
            <div class="linea"></div>
            <div class="fila" style="font-size:15px;"><span><b>${p.numero}</b></span><span>${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "-"}</span></div>
            <div class="fila" style="font-size:15px;"><span>${p.franjaDisplay}</span><span>${p.zona || ""}</span></div>
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

        await imprimirRawQZ(lineas.join(""), fallback);
      }

      // ─── IMPRIMIR COMANDAS EN LOTE (HOY · sucursal del tab · no impresas) ───
      // La sucursal "seleccionada" es la del tab activo: cada tab es retiro/delivery
      // de un local (localLabel(tab) → "A. Thomas" | "French"). Pendientes = pedidos
      // activos de HOY de esa sucursal cuyo contador de comandas impresas está en 0.
      const sucursalSeleccionada = localLabel(tab);
      const comandasPendientes = pedidosActivos.filter(p => {
        const est = pedidosLocales[p.id]?.estado || p.estado;
        if (est === "Anulado" || est === "Entregado") return false;
        if (p.fechaDisplay !== HOY) return false;
        if (p.local !== sucursalSeleccionada) return false;
        return (comandasImpresas[p.id] || 0) === 0;
      });
      async function imprimirComandasLote() {
        if (comandasPendientes.length === 0) return;
        if (!window.confirm(`¿Imprimir ${comandasPendientes.length} comanda${comandasPendientes.length > 1 ? "s" : ""}?`)) return;
        const lote = comandasPendientes;
        const datos = lote.map(p => ({
          p,
          estadoActual: pedidosLocales[p.id]?.estado || "Por empaquetar",
          repartidorActual: pedidosLocales[p.id]?.repartidor || "Sin asignar",
          cobrar: pedidosLocales[p.id]?.cobrar,
        }));

        // QZ Tray: una sola tirada con todas las comandas concatenadas. Cada
        // comanda ya termina con su corte de papel ("\x1D\x56\x00"), así que el
        // corte entre comandas sale solo. Mismo template ESC/POS que la individual.
        const dataLote = datos.map(d => comandaLineasESCPOS(d.p, d.estadoActual, d.repartidorActual, d.cobrar).join("")).join("");

        // Fallback (sin QZ): un solo documento HTML, una comanda por página
        // (break-after: page), un único window.print(). Mismo template individual.
        const fallbackLote = () => {
          const bloques = datos.map(({ p, estadoActual, repartidorActual, cobrar }) => `<div class="comanda">
            <div class="centro"><div class="titulo">Piccadely</div><div style="font-size:11px;">comanda de pedido</div></div>
            <div class="linea"></div>
            <div class="fila" style="font-size:15px;"><span><b>${p.numero}</b></span><span>${p.fechaDisplay ? new Date(p.fechaDisplay+"T12:00:00").toLocaleDateString("es-AR",{day:"numeric",month:"long"}) : "-"}</span></div>
            <div class="fila" style="font-size:15px;"><span>${p.franjaDisplay}</span><span>${p.zona || ""}</span></div>
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
          </div>`).join("");
          const ventana = window.open("", "_blank", "width=400,height=600");
          ventana.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Comandas (${lote.length})</title>
            <style>* { margin:0; padding:0; box-sizing:border-box; } body { font-family:'Courier New',monospace; font-size:12px; color:#000; } .comanda { width:80mm; padding:4mm; } .comanda:not(:last-child) { break-after:page; page-break-after:always; } .centro { text-align:center; } .titulo { font-size:18px; font-weight:bold; margin-bottom:2px; } .linea { border-top:1px dashed #000; margin:6px 0; } .fila { display:flex; justify-content:space-between; margin:2px 0; } .label { font-weight:bold; font-size:10px; text-transform:uppercase; color:#555; margin-top:6px; margin-bottom:1px; } .valor { font-size:12px; } .total { font-size:15px; font-weight:bold; text-align:right; margin-top:4px; } .cobrar { text-align:center; font-size:16px; font-weight:bold; border:2px solid #000; padding:6px; margin:8px 0; } @media print { @page { margin:0; size:80mm auto; } }</style></head><body>
            ${bloques}
            <script>window.onload=function(){window.print();}<\/script></body></html>`);
          ventana.document.close();
        };

        await imprimirRawQZ(dataLote, fallbackLote);

        // Marcado optimista (sale de "pendientes" al instante) + endpoint en loop.
        // Si alguna falla, el contador local queda igual que en la impresión individual
        // y el botón individual de cada pedido sigue disponible para reimprimir esa sola.
        lote.forEach(p => {
          setComandasImpresas(prev => ({ ...prev, [p.id]: (prev[p.id] || 0) + 1 }));
          axios.post(`${API}/api/pedidos/${p.id}/imprimir`, { usuario: usuario.nombre_completo })
            .then(res => setComandasImpresas(prev => ({ ...prev, [p.id]: res.data.comandasImpresas })))
            .catch(() => {});
        });
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
                  {usuario.rol === "admin" && (
                    <>
                      <button
                        style={{ ...s.dropItem, fontWeight: 700, color: "#444", background: "#fafaf8", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                        onClick={() => setMenuGrupo(g => g === "admin" ? "" : "admin")}>
                        <span>🛠️ Administración</span>
                        <span style={{ fontSize: 10, color: "#aaa" }}>{menuGrupo === "admin" ? "▾" : "▸"}</span>
                      </button>
                      {menuGrupo === "admin" && (
                        <>
                          <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("usuarios"); setMenuAbierto(false); }}>👥 Usuarios</button>
                          <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("repartidores"); setMenuAbierto(false); }}>🚚 Repartidores</button>
                          <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={async () => {
                            setMenuAbierto(false);
                            if (!window.confirm("¿Resincronizar TODOS los pedidos desde Tienda Nube? Puede tardar 1-2 minutos.")) return;
                            try {
                              const res = await axios.post(`${API}/api/admin/backfill-orders`);
                              alert(`✅ Resincronización completa: ${res.data.totalSynced} pedidos actualizados en ${res.data.totalPages} páginas.`);
                              window.location.reload();
                            } catch (err) { alert("❌ Error: " + (err.response?.data?.error || err.message)); }
                          }}>🔄 Resincronizar TN</button>
                          <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={corregirPedidosSinFecha}>🗓️ Corregir pedidos sin fecha</button>
                          <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={anularPasadosHasta}>🗑️ Anular pedidos viejos</button>
                        </>
                      )}
                    </>
                  )}
                  <button
                    style={{ ...s.dropItem, fontWeight: 700, color: "#444", background: "#fafaf8", display: "flex", justifyContent: "space-between", alignItems: "center" }}
                    onClick={() => setMenuGrupo(g => g === "reportes" ? "" : "reportes")}>
                    <span>📊 Reportes</span>
                    <span style={{ fontSize: 10, color: "#aaa" }}>{menuGrupo === "reportes" ? "▾" : "▸"}</span>
                  </button>
                  {menuGrupo === "reportes" && (
                    <>
                      {usuario.rol === "admin" && <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("dashboard"); setMenuAbierto(false); }}>📈 Dashboard ejecutivo</button>}
                      <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("reporteVentas"); setMenuAbierto(false); }}>📊 Reporte de ventas</button>
                      <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("reporteReservas"); setMenuAbierto(false); }}>📅 Reporte de reservas</button>
                      <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("reporteProductos"); setMenuAbierto(false); }}>📦 Productos vendidos</button>
                      {usuario.rol === "admin" && <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("reporteFusionado"); setMenuAbierto(false); }}>🧾 Vendido / Por vender</button>}
                      {usuario.rol === "admin" && <button style={{ ...s.dropItem, paddingLeft: 30, fontSize: 12, color: "#555" }} onClick={() => { setVista("zonas"); setMenuAbierto(false); }}>📍 Pedidos por zona</button>}
                    </>
                  )}
                  <button style={s.dropItem} onClick={() => { setVista("tandas"); setMenuAbierto(false); }}>🚚 Tandas activas</button>
                  <button style={s.dropItem} onClick={() => { setVista("caja"); setMenuAbierto(false); }}>💰 Caja</button>
                  {usuario.rol === "admin" && <button style={s.dropItem} onClick={() => { setVista("importar"); setMenuAbierto(false); }}>📥 Importar pedidos</button>}
                  <button style={s.dropItem} onClick={() => { setVista("finalizados"); setMenuAbierto(false); }}>📋 Pedidos finalizados</button>
                  <button style={s.dropItem} onClick={() => { setVista("cotizaciones"); setMenuAbierto(false); }}>🎉 Cotizaciones</button>
                  <button style={s.dropItem} onClick={() => { setVista("produccion"); setMenuAbierto(false); }}>🔧 Análisis de producción</button>
                  <button style={s.dropItem} onClick={() => { setVista("cocina"); setMenuAbierto(false); }}>🍳 Tablero de cocina</button>
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
      if (vista === "cotizaciones") {
        return <div style={s.wrap}><Header /><VistaCotizaciones onVolver={() => setVista("panel")} /></div>;
      }
      if (vista === "usuarios") {
        return <div style={s.wrap}><Header /><Usuarios onVolver={() => setVista("panel")} /></div>;
      }
      if (vista === "caja") {
        return <div style={s.wrap}><Header /><VistaCaja pedidosFinalizados={pedidosFinalizados} pedidosActivos={pedidosActivos} onVolver={() => setVista("panel")} usuario={usuario} /></div>;
      }
if (vista === "dashboard") {
        const filtrarVentas = (desde, hasta) => repPedidos.filter(p => {
          const est = p.estado;
          if (est === "Anulado") return false;
          if (!p.fechaDisplay) return false;
          if (p.fechaDisplay < desde || p.fechaDisplay > hasta) return false;
          if (dashOrigen === "manual" && !p.esManual) return false;
          if (dashOrigen === "online" && p.esManual) return false;
          return true;
        });
        const ventasAct = filtrarVentas(dashDesde, dashHasta);
        // Período anterior: en "semana", mismo tramo de la semana pasada; en "custom",
        // misma duración inmediatamente anterior. (ver rangoAnterior)
        const { prevDesde, prevHasta } = rangoAnterior(dashModo, dashDesde, dashHasta);
        const ventasPrev = filtrarVentas(prevDesde, prevHasta);
        const totalAct = ventasAct.reduce((a, p) => a + p.totalNum, 0);
        const totalPrev = ventasPrev.reduce((a, p) => a + p.totalNum, 0);
        const variacion = totalPrev > 0 ? ((totalAct - totalPrev) / totalPrev) * 100 : null;
        const ticketProm = ventasAct.length > 0 ? totalAct / ventasAct.length : 0;
        const porMedioDash = MEDIOS_PAGO.map(m => {
          const lista = ventasAct.filter(p => p.medioPago === m);
          return { medio: m, total: lista.reduce((a, p) => a + p.totalNum, 0), cantidad: lista.length };
        }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
        const totalAT = ventasAct.filter(p => p.local === "A. Thomas").reduce((a, p) => a + p.totalNum, 0);
        const totalFR = ventasAct.filter(p => p.local === "French").reduce((a, p) => a + p.totalNum, 0);
        const pctAT = totalAct > 0 ? Math.round((totalAT / totalAct) * 100) : 0;
        const pctFR = totalAct > 0 ? Math.round((totalFR / totalAct) * 100) : 0;
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>📈 Dashboard ejecutivo</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={dashDesde} onChange={e => { setDashDesde(e.target.value); setDashModo("custom"); }} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={dashHasta} onChange={e => { setDashHasta(e.target.value); setDashModo("custom"); }} />
                  <button style={s.btnVolver} onClick={() => { setDashModo("semana"); setDashDesde(lunesDeLaSemana(HOY)); setDashHasta(HOY); }}>Esta semana</button>
                  <button style={s.btnVolver} onClick={() => { setDashModo("custom"); setDashDesde(HOY.slice(0, 8) + "01"); setDashHasta(HOY); }}>Este mes</button>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Origen:</span>
                {[{ id: "todos", label: "🧾 Todos" }, { id: "online", label: "🌐 Online (web)" }, { id: "manual", label: "✍️ Manual" }].map(opt => (
                  <button key={opt.id} onClick={() => setDashOrigen(opt.id)}
                    style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: dashOrigen === opt.id ? "#F68B32" : "#ddd", background: dashOrigen === opt.id ? "#F68B32" : "#fff", color: dashOrigen === opt.id ? "#fff" : "#555", fontWeight: dashOrigen === opt.id ? 600 : 400 }}>
                    {opt.label}
                  </button>
                ))}
              </div>
              {repLoading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Cargando datos históricos…</div>
              ) : repError ? (
                <div style={{ padding: "20px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {repError}</div>
              ) : (<>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
                <div style={{ background: "#F68B32", borderRadius: 10, padding: "16px 18px", color: "#fff" }}>
                  <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Ventas del período</div>
                  <div style={{ fontSize: 26, fontWeight: 700 }}>{fmt(totalAct)}</div>
                  <div style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}>{ventasAct.length} pedidos</div>
                </div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: "16px 18px" }}>
                  <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Período anterior</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{fmt(totalPrev)}</div>
                  {variacion !== null ? (
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4, color: variacion >= 0 ? "#1a9c4b" : "#c0392b" }}>
                      {variacion >= 0 ? "↑" : "↓"} {Math.abs(variacion).toFixed(1)}% {dashModo === "semana" ? "vs semana pasada" : "vs período anterior"}
                    </div>
                  ) : <div style={{ fontSize: 12, color: "#aaa", marginTop: 4 }}>Sin datos previos</div>}
                </div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: "16px 18px" }}>
                  <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 }}>Ticket promedio</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{fmt(Math.round(ticketProm))}</div>
                </div>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 10 }}>💳 Por medio de cobro</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, marginBottom: 24 }}>
                {porMedioDash.length === 0 && <div style={{ fontSize: 13, color: "#aaa" }}>Sin ventas en este período.</div>}
                {porMedioDash.map(x => (
                  <div key={x.medio} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>{x.medio}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: "#F68B32" }}>{fmt(x.total)}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{totalAct > 0 ? Math.round((x.total / totalAct) * 100) : 0}% · {x.cantidad} pedidos</div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "#333", marginBottom: 10 }}>📍 Por local</div>
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 18, maxWidth: 520 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>A. Thomas</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(totalAT)} <span style={{ color: "#aaa", fontWeight: 400 }}>({pctAT}%)</span></span>
                </div>
                <div style={{ height: 8, background: "#eee", borderRadius: 4, overflow: "hidden", marginBottom: 14 }}>
                  <div style={{ width: `${pctAT}%`, height: "100%", background: "#F68B32" }} />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: "#333" }}>French</span>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{fmt(totalFR)} <span style={{ color: "#aaa", fontWeight: 400 }}>({pctFR}%)</span></span>
                </div>
                <div style={{ height: 8, background: "#eee", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${pctFR}%`, height: "100%", background: "#0c447c" }} />
                </div>
              </div>
              </>)}
            </div>
          </div>
        );
      }
      // Render compartido entre "Reporte de ventas" (finalizados, vía repPedidos)
      // y "Reporte de reservas" (pedidos activos a futuro). Misma presentación,
      // tarjetas por medio de pago, totales, filtros y exports. El modo sólo
      // cambia título/archivo/etiquetas; la lógica de agregación es idéntica.
      const renderReporteVR = ({ pedidos, titulo, tituloExport, emoji, fileBase, sheetName, emptyMsg, loading, error, desde, setDesde, hasta, setHasta, medio, setMedio, repartidor, setRepartidor, local, setLocal, tipo, setTipo, turno, setTurno }) => {
        const conTurno = !!setTurno; // el filtro/desglose por turno solo se activa donde se pasa (reservas)
        const filtradas = pedidos.filter(p => {
          const est = p.estado;
          if (est === "Anulado") return false;
          if (desde && p.fechaDisplay && p.fechaDisplay < desde) return false;
          if (hasta && p.fechaDisplay && p.fechaDisplay > hasta) return false;
          if (medio && p.medioPago !== medio) return false;
          if (repartidor && (p.repartidor || "Sin asignar") !== repartidor) return false;
          if (local && p.local !== local) return false;
          // Tipo de entrega: "" no filtra. Retiro/Delivery por p.tabActual (retiro-*/delivery-*).
          if (tipo && (tipo === "retiro") !== String(p.tabActual || "").startsWith("retiro")) return false;
          // Turno por hora de inicio de franja ("" no filtra). Solo cuando conTurno.
          if (turno && turnoDe(p.franjaDisplay) !== turno) return false;
          if ((desde || hasta) && !p.fechaDisplay) return false;
          return true;
        }).sort((a, b) => { if (!a.fechaDisplay) return 1; if (!b.fechaDisplay) return -1; return b.fechaDisplay.localeCompare(a.fechaDisplay); });
        const totalGeneral = filtradas.reduce((acc, p) => acc + p.totalNum, 0);
        const porMedio = MEDIOS_PAGO.reduce((acc, m) => { acc[m] = filtradas.filter(p => p.medioPago === m).reduce((a, p) => a + p.totalNum, 0); return acc; }, {});
        const tag = fechaTagArchivo(desde, hasta);
        const exportarVRExcel = () => {
          const datos = filtradas.map(p => ({ "Nº": p.numero, "Cliente": p.cliente, "Productos": p.productos, "Medio de pago": p.medioPago, "Código MKP": p.codigoPago || "", "Repartidor": repartidorReporte(p), "Fecha": p.fechaDisplay || "", "Local": p.local, "Total": p.totalNum, ...(conTurno ? { "Turno": turnoDe(p.franjaDisplay) } : {}) }));
          const resumen = MEDIOS_PAGO.filter(m => porMedio[m] > 0).map(m => ({ "Medio de pago": m, "Pedidos": filtradas.filter(p => p.medioPago === m).length, "Total": porMedio[m] }));
          resumen.push({ "Medio de pago": "TOTAL GENERAL", "Pedidos": filtradas.length, "Total": totalGeneral });
          const sheets = [{ name: sheetName, data: datos }, { name: "Resumen", data: resumen }];
          if (conTurno) {
            // Desglose por turno (orden canónico), refleja el filtro aplicado.
            const porTurno = TURNOS_ORDEN
              .map(t => { const ped = filtradas.filter(p => turnoDe(p.franjaDisplay) === t); return { "Turno": t, "Pedidos": ped.length, "Total": ped.reduce((a, p) => a + p.totalNum, 0) }; })
              .filter(r => r["Pedidos"] > 0);
            if (porTurno.length) sheets.push({ name: "Por turno", data: porTurno });
          }
          exportarExcel(`${fileBase}_${tag}.xlsx`, sheets);
        };
        const exportarVRPDF = () => {
          const filas = filtradas.map(p => [p.numero, p.cliente, p.productos.length > 50 ? p.productos.substring(0, 50) + "..." : p.productos, p.medioPago, p.codigoPago || "—", p.fechaDisplay || "—", p.local, fmt(p.totalNum)]);
          const subt = (desde || hasta) ? `Desde ${desde || "inicio"} hasta ${hasta || "hoy"}` : "Todas las fechas";
          exportarPDF(`${fileBase}_${tag}.pdf`, tituloExport, ["Nº", "Cliente", "Productos", "Medio pago", "Cód. MKP", "Fecha", "Local", "Total"], filas, `Total: ${fmt(totalGeneral)}  ·  ${filtradas.length} pedidos`, subt);
        };
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>{emoji} {titulo}</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={desde} onChange={e => setDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={hasta} onChange={e => setHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={medio} onChange={e => setMedio(e.target.value)}>
                    <option value="">Todos los medios</option>
                    {MEDIOS_PAGO.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select style={{ ...s.select, padding: "5px 8px" }} value={repartidor} onChange={e => setRepartidor(e.target.value)}>
                    <option value="">Todos los repartidores</option>
                    {repartidoresLista.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <select style={{ ...s.select, padding: "5px 8px" }} value={local} onChange={e => setLocal(e.target.value)}>
                    <option value="">Todos los locales</option>
                    <option value="A. Thomas">A. Thomas</option>
                    <option value="French">French</option>
                  </select>
                  <select style={{ ...s.select, padding: "5px 8px" }} value={tipo} onChange={e => setTipo(e.target.value)}>
                    <option value="">Todos</option>
                    <option value="retiro">Retiro</option>
                    <option value="delivery">Delivery</option>
                  </select>
                  {conTurno && (
                    <select style={{ ...s.select, padding: "5px 8px" }} value={turno} onChange={e => setTurno(e.target.value)}>
                      <option value="">Turno: todos</option>
                      {TURNOS_ORDEN.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                  )}
                  {(desde || hasta || medio || repartidor || local || tipo || turno) && (
                    <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setDesde(""); setHasta(""); setMedio(""); setRepartidor(""); setLocal(""); setTipo(""); if (setTurno) setTurno(""); }}>✕ Limpiar</button>
                  )}
                  {filtradas.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarVRExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarVRPDF}>📄 PDF</button></>)}
                </div>
              </div>
              {loading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Cargando datos históricos…</div>
              ) : error ? (
                <div style={{ padding: "20px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {error}</div>
              ) : (<>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                {MEDIOS_PAGO.filter(m => porMedio[m] > 0).map(m => (
                  <div key={m} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}>
                    <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>{m}</div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: "#F68B32" }}>{fmt(porMedio[m])}</div>
                    <div style={{ fontSize: 11, color: "#aaa" }}>{filtradas.filter(p => p.medioPago === m).length} pedidos</div>
                  </div>
                ))}
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 14px" }}>
                  <div style={{ fontSize: 11, color: "#a8d5b5", marginBottom: 4 }}>TOTAL</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>{fmt(totalGeneral)}</div>
                  <div style={{ fontSize: 11, color: "#a8d5b5" }}>{filtradas.length} pedidos</div>
                </div>
              </div>
              <div style={s.lista}>
                <div style={s.cabecera}>
                  <span style={{ ...s.col, flex: 0.6 }}>Nº</span><span style={{ ...s.col, flex: 1.5 }}>Cliente</span>
                  <span style={{ ...s.col, flex: 1 }}>Productos</span><span style={{ ...s.col, flex: 0.8 }}>Medio de pago</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Fecha</span><span style={{ ...s.col, flex: 0.7, textAlign: "center" }}>Local</span>
                  <span style={{ ...s.col, flex: 0.7, textAlign: "right" }}>Monto</span>
                </div>
                {filtradas.length === 0 && <div style={s.empty}>{emptyMsg}</div>}
                {filtradas.map(p => (
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
                {filtradas.length > 0 && <div style={{ display: "flex", justifyContent: "flex-end", padding: "12px 14px", borderTop: "2px solid #eee", fontWeight: 700, fontSize: 14, color: "#F68B32" }}>Total: {fmt(totalGeneral)}</div>}
              </div>
              </>)}
            </div>
          </div>
        );
      };

      if (vista === "reporteVentas") {
        return renderReporteVR({
          pedidos: repPedidos,
          titulo: "Reporte de ventas", tituloExport: "Reporte de Ventas", emoji: "📊",
          fileBase: "ventas", sheetName: "Ventas", emptyMsg: "No hay ventas en ese rango.",
          loading: repLoading, error: repError,
          desde: rvDesde, setDesde: setRvDesde, hasta: rvHasta, setHasta: setRvHasta,
          medio: rvMedio, setMedio: setRvMedio, repartidor: rvRepartidor, setRepartidor: setRvRepartidor,
          local: rvLocal, setLocal: setRvLocal, tipo: rvTipo, setTipo: setRvTipo,
        });
      }

      if (vista === "reporteReservas") {
        // Sólo activos a futuro: fechaDisplay >= HOY. Los vencidos (fecha pasada)
        // y los sin fecha quedan fuera. No hay fetch: usa pedidosActivos en memoria.
        const reservasBase = pedidosActivos.filter(p => p.fechaDisplay && p.fechaDisplay >= HOY);
        return renderReporteVR({
          pedidos: reservasBase,
          titulo: "Reporte de Reservas", tituloExport: "Reporte de Reservas", emoji: "📅",
          fileBase: "reservas", sheetName: "Reservas", emptyMsg: "No hay reservas en ese rango.",
          loading: false, error: null,
          desde: rrDesde, setDesde: setRrDesde, hasta: rrHasta, setHasta: setRrHasta,
          medio: rrMedio, setMedio: setRrMedio, repartidor: rrRepartidor, setRepartidor: setRrRepartidor,
          local: rrLocal, setLocal: setRrLocal, tipo: rrTipo, setTipo: setRrTipo, turno: rrTurno, setTurno: setRrTurno,
        });
      }

      if (vista === "reporteProductos") {
        const pedidosBase = repPedidos.filter(p => {
          const est = p.estado;
          if (est === "Anulado") return false;
          if (rpDesde && p.fechaDisplay && p.fechaDisplay < rpDesde) return false;
          if (rpHasta && p.fechaDisplay && p.fechaDisplay > rpHasta) return false;
          if (rpLocal && p.local !== rpLocal) return false;
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
                  <select style={{ ...s.select, padding: "5px 8px" }} value={rpLocal} onChange={e => setRpLocal(e.target.value)}>
                    <option value="">Todos los locales</option>
                    <option value="A. Thomas">A. Thomas</option>
                    <option value="French">French</option>
                  </select>
                  {(rpDesde || rpHasta || rpLocal) && <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setRpDesde(""); setRpHasta(""); setRpLocal(""); }}>✕ Limpiar</button>}
                  {listaProductos.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarProdExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarProdPDF}>📄 PDF</button></>)}
                </div>
              </div>
              {repLoading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Cargando datos históricos…</div>
              ) : repError ? (
                <div style={{ padding: "20px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {repError}</div>
              ) : (<>
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
              </>)}
            </div>
          </div>
        );
      }

      if (vista === "zonas") {
        // Reporte de pedidos por repartidor y área geográfica (solo admin).
        const AREAS = Array.from({ length: 10 }, (_, i) => i + 1);
        const filasBase = zonasData?.repartidores || [];
        const filas = zonasRepartidor ? filasBase.filter(r => r.repartidor === zonasRepartidor) : filasBase;
        const areasMostradas = zonasArea ? [Number(zonasArea)] : AREAS;
        const sumCol = (key) => filas.reduce((a, r) => a + (r[key] || 0), 0);
        const costos = zonasData?.costoArea || {};                       // { "1".."10": costo } (persistido)
        const fmtCosto = (n) => `$${Number(costos[n] ?? 1).toLocaleString("es-AR")}`;
        const th = { padding: "8px 10px", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: 0.3, textAlign: "center", borderBottom: "2px solid #eee", whiteSpace: "nowrap" };
        const thL = { ...th, textAlign: "left", position: "sticky", left: 0, background: "#fff" };
        const td = { padding: "7px 10px", fontSize: 13, color: "#333", textAlign: "center", borderBottom: "1px solid #f0f0ee", whiteSpace: "nowrap" };
        const tdL = { ...td, textAlign: "left", fontWeight: 600, position: "sticky", left: 0, background: "#fff" };
        const motivoLabel = (pd) => pd.area != null ? pd.area : (pd.motivo === "sin_coordenada" ? "Sin coord" : pd.motivo === "fuera_de_area" ? "Fuera de área" : "");
        const exportarZonasExcel = () => {
          // Solapa 1: Resumen (matriz, respeta filtros de repartidor/área).
          const filaObj = (r, esTotal) => {
            const o = { "Repartidor": esTotal ? "TOTAL" : r.repartidor };
            areasMostradas.forEach(n => { o["Área " + n] = esTotal ? sumCol("area" + n) : r["area" + n]; });
            o["Sin coord"] = esTotal ? sumCol("sin_coordenada") : r.sin_coordenada;
            o["Fuera de área"] = esTotal ? sumCol("fuera_de_area") : r.fuera_de_area;
            o["Total pedidos"] = esTotal ? sumCol("total_pedidos") : r.total_pedidos;
            o["Total costo"] = esTotal ? sumCol("total_costo") : r.total_costo;
            return o;
          };
          const resumen = filas.map(r => filaObj(r, false));
          resumen.push(filaObj(null, true));
          // Solapa 2: Detalle — SIEMPRE todos los pedidos del rango (NO aplica los
          // filtros de repartidor/área de la pantalla). Ordenado por repartidor y área.
          const detalle = (zonasData?.pedidos || [])
            .slice()
            .sort((a, b) => a.repartidor.localeCompare(b.repartidor) || ((a.area ?? 999) - (b.area ?? 999)))
            .map(pd => ({ "Número": pd.numero, "Dirección": pd.direccion, "Barrio": pd.barrio, "Repartidor": pd.repartidor, "Área": motivoLabel(pd), "Fecha": pd.fecha || "" }));
          exportarExcel(`zonas_${zonasDesde}_${zonasHasta}.xlsx`, [
            { name: "Resumen", data: resumen },
            { name: "Detalle", data: detalle },
          ]);
        };
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>📍 Pedidos por zona</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={zonasDesde} onChange={e => setZonasDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={zonasHasta} onChange={e => setZonasHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={zonasRepartidor} onChange={e => setZonasRepartidor(e.target.value)}>
                    <option value="">Todos los repartidores</option>
                    {filasBase.map(r => <option key={r.repartidor} value={r.repartidor}>{r.repartidor}</option>)}
                  </select>
                  <select style={{ ...s.select, padding: "5px 8px" }} value={zonasArea} onChange={e => setZonasArea(e.target.value)}>
                    <option value="">Todas las áreas</option>
                    {AREAS.map(n => <option key={n} value={String(n)}>Área {n}</option>)}
                  </select>
                  {(zonasRepartidor || zonasArea) && (
                    <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setZonasRepartidor(""); setZonasArea(""); }}>✕ Limpiar</button>
                  )}
                  {filas.length > 0 && <button style={btnExportar("#F68B32")} onClick={exportarZonasExcel}>📊 Excel</button>}
                </div>
              </div>

              {/* Panel admin: costos por área editables */}
              <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: "14px 16px", marginBottom: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>💲 Costos por área</span>
                  <button onClick={guardarCostosAreas} disabled={costosGuardando}
                    style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "none", background: costosGuardando ? "#ccc" : "#27500a", color: "#fff", fontWeight: 600, cursor: costosGuardando ? "default" : "pointer" }}>
                    {costosGuardando ? "Guardando…" : "Guardar costos"}
                  </button>
                  {costosMsg && <span style={{ fontSize: 12, fontWeight: 600, color: costosMsg.startsWith("⚠️") ? "#c0392b" : "#27500a" }}>{costosMsg}</span>}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10 }}>
                  {AREAS.map(n => (
                    <label key={n} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 11, color: "#888", fontWeight: 600 }}>Área {n}</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 13, color: "#aaa" }}>$</span>
                        <input type="number" min="0" step="any" value={costosEdit[n] ?? ""}
                          onChange={e => setCostosEdit(prev => ({ ...prev, [n]: e.target.value }))}
                          style={{ width: "100%", fontSize: 13, padding: "5px 8px", borderRadius: 6, border: "1px solid #ddd" }} />
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {zonasLoading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Calculando zonas…</div>
              ) : zonasError ? (
                <div style={{ padding: 20, background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {zonasError}</div>
              ) : filas.length === 0 ? (
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 40, textAlign: "center", color: "#aaa", fontSize: 13 }}>No hay pedidos entregados de delivery en ese rango.</div>
              ) : (
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, overflowX: "auto" }}>
                  <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
                    <thead>
                      <tr>
                        <th style={thL}>Repartidor</th>
                        {areasMostradas.map(n => <th key={n} style={th}>Área {n}<div style={{ fontSize: 10, fontWeight: 500, color: "#bbb", textTransform: "none", letterSpacing: 0 }}>{fmtCosto(n)}</div></th>)}
                        <th style={th}>Sin coord</th>
                        <th style={th}>Fuera de área</th>
                        <th style={th}>Total pedidos</th>
                        <th style={th}>Total costo</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filas.map(r => (
                        <tr key={r.repartidor}>
                          <td style={tdL}>{r.repartidor}</td>
                          {areasMostradas.map(n => <td key={n} style={{ ...td, color: r["area" + n] ? "#333" : "#ccc" }}>{r["area" + n]}</td>)}
                          <td style={{ ...td, color: r.sin_coordenada ? "#c0392b" : "#ccc" }}>{r.sin_coordenada}</td>
                          <td style={{ ...td, color: r.fuera_de_area ? "#8a5a00" : "#ccc" }}>{r.fuera_de_area}</td>
                          <td style={{ ...td, fontWeight: 700 }}>{r.total_pedidos}</td>
                          <td style={{ ...td, fontWeight: 700, color: "#F68B32" }}>{r.total_costo}</td>
                        </tr>
                      ))}
                      <tr>
                        <td style={{ ...tdL, borderTop: "2px solid #eee", background: "#faf7f2" }}>TOTAL</td>
                        {areasMostradas.map(n => <td key={n} style={{ ...td, borderTop: "2px solid #eee", fontWeight: 700, background: "#faf7f2" }}>{sumCol("area" + n)}</td>)}
                        <td style={{ ...td, borderTop: "2px solid #eee", fontWeight: 700, background: "#faf7f2" }}>{sumCol("sin_coordenada")}</td>
                        <td style={{ ...td, borderTop: "2px solid #eee", fontWeight: 700, background: "#faf7f2" }}>{sumCol("fuera_de_area")}</td>
                        <td style={{ ...td, borderTop: "2px solid #eee", fontWeight: 800, background: "#faf7f2" }}>{sumCol("total_pedidos")}</td>
                        <td style={{ ...td, borderTop: "2px solid #eee", fontWeight: 800, color: "#F68B32", background: "#faf7f2" }}>{sumCol("total_costo")}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              {!zonasLoading && !zonasError && filas.length > 0 && (
                <div style={{ fontSize: 11, color: "#aaa", marginTop: 10 }}>
                  Solo pedidos <b>Entregados</b> de <b>delivery</b>. "Sin coord" = dirección no está en el cache de geolocalización; "Fuera de área" = geolocalizado pero no cae en ninguna de las 10 áreas.
                </div>
              )}
            </div>
          </div>
        );
      }

      if (vista === "reporteFusionado") {
        // Reporte fusionado (solo admin): separa el rango en VENDIDO (Entregado) vs
        // POR VENDER (En camino + Listo + Por empaquetar). Excluye Anulado.
        const ESTADOS_POR_VENDER = ["Por empaquetar", "Listo", "En camino"];
        const baseRf = repPedidos.filter(p => {
          if (p.estado === "Anulado") return false;
          if (rfDesde && p.fechaDisplay && p.fechaDisplay < rfDesde) return false;
          if (rfHasta && p.fechaDisplay && p.fechaDisplay > rfHasta) return false;
          if ((rfDesde || rfHasta) && !p.fechaDisplay) return false;
          if (rfLocal && p.local !== rfLocal) return false;
          return true;
        });
        const sumRf = arr => arr.reduce((a, p) => a + p.totalNum, 0);
        const vendidos = baseRf.filter(p => p.estado === "Entregado");
        const porVender = baseRf.filter(p => ESTADOS_POR_VENDER.includes(p.estado));
        const vendidoValor = sumRf(vendidos);
        const porVenderValor = sumRf(porVender);
        const totalCount = vendidos.length + porVender.length;
        const totalValor = vendidoValor + porVenderValor;
        const desglosePV = ESTADOS_POR_VENDER.map(e => {
          const grupo = porVender.filter(p => p.estado === e);
          return { estado: e, count: grupo.length, valor: sumRf(grupo) };
        });
        const cardBox = { background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: "20px 22px" };
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🧾 Vendido / Por vender</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rfDesde} onChange={e => setRfDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={rfHasta} onChange={e => setRfHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={rfLocal} onChange={e => setRfLocal(e.target.value)}>
                    <option value="">Todos los locales</option>
                    <option value="A. Thomas">A. Thomas</option>
                    <option value="French">French</option>
                  </select>
                </div>
              </div>
              {repLoading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Cargando datos históricos…</div>
              ) : repError ? (
                <div style={{ padding: "20px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {repError}</div>
              ) : (<>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16, marginBottom: 16 }}>
                  {/* VENDIDO */}
                  <div style={cardBox}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: "#27500a", background: "#eaf3de", padding: "3px 10px", borderRadius: 20 }}>✓ VENDIDO</span>
                      <span style={{ fontSize: 12, color: "#aaa" }}>Entregado</span>
                    </div>
                    <div style={{ fontSize: 34, fontWeight: 800, color: "#27500a", lineHeight: 1.1 }}>{fmt(vendidoValor)}</div>
                    <div style={{ fontSize: 13, color: "#888", marginTop: 4 }}>{vendidos.length} pedido{vendidos.length === 1 ? "" : "s"}</div>
                  </div>
                  {/* POR VENDER */}
                  <div style={cardBox}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: "#8a5a00", background: "#fff0db", padding: "3px 10px", borderRadius: 20 }}>⏳ POR VENDER</span>
                      <span style={{ fontSize: 12, color: "#aaa" }}>Por empaquetar · Listo · En camino</span>
                    </div>
                    <div style={{ fontSize: 34, fontWeight: 800, color: "#F68B32", lineHeight: 1.1 }}>{fmt(porVenderValor)}</div>
                    <div style={{ fontSize: 13, color: "#888", marginTop: 4, marginBottom: 12 }}>{porVender.length} pedido{porVender.length === 1 ? "" : "s"}</div>
                    <div style={{ borderTop: "1px solid #f0f0ee", paddingTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                      {desglosePV.map(d => (
                        <div key={d.estado} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: "#666" }}>
                          <span>{d.estado} <span style={{ color: "#bbb" }}>· {d.count}</span></span>
                          <span style={{ fontWeight: 600, color: "#555" }}>{fmt(d.valor)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* TOTAL destacado */}
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 10, padding: "18px 22px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, color: "#ffe6cf", fontWeight: 700, letterSpacing: 0.4 }}>TOTAL GENERAL</div>
                    <div style={{ fontSize: 13, color: "#ffe6cf", marginTop: 2 }}>{totalCount} pedido{totalCount === 1 ? "" : "s"} (vendido + por vender)</div>
                  </div>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#fff" }}>{fmt(totalValor)}</div>
                </div>
                {totalCount === 0 && <div style={s.empty}>No hay pedidos en ese rango.</div>}
              </>)}
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
          if (prodTurno && turnoDe(p.franjaDisplay) !== prodTurno) return false;
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
          // Desglose por turno (orden canónico) con columna "Turno". Refleja el filtro:
          // si prodTurno está seteado, pedidosProduccion ya trae solo ese turno.
          const datos = [];
          TURNOS_ORDEN.forEach(t => {
            const peds = pedidosProduccion.filter(p => turnoDe(p.franjaDisplay) === t);
            if (peds.length === 0) return;
            const m = {};
            peds.forEach(p => p.productos.split(", ").forEach(item => {
              const mt = item.match(/^(.+) x(\d+)$/); if (!mt) return;
              m[mt[1].trim()] = (m[mt[1].trim()] || 0) + Number(mt[2]);
            }));
            Object.entries(m).sort((a, b) => b[1] - a[1])
              .forEach(([nombre, cant]) => datos.push({ "Turno": t, "Producto": nombre, "Cantidad a producir": cant }));
          });
          datos.push({ "Turno": "TOTAL", "Producto": "", "Cantidad a producir": totalUnidades });
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
                <span style={{ fontSize: 12, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3, marginLeft: 8 }}>Turno:</span>
                <select style={{ ...s.select, padding: "5px 8px" }} value={prodTurno} onChange={e => setProdTurno(e.target.value)}>
                  <option value="">Todos</option>
                  {TURNOS_ORDEN.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
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
      if (vista === "cocina") {
        // Demanda: mismo agrupado que `produccion`, pero SOLO pedidos por producir
        // (Por empaquetar / Listo): lo ya despachado no se produce mas. Mantiene
        // el filtro por local y la fecha.
        const pedidosCocina = pedidosProcesados.filter(p => {
          const est = pedidosLocales[p.id]?.estado || p.estado;
          if (est !== "Por empaquetar" && est !== "Listo") return false;
          // Demanda sumada sobre el rango [desde, hasta] inclusive.
          if (!p.fechaDisplay || p.fechaDisplay < cocinaDesde || p.fechaDisplay > cocinaHasta) return false;
          if (cocinaLocal !== "todos" && p.local !== cocinaLocal) return false;
          if (cocinaTurno && turnoDe(p.franjaDisplay) !== cocinaTurno) return false;
          return true;
        });
        const demandaMap = {};
        pedidosCocina.forEach(p => {
          p.productos.split(", ").forEach(item => {
            const match = item.match(/^(.+) x(\d+)$/);
            if (!match) return;
            const nombre = match[1].trim();
            demandaMap[nombre] = (demandaMap[nombre] || 0) + Number(match[2]);
          });
        });
        // Stock indexado por clave_producto (match por NOMBRE exacto, misma clave
        // que agrupa produccion y que descuenta el backend).
        const stockMap = {};
        stockData.forEach(it => { stockMap[it.clave_producto] = it; });

        // El stock es un pool por local: su fecha de produccion es relativa a HOY,
        // no al rango de entrega de la demanda.
        const ayer = restarDias(HOY, 1);
        const etiquetaFecha = (f) => f === HOY ? "de hoy" : (f === ayer ? "de ayer" : `del ${f.slice(8, 10)}/${f.slice(5, 7)}`);
        const desglose = (stk) => (stk?.porFecha || []).map(f => `${etiquetaFecha(f.fecha_produccion)} ${f.cantidad}`).join(" · ");

        // Filas con demanda, ordenadas por "para producir" desc.
        const filas = Object.keys(demandaMap).map(clave => {
          const demanda = demandaMap[clave];
          const enStock = stockMap[clave]?.total_disponible || 0;
          return { clave, demanda, enStock, paraProducir: Math.max(0, demanda - enStock), stock: stockMap[clave] };
        }).sort((a, b) => b.paraProducir - a.paraProducir || b.demanda - a.demanda);

        // Stock sin demanda: abajo, en gris, no cuenta para producir.
        const sinDemanda = stockData
          .filter(it => !(it.clave_producto in demandaMap) && it.total_disponible > 0)
          .sort((a, b) => a.clave_producto.localeCompare(b.clave_producto));

        const totalProducir = filas.reduce((a, f) => a + f.paraProducir, 0);
        const puedeProducir = cocinaLocal !== "todos";

        const fechasDisponibles = [...new Set(pedidosProcesados.filter(p => {
          const est = pedidosLocales[p.id]?.estado || p.estado;
          return (est === "Por empaquetar" || est === "Listo") && p.fechaDisplay && p.fechaDisplay >= HOY;
        }).map(p => p.fechaDisplay))].sort();

        // Control para descartar stock (merma de perecederos). Solo si hay lote y local elegido.
        const stockControl = (clave, stockItem) => {
          if (!puedeProducir || !stockItem || stockItem.total_disponible <= 0) return null;
          const abierto = descartar && descartar.clave === clave;
          if (!abierto) {
            return <button onClick={() => setDescartar({ clave, cantidad: "1", fecha: "" })}
              style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #e0b4b4", background: "#fff", color: "#c0392b", cursor: "pointer" }}>Sacar de stock</button>;
          }
          const tieneFechas = stockItem.porFecha.length > 1;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <input type="number" min="1" autoFocus value={descartar.cantidad}
                onChange={e => setDescartar(d => ({ ...d, cantidad: e.target.value }))}
                style={{ width: 52, fontSize: 12, padding: "3px 6px", borderRadius: 6, border: "1px solid #ddd" }} />
              {tieneFechas && (
                <select value={descartar.fecha} onChange={e => setDescartar(d => ({ ...d, fecha: e.target.value }))}
                  style={{ fontSize: 11, padding: "3px 6px", borderRadius: 6, border: "1px solid #ddd" }}>
                  <option value="">Más viejo (FIFO)</option>
                  {stockItem.porFecha.map(f => <option key={f.fecha_produccion} value={f.fecha_produccion}>{etiquetaFecha(f.fecha_produccion)} ({f.cantidad})</option>)}
                </select>
              )}
              <button onClick={() => descartarStock(clave, descartar.cantidad, descartar.fecha)}
                style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "none", background: "#c0392b", color: "#fff", fontWeight: 600, cursor: "pointer" }}>Descartar</button>
              <button onClick={() => setDescartar(null)}
                style={{ fontSize: 11, padding: "4px 8px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#888", cursor: "pointer" }}>Cancelar</button>
            </div>
          );
        };

        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🍳 Tablero de cocina</h2>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12, color: "#888" }}>Desde</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={cocinaDesde} onChange={e => setCocinaDesde(e.target.value)} />
                  <span style={{ fontSize: 12, color: "#888" }}>Hasta</span>
                  <input type="date" style={{ ...s.select, padding: "5px 8px" }} value={cocinaHasta} onChange={e => setCocinaHasta(e.target.value)} />
                  <select style={{ ...s.select, padding: "5px 8px" }} value={cocinaTurno} onChange={e => setCocinaTurno(e.target.value)}>
                    <option value="">Turno: todos</option>
                    {TURNOS_ORDEN.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {fechasDisponibles.length > 0 && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {fechasDisponibles.map(f => {
                        const activo = cocinaDesde === f && cocinaHasta === f;
                        return (
                          <button key={f} title="Fijar el rango a este día" onClick={() => { setCocinaDesde(f); setCocinaHasta(f); }}
                            style={{ fontSize: 11, padding: "4px 10px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: activo ? "#F68B32" : "#ddd", background: activo ? "#F68B32" : "#fff", color: activo ? "#fff" : "#555" }}>
                            {new Date(f + "T12:00:00").toLocaleDateString("es-AR", { weekday: "short", day: "numeric", month: "short" })}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, color: "#888", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Sucursal:</span>
                {[{ id: "todos", label: "🏭 Ambos" }, { id: "A. Thomas", label: "📍 A. Thomas" }, { id: "French", label: "📍 French" }].map(opt => (
                  <button key={opt.id} onClick={() => setCocinaLocal(opt.id)}
                    style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: cocinaLocal === opt.id ? "#F68B32" : "#ddd", background: cocinaLocal === opt.id ? "#F68B32" : "#fff", color: cocinaLocal === opt.id ? "#fff" : "#555", fontWeight: cocinaLocal === opt.id ? 600 : 400 }}>
                    {opt.label}
                  </button>
                ))}
              </div>

              {!puedeProducir && (
                <div style={{ background: "#fff8ec", border: "1px solid #f3d9a8", color: "#8a5a00", borderRadius: 8, padding: "10px 14px", fontSize: 13, marginBottom: 16 }}>
                  Elegí una sucursal (A. Thomas o French) para poder marcar producción. En “Ambos” el tablero es de solo lectura, porque el stock es por local.
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10, marginBottom: 20 }}>
                <div style={{ background: "#F68B32", border: "1px solid #F68B32", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#ffe6cf", marginBottom: 4 }}>FALTA PRODUCIR (NETO)</div><div style={{ fontSize: 22, fontWeight: 700, color: "#fff" }}>{totalProducir}</div><div style={{ fontSize: 11, color: "#ffe6cf" }}>{pedidosCocina.length} pedidos por producir</div></div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>PRODUCTOS CON DEMANDA</div><div style={{ fontSize: 22, fontWeight: 700, color: "#333" }}>{filas.length}</div></div>
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: "12px 14px" }}><div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>{cocinaDesde === cocinaHasta ? "FECHA" : "RANGO"}</div><div style={{ fontSize: 14, fontWeight: 700, color: "#333", textTransform: "capitalize" }}>{cocinaDesde === cocinaHasta ? new Date(cocinaDesde + "T12:00:00").toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" }) : `${new Date(cocinaDesde + "T12:00:00").toLocaleDateString("es-AR", { day: "numeric", month: "short" })} – ${new Date(cocinaHasta + "T12:00:00").toLocaleDateString("es-AR", { day: "numeric", month: "short" })}`}</div></div>
              </div>

              {stockError && <div style={{ padding: "12px 14px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 13, fontWeight: 500, marginBottom: 16 }}>⚠️ {stockError}</div>}
              {stockLoading && <div style={{ padding: 20, textAlign: "center", color: "#aaa", fontSize: 13 }}>Cargando stock…</div>}

              {!stockLoading && filas.length === 0 && sinDemanda.length === 0 ? (
                <div style={{ background: "#fff", border: "1px solid #eee", borderRadius: 10, padding: 40, textAlign: "center", color: "#aaa", fontSize: 13 }}>No hay demanda ni stock para este rango/sucursal.</div>
              ) : (
                <div style={s.lista}>
                  <div style={s.cabecera}>
                    <span style={{ ...s.col, flex: 3 }}>Producto</span>
                    <span style={{ ...s.col, flex: 1, textAlign: "center" }}>Demanda</span>
                    <span style={{ ...s.col, flex: 3 }}>En stock</span>
                    <span style={{ ...s.col, flex: 2.5, textAlign: "center" }}>Para producir</span>
                  </div>
                  {filas.map(f => (
                    <div key={f.clave} style={s.fila}>
                      <div style={{ ...s.filaTop, cursor: "default", alignItems: "center" }}>
                        <span style={{ ...s.cel, flex: 3, fontWeight: 600 }}>{f.clave}</span>
                        <span style={{ ...s.cel, flex: 1, textAlign: "center", fontWeight: 600 }}>{f.demanda}</span>
                        <div style={{ ...s.cel, flex: 3, display: "flex", flexDirection: "column", gap: 4 }}>
                          <div>
                            <span style={{ fontWeight: 700, color: f.enStock >= f.demanda ? "#27500a" : "#333" }}>{f.enStock}</span>
                            {f.stock && f.stock.porFecha.length > 0 && <span style={{ fontSize: 11, color: "#999", marginLeft: 8 }}>({desglose(f.stock)})</span>}
                          </div>
                          {stockControl(f.clave, f.stock)}
                        </div>
                        <div style={{ flex: 2.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                          <span style={{ fontSize: 18, fontWeight: 700, color: f.paraProducir > 0 ? "#F68B32" : "#27500a" }}>{f.paraProducir}</span>
                          {puedeProducir && (
                            <>
                              <input type="number" min="1" value={cocinaCant[f.clave] !== undefined ? cocinaCant[f.clave] : String(f.paraProducir || "")}
                                onChange={e => setCocinaCant(prev => ({ ...prev, [f.clave]: e.target.value }))}
                                style={{ width: 56, fontSize: 13, padding: "4px 6px", borderRadius: 6, border: "1px solid #ddd" }} />
                              <button onClick={() => producirCocina(f.clave, cocinaCant[f.clave] !== undefined ? cocinaCant[f.clave] : f.paraProducir)}
                                style={{ fontSize: 12, padding: "5px 10px", borderRadius: 6, border: "none", background: "#27500a", color: "#fff", fontWeight: 600, cursor: "pointer" }}>
                                Marcar realizadas
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}

                  {sinDemanda.length > 0 && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: 0.3, margin: "18px 0 8px 4px" }}>En stock sin demanda</div>
                      {sinDemanda.map(it => (
                        <div key={it.clave_producto} style={{ ...s.fila, background: "#fafafa" }}>
                          <div style={{ ...s.filaTop, cursor: "default", alignItems: "center" }}>
                            <span style={{ ...s.cel, flex: 3, fontWeight: 600, color: "#999" }}>{it.clave_producto}</span>
                            <span style={{ ...s.cel, flex: 1, textAlign: "center", color: "#bbb" }}>—</span>
                            <div style={{ ...s.cel, flex: 3, color: "#999", display: "flex", flexDirection: "column", gap: 4 }}>
                              <div>
                                <span style={{ fontWeight: 700 }}>{it.total_disponible}</span>
                                {it.porFecha.length > 0 && <span style={{ fontSize: 11, color: "#bbb", marginLeft: 8 }}>({desglose(it)})</span>}
                              </div>
                              {stockControl(it.clave_producto, it)}
                            </div>
                            <span style={{ ...s.cel, flex: 2.5, textAlign: "center", color: "#bbb" }}>—</span>
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      }
     if (vista === "importar") {
      return <div style={s.wrap}><Header /><VistaImportar usuario={usuario} onVolver={() => setVista("panel")} /></div>;
    }
    if (vista === "mapa") {
        return <div style={s.wrap}><Header /><VistaMapa onVolver={() => setVista("panel")} repartidores={repartidoresLista} onCrearTanda={crearTanda} /></div>;
      }
      if (vista === "finalizados") {
        // Fuente: /api/reportes/pedidos por rango (repPedidos) — trae TODO lo finalizado
        // de la fecha sin importar cuándo se cargó (a diferencia de la ventana de 7 días).
        const finalizadosOrdenados = [...repPedidos]
          .filter(p => {
            if (filtroRepartidor && repartidorReporte(p) !== filtroRepartidor) return false;
            if (filtroFinLocal && p.local !== filtroFinLocal) return false;
            return true;
          })
          .sort((a, b) => { if (!a.fechaDisplay) return 1; if (!b.fechaDisplay) return -1; return b.fechaDisplay.localeCompare(a.fechaDisplay); });
        const entregados = finalizadosOrdenados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "Entregado");
        const anulados = finalizadosOrdenados.filter(p => (pedidosLocales[p.id]?.estado || p.estado) === "Anulado");
        const listaMostrada = tabFin === "entregados" ? entregados : anulados;
        const tagFin = fechaTagArchivo(filtroFinDesde, filtroFinHasta);
        const exportarFinalizadosExcel = () => {
                 const datos = listaMostrada.map(p => ({ "Nº": p.numero, "Cliente": p.cliente, "Email": p.email || "", "Teléfono": p.telefono, "Dirección": p.direccion + (p.barrio ? `, ${p.barrio}` : ""), "Productos": p.productos, "Medio de pago": p.medioPago, "Código MKP": p.codigoPago || "", "Total": p.totalNum, "Fecha": p.fechaDisplay || "", "Local": p.local, "Factura": facturasMap[String(p.id)] || "", "Estado": pedidosLocales[p.id]?.estado || p.estado, "Repartidor": repartidorReporte(p) }));
          exportarExcel(`pedidos_${tabFin}_${tagFin}.xlsx`, [{ name: tabFin === "entregados" ? "Entregados" : "Anulados", data: datos }]);
        };
        const exportarFinalizadosPDF = () => {
const filas = listaMostrada.map(p => [p.numero, p.cliente, p.telefono, (p.productos.length > 40 ? p.productos.substring(0, 40) + "..." : p.productos), p.medioPago, p.codigoPago || "—", fmt(p.totalNum), p.fechaDisplay || "—", p.local, facturasMap[String(p.id)] || "—"]);          const totalSum = listaMostrada.reduce((a, p) => a + p.totalNum, 0);
          const subt = (filtroFinDesde || filtroFinHasta) ? `Desde ${filtroFinDesde || "inicio"} hasta ${filtroFinHasta || "hoy"}` : "Todas las fechas";
exportarPDF(`pedidos_${tabFin}_${tagFin}.pdf`, tabFin === "entregados" ? "Pedidos Entregados" : "Pedidos Anulados", ["Nº", "Cliente", "Teléfono", "Productos", "Pago", "Cód. MKP", "Total", "Fecha", "Local", "Factura"], filas, `Total: ${fmt(listaMostrada.reduce((a, p) => a + p.totalNum, 0))}  ·  ${listaMostrada.length} pedidos`, subt);        };
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
                  <select style={{ ...s.select, padding: "5px 8px" }} value={filtroFinLocal} onChange={e => setFiltroFinLocal(e.target.value)}>
                    <option value="">Todos los locales</option>
                    <option value="A. Thomas">A. Thomas</option>
                    <option value="French">French</option>
                  </select>
                  {(filtroFinDesde || filtroFinHasta || filtroRepartidor || filtroFinLocal) && <button style={{ ...s.btnVolver, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => { setFiltroFinDesde(""); setFiltroFinHasta(""); setFiltroRepartidor(""); setFiltroFinLocal(""); }}>✕ Limpiar</button>}
                  {listaMostrada.length > 0 && (<><button style={btnExportar("#F68B32")} onClick={exportarFinalizadosExcel}>📊 Excel</button><button style={btnExportar("#c0392b")} onClick={exportarFinalizadosPDF}>📄 PDF</button></>)}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={() => setTabFin("entregados")} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: tabFin === "entregados" ? "#F68B32" : "#ddd", background: tabFin === "entregados" ? "#F68B32" : "#fff", color: tabFin === "entregados" ? "#fff" : "#555", fontWeight: tabFin === "entregados" ? 600 : 400 }}>✅ Entregados ({entregados.length})</button>
                <button onClick={() => setTabFin("anulados")} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: tabFin === "anulados" ? "#c0392b" : "#ddd", background: tabFin === "anulados" ? "#c0392b" : "#fff", color: tabFin === "anulados" ? "#fff" : "#555", fontWeight: tabFin === "anulados" ? 600 : 400 }}>🚫 Anulados ({anulados.length})</button>
              </div>
              {repLoading ? (
                <div style={{ padding: "60px 0", textAlign: "center", color: "#888", fontSize: 14 }}>⏳ Cargando finalizados…</div>
              ) : repError ? (
                <div style={{ padding: "20px", background: "#fdecea", color: "#c0392b", borderRadius: 8, fontSize: 14, fontWeight: 500 }}>⚠️ {repError}</div>
              ) : (
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
                {listaMostrada.map(p => {
                  const esCorp = p.esManual && p.esCorporativo; // violeta clarito (solo manuales corporativos)
                  return (
                  <div key={p.id} style={{ ...s.fila, ...(expandido === p.id ? s.filaAbierta : {}), ...(expandido !== p.id && esCorp ? { background: "#ede9fe" } : {}) }}>
                    <div style={{ ...s.filaTop, ...(expandido === p.id && esCorp ? { background: "#ede9fe" } : {}) }} onClick={() => toggleExpandido(p.id)}>
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
                          {(pedidosLocales[p.id]?.estado || p.estado) === "Anulado" && (
                            <div style={s.detalleBloque}><div style={s.detalleLabel}>Motivo de anulación</div><div style={{ ...s.detalleVal, color: p.motivoAnulacion ? "#c0392b" : "#aaa", fontStyle: p.motivoAnulacion ? "normal" : "italic" }}>{p.motivoAnulacion || "Sin motivo registrado"}</div></div>
                          )}
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
                            {p.medioPago === "Otro" && (
                              <InputBlur style={{ ...s.inputField, marginTop: 4 }} initialValue={p.medioPagoOtro || ""} placeholder="¿Cuál? (ej: Cheque, Canje)"
                                onCommit={v => actualizarDato(p, "medioPagoOtro", v)} onClick={e => e.stopPropagation()} />
                            )}
                          </div>
                          <div style={s.detalleBloque}>
                            <div style={s.detalleLabel}>Cobrar en entrega</div>
                            <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!pedidosLocales[p.id]?.cobrar} onChange={e => { e.stopPropagation(); cambiarCobrar(p.id, e.target.checked); }} onClick={e => e.stopPropagation()} />
                              <span style={{ fontSize: 12, color: pedidosLocales[p.id]?.cobrar ? "#c0392b" : "#888", fontWeight: pedidosLocales[p.id]?.cobrar ? 600 : 400 }}>{pedidosLocales[p.id]?.cobrar ? "⚠️ COBRAR" : "Cobrar"}</span>
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
                  );
                })}
              </div>
              )}
            </div>
          </div>
        );
      }

      if (vista === "tandas") {
        const tandasActivas = tandas.filter(t => (t.estado === "armada" || t.estado === "en_reparto") && t.local === tandaVistaLocal);
        const etiquetaEstadoTanda = (e) => e === "en_reparto" ? "En reparto" : e === "armada" ? "Armada" : e;
        return (
          <div style={s.wrap}>
            <Header />
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
                <button style={s.btnVolver} onClick={() => setVista("panel")}>← Volver</button>
                <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>🚚 Tandas activas</h2>
                <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                  {["A. Thomas", "French"].map(loc => (
                    <button key={loc} onClick={() => setTandaVistaLocal(loc)}
                      style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: "pointer", borderColor: tandaVistaLocal === loc ? "#7c3aed" : "#ddd", background: tandaVistaLocal === loc ? "#7c3aed" : "#fff", color: tandaVistaLocal === loc ? "#fff" : "#555" }}>
                      {loc}
                    </button>
                  ))}
                </div>
              </div>
              {tandasActivas.length === 0 && <div style={s.empty}>No hay tandas activas en {tandaVistaLocal}.</div>}
              {tandasActivas.map(t => {
                const pedidosDeTanda = pedidosProcesados.filter(p => p.tandaId === t.id);
                return (
                  <div key={t.id} style={{ marginBottom: 20, border: "1px solid #e0d4f7", borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ background: "#7c3aed", color: "#fff", padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <span style={{ fontWeight: 700, fontSize: 15 }}>Tanda #{t.id}</span>
                      {t.nombre && <span style={{ fontSize: 13, opacity: 0.9 }}>· {t.nombre}</span>}
                      <span style={{ fontSize: 12, background: "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: 99 }}>🛵 {t.repartidor || "Sin asignar"}</span>
                      <span style={{ fontSize: 12, background: t.estado === "en_reparto" ? "#1e7e34" : "rgba(255,255,255,0.2)", padding: "2px 8px", borderRadius: 99 }}>{etiquetaEstadoTanda(t.estado)}</span>
                      <span style={{ fontSize: 12, opacity: 0.85 }}>{pedidosDeTanda.length} pedido{pedidosDeTanda.length !== 1 ? "s" : ""}</span>
                      <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {t.estado === "armada" && <button onClick={() => despacharTanda(t)} style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", background: "#fff", color: "#7c3aed" }}>🛵 Despachar</button>}
                        {t.estado === "en_reparto" && <button onClick={() => entregarTanda(t)} style={{ fontSize: 12, fontWeight: 700, padding: "6px 14px", borderRadius: 6, border: "none", cursor: "pointer", background: "#fff", color: "#1e7e34" }}>✅ Marcar entregada</button>}
                        <button onClick={() => deshacerTanda(t)} style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid rgba(255,255,255,0.6)", cursor: "pointer", background: "transparent", color: "#fff" }}>↩️ Deshacer</button>
                      </div>
                    </div>
                    <div style={{ padding: 8 }}>
                      {pedidosDeTanda.length === 0 ? <div style={s.empty}>Sin pedidos (refrescá si los acabás de mover).</div> : pedidosDeTanda.map(p => (
                        <div key={p.id}>
                          <div style={{ display: "flex", justifyContent: "flex-end", padding: "2px 8px" }}>
                            <button onClick={() => quitarDeTanda(p.id)} style={{ fontSize: 11, color: "#c0392b", background: "none", border: "none", cursor: "pointer" }}>✕ Quitar de la tanda</button>
                          </div>
                          {renderCardPedidoActivo(p, false)}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            {tandaError && (
              <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#fdecea", color: "#c0392b", border: "1px solid #f5b7b1", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 300 }}>
                {tandaError}
              </div>
            )}
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
                    <div style={s.formBloque}><label style={{ ...s.formLabel, color: "#F68B32", fontWeight: 700 }}>ELEGIR SUCURSAL</label><select style={s.formInput} value={form.seccion} onChange={e => setForm(f => ({...f, seccion: e.target.value}))}>{TABS.filter(t => t.id !== "nuevo").map(t => <option key={t.id} value={t.id}>{t.label.replace(/🏪|🚚/g, "").trim()}</option>)}</select></div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}><label style={s.formLabel}>Nota</label><textarea style={{ ...s.formInput, height: 60, resize: "vertical" }} value={form.nota} onChange={e => setForm(f => ({...f, nota: e.target.value}))} placeholder="Nota adicional..." /></div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                        <input type="checkbox" checked={form.cobrar} onChange={e => setForm(f => ({...f, cobrar: e.target.checked}))} />
                        <span style={{ color: form.cobrar ? "#c0392b" : "#666", fontWeight: form.cobrar ? 600 : 400 }}>{form.cobrar ? "⚠️ Marcar como COBRAR en entrega" : "Cobrar en entrega"}</span>
                      </label>
                    </div>
                    <div style={{ ...s.formBloque, gridColumn: "span 2" }}>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12 }}>
                        <input type="checkbox" checked={form.esCorporativo} onChange={e => setForm(f => ({...f, esCorporativo: e.target.checked}))} />
                        <span style={{ color: form.esCorporativo ? "#6d28d9" : "#666", fontWeight: form.esCorporativo ? 600 : 400 }}>🏢 Pedido corporativo</span>
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
                  <button style={{ ...s.btnAgregar, width: "100%", padding: "7px", fontSize: 12, background: "#8BC34A", borderColor: "#8BC34A", color: "#101820" }}
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
            <button
              onClick={imprimirComandasLote}
              disabled={comandasPendientes.length === 0}
              title={comandasPendientes.length === 0 ? "No hay comandas pendientes" : `Imprimir ${comandasPendientes.length} comanda(s) de hoy de ${sucursalSeleccionada}`}
              style={{ marginLeft: "auto", fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid", cursor: comandasPendientes.length === 0 ? "not-allowed" : "pointer", borderColor: comandasPendientes.length === 0 ? "#ddd" : "#0c447c", background: comandasPendientes.length === 0 ? "#f5f5f5" : "#0c447c", color: comandasPendientes.length === 0 ? "#aaa" : "#fff", display: "flex", alignItems: "center", gap: 8 }}>
              🖨️ IMPRIMIR COMANDAS
              {comandasPendientes.length > 0 && <span style={{ background: "#fff", color: "#0c447c", borderRadius: 99, fontSize: 11, padding: "1px 8px", fontWeight: 700 }}>{comandasPendientes.length}</span>}
            </button>
            {modoTandaLocal ? (
              <button onClick={salirModoTanda}
                style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid #c0392b", cursor: "pointer", background: "#fff", color: "#c0392b" }}>
                ✕ Cancelar selección
              </button>
            ) : (
              <button onClick={entrarModoTanda}
                title={`Armar una tanda de reparto para ${sucursalSeleccionada}`}
                style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid #7c3aed", cursor: "pointer", background: "#7c3aed", color: "#fff" }}>
                📦 Armar tanda
              </button>
            )}
            <button onClick={() => { setTandaVistaLocal(localLabel(tab)); setVista("tandas"); }}
              title="Ver tandas activas de la sucursal"
              style={{ fontSize: 12, fontWeight: 600, padding: "6px 14px", borderRadius: 6, border: "1px solid #7c3aed", cursor: "pointer", background: "#fff", color: "#7c3aed" }}>
              🚚 Tandas activas
            </button>
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
              const esHoy = fecha === HOY;
              return (
                <div key={key}>
                  <div style={esHoy ? { ...s.franjaHeader, background: "#499342" } : s.franjaHeader}>
                    <span style={esHoy ? { ...s.franjaFecha, color: "#fff" } : s.franjaFecha}>{fechaLabel}</span>
                    <span style={esHoy ? { ...s.franjaHora, color: "#fff" } : s.franjaHora}>{key.split("|")[1]}</span>
                    <span style={esHoy ? { ...s.franjaCount, color: "#fff" } : s.franjaCount}>{grupo.length} pedido{grupo.length > 1 ? "s" : ""}</span>
                  </div>
                  {grupo.map(p => renderCardPedidoActivo(p, !!modoTandaLocal))}
                </div>
              );
            })}
          </div>
          {sobreError && (
            <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#fdecea", color: "#c0392b", border: "1px solid #f5b7b1", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 200 }}>
              {sobreError}
            </div>
          )}
          {tandaError && (
            <div style={{ position: "fixed", bottom: 20, left: "50%", transform: "translateX(-50%)", background: "#fdecea", color: "#c0392b", border: "1px solid #f5b7b1", borderRadius: 8, padding: "8px 16px", fontSize: 13, fontWeight: 500, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 300 }}>
              {tandaError}
            </div>
          )}
          {/* Barra fija para confirmar la tanda en armado */}
          {modoTandaLocal && seleccionTanda.length > 0 && (() => {
            const tandasArmadasLocal = tandas.filter(t => t.estado === "armada" && t.local === modoTandaLocal);
            return (
            <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#2b2b2b", color: "#fff", padding: "12px 24px", display: "flex", alignItems: "center", gap: 16, zIndex: 250, boxShadow: "0 -4px 16px rgba(0,0,0,0.2)" }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{seleccionTanda.length} pedido{seleccionTanda.length > 1 ? "s" : ""} de {modoTandaLocal} seleccionado{seleccionTanda.length > 1 ? "s" : ""}</span>
              {tandasArmadasLocal.length > 0 && (
                <select value="" onChange={e => { const tid = Number(e.target.value); if (tid) agregarPedidosATanda(tid); }}
                  style={{ marginLeft: "auto", fontSize: 13, padding: "8px 10px", borderRadius: 6, border: "1px solid #777", background: "#fff", color: "#333", cursor: "pointer" }}>
                  <option value="">Agregar a tanda…</option>
                  {tandasArmadasLocal.map(t => <option key={t.id} value={t.id}>Tanda #{t.id}{t.nombre ? ` · ${t.nombre}` : ""} ({t.repartidor})</option>)}
                </select>
              )}
              <button onClick={() => { setTandaNombre(""); setTandaRepartidor(""); setConfirmandoTanda(true); }}
                style={{ marginLeft: tandasArmadasLocal.length > 0 ? 0 : "auto", fontSize: 13, fontWeight: 700, padding: "8px 18px", borderRadius: 6, border: "none", cursor: "pointer", background: "#7c3aed", color: "#fff" }}>
                Crear tanda nueva ({seleccionTanda.length})
              </button>
              <button onClick={salirModoTanda} style={{ fontSize: 13, padding: "8px 14px", borderRadius: 6, border: "1px solid #777", cursor: "pointer", background: "transparent", color: "#fff" }}>Cancelar</button>
            </div>
            );
          })()}
          {/* Modal: repartidor (obligatorio) + nombre (opcional) */}
          {confirmandoTanda && (
            <div onClick={() => setConfirmandoTanda(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 400, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
              <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 24, width: 380, boxShadow: "0 8px 40px rgba(0,0,0,0.25)" }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#333", marginBottom: 4 }}>📦 Nueva tanda — {modoTandaLocal}</div>
                <div style={{ fontSize: 12, color: "#888", marginBottom: 16 }}>{seleccionTanda.length} pedido{seleccionTanda.length > 1 ? "s" : ""}</div>
                <div style={{ marginBottom: 12 }}>
                  <label style={{ ...s.formLabel, display: "block", marginBottom: 4 }}>Repartidor *</label>
                  <select style={{ ...s.formInput, width: "100%" }} value={tandaRepartidor} onChange={e => setTandaRepartidor(e.target.value)}>
                    <option value="">Elegí un repartidor…</option>
                    {repartidoresLista.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div style={{ marginBottom: 20 }}>
                  <label style={{ ...s.formLabel, display: "block", marginBottom: 4 }}>Nombre (opcional)</label>
                  <input style={{ ...s.formInput, width: "100%", boxSizing: "border-box" }} value={tandaNombre} onChange={e => setTandaNombre(e.target.value)} placeholder="ej: Recorrido centro" />
                </div>
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button onClick={() => setConfirmandoTanda(false)} style={{ fontSize: 13, padding: "8px 14px", borderRadius: 6, border: "1px solid #ddd", cursor: "pointer", background: "#fff", color: "#555" }}>Cancelar</button>
                  <button onClick={confirmarTanda} disabled={!tandaRepartidor}
                    style={{ fontSize: 13, fontWeight: 700, padding: "8px 18px", borderRadius: 6, border: "none", cursor: tandaRepartidor ? "pointer" : "not-allowed", background: tandaRepartidor ? "#7c3aed" : "#ccc", color: "#fff" }}>
                    Crear tanda
                  </button>
                </div>
              </div>
            </div>
          )}
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