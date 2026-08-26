import { useState } from "react";
import axios from "axios";
import { guardarSesion } from "./auth-utils";

const API = import.meta.env.VITE_API_URL || "https://piccadely-panel-production.up.railway.app";

const cardStyle = { background: "#fff", border: "1px solid #eee", borderRadius: 12, padding: 32, width: "100%", maxWidth: 360, boxShadow: "0 4px 20px rgba(0,0,0,0.05)" };
const labelStyle = { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", display: "block", marginBottom: 5 };
const inputStyle = { fontSize: 14, padding: "9px 12px", borderRadius: 8, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", outline: "none" };
const errorBox = { background: "#fdecea", border: "1px solid #c0392b", borderRadius: 6, padding: "8px 12px", marginBottom: 14, fontSize: 12, color: "#c0392b" };
const infoBox = { background: "#eaf3de", border: "1px solid #F68B32", borderRadius: 6, padding: "8px 12px", marginBottom: 14, fontSize: 12, color: "#27500a" };
const btnStyle = (disabled) => ({ width: "100%", padding: 11, borderRadius: 8, border: "none", background: disabled ? "#ccc" : "#F68B32", color: "#fff", fontSize: 14, fontWeight: 600, cursor: disabled ? "default" : "pointer" });

export default function Login({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(false);
  // 2FA (paso 2)
  const [paso, setPaso] = useState("credenciales"); // "credenciales" | "codigo"
  const [challengeToken, setChallengeToken] = useState("");
  const [codigo, setCodigo] = useState("");
  const [info, setInfo] = useState("");

  // Paso 1: usuario + contraseña
  async function handleSubmit(e) {
    e.preventDefault();
    if (!username || !password) return;
    setError(""); setInfo(""); setCargando(true);
    try {
      const res = await axios.post(`${API}/api/login`, { username: username.trim(), password });
      if (res.data.requiere2FA) {
        setChallengeToken(res.data.challengeToken);
        setCodigo("");
        setPaso("codigo");
      } else {
        guardarSesion(res.data.token, res.data.user);
        onLogin(res.data.user);
      }
    } catch (err) {
      setError(err.response?.data?.error || "Error al ingresar");
    }
    setCargando(false);
  }

  // Paso 2: código de 6 dígitos
  async function handleVerificar(e) {
    e.preventDefault();
    if (codigo.length < 6) return;
    setError(""); setInfo(""); setCargando(true);
    try {
      const res = await axios.post(`${API}/api/login/2fa`, { challengeToken, codigo });
      guardarSesion(res.data.token, res.data.user);
      onLogin(res.data.user);
    } catch (err) {
      setError(err.response?.data?.error || "Código incorrecto o vencido");
    }
    setCargando(false);
  }

  async function handleReenviar() {
    setError(""); setInfo("");
    try {
      await axios.post(`${API}/api/login/2fa/reenviar`, { challengeToken });
      setInfo("Código reenviado. Revisá tu email.");
    } catch (err) {
      setError(err.response?.data?.error || "No se pudo reenviar el código");
    }
  }

  function volver() {
    setPaso("credenciales"); setChallengeToken(""); setCodigo(""); setError(""); setInfo("");
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f7f7f5", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui, sans-serif", padding: 16 }}>
      {paso === "credenciales" ? (
        <form onSubmit={handleSubmit} style={cardStyle}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <img src="/Piccadely_Logotipo-Centrado-Negro.svg" alt="Piccadely" style={{ height: 48, objectFit: "contain" }} />
          </div>
          <div style={{ fontSize: 13, color: "#888", textAlign: "center", marginBottom: 24 }}>Ingresá al panel</div>

          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Usuario</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)} placeholder="ej: chapa"
              autoFocus autoCapitalize="none" autoCorrect="off" style={inputStyle} />
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={labelStyle}>Contraseña</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" style={inputStyle} />
          </div>

          {error && <div style={errorBox}>{error}</div>}

          <button type="submit" disabled={cargando || !username || !password} style={btnStyle(cargando || !username || !password)}>
            {cargando ? "Ingresando..." : "Ingresar"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleVerificar} style={cardStyle}>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <img src="/Piccadely_Logotipo-Centrado-Negro.svg" alt="Piccadely" style={{ height: 48, objectFit: "contain" }} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#333", textAlign: "center", marginBottom: 6 }}>🔐 Verificación en 2 pasos</div>
          <div style={{ fontSize: 13, color: "#888", textAlign: "center", marginBottom: 20 }}>Te enviamos un código a tu email. Ingresalo:</div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>Código de 6 dígitos</label>
            <input type="text" value={codigo}
              onChange={e => { setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
              placeholder="000000" autoFocus inputMode="numeric" maxLength={6}
              style={{ ...inputStyle, textAlign: "center", letterSpacing: 6, fontSize: 20, fontWeight: 700 }} />
          </div>

          {error && <div style={errorBox}>{error}</div>}
          {info && <div style={infoBox}>{info}</div>}

          <button type="submit" disabled={cargando || codigo.length < 6} style={btnStyle(cargando || codigo.length < 6)}>
            {cargando ? "Verificando..." : "Ingresar"}
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
            <button type="button" onClick={volver} style={{ background: "none", border: "none", color: "#888", fontSize: 12, cursor: "pointer", padding: 0 }}>← Volver</button>
            <button type="button" onClick={handleReenviar} disabled={cargando} style={{ background: "none", border: "none", color: "#F68B32", fontSize: 12, fontWeight: 600, cursor: cargando ? "default" : "pointer", padding: 0 }}>Reenviar código</button>
          </div>
        </form>
      )}
    </div>
  );
}
