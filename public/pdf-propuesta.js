// ─────────────────────────────────────────────────────────────────────────
// Diseño del PDF de propuestas de Piccadely, COMPARTIDO por:
//   - public/regalos.html: la propuesta y el calendario de regalos (van adjuntos al mail al cliente);
//   - el panel (src/App.jsx): la Cotización de "Nuevo pedido".
// Script clásico sin dependencias (regalos.html lo carga con <script>, el panel lo inyecta al usarlo):
// deja todo en window.PDFPropuesta y recibe la clase jsPDF de quien lo usa (regalos: CDN; panel: npm).
// ─────────────────────────────────────────────────────────────────────────
(function () {
  const W = 210;
  const TEXTO = [43, 32, 24], GRIS = [138, 122, 107], LINEA = [236, 226, 212];

  // Hoja con la banda naranja: "Piccadely" + subtítulo a la izquierda y dos líneas a la derecha.
  // header() la repite en cada página nueva.
  // opciones.logo = { dataUrl, ancho, alto } (px de la imagen): en lugar de "Piccadely" escrito va la IMAGEN del
  // logo, a 13 mm de alto y con el ancho proporcional. Sin logo, la banda es la de siempre (regalos.html).
  function nuevo(jsPDF, subtitulo, derecha, opciones = {}) {
    const doc = new jsPDF();
    const logo = opciones.logo;
    const header = () => {
      doc.setFillColor(246, 139, 50); doc.rect(0, 0, W, 30, "F");
      doc.setTextColor(255, 255, 255);
      if (logo) {
        const alto = 13, ancho = alto * logo.ancho / logo.alto;
        doc.addImage(logo.dataUrl, "PNG", 15, 4.5, ancho, alto);
        doc.setFont("helvetica", "normal"); doc.setFontSize(11);
        doc.text(subtitulo, 15, 25);
      } else {
        doc.setFont("helvetica", "bold"); doc.setFontSize(22);
        doc.text("Piccadely", 15, 16);
        doc.setFont("helvetica", "normal"); doc.setFontSize(11);
        doc.text(subtitulo, 15, 23);
      }
      doc.text(derecha[0], W - 15, 16, { align: "right" });
      doc.text(derecha[1], W - 15, 23, { align: "right" });
    };
    header();
    return { doc, W, header };
  }

  // Renglón del detalle: "N x producto" (con foto chica si hay), precio unitario y subtotal alineados a la derecha.
  function renglon(doc, y, { texto, unitario, subtotal, foto }) {
    if (foto) {
      const f = (/^data:image\/(\w+)/.exec(foto) || [])[1];
      try { doc.addImage(foto, f === "png" ? "PNG" : f === "webp" ? "WEBP" : "JPEG", 15, y - 5, 8, 8); } catch (_) {}
    }
    doc.text(doc.splitTextToSize(texto, 125), foto ? 26 : 15, y);
    doc.text(unitario, 160, y, { align: "right" });
    doc.text(subtotal, W - 15, y, { align: "right" });
  }

  // Línea fina que separa el detalle de los totales.
  function separador(doc, y) {
    doc.setDrawColor(...LINEA); doc.line(15, y, W - 15, y);
  }

  // Fila de totales (texto alineado a la derecha + monto); la del total va en negrita y más grande. Devuelve el y siguiente.
  function filaTotal(doc, y, txt, monto, negrita) {
    doc.setFont("helvetica", negrita ? "bold" : "normal"); doc.setFontSize(negrita ? 13 : 10);
    doc.text(txt, 120, y, { align: "right" }); doc.text(monto, W - 15, y, { align: "right" });
    return y + (negrita ? 9 : 7);
  }

  // Pie de la hoja (gris, chico): una línea cada 6 mm desde el borde inferior.
  function pie(doc, lineas) {
    doc.setFontSize(9); doc.setTextColor(...GRIS);
    lineas.forEach((t, i) => doc.text(t, 15, 285 + 6 * i));
  }

  window.PDFPropuesta = { W, TEXTO, GRIS, nuevo, renglon, separador, filaTotal, pie };
})();
