import { useState } from "react";
import axios from "axios";
import { guardarSesion } from "./auth-utils";

const API = "https://piccadely-panel-production.up.railway.app";

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setError("");
    setCargando(true);
    try {
      const res = await axios.post(`${API}/api/login`, {
        username: username.trim(),
        password,
      });
      guardarSesion(res.data.token, res.data.user);
      onLogin(res.data.user);
    } catch (err) {
      const msg = err.response?.data?.error || "Error al ingresar";
      setError(msg);
    }
    setCargando(false);
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "#f7f7f5",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: "system-ui, sans-serif",
      padding: 16,
    }}>
      <form onSubmit={handleSubmit} style={{
        background: "#fff",
        border: "1px solid #eee",
        borderRadius: 12,
        padding: 32,
        width: "100%",
        maxWidth: 360,
        boxShadow: "0 4px 20px rgba(0,0,0,0.05)",
      }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <img
            src="/Piccadely_Logotipo-Centrado-Negro.svg"
            alt="Piccadely"
            style={{ height: 48, objectFit: "contain" }}
          />
        </div>
        <div style={{
          fontSize: 13,
          color: "#888",
          textAlign: "center",
          marginBottom: 24,
        }}>
          Ingresá al panel
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#888",
            textTransform: "uppercase",
            display: "block",
            marginBottom: 5,
          }}>
            Usuario
          </label>
          <input
            type="text"
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="ej: chapa"
            autoFocus
            autoCapitalize="none"
            autoCorrect="off"
            style={{
              fontSize: 14,
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
              width: "100%",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>

        <div style={{ marginBottom: 18 }}>
          <label style={{
            fontSize: 11,
            fontWeight: 600,
            color: "#888",
            textTransform: "uppercase",
            display: "block",
            marginBottom: 5,
          }}>
            Contraseña
          </label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="••••••••"
            style={{
              fontSize: 14,
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px solid #ddd",
              width: "100%",
              boxSizing: "border-box",
              outline: "none",
            }}
          />
        </div>

        {error && (
          <div style={{
            background: "#fdecea",
            border: "1px solid #c0392b",
            borderRadius: 6,
            padding: "8px 12px",
            marginBottom: 14,
            fontSize: 12,
            color: "#c0392b",
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={cargando || !username || !password}
          style={{
            width: "100%",
            padding: 11,
            borderRadius: 8,
            border: "none",
            background: (cargando || !username || !password) ? "#ccc" : "#2a7a4b",
            color: "#fff",
            fontSize: 14,
            fontWeight: 600,
            cursor: (cargando || !username || !password) ? "default" : "pointer",
          }}>
          {cargando ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </div>
  );
}
