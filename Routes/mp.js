import express from "express";
import { MercadoPagoConfig, Preference, Payment } from "mercadopago";

const router = express.Router();

export function mpRouter(pool, mailTransporter) {

  // ─── POST /api/mp/create-preference ────────────────────────────────
  router.post("/create-preference", async (req, res) => {
    const { pedidoId } = req.body;
    try {
      const client = new MercadoPagoConfig({
        accessToken: process.env.MP_ACCESS_TOKEN_PROD,
      });

      const { rows } = await pool.query(
        "SELECT * FROM pedidos_manuales WHERE id = $1",
        [pedidoId]
      );
      let pedido = rows[0];
      let total, email, numero;

      if (pedido) {
        total = Number(pedido.total_num);
        email = pedido.email || null;
        numero = pedido.numero;
      } else {
        const tn = await pool.query(
          "SELECT * FROM pedidos_tn WHERE id = $1",
          [pedidoId]
        );
        if (!tn.rows[0]) return res.status(404).json({ error: "Pedido no encontrado" });
        const data = tn.rows[0].data;
        total = Number(tn.rows[0].total);
        email = tn.rows[0].contact_email || null;
        numero = `#${data.number}`;
      }

      const preference = new Preference(client);
      const response = await preference.create({
        body: {
          items: [{
            id: String(pedidoId),
            title: `Picada Piccadely ${numero}`,
            quantity: 1,
            currency_id: "ARS",
            unit_price: total,
          }],
          payer: email ? { email } : undefined,
          back_urls: {
            success: "https://piccadely-panel.vercel.app/pedidos",
            failure: "https://piccadely-panel.vercel.app/pedidos",
            pending: "https://piccadely-panel.vercel.app/pedidos",
          },
          notification_url:
            "https://piccadely-panel-production.up.railway.app/api/mp/webhook",
        },
      });

      await pool.query(
        "UPDATE pedidos_manuales SET mp_preference_id = $1 WHERE id = $2",
        [response.id, pedidoId]
      ).catch(() => {});

      await pool.query(
        "UPDATE pedidos_tn SET mp_preference_id = $1 WHERE id = $2",
        [response.id, pedidoId]
      ).catch(() => {});

      console.log(`MP preference creada: ${response.id} para pedido ${pedidoId}`);
      // Mandar el link por mail al cliente
      if (email && mailTransporter) {
        mailTransporter.sendMail({
          from: `Piccadely <${process.env.GMAIL_USER}>`,
          to: email,
          subject: `💳 Tu link de pago - Piccadely ${numero}`,
          html: `
            <!DOCTYPE html>
            <html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
              <div style="max-width:600px;margin:0 auto;background:#fff;">
                <div style="background:#F68B32;padding:30px 24px;text-align:center;">
                  <h1 style="margin:0;color:#fff;font-size:28px;">Piccadely</h1>
                  <p style="margin:8px 0 0;color:#fff;font-size:14px;">Link de pago</p>
                </div>
                <div style="padding:24px;">
                  <p style="font-size:15px;color:#333;">Hola! Te enviamos el link para abonar tu pedido <strong>${numero}</strong>.</p>
                  <div style="text-align:center;margin:28px 0;">
                    <a href="${response.init_point}"
                      style="background:#009ee3;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:16px;font-weight:700;display:inline-block;">
                      💳 Pagar con Mercado Pago
                    </a>
                  </div>
                  <p style="font-size:13px;color:#888;text-align:center;">
                    O copiá este link: <a href="${response.init_point}" style="color:#009ee3;">${response.init_point}</a>
                  </p>
                  <p style="font-size:13px;color:#F68B32;font-style:italic;text-align:center;font-weight:bold;">
                    Si hay piccada, que sea Piccadely. Piccadely, con doble C.
                  </p>
                </div>
                <div style="background:#f5f5f5;padding:16px 24px;text-align:center;color:#999;font-size:11px;">
                  Piccadely · Alvarez Thomas 1558 · French 2615
                </div>
              </div>
            </body></html>
          `,
        }).catch(err => console.error("Mail link MP falló:", err.message));
        console.log(`💳 Mail link MP enviado a ${email} para pedido ${numero}`);
      }

      res.json({ init_point: response.init_point });
    
    } catch (err) {
      console.error("MP create-preference error:", err);
      res.status(500).json({ error: "Error al crear preferencia de pago" });
    }
  });

  // ─── POST /api/mp/webhook ───────────────────────────────────────────
  // Maneja tanto el formato nuevo (JSON body) como IPN viejo (query params)
  router.post("/webhook", async (req, res) => {
    res.sendStatus(200);

    // Detectar formato: nuevo webhook o IPN viejo
    const topic = req.body?.type || req.query?.topic;
    const dataId = req.body?.data?.id || req.query?.id;

    console.log("MP webhook recibido:", JSON.stringify({ topic, dataId, body: req.body, query: req.query }));

    if (!dataId) {
      console.log("MP webhook: sin ID, ignorando");
      return;
    }

    // IPN viejo puede enviar topic "payment" o "merchant_order"
    if (topic && topic !== "payment") {
      console.log(`MP webhook: topic '${topic}' ignorado`);
      return;
    }

    try {
      const client = new MercadoPagoConfig({
        accessToken: process.env.MP_ACCESS_TOKEN_PROD,
      });
      const paymentClient = new Payment(client);
      const payment = await paymentClient.get({ id: dataId });

    console.log(`MP pago ${dataId}: status=${payment.status} preference_id=${payment.preference_id}`);
console.log(`MP pago objeto keys:`, Object.keys(payment));

      if (payment.status !== "approved") return;

      const paymentId = payment.id;
      const preferenceId = payment.preference_id;

      // Buscar pedido en ambas tablas
      const manual = await pool.query(
        "SELECT * FROM pedidos_manuales WHERE mp_preference_id = $1",
        [preferenceId]
      );
      const esTN = manual.rows.length === 0;
      let pedido, clienteEmail, clienteNombre, pedidoNumero;

      if (!esTN) {
        pedido = manual.rows[0];
        clienteEmail = pedido.email;
        clienteNombre = pedido.cliente;
        pedidoNumero = pedido.numero;
      } else {
        const tn = await pool.query(
          "SELECT * FROM pedidos_tn WHERE mp_preference_id = $1",
          [preferenceId]
        );
        if (!tn.rows[0]) {
          console.log(`MP webhook: no se encontró pedido con preference_id ${preferenceId}`);
          return;
        }
        pedido = tn.rows[0];
        clienteEmail = pedido.contact_email;
        clienteNombre = pedido.contact_name;
        pedidoNumero = `#${pedido.data?.number || pedido.id}`;
      }

      const ahora = new Date().toLocaleString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        day: "2-digit", month: "2-digit", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });

      const notaAnterior = pedido.nota || "";
      const nuevaNota = notaAnterior
        ? `${notaAnterior}\nPagado MP #${paymentId} · ${ahora}`
        : `Pagado MP #${paymentId} · ${ahora}`;

      if (!esTN) {
        await pool.query(
          `UPDATE pedidos_manuales
           SET nota = $1, cobrar = false, pago = 'Pagado', mp_payment_id = $2
           WHERE id = $3`,
          [nuevaNota, String(paymentId), pedido.id]
        );
      } else {
        const dataActualizada = { ...pedido.data, _mp_nota: nuevaNota, _mp_payment_id: String(paymentId) };
        await pool.query(
          "UPDATE pedidos_tn SET mp_payment_id = $1, data = $2 WHERE id = $3",
          [String(paymentId), JSON.stringify(dataActualizada), pedido.id]
        );
        await pool.query(
          `INSERT INTO pedidos_estados (id, cobrar, updated_at)
           VALUES ($1, false, NOW())
           ON CONFLICT (id) DO UPDATE SET cobrar = false, updated_at = NOW()`,
          [String(pedido.id)]
        );
      }

      // Mail confirmación de pago al cliente
      if (clienteEmail && mailTransporter) {
        mailTransporter.sendMail({
          from: `Piccadely <${process.env.GMAIL_USER}>`,
          to: clienteEmail,
          subject: `✅ Piccadely · Pago confirmado ${pedidoNumero}`,
          html: `
            <!DOCTYPE html>
            <html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif;">
              <div style="max-width:600px;margin:0 auto;background:#fff;">
                <div style="background:#F68B32;padding:30px 24px;text-align:center;">
                  <h1 style="margin:0;color:#fff;font-size:28px;">Piccadely</h1>
                  <p style="margin:8px 0 0;color:#fff;font-size:14px;">Pago confirmado</p>
                </div>
                <div style="padding:24px;">
                  <p style="font-size:16px;color:#333;">Hola <strong>${clienteNombre || ""}</strong>,</p>
                  <p style="font-size:14px;color:#555;">
                    Confirmamos que recibimos tu pago para el pedido <strong>${pedidoNumero}</strong>. 
                    ¡Tu picada está en camino! 🧀🍷
                  </p>
                  <p style="font-size:13px;color:#F68B32;font-style:italic;text-align:center;font-weight:bold;">
                    Si hay piccada, que sea Piccadely. Piccadely, con doble C.
                  </p>
                </div>
                <div style="background:#f5f5f5;padding:16px 24px;text-align:center;color:#999;font-size:11px;">
                  Piccadely · Alvarez Thomas 1558 · French 2615
                </div>
              </div>
            </body></html>
          `,
        }).catch(err => console.error("Mail pago MP falló:", err.message));
      }

      console.log(`✅ MP pago procesado: ${paymentId} → pedido ${pedidoNumero}`);
    } catch (err) {
      console.error("MP webhook error:", err);
    }
  });

  // ─── GET /api/mp/webhook (validación IPN) ──────────────────────────
  router.get("/webhook", (req, res) => {
    res.sendStatus(200);
  });

  return router;
}