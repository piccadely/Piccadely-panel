    import express from "express";
    import cors from "cors";
    import axios from "axios";

    const app = express();
    app.use(cors());
    app.use(express.json());

    const STORE_ID = "7597872";
    const ACCESS_TOKEN = "657a5d5af8780cd0304f2652e5122b651c60b66c";    
    const headers = {
    Authentication: `bearer ${ACCESS_TOKEN}`,
    "User-Agent": "PiccadelyPanel (piccadely@gmail.com)",
    };

    app.get("/api/orders", async (req, res) => {
    try {
        const response = await axios.get(
        `https://api.tiendanube.com/2025-03/${STORE_ID}/orders`,
        { headers }
        );
        res.json(response.data);
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "Error conectando con Tienda Nube" });
    }
    });
app.get("/api/products", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/products?per_page=200`,
      { headers }
    );
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error trayendo productos" });
  }
});

app.get("/api/categories", async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.tiendanube.com/2025-03/${STORE_ID}/categories`,
      { headers }
    );
    res.json(response.data);
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "Error trayendo categorías" });
  }
});
    app.listen(3001, () => {
    console.log("Servidor corriendo en http://localhost:3001");
    });