app.post("/api/facturar", async (req, res) => {
  const { pedidoId, tipo, cliente, documentoTipo, documentoNro, razonSocial, domicilio, email, total, productos } = req.body;

  const esFacturaA = tipo === "FACTURA A";
  const esExento = tipo === "FACTURA B EXENTO";
  const sinDatos = !documentoNro || String(documentoNro).trim() === "";
  const totalNum = Number(total);

  console.log("FACTURAR:", { tipo, totalNum, documentoNro, sinDatos });

  if (!totalNum || totalNum <= 0) {
    return res.json({ ok: false, error: "Total inválido: " + total });
  }

  const tipoComprobante = esFacturaA ? "FACTURA A" : "FACTURA B";

  const clienteObj = (sinDatos && !esFacturaA) ? {
    documento_tipo: "DNI", documento_nro: "0",
    razon_social: "Consumidor Final", email: "",
    domicilio: "Sin domicilio", provincia: "2",
    condicion_pago: "201", condicion_iva: "CF", condicion_iva_operacion: "CF",
    envia_por_mail: "N", reclama_deuda: "N",
  } : {
    documento_tipo: documentoTipo, documento_nro: String(documentoNro).trim() || "0",
    razon_social: razonSocial || cliente, email: email || "",
    domicilio: domicilio || "Sin domicilio", provincia: "2",
    condicion_pago: "201",
    condicion_iva: esFacturaA ? "RI" : "CF",
    condicion_iva_operacion: esFacturaA ? "RI" : "CF",
    envia_por_mail: email ? "S" : "N", reclama_deuda: "N",
  };

  const descripcion = productos.map(p => p.descripcion).join(", ").substring(0, 200);

  // iva_incluido: "S" → precio_unitario_sin_iva es el precio CON IVA incluido
  // TusFacturas se encarga de desglosar el IVA internamente
  const detalle = [{
    cantidad: 1,
    bonificacion_porcentaje: 0,
    afecta_stock: "N",
    iva_incluido: esExento ? "N" : "S",
    producto: {
      descripcion,
      codigo: "VENTA",
      lista_precios: "standard",
      leyenda: "",
      unidad_bulto: 1,
      alicuota: esExento ? 0 : 21,
      precio_unitario_sin_iva: totalNum,
      actualiza_precio: "S",
    },
  }];

  const body = {
    apitoken: TF_APITOKEN, usertoken: TF_USERTOKEN, apikey: TF_APIKEY,
    cliente: clienteObj,
    comprobante: {
      fecha: fechaHoy(),
      vencimiento: fechaVencimiento(30),
      tipo: tipoComprobante,
      operacion: "V",
      moneda: "PES",
      cotizacion: 1,
      punto_venta: TF_PDV,
      rubro: "Alimentos y bebidas",
      rubro_grupo_contable: "Alimentos",
      bonificacion: 0,
      external_reference: String(pedidoId) || `pedido-${Date.now()}`,
      detalle,
    },
  };

  console.log("TF body:", JSON.stringify(body, null, 2));

  try {
    const response = await axios.post(
      "https://www.tusfacturas.app/app/api/v2/facturacion/nuevo",
      body, { headers: { "Content-Type": "application/json" } }
    );
    const data = response.data;
    console.log("TF response:", JSON.stringify(data));
    if (data.error === "N") {
      await pool.query(`
        INSERT INTO facturas (pedido_id, tipo, numero, cae, vencimiento_cae, cliente, documento_tipo, documento_nro, total, pdf_url, fecha, datos_raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [pedidoId, tipo, data.comprobante_nro, data.cae, data.vencimiento_cae,
          clienteObj.razon_social, clienteObj.documento_tipo, clienteObj.documento_nro,
          totalNum, data.comprobante_pdf_url || "", fechaHoy(), JSON.stringify(data)]);
      res.json({ ok: true, data });
    } else {
      res.json({ ok: false, error: data.errores || data });
    }
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});