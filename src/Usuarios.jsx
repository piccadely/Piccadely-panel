import { useState, useEffect } from "react";
import axios from "axios";
import { ROL_LABELS, getUsuarioGuardado } from "./auth-utils";

const API = import.meta.env.VITE_API_URL || "https://piccadely-panel-production.up.railway.app";

const FORM_VACIO = {
  username: "",
  nombre_completo: "",
  rol: "a_thomas",
  password: "",
  email_2fa: "",
};

export default function Usuarios({ onVolver }) {
  const [usuarios, setUsuarios] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modal, setModal] = useState(null); // null | "nuevo" | "editar" | "password"
  const [usuarioEditando, setUsuarioEditando] = useState(null);
  const [form, setForm] = useState(FORM_VACIO);
  const [passwordNueva, setPasswordNueva] = useState("");
  const [guardando, setGuardando] = useState(false);
  const [mensaje, setMensaje] = useState(null);
  const [codigo2fa, setCodigo2fa] = useState("");
  const [enviado2fa, setEnviado2fa] = useState(false);
  const [verif2fa, setVerif2fa] = useState(null); // null | "ok" | "bad"
  const yo = getUsuarioGuardado(); // usuario logueado (el botón "Probar 2FA" solo va sobre su propia fila)

  async function cargarUsuarios() {
    setLoading(true);
    try {
      const res = await axios.get(`${API}/api/usuarios`);
      setUsuarios(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || "Error cargando usuarios");
    }
    setLoading(false);
  }

  useEffect(() => { cargarUsuarios(); }, []);

  function mostrarMensaje(texto, tipo = "ok") {
    setMensaje({ texto, tipo });
    setTimeout(() => setMensaje(null), 3000);
  }

  async function crearUsuario() {
    if (!form.username || !form.nombre_completo || !form.password) {
      mostrarMensaje("Completá todos los campos", "error");
      return;
    }
    if (form.password.length < 6) {
      mostrarMensaje("La contraseña debe tener al menos 6 caracteres", "error");
      return;
    }
    setGuardando(true);
    try {
      await axios.post(`${API}/api/usuarios`, form);
      await cargarUsuarios();
      setModal(null);
      setForm(FORM_VACIO);
      mostrarMensaje(`Usuario "${form.username}" creado correctamente`);
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error creando usuario", "error");
    }
    setGuardando(false);
  }

  async function editarUsuario() {
    setGuardando(true);
    try {
      await axios.patch(`${API}/api/usuarios/${usuarioEditando.id}`, {
        nombre_completo: form.nombre_completo,
        rol: form.rol,
        activo: usuarioEditando.activo,
        email_2fa: form.email_2fa,
      });
      await cargarUsuarios();
      setModal(null);
      setUsuarioEditando(null);
      mostrarMensaje("Usuario actualizado");
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error editando usuario", "error");
    }
    setGuardando(false);
  }

  async function cambiarPassword() {
    if (!passwordNueva || passwordNueva.length < 6) {
      mostrarMensaje("La contraseña debe tener al menos 6 caracteres", "error");
      return;
    }
    setGuardando(true);
    try {
      await axios.patch(`${API}/api/usuarios/${usuarioEditando.id}`, {
        password: passwordNueva,
      });
      setModal(null);
      setUsuarioEditando(null);
      setPasswordNueva("");
      mostrarMensaje(`Contraseña actualizada para ${usuarioEditando.username}`);
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error cambiando contraseña", "error");
    }
    setGuardando(false);
  }

  async function toggleActivo(usuario) {
    if (!window.confirm(`¿${usuario.activo ? "Desactivar" : "Activar"} usuario "${usuario.username}"?`)) return;
    try {
      await axios.patch(`${API}/api/usuarios/${usuario.id}`, { activo: !usuario.activo });
      await cargarUsuarios();
      mostrarMensaje(`Usuario ${!usuario.activo ? "activado" : "desactivado"}`);
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error", "error");
    }
  }

  async function eliminarUsuario(usuario) {
    if (!window.confirm(`¿ELIMINAR PERMANENTEMENTE al usuario "${usuario.username}"?\n\nEsta acción no se puede deshacer.`)) return;
    try {
      await axios.delete(`${API}/api/usuarios/${usuario.id}`);
      await cargarUsuarios();
      mostrarMensaje(`Usuario "${usuario.username}" eliminado`);
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error eliminando", "error");
    }
  }

  function abrir2fa(u) {
    setUsuarioEditando(u);
    setCodigo2fa(""); setEnviado2fa(false); setVerif2fa(null);
    setModal("2fa");
  }
  async function probar2faEnviar() {
    setGuardando(true);
    try {
      const res = await axios.post(`${API}/api/2fa/test-enviar`);
      setEnviado2fa(true); setVerif2fa(null);
      mostrarMensaje(`Código enviado a ${res.data.enviadoA}`);
    } catch (err) {
      mostrarMensaje(err.response?.data?.error || "Error enviando código", "error");
    }
    setGuardando(false);
  }
  async function probar2faVerificar() {
    setGuardando(true);
    try {
      const res = await axios.post(`${API}/api/2fa/test-verificar`, { codigo: codigo2fa });
      setVerif2fa(res.data.valido ? "ok" : "bad");
    } catch (err) {
      setVerif2fa("bad");
    }
    setGuardando(false);
  }

  function abrirNuevo() {
    setForm(FORM_VACIO);
    setModal("nuevo");
  }

  function abrirEditar(u) {
    setUsuarioEditando(u);
    setForm({ username: u.username, nombre_completo: u.nombre_completo, rol: u.rol, password: "", email_2fa: u.email_2fa || "" });
    setModal("editar");
  }

  function abrirPassword(u) {
    setUsuarioEditando(u);
    setPasswordNueva("");
    setModal("password");
  }

  const rolColor = {
    superadmin: { bg: "#fdecea", text: "#c0392b", border: "#c0392b" },
    admin: { bg: "#fef9e7", text: "#856404", border: "#f39c12" },
    encargado: { bg: "#f3e8fd", text: "#6d28d9", border: "#8b5cf6" },
    solo_lectura: { bg: "#f1f1f1", text: "#555", border: "#bbb" },
    a_thomas: { bg: "#e6f1fb", text: "#0c447c", border: "#3b82f6" },
    french: { bg: "#eaf3de", text: "#27500a", border: "#F68B32" },
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <button style={st.btnVolver} onClick={onVolver}>← Volver</button>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: "#333", margin: 0 }}>👥 Usuarios del sistema</h2>
        <button style={{ marginLeft: "auto", fontSize: 12, padding: "7px 14px", borderRadius: 6, border: "none", background: "#F68B32", color: "#fff", cursor: "pointer", fontWeight: 600 }}
          onClick={abrirNuevo}>+ Nuevo usuario</button>
      </div>

      {mensaje && (
        <div style={{ marginBottom: 16, padding: "10px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500,
          background: mensaje.tipo === "error" ? "#fdecea" : "#eaf3de",
          color: mensaje.tipo === "error" ? "#c0392b" : "#27500a",
          border: `1px solid ${mensaje.tipo === "error" ? "#c0392b" : "#F68B32"}` }}>
          {mensaje.tipo === "error" ? "❌ " : "✅ "}{mensaje.texto}
        </div>
      )}

      {error && <div style={{ background: "#fdecea", color: "#c0392b", padding: 14, borderRadius: 8, marginBottom: 16 }}>{error}</div>}
      {loading ? <div style={{ color: "#aaa", fontSize: 13 }}>Cargando usuarios...</div> : (
        <div style={st.tabla}>
          <div style={st.cabecera}>
            <span style={{ ...st.col, flex: 0.4, textAlign: "center" }}>ID</span>
            <span style={{ ...st.col, flex: 1 }}>Usuario</span>
            <span style={{ ...st.col, flex: 1.6 }}>Nombre completo</span>
            <span style={{ ...st.col, flex: 0.9, textAlign: "center" }}>Rol</span>
            <span style={{ ...st.col, flex: 0.6, textAlign: "center" }}>Estado</span>
            <span style={{ ...st.col, flex: 1.8, textAlign: "right" }}>Acciones</span>
          </div>
          {usuarios.length === 0 && <div style={{ padding: 40, textAlign: "center", color: "#aaa", fontSize: 13 }}>Sin usuarios</div>}
          {usuarios.map(u => {
            const rc = rolColor[u.rol] || { bg: "#eee", text: "#555", border: "#ddd" };
            return (
              <div key={u.id} style={{ ...st.fila, opacity: u.activo ? 1 : 0.55 }}>
                <span style={{ ...st.cel, flex: 0.4, textAlign: "center", color: "#aaa", fontWeight: 600 }}>#{u.id}</span>
                <span style={{ ...st.cel, flex: 1, fontWeight: 600, color: "#F68B32" }}>{u.username}</span>
                <span style={{ ...st.cel, flex: 1.6 }}>{u.nombre_completo}{u.email_2fa && <span title={`2FA a ${u.email_2fa}`} style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: "#eef2ff", color: "#4f46e5", border: "1px solid #c7d2fe", whiteSpace: "nowrap" }}>🔐 2FA</span>}</span>
                <span style={{ ...st.cel, flex: 0.9, textAlign: "center" }}>
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 4, background: rc.bg, color: rc.text, border: `1px solid ${rc.border}` }}>
                    {ROL_LABELS[u.rol] || u.rol}
                  </span>
                </span>
                <span style={{ ...st.cel, flex: 0.6, textAlign: "center" }}>
                  {u.activo
                    ? <span style={{ fontSize: 11, fontWeight: 600, color: "#F68B32" }}>● Activo</span>
                    : <span style={{ fontSize: 11, fontWeight: 600, color: "#aaa" }}>○ Inactivo</span>}
                </span>
                <span style={{ ...st.cel, flex: 1.8, textAlign: "right", display: "flex", justifyContent: "flex-end", gap: 4, flexWrap: "wrap" }}>
                  <button style={st.btnAccion} onClick={() => abrirEditar(u)}>✏️ Editar</button>
                  {yo?.id === u.id && u.email_2fa && <button style={{ ...st.btnAccion, color: "#4f46e5", borderColor: "#c7d2fe" }} onClick={() => abrir2fa(u)}>🔐 Probar 2FA</button>}
                  <button style={st.btnAccion} onClick={() => abrirPassword(u)}>🔑 Password</button>
                  <button style={{ ...st.btnAccion, color: u.activo ? "#856404" : "#27500a", borderColor: u.activo ? "#f39c12" : "#F68B32" }} onClick={() => toggleActivo(u)}>
                    {u.activo ? "⊘ Desactivar" : "✓ Activar"}
                  </button>
                  <button style={{ ...st.btnAccion, color: "#c0392b", borderColor: "#c0392b" }} onClick={() => eliminarUsuario(u)}>🗑</button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL NUEVO / EDITAR */}
      {(modal === "nuevo" || modal === "editar") && (
        <div style={st.modalOverlay}>
          <div style={st.modal}>
            <div style={st.modalHeader}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#333" }}>
                  {modal === "nuevo" ? "➕ Nuevo usuario" : `✏️ Editar ${usuarioEditando?.username}`}
                </div>
              </div>
              <button style={st.btnCerrar} onClick={() => { setModal(null); setUsuarioEditando(null); setForm(FORM_VACIO); }}>✕</button>
            </div>
            <div style={{ display: "grid", gap: 12 }}>
              <div>
                <label style={st.label}>Username</label>
                <input style={{ ...st.input, opacity: modal === "editar" ? 0.5 : 1 }}
                  value={form.username}
                  onChange={e => setForm(f => ({ ...f, username: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "") }))}
                  placeholder="usuario_minusculas"
                  disabled={modal === "editar"} />
                {modal === "editar" && <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>El username no se puede cambiar</div>}
              </div>
              <div>
                <label style={st.label}>Nombre completo</label>
                <input style={st.input} value={form.nombre_completo}
                  onChange={e => setForm(f => ({ ...f, nombre_completo: e.target.value }))}
                  placeholder="Nombre Apellido" />
              </div>
              <div>
                <label style={st.label}>Rol</label>
                <select style={st.input} value={form.rol} onChange={e => setForm(f => ({ ...f, rol: e.target.value }))}>
                  <option value="superadmin">Superadmin (todo + caja Administración)</option>
                  <option value="admin">Admin (todo menos caja Administración)</option>
                  <option value="encargado">Encargado (todo menos plata/administración)</option>
                  <option value="solo_lectura">Solo lectura (ve como encargado, no modifica)</option>
                  <option value="a_thomas">A. Thomas</option>
                  <option value="french">French</option>
                </select>
              </div>
              <div>
                <label style={st.label}>Email para 2FA (opcional)</label>
                <input type="email" style={st.input} value={form.email_2fa}
                  onChange={e => setForm(f => ({ ...f, email_2fa: e.target.value }))}
                  placeholder="mail@ejemplo.com" autoCapitalize="none" autoCorrect="off" />
                <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>Vacío = sin 2FA (entra normal). Con mail = se le pedirá un código al ingresar.</div>
              </div>
              {modal === "nuevo" && (
                <div>
                  <label style={st.label}>Contraseña inicial</label>
                  <input type="text" style={st.input} value={form.password}
                    onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                    placeholder="Mínimo 6 caracteres" />
                  <div style={{ fontSize: 11, color: "#aaa", marginTop: 4 }}>El usuario podrá cambiarla luego de iniciar sesión</div>
                </div>
              )}
            </div>
            <button style={{ ...st.btnPrimary, marginTop: 18, opacity: guardando ? 0.5 : 1 }}
              disabled={guardando}
              onClick={modal === "nuevo" ? crearUsuario : editarUsuario}>
              {guardando ? "Guardando..." : modal === "nuevo" ? "Crear usuario" : "Guardar cambios"}
            </button>
          </div>
        </div>
      )}

      {/* MODAL CAMBIAR PASSWORD */}
      {modal === "password" && (
        <div style={st.modalOverlay}>
          <div style={{ ...st.modal, width: 400 }}>
            <div style={st.modalHeader}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#333" }}>🔑 Cambiar contraseña</div>
              <button style={st.btnCerrar} onClick={() => { setModal(null); setUsuarioEditando(null); setPasswordNueva(""); }}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 12 }}>
              Usuario: <strong>{usuarioEditando?.username}</strong> ({usuarioEditando?.nombre_completo})
            </div>
            <label style={st.label}>Nueva contraseña</label>
            <input type="text" style={st.input} value={passwordNueva}
              onChange={e => setPasswordNueva(e.target.value)}
              placeholder="Mínimo 6 caracteres"
              autoFocus />
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 6 }}>
              ⚠️ Comunicale al usuario su nueva contraseña por un canal seguro
            </div>
            <button style={{ ...st.btnPrimary, marginTop: 18, opacity: guardando ? 0.5 : 1 }}
              disabled={guardando}
              onClick={cambiarPassword}>
              {guardando ? "Guardando..." : "Cambiar contraseña"}
            </button>
          </div>
        </div>
      )}

      {/* MODAL PROBAR 2FA */}
      {modal === "2fa" && (
        <div style={st.modalOverlay}>
          <div style={{ ...st.modal, width: 420 }}>
            <div style={st.modalHeader}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#333" }}>🔐 Probar 2FA</div>
              <button style={st.btnCerrar} onClick={() => { setModal(null); setUsuarioEditando(null); }}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: "#666", marginBottom: 14 }}>
              Se envía un código al mail 2FA de <strong>{usuarioEditando?.username}</strong> ({usuarioEditando?.email_2fa}).
            </div>
            <button style={{ ...st.btnPrimary, opacity: guardando ? 0.5 : 1 }} disabled={guardando} onClick={probar2faEnviar}>
              {guardando && !enviado2fa ? "Enviando..." : enviado2fa ? "Reenviar código" : "Enviar código al mail"}
            </button>
            {enviado2fa && (
              <div style={{ marginTop: 16 }}>
                <label style={st.label}>Código recibido (6 dígitos)</label>
                <input style={st.input} value={codigo2fa}
                  onChange={e => { setCodigo2fa(e.target.value.replace(/\D/g, "").slice(0, 6)); setVerif2fa(null); }}
                  placeholder="000000" inputMode="numeric" autoFocus />
                <button style={{ ...st.btnPrimary, marginTop: 12, opacity: (guardando || codigo2fa.length < 6) ? 0.5 : 1 }}
                  disabled={guardando || codigo2fa.length < 6} onClick={probar2faVerificar}>
                  {guardando ? "Verificando..." : "Verificar código"}
                </button>
                {verif2fa === "ok" && <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700, color: "#27500a", textAlign: "center" }}>✓ Código válido</div>}
                {verif2fa === "bad" && <div style={{ marginTop: 14, fontSize: 15, fontWeight: 700, color: "#c0392b", textAlign: "center" }}>✗ Código incorrecto</div>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const st = {
  btnVolver: { fontSize: 12, padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555" },
  tabla: { background: "#fff", border: "1px solid #eee", borderRadius: 8, overflow: "hidden" },
  cabecera: { display: "flex", padding: "12px 14px", background: "#f9f9f7", fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: 0.3, borderBottom: "1px solid #eee" },
  col: { padding: "0 6px" },
  fila: { display: "flex", alignItems: "center", padding: "12px 14px", borderBottom: "1px solid #f5f5f5", fontSize: 13 },
  cel: { padding: "0 6px", color: "#333" },
  btnAccion: { fontSize: 11, padding: "5px 10px", borderRadius: 5, border: "1px solid #ddd", background: "#fff", cursor: "pointer", color: "#555", fontWeight: 500 },
  modalOverlay: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.5)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 },
  modal: { background: "#fff", borderRadius: 12, padding: 24, width: 480, maxHeight: "92vh", overflowY: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.25)" },
  modalHeader: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  btnCerrar: { border: "none", background: "none", fontSize: 20, cursor: "pointer", color: "#aaa" },
  label: { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", marginBottom: 4, display: "block" },
  input: { fontSize: 13, padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", width: "100%", boxSizing: "border-box", outline: "none" },
  btnPrimary: { width: "100%", padding: 11, borderRadius: 8, border: "none", background: "#F68B32", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" },
};