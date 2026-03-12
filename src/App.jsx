import { useState, useEffect, useRef, useCallback } from "react";

// ═══════════════════════════════════════════════════════════════════════════════
// ─── OIU 3-LAYER SYNC ENGINE ──────────────────────────────────────────────────
// Layer 1: localStorage  — instant reads, small data, always available offline
// Layer 2: IndexedDB     — large media (images/videos as base64), offline-first
// Layer 3: CloudDB       — cross-device sync via Anthropic API key-value store
// ═══════════════════════════════════════════════════════════════════════════════

// ── LAYER 1: localStorage ────────────────────────────────────────────────────
const LS = {
  get: (k, def=null) => { try { const v=localStorage.getItem(k); return v?JSON.parse(v):def; } catch { return def; } },
  set: (k, v)  => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del: (k)     => { try { localStorage.removeItem(k); } catch {} },
};

// ── LAYER 2: IndexedDB (for media & large payloads) ──────────────────────────
const IDB = (() => {
  let _db = null;
  const DB_NAME = "oiu_idb", DB_VER = 1, STORE = "kv";
  const open = () => new Promise((res, rej) => {
    if (_db) return res(_db);
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE);
    req.onsuccess = e => { _db = e.target.result; res(_db); };
    req.onerror   = () => rej(req.error);
  });
  return {
    get: async (k) => {
      try { const db=await open(); return new Promise((res,rej)=>{ const r=db.transaction(STORE).objectStore(STORE).get(k); r.onsuccess=()=>res(r.result??null); r.onerror=()=>rej(r.error); }); }
      catch { return null; }
    },
    set: async (k, v) => {
      try { const db=await open(); return new Promise((res,rej)=>{ const r=db.transaction(STORE,"readwrite").objectStore(STORE).put(v,k); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); }
      catch { return false; }
    },
    del: async (k) => {
      try { const db=await open(); return new Promise((res,rej)=>{ const r=db.transaction(STORE,"readwrite").objectStore(STORE).delete(k); r.onsuccess=()=>res(true); r.onerror=()=>rej(r.error); }); }
      catch { return false; }
    },
    keys: async (prefix="") => {
      try {
        const db=await open();
        return new Promise((res,rej)=>{ const r=db.transaction(STORE).objectStore(STORE).getAllKeys(); r.onsuccess=()=>res((r.result||[]).filter(k=>k.startsWith(prefix))); r.onerror=()=>rej(r.error); });
      } catch { return []; }
    },
  };
})();

// ── LAYER 3: ServerDB — talks to your own PostgreSQL server on port 4000 ───────
// Change API_BASE if you deploy to a real domain, e.g. https://api.your-server.com
const API_BASE = "http://localhost:4000";

const ServerDB = (() => {
  let _online = navigator.onLine;
  window.addEventListener("online",  () => { _online = true;  });
  window.addEventListener("offline", () => { _online = false; });

  const getToken = () => localStorage.getItem("oiu_jwt");
  const saveToken = (t) => localStorage.setItem("oiu_jwt", t);
  const clearToken = () => localStorage.removeItem("oiu_jwt");

  const api = async (method, path, body) => {
    const token = getToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || "API error");
    }
    return res.json();
  };

  return {
    isOnline: () => _online,
    getToken, saveToken, clearToken,

    // Auth
    login:         (sid, contact, password) => api("POST", "/api/auth/login", { sid, contact, password }),
    register:      (data)                   => api("POST", "/api/auth/register", data),
    sendCode:      (contact, purpose)       => api("POST", "/api/auth/send-code", { contact, purpose }),
    verifyCode:    (contact, purpose, code) => api("POST", "/api/auth/verify-code", { contact, purpose, code }),
    resetPassword: (sid, contact, new_password) => api("POST", "/api/auth/reset-password", { sid, contact, new_password }),

    // Posts
    pushPost:        (post)   => api("POST",   "/api/posts", { content: post.content||"", feeling: post.feeling||undefined, visibility: post.visibility||"college" }),
    pullPostsSince:  (sinceTs)=> api("GET",    `/api/posts/since/${sinceTs}`),
    fetchFeed:       (p={})   => api("GET",    `/api/posts?${new URLSearchParams(p)}`),
    deletePost:      (id)     => api("DELETE", `/api/posts/${id}`),
    reactPost:       (id, emoji) => api("POST", `/api/posts/${id}/react`, { emoji }),
    addComment:      (id, content) => api("POST", `/api/posts/${id}/comments`, { content }),
    getComments:     (id)     => api("GET",    `/api/posts/${id}/comments`),
    pinPost:         (id)     => api("PATCH",  `/api/posts/${id}/pin`),

    // Legacy shim methods so old CloudDB call-sites don't crash
    pushPosts:  async (posts) => { for (const p of posts) { try { await ServerDB.pushPost(p); } catch {} } return true; },
    pullUsers:  async ()      => null,
    pushUser:   async ()      => true,
    set:        async ()      => true,
    get:        async ()      => null,
  };
})();

// Alias — keeps every CloudDB.xxx call working without changes
const CloudDB = ServerDB;

// ── DB FACADE — single interface to all 3 layers ─────────────────────────────
const DB = {
  // ─ Auth & Session ─
  getUsers: () => LS.get("oiu_users", []),
  saveUsers: (u) => LS.set("oiu_users", u),
  getSession: () => LS.get("oiu_session", null),
  saveSession: (s) => LS.set("oiu_session", s),
  clearSession: () => LS.del("oiu_session"),

  // ─ Verification codes ─
  getCodes: () => LS.get("oiu_vcodes", {}),
  saveCode: (key, code, expires) => {
    const c = DB.getCodes(); c[key] = { code, expires };
    LS.set("oiu_vcodes", c);
  },
  verifyCode: (key, code) => {
    const c = DB.getCodes(); const entry = c[key];
    if (!entry) return false;
    if (Date.now() > entry.expires) { delete c[key]; LS.set("oiu_vcodes", c); return false; }
    if (entry.code === code) { delete c[key]; LS.set("oiu_vcodes", c); return true; }
    return false;
  },

  // ─ Per-user data (Layer 1 fast path) ─
  getUserData: (uid, key, def) => LS.get(`oiu_u${uid}_${key}`, def),
  saveUserData: (uid, key, val) => LS.set(`oiu_u${uid}_${key}`, val),

  // ─ Posts: write to L1+L2 immediately, async push to L3 ─
  getPosts: () => LS.get("oiu_posts", []),
  savePosts: async (posts) => {
    LS.set("oiu_posts", posts);
    // Store in IDB without media (media goes separately)
    await IDB.set("oiu_posts", posts);
    // Async cloud push — don't await, fire and forget
    CloudDB.pushPosts(posts).catch(()=>{});
  },
  getPostsSince: (ts) => {
    const all = LS.get("oiu_posts", []);
    return all.filter(p => (p.ts||0) > ts);
  },

  // ─ Media: stored ONLY in IndexedDB (large binary) ─
  saveMedia: async (postId, dataUrl) => {
    await IDB.set(`oiu_media_${postId}`, dataUrl);
  },
  getMedia: async (postId) => {
    return await IDB.get(`oiu_media_${postId}`);
  },

  // ─ Sync: pull cloud posts and merge with local ─
  syncFromCloud: async (sinceTs) => {
    const cloudPosts = await CloudDB.pullPostsSince(sinceTs);
    if (!cloudPosts || cloudPosts.length === 0) return null;
    return cloudPosts;
  },

  // ─ Online status ─
  isOnline: () => CloudServerDB.isOnline(),
};

// Pre-seed demo users if empty — also tries to pull from cloud for cross-device
// seedDemoUsers is no longer needed — users are stored in the server database.
// Demo accounts are seeded by running: node scripts/seed.js
const seedDemoUsers = async () => {};

// Email simulation via EmailJS-compatible free service (simulated in-app)
const sendVerificationCode = async (contact, type) => {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const key = `${type}:${contact}`;
  DB.saveCode(key, code, Date.now() + 10 * 60 * 1000); // 10 min expiry

  // Simulate email send — In production, use EmailJS free tier
  // For demo: show the code in console + return it so UI can display it
  console.log(`📧 Verification code for ${contact}: ${code}`);
  return { code, key }; // We'll show code in UI for demo purposes
};

// ─── COLLEGE → DEPARTMENT MAPPING ────────────────────────────────────────────
const COLLEGE_DEPARTMENTS = {
  "Faculty of Computer Science": ["Computer Science", "Information Systems", "Software Engineering", "Cybersecurity"],
  "Faculty of Islamic Law": ["Islamic Jurisprudence", "Sharia & Law", "Islamic Finance", "Comparative Fiqh"],
  "Faculty of Arabic Language": ["Arabic Literature", "Arabic Linguistics", "Translation", "Media & Communication"],
  "Faculty of Education": ["Educational Technology", "Curriculum & Instruction", "Special Education", "Early Childhood"],
  "Faculty of Medicine": ["General Medicine", "Pharmacy", "Nursing", "Public Health"],
  "Faculty of Engineering": ["Civil Engineering", "Electrical Engineering", "Mechanical Engineering", "Architecture"],
  "Faculty of Economics": ["Accounting", "Business Administration", "Economics", "Islamic Economics"],
};
const COLLEGES = Object.keys(COLLEGE_DEPARTMENTS);

// ─── AUTH COLORS ──────────────────────────────────────────────────────────────
const AC = {
  navy:"#0f3d1a", dark:"#091509", gold:"#c9a43e",
  green:"#1a5c2a", light:"#e8f5e9", border:"rgba(26,92,42,.15)",
  text:"#1c2d1e", muted:"#5a7a60", input:"#f5f2eb",
  card:"#ffffff", error:"#c62828", errorBg:"#ffebee",
};

// ─── AUTH GATE ────────────────────────────────────────────────────────────────
function AuthGate({ onLogin }) {
  const [screen, setScreen] = useState("login"); // login | register | forgot | verify
  const [verifyCtx, setVerifyCtx] = useState(null); // { mode, contact, contactType, userData?, codeKey, demoCode }
  const [err, setErr] = useState("");
  const [info, setInfo] = useState("");
  const [loading, setLoading] = useState(false);

  // Login fields
  const [loginSid, setLoginSid] = useState("");
  const [loginContact, setLoginContact] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [showPass, setShowPass] = useState(false);

  // Register fields
  const [regSid, setRegSid] = useState("");
  const [regName, setRegName] = useState("");
  const [regContact, setRegContact] = useState(""); // email or phone
  const [regPass, setRegPass] = useState("");
  const [regCollege, setRegCollege] = useState(COLLEGES[0]);
  const [regDept, setRegDept] = useState(COLLEGE_DEPARTMENTS[COLLEGES[0]][0]);
  const [regYear, setRegYear] = useState("1");

  // Forgot fields
  const [fgtSid, setFgtSid] = useState("");
  const [fgtContact, setFgtContact] = useState("");
  const [newPass, setNewPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");

  // Verify field
  const [vCode, setVCode] = useState("");
  const [aiSuggestLoading, setAiSuggestLoading] = useState(false);

  useEffect(() => { seedDemoUsers(); }, []);
  useEffect(() => { setErr(""); setInfo(""); }, [screen]);

  const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
  const isPhone = s => /^[0-9+\-\s]{7,15}$/.test(s);

  // ── LOGIN ──────────────────────────────────────────────────────────────────
  const handleLogin = async (e) => {
    e && e.preventDefault();
    setErr(""); setLoading(true);
    try {
      const { user, token } = await ServerDB.login(loginSid, loginContact, loginPass);
      ServerDB.saveToken(token);
      const sessionUser = { ...user, token };
      DB.saveSession(sessionUser);
      setLoading(false);
      onLogin(sessionUser);
    } catch (err) {
      setErr(err.message || "Invalid university ID, email/phone, or password.");
      setLoading(false);
    }
  };

  // ── REGISTER STEP 1: send verification ────────────────────────────────────
  const handleRegister = async (e) => {
    e && e.preventDefault();
    setErr("");
    if (!/^\d{6,12}$/.test(regSid)) { setErr("University ID must be 6-12 digits (numbers only)."); return; }
    if (!regName.trim()) { setErr("Please enter your full name."); return; }
    if (!isEmail(regContact) && !isPhone(regContact)) { setErr("Enter a valid email address or phone number."); return; }
    if (regPass.length < 6) { setErr("Password must be at least 6 characters."); return; }
    const users = DB.getUsers();
    if (users.find(u => u.sid === regSid)) { setErr("A user with this university ID already exists."); return; }
    if (users.find(u => u.email === regContact || u.phone === regContact)) { setErr("This email/phone is already registered."); return; }

    setLoading(true);
    try {
      const result = await ServerDB.sendCode(regContact, "register");
      const demoCode = result.demo_code || "------";
      const contactType = isEmail(regContact) ? "email" : "phone";
      setVerifyCtx({
        mode: "register",
        contact: regContact,
        contactType,
        demoCode,
        codeKey: `register:${regContact}`,
        userData: { sid:regSid, name:regName.trim(), email:isEmail(regContact)?regContact:"", phone:isPhone(regContact)&&!isEmail(regContact)?regContact:"", college:regCollege, department:regDept, year:parseInt(regYear), gpa:0, points:0, rank:0, password:regPass }
      });
      setScreen("verify");
    } catch (err) {
      setErr(err.message || "Failed to send verification code.");
    }
    setLoading(false);
  };

  // ── FORGOT STEP 1: send verification ──────────────────────────────────────
  const handleForgot = async (e) => {
    e && e.preventDefault();
    setErr("");
    if (!fgtSid.trim() || !fgtContact.trim()) { setErr("Please enter your university ID and email/phone."); return; }

    setLoading(true);
    try {
      const result = await ServerDB.sendCode(fgtContact, "forgot");
      const demoCode = result.demo_code || "------";
      const contactType = isEmail(fgtContact) ? "email" : "phone";
      setVerifyCtx({
        mode: "forgot",
        contact: fgtContact,
        contactType,
        demoCode,
        codeKey: `forgot:${fgtContact}`,
        userId: null
      });
      setScreen("verify");
    } catch (err) {
      setErr(err.message || "No account found with that university ID and email/phone.");
    }
    setLoading(false);
  };

  // ── VERIFY ─────────────────────────────────────────────────────────────────
  const handleVerify = async (e) => {
    e && e.preventDefault();
    setErr("");
    if (!vCode.trim()) { setErr("Please enter the verification code."); return; }

    try {
      await ServerDB.verifyCode(verifyCtx.contact, verifyCtx.mode === "register" ? "register" : "forgot", vCode.trim());
    } catch {
      setErr("Invalid or expired code. Please try again."); return;
    }

    if (verifyCtx.mode === "register") {
      try {
        const ud = verifyCtx.userData;
        const { user, token } = await ServerDB.register({
          sid: ud.sid, name: ud.name, email: ud.email || undefined,
          phone: ud.phone || undefined, password: ud.password,
          college: ud.college, department: ud.department, year: ud.year,
        });
        ServerDB.saveToken(token);
        const sessionUser = { ...user, token };
        DB.saveSession(sessionUser);
        onLogin(sessionUser);
      } catch (err) {
        setErr(err.message || "Registration failed. Please try again.");
      }
    } else if (verifyCtx.mode === "forgot") {
      setScreen("resetpass");
    }
  };

  // ── RESET PASSWORD ──────────────────────────────────────────────────────────
  const handleResetPass = async (e) => {
    e && e.preventDefault();
    setErr("");
    if (newPass.length < 6) { setErr("Password must be at least 6 characters."); return; }
    if (newPass !== confirmPass) { setErr("Passwords do not match."); return; }
    try {
      await ServerDB.resetPassword(fgtSid, verifyCtx.contact, newPass);
      setInfo("Password reset successfully! Please log in.");
    } catch (err) {
      setErr(err.message || "Failed to reset password.");
      return;
    }
    setScreen("login");
  };

  const inp = {
    width:"100%", padding:"12px 16px", border:`1.5px solid ${AC.border}`,
    borderRadius:12, fontSize:14, fontFamily:"inherit", outline:"none",
    color:AC.text, background:AC.input, boxSizing:"border-box", transition:"border .2s",
  };
  const btn = {
    width:"100%", padding:"13px", background:`linear-gradient(135deg,${AC.green},${AC.navy})`,
    color:"#fff", border:"none", borderRadius:12, fontSize:15, fontWeight:800,
    cursor:"pointer", letterSpacing:.3, transition:"opacity .2s",
  };
  const link = { background:"none", border:"none", color:AC.green, cursor:"pointer", fontSize:13, fontWeight:700, textDecoration:"underline", padding:0 };

  return (
    <div style={{ minHeight:"100vh", background:`linear-gradient(160deg,${AC.dark} 0%,${AC.navy} 40%,#1a3a22 100%)`, display:"flex", alignItems:"center", justifyContent:"center", padding:20, fontFamily:"'DM Sans','Segoe UI',sans-serif" }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700;9..40,800;9..40,900&family=Amiri:wght@400;700&display=swap');*{box-sizing:border-box}input:focus{border-color:${AC.green}!important;box-shadow:0 0 0 3px rgba(26,92,42,.15)}@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}`}</style>

      {/* Background decoration */}
      <div style={{ position:"fixed", inset:0, overflow:"hidden", pointerEvents:"none" }}>
        {[...Array(6)].map((_,i)=>(
          <div key={i} style={{ position:"absolute", borderRadius:"50%", background:`rgba(201,164,62,${0.03+i*0.01})`, width:200+i*100, height:200+i*100, top:`${10+i*12}%`, left:`${-10+i*15}%`, }} />
        ))}
      </div>

      <div style={{ width:"100%", maxWidth:440, animation:"fadeUp .4s ease" }}>
        {/* Logo */}
        <div style={{ textAlign:"center", marginBottom:28 }}>
          <svg width="60" height="72" viewBox="0 0 100 120" fill="none" style={{ filter:"drop-shadow(0 4px 20px rgba(201,164,62,.3))" }}>
            <path d="M50 5 L92 24 L92 72 Q92 102 50 118 Q8 102 8 72 L8 24 Z" fill="#0f3d1a" stroke="#c9a43e" strokeWidth="3"/>
            <path d="M50 13 L85 30 L85 70 Q85 97 50 111 Q15 97 15 70 L15 30 Z" fill="none" stroke="#c9a43e" strokeWidth="1.5"/>
            <text x="50" y="73" textAnchor="middle" fontFamily="Georgia,serif" fontWeight="900" fontSize="24" fill="#c9a43e">OIU</text>
            <line x1="32" y1="80" x2="68" y2="80" stroke="#c9a43e" strokeWidth="1.2"/>
            <text x="50" y="91" textAnchor="middle" fontFamily="serif" fontSize="8.5" fill="rgba(201,164,62,.7)">١٣٣٢ هـ</text>
          </svg>
          <div style={{ fontFamily:"'Amiri',serif", fontSize:22, color:"#fff", fontWeight:700, marginTop:8 }}>جامعة أم درمان الإسلامية</div>
          <div style={{ fontSize:13, color:"rgba(255,255,255,.5)", marginTop:2 }}>Omdurman Islamic University Portal</div>
        </div>

        {/* Card */}
        <div style={{ background:"rgba(255,255,255,.97)", borderRadius:24, padding:32, boxShadow:"0 24px 80px rgba(0,0,0,.4)" }}>

          {/* ── LOGIN ── */}
          {screen === "login" && (
            <>
              <h2 style={{ fontSize:22, fontWeight:900, color:AC.text, margin:"0 0 6px" }}>Welcome Back 👋</h2>
              <p style={{ color:AC.muted, fontSize:13, margin:"0 0 24px" }}>Sign in to your OIU account</p>
              {err && <div style={{ background:AC.errorBg, color:AC.error, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:16 }}>⚠️ {err}</div>}
              {info && <div style={{ background:"#e8f5e9", color:AC.green, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:16 }}>✅ {info}</div>}
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>UNIVERSITY ID</label>
                  <input value={loginSid} onChange={e=>setLoginSid(e.target.value)} placeholder="e.g. 20220001" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>EMAIL OR PHONE</label>
                  <input value={loginContact} onChange={e=>setLoginContact(e.target.value)} placeholder="email@oiu.edu or 09xxxxxxxx" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>PASSWORD</label>
                  <div style={{ position:"relative" }}>
                    <input value={loginPass} onChange={e=>setLoginPass(e.target.value)} type={showPass?"text":"password"} placeholder="••••••••" style={{...inp, paddingRight:48}} onKeyDown={e=>e.key==="Enter"&&handleLogin()} />
                    <button onClick={()=>setShowPass(s=>!s)} style={{ position:"absolute", right:14, top:"50%", transform:"translateY(-50%)", background:"none", border:"none", cursor:"pointer", fontSize:16, color:AC.muted }}>{showPass?"🙈":"👁"}</button>
                  </div>
                </div>
                <button onClick={handleLogin} disabled={loading} style={{...btn, opacity:loading?.7:1}}>{loading?"Signing in…":"Sign In →"}</button>
              </div>
              <div style={{ marginTop:18, display:"flex", justifyContent:"space-between", flexWrap:"wrap", gap:8 }}>
                <button onClick={()=>setScreen("forgot")} style={link}>Forgot password?</button>
                <button onClick={()=>setScreen("register")} style={link}>Create account →</button>
              </div>
              <div style={{ marginTop:20, padding:"12px 16px", background:"#f0fdf4", borderRadius:12, border:"1px solid #bbf7d0" }}>
                <div style={{ fontSize:11, fontWeight:700, color:AC.green, marginBottom:4 }}>🎓 DEMO ACCOUNTS</div>
                <div style={{ fontSize:11, color:AC.muted }}>ID: <b>20220001</b> · Email: ahmed.hassan@oiu.edu · Pass: pass123</div>
                <div style={{ fontSize:11, color:AC.muted }}>ID: <b>20220002</b> · Email: fatima@oiu.edu · Pass: pass123</div>
              </div>
            </>
          )}

          {/* ── REGISTER ── */}
          {screen === "register" && (
            <>
              <h2 style={{ fontSize:22, fontWeight:900, color:AC.text, margin:"0 0 6px" }}>Create Account 🎓</h2>
              <p style={{ color:AC.muted, fontSize:13, margin:"0 0 20px" }}>Register as a new OIU student</p>
              {err && <div style={{ background:AC.errorBg, color:AC.error, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:14 }}>⚠️ {err}</div>}
              <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>UNIVERSITY ID <span style={{ color:AC.error }}>*</span></label>
                  <input value={regSid} onChange={e=>setRegSid(e.target.value.replace(/\D/g,""))} placeholder="Numbers only, e.g. 20220045" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>FULL NAME <span style={{ color:AC.error }}>*</span></label>
                  <input value={regName} onChange={e=>setRegName(e.target.value)} placeholder="Your full name" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>EMAIL OR PHONE <span style={{ color:AC.error }}>*</span></label>
                  <input value={regContact} onChange={e=>setRegContact(e.target.value)} placeholder="email@example.com or 09xxxxxxxx" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>PASSWORD <span style={{ color:AC.error }}>*</span></label>
                  <input value={regPass} onChange={e=>setRegPass(e.target.value)} type="password" placeholder="Min 6 characters" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>COLLEGE <span style={{ color:AC.error }}>*</span></label>
                  <select value={regCollege} onChange={e=>{ setRegCollege(e.target.value); setRegDept(COLLEGE_DEPARTMENTS[e.target.value][0]); }} style={{...inp, cursor:"pointer"}}>
                    {COLLEGES.map(c=><option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>DEPARTMENT <span style={{ color:AC.error }}>*</span></label>
                  <div style={{ display:"flex", gap:8 }}>
                    <select value={regDept} onChange={e=>setRegDept(e.target.value)} style={{...inp, cursor:"pointer", flex:1}}>
                      {(COLLEGE_DEPARTMENTS[regCollege]||[]).map(d=><option key={d}>{d}</option>)}
                    </select>
                    <button type="button" disabled={aiSuggestLoading||!regName.trim()} onClick={async()=>{
                      setAiSuggestLoading(true);
                      try {
                        const res = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-5",max_tokens:100,messages:[{role:"user",content:`A student named "${regName}" is enrolling in "${regCollege}" at Omdurman Islamic University. Based ONLY on their name and college, suggest the single most likely department from this list: ${COLLEGE_DEPARTMENTS[regCollege].join(", ")}. Reply with ONLY the department name, nothing else.`}]})});
                        const data = await res.json();
                        const suggested = data.content?.[0]?.text?.trim();
                        if (suggested && COLLEGE_DEPARTMENTS[regCollege].includes(suggested)) { setRegDept(suggested); }
                      } catch(e) {}
                      setAiSuggestLoading(false);
                    }} style={{ padding:"0 12px", background:aiSuggestLoading?"#ccc":`linear-gradient(135deg,${AC.green},${AC.navy})`, color:"#fff", border:"none", borderRadius:10, fontSize:11, fontWeight:700, cursor:aiSuggestLoading?"not-allowed":"pointer", whiteSpace:"nowrap", flexShrink:0 }}>
                      {aiSuggestLoading ? "🤖…" : "🤖 AI Suggest"}
                    </button>
                  </div>
                  <div style={{ fontSize:10, color:AC.muted, marginTop:4 }}>Kaido AI will suggest your department based on your name & college</div>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>ACADEMIC YEAR</label>
                  <select value={regYear} onChange={e=>setRegYear(e.target.value)} style={{...inp, cursor:"pointer"}}>
                    {["1","2","3","4","5"].map(y=><option key={y} value={y}>Year {y}</option>)}
                  </select>
                </div>
                <button onClick={handleRegister} disabled={loading} style={{...btn, opacity:loading?.7:1}}>{loading?"Sending code…":"Send Verification Code →"}</button>
              </div>
              <div style={{ marginTop:16, textAlign:"center" }}>
                <button onClick={()=>setScreen("login")} style={link}>← Back to login</button>
              </div>
            </>
          )}

          {/* ── FORGOT PASSWORD ── */}
          {screen === "forgot" && (
            <>
              <h2 style={{ fontSize:22, fontWeight:900, color:AC.text, margin:"0 0 6px" }}>Forgot Password 🔑</h2>
              <p style={{ color:AC.muted, fontSize:13, margin:"0 0 24px" }}>We'll send a code to verify your identity</p>
              {err && <div style={{ background:AC.errorBg, color:AC.error, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:16 }}>⚠️ {err}</div>}
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>UNIVERSITY ID</label>
                  <input value={fgtSid} onChange={e=>setFgtSid(e.target.value)} placeholder="e.g. 20220001" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>EMAIL OR PHONE ON YOUR ACCOUNT</label>
                  <input value={fgtContact} onChange={e=>setFgtContact(e.target.value)} placeholder="email@oiu.edu or 09xxxxxxxx" style={inp} />
                </div>
                <button onClick={handleForgot} disabled={loading} style={{...btn, opacity:loading?.7:1}}>{loading?"Checking…":"Send Reset Code →"}</button>
              </div>
              <div style={{ marginTop:16, textAlign:"center" }}>
                <button onClick={()=>setScreen("login")} style={link}>← Back to login</button>
              </div>
            </>
          )}

          {/* ── VERIFY CODE ── */}
          {screen === "verify" && verifyCtx && (
            <>
              <h2 style={{ fontSize:22, fontWeight:900, color:AC.text, margin:"0 0 6px" }}>Verify Your Identity ✉️</h2>
              <p style={{ color:AC.muted, fontSize:13, margin:"0 0 4px" }}>
                A 6-digit code was sent to your {verifyCtx.contactType}:
              </p>
              <div style={{ fontSize:13, fontWeight:700, color:AC.green, marginBottom:20, wordBreak:"break-all" }}>{verifyCtx.contact}</div>

              {/* Demo code display box */}
              <div style={{ background:"#fff8e1", border:"1.5px dashed #f9a825", borderRadius:12, padding:"12px 16px", marginBottom:20 }}>
                <div style={{ fontSize:11, fontWeight:700, color:"#f57f17", marginBottom:4 }}>📱 DEMO MODE — Verification Code</div>
                <div style={{ fontSize:28, fontWeight:900, color:"#e65100", letterSpacing:8, textAlign:"center" }}>{verifyCtx.demoCode}</div>
                <div style={{ fontSize:11, color:"#bf360c", marginTop:4, textAlign:"center" }}>Valid for 10 minutes</div>
              </div>

              {err && <div style={{ background:AC.errorBg, color:AC.error, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:16 }}>⚠️ {err}</div>}
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>ENTER 6-DIGIT CODE</label>
                  <input value={vCode} onChange={e=>setVCode(e.target.value.replace(/\D/g,"").slice(0,6))} placeholder="000000" style={{...inp, fontSize:22, letterSpacing:8, textAlign:"center", fontWeight:900}} maxLength={6} onKeyDown={e=>e.key==="Enter"&&handleVerify()} />
                </div>
                <button onClick={handleVerify} disabled={vCode.length<6} style={{...btn, opacity:vCode.length<6?.5:1}}>Verify & Continue →</button>
              </div>
              <div style={{ marginTop:16, textAlign:"center", display:"flex", justifyContent:"space-between" }}>
                <button onClick={()=>{ setScreen(verifyCtx.mode==="register"?"register":"forgot"); setVCode(""); }} style={link}>← Change details</button>
                <button onClick={async()=>{ const {code,key}=await sendVerificationCode(verifyCtx.contact,verifyCtx.mode==="register"?"reg":"fgt"); setVerifyCtx(v=>({...v,demoCode:code,codeKey:key})); setVCode(""); }} style={link}>Resend code</button>
              </div>
            </>
          )}

          {/* ── RESET PASSWORD ── */}
          {screen === "resetpass" && (
            <>
              <h2 style={{ fontSize:22, fontWeight:900, color:AC.text, margin:"0 0 6px" }}>Set New Password 🔒</h2>
              <p style={{ color:AC.muted, fontSize:13, margin:"0 0 24px" }}>Choose a strong password for your account</p>
              {err && <div style={{ background:AC.errorBg, color:AC.error, borderRadius:10, padding:"10px 14px", fontSize:13, fontWeight:600, marginBottom:16 }}>⚠️ {err}</div>}
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>NEW PASSWORD</label>
                  <input value={newPass} onChange={e=>setNewPass(e.target.value)} type="password" placeholder="Min 6 characters" style={inp} />
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:AC.muted, display:"block", marginBottom:5 }}>CONFIRM PASSWORD</label>
                  <input value={confirmPass} onChange={e=>setConfirmPass(e.target.value)} type="password" placeholder="Repeat password" style={inp} onKeyDown={e=>e.key==="Enter"&&handleResetPass()} />
                </div>
                <button onClick={handleResetPass} style={btn}>Reset Password →</button>
              </div>
            </>
          )}

        </div>

        <div style={{ textAlign:"center", marginTop:16, fontSize:12, color:"rgba(255,255,255,.35)" }}>
          © 2026 Omdurman Islamic University · Powered by OIU Portal
        </div>
      </div>
    </div>
  );
}


// ─── CLAUDE AI CONFIG ─────────────────────────────────────────────────────────
const callClaudeAI = async (messages, systemPrompt) => {
  const apiMessages = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .map(m => ({ role: m.role, content: m.text }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 1000,
      system: systemPrompt,
      messages: apiMessages,
    })
  });
  const data = await res.json();
  return data.content?.[0]?.text || "عذراً، لم أتمكن من الرد. / Sorry, couldn't respond.";
};

// ─── i18n TRANSLATIONS ────────────────────────────────────────────────────────
const T = {
  en: {
    dir:"ltr", portal:"OIU Portal", greeting:"Good morning", dashboard:"Dashboard",
    feed:"Social Feed", channels:"Channels", assignments:"Assignments", grades:"Grades",
    timetable:"Timetable", announcements:"Announcements", events:"Events",
    leaderboard:"Leaderboard", rooms:"Study Rooms", library:"Library", finance:"Finance",
    prayer:"Prayer Times", map:"Campus Map", tutor:"Kaido AI", quiz:"Exam Quiz",
    settings:"Settings", people:"People", messages:"Messages", notifications:"Notifications",
    profile:"My Profile", signOut:"Sign Out", main:"Main", academic:"Academic",
    services:"Services", studyTools:"Study Tools", connect:"Connect",
    pending:"Pending", submitted:"Submitted", graded:"Graded",
    submit:"Submit", send:"Send", post:"Post", close:"Close", save:"Save",
    search:"Search", cancel:"Cancel", today:"Today", viewAll:"View all →",
    noClasses:"No classes today 🎉", friends:"Friends", online:"Online", offline:"Offline",
    pendingTasks:"Pending Tasks", currentGpa:"Current GPA", campusRank:"Campus Rank",
    latestNotices:"Latest Notices", todaySchedule:"Today's Schedule", friendsOnline:"Friends Online",
    upcomingAssignments:"Upcoming Assignments", kaidoTitle:"🤖 Kaido AI Assistant",
    kaidoSub:"Your multilingual AI — Sudanese Arabic · English · French · and more",
    kaidoPlaceholder:"Ask Kaido anything… اسأل كيدو أي شيء…",
    langBtn:"العربية 🌐", groups:"Groups",
  },
  ar: {
    dir:"rtl", portal:"بوابة OIU", greeting:"صباح الخير", dashboard:"الرئيسية",
    feed:"المنشورات", channels:"القنوات", assignments:"الواجبات", grades:"الدرجات",
    timetable:"الجدول الدراسي", announcements:"الإعلانات", events:"الفعاليات",
    leaderboard:"المتصدرون", rooms:"غرف الدراسة", library:"المكتبة", finance:"الشؤون المالية",
    prayer:"مواقيت الصلاة", map:"خريطة الحرم", tutor:"كيدو AI", quiz:"اختبار التحضير",
    settings:"الإعدادات", people:"الأصدقاء", messages:"الرسائل", notifications:"الإشعارات",
    profile:"ملفي الشخصي", signOut:"تسجيل الخروج", main:"الرئيسية", academic:"الأكاديمية",
    services:"الخدمات", studyTools:"أدوات الدراسة", connect:"التواصل",
    pending:"قيد الانتظار", submitted:"مُسلَّم", graded:"مُقيَّم",
    submit:"إرسال", send:"إرسال", post:"نشر", close:"إغلاق", save:"حفظ",
    search:"بحث", cancel:"إلغاء", today:"اليوم", viewAll:"عرض الكل →",
    noClasses:"لا توجد محاضرات اليوم 🎉", friends:"أصدقاء", online:"متصل", offline:"غير متصل",
    pendingTasks:"المهام المعلقة", currentGpa:"المعدل الحالي", campusRank:"الترتيب",
    latestNotices:"آخر الإعلانات", todaySchedule:"جدول اليوم", friendsOnline:"الأصدقاء المتصلون",
    upcomingAssignments:"الواجبات القادمة", kaidoTitle:"🤖 مساعد كيدو الذكي",
    kaidoSub:"مساعدك متعدد اللغات — عربي سوداني · إنجليزي · فرنسي · والمزيد",
    kaidoPlaceholder:"اسأل كيدو أي شيء… Ask Kaido anything…",
    langBtn:"English 🌐", groups:"المجموعات",
  }
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const PALETTE = ["#1a5c2a","#2e5d4b","#7b3f00","#4a148c","#006064","#b71c1c","#1565c0","#558b2f","#c9a43e","#2d4a6b"];
const scol = s => { let h=0; for(let i=0;i<s.length;i++) h=s.charCodeAt(i)+((h<<5)-h); return PALETTE[Math.abs(h)%PALETTE.length]; };
const inits = n => (n||"?").split(" ").map(w=>w[0]).join("").slice(0,2).toUpperCase();
const fmtDate = iso => { try{return new Date(iso).toLocaleDateString("en-GB",{day:"numeric",month:"short"})}catch{return iso||""} };

const REACTIONS = [
  { key:"❤️", label:"Love" }, { key:"👍", label:"Like" }, { key:"😂", label:"Haha" },
  { key:"😮", label:"Wow" },  { key:"😢", label:"Sad" },  { key:"🙏", label:"Pray" },
  { key:"🔥", label:"Fire" }, { key:"💯", label:"100" },
];

const ME_DEFAULT = { id:1, name:"Ahmed Hassan", sid:"OIU-2022-001", college:"Faculty of Computer Science", department:"Computer Science", year:3, gpa:3.7, email:"ahmed.hassan@oiu.edu", points:1240, rank:3 };

const STUDENTS = [
  { id:2, name:"Fatima Al-Rashid",  college:"Faculty of Islamic Law",      year:2, gpa:3.9, points:1580, rank:1, status:"online",  bio:"Passionate about Fiqh and Islamic jurisprudence." },
  { id:3, name:"Omar Abdulkarim",   college:"Faculty of Arabic Language",  year:4, gpa:3.5, points:1420, rank:2, status:"online",  bio:"Arabic literature enthusiast and poet." },
  { id:4, name:"Mariam Yusuf",      college:"Faculty of Computer Science", year:3, gpa:3.8, points:1180, rank:4, status:"offline", bio:"Full-stack developer & AI researcher." },
  { id:5, name:"Ibrahim Al-Nour",   college:"Faculty of Education",        year:1, gpa:3.2, points:950,  rank:5, status:"online",  bio:"Future educator, passionate about pedagogy." },
  { id:6, name:"Zainab Mohammed",   college:"Faculty of Islamic Law",      year:4, gpa:3.6, points:890,  rank:6, status:"offline", bio:"Studying comparative Islamic law." },
  { id:7, name:"Khalid Hassan",     college:"Faculty of Computer Science", year:2, gpa:3.4, points:820,  rank:7, status:"online",  bio:"Mobile developer & tech enthusiast." },
  { id:8, name:"Aisha Osman",       college:"Faculty of Arabic Language",  year:3, gpa:3.7, points:760,  rank:8, status:"offline", bio:"Linguist and calligrapher." },
];

const CHANNELS = [
  { id:"ch1", name:"OIU Official",         icon:"🕌", desc:"University announcements and news",            members:1247, pinned:true  },
  { id:"ch2", name:"CS Department",         icon:"💻", desc:"Computer Science department updates",          members:312,  pinned:false },
  { id:"ch3", name:"Islamic Studies",       icon:"📖", desc:"Faculty of Islamic Law & Studies",             members:289,  pinned:false },
  { id:"ch4", name:"Arabic Language Dept",  icon:"✍️", desc:"Arabic Language & Literature faculty channel", members:198,  pinned:false },
  { id:"ch5", name:"Student Union",         icon:"🤝", desc:"Student union news and activities",            members:987,  pinned:false },
  { id:"ch6", name:"OIU Sports Club",       icon:"⚽", desc:"Sports events, tournaments and results",       members:445,  pinned:false },
];

const CH_MSGS_INIT = {
  ch1:[
    { id:1, text:"📢 **Final Exam Schedule** has been published on the student portal. Please review your timetable and report any conflicts to the registrar's office before April 1st.", time:"09:00", views:1102, pinned:true, reactions:{} },
    { id:2, text:"The university library will operate **24/7 from April 1–20** to support students during the examination period. Refreshments will be available at the student lounge.", time:"10:30", views:876,  pinned:false, reactions:{} },
    { id:3, text:"🎉 Congratulations to our students who placed in the **National Arabic Olympiad**! OIU secured 3 gold medals and 5 silver medals. Full results on the website.", time:"14:00", views:1034, pinned:false, reactions:{"❤️":45,"👍":78,"🔥":23} },
  ],
  ch2:[
    { id:1, text:"💻 The CS Department hackathon is **April 15–16**. Teams of 2–4. Registration closes April 10. Prizes worth 50,000 SDG for first place!", time:"11:00", views:280, pinned:false, reactions:{"🔥":32,"👍":28} },
    { id:2, text:"Reminder: CS301 project submissions are due **April 20**. Late submissions will lose 10% per day. Email your supervisor with any extension requests.", time:"13:00", views:305, pinned:false, reactions:{} },
  ],
  ch5:[
    { id:1, text:"📋 **Student Union Elections** nominations are now open! If you wish to stand for a position, submit your form to the Dean's office by March 25.", time:"08:30", views:756, pinned:false, reactions:{"👍":120,"❤️":45} },
    { id:2, text:"This Friday: **Free Pizza Night** at the Student Union hall from 7–10 PM. Open to all registered students. See you there! 🍕", time:"12:00", views:891, pinned:false, reactions:{"❤️":203,"😂":89,"🔥":67} },
  ],
};

const ASSIGNMENTS = [
  { id:1, title:"Fiqh Research Paper",     course:"ISL301 – Fiqh",      due:"2026-04-15", status:"pending",   desc:"Write a 2000-word paper on contemporary Fiqh issues." },
  { id:2, title:"Data Structures Project", course:"CS201 – DSA",         due:"2026-04-20", status:"pending",   desc:"Implement a balanced BST with all operations." },
  { id:3, title:"Arabic Grammar Essay",    course:"ARA101 – Grammar",    due:"2026-03-30", status:"submitted", desc:"Analyse morphological patterns in classical texts." },
  { id:4, title:"Algorithm Analysis",      course:"CS301 – Algorithms",  due:"2026-03-10", status:"graded",    desc:"Big-O complexity analysis.", grade:88, maxGrade:100, feedback:"Excellent analysis! Minor gaps in amortised complexity." },
  { id:5, title:"Islamic History Report",  course:"ISL201 – History",    due:"2026-04-05", status:"pending",   desc:"Report on the Abbasid Caliphate's contributions to science." },
];

const NOTICES_INIT = [
  { id:1, title:"Final Exam Schedule Released",       body:"The final examination timetable for Semester 1 2025/2026 has been published. Please check the portal for your individual schedule.", priority:"urgent", date:"2026-03-08" },
  { id:2, title:"University Anniversary Celebration", body:"Join us on April 5th to celebrate OIU's 94th anniversary with cultural performances, exhibitions, and a gala dinner.", priority:"high", date:"2026-03-06" },
  { id:3, title:"Library Extended Hours",             body:"The university library will be open 24/7 from April 1st to April 20th during the examination period.", priority:"normal", date:"2026-03-04" },
  { id:4, title:"Research Symposium 2026",            body:"Annual student research symposium on April 10th. Submit your abstracts by March 30th.", priority:"normal", date:"2026-03-01" },
];

const EVENTS_INIT = [
  { id:1, title:"Islamic Studies Conference", date:"2026-04-10", time:"9:00 AM",  location:"Main Hall",            desc:"International conference on contemporary Islamic scholarship.", attending:45,  rsvp:null },
  { id:2, title:"CS Hackathon 2026",          date:"2026-04-15", time:"8:00 AM",  location:"Engineering Building", desc:"48-hour coding competition with prizes.",                      attending:32,  rsvp:"attending" },
  { id:3, title:"Arabic Poetry Night",        date:"2026-04-08", time:"7:00 PM",  location:"Cultural Center",      desc:"An evening of classical and modern Arabic poetry.",             attending:78,  rsvp:null },
  { id:4, title:"Career Fair",                date:"2026-04-20", time:"10:00 AM", location:"Sports Complex",        desc:"Meet top employers from Sudan and the wider region.",           attending:200, rsvp:"attending" },
];

const POSTS_INIT = [
  { id:1, author_id:2, author:"Fatima Al-Rashid", college:"Faculty of Islamic Law",      content:"Just finished my Fiqh research paper! The topic of digital currency in Islamic finance was challenging but fascinating. If anyone wants to discuss, I'm here 📚", time:"2h ago", reactions:{"❤️":8,"👍":12,"🙏":4}, myReaction:null, comments:[{id:1,author:"Omar Abdulkarim",author_id:3,text:"Mashallah! I'd love to read it 📖",time:"1h ago"},{id:2,author:"Ahmed Hassan",author_id:1,text:"Great topic! Digital Fiqh is the future",time:"45m ago"}], pinned:false, views:124 },
  { id:2, author_id:3, author:"Omar Abdulkarim",  college:"Faculty of Arabic Language",  content:"بسم الله الرحمن الرحيم\n\n«وَمَن يَتَّقِ اللَّهَ يَجْعَل لَّهُ مَخْرَجًا»\n\nMay Allah make a way out for all of us during exam season 🤲", time:"4h ago", reactions:{"🙏":45,"❤️":32,"💯":12}, myReaction:"🙏", comments:[], pinned:true, views:342 },
  { id:3, author_id:4, author:"Mariam Yusuf",     college:"Faculty of Computer Science",  content:"Study session in Room B-204 tonight at 8 pm for CS201 Data Structures! We'll be going over trees and graphs. Everyone welcome 💻", time:"6h ago", reactions:{"👍":15,"🔥":8}, myReaction:null, comments:[{id:1,author:"Khalid Hassan",author_id:7,text:"I'll be there! 💪",time:"5h ago"}], pinned:false, views:89 },
  { id:4, author_id:7, author:"Khalid Hassan",    college:"Faculty of Computer Science",  content:"Finally got my mobile app to compile without errors after 6 hours 😭 The struggle is real. Who else is staying up late coding? ☕", time:"8h ago", reactions:{"😂":22,"❤️":15,"🔥":10}, myReaction:"😂", comments:[{id:1,author:"Mariam Yusuf",author_id:4,text:"Been there 😭 Good luck!",time:"7h ago"},{id:2,author:"Ahmed Hassan",author_id:1,text:"The AVL rotation bug? 😅",time:"6h ago"}], pinned:false, views:203 },
];

const TIMETABLE = [
  { day:"Sunday",    time:"08:00–10:00", course:"CS201 – Data Structures",  room:"C-101", color:"#1a5c2a" },
  { day:"Sunday",    time:"12:00–14:00", course:"ISL201 – Islamic History", room:"A-205", color:"#c9a43e" },
  { day:"Monday",    time:"08:00–10:00", course:"CS301 – Algorithms",       room:"C-102", color:"#1a5c2a" },
  { day:"Monday",    time:"10:00–12:00", course:"ARA101 – Arabic Grammar",  room:"B-301", color:"#7b3f00" },
  { day:"Tuesday",   time:"08:00–10:00", course:"CS201 – Data Structures",  room:"C-101", color:"#1a5c2a" },
  { day:"Tuesday",   time:"14:00–16:00", course:"ISL301 – Fiqh",           room:"A-108", color:"#c9a43e" },
  { day:"Wednesday", time:"10:00–12:00", course:"CS301 – Algorithms",       room:"C-102", color:"#1a5c2a" },
  { day:"Wednesday", time:"12:00–14:00", course:"MATH201 – Linear Algebra", room:"D-201", color:"#1565c0" },
  { day:"Thursday",  time:"08:00–10:00", course:"ARA101 – Arabic Grammar",  room:"B-301", color:"#7b3f00" },
  { day:"Thursday",  time:"10:00–12:00", course:"MATH201 – Linear Algebra", room:"D-201", color:"#1565c0" },
];

const ROOMS_INIT = [
  { id:1, name:"Fiqh Exam Prep",          subject:"ISL301 – Fiqh",      members:["Fatima Al-Rashid","Omar Abdulkarim","Zainab Mohammed"], capacity:10, online:3, joined:false },
  { id:2, name:"CS Final Project Help",    subject:"CS301 – Algorithms", members:["Mariam Yusuf","Khalid Hassan"],                        capacity:20, online:2, joined:true  },
  { id:3, name:"Arabic Literature Circle", subject:"ARA101",             members:["Aisha Osman","Ibrahim Al-Nour"],                       capacity:5,  online:1, joined:false },
  { id:4, name:"Math Study Group",         subject:"MATH201",            members:["Mariam Yusuf","Ahmed Hassan"],                         capacity:10, online:2, joined:true  },
];

const MSGS_INIT = {
  2:[ {id:1,from:2,text:"السلام عليكم! Are you ready for the Fiqh exam?",time:"10:32 AM",read:true},{id:2,from:1,text:"وعليكم السلام! Yes, been studying all weekend.",time:"10:35 AM",read:true},{id:3,from:2,text:"Inshallah! The Fiqh Exam Prep room at 8 pm?",time:"10:36 AM",read:true},{id:4,from:1,text:"Exactly! See you there 📚",time:"10:38 AM",read:true},{id:5,from:2,text:"Great! I found a really helpful book on contemporary Fiqh. Want me to save it?",time:"10:45 AM",read:false} ],
  3:[ {id:1,from:3,text:"Hey Ahmed! Did you see the Arabic poetry night event?",time:"Yesterday",read:true},{id:2,from:1,text:"Yes! I'm definitely going. Are you performing?",time:"Yesterday",read:true},{id:3,from:3,text:"Yes! Reading one of my original pieces. 🎭",time:"Yesterday",read:true} ],
  7:[ {id:1,from:7,text:"Bro that DSA problem set is killing me 💀",time:"2h ago",read:false},{id:2,from:1,text:"Same! Which question are you stuck on?",time:"2h ago",read:true},{id:3,from:7,text:"The AVL tree rotation logic. Makes no sense 😅",time:"1h ago",read:false} ],
};

// ─── GROUP CHATS DATA ──────────────────────────────────────────────────────────
const GROUPS_INIT = [
  {
    id:"g1", name:"CS Final Project Team", icon:"💻",
    bio:"Working together on CS301 final project. Everyone stay focused! 🚀",
    photo:null,
    members:[
      {id:1,role:"admin"},{id:4,role:"admin"},{id:7,role:"member"}
    ],
    onlyAdminsCanMsg:false,
    maxMembers:10000,
    createdAt:"2026-03-01",
    msgs:[
      {id:1,from:4,text:"Hey team! Let's divide the project tasks 📋",time:"Mon 10:00",reactions:{}},
      {id:2,from:7,text:"I can handle the frontend part 💻",time:"Mon 10:05",reactions:{"👍":1}},
      {id:3,from:1,text:"Perfect! I'll take backend and algorithms",time:"Mon 10:08",reactions:{"🔥":1}},
      {id:4,from:4,text:"I'll write the report and do testing ✅",time:"Mon 10:12",reactions:{"❤️":2}},
    ]
  },
  {
    id:"g2", name:"Islamic Studies Study Circle", icon:"📖",
    bio:"A blessed circle of knowledge. بسم الله الرحمن الرحيم — Fiqh & Quran study group.",
    photo:null,
    members:[
      {id:2,role:"admin"},{id:1,role:"member"},{id:3,role:"member"},{id:6,role:"member"}
    ],
    onlyAdminsCanMsg:false,
    maxMembers:10000,
    createdAt:"2026-02-15",
    msgs:[
      {id:1,from:2,text:"السلام عليكم جميعاً! أهلاً بكم في مجموعة الدراسة 🌙",time:"Sat 9:00",reactions:{"🙏":3}},
      {id:2,from:6,text:"وعليكم السلام! جزاكم الله خيراً على هذه المبادرة",time:"Sat 9:05",reactions:{}},
      {id:3,from:3,text:"متحمس للنقاشات الفقهية! نبدأ بموضوع المعاملات المعاصرة؟",time:"Sat 9:10",reactions:{"👍":2,"❤️":1}},
    ]
  },
  {
    id:"g3", name:"OIU Year 3 Students", icon:"🎓",
    bio:"All Year 3 students at OIU. Share notes, events, and announcements here!",
    photo:null,
    members:[
      {id:1,role:"admin"},{id:4,role:"member"},{id:6,role:"member"},{id:8,role:"member"}
    ],
    onlyAdminsCanMsg:true,
    maxMembers:10000,
    createdAt:"2026-01-10",
    msgs:[
      {id:1,from:1,text:"📢 Welcome to the Year 3 group! Only admins can post here.",time:"Jan 10",reactions:{}},
      {id:2,from:1,text:"Final exam schedule is out — check the portal! 🗓",time:"Mar 8",reactions:{"👍":5,"🔥":2}},
    ]
  }
];

// ─── STUDY PLANNER DATA ───────────────────────────────────────────────────────
const PLANNER_INIT = [
  { id:1, title:"Study Chapter 4 – AVL Trees",    course:"CS201", due:"2026-03-13", priority:"high",   done:false, tags:["cs","study"] },
  { id:2, title:"Read Fiqh notes before class",   course:"ISL301", due:"2026-03-12", priority:"urgent", done:false, tags:["fiqh"] },
  { id:3, title:"Math problem set 7",             course:"MATH201",due:"2026-03-15", priority:"normal", done:false, tags:["math"] },
  { id:4, title:"Draft intro for Fiqh paper",     course:"ISL301", due:"2026-03-14", priority:"high",   done:false, tags:["fiqh","writing"] },
  { id:5, title:"Review Arabic grammar rules",    course:"ARA101", due:"2026-03-11", priority:"normal", done:true,  tags:["arabic"] },
  { id:6, title:"Push DSA project to GitHub",     course:"CS201", due:"2026-03-20", priority:"normal", done:false, tags:["cs","coding"] },
];

// ─── GPA GOAL DATA ────────────────────────────────────────────────────────────
const GPA_GOALS_INIT = [
  { course:"CS201 – Data Structures",  target:4.0, current:3.7 },
  { course:"CS301 – Algorithms",       target:4.0, current:4.0 },
  { course:"ARA101 – Arabic Grammar",  target:3.7, current:3.3 },
  { course:"ISL301 – Fiqh",           target:4.0, current:4.0 },
  { course:"MATH201 – Linear Algebra", target:3.7, current:3.3 },
  { course:"ISL201 – Islamic History", target:3.7, current:3.7 },
];

// ─── SHARED NOTES DATA ────────────────────────────────────────────────────────
const NOTES_INIT = [
  { id:1, title:"AVL Tree Rotations — Summary",  course:"CS201", content:"**Left Rotation:** Applied when right subtree is heavier.\n**Right Rotation:** Applied when left subtree is heavier.\n**LR & RL:** Double rotations for zig-zag imbalance.\n\nBalance factor = height(left) - height(right)\nMust stay in {-1, 0, 1} at every node.", author:1, sharedWith:[4,7], updatedAt:"2026-03-10", pinned:true, tags:["cs","algorithms"] },
  { id:2, title:"Fiqh — Digital Currency Notes", course:"ISL301", content:"Key Positions:\n- Ibn Uthaymeen: Currency is currency if accepted by state.\n- Contemporary scholars split on Bitcoin.\n- OIC resolution pending on stablecoins.\n\nPrinciples: Must avoid gharar (uncertainty), riba (interest), and maysir (gambling).", author:2, sharedWith:[1,3,6], updatedAt:"2026-03-09", pinned:false, tags:["fiqh","economics"] },
  { id:3, title:"Arabic Grammar — Nominal Sentences", course:"ARA101", content:"المبتدأ (Mubtada): Subject — always marfoo (nominative)\nالخبر (Khabar): Predicate — also marfoo\n\nExamples:\nالطالب مجتهد — The student is diligent\nالجامعة كبيرة — The university is big\n\nBoth must agree in gender and number.", author:3, sharedWith:[1,8], updatedAt:"2026-03-08", pinned:false, tags:["arabic","grammar"] },
  { id:4, title:"My Algorithms Cheat Sheet",       course:"CS301", content:"Big-O Quick Reference:\nO(1) — Hash table lookup\nO(log n) — Binary search\nO(n) — Linear scan\nO(n log n) — Merge sort, Heap sort\nO(n^2) — Bubble, Insertion (worst)\nO(2^n) — Recursive Fibonacci\n\nSpace complexity matters too!", author:1, sharedWith:[4], updatedAt:"2026-03-07", pinned:true, tags:["cs","algorithms"] },
];

// ─── CAFETERIA DATA ───────────────────────────────────────────────────────────
const CAFETERIA_MENU = {
  Sunday:    { breakfast:[{name:"Ful Medames",ar:"فول مدمس",price:15,halal:true,cal:320,emoji:"🫘"},{name:"Tamiya & Bread",ar:"طعمية وخبز",price:12,halal:true,cal:280,emoji:"🧆"}], lunch:[{name:"Lamb Stew & Rice",ar:"مرق ضأن مع رز",price:35,halal:true,cal:650,emoji:"🍲"},{name:"Grilled Chicken",ar:"دجاج مشوي",price:40,halal:true,cal:480,emoji:"🍗"},{name:"Vegetable Curry",ar:"كاري خضار",price:25,halal:true,cal:380,emoji:"🥘"}], dinner:[{name:"Kisra & Mulah",ar:"كسرة ومُلاح",price:20,halal:true,cal:420,emoji:"🫓"},{name:"Shawarma Wrap",ar:"شاورما",price:30,halal:true,cal:560,emoji:"🌯"}] },
  Monday:    { breakfast:[{name:"Asida with Milk",ar:"عصيدة بالحليب",price:10,halal:true,cal:290,emoji:"🥣"},{name:"Boiled Eggs & Bread",ar:"بيض مسلوق وخبز",price:8,halal:true,cal:200,emoji:"🥚"}], lunch:[{name:"Beef Kabab & Rice",ar:"كباب لحم مع رز",price:38,halal:true,cal:700,emoji:"🍢"},{name:"Lentil Soup",ar:"شوربة عدس",price:18,halal:true,cal:280,emoji:"🍵"},{name:"Pasta Bolognese",ar:"مكرونة بولونيز",price:28,halal:true,cal:540,emoji:"🍝"}], dinner:[{name:"Grilled Fish",ar:"سمك مشوي",price:45,halal:true,cal:520,emoji:"🐟"},{name:"Salad Bar",ar:"طبق سلطة",price:15,halal:true,cal:180,emoji:"🥗"}] },
  Tuesday:   { breakfast:[{name:"Ful Medames",ar:"فول مدمس",price:15,halal:true,cal:320,emoji:"🫘"},{name:"Pancakes & Honey",ar:"بانكيك بالعسل",price:18,halal:true,cal:450,emoji:"🥞"}], lunch:[{name:"Chicken Shawarma Plate",ar:"بلاط شاورما دجاج",price:42,halal:true,cal:680,emoji:"🍗"},{name:"Fried Rice",ar:"رز مقلي",price:22,halal:true,cal:460,emoji:"🍚"},{name:"Bean Burger",ar:"برجر فول",price:30,halal:true,cal:420,emoji:"🍔"}], dinner:[{name:"Lamb Chops",ar:"ضلوع ضأن",price:55,halal:true,cal:720,emoji:"🥩"},{name:"Hummus & Bread",ar:"حمص وخبز",price:14,halal:true,cal:350,emoji:"🫙"}] },
  Wednesday: { breakfast:[{name:"Tamiya & Ful",ar:"طعمية وفول",price:15,halal:true,cal:340,emoji:"🧆"},{name:"Yogurt & Fruit",ar:"زبادي وفواكه",price:12,halal:true,cal:190,emoji:"🍓"}], lunch:[{name:"Molokhia & Rice",ar:"ملوخية مع رز",price:28,halal:true,cal:520,emoji:"🌿"},{name:"Grilled Kofta",ar:"كفتة مشوية",price:36,halal:true,cal:620,emoji:"🍖"},{name:"Vegetable Soup",ar:"شوربة خضار",price:15,halal:true,cal:240,emoji:"🥣"}], dinner:[{name:"Jollof Rice",ar:"رز جولوف",price:25,halal:true,cal:490,emoji:"🍚"},{name:"Grilled Corn",ar:"ذرة مشوية",price:10,halal:true,cal:160,emoji:"🌽"}] },
  Thursday:  { breakfast:[{name:"Asida with Simsim",ar:"عصيدة بالسمسم",price:10,halal:true,cal:310,emoji:"🥣"},{name:"Date & Milk",ar:"تمر وحليب",price:8,halal:true,cal:220,emoji:"🌴"}], lunch:[{name:"Full Sudanese Platter",ar:"طبق سوداني كامل",price:50,halal:true,cal:850,emoji:"🍱"},{name:"Stuffed Peppers",ar:"فلفل محشي",price:32,halal:true,cal:480,emoji:"🫑"},{name:"Chickpea Stew",ar:"يخني حمص",price:22,halal:true,cal:390,emoji:"🫘"}], dinner:[{name:"Hawawshi",ar:"هواوشي",price:35,halal:true,cal:610,emoji:"🥙"},{name:"Fresh Juice",ar:"عصير طازج",price:12,halal:true,cal:140,emoji:"🧃"}] },
};

// ─── SPORTS BOOKING DATA ──────────────────────────────────────────────────────
const SPORTS_FACILITIES = [
  { id:"f1", name:"Football Pitch",    icon:"⚽", capacity:22, slots:["08:00","10:00","14:00","16:00","18:00"], color:"#2e7d32", desc:"Full-size grass pitch, changing rooms available" },
  { id:"f2", name:"Basketball Court", icon:"🏀", capacity:10, slots:["09:00","11:00","13:00","15:00","17:00"], color:"#e65100", desc:"Two indoor courts, air-conditioned" },
  { id:"f3", name:"Gym & Fitness",    icon:"🏋️", capacity:30, slots:["07:00","09:00","11:00","14:00","16:00","18:00"], color:"#1565c0", desc:"Modern equipment, free weights and machines" },
  { id:"f4", name:"Swimming Pool",    icon:"🏊", capacity:20, slots:["07:00","09:00","11:00","15:00","17:00"], color:"#006064", desc:"25m pool, lanes 1-3 reserved for lengths" },
  { id:"f5", name:"Tennis Court",     icon:"🎾", capacity:4,  slots:["08:00","10:00","14:00","16:00"], color:"#7b3f00", desc:"2 hard courts, rackets available for rental" },
  { id:"f6", name:"Volleyball Court", icon:"🏐", capacity:12, slots:["10:00","14:00","16:00","18:00"], color:"#4a148c", desc:"Outdoor sand court" },
];

// ─── CLUBS DATA ───────────────────────────────────────────────────────────────
const CLUBS_INIT = [
  { id:"c1", name:"Computer Science Society", icon:"💻", members:142, category:"Academic", desc:"Hackathons, coding competitions, and tech talks. Open to all CS students.", joined:true,  events:["Hackathon April 15","Weekly Coding Challenge"] },
  { id:"c2", name:"Islamic Studies Circle",   icon:"📖", members:98,  category:"Religious",desc:"Quranic study, Fiqh discussions, and Islamic lectures every Friday.", joined:true,  events:["Friday Halaqah","Tafseer Session Mar 20"] },
  { id:"c3", name:"Arabic Language Club",     icon:"✍️", members:76,  category:"Language", desc:"Arabic poetry, calligraphy, and public speaking.", joined:false, events:["Poetry Night Apr 8","Calligraphy Workshop"] },
  { id:"c4", name:"Photography Club",         icon:"📸", members:55,  category:"Arts",     desc:"Campus photography, editing workshops, and annual exhibition.", joined:false, events:["Campus Shoot Mar 15","Lightroom Workshop"] },
  { id:"c5", name:"Debate & Oratory Society", icon:"🎙️", members:63,  category:"Academic", desc:"Improve public speaking, participate in inter-university debates.", joined:false, events:["Weekly Debate Mar 13","Regional Competition Apr"] },
  { id:"c6", name:"Environmental Club",       icon:"🌱", members:44,  category:"Social",   desc:"Campus greening initiatives, recycling drives, and sustainability.", joined:false, events:["Tree Planting Mar 22","Eco-Fair April"] },
  { id:"c7", name:"Entrepreneurship Hub",     icon:"🚀", members:87,  category:"Business", desc:"Startup pitches, business workshops, and mentorship from industry leaders.", joined:true,  events:["Pitch Night April 3","Design Thinking Workshop"] },
  { id:"c8", name:"Sports Union",             icon:"⚽", members:210, category:"Sports",   desc:"Organises inter-faculty tournaments in football, basketball, and more.", joined:false, events:["Football League starts April","Basketball Tryouts Mar 20"] },
];

// ─── ELECTIONS DATA ───────────────────────────────────────────────────────────
const ELECTIONS_INIT = [
  { id:"e1", title:"Student Union President 2026", status:"active", endDate:"2026-03-20",
    desc:"Vote for your Student Union President for academic year 2026-2027.",
    candidates:[
      { id:"ca1", name:"Fatima Al-Rashid", college:"Faculty of Islamic Law",      votes:142, manifesto:"Better study facilities, halal food variety, and stronger student rights.", icon:"📚" },
      { id:"ca2", name:"Omar Abdulkarim",  college:"Faculty of Arabic Language",  votes:98,  manifesto:"Cultural enrichment, Arabic language pride, and a welcoming campus.", icon:"🌟" },
      { id:"ca3", name:"Ibrahim Al-Nour",  college:"Faculty of Education",        votes:75,  manifesto:"Education reform, modern labs, and mental health support.", icon:"🎓" },
    ], voted:false, myVote:null },
  { id:"e2", title:"CS Department Rep 2026", status:"active", endDate:"2026-03-18",
    desc:"Elect a representative for the Faculty of Computer Science.",
    candidates:[
      { id:"ca4", name:"Mariam Yusuf",  college:"Faculty of Computer Science", votes:54, manifesto:"More lab hours, better internet, and industry partnerships.", icon:"💻" },
      { id:"ca5", name:"Khalid Hassan", college:"Faculty of Computer Science", votes:41, manifesto:"Coding bootcamps and a student-run hackathon every semester.", icon:"🚀" },
    ], voted:false, myVote:null },
  { id:"e3", title:"Cultural Committee Chair", status:"closed", endDate:"2026-02-28",
    desc:"Election for the Cultural Committee leadership.",
    candidates:[
      { id:"ca6", name:"Aisha Osman",    college:"Faculty of Arabic Language", votes:89, manifesto:"Celebrating Arabic arts and Sudanese culture on campus.", icon:"🎨" },
      { id:"ca7", name:"Zainab Mohammed",college:"Faculty of Islamic Law",     votes:72, manifesto:"Inclusive cultural events for all faculties.", icon:"🎭" },
    ], voted:true, myVote:"ca6" },
];

// ─── STORIES DATA ─────────────────────────────────────────────────────────────
const STORIES_INIT = [
  { id:"s1", author:2, name:"Fatima Al-Rashid", bg:"linear-gradient(135deg,#7b3f00,#c9a43e)", text:"Just finished my Fiqh paper! الحمد لله 🙏", time:"2h ago", seen:false, type:"text" },
  { id:"s2", author:3, name:"Omar Abdulkarim",  bg:"linear-gradient(135deg,#1a5c2a,#2e7d32)", text:"Arabic poetry night was amazing last night ✍️", time:"4h ago", seen:false, type:"text" },
  { id:"s3", author:5, name:"Ibrahim Al-Nour",  bg:"linear-gradient(135deg,#1565c0,#0d47a1)", text:"Year 1 finals coming up — wish me luck! 📚", time:"6h ago", seen:true,  type:"text" },
  { id:"s4", author:7, name:"Khalid Hassan",    bg:"linear-gradient(135deg,#4a148c,#6a1b9a)", text:"Hackathon team is ready 💻🔥", time:"8h ago", seen:true,  type:"text" },
];

// ─── CUSTOM STATUS OPTIONS ─────────────────────────────────────────────────────
const STATUS_OPTIONS = [
  { emoji:"📚", text:"Studying" }, { emoji:"🕌", text:"At Prayer" }, { emoji:"💻", text:"Coding" },
  { emoji:"🏃", text:"At Gym" }, { emoji:"😴", text:"Away" }, { emoji:"☕", text:"On Break" },
  { emoji:"📝", text:"In Exam" }, { emoji:"🎯", text:"Focused" }, { emoji:"🤝", text:"Available" },
  { emoji:"🔕", text:"Do Not Disturb" },
];

const NOTIFS_INIT = [
  { id:1, type:"reaction",   icon:"❤️", text:"Fatima reacted ❤️ to your post",            time:"5m ago",  read:false },
  { id:2, type:"comment",    icon:"💬", text:"Omar commented on your post",                time:"12m ago", read:false },
  { id:3, type:"friend",     icon:"👋", text:"Ibrahim Al-Nour sent you a friend request",  time:"1h ago",  read:false },
  { id:4, type:"assignment", icon:"📝", text:"New assignment: Data Structures Project",    time:"3h ago",  read:true  },
  { id:5, type:"announce",   icon:"📢", text:"Final Exam Schedule Released — check now",   time:"5h ago",  read:true  },
  { id:6, type:"reaction",   icon:"🔥", text:"Khalid reacted 🔥 to your comment",         time:"1d ago",  read:true  },
  { id:7, type:"channel",    icon:"🕌", text:"OIU Official: Library extended hours",       time:"1d ago",  read:true  },
];

// NEW: Grades data
const GRADES_DATA = [
  { course:"CS201 – Data Structures",  credits:3, grade:"A-", points:3.7, semester:"2025/26 S1", status:"current" },
  { course:"CS301 – Algorithms",       credits:3, grade:"A",  points:4.0, semester:"2025/26 S1", status:"current" },
  { course:"ARA101 – Arabic Grammar",  credits:3, grade:"B+", points:3.3, semester:"2025/26 S1", status:"current" },
  { course:"ISL201 – Islamic History", credits:3, grade:"A-", points:3.7, semester:"2025/26 S1", status:"current" },
  { course:"ISL301 – Fiqh",           credits:4, grade:"A",  points:4.0, semester:"2025/26 S1", status:"current" },
  { course:"MATH201 – Linear Algebra", credits:3, grade:"B+", points:3.3, semester:"2025/26 S1", status:"current" },
  { course:"CS101 – Intro to CS",      credits:3, grade:"A",  points:4.0, semester:"2024/25 S2", status:"completed" },
  { course:"CS102 – Programming",      credits:3, grade:"A+", points:4.0, semester:"2024/25 S2", status:"completed" },
  { course:"MATH101 – Calculus",       credits:3, grade:"B",  points:3.0, semester:"2024/25 S2", status:"completed" },
];

// NEW: Library data
const LIBRARY_BOOKS = [
  { id:1, title:"Introduction to Algorithms", author:"Cormen, Leiserson", subject:"Computer Science", available:3, total:5, borrowed:false },
  { id:2, title:"The Art of Computer Programming", author:"Donald Knuth", subject:"Computer Science", available:1, total:3, borrowed:true, due:"2026-03-20" },
  { id:3, title:"فقه المعاملات المعاصرة", author:"د. وهبة الزحيلي", subject:"Islamic Law", available:2, total:4, borrowed:false },
  { id:4, title:"النحو الواضح", author:"علي الجارم", subject:"Arabic Language", available:0, total:3, borrowed:false },
  { id:5, title:"Islamic Finance Theory & Practice", author:"Obaidullah", subject:"Islamic Finance", available:4, total:4, borrowed:false },
  { id:6, title:"Machine Learning Basics", author:"Murphy, Kevin", subject:"Computer Science", available:2, total:2, borrowed:false },
];

// NEW: Financial data
const FINANCIAL_DATA = {
  balance: -1200,
  tuition: 8500,
  paid: 7300,
  scholarshipAmt: 2000,
  transactions: [
    { id:1, desc:"Tuition Payment – S1 2025/26", amount:5000, type:"payment", date:"2025-09-01" },
    { id:2, desc:"Merit Scholarship Award",       amount:2000, type:"credit",  date:"2025-09-05" },
    { id:3, desc:"Late Registration Fee",         amount:-50,  type:"charge",  date:"2025-09-10" },
    { id:4, desc:"Library Fine",                  amount:-30,  type:"charge",  date:"2025-10-15" },
    { id:5, desc:"Tuition Payment – S1 (2nd)",    amount:2300, type:"payment", date:"2026-01-10" },
    { id:6, desc:"Lab Fee – CS201",               amount:-80,  type:"charge",  date:"2026-01-15" },
  ]
};

// NEW: Prayer times
const PRAYER_TIMES = [
  { name:"Fajr",    time:"04:52", arabic:"الفجر",   icon:"🌙" },
  { name:"Dhuhr",   time:"12:18", arabic:"الظهر",   icon:"☀️" },
  { name:"Asr",     time:"15:47", arabic:"العصر",   icon:"🌤" },
  { name:"Maghrib", time:"18:31", arabic:"المغرب",  icon:"🌅" },
  { name:"Isha",    time:"20:02", arabic:"العشاء",  icon:"🌃" },
];

// NEW: Quiz questions bank
const QUIZ_BANK = {
  "CS201 – DSA": [
    { q:"What is the time complexity of binary search?", opts:["O(n)","O(log n)","O(n²)","O(1)"], ans:1, exp:"Binary search halves the search space each step, giving O(log n)." },
    { q:"Which data structure uses LIFO order?", opts:["Queue","Stack","Heap","Tree"], ans:1, exp:"A stack follows Last-In-First-Out (LIFO) ordering." },
    { q:"What is the height of a balanced BST with 7 nodes?", opts:["2","3","4","5"], ans:1, exp:"A balanced BST with 7 nodes has height ⌊log₂(7)⌋ = 2 (0-indexed)." },
    { q:"Which traversal visits nodes in sorted order for a BST?", opts:["Pre-order","Post-order","In-order","Level-order"], ans:2, exp:"In-order traversal (Left → Root → Right) gives sorted output for a BST." },
    { q:"What is the worst-case complexity of quicksort?", opts:["O(n log n)","O(n)","O(n²)","O(log n)"], ans:2, exp:"When the pivot is always the smallest/largest, quicksort degrades to O(n²)." },
  ],
  "ISL301 – Fiqh": [
    { q:"What is the Arabic term for Islamic jurisprudence?", opts:["Aqeedah","Fiqh","Seerah","Tafseer"], ans:1, exp:"Fiqh (الفقه) literally means 'deep understanding' and refers to Islamic law." },
    { q:"How many pillars of Islam are there?", opts:["4","5","6","7"], ans:1, exp:"The five pillars are Shahada, Salah, Zakat, Sawm, and Hajj." },
    { q:"What does 'Halal' mean?", opts:["Forbidden","Permitted","Doubtful","Obligatory"], ans:1, exp:"Halal (حلال) means 'permitted' or 'lawful' in Islamic law." },
    { q:"Which school of Islamic law was founded by Imam Malik?", opts:["Hanafi","Maliki","Shafi'i","Hanbali"], ans:1, exp:"The Maliki school was founded by Imam Malik ibn Anas." },
    { q:"What is 'Ijma' in Islamic jurisprudence?", opts:["Quranic text","Scholarly consensus","Individual opinion","Analogy"], ans:1, exp:"Ijma (إجماع) is the consensus of Islamic scholars on a legal ruling." },
  ],
  "ARA101 – Grammar": [
    { q:"What is the term for the subject of a nominal sentence in Arabic?", opts:["Khabar","Mubtada","Fail","Maf'ul"], ans:1, exp:"The mubtada (مبتدأ) is the subject/topic of a nominal sentence." },
    { q:"How many letters are in the Arabic alphabet?", opts:["26","28","30","32"], ans:1, exp:"The Arabic alphabet contains 28 letters." },
    { q:"What case does the direct object take in Arabic?", opts:["Nominative","Genitive","Accusative","Jussive"], ans:2, exp:"The direct object (مفعول به) takes the accusative (منصوب) case, marked by fatha." },
    { q:"What is the dual suffix for a masculine noun?", opts:["-oon/-een","-aan/-ayn","-aat","-at"], ans:1, exp:"The dual suffix is ـان (nominative) or ـين (accusative/genitive)." },
  ],
};

// NEW: Campus map locations
const CAMPUS_LOCATIONS = [
  { id:1, name:"Main Library",         x:45, y:30, icon:"📚", desc:"6 floors, 24/7 during exams, 80,000+ volumes", category:"Academic" },
  { id:2, name:"Faculty of CS",        x:70, y:20, icon:"💻", desc:"Computer labs, project rooms, faculty offices", category:"Academic" },
  { id:3, name:"Faculty of Islamic Law", x:25, y:25, icon:"📖", desc:"Fiqh research centre and lecture halls", category:"Academic" },
  { id:4, name:"Student Union",        x:50, y:55, icon:"🤝", desc:"Events, clubs, student services", category:"Student Life" },
  { id:5, name:"Main Mosque",          x:50, y:15, icon:"🕌", desc:"Open for all five daily prayers", category:"Worship" },
  { id:6, name:"Cafeteria",            x:60, y:65, icon:"🍽", desc:"Halal food, open 7am–10pm", category:"Facilities" },
  { id:7, name:"Sports Complex",       x:20, y:70, icon:"⚽", desc:"Football, basketball, gym", category:"Sports" },
  { id:8, name:"Medical Centre",       x:78, y:55, icon:"🏥", desc:"Free for registered students, Mon–Thu 8–4", category:"Facilities" },
  { id:9, name:"Admin Building",       x:40, y:72, icon:"🏛", desc:"Registrar, finance, student affairs", category:"Admin" },
  { id:10,name:"Faculty of Arabic",    x:30, y:45, icon:"✍️", desc:"Arabic language & literature dept", category:"Academic" },
  { id:11,name:"Parking",             x:85, y:80, icon:"🅿️", desc:"Free for students with valid ID", category:"Facilities" },
  { id:12,name:"Engineering Building", x:75, y:40, icon:"🔬", desc:"Labs, workshops, project spaces", category:"Academic" },
];

// ─── AVATAR ───────────────────────────────────────────────────────────────────
const AvatarDisplay = ({ name, photo, size, ring=false, badge=false, onClick }) => {
  if (photo && photo.startsWith("emoji:")) {
    const emoji = photo.replace("emoji:","");
    return <div onClick={onClick} style={{ position:"relative", width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg,${scol(name)},${scol(name+"_")})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*.5, border:ring?"2.5px solid #c9a43e":"none", boxShadow:"0 2px 10px rgba(0,0,0,.22)", flexShrink:0, cursor:onClick?"pointer":"default" }}>
      {emoji}
      {badge && <div style={{ position:"absolute", bottom:1, right:1, width:Math.max(9,size*.25), height:Math.max(9,size*.25), background:"#2e7d32", borderRadius:"50%", border:"2px solid white" }}></div>}
    </div>;
  }
  return (
    <div onClick={onClick} style={{ position:"relative", flexShrink:0, cursor:onClick?"pointer":"default" }}>
      {photo ? (
        <div style={{ width:size, height:size, borderRadius:"50%", overflow:"hidden", border:ring?"2.5px solid #c9a43e":"none", boxShadow:"0 2px 10px rgba(0,0,0,.22)" }}>
          <img src={photo} alt={name} style={{ width:"100%", height:"100%", objectFit:"cover" }} />
        </div>
      ) : (
        <div style={{ width:size, height:size, borderRadius:"50%", background:`linear-gradient(135deg,${scol(name)},${scol(name+"_")})`, display:"flex", alignItems:"center", justifyContent:"center", color:"#fff", fontSize:size*.38, fontWeight:800, flexShrink:0, border:ring?"2.5px solid #c9a43e":"none", boxShadow:"0 2px 10px rgba(0,0,0,.22)" }}>
          {inits(name)}
        </div>
      )}
      {badge && <div style={{ position:"absolute", bottom:1, right:1, width:Math.max(9,size*.25), height:Math.max(9,size*.25), background:"#2e7d32", borderRadius:"50%", border:"2px solid white" }}></div>}
    </div>
  );
};

const Tag = ({ label, bg="#e8f5e9", fg="#1a5c2a" }) => (
  <span style={{ background:bg, color:fg, fontSize:10, fontWeight:700, padding:"2px 9px", borderRadius:20, letterSpacing:.3, whiteSpace:"nowrap" }}>{label}</span>
);

let _tid = 1;
const useToast = () => {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((msg, type="info") => {
    const id = _tid++;
    setToasts(t => [...t,{id,msg,type}]);
    setTimeout(() => setToasts(t => t.filter(x=>x.id!==id)), 3500);
  }, []);
  return { toasts, push };
};

// ─── COMPOSE BOX ──────────────────────────────────────────────────────────────
const ComposeBox = ({ myPhoto, me, onPost, dark, C }) => {
  const [draft, setDraft]   = useState("");
  const [mode, setMode]     = useState(null);
  const [poll, setPoll]     = useState({ question:"", options:[{text:""},{text:""}] });
  const [feeling, setFeeling] = useState(null);
  const [visibility, setVisibility] = useState("college"); // "college" | "public"
  const [mediaFiles, setMediaFiles] = useState([]); // [{id, type:"image"|"video", dataUrl, name, size}]
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef(null);

  const FEELINGS = ["😊 Happy","😂 Funny","🙏 Grateful","💪 Motivated","😤 Focused","🎉 Celebrating","😔 Reflective","❤️ Blessed"];

  const handleFiles = (files) => {
    setUploading(true);
    const toProcess = Array.from(files).slice(0, 4); // max 4 files
    let done = 0;
    const results = [];
    toProcess.forEach(file => {
      // Enforce reasonable size limit (20MB per file)
      if (file.size > 20 * 1024 * 1024) { done++; if (done===toProcess.length) { setMediaFiles(p=>[...p,...results]); setUploading(false); } return; }
      const reader = new FileReader();
      reader.onload = (ev) => {
        const type = file.type.startsWith("video") ? "video" : "image";
        results.push({ id: Date.now() + Math.random(), type, dataUrl: ev.target.result, name: file.name, size: file.size });
        done++;
        if (done === toProcess.length) { setMediaFiles(p=>[...p,...results]); setUploading(false); }
      };
      reader.onerror = () => { done++; if (done===toProcess.length) { setMediaFiles(p=>[...p,...results]); setUploading(false); } };
      reader.readAsDataURL(file);
    });
  };

  const submit = async () => {
    if (!draft.trim() && mode!=="poll" && mediaFiles.length===0) return;
    const now = Date.now();
    const post = {
      id: now,
      ts: now,
      author_id: me.id,
      author: me.name,
      college: me.college,
      department: me.department,
      visibility,                       // "college" or "public"
      content: draft + (feeling ? ` — feeling ${feeling}` : ""),
      time: "just now",
      reactions: {}, myReaction: null,
      comments: [], pinned: false, views: 0,
      syncStatus: "local",              // "local" | "synced" | "pending"
    };
    if (mode==="poll" && poll.question.trim()) {
      post.poll = { question:poll.question, options:poll.options.filter(o=>o.text.trim()).map(o=>({...o,votes:0})), voted:false };
      post.content = feeling ? `— feeling ${feeling}` : "";
    }
    // Attach media — store full data locally, strip for cloud
    if (mediaFiles.length > 0) {
      post.mediaData = mediaFiles;  // full base64 — stays in IDB
      post.mediaCount = mediaFiles.length;
      post.mediaTypes = mediaFiles.map(m=>m.type);
      // Save each media file to IDB under postId
      for (const m of mediaFiles) { await DB.saveMedia(`${post.id}_${m.id}`, m.dataUrl); }
    }
    onPost(post);
    setDraft(""); setMode(null); setPoll({question:"",options:[{text:""},{text:""}]}); setFeeling(null); setMediaFiles([]);
  };

  const inp2 = { background:dark?"rgba(255,255,255,.05)":"rgba(0,0,0,.03)", border:`1.5px solid ${C.border}`, borderRadius:12, padding:"10px 13px", fontSize:14, fontFamily:"inherit", outline:"none", color:C.text, boxSizing:"border-box" };
  return (
    <div style={{ background:C.card, borderRadius:16, border:`1px solid ${C.border}`, padding:16, marginBottom:16, boxShadow:dark?"0 2px 16px rgba(0,0,0,.3)":"0 1px 8px rgba(26,92,42,.06)" }}>
      <div style={{ display:"flex", gap:12, alignItems:"flex-start" }}>
        <AvatarDisplay name={me.name} photo={myPhoto} size={40} ring />
        <textarea value={draft} onChange={e=>setDraft(e.target.value)} placeholder="What's on your mind? شارك أفكارك…"
          style={{ ...inp2, flex:1, resize:"none", minHeight:52, lineHeight:1.5, width:"100%" }}
          onInput={e=>{e.target.style.height="auto";e.target.style.height=e.target.scrollHeight+"px";}} />
      </div>

      {/* Visibility selector */}
      <div style={{ display:"flex", alignItems:"center", gap:8, margin:"10px 0 0 52px" }}>
        <span style={{ fontSize:11, color:C.muted, fontWeight:700 }}>Visible to:</span>
        {[{k:"college",l:"🎓 My College",desc:"Only your college"},{k:"public",l:"🌐 Everyone",desc:"All OIU students"}].map(v=>(
          <button key={v.k} onClick={()=>setVisibility(v.k)}
            style={{ background:visibility===v.k?`linear-gradient(135deg,${C.navy},${C.nDark})`:C.card2, color:visibility===v.k?"#fff":C.muted, border:`1px solid ${visibility===v.k?C.navy:C.border}`, borderRadius:20, padding:"4px 12px", fontSize:11, fontWeight:700, cursor:"pointer" }}
            title={v.desc}>{v.l}</button>
        ))}
      </div>

      {/* Media preview grid */}
      {mediaFiles.length > 0 && (
        <div style={{ margin:"10px 0 0 52px", display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))", gap:6 }}>
          {mediaFiles.map(m=>(
            <div key={m.id} style={{ position:"relative", borderRadius:10, overflow:"hidden", aspectRatio:"1", background:"#000" }}>
              {m.type==="image"
                ? <img src={m.dataUrl} alt="" style={{ width:"100%", height:"100%", objectFit:"cover" }} />
                : <video src={m.dataUrl} style={{ width:"100%", height:"100%", objectFit:"cover" }} muted />}
              <div style={{ position:"absolute", top:4, left:4, background:"rgba(0,0,0,.6)", borderRadius:6, padding:"2px 6px", fontSize:10, color:"#fff", fontWeight:700 }}>{m.type==="video"?"🎬":"🖼"}</div>
              <button onClick={()=>setMediaFiles(f=>f.filter(x=>x.id!==m.id))}
                style={{ position:"absolute", top:4, right:4, width:20, height:20, borderRadius:"50%", background:"rgba(198,40,40,.9)", border:"none", color:"#fff", cursor:"pointer", fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", fontWeight:900 }}>✕</button>
            </div>
          ))}
          {uploading && <div style={{ display:"flex", alignItems:"center", justifyContent:"center", background:C.card2, borderRadius:10, aspectRatio:"1", fontSize:22 }}>⏳</div>}
        </div>
      )}

      {/* Hidden file input */}
      <input ref={fileRef} type="file" accept="image/*,video/*" multiple style={{ display:"none" }}
        onChange={e=>{ if(e.target.files?.length) handleFiles(e.target.files); e.target.value=""; }} />

      {feeling && <div style={{ margin:"8px 0 0 52px", display:"flex", alignItems:"center", gap:7 }}><span style={{ fontSize:13, color:C.muted }}>Feeling:</span><Tag label={feeling} bg={dark?"rgba(201,164,62,.15)":"rgba(201,164,62,.12)"} fg={C.gold} /><button onClick={()=>setFeeling(null)} style={{ background:"none", border:"none", color:C.muted, cursor:"pointer" }}>✕</button></div>}
      {mode==="poll" && (
        <div style={{ margin:"12px 0 0 52px", background:dark?"rgba(255,255,255,.04)":"rgba(26,92,42,.03)", borderRadius:12, padding:14, border:`1px solid ${C.border}` }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.navy, marginBottom:10 }}>📊 Create Poll</div>
          <input value={poll.question} onChange={e=>setPoll(p=>({...p,question:e.target.value}))} placeholder="Ask a question…" style={{ ...inp2, width:"100%", marginBottom:8 }} />
          {poll.options.map((o,i)=>(
            <div key={i} style={{ display:"flex", gap:7, marginBottom:7 }}>
              <input value={o.text} onChange={e=>{const opts=[...poll.options];opts[i]={...opts[i],text:e.target.value};setPoll(p=>({...p,options:opts}));}} placeholder={`Option ${i+1}`} style={{ ...inp2, flex:1 }} />
              {poll.options.length>2 && <button onClick={()=>setPoll(p=>({...p,options:p.options.filter((_,j)=>j!==i)}))} style={{ background:"none", border:"none", color:"#c62828", cursor:"pointer", fontSize:16 }}>✕</button>}
            </div>
          ))}
          {poll.options.length<6 && <button onClick={()=>setPoll(p=>({...p,options:[...p.options,{text:""}]}))} style={{ background:"none", border:"none", color:C.navy, fontSize:12, fontWeight:700, cursor:"pointer" }}>+ Add option</button>}
        </div>
      )}
      {mode==="feeling" && (
        <div style={{ margin:"8px 0 0 52px", display:"flex", flexWrap:"wrap", gap:6 }}>
          {FEELINGS.map(f=><button key={f} onClick={()=>{setFeeling(f);setMode(null);}} style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", fontSize:12, cursor:"pointer", color:C.text }}>{f}</button>)}
        </div>
      )}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginTop:12, paddingTop:10, borderTop:`1px solid ${C.border}`, flexWrap:"wrap", gap:8 }}>
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          <button onClick={()=>fileRef.current?.click()}
            style={{ display:"flex", alignItems:"center", gap:4, background:mediaFiles.length>0?(dark?"rgba(255,255,255,.08)":"rgba(26,92,42,.07)"):"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 10px", fontSize:12, fontWeight:600, cursor:"pointer", color:mediaFiles.length>0?C.navy:C.muted }}>
            📷 Photo/Video{mediaFiles.length>0?` (${mediaFiles.length})`:""}
          </button>
          {[{icon:"📊",label:"Poll",m:"poll"},{icon:"😊",label:"Feeling",m:"feeling"}].map(b=>(
            <button key={b.label} onClick={()=>setMode(x=>x===b.m?null:b.m)}
              style={{ display:"flex", alignItems:"center", gap:4, background:mode===b.m?(dark?"rgba(255,255,255,.08)":"rgba(26,92,42,.07)"):"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 10px", fontSize:12, fontWeight:600, cursor:"pointer", color:C.muted }}>{b.icon} {b.label}</button>
          ))}
        </div>
        <button onClick={submit} disabled={uploading}
          style={{ background:uploading?"#ccc":`linear-gradient(135deg,${C.navy},${C.nDark})`, color:"#fff", border:"none", borderRadius:10, padding:"8px 20px", fontSize:13, fontWeight:700, cursor:uploading?"not-allowed":"pointer" }}>
          {uploading?"Processing…":"Share ➤"}
        </button>
      </div>
    </div>
  );
};

// ─── POST CARD ────────────────────────────────────────────────────────────────
const PostCard = ({ post, me, myPhoto, friends, fStatus, sendReq, openChat, onReact, onComment, onPin, onDelete, onVotePoll, dark, C, push }) => {
  const [showComments, setShowComments] = useState(false);
  const [commentDraft, setCommentDraft] = useState("");
  const [showReactions, setShowReactions] = useState(false);
  const [mediaLoaded, setMediaLoaded]   = useState({}); // postMediaId -> dataUrl (loaded from IDB)
  const total = Object.values(post.reactions||{}).reduce((a,b)=>a+b,0);

  // Load any offline media from IDB on mount
  useEffect(() => {
    if (!post.mediaData && post.mediaCount > 0) {
      // Post came from cloud — no local media, show placeholder
      return;
    }
    if (post.mediaData) {
      const map = {};
      post.mediaData.forEach(m => { map[m.id] = m.dataUrl; });
      setMediaLoaded(map);
    }
  }, [post.id]);

  const mediaItems = post.mediaData || [];
  const hasMedia = mediaItems.length > 0 || post.mediaCount > 0;

  return (
    <div style={{ background:C.card, borderRadius:16, border:`1px solid ${C.border}`, padding:18, marginBottom:12, boxShadow:dark?"0 2px 16px rgba(0,0,0,.3)":"0 1px 8px rgba(26,92,42,.06)", position:"relative" }}>
      {post.pinned && <div style={{ position:"absolute", top:14, right:14, fontSize:11, color:C.gold, fontWeight:800 }}>📌 Pinned</div>}
      <div style={{ display:"flex", gap:12, marginBottom:12 }}>
        <AvatarDisplay name={post.author} photo={post.author_id===me.id?myPhoto:null} size={40} badge={post.author_id!==me.id&&STUDENTS.find(s=>s.id===post.author_id)?.status==="online"} />
        <div style={{ flex:1 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{post.author}</div>
          <div style={{ display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
            <span style={{ fontSize:11, color:C.muted }}>{post.college?.replace("Faculty of ","")??""} · {post.time}</span>
            {/* Visibility badge */}
            <span style={{ fontSize:10, fontWeight:700, borderRadius:20, padding:"1px 7px",
              background: post.visibility==="public" ? "rgba(21,101,192,.1)" : "rgba(26,92,42,.1)",
              color: post.visibility==="public" ? "#1565c0" : "#2e7d32" }}>
              {post.visibility==="public" ? "🌐 Public" : "🎓 College"}
            </span>
            {/* Sync status dot */}
            {post.author_id===me.id && (() => {
              const icon = post.syncStatus==="synced" ? "☁️" : post.syncStatus==="pending" ? "🔄" : "💾";
              const color = post.syncStatus==="synced" ? "#2e7d32" : post.syncStatus==="pending" ? "#e65100" : C.muted;
              const tip = post.syncStatus==="synced" ? "Synced to cloud" : post.syncStatus==="pending" ? "Pending sync" : "Saved locally";
              return <span title={tip} style={{ fontSize:10, color }}>{icon}</span>;
            })()}
          </div>
        </div>
        {post.author_id===me.id && (
          <div style={{ display:"flex", gap:6 }}>
            <button onClick={()=>onPin(post.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, color:C.gold }} title={post.pinned?"Unpin":"Pin"}>📌</button>
            <button onClick={()=>onDelete(post.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, color:"#c62828" }} title="Delete">🗑</button>
          </div>
        )}
      </div>
      {post.content && <p style={{ fontSize:14, lineHeight:1.75, color:C.text, whiteSpace:"pre-wrap", margin:"0 0 10px" }}>{post.content}</p>}

      {/* ── MEDIA DISPLAY ── */}
      {hasMedia && (
        <div style={{ marginBottom:10, borderRadius:12, overflow:"hidden",
          display: mediaItems.length > 1 ? "grid" : "block",
          gridTemplateColumns: mediaItems.length === 2 ? "1fr 1fr" : mediaItems.length >= 3 ? "1fr 1fr" : "1fr",
          gap:2 }}>
          {mediaItems.length > 0 ? mediaItems.map((m, idx) => (
            <div key={m.id} style={{ position:"relative", background:"#000",
              ...(mediaItems.length >= 3 && idx === 2 && mediaItems.length > 3 ? { position:"relative" } : {}) }}>
              {m.type === "video"
                ? <video src={mediaLoaded[m.id] || m.dataUrl} controls style={{ width:"100%", maxHeight: mediaItems.length===1?360:200, objectFit:"cover", display:"block" }} />
                : <img src={mediaLoaded[m.id] || m.dataUrl} alt="post media" style={{ width:"100%", height: mediaItems.length===1?"auto":200, maxHeight: mediaItems.length===1?400:200, objectFit:"cover", display:"block" }} onError={e=>{e.target.style.display="none";}} />}
              {/* "+N more" overlay on last visible item when >4 */}
              {mediaItems.length > 4 && idx === 3 && (
                <div style={{ position:"absolute", inset:0, background:"rgba(0,0,0,.6)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, fontWeight:900, color:"#fff" }}>+{mediaItems.length-4}</div>
              )}
            </div>
          )).slice(0,4) : (
            // Cloud post — media not available locally
            <div style={{ background:C.card2, borderRadius:12, padding:"20px", textAlign:"center", color:C.muted, fontSize:13 }}>
              📎 {post.mediaCount} media file{post.mediaCount>1?"s":""} · not cached offline
            </div>
          )}
        </div>
      )}

      {post.image && !hasMedia && <img src={post.image} alt="post" style={{ width:"100%", borderRadius:12, marginBottom:10, maxHeight:320, objectFit:"cover" }} onError={e=>{e.target.style.display="none";}} />}
      {post.poll && (
        <div style={{ background:dark?"rgba(26,92,42,.06)":"rgba(26,92,42,.04)", borderRadius:12, padding:14, marginBottom:10 }}>
          <div style={{ fontSize:14, fontWeight:800, color:C.text, marginBottom:10 }}>📊 {post.poll.question}</div>
          {post.poll.options.map((o,i)=>{
            const tot = post.poll.options.reduce((a,x)=>a+(x.votes||0),0);
            const pct = tot>0?Math.round((o.votes||0)/tot*100):0;
            return (
              <div key={i} onClick={()=>{ if(post.poll.voted) return; onVotePoll && onVotePoll(post.id, i); }} style={{ marginBottom:7, cursor:post.poll.voted?"default":"pointer" }}>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:C.text, marginBottom:3 }}><span>{o.text}</span><span style={{ color:C.muted }}>{pct}%</span></div>
                <div style={{ height:7, background:C.border, borderRadius:4, overflow:"hidden" }}><div style={{ height:"100%", width:`${pct}%`, background:post.poll.votedIdx===i?`linear-gradient(90deg,${C.gold},#b8922d)`:`linear-gradient(90deg,${C.navy},${C.nDark})`, borderRadius:4, transition:"width .5s ease" }}></div></div>
              </div>
            );
          })}
          <div style={{ fontSize:11, color:C.muted, marginTop:6 }}>{post.poll.options.reduce((a,x)=>a+(x.votes||0),0)} votes</div>
        </div>
      )}
      {/* Reaction summary */}
      {total>0 && (
        <div style={{ display:"flex", gap:4, marginBottom:10, flexWrap:"wrap" }}>
          {Object.entries(post.reactions).filter(([,v])=>v>0).map(([k,v])=>
            <span key={k} style={{ background:dark?"rgba(255,255,255,.07)":"rgba(26,92,42,.06)", borderRadius:20, padding:"2px 9px", fontSize:13 }}>{k} {v}</span>
          )}
        </div>
      )}
      {/* Actions */}
      <div style={{ display:"flex", gap:8, paddingTop:10, borderTop:`1px solid ${C.border}`, flexWrap:"wrap" }}>
        <div style={{ position:"relative" }}>
          <button onMouseEnter={()=>setShowReactions(true)} onMouseLeave={()=>setShowReactions(false)}
            onClick={()=>onReact(post.id, post.myReaction?null:"❤️")}
            style={{ display:"flex", alignItems:"center", gap:5, background:post.myReaction?`rgba(201,164,62,.1)`:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", cursor:"pointer", color:post.myReaction?C.gold:C.muted, fontSize:13, fontWeight:600 }}>
            {post.myReaction||"❤️"} React
          </button>
          {showReactions && (
            <div onMouseEnter={()=>setShowReactions(true)} onMouseLeave={()=>setShowReactions(false)}
              style={{ position:"absolute", bottom:"calc(100% + 6px)", left:0, background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:"8px 10px", zIndex:50, display:"flex", gap:4, boxShadow:"0 8px 30px rgba(0,0,0,.2)" }}>
              {REACTIONS.map(r=>(
                <button key={r.key} onClick={()=>{onReact(post.id,r.key);setShowReactions(false);}}
                  style={{ background:post.myReaction===r.key?`rgba(201,164,62,.15)`:"none", border:"none", borderRadius:10, padding:"6px 8px", cursor:"pointer", fontSize:20 }} title={r.label}>{r.key}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={()=>setShowComments(s=>!s)} style={{ display:"flex", alignItems:"center", gap:5, background:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", cursor:"pointer", color:C.muted, fontSize:13, fontWeight:600 }}>
          💬 {post.comments?.length||0}
        </button>
        <button onClick={()=>push("Link copied!","success")} style={{ display:"flex", alignItems:"center", gap:5, background:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", cursor:"pointer", color:C.muted, fontSize:13, fontWeight:600 }}>↗ Share</button>
        {post.author_id!==me.id && friends.includes(post.author_id) && (
          <button onClick={()=>openChat(post.author_id)} style={{ marginLeft:"auto", display:"flex", alignItems:"center", gap:5, background:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", cursor:"pointer", color:C.muted, fontSize:13 }}>✉️ Message</button>
        )}
      </div>
      {showComments && (
        <div style={{ marginTop:12, paddingTop:12, borderTop:`1px solid ${C.border}` }}>
          {(post.comments||[]).map(c=>(
            <div key={c.id} style={{ display:"flex", gap:9, marginBottom:9 }}>
              <AvatarDisplay name={c.author} photo={c.author_id===me.id?myPhoto:null} size={28} />
              <div style={{ background:dark?"rgba(255,255,255,.05)":"rgba(0,0,0,.03)", borderRadius:"0 12px 12px 12px", padding:"7px 11px", flex:1 }}>
                <div style={{ fontSize:12, fontWeight:800, color:C.text, marginBottom:2 }}>{c.author}</div>
                <div style={{ fontSize:13, color:C.text, lineHeight:1.5 }}>{c.text}</div>
                <div style={{ fontSize:10, color:C.muted, marginTop:3 }}>{c.time}</div>
              </div>
            </div>
          ))}
          <div style={{ display:"flex", gap:8, marginTop:4 }}>
            <AvatarDisplay name={me.name} photo={myPhoto} size={28} />
            <input value={commentDraft} onChange={e=>setCommentDraft(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&commentDraft.trim()){onComment(post.id,commentDraft.trim());setCommentDraft("");}}}
              placeholder="Write a comment…" style={{ flex:1, background:dark?"rgba(255,255,255,.06)":"rgba(0,0,0,.04)", border:`1px solid ${C.border}`, borderRadius:20, padding:"7px 13px", fontSize:13, fontFamily:"inherit", outline:"none", color:C.text }} />
            <button onClick={()=>{if(commentDraft.trim()){onComment(post.id,commentDraft.trim());setCommentDraft("");}}}
              style={{ width:34, height:34, borderRadius:"50%", background:`linear-gradient(135deg,${C.navy},${C.nDark})`, border:"none", cursor:"pointer", color:"#fff", fontSize:14 }}>➤</button>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
function PortalApp({ currentUser, onLogout }) {
  const ME = {
    id: currentUser.id,
    name: currentUser.name,
    sid: "OIU-" + currentUser.sid,
    college: currentUser.college,
    department: currentUser.department || "General",
    year: currentUser.year || 1,
    gpa: currentUser.gpa || 0,
    email: currentUser.email || "",
    points: currentUser.points || 0,
    rank: currentUser.rank || 99,
  };
  const [page, setPage]       = useState("dashboard");
  const [dark, setDark]       = useState(false);
  const [lang, setLang]       = useState("en");
  const t = T[lang];
  const { toasts, push }      = useToast();
  const [myPhoto, setMyPhoto] = useState(null);

  // ── SYNC ENGINE STATE ─────────────────────────────────────────────────────
  const [syncStatus, setSyncStatus]   = useState("idle"); // "idle"|"syncing"|"synced"|"offline"
  const [lastSync, setLastSync]       = useState(0);
  const [pendingPosts, setPendingPosts] = useState([]); // posts waiting to sync
  const syncRef = useRef(null);

  // Load posts from local storage on mount (offline-first), then sync from cloud
  const [posts, setPostsRaw] = useState(() => {
    const saved = DB.getPosts();
    return saved.length > 0 ? saved : POSTS_INIT;
  });

  // Wrapped setPosts that also persists and enqueues cloud sync
  const setPosts = useCallback((updater) => {
    setPostsRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      DB.savePosts(next).catch(()=>{});
      return next;
    });
  }, []);

  // College-scoped visibility filter: show post if public, or same college, or own post
  const canSeePost = (post) => {
    if (post.visibility === "public") return true;
    if (post.author_id === ME.id)     return true;
    if (post.visibility === "college" && post.college === ME.college) return true;
    if (!post.visibility) return true; // legacy posts without visibility
    return false;
  };

  // ── REAL-TIME SYNC ENGINE ─────────────────────────────────────────────────
  // Polls cloud every 8 seconds for new posts, merges without duplicates
  useEffect(() => {
    const doSync = async () => {
      if (!ServerServerDB.isOnline()) { setSyncStatus("offline"); return; }
      setSyncStatus("syncing");
      try {
        const serverPosts = await ServerDB.pullPostsSince(lastSync);
        if (serverPosts && serverPosts.length > 0) {
          setPostsRaw(prev => {
            const existingIds = new Set(prev.map(p => p.id));
            const newOnes = serverPosts.filter(p => !existingIds.has(p.id));
            if (newOnes.length === 0) return prev;
            const mapped = newOnes.map(p => ({
              ...p,
              author: p.author_name || p.author || "Unknown",
              syncStatus: "synced",
              reactions: p.reactions || {},
              comments: [],
            }));
            const merged = [...mapped, ...prev];
            DB.savePosts(merged).catch(()=>{});
            return merged;
          });
          setLastSync(Date.now());
        }
        setSyncStatus("synced");
      } catch { setSyncStatus("offline"); }
    };

    // Run immediately, then every 8s
    doSync();
    syncRef.current = setInterval(doSync, 8000);
    return () => clearInterval(syncRef.current);
  }, []); // eslint-disable-line

  // Online/offline listener
  useEffect(() => {
    const onOnline  = () => { setSyncStatus("syncing"); };
    const onOffline = () => { setSyncStatus("offline"); };
    window.addEventListener("online",  onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online",onOnline); window.removeEventListener("offline",onOffline); };
  }, []);

  const [notices, setNotices] = useState(NOTICES_INIT);
  const [friends, setFriends] = useState([2,3]);
  const [reqs, setReqs]       = useState([{id:10,from:5,to:1,status:"pending"},{id:11,from:8,to:1,status:"pending"}]);
  const [sent, setSent]       = useState([7]);
  const [msgs, setMsgs]       = useState(MSGS_INIT);
  const [chat, setChat]       = useState(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMode, setChatMode]   = useState("dm");
  const [activeChannel, setActiveChannel] = useState(null);
  const [chMsgs, setChMsgs]   = useState(CH_MSGS_INIT);
  const [subscribedChs, setSubscribedChs] = useState(["ch1","ch5"]);
  const msgsEnd               = useRef(null);

  const [asgns, setAsgns]     = useState(ASSIGNMENTS);
  const [asgnTab, setAsgnTab] = useState("pending");
  const [submitText, setSubmitText] = useState({});
  const [events, setEvents]   = useState(EVENTS_INIT);
  const [rooms, setRooms]     = useState(ROOMS_INIT);
  const [showNewRoom, setShowNewRoom] = useState(false);
  const [newRoom, setNewRoom] = useState({name:"",subject:"",capacity:10});

  const [pTab, setPTab]       = useState("discover");
  const [pQ, setPQ]           = useState("");
  const [pCollege, setPCollege] = useState("All");
  const [lbSearch, setLbSearch] = useState("");
  const [lbFilter, setLbFilter] = useState("All");
  const [groupEditName, setGroupEditName] = useState("");
  const [groupEditBio, setGroupEditBio]   = useState("");
  const [groupEditOnly, setGroupEditOnly] = useState(false);
  const [groupAddSearch, setGroupAddSearch] = useState("");
  const [groupMsgHover, setGroupMsgHover] = useState(null);
  const [bio, setBioRaw] = useState(() => DB.getUserData(currentUser.id, "bio", currentUser.bio || "OIU student — passionate about learning and knowledge."));
  const setBio = (v) => { setBioRaw(v); DB.saveUserData(currentUser.id,"bio",v); };
  const [editingBio, setEditingBio] = useState(false);
  const [notifs, setNotifs]   = useState(NOTIFS_INIT);
  const [feedFilter, setFeedFilter] = useState("all");

  // NEW states
  const [libSearch, setLibSearch] = useState("");
  const [libBooks, setLibBooks]   = useState(LIBRARY_BOOKS);
  const [gradeTab, setGradeTab]   = useState("current");
  const [calMonth] = useState("March 2026");

  // Quiz state
  const [quizCourse, setQuizCourse] = useState(Object.keys(QUIZ_BANK)[0]);
  const [quizIdx, setQuizIdx]       = useState(0);
  const [quizSelected, setQuizSelected] = useState(null);
  const [quizShowExp, setQuizShowExp]   = useState(false);
  const [quizScore, setQuizScore]       = useState(0);
  const [quizDone, setQuizDone]         = useState(false);
  const [quizAnswered, setQuizAnswered] = useState([]);

  // Kaido AI state
  const [tutorMsgs, setTutorMsgs]   = useState([{ role:"assistant", text:"السلام عليكم وعليكن! 🌟\nأنا **كيدو** — مساعدك الذكي في بوابة OIU!\n\nI'm Kaido, your multilingual AI assistant. I can help you in:\n🇸🇩 العربية السودانية (Sudanese Arabic)\n🇬🇧 English\n🇫🇷 Français\n🇩🇪 Deutsch · 🇹🇷 Türkçe · 🇷🇺 Русский · and more!\n\nأسألني عن أي شيء — مادة دراسية، كود برمجي، شرح مفهوم، أو حتى مجرد محادثة. Ask me anything — coursework, coding, concepts, or just chat! 💡" }]);
  const [tutorInput, setTutorInput] = useState("");
  const [tutorLoading, setTutorLoading] = useState(false);
  const [tutorSubject, setTutorSubject] = useState("General");
  const tutorEnd = useRef(null);

  // Group chat state
  const [groups, setGroups] = useState(() => {
    // Auto-create/join college group and department group for current user
    const base = [...GROUPS_INIT];
    const college = ME.college;
    const dept = ME.department;
    const collegeGroupId = "college_" + college.replace(/\s+/g,"_").toLowerCase();
    const deptGroupId = "dept_" + dept.replace(/\s+/g,"_").toLowerCase();
    const collegeIcon = {"Faculty of Computer Science":"💻","Faculty of Islamic Law":"📖","Faculty of Arabic Language":"✍️","Faculty of Education":"🎓","Faculty of Medicine":"🏥","Faculty of Engineering":"🔧","Faculty of Economics":"📊"}[college] || "🏛";
    // Add college group if not exists
    if (!base.find(g=>g.id===collegeGroupId)) {
      base.unshift({ id:collegeGroupId, name:college, icon:collegeIcon, bio:`Official group for all ${college} students at OIU.`, photo:null, members:[{id:ME.id,role:"member"}], onlyAdminsCanMsg:false, maxMembers:10000, createdAt:new Date().toISOString().slice(0,10), msgs:[{id:1,from:0,text:`🎉 Welcome to the official ${college} group! Connect with your fellow students.`,time:"now",reactions:{}}] });
    } else {
      const idx = base.findIndex(g=>g.id===collegeGroupId);
      if (!base[idx].members.find(m=>m.id===ME.id)) base[idx].members.push({id:ME.id,role:"member"});
    }
    // Add department group if not exists
    if (!base.find(g=>g.id===deptGroupId)) {
      base.splice(1,0,{ id:deptGroupId, name:`${dept} Dept.`, icon:"📚", bio:`Group for ${dept} students — share resources, notes, and updates.`, photo:null, members:[{id:ME.id,role:"member"}], onlyAdminsCanMsg:false, maxMembers:10000, createdAt:new Date().toISOString().slice(0,10), msgs:[{id:1,from:0,text:`👋 Welcome to the ${dept} department group! This group is auto-managed by Kaido AI.`,time:"now",reactions:{}}] });
    } else {
      const idx = base.findIndex(g=>g.id===deptGroupId);
      if (!base[idx].members.find(m=>m.id===ME.id)) base[idx].members.push({id:ME.id,role:"member"});
    }
    return base;
  });
  const [activeGroup, setActiveGroup] = useState(null);
  const [groupDraft, setGroupDraft]   = useState("");
  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [newGroupName, setNewGroupName] = useState("");
  const [newGroupDesc, setNewGroupDesc] = useState("");
  const [newGroupMembers, setNewGroupMembers] = useState([]);
  const groupEnd = useRef(null);
  useEffect(()=>{ groupEnd.current?.scrollIntoView({behavior:"smooth"}); },[activeGroup,groups]);
  // Sync group edit fields when info panel opens
  useEffect(()=>{
    if(showGroupInfo && activeGroup) {
      const g = groups.find(x=>x.id===activeGroup);
      if(g){ setGroupEditName(g.name); setGroupEditBio(g.bio); setGroupEditOnly(g.onlyAdminsCanMsg); setGroupAddSearch(""); }
    }
  },[showGroupInfo, activeGroup]);

  // Map state
  const [mapSelected, setMapSelected] = useState(null);
  const [mapCategory, setMapCategory] = useState("All");

  // Settings state
  const [settingsLang, setSettingsLang]             = useState("English");
  const [settingsNotifEmail, setSettingsNotifEmail] = useState(true);
  const [settingsNotifPush, setSettingsNotifPush]   = useState(true);
  const [settingsPrivacy, setSettingsPrivacy]       = useState("friends");
  const [chgPassCurrent, setChgPassCurrent]         = useState("");
  const [chgPassNew, setChgPassNew]                 = useState("");
  const [chgPassConfirm, setChgPassConfirm]         = useState("");
  const [chgPassErr, setChgPassErr]                 = useState("");

  // ── NEW FEATURE STATES ─────────────────────────────────────────────────────
  // Study Planner — persisted per user
  const [plannerTasks, setPlannerTasksRaw] = useState(() => DB.getUserData(currentUser.id, "planner", PLANNER_INIT));
  const setPlannerTasks = (v) => { setPlannerTasksRaw(v); const next = typeof v==="function"?v(plannerTasks):v; DB.saveUserData(currentUser.id,"planner",next); };
  const [plannerFilter, setPlannerFilter] = useState("all");
  const [plannerNew, setPlannerNew]     = useState({title:"",course:"",due:"",priority:"normal"});
  const [showPlannerForm, setShowPlannerForm] = useState(false);

  // Pomodoro Timer
  const [pomodoroMode, setPomodoroMode] = useState("work"); // work|break|longbreak
  const [pomodoroSecs, setPomodoroSecs] = useState(25*60);
  const [pomodoroRunning, setPomodoroRunning] = useState(false);
  const [pomodoroSession, setPomodoroSession] = useState(1);
  const [pomodoroTask, setPomodoroTask] = useState("");
  useEffect(()=>{
    if(!pomodoroRunning) return;
    const t = setInterval(()=>{
      setPomodoroSecs(s=>{
        if(s<=1){
          setPomodoroRunning(false);
          setPomodoroSession(n=>n+1);
          const next = pomodoroMode==="work"?(pomodoroSession%4===0?"longbreak":"break"):"work";
          setPomodoroMode(next);
          return next==="work"?25*60:next==="longbreak"?15*60:5*60;
        }
        return s-1;
      });
    },1000);
    return ()=>clearInterval(t);
  },[pomodoroRunning, pomodoroMode, pomodoroSession]);

  // Shared Notes — persisted per user
  const [notes, setNotesRaw]       = useState(() => DB.getUserData(currentUser.id, "notes", NOTES_INIT));
  const setNotes = (v) => { setNotesRaw(v); const next = typeof v==="function"?v(notes):v; DB.saveUserData(currentUser.id,"notes",next); };
  const [noteTab, setNoteTab]     = useState("mine");
  const [activeNote, setActiveNote] = useState(null);
  const [noteEdit, setNoteEdit]   = useState(false);
  const [noteDraft, setNoteDraft] = useState({title:"",course:"",content:"",tags:""});

  // GPA Goal Tracker — persisted
  const [gpaGoals, setGpaGoalsRaw] = useState(() => DB.getUserData(currentUser.id, "gpaGoals", GPA_GOALS_INIT));
  const setGpaGoals = (v) => { setGpaGoalsRaw(v); const next = typeof v==="function"?v(gpaGoals):v; DB.saveUserData(currentUser.id,"gpaGoals",next); };
  const [overallTarget, setOverallTarget] = useState(() => DB.getUserData(currentUser.id, "gpaTarget", 3.9));

  // Cafeteria
  const [cafDay, setCafDay]       = useState("Monday");
  const [cafMeal, setCafMeal]     = useState("lunch");
  const [cafFavs, setCafFavs]     = useState([]);

  // Finance payment
  const [finTuition, setFinTuition] = useState(FINANCIAL_DATA.tuition);
  const [finPaid, setFinPaid]       = useState(FINANCIAL_DATA.paid);
  const [finTxns, setFinTxns]       = useState(FINANCIAL_DATA.transactions);
  const [showPayModal, setShowPayModal] = useState(false);
  const [payAmount, setPayAmount]   = useState("");
  const [payMethod, setPayMethod]   = useState("bank");

  // Sports Booking
  const [sportsFac, setSportsFac] = useState(null);
  const [sportsSlot, setSportsSlot] = useState(null);
  const [sportsBookings, setSportsBookings] = useState([]);
  const [sportsDate, setSportsDate] = useState("2026-03-12");

  // Clubs
  const [clubs, setClubs]         = useState(CLUBS_INIT);
  const [clubFilter, setClubFilter] = useState("All");
  const [clubSearch, setClubSearch] = useState("");

  // Directory
  const [dirSearch, setDirSearch] = useState("");
  const [dirCollege, setDirCollege] = useState("All");
  const [dirYear, setDirYear]     = useState("All");
  const [dirSort, setDirSort]     = useState("name");

  // Elections
  const [elections, setElections] = useState(ELECTIONS_INIT);
  const [elecDetail, setElecDetail] = useState(null);

  // Reports
  const [showReport, setShowReport] = useState(false);
  const [reportTarget, setReportTarget] = useState(null);
  const [reportReason, setReportReason] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportsDone, setReportsDone] = useState([]);

  // Analytics
  const analyticsData = {
    loginStreak: DB.getUserData(currentUser.id,"loginStreak",1),
    totalLogins: DB.getUserData(currentUser.id,"totalLogins",1),
    msgsToday: Object.values(msgs).flat().filter(m=>m.from===1).length,
    postsThisWeek: posts.filter(p=>p.author_id===ME.id).length,
    assignmentsSubmitted: asgns.filter(a=>a.status==="submitted"||a.status==="graded").length,
    studyHours: DB.getUserData(currentUser.id,"studyHours",0) + Math.floor(plannerTasks.filter(t=>t.done).length * 1.5),
    notesCreated: notes.filter(n=>n.author===ME.id).length,
    groupsJoined: groups.filter(g=>g.members.find(m=>m.id===ME.id)).length,
    quizzesTaken: DB.getUserData(currentUser.id,"quizzesTaken",0),
    quizAvgScore: DB.getUserData(currentUser.id,"quizAvgScore",0),
    topCourse: tutorSubject || "General",
    weekActivity: [3,5,2,7,4,6,2],
    monthHeatmap: Array.from({length:31},(_,i)=>({day:i+1,count:i===new Date().getDate()-1?5:Math.floor(Math.random()*5)})),
  };

  // ── Stories
  const [stories, setStories]       = useState(STORIES_INIT);
  const [viewingStory, setViewingStory] = useState(null);
  const [storyDraft, setStoryDraft] = useState("");
  const [storyBg, setStoryBg]       = useState("linear-gradient(135deg,#1a5c2a,#c9a43e)");
  const [showStoryCompose, setShowStoryCompose] = useState(false);

  // ── Custom Status
  const [myStatus, setMyStatus]     = useState({ emoji:"📚", text:"Studying" });
  const [showStatusPicker, setShowStatusPicker] = useState(false);

  // ── Call UI
  const [callState, setCallState]   = useState(null); // null | {type:"voice"|"video", person, duration, active}
  const [callDuration, setCallDuration] = useState(0);
  const [callMuted, setCallMuted]   = useState(false);
  const [callCamOff, setCallCamOff] = useState(false);
  const [callSpeaker, setCallSpeaker] = useState(true);
  const callTimerRef = useRef(null);
  useEffect(()=>{
    if(callState?.active) { callTimerRef.current = setInterval(()=>setCallDuration(d=>d+1),1000); }
    else { clearInterval(callTimerRef.current); setCallDuration(0); }
    return ()=>clearInterval(callTimerRef.current);
  },[callState?.active]);

  // Track login streak and count
  useEffect(() => {
    const uid = currentUser.id;
    const today = new Date().toISOString().slice(0,10);
    const lastLogin = DB.getUserData(uid, "lastLoginDate", null);
    const streak = DB.getUserData(uid, "loginStreak", 0);
    const total = DB.getUserData(uid, "totalLogins", 0);
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
    const newStreak = lastLogin === today ? streak : (lastLogin === yesterday ? streak + 1 : 1);
    DB.saveUserData(uid, "loginStreak", newStreak);
    DB.saveUserData(uid, "totalLogins", total + (lastLogin === today ? 0 : 1));
    DB.saveUserData(uid, "lastLoginDate", today);
  }, []);

  // Track quiz completions
  useEffect(() => {
    if (quizDone) {
      const uid = currentUser.id;
      const prev = DB.getUserData(uid, "quizzesTaken", 0);
      const prevAvg = DB.getUserData(uid, "quizAvgScore", 0);
      const questions = QUIZ_BANK[quizCourse]||[];
      const score = questions.length > 0 ? Math.round(quizScore/questions.length*100) : 0;
      DB.saveUserData(uid, "quizzesTaken", prev+1);
      DB.saveUserData(uid, "quizAvgScore", Math.round((prevAvg*prev + score)/(prev+1)));
    }
  }, [quizDone]);

  // ── Profile Pages (viewing other students)
  const [viewingProfile, setViewingProfile] = useState(null); // student id

  useEffect(() => { msgsEnd.current?.scrollIntoView({behavior:"smooth"}); }, [chat, msgs, activeChannel, chMsgs]);

  const nav = p => setPage(p);
  const openChat = id => {
    setChat(id);
    setChatMode("dm");
    // Mark all messages from this person as read
    setMsgs(m=>({...m,[id]:(m[id]||[]).map(msg=>({...msg,read:true}))}));
    nav("chat");
  };

  const incoming      = reqs.filter(r=>r.to===1&&r.status==="pending");
  const incomingCount = incoming.length;
  const unreadCount   = Object.values(msgs).filter(conv=>conv.some(m=>m.from!==1&&!m.read)).length;
  const unreadNotifs  = notifs.filter(n=>!n.read).length;
  const pendingAsgn   = asgns.filter(a=>a.status==="pending").length;

  const pushNotif = (icon, text, type="info") => {
    setNotifs(ns=>[{id:Date.now(),type,icon,text,time:"just now",read:false},...ns]);
  };

  const fStatus = id => friends.includes(id)?"friend":sent.includes(id)?"sent":incoming.find(r=>r.from===id)?"incoming":"none";
  const sendReq = id => {
    setSent(s=>[...s,id]);
    push("Friend request sent! 👋","success");
    pushNotif("👋","Your friend request was sent!","friend");
  };
  const acceptReq = (reqId, fromId) => {
    setReqs(r=>r.map(x=>x.id===reqId?{...x,status:"accepted"}:x));
    setFriends(f=>[...f,fromId]);
    push("Friend request accepted! 🎉","success");
    const s=STUDENTS.find(x=>x.id===fromId);
    pushNotif("🎉",`You and ${s?.name.split(" ")[0]||"someone"} are now friends!`,"friend");
  };
  const declineReq = reqId => { setReqs(r=>r.map(x=>x.id===reqId?{...x,status:"declined"}:x)); };
  const removeFriend = id => { setFriends(f=>f.filter(x=>x!==id)); push("Friend removed",""); };

  const reactPost = (pid, key) => setPosts(ps=>ps.map(p=>{
    if(p.id!==pid) return p;
    const reactions={...p.reactions};
    if(p.myReaction===key){reactions[key]=Math.max(0,(reactions[key]||1)-1);return {...p,reactions,myReaction:null};}
    if(p.myReaction){reactions[p.myReaction]=Math.max(0,(reactions[p.myReaction]||1)-1);}
    reactions[key]=(reactions[key]||0)+1;
    return {...p,reactions,myReaction:key};
  }));
  const addComment = (pid, text) => setPosts(ps=>ps.map(p=>p.id!==pid?p:{...p,comments:[...p.comments,{id:Date.now(),author:ME.name,author_id:1,text,time:"just now"}]}));
  const pinPost   = pid => setPosts(ps=>ps.map(p=>p.id===pid?{...p,pinned:!p.pinned}:p));
  const deletePost= pid => { setPosts(ps=>ps.filter(p=>p.id!==pid)); push("Post deleted",""); };
  const votePoll  = (pid, optIdx) => setPosts(ps=>ps.map(p=>{
    if(p.id!==pid||!p.poll||p.poll.voted) return p;
    const options = p.poll.options.map((o,i)=>i===optIdx?{...o,votes:(o.votes||0)+1}:o);
    return {...p,poll:{...p.poll,options,voted:true,votedIdx:optIdx}};
  }));

  // ── GROUP HELPERS ──────────────────────────────────────────────────────────
  const myRoleInGroup = g => g.members.find(m=>m.id===ME.id)?.role || "none";
  const isGroupAdmin  = g => myRoleInGroup(g) === "admin";
  const canSendInGroup= g => !g.onlyAdminsCanMsg || isGroupAdmin(g);
  const sendGroupMsg  = () => {
    if (!groupDraft.trim() || !activeGroup) return;
    if (!canSendInGroup(groups.find(g=>g.id===activeGroup))) { push("Only admins can send messages in this group","error"); return; }
    const text = groupDraft.trim(); setGroupDraft("");
    setGroups(gs=>gs.map(g=>g.id!==activeGroup?g:{...g,msgs:[...g.msgs,{id:Date.now(),from:1,text,time:"now",reactions:{}}]}));
  };
  const createGroup = () => {
    if (!newGroupName.trim()) { push("Enter a group name","error"); return; }
    const memberList = [{id:1,role:"admin"}, ...newGroupMembers.map(id=>({id,role:"member"}))];
    const ng = {id:"g"+Date.now(),name:newGroupName.trim(),icon:"💬",bio:newGroupDesc||"",photo:null,members:memberList,onlyAdminsCanMsg:false,maxMembers:10000,createdAt:new Date().toISOString().slice(0,10),msgs:[{id:1,from:1,text:`👋 Welcome to ${newGroupName}! I created this group.`,time:"now",reactions:{}}]};
    setGroups(gs=>[ng,...gs]); setActiveGroup(ng.id);
    setNewGroupName(""); setNewGroupDesc(""); setNewGroupMembers([]); setShowNewGroup(false);
    push(`Group "${ng.name}" created! 🎉`,"success");
  };
  const addMemberToGroup = (gid, uid) => {
    setGroups(gs=>gs.map(g=>{
      if(g.id!==gid) return g;
      if(g.members.find(m=>m.id===uid)) return g;
      if(g.members.length>=g.maxMembers) { push("Group is full","error"); return g; }
      return {...g,members:[...g.members,{id:uid,role:"member"}]};
    })); push("Member added ✅","success");
  };
  const removeMemberFromGroup = (gid, uid) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,members:g.members.filter(m=>m.id!==uid)}));
    push("Member removed","");
  };
  const promoteMember = (gid, uid) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,members:g.members.map(m=>m.id===uid?{...m,role:"admin"}:m)}));
    push("Promoted to admin 👑","success");
  };
  const demoteMember = (gid, uid) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,members:g.members.map(m=>m.id===uid?{...m,role:"member"}:m)}));
    push("Demoted to member","");
  };
  const updateGroupInfo = (gid, patch) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,...patch}));
    push("Group updated ✅","success");
  };
  const leaveGroup = gid => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,members:g.members.filter(m=>m.id!==1)}));
    if(activeGroup===gid) setActiveGroup(null);
    push("You left the group","");
  };
  const reactGroupMsg = (gid, mid, emoji) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,msgs:g.msgs.map(m=>m.id!==mid?m:{...m,reactions:{...m.reactions,[emoji]:(m.reactions[emoji]||0)+1}})}));
  };
  const deleteGroupMsg = (gid, mid) => {
    setGroups(gs=>gs.map(g=>g.id!==gid?g:{...g,msgs:g.msgs.filter(m=>m.id!==mid)}));
  };
  const unreadGroupCount = groups.filter(g=>g.members.find(m=>m.id===ME.id)).reduce((acc,g)=>{
    const last = g.msgs[g.msgs.length-1];
    return acc + (last&&last.from!==1?1:0);
  },0);

  const sendMsg = () => {
    if (!chatDraft.trim()||!chat) return;
    setMsgs(m=>({...m,[chat]:[...(m[chat]||[]),{id:Date.now(),from:1,text:chatDraft.trim(),time:"now",read:true}]}));
    setChatDraft("");
  };

  const C = {
    navy:"#1a5c2a", nDark:"#0f3d1a", nLight:"#236b32", gold:"#c9a43e",
    bg:      dark?"#0b1a0f":"#f0ede6",
    sidebar: dark?"#0d1f12":"#ffffff",
    header:  dark?"#091509":"#0f3d1a",
    card:    dark?"#142018":"#ffffff",
    card2:   dark?"#1a2a1e":"#faf8f4",
    border:  dark?"rgba(255,255,255,.07)":"rgba(26,92,42,.11)",
    text:    dark?"#e6f0e8":"#1c2d1e",
    muted:   dark?"#6b9b74":"#5a7a60",
    input:   dark?"#1c2e20":"#f5f2eb",
  };
  const btnP = { background:`linear-gradient(135deg,${C.navy},${C.nDark})`, color:"#fff", border:"none", borderRadius:10, padding:"8px 18px", fontSize:13, fontWeight:700, cursor:"pointer" };
  const inp  = { background:C.input, border:`1.5px solid ${C.border}`, borderRadius:10, padding:"9px 13px", fontSize:13, fontFamily:"inherit", outline:"none", color:C.text, width:"100%", boxSizing:"border-box" };
  const crd  = { background:C.card, borderRadius:16, border:`1px solid ${C.border}`, boxShadow:dark?"0 2px 16px rgba(0,0,0,.3)":"0 1px 8px rgba(26,92,42,.06)" };

  const NavItem = ({ icon, label, pg, badge }) => (
    <div onClick={()=>nav(pg)} style={{ display:"flex", alignItems:"center", gap:9, padding:"8px 12px", borderRadius:10, marginBottom:2, cursor:"pointer", background:page===pg?`linear-gradient(135deg,${C.navy}22,${C.gold}11)`:"none", color:page===pg?C.navy:C.muted, fontWeight:page===pg?800:500, fontSize:13, transition:"all .15s", position:"relative" }}>
      <span style={{ fontSize:16, width:20, textAlign:"center" }}>{icon}</span>
      <span style={{ flex:1 }}>{label}</span>
      {badge>0 && <span style={{ background:"#c62828", color:"#fff", fontSize:9, fontWeight:800, padding:"1px 5px", borderRadius:9, minWidth:16, textAlign:"center" }}>{badge}</span>}
      {page===pg && <div style={{ position:"absolute", left:0, top:"20%", bottom:"20%", width:3, background:C.gold, borderRadius:"0 3px 3px 0" }} />}
    </div>
  );

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  const renderDashboard = () => {
    const todayName = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
    const todaySlots = TIMETABLE.filter(s=>s.day===todayName);
    const hour = new Date().getHours();
    const greetWord = lang==="ar" ? (hour<12?"صباح الخير":hour<17?"مساء الخير":"مساء النور") : (hour<12?"Good morning":hour<17?"Good afternoon":"Good evening");
    return (
      <div>
        <p style={{ fontFamily:"'Amiri',serif", fontSize:16, color:C.gold, marginBottom:4 }}>بسم الله الرحمن الرحيم</p>
        <h2 style={{ fontSize:26, fontWeight:900, color:C.text, margin:"0 0 2px" }}>{greetWord}, {ME.name.split(" ")[0]} 👋</h2>
        <p style={{ color:C.muted, fontSize:12, marginBottom:2 }}>{ME.college} · {ME.department} · Year {ME.year}</p>
        <p style={{ color:C.muted, fontSize:13, marginBottom:18 }}>{lang==="ar"?"إليك ما يحدث اليوم في OIU.":"Here's what's happening today at OIU."}</p>

        {incomingCount>0 && (
          <div onClick={()=>nav("people")} style={{ background:`linear-gradient(90deg,${C.nDark},${C.navy})`, borderRadius:14, padding:"14px 20px", marginBottom:18, display:"flex", alignItems:"center", gap:14, cursor:"pointer", boxShadow:"0 4px 20px rgba(15,61,26,.3)" }}>
            <span style={{ fontSize:30 }}>👋</span>
            <div style={{ flex:1 }}><div style={{ fontWeight:800, color:"#fff", fontSize:15 }}>{incomingCount} pending friend request{incomingCount>1?"s":""}!</div><div style={{ fontSize:12, color:"rgba(255,255,255,.55)", marginTop:2 }}>From: {incoming.map(r=>STUDENTS.find(s=>s.id===r.from)?.name.split(" ")[0]).join(", ")}</div></div>
            <span style={{ color:C.gold, fontSize:20 }}>→</span>
          </div>
        )}

        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12, marginBottom:18 }}>
          {[{label:"Pending Tasks",val:pendingAsgn,icon:"📝",click:()=>nav("assignments")},{label:"Current GPA",val:ME.gpa,icon:"🎓",click:()=>nav("grades")},{label:"Campus Rank",val:`#${ME.rank}`,icon:"🏆",click:()=>nav("leaderboard")},{label:"Friends",val:friends.length,icon:"👥",click:()=>nav("people")}].map((k,i)=>(
            <div key={i} onClick={k.click} style={{ ...crd, padding:18, cursor:"pointer" }}>
              <div style={{ fontSize:26, marginBottom:8 }}>{k.icon}</div>
              <div style={{ fontSize:30, fontWeight:900, color:C.navy, lineHeight:1 }}>{k.val}</div>
              <div style={{ fontSize:12, color:C.muted, marginTop:5, fontWeight:600 }}>{k.label}</div>
            </div>
          ))}
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
          <div style={crd}>
            <div style={{ padding:"14px 18px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:0 }}>📝 Upcoming Assignments</h3>
              <span onClick={()=>nav("assignments")} style={{ fontSize:11, color:C.gold, cursor:"pointer", fontWeight:700 }}>View all →</span>
            </div>
            <div style={{ padding:"4px 0 8px" }}>
              {asgns.filter(a=>a.status==="pending").slice(0,3).map(a=>{
                const diff=new Date(a.due)-Date.now(), d=Math.ceil(diff/86400000);
                const t=diff<0?{bg:"#ffebee",c:"#c62828",l:"Overdue"}:d<=3?{bg:"#fff3e0",c:"#e65100",l:d+"d left"}:{bg:"#e8f5e9",c:"#2e7d32",l:d+"d left"};
                return <div key={a.id} style={{ display:"flex", gap:12, padding:"10px 18px", borderBottom:`1px solid ${C.border}`, alignItems:"center" }}><div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{a.title}</div><div style={{ fontSize:11, color:C.muted }}>{a.course}</div></div><Tag label={t.l} bg={t.bg} fg={t.c} /></div>;
              })}
            </div>
          </div>

          <div style={crd}>
            <div style={{ padding:"14px 18px 0", display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:0 }}>🗓 Today's Schedule</h3>
              <span onClick={()=>nav("timetable")} style={{ fontSize:11, color:C.gold, cursor:"pointer", fontWeight:700 }}>Full →</span>
            </div>
            <div style={{ padding:"4px 0 8px" }}>
              {!todaySlots.length ? <div style={{ padding:"20px 18px", textAlign:"center", color:C.muted, fontSize:13 }}>No classes today 🎉</div> : todaySlots.map((s,i)=>(
                <div key={i} style={{ display:"flex", gap:10, padding:"9px 18px", borderBottom:`1px solid ${C.border}`, alignItems:"center" }}>
                  <div style={{ width:4, height:36, borderRadius:4, background:s.color, flexShrink:0 }}></div>
                  <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.course}</div><div style={{ fontSize:11, color:C.muted }}>{s.time} · 📍 {s.room}</div></div>
                </div>
              ))}
            </div>
          </div>

          <div style={crd}>
            <div style={{ padding:"14px 18px 4px" }}><h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:0 }}>📢 Latest Notices</h3></div>
            {notices.slice(0,3).map(a=>{
              const pc={urgent:"#c62828",high:C.gold,normal:C.navy}[a.priority];
              return <div key={a.id} style={{ display:"flex", gap:10, padding:"10px 18px", borderBottom:`1px solid ${C.border}` }}><div style={{ width:3, minHeight:36, borderRadius:3, background:pc, flexShrink:0 }}></div><div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{a.title}</div><div style={{ fontSize:11, color:C.muted }}>{a.date}</div></div></div>;
            })}
          </div>

          <div style={crd}>
            <div style={{ padding:"14px 18px 10px", display:"flex", justifyContent:"space-between" }}>
              <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:0 }}>👥 Friends Online</h3>
              <span onClick={()=>nav("people")} style={{ fontSize:11, color:C.gold, cursor:"pointer", fontWeight:700 }}>All →</span>
            </div>
            <div style={{ padding:"0 18px 14px", display:"flex", gap:14, flexWrap:"wrap" }}>
              {STUDENTS.filter(s=>friends.includes(s.id)).map(s=>(
                <div key={s.id} onClick={()=>openChat(s.id)} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:5, cursor:"pointer" }}>
                  <AvatarDisplay name={s.name} photo={null} size={44} badge={s.status==="online"} />
                  <div style={{ fontSize:10, color:C.muted, textAlign:"center", maxWidth:52, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{s.name.split(" ")[0]}</div>
                </div>
              ))}
              {friends.length===0 && <div style={{ fontSize:13, color:C.muted }}>No friends yet. <span onClick={()=>nav("people")} style={{ color:C.navy, cursor:"pointer", fontWeight:700 }}>Find people →</span></div>}
            </div>
          </div>
        </div>

        {/* Quick access row */}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(8,1fr)", gap:10, marginTop:14 }}>
          {[{icon:"📚",label:"Library",pg:"library"},{icon:"💰",label:"Finance",pg:"finance"},{icon:"🎓",label:"Grades",pg:"grades"},{icon:"📅",label:"Events",pg:"events"},{icon:"📡",label:"Channels",pg:"channels"},{icon:"🧑‍💻",label:"Study Rooms",pg:"rooms"},{icon:"🤖",label:"AI Tutor",pg:"tutor"},{icon:"🧠",label:"Quiz",pg:"quiz"}].map(it=>(
            <div key={it.pg} onClick={()=>nav(it.pg)} style={{ ...crd, padding:"14px 10px", textAlign:"center", cursor:"pointer", transition:"transform .15s" }} onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="none"}>
              <div style={{ fontSize:24, marginBottom:6 }}>{it.icon}</div>
              <div style={{ fontSize:11, fontWeight:700, color:C.muted }}>{it.label}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── FEED ──────────────────────────────────────────────────────────────────
  const renderFeed = () => {
    // Apply college-scoped visibility: only show public posts OR same-college posts
    const visible = posts.filter(canSeePost);
    const filtered = feedFilter==="friends" ? visible.filter(p=>p.author_id===ME.id||friends.includes(p.author_id))
                   : feedFilter==="pinned"  ? visible.filter(p=>p.pinned)
                   : feedFilter==="college" ? visible.filter(p=>p.college===ME.college||p.author_id===ME.id)
                   : visible;
    const sorted = [...filtered].sort((a,b)=>a.pinned===b.pinned?0:a.pinned?-1:1);
    const storyBgs = ["linear-gradient(135deg,#7b3f00,#c9a43e)","linear-gradient(135deg,#1565c0,#0d47a1)","linear-gradient(135deg,#4a148c,#6a1b9a)","linear-gradient(135deg,#2e7d32,#1b5e20)"];
    return (
      <div style={{ maxWidth:660, margin:"0 auto" }}>
        {/* Sync status bar */}
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10, padding:"6px 14px", borderRadius:10,
          background: syncStatus==="offline" ? "rgba(198,40,40,.08)" : syncStatus==="syncing" ? "rgba(201,164,62,.08)" : "rgba(26,92,42,.07)",
          border:`1px solid ${syncStatus==="offline"?"rgba(198,40,40,.15)":syncStatus==="syncing"?"rgba(201,164,62,.2)":"rgba(26,92,42,.12)"}` }}>
          <div style={{ display:"flex", alignItems:"center", gap:7, fontSize:12 }}>
            <span style={{ fontSize:14 }}>{syncStatus==="offline"?"📴":syncStatus==="syncing"?"🔄":"☁️"}</span>
            <span style={{ fontWeight:700, color: syncStatus==="offline"?"#c62828":syncStatus==="syncing"?"#b8922d":C.navy }}>
              {syncStatus==="offline" ? "Offline — changes saved locally" : syncStatus==="syncing" ? "Syncing…" : `Live · ${sorted.length} posts visible`}
            </span>
          </div>
          <div style={{ fontSize:11, color:C.muted }}>{syncStatus==="synced"&&lastSync>0 ? `Updated ${new Date(lastSync).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}` : ""}</div>
        </div>

        {/* ── STORIES STRIP ───────────────────────────────────── */}
        <div style={{ ...crd, padding:"14px 16px", marginBottom:16, overflow:"hidden" }}>
          <div style={{ display:"flex", gap:12, overflowX:"auto", paddingBottom:4 }}>
            {/* My story / add story */}
            <div onClick={()=>setShowStoryCompose(true)} style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:"pointer" }}>
              <div style={{ position:"relative", width:60, height:60, borderRadius:18, background:`linear-gradient(135deg,${C.navy},${C.gold})`, display:"flex", alignItems:"center", justifyContent:"center", border:`2px solid ${C.gold}` }}>
                <AvatarDisplay name={ME.name} photo={myPhoto} size={50} />
                <div style={{ position:"absolute", bottom:-4, right:-4, width:22, height:22, borderRadius:"50%", background:`linear-gradient(135deg,${C.navy},${C.nDark})`, border:`2px solid ${C.card}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14, color:"#fff", fontWeight:900 }}>+</div>
              </div>
              <span style={{ fontSize:10, color:C.muted, fontWeight:700, whiteSpace:"nowrap" }}>Your Story</span>
            </div>
            {/* Other stories */}
            {stories.map(s=>(
              <div key={s.id} onClick={()=>{ setStories(ss=>ss.map(x=>x.id===s.id?{...x,seen:true}:x)); setViewingStory(s.id); }} style={{ flexShrink:0, display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:"pointer" }}>
                <div style={{ width:60, height:60, borderRadius:18, background:s.bg, border:`3px solid ${s.seen?C.border:C.gold}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, position:"relative", transition:"border-color .2s" }}>
                  <AvatarDisplay name={s.name} size={50} />
                  {!s.seen && <div style={{ position:"absolute", inset:-3, borderRadius:20, border:`3px solid ${C.gold}`, pointerEvents:"none" }}/>}
                </div>
                <span style={{ fontSize:10, color:s.seen?C.muted:C.text, fontWeight:s.seen?400:700, whiteSpace:"nowrap", maxWidth:60, overflow:"hidden", textOverflow:"ellipsis" }}>{s.name.split(" ")[0]}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>📣 Social Feed</h2>
          <div style={{ display:"flex", gap:4, background:C.card2, borderRadius:10, padding:3, border:`1px solid ${C.border}` }}>
            {[{k:"all",l:"🌐 All"},{k:"college",l:`🎓 ${ME.college.replace("Faculty of ","")}`},{k:"friends",l:"👥 Friends"},{k:"pinned",l:"📌"}].map(tb=>(
              <button key={tb.k} onClick={()=>setFeedFilter(tb.k)} style={{ background:feedFilter===tb.k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none", color:feedFilter===tb.k?"#fff":C.muted, border:"none", borderRadius:7, padding:"5px 12px", fontSize:12, fontWeight:700, cursor:"pointer" }}>{tb.l}</button>
            ))}
          </div>
        </div>
        <ComposeBox myPhoto={myPhoto} me={ME} onPost={async (p) => {
          const newPost = { ...p, syncStatus: "local" };
          setPosts(ps => [newPost, ...ps]);
          push("Posted! 🎉", "success");
          // Save to server immediately
          if (ServerServerDB.isOnline()) {
            try {
              const saved = await ServerDB.pushPost(newPost);
              setPosts(ps => ps.map(x => x.id === newPost.id ? {...x, ...saved, syncStatus:"synced"} : x));
            } catch { /* stays as "local", will show as pending */ }
          }
        }} dark={dark} C={C} />
        {sorted.map(p=>(
          <PostCard key={p.id} post={p} me={ME} myPhoto={myPhoto} friends={friends} fStatus={fStatus} sendReq={sendReq} openChat={openChat}
            onReact={reactPost} onComment={addComment} onPin={pinPost} onDelete={deletePost} onVotePoll={votePoll} dark={dark} C={C} push={push} />
        ))}

        {/* ── STORY VIEWER OVERLAY ─────────────────────────────── */}
        {viewingStory && (() => {
          const s = stories.find(x=>x.id===viewingStory);
          if(!s) return null;
          const idx = stories.indexOf(s);
          return (
            <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.9)", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center" }}>
              <div style={{ width:"100%", maxWidth:380, height:"85vh", borderRadius:24, background:s.bg, display:"flex", flexDirection:"column", position:"relative", overflow:"hidden" }}>
                {/* Progress bars */}
                <div style={{ display:"flex", gap:3, padding:"12px 12px 0" }}>
                  {stories.map((st,i)=>(
                    <div key={st.id} style={{ flex:1, height:3, borderRadius:2, background:i<idx?"rgba(255,255,255,.9)":i===idx?"rgba(255,255,255,.9)":"rgba(255,255,255,.3)" }}/>
                  ))}
                </div>
                {/* Header */}
                <div style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 16px" }}>
                  <AvatarDisplay name={s.name} size={36}/>
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:800, color:"#fff" }}>{s.name}</div>
                    <div style={{ fontSize:11, color:"rgba(255,255,255,.6)" }}>{s.time}</div>
                  </div>
                  <button onClick={()=>setViewingStory(null)} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:"50%", width:32, height:32, cursor:"pointer", fontSize:16, color:"#fff", display:"flex", alignItems:"center", justifyContent:"center" }}>✕</button>
                </div>
                {/* Content */}
                <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", padding:24 }}>
                  <p style={{ fontSize:24, fontWeight:800, color:"#fff", textAlign:"center", lineHeight:1.5, textShadow:"0 2px 12px rgba(0,0,0,.4)" }}>{s.text}</p>
                </div>
                {/* Navigation */}
                <div style={{ display:"flex", justifyContent:"space-between", padding:"0 16px 24px" }}>
                  <button onClick={()=>setViewingStory(stories[Math.max(0,idx-1)]?.id||null)} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:20, padding:"8px 18px", color:"#fff", cursor:"pointer", fontWeight:700, fontSize:13 }}>← Prev</button>
                  <button onClick={()=>{ const next=stories[idx+1]; if(next)setViewingStory(next.id); else setViewingStory(null); }} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:20, padding:"8px 18px", color:"#fff", cursor:"pointer", fontWeight:700, fontSize:13 }}>Next →</button>
                </div>
              </div>
            </div>
          );
        })()}

        {/* ── STORY COMPOSE OVERLAY ──────────────────────────── */}
        {showStoryCompose && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.7)", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
            <div style={{ background:C.card, borderRadius:20, padding:24, width:"100%", maxWidth:400 }}>
              <div style={{ display:"flex", justifyContent:"space-between", marginBottom:16 }}>
                <div style={{ fontSize:16, fontWeight:900, color:C.navy }}>📸 Create Story</div>
                <button onClick={()=>setShowStoryCompose(false)} style={{ background:"none", border:"none", fontSize:18, cursor:"pointer", color:C.muted }}>✕</button>
              </div>
              <div style={{ height:120, borderRadius:14, background:storyBg, display:"flex", alignItems:"center", justifyContent:"center", marginBottom:12, padding:16 }}>
                <p style={{ color:"#fff", fontWeight:800, fontSize:18, textAlign:"center", textShadow:"0 1px 6px rgba(0,0,0,.3)" }}>{storyDraft||"Your story text…"}</p>
              </div>
              <textarea value={storyDraft} onChange={e=>setStoryDraft(e.target.value)} placeholder="What's on your mind?" rows={3} style={{ ...inp, resize:"none", marginBottom:10 }}/>
              <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap" }}>
                {["linear-gradient(135deg,#1a5c2a,#c9a43e)","linear-gradient(135deg,#7b3f00,#c9a43e)","linear-gradient(135deg,#1565c0,#0d47a1)","linear-gradient(135deg,#4a148c,#6a1b9a)","linear-gradient(135deg,#c62828,#b71c1c)","linear-gradient(135deg,#006064,#00838f)"].map(bg=>(
                  <button key={bg} onClick={()=>setStoryBg(bg)} style={{ width:32, height:32, borderRadius:10, background:bg, border:`3px solid ${storyBg===bg?C.gold:"transparent"}`, cursor:"pointer" }}/>
                ))}
              </div>
              <button onClick={()=>{
                if(!storyDraft.trim()){push("Write something first","error");return;}
                const ns={id:"s"+Date.now(),author:1,name:ME.name,bg:storyBg,text:storyDraft.trim(),time:"just now",seen:false,type:"text"};
                setStories(ss=>[ns,...ss]); setStoryDraft(""); setShowStoryCompose(false);
                push("Story posted! 📸","success");
              }} style={{ ...btnP, width:"100%", padding:"11px" }}>📤 Share Story</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── CHANNELS ──────────────────────────────────────────────────────────────
  const renderChannels = () => {
    const msgs2 = activeChannel ? (chMsgs[activeChannel]||[]) : [];
    const ch = CHANNELS.find(c=>c.id===activeChannel);
    return (
      <div style={{ display:"flex", height:"calc(100vh - 80px)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, background:C.card }}>
        <div style={{ width:280, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", background:C.card2, flexShrink:0 }}>
          <div style={{ padding:"16px 16px 10px", borderBottom:`1px solid ${C.border}` }}>
            <h3 style={{ fontSize:16, fontWeight:900, color:C.navy, margin:"0 0 4px" }}>📡 Channels</h3>
            <p style={{ fontSize:12, color:C.muted, margin:0 }}>University broadcast channels</p>
          </div>
          <div style={{ flex:1, overflowY:"auto" }}>
            <div style={{ padding:"8px 10px 4px" }}><div style={{ fontSize:10, fontWeight:800, color:C.muted, textTransform:"uppercase", letterSpacing:.6, marginBottom:4 }}>Subscribed</div></div>
            {CHANNELS.filter(c=>subscribedChs.includes(c.id)).map(c=>(
              <div key={c.id} onClick={()=>setActiveChannel(c.id)} style={{ display:"flex", gap:10, padding:"10px 14px", cursor:"pointer", background:activeChannel===c.id?(dark?"rgba(26,92,42,.25)":"rgba(26,92,42,.07)"):"transparent", borderBottom:`1px solid ${C.border}`, transition:"background .15s" }}>
                <div style={{ width:44, height:44, borderRadius:12, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{c.icon}</div>
                <div style={{ flex:1, minWidth:0 }}><div style={{ fontSize:14, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{c.name}</div><div style={{ fontSize:11, color:C.muted, marginTop:2 }}>👥 {c.members.toLocaleString()}</div></div>
              </div>
            ))}
            <div style={{ padding:"8px 10px 4px" }}><div style={{ fontSize:10, fontWeight:800, color:C.muted, textTransform:"uppercase", letterSpacing:.6, marginBottom:4 }}>Discover</div></div>
            {CHANNELS.filter(c=>!subscribedChs.includes(c.id)).map(c=>(
              <div key={c.id} style={{ display:"flex", gap:10, padding:"10px 14px", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ width:44, height:44, borderRadius:12, background:dark?"rgba(255,255,255,.06)":"rgba(26,92,42,.05)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{c.icon}</div>
                <div style={{ flex:1, minWidth:0 }}><div style={{ fontSize:14, fontWeight:700, color:C.text }}>{c.name}</div><div style={{ fontSize:11, color:C.muted, marginTop:1 }}>{c.desc}</div></div>
                <button onClick={()=>{setSubscribedChs(s=>[...s,c.id]);push(`Subscribed to ${c.name} ✅`,"success");}} style={{ ...btnP, padding:"5px 10px", fontSize:11, flexShrink:0, alignSelf:"center" }}>+Join</button>
              </div>
            ))}
          </div>
        </div>
        {!activeChannel ? (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, color:C.muted }}>
            <div style={{ fontSize:56 }}>📡</div>
            <div style={{ fontSize:20, fontWeight:800, color:C.text }}>Select a Channel</div>
            <div style={{ fontSize:14 }}>Choose a channel to read updates</div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderBottom:`1px solid ${C.border}`, background:dark?"rgba(9,21,9,.5)":"rgba(247,243,235,.9)" }}>
              <div style={{ width:42, height:42, borderRadius:12, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>{ch?.icon}</div>
              <div style={{ flex:1 }}><div style={{ fontSize:15, fontWeight:800, color:C.text }}>{ch?.name}</div><div style={{ fontSize:12, color:C.muted }}>{ch?.members.toLocaleString()} subscribers</div></div>
              <button onClick={()=>{setSubscribedChs(s=>s.filter(x=>x!==activeChannel));setActiveChannel(null);push("Unsubscribed","");}} style={{ background:"#ffebee", color:"#c62828", border:"none", borderRadius:9, padding:"6px 12px", fontSize:12, fontWeight:700, cursor:"pointer" }}>Leave</button>
            </div>
            <div style={{ flex:1, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:10 }}>
              {msgs2.map(m=>(
                <div key={m.id} style={{ ...crd, padding:16, position:"relative" }}>
                  {m.pinned && <div style={{ position:"absolute", top:10, right:12, fontSize:11, color:C.gold, fontWeight:800 }}>📌</div>}
                  <p style={{ fontSize:14, lineHeight:1.75, color:C.text, whiteSpace:"pre-wrap", margin:"0 0 10px" }}>{m.text.replace(/\*\*(.*?)\*\*/g,"$1")}</p>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                    <div style={{ display:"flex", gap:6 }}>
                      {Object.entries(m.reactions||{}).filter(([,v])=>v>0).map(([k,v])=>(
                        <span key={k} style={{ background:dark?"rgba(255,255,255,.08)":"rgba(26,92,42,.06)", borderRadius:20, padding:"3px 8px", fontSize:13 }}>{k} {v}</span>
                      ))}
                    </div>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <span style={{ fontSize:11, color:C.muted }}>👁 {m.views}</span>
                      <span style={{ fontSize:11, color:C.muted }}>{m.time}</span>
                    </div>
                  </div>
                  <div style={{ display:"flex", gap:4, marginTop:8 }}>
                    {REACTIONS.slice(0,5).map(r=><button key={r.key} onClick={()=>setChMsgs(cm=>({...cm,[activeChannel]:cm[activeChannel].map(x=>x.id===m.id?{...x,reactions:{...x.reactions,[r.key]:(x.reactions[r.key]||0)+1}}:x)}))} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"3px 9px", cursor:"pointer", fontSize:13 }}>{r.key}</button>)}
                  </div>
                </div>
              ))}
              {msgs2.length===0 && <div style={{ textAlign:"center", color:C.muted, padding:40 }}><div style={{ fontSize:36, marginBottom:8 }}>📭</div>No posts yet</div>}
              <div ref={msgsEnd} />
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── CHAT ──────────────────────────────────────────────────────────────────
  const renderChat = () => {
    const activePerson = STUDENTS.find(s=>s.id===chat);
    const convMsgs = chat ? (msgs[chat]||[]) : [];
    const contacts = STUDENTS.filter(s=>friends.includes(s.id)||Object.keys(msgs).map(Number).includes(s.id));
    return (
      <div style={{ display:"flex", height:"calc(100vh - 80px)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, background:C.card }}>
        <div style={{ width:280, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", background:C.card2, flexShrink:0 }}>
          <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${C.border}` }}>
            <h3 style={{ fontSize:15, fontWeight:900, color:C.navy, margin:"0 0 8px" }}>💬 Messages</h3>
            <input placeholder="Search conversations…" style={{ ...inp, fontSize:12, padding:"7px 11px" }} />
          </div>
          <div style={{ flex:1, overflowY:"auto" }}>
            {contacts.map(s=>{
              const conv = msgs[s.id]||[];
              const last = conv[conv.length-1];
              const unread = conv.filter(m=>m.from!==1&&!m.read).length;
              return (
                <div key={s.id} onClick={()=>{setChat(s.id);setMsgs(m=>({...m,[s.id]:m[s.id]?.map(x=>({...x,read:true}))||[]}));}} style={{ display:"flex", gap:10, padding:"12px 14px", cursor:"pointer", background:chat===s.id?(dark?"rgba(26,92,42,.25)":"rgba(26,92,42,.06)"):"transparent", borderBottom:`1px solid ${C.border}`, transition:"background .15s" }}>
                  <AvatarDisplay name={s.name} photo={null} size={42} badge={s.status==="online"} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                      <div style={{ fontSize:13, fontWeight:unread>0?800:600, color:C.text }}>{s.name.split(" ")[0]}</div>
                      {unread>0 && <span style={{ background:"#c62828", color:"#fff", fontSize:9, fontWeight:800, padding:"1px 5px", borderRadius:9, minWidth:16, textAlign:"center" }}>{unread}</span>}
                    </div>
                    <div style={{ fontSize:11, color:C.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{last?.text||"No messages yet"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        {!chat ? (
          <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:12, color:C.muted }}>
            <div style={{ fontSize:56 }}>💬</div>
            <div style={{ fontSize:20, fontWeight:800, color:C.text }}>Select a conversation</div>
          </div>
        ) : (
          <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
            <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderBottom:`1px solid ${C.border}`, background:dark?"rgba(9,21,9,.5)":"rgba(247,243,235,.9)" }}>
              <AvatarDisplay name={activePerson?.name||""} photo={null} size={40} badge={activePerson?.status==="online"} />
              <div style={{ flex:1 }}><div style={{ fontSize:15, fontWeight:800, color:C.text }}>{activePerson?.name}</div><div style={{ fontSize:12, color:activePerson?.status==="online"?"#2e7d32":C.muted }}>{activePerson?.status==="online"?"● Online":"○ Offline"}</div></div>
              <button onClick={()=>setCallState({type:"voice",person:activePerson,active:true})} title="Voice call" style={{ width:36,height:36,borderRadius:"50%",background:`rgba(26,92,42,.1)`,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",color:C.navy }}>📞</button>
              <button onClick={()=>setCallState({type:"video",person:activePerson,active:true})} title="Video call" style={{ width:36,height:36,borderRadius:"50%",background:`rgba(26,92,42,.1)`,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",color:C.navy }}>📹</button>
              <button onClick={()=>setViewingProfile(activePerson?.id)} title="View profile" style={{ width:36,height:36,borderRadius:"50%",background:`rgba(26,92,42,.1)`,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:18,display:"flex",alignItems:"center",justifyContent:"center",color:C.navy }}>👤</button>
            </div>
            <div style={{ flex:1, overflowY:"auto", padding:"16px", display:"flex", flexDirection:"column", gap:8 }}>
              {convMsgs.map(m=>{
                const mine = m.from===ME.id;
                return (
                  <div key={m.id} style={{ display:"flex", justifyContent:mine?"flex-end":"flex-start", flexDirection:"column", alignItems:mine?"flex-end":"flex-start" }}>
                    <div style={{ display:"flex", alignItems:"flex-end", gap:6 }}>
                      {!mine && <AvatarDisplay name={activePerson?.name||""} photo={null} size={28} />}
                      <div style={{ maxWidth:"70%" }}>
                        <div style={{ background:mine?`linear-gradient(135deg,${C.navy},${C.nDark})`:(dark?"rgba(255,255,255,.08)":"rgba(0,0,0,.05)"), color:mine?"#fff":C.text, borderRadius:mine?"16px 16px 4px 16px":"16px 16px 16px 4px", padding:"10px 14px", fontSize:14, lineHeight:1.5 }}>{m.text}</div>
                        <div style={{ fontSize:10, color:C.muted, marginTop:3, textAlign:mine?"right":"left" }}>{m.time}{mine&&" ✓✓"}</div>
                        {m.reaction && <div style={{ fontSize:16, textAlign:mine?"right":"left", marginTop:2 }}>{m.reaction}</div>}
                      </div>
                      {mine && <AvatarDisplay name={ME.name} photo={myPhoto} size={28} />}
                    </div>
                    {/* Quick react */}
                    {!mine && (
                      <div style={{ display:"flex", gap:3, marginLeft:34, marginTop:3 }}>
                        {["❤️","👍","😂","🙏"].map(r=>(
                          <button key={r} onClick={()=>setMsgs(mm=>({...mm,[chat]:mm[chat].map(x=>x.id===m.id?{...x,reaction:x.reaction===r?null:r}:x)}))} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:20, padding:"2px 6px", cursor:"pointer", fontSize:13, opacity:m.reaction===r?1:.5 }}>{r}</button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={msgsEnd} />
            </div>
            <div style={{ padding:"12px 16px", borderTop:`1px solid ${C.border}`, display:"flex", gap:8, alignItems:"center" }}>
              <button onClick={()=>{const emojis=["😊","😂","🙏","❤️","🔥","💯","👍","😮"]; setChatDraft(d=>d+emojis[Math.floor(Math.random()*emojis.length)]);}} style={{ width:36,height:36,borderRadius:"50%",background:C.card2,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:18,flexShrink:0 }}>😊</button>
              <input value={chatDraft} onChange={e=>setChatDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMsg();}}} placeholder="Type a message… اكتب رسالة" style={{ ...inp, borderRadius:22, flex:1 }} />
              <button onClick={sendMsg} style={{ width:42, height:42, borderRadius:"50%", background:`linear-gradient(135deg,${C.navy},${C.nDark})`, border:"none", display:"flex", alignItems:"center", justifyContent:"center", cursor:"pointer", fontSize:18, color:"#fff", flexShrink:0 }}>➤</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── PEOPLE ────────────────────────────────────────────────────────────────
  const renderPeople = () => {
    const tabs=[{k:"discover",l:"🔍 Discover"},{k:"friends",l:`👥 Friends (${friends.length})`},{k:"requests",l:`📩 Requests${incomingCount>0?" ("+incomingCount+")":""}`},{k:"sent",l:`📤 Sent (${sent.length})`}];
    const getMutual = id => STUDENTS.filter(s=>friends.includes(s.id)&&STUDENTS.find(x=>x.id===id)?.id!==s.id).slice(0,3);
    const colleges2 = ["All",...new Set(STUDENTS.map(s=>s.college.replace("Faculty of ","")).sort())];
    const filtered = STUDENTS.filter(s=>s.id!==1
      && s.name.toLowerCase().includes(pQ.toLowerCase())
      && (pCollege==="All" || s.college.includes(pCollege))
    );
    const suggested = STUDENTS.filter(s=>!friends.includes(s.id)&&!sent.includes(s.id)&&s.id!==1&&!incoming.find(r=>r.from===s.id)).slice(0,4);

    const PersonCard = ({s, showInvite=false}) => {
      const st=fStatus(s.id);
      const mutual=getMutual(s.id);
      return (
        <div style={{ ...crd, padding:18, display:"flex", flexDirection:"column", gap:10 }}>
          <div style={{ display:"flex", gap:12, alignItems:"center" }}>
            <div style={{ position:"relative" }}>
              <AvatarDisplay name={s.name} photo={null} size={52} badge={s.status==="online"} />
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{s.name}</div>
              <div style={{ fontSize:11, color:C.muted }}>{s.college.replace("Faculty of ","")}</div>
              <div style={{ fontSize:11, color:s.status==="online"?"#2e7d32":C.muted, marginTop:1 }}>{s.status==="online"?"● Online":"○ Offline"} · Year {s.year}</div>
            </div>
          </div>
          {s.bio && <p style={{ fontSize:12, color:C.muted, lineHeight:1.5, margin:0 }}>{s.bio}</p>}
          {mutual.length>0 && (
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <div style={{ display:"flex" }}>{mutual.map(m=><div key={m.id} style={{ width:18,height:18,borderRadius:"50%",background:scol(m.name),marginLeft:-4,border:"1.5px solid white",display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:"#fff",fontWeight:700 }}>{inits(m.name)}</div>)}</div>
              <span style={{ fontSize:11, color:C.muted }}>+{friends.length} mutual</span>
            </div>
          )}
          <div style={{ display:"flex", gap:7, flexWrap:"wrap" }}>
            {st==="friend" && <>
              <button onClick={()=>openChat(s.id)} style={{ ...btnP, flex:1, padding:"7px", fontSize:12 }}>💬 Message</button>
              {showInvite && (
                <button onClick={()=>{
                  const g=groups.find(x=>x.members.find(m=>m.id===ME.id)&&isGroupAdmin(x)&&!x.members.find(m=>m.id===s.id));
                  if(g){addMemberToGroup(g.id,s.id);push(`Added to ${g.name}!`,"success");}else push("No group to invite to","error");
                }} style={{ background:C.input, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"7px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>+ Group</button>
              )}
              <button onClick={()=>removeFriend(s.id)} style={{ background:"#ffebee", color:"#c62828", border:"none", borderRadius:10, padding:"7px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}>✕</button>
            </>}
            {st==="sent" && <button disabled style={{ flex:1, background:C.input, color:C.muted, border:"none", borderRadius:10, padding:"7px", fontSize:12, fontWeight:700, cursor:"not-allowed" }}>Sent ✓</button>}
            {st==="incoming" && <>
              <button onClick={()=>acceptReq(incoming.find(r=>r.from===s.id)?.id,s.id)} style={{ ...btnP, flex:1, padding:"7px", fontSize:12 }}>✅ Accept</button>
              <button onClick={()=>declineReq(incoming.find(r=>r.from===s.id)?.id)} style={{ background:"#ffebee", color:"#c62828", border:"none", borderRadius:10, padding:"7px 10px", fontSize:12, fontWeight:700, cursor:"pointer" }}>✕ Decline</button>
            </>}
            {st==="none" && <button onClick={()=>sendReq(s.id)} style={{ ...btnP, flex:1, padding:"7px", fontSize:12 }}>👋 Add Friend</button>}
          </div>
        </div>
      );
    };

    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16, flexWrap:"wrap", gap:10 }}>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>👥 {t.people}</h2>
          <div style={{ display:"flex", gap:8 }}>
            <input value={pQ} onChange={e=>setPQ(e.target.value)} placeholder="Search by name…" style={{ ...inp, width:180 }} />
            <select value={pCollege} onChange={e=>setPCollege(e.target.value)} style={{ ...inp, width:"auto", padding:"8px 10px", fontSize:12 }}>
              {colleges2.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ display:"flex", gap:4, marginBottom:18, background:C.card2, borderRadius:12, padding:4, width:"fit-content", border:`1px solid ${C.border}` }}>
          {tabs.map(tb=><button key={tb.k} onClick={()=>setPTab(tb.k)} style={{ background:pTab===tb.k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none", color:pTab===tb.k?"#fff":C.muted, border:"none", borderRadius:9, padding:"7px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>{tb.l}</button>)}
        </div>

        {pTab==="discover" && (
          <div>
            {/* People You May Know */}
            {suggested.length>0 && pQ==="" && pCollege==="All" && (
              <div style={{ marginBottom:20 }}>
                <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:10 }}>✨ People You May Know</div>
                <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))", gap:10 }}>
                  {suggested.map(s=>(
                    <div key={s.id} style={{ ...crd, padding:16, textAlign:"center" }}>
                      <AvatarDisplay name={s.name} photo={null} size={52} badge={s.status==="online"} />
                      <div style={{ fontSize:13, fontWeight:800, color:C.text, marginTop:8 }}>{s.name.split(" ")[0]}</div>
                      <div style={{ fontSize:11, color:C.muted, marginBottom:10 }}>{s.college.replace("Faculty of ","")}</div>
                      <button onClick={()=>sendReq(s.id)} style={{ ...btnP, width:"100%", padding:"7px", fontSize:12 }}>👋 Add</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:10 }}>🔍 All Students</div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12 }}>{filtered.map(s=><PersonCard key={s.id} s={s} />)}</div>
          </div>
        )}

        {pTab==="friends" && (
          <div>
            <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))", gap:12 }}>
              {STUDENTS.filter(s=>friends.includes(s.id)&&s.name.toLowerCase().includes(pQ.toLowerCase())).map(s=><PersonCard key={s.id} s={s} showInvite />)}
              {friends.length===0 && <div style={{ gridColumn:"1/-1", ...crd, padding:40, textAlign:"center", color:C.muted }}><div style={{ fontSize:40, marginBottom:10 }}>👥</div>No friends yet.</div>}
            </div>
          </div>
        )}

        {pTab==="requests" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10, maxWidth:560 }}>
            {incoming.length===0 ? (
              <div style={{ ...crd, padding:40, textAlign:"center", color:C.muted }}><div style={{ fontSize:40, marginBottom:10 }}>📭</div>No pending requests</div>
            ) : incoming.map(req=>{
              const s=STUDENTS.find(x=>x.id===req.from); if(!s) return null;
              return (
                <div key={req.id} style={{ ...crd, padding:18, display:"flex", alignItems:"center", gap:14 }}>
                  <AvatarDisplay name={s.name} photo={null} size={56} badge={s.status==="online"} />
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{s.name}</div>
                    <div style={{ fontSize:12, color:C.muted }}>{s.college.replace("Faculty of ","")}</div>
                    {s.bio && <div style={{ fontSize:12, color:C.muted, marginTop:4, fontStyle:"italic" }}>"{s.bio}"</div>}
                  </div>
                  <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                    <button onClick={()=>acceptReq(req.id,s.id)} style={{ ...btnP, padding:"8px 16px" }}>✅ Accept</button>
                    <button onClick={()=>declineReq(req.id)} style={{ background:C.input, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"8px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>✕ Decline</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {pTab==="sent" && (
          <div style={{ display:"flex", flexDirection:"column", gap:10, maxWidth:560 }}>
            {sent.length===0 ? (
              <div style={{ ...crd, padding:40, textAlign:"center", color:C.muted }}><div style={{ fontSize:40, marginBottom:10 }}>📤</div>No sent requests</div>
            ) : STUDENTS.filter(s=>sent.includes(s.id)).map(s=>(
              <div key={s.id} style={{ ...crd, padding:16, display:"flex", alignItems:"center", gap:14 }}>
                <AvatarDisplay name={s.name} photo={null} size={50} badge={s.status==="online"} />
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:C.text }}>{s.name}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{s.college.replace("Faculty of ","")}</div>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:4, alignItems:"flex-end" }}>
                  <span style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Pending ⏳</span>
                  <button onClick={()=>setSent(ss=>ss.filter(x=>x!==s.id))} style={{ background:"#ffebee", color:"#c62828", border:"none", borderRadius:9, padding:"5px 12px", fontSize:12, fontWeight:700, cursor:"pointer" }}>Cancel</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── ASSIGNMENTS ───────────────────────────────────────────────────────────
  const renderAssignments = () => {
    const filtered=asgnTab==="all"?asgns:asgns.filter(a=>a.status===asgnTab);
    return (
      <div>
        <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:18 }}>📝 Assignments</h2>
        <div style={{ display:"flex", gap:4, marginBottom:18, background:C.card2, borderRadius:12, padding:4, width:"fit-content", border:`1px solid ${C.border}` }}>
          {[{k:"pending",l:"Pending"},{k:"submitted",l:"Submitted"},{k:"graded",l:"Graded"},{k:"all",l:"All"}].map(t=><button key={t.k} onClick={()=>setAsgnTab(t.k)} style={{ background:asgnTab===t.k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none", color:asgnTab===t.k?"#fff":C.muted, border:"none", borderRadius:9, padding:"7px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>{t.l}</button>)}
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {filtered.map(a=>{
            const diff=new Date(a.due)-Date.now(), d=Math.ceil(diff/86400000);
            const dt=diff<0?{bg:"#ffebee",c:"#c62828",l:"Overdue"}:d<=3?{bg:"#fff3e0",c:"#e65100",l:d+"d left"}:{bg:"#e8f5e9",c:"#2e7d32",l:d+"d left"};
            return (
              <div key={a.id} style={{ ...crd, padding:18 }}>
                <div style={{ display:"flex", alignItems:"flex-start", gap:14, marginBottom:10 }}>
                  <div style={{ flex:1 }}>
                    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", marginBottom:5 }}>
                      <span style={{ fontSize:15, fontWeight:800, color:C.text }}>{a.title}</span>
                      <Tag label={a.status} bg={a.status==="graded"?"#e8f5e9":a.status==="submitted"?"#e3f2fd":"#fff3e0"} fg={a.status==="graded"?"#1a5c2a":a.status==="submitted"?"#1565c0":"#c9a43e"} />
                      {a.status==="pending" && <Tag label={dt.l} bg={dt.bg} fg={dt.c} />}
                    </div>
                    <div style={{ fontSize:12, color:C.muted }}>{a.course} · Due {fmtDate(a.due)}</div>
                    <p style={{ fontSize:13, color:C.muted, margin:"8px 0 0", lineHeight:1.5 }}>{a.desc}</p>
                  </div>
                  {a.status==="graded" && <div style={{ textAlign:"center", background:`linear-gradient(135deg,${C.navy},${C.nDark})`, borderRadius:12, padding:"10px 18px", flexShrink:0 }}><div style={{ fontSize:22, fontWeight:900, color:"#fff" }}>{a.grade}</div><div style={{ fontSize:10, color:"rgba(255,255,255,.6)" }}>/ {a.maxGrade}</div></div>}
                </div>
                {a.status==="graded" && a.feedback && <div style={{ background:dark?"rgba(26,92,42,.1)":"#f0f9f0", borderRadius:10, padding:"10px 14px", fontSize:13, color:C.muted, borderLeft:`3px solid ${C.navy}` }}><strong style={{ color:C.navy }}>Feedback:</strong> {a.feedback}</div>}
                {a.status==="pending" && (
                  <div style={{ marginTop:12 }}>
                    <textarea value={submitText[a.id]||""} onChange={e=>setSubmitText(s=>({...s,[a.id]:e.target.value}))} placeholder="Write your submission or paste a link…" rows={3} style={{ ...inp, resize:"vertical", marginBottom:8, borderRadius:10 }} />
                    <button onClick={()=>{ if(!(submitText[a.id]||"").trim()){push("Write something first!","error");return;} setAsgns(as=>as.map(x=>x.id===a.id?{...x,status:"submitted"}:x)); push("Assignment submitted! ✅","success"); }} style={btnP}>Submit Assignment</button>
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length===0 && <div style={{ ...crd, padding:40, textAlign:"center", color:C.muted }}><div style={{ fontSize:36, marginBottom:8 }}>✅</div>Nothing here</div>}
        </div>
      </div>
    );
  };

  // ── TIMETABLE ─────────────────────────────────────────────────────────────
  const renderTimetable = () => {
    const days=["Sunday","Monday","Tuesday","Wednesday","Thursday"];
    const todayName=["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date().getDay()];
    const allTimes=[...new Set(TIMETABLE.map(s=>s.time))].sort();
    return (
      <div>
        <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:18 }}>🗓 Timetable</h2>
        <div style={{ ...crd, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:580 }}>
            <thead><tr>
              <th style={{ padding:"12px 16px", textAlign:"left", fontSize:11, fontWeight:800, color:C.muted, width:110, borderBottom:`2px solid ${C.border}` }}>Time</th>
              {days.map(d=><th key={d} style={{ padding:"12px 8px", textAlign:"center", fontSize:11, fontWeight:800, color:d===todayName?C.navy:C.muted, borderBottom:`2px solid ${C.border}`, background:d===todayName?(dark?"rgba(26,92,42,.1)":"rgba(26,92,42,.04)"):"none" }}>{d}{d===todayName&&<div style={{ fontSize:9, color:C.gold, fontWeight:800 }}>TODAY</div>}</th>)}
            </tr></thead>
            <tbody>{allTimes.map(time=>(
              <tr key={time}>
                <td style={{ padding:"10px 16px", fontSize:11, fontWeight:700, color:C.muted, borderBottom:`1px solid ${C.border}` }}>{time}</td>
                {days.map(day=>{
                  const slot=TIMETABLE.find(s=>s.day===day&&s.time===time);
                  return <td key={day} style={{ padding:"6px 8px", borderBottom:`1px solid ${C.border}`, background:day===todayName?(dark?"rgba(26,92,42,.06)":"rgba(26,92,42,.03)"):"none" }}>{slot&&<div style={{ background:slot.color+"22", borderLeft:`3px solid ${slot.color}`, borderRadius:8, padding:"7px 8px" }}><div style={{ fontSize:11, fontWeight:700, color:slot.color, lineHeight:1.3 }}>{slot.course}</div><div style={{ fontSize:10, color:C.muted, marginTop:2 }}>📍 {slot.room}</div></div>}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    );
  };

  // ── LEADERBOARD ───────────────────────────────────────────────────────────
  const renderLeaderboard = () => {
    const all=[{id:1,name:ME.name,college:ME.college,points:ME.points,rank:ME.rank,gpa:ME.gpa},...STUDENTS].sort((a,b)=>a.rank-b.rank);
    const colleges = ["All",...new Set(all.map(s=>s.college.replace("Faculty of ","")))];
    const filtered = all.filter(s=> s.name.toLowerCase().includes(lbSearch.toLowerCase()) && (lbFilter==="All" || s.college.includes(lbFilter)));
    const podium=[[all[1],"🥈",80],[all[0],"🥇",110],[all[2],"🥉",60]].filter(([s])=>s);
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18, flexWrap:"wrap", gap:10 }}>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🏆 {lang==="ar"?"المتصدرون":"Leaderboard"}</h2>
          <div style={{ display:"flex", gap:8 }}>
            <input value={lbSearch} onChange={e=>setLbSearch(e.target.value)} placeholder={lang==="ar"?"بحث…":"Search…"} style={{ ...inp, width:160 }} />
            <select value={lbFilter} onChange={e=>setLbFilter(e.target.value)} style={{ ...inp, width:"auto", padding:"7px 10px", fontSize:12 }}>
              {colleges.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>
        <div style={{ ...crd, padding:"24px 20px 0", marginBottom:16, background:`linear-gradient(180deg,${C.nDark},${C.navy})` }}>
          <div style={{ display:"flex", justifyContent:"center", alignItems:"flex-end", gap:12, paddingBottom:0 }}>
            {podium.map(([s,medal,h],i)=>(
              <div key={s.id} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6 }}>
                <div style={{ fontSize:22 }}>{medal}</div>
                <AvatarDisplay name={s.name} photo={s.id===1?myPhoto:null} size={50} ring={s.rank===1} />
                <div style={{ fontSize:12, fontWeight:800, color:"#fff", textAlign:"center", maxWidth:90 }}>{s.name.split(" ")[0]}</div>
                <div style={{ fontSize:11, color:"rgba(255,255,255,.5)" }}>{s.points} pts</div>
                <div style={{ width:90, height:h, background:i===1?"linear-gradient(180deg,#c9a43e,#b8922d)":"rgba(255,255,255,.1)", borderRadius:"8px 8px 0 0", display:"flex", alignItems:"flex-end", justifyContent:"center", paddingBottom:6 }}>
                  <span style={{ fontWeight:900, fontSize:18, color:i===1?C.nDark:"rgba(255,255,255,.6)" }}>#{s.rank}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={crd}>
          {filtered.length===0 && <div style={{ padding:32, textAlign:"center", color:C.muted }}>No results found</div>}
          {filtered.map(s=>(
            <div key={s.id} style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 18px", borderBottom:`1px solid ${C.border}`, background:s.id===1?(dark?"rgba(201,164,62,.08)":"rgba(201,164,62,.05)"):"none", transition:"background .2s" }}>
              <div style={{ width:32, textAlign:"center", fontWeight:800, fontSize:15, color:s.rank<=3?C.gold:C.muted }}>
                {s.rank<=3?["🥇","🥈","🥉"][s.rank-1]:`#${s.rank}`}
              </div>
              <AvatarDisplay name={s.name} photo={s.id===1?myPhoto:null} size={38} />
              <div style={{ flex:1 }}>
                <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.name}{s.id===1&&<span style={{ color:C.gold, marginLeft:6, fontSize:11, fontWeight:800 }}>← {lang==="ar"?"أنت":"You"}</span>}</div>
                <div style={{ fontSize:11, color:C.muted }}>{s.college.replace("Faculty of ","")}</div>
              </div>
              <div style={{ textAlign:"right", marginRight:8 }}>
                <div style={{ fontSize:14, fontWeight:800, color:C.navy }}>{s.points}</div>
                <div style={{ fontSize:10, color:C.muted }}>pts</div>
              </div>
              <div style={{ width:80 }}>
                <div style={{ height:5, background:C.border, borderRadius:3, overflow:"hidden" }}>
                  <div style={{ height:"100%", background:`linear-gradient(90deg,${C.gold},${C.navy})`, borderRadius:3, width:`${(s.points/1580*100).toFixed(0)}%`, transition:"width .5s" }}></div>
                </div>
              </div>
              {s.id!==1 && friends.includes(s.id) && (
                <button onClick={()=>openChat(s.id)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"4px 10px", fontSize:11, cursor:"pointer", color:C.muted }}>💬</button>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop:14, ...crd, padding:16, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div style={{ fontSize:13, color:C.muted }}>{lang==="ar"?"مركزك في الترتيب:":"Your position:"} <span style={{ fontWeight:800, color:C.navy }}>#{ME.rank}</span> {lang==="ar"?"من":"of"} {all.length}</div>
          <div style={{ fontSize:13, color:C.muted }}>{lang==="ar"?"نقاطك:":"Your points:"} <span style={{ fontWeight:800, color:C.gold }}>{ME.points}</span></div>
        </div>
      </div>
    );
  };

  // ── STUDY ROOMS ───────────────────────────────────────────────────────────
  const renderRooms = () => (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🧑‍💻 Study Rooms</h2>
        <button onClick={()=>setShowNewRoom(true)} style={btnP}>+ New Room</button>
      </div>
      {showNewRoom && (
        <div style={{ ...crd, padding:20, marginBottom:18, border:`2px solid ${C.gold}` }}>
          <h3 style={{ fontSize:15, fontWeight:800, color:C.navy, margin:"0 0 14px" }}>Create Study Room</h3>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr auto", gap:10, alignItems:"end" }}>
            <div><label style={{ display:"block", fontSize:11, fontWeight:700, color:C.muted, marginBottom:4, textTransform:"uppercase" }}>Room Name *</label><input value={newRoom.name} onChange={e=>setNewRoom(r=>({...r,name:e.target.value}))} style={inp} /></div>
            <div><label style={{ display:"block", fontSize:11, fontWeight:700, color:C.muted, marginBottom:4, textTransform:"uppercase" }}>Subject</label><input value={newRoom.subject} onChange={e=>setNewRoom(r=>({...r,subject:e.target.value}))} style={inp} /></div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={()=>{ if(!newRoom.name){push("Enter a room name","error");return;} setRooms(rs=>[...rs,{id:Date.now(),name:newRoom.name,subject:newRoom.subject,members:[ME.name],capacity:10,online:1,joined:true}]); setNewRoom({name:"",subject:"",capacity:10}); setShowNewRoom(false); push("Room created! 🧑‍💻","success"); }} style={btnP}>Create</button>
              <button onClick={()=>setShowNewRoom(false)} style={{ background:C.input, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"8px 14px", fontSize:13, cursor:"pointer" }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14 }}>
        {rooms.map(r=>(
          <div key={r.id} style={{ ...crd, padding:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
              <div><div style={{ fontSize:15, fontWeight:800, color:C.text, marginBottom:5 }}>{r.name}</div><Tag label={r.subject} /></div>
              {r.joined && <Tag label="Joined" />}
            </div>
            <div style={{ display:"flex", gap:16, marginBottom:10 }}><span style={{ fontSize:13, color:C.muted }}>👥 {r.members.length}/{r.capacity}</span><span style={{ fontSize:13, color:"#2e7d32" }}>● {r.online} online</span></div>
            <div style={{ display:"flex", gap:4, marginBottom:14 }}>
              {r.members.slice(0,4).map(m=><AvatarDisplay key={m} name={m} photo={m===ME.name?myPhoto:null} size={28} />)}
              {r.members.length>4 && <div style={{ width:28, height:28, borderRadius:"50%", background:C.input, display:"flex", alignItems:"center", justifyContent:"center", fontSize:11, fontWeight:700, color:C.muted }}>+{r.members.length-4}</div>}
            </div>
            <button onClick={()=>{ if(r.joined){setRooms(rs=>rs.map(x=>x.id===r.id?{...x,joined:false,online:Math.max(0,x.online-1)}:x));push("Left room","");}else{setRooms(rs=>rs.map(x=>x.id===r.id?{...x,joined:true,online:x.online+1}:x));push("Joined room! 📚","success");} }}
              style={r.joined?{background:"#ffebee",color:"#c62828",border:"1px solid #ffcdd2",borderRadius:10,padding:"8px",fontSize:13,fontWeight:700,cursor:"pointer",width:"100%"}:{...btnP,width:"100%",padding:"8px",display:"block",textAlign:"center"}}>
              {r.joined?"Leave Room":"Join Room"}
            </button>
          </div>
        ))}
      </div>
    </div>
  );

  // ── ANNOUNCEMENTS ─────────────────────────────────────────────────────────
  const renderAnnouncements = () => (
    <div>
      <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:18 }}>📢 Announcements</h2>
      <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {notices.map(a=>{
          const col={urgent:"#c62828",high:C.gold,normal:C.navy}[a.priority];
          return (
            <div key={a.id} style={{ ...crd, padding:20, borderLeft:`4px solid ${col}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:8 }}>
                <div style={{ fontSize:15, fontWeight:800, color:C.text }}>{a.title}</div>
                <div style={{ display:"flex", gap:8, alignItems:"center" }}><Tag label={a.priority} bg={col+"22"} fg={col}/><span style={{ fontSize:11, color:C.muted }}>{a.date}</span></div>
              </div>
              <p style={{ fontSize:13, color:C.muted, lineHeight:1.6, margin:0 }}>{a.body}</p>
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── EVENTS ────────────────────────────────────────────────────────────────
  const renderEvents = () => (
    <div>
      <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:18 }}>📅 Events</h2>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))", gap:14 }}>
        {events.map(e=>(
          <div key={e.id} style={{ ...crd, padding:18 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:10 }}>
              <div><div style={{ fontSize:15, fontWeight:800, color:C.text, marginBottom:4 }}>{e.title}</div><div style={{ fontSize:12, color:C.muted }}>📅 {e.date} · {e.time}</div><div style={{ fontSize:12, color:C.muted }}>📍 {e.location}</div></div>
              {e.rsvp==="attending" && <Tag label="Going ✓" />}
            </div>
            <p style={{ fontSize:13, color:C.muted, lineHeight:1.5, margin:"0 0 14px" }}>{e.desc}</p>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <span style={{ fontSize:12, color:C.muted }}>👥 {e.attending} attending</span>
              <button onClick={()=>{setEvents(es=>es.map(x=>x.id===e.id?{...x,rsvp:x.rsvp==="attending"?null:"attending",attending:x.rsvp==="attending"?x.attending-1:x.attending+1}:x));push(e.rsvp==="attending"?"RSVP cancelled":"RSVP confirmed! 📅","success");}}
                style={{ ...btnP, padding:"6px 14px", fontSize:12, background:e.rsvp==="attending"?"#ffebee":"", color:e.rsvp==="attending"?"#c62828":"#fff", border:e.rsvp==="attending"?"1px solid #ffcdd2":"none" }}>
                {e.rsvp==="attending"?"Cancel RSVP":"RSVP"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  // ── NOTIFICATIONS ─────────────────────────────────────────────────────────
  const renderNotifications = () => (
    <div style={{ maxWidth:640, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
        <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🔔 Notifications</h2>
        <button onClick={()=>setNotifs(n=>n.map(x=>({...x,read:true})))} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:9, padding:"6px 14px", fontSize:12, color:C.muted, cursor:"pointer" }}>Mark all read</button>
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
        {notifs.map(n=>(
          <div key={n.id} onClick={()=>setNotifs(ns=>ns.map(x=>x.id===n.id?{...x,read:true}:x))} style={{ ...crd, padding:"12px 16px", display:"flex", gap:12, alignItems:"center", cursor:"pointer", borderLeft:`3px solid ${n.read?C.border:C.gold}`, opacity:n.read?.7:1 }}>
            <div style={{ width:40, height:40, borderRadius:12, background:n.read?C.input:`linear-gradient(135deg,${C.navy}22,${C.gold}22)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>{n.icon}</div>
            <div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:n.read?500:700, color:C.text }}>{n.text}</div><div style={{ fontSize:11, color:C.muted, marginTop:3 }}>{n.time}</div></div>
            {!n.read && <div style={{ width:8, height:8, borderRadius:"50%", background:C.gold, flexShrink:0 }}></div>}
          </div>
        ))}
      </div>
    </div>
  );

  // ── PROFILE ───────────────────────────────────────────────────────────────
  const renderProfile = () => (
    <div style={{ maxWidth:700, margin:"0 auto" }}>
      <div style={{ ...crd, padding:28, marginBottom:16, background:`linear-gradient(135deg,${C.nDark},${C.navy})`, position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-40, right:-40, width:200, height:200, borderRadius:"50%", background:"rgba(201,164,62,.08)" }}></div>
        <div style={{ display:"flex", gap:20, alignItems:"center", position:"relative" }}>
          <AvatarDisplay name={ME.name} photo={myPhoto} size={80} ring />
          <div>
            <div style={{ fontSize:22, fontWeight:900, color:"#fff" }}>{ME.name}</div>
            <div style={{ fontSize:13, color:"rgba(255,255,255,.6)", marginTop:4 }}>{ME.sid}</div>
            <div style={{ fontSize:13, color:"rgba(255,255,255,.6)" }}>{ME.college} · Year {ME.year}</div>
            <div style={{ display:"flex", gap:8, marginTop:10 }}>
              <Tag label={`GPA ${ME.gpa}`} bg="rgba(201,164,62,.2)" fg={C.gold} />
              <Tag label={`Rank #${ME.rank}`} bg="rgba(255,255,255,.1)" fg="#fff" />
              <Tag label={`${ME.points} pts`} bg="rgba(255,255,255,.1)" fg="#fff" />
            </div>
          </div>
        </div>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
        <div style={{ ...crd, padding:20 }}>
          <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:"0 0 12px" }}>👤 About Me</h3>
          {editingBio ? (
            <div>
              <textarea value={bio} onChange={e=>setBio(e.target.value)} rows={4} style={{ ...inp, resize:"vertical", marginBottom:10 }} />
              <div style={{ display:"flex", gap:8 }}>
                <button onClick={()=>{setEditingBio(false);push("Bio updated! ✅","success");}} style={btnP}>Save</button>
                <button onClick={()=>setEditingBio(false)} style={{ background:C.input, color:C.muted, border:"none", borderRadius:9, padding:"7px 14px", fontSize:13, cursor:"pointer" }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ fontSize:13, color:C.muted, lineHeight:1.6, margin:"0 0 12px" }}>{bio}</p>
              <button onClick={()=>setEditingBio(true)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:9, padding:"6px 14px", fontSize:12, color:C.muted, cursor:"pointer" }}>✏️ Edit Bio</button>
            </div>
          )}
        </div>
        <div style={{ ...crd, padding:20 }}>
          <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:"0 0 12px" }}>📊 Stats</h3>
          {[["📝","Assignments",asgns.length],["👥","Friends",friends.length],["🏠","Posts",posts.filter(p=>p.author_id===1).length],["📡","Channels",subscribedChs.length],["🧑‍💻","Study Rooms",rooms.filter(r=>r.joined).length]].map(([icon,label,val])=>(
            <div key={label} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
              <span style={{ fontSize:13, color:C.muted }}>{icon} {label}</span>
              <span style={{ fontSize:14, fontWeight:800, color:C.navy }}>{val}</span>
            </div>
          ))}
        </div>
        <div style={{ ...crd, padding:20 }}>
          <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:"0 0 12px" }}>📧 Contact Info</h3>
          {[["Email", currentUser.email||ME.email], ["Phone", currentUser.phone||"—"], ["Student ID", ME.sid], ["College", ME.college], ["Department", ME.department], ["Year", "Year "+ME.year]].map(([k,v])=>(
            <div key={k} style={{ marginBottom:10 }}>
              <div style={{ fontSize:10, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.4, marginBottom:2 }}>{k}</div>
              <div style={{ fontSize:13, color:C.text, fontWeight:600 }}>{v}</div>
            </div>
          ))}
        </div>
        <div style={{ ...crd, padding:20 }}>
          <h3 style={{ fontSize:14, fontWeight:800, color:C.navy, margin:"0 0 12px" }}>🖼 Profile Photo</h3>
          <div style={{ display:"flex", gap:12, flexWrap:"wrap", marginBottom:14 }}>
            {["🎓","📚","🌙","💻","✍️","🕌","🌟","🦁"].map(e=>(
              <button key={e} onClick={()=>{setMyPhoto("emoji:"+e);push("Avatar updated! ✅","success");}} style={{ width:48, height:48, borderRadius:12, background:myPhoto==="emoji:"+e?`linear-gradient(135deg,${C.navy},${C.nDark})`:`${C.navy}22`, border:myPhoto==="emoji:"+e?`2px solid ${C.gold}`:"none", fontSize:24, cursor:"pointer", transition:"all .2s" }}>{e}</button>
            ))}
            <button onClick={()=>{setMyPhoto(null);push("Photo removed","");}} style={{ width:48, height:48, borderRadius:12, background:C.input, border:`1px solid ${C.border}`, fontSize:11, color:C.muted, cursor:"pointer" }}>None</button>
          </div>
          <label style={{ display:"flex", alignItems:"center", gap:8, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, color:"#fff", borderRadius:10, padding:"9px 16px", cursor:"pointer", fontSize:13, fontWeight:700, width:"fit-content" }}>
            📷 Upload from device
            <input type="file" accept="image/*" style={{ display:"none" }} onChange={e=>{
              const file = e.target.files?.[0];
              if (!file) return;
              const reader = new FileReader();
              reader.onload = ev => { setMyPhoto(ev.target.result); push("Photo uploaded! 📸","success"); };
              reader.readAsDataURL(file);
            }} />
          </label>
        </div>
      </div>
    </div>
  );

  // ── NEW: GRADES ───────────────────────────────────────────────────────────
  const renderGrades = () => {
    const current = GRADES_DATA.filter(g=>g.status==="current");
    const completed = GRADES_DATA.filter(g=>g.status==="completed");
    const display = gradeTab==="current"?current:completed;
    const gpaCalc = current.reduce((a,g)=>a+g.points*g.credits,0)/current.reduce((a,g)=>a+g.credits,0);
    const letterColor = {A:"#2e7d32","A-":"#388e3c","B+":"#1565c0","B":"#1976d2","C":"#c9a43e"};
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:18 }}>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🎓 Grades</h2>
          <div style={{ textAlign:"right" }}><div style={{ fontSize:28, fontWeight:900, color:C.navy }}>{gpaCalc.toFixed(2)}</div><div style={{ fontSize:11, color:C.muted }}>Semester GPA</div></div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:10, marginBottom:18 }}>
          {[{label:"Semester GPA",val:gpaCalc.toFixed(2),icon:"🎓"},{label:"Credit Hours",val:current.reduce((a,g)=>a+g.credits,0),icon:"📚"},{label:"Rank",val:`#${ME.rank}`,icon:"🏆"},{label:"Cumulative GPA",val:ME.gpa,icon:"📊"}].map((k,i)=>(
            <div key={i} style={{ ...crd, padding:16, textAlign:"center" }}>
              <div style={{ fontSize:22, marginBottom:6 }}>{k.icon}</div>
              <div style={{ fontSize:22, fontWeight:900, color:C.navy }}>{k.val}</div>
              <div style={{ fontSize:11, color:C.muted, marginTop:4 }}>{k.label}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"flex", gap:4, marginBottom:14, background:C.card2, borderRadius:12, padding:4, width:"fit-content", border:`1px solid ${C.border}` }}>
          {[{k:"current",l:"Current Semester"},{k:"completed",l:"Previous Semester"}].map(t=><button key={t.k} onClick={()=>setGradeTab(t.k)} style={{ background:gradeTab===t.k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none", color:gradeTab===t.k?"#fff":C.muted, border:"none", borderRadius:9, padding:"7px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>{t.l}</button>)}
        </div>
        <div style={{ ...crd, overflow:"hidden" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead><tr style={{ background:dark?"rgba(255,255,255,.03)":"#f8faf8" }}>{["Course","Credits","Grade","Points","Progress"].map(h=><th key={h} style={{ padding:"10px 18px", textAlign:"left", fontSize:10, fontWeight:800, color:C.muted, textTransform:"uppercase", letterSpacing:.4, borderBottom:`1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>{display.map((g,i)=>(
              <tr key={i} style={{ borderBottom:`1px solid ${C.border}` }}>
                <td style={{ padding:"12px 18px", fontWeight:700, color:C.text }}>{g.course}</td>
                <td style={{ padding:"12px 18px", color:C.muted, textAlign:"center" }}>{g.credits} cr.</td>
                <td style={{ padding:"12px 18px" }}><span style={{ background:(letterColor[g.grade]||"#888")+"22", color:letterColor[g.grade]||"#888", fontWeight:800, padding:"3px 10px", borderRadius:8 }}>{g.grade}</span></td>
                <td style={{ padding:"12px 18px", fontWeight:700, color:C.navy }}>{g.points.toFixed(1)}</td>
                <td style={{ padding:"12px 18px" }}><div style={{ height:6, background:C.border, borderRadius:3, overflow:"hidden", width:80 }}><div style={{ height:"100%", width:`${(g.points/4)*100}%`, background:`linear-gradient(90deg,${C.navy},${C.gold})`, borderRadius:3 }}></div></div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    );
  };

  // ── NEW: LIBRARY ──────────────────────────────────────────────────────────
  const renderLibrary = () => {
    const filtered = libBooks.filter(b=>b.title.toLowerCase().includes(libSearch.toLowerCase())||b.author.toLowerCase().includes(libSearch.toLowerCase())||b.subject.toLowerCase().includes(libSearch.toLowerCase()));
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-end", marginBottom:18 }}>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>📚 Library</h2>
          <input value={libSearch} onChange={e=>setLibSearch(e.target.value)} placeholder="Search books, authors…" style={{ ...inp, width:240 }} />
        </div>
        {/* Borrowed books */}
        {libBooks.filter(b=>b.borrowed).length>0 && (
          <div style={{ ...crd, padding:18, marginBottom:18, borderLeft:`4px solid ${C.gold}` }}>
            <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:10 }}>📖 Currently Borrowed</div>
            {libBooks.filter(b=>b.borrowed).map(b=>(
              <div key={b.id} style={{ display:"flex", alignItems:"center", gap:14, padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ width:40, height:52, borderRadius:6, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>📕</div>
                <div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{b.title}</div><div style={{ fontSize:11, color:C.muted }}>{b.author}</div></div>
                <div style={{ textAlign:"right" }}><div style={{ fontSize:11, color:"#c62828", fontWeight:700 }}>Due: {b.due}</div><button onClick={()=>{setLibBooks(bs=>bs.map(x=>x.id===b.id?{...x,borrowed:false,available:x.available+1}:x));push("Book returned!","success");}} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"4px 10px", fontSize:11, cursor:"pointer", color:C.muted, marginTop:4 }}>Return</button></div>
              </div>
            ))}
          </div>
        )}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:12 }}>
          {filtered.map(b=>(
            <div key={b.id} style={{ ...crd, padding:16 }}>
              <div style={{ display:"flex", gap:12, marginBottom:12 }}>
                <div style={{ width:44, height:58, borderRadius:8, background:`linear-gradient(135deg,${scol(b.title)},${scol(b.title+"x")})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>📗</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:800, color:C.text, lineHeight:1.3, marginBottom:4 }}>{b.title}</div>
                  <div style={{ fontSize:11, color:C.muted }}>{b.author}</div>
                  <Tag label={b.subject} bg={C.navy+"22"} fg={C.navy} />
                </div>
              </div>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                <span style={{ fontSize:12, color:b.available>0?"#2e7d32":"#c62828", fontWeight:700 }}>{b.available>0?`${b.available} available`:"Unavailable"}</span>
                <button onClick={()=>{if(b.available===0||b.borrowed){push("Cannot borrow","error");return;} setLibBooks(bs=>bs.map(x=>x.id===b.id?{...x,borrowed:true,available:x.available-1,due:"2026-03-"+String(20+b.id)}:x));push(`${b.title} borrowed! 📚`,"success");}}
                  disabled={b.available===0||b.borrowed} style={{ ...btnP, padding:"6px 12px", fontSize:12, opacity:b.available===0||b.borrowed?.5:1, cursor:b.available===0||b.borrowed?"not-allowed":"pointer" }}>
                  {b.borrowed?"Borrowed":"Borrow"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── NEW: FINANCE ──────────────────────────────────────────────────────────
  const renderFinance = () => {
    const balance = finTuition - finPaid;
    const pct = (finPaid/finTuition*100).toFixed(0);
    return (
      <div>
        <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:18 }}>💰 Financial Account</h2>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(3,1fr)", gap:14, marginBottom:18 }}>
          {[{label:"Total Tuition",val:`SDG ${finTuition.toLocaleString()}`,icon:"📋",color:C.navy},{label:"Paid",val:`SDG ${finPaid.toLocaleString()}`,icon:"✅",color:"#2e7d32"},{label:"Outstanding Balance",val:`SDG ${balance.toLocaleString()}`,icon:balance>0?"⚠️":"🎉",color:balance>0?"#c62828":"#2e7d32"}].map((k,i)=>(
            <div key={i} style={{ ...crd, padding:20 }}>
              <div style={{ fontSize:24, marginBottom:8 }}>{k.icon}</div>
              <div style={{ fontSize:22, fontWeight:900, color:k.color }}>{k.val}</div>
              <div style={{ fontSize:12, color:C.muted, marginTop:4 }}>{k.label}</div>
            </div>
          ))}
        </div>
        <div style={{ ...crd, padding:20, marginBottom:18 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10, flexWrap:"wrap", gap:10 }}>
            <div style={{ fontSize:14, fontWeight:800, color:C.navy }}>Payment Progress — {pct}%</div>
            {balance > 0 && <button onClick={()=>setShowPayModal(true)} style={{ ...btnP, padding:"8px 20px", fontSize:13 }}>💳 Pay Now</button>}
            {balance <= 0 && <span style={{ fontSize:13, fontWeight:700, color:"#2e7d32" }}>✅ Fully Paid!</span>}
          </div>
          <div style={{ height:12, background:C.border, borderRadius:6, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${Math.min(100,pct)}%`, background:`linear-gradient(90deg,${C.navy},${C.gold})`, borderRadius:6, transition:"width .6s" }}></div>
          </div>
          <div style={{ display:"flex", justifyContent:"space-between", marginTop:6 }}>
            <div style={{ fontSize:11, color:C.muted }}>SDG 0</div>
            <div style={{ fontSize:11, color:C.muted }}>SDG {finTuition.toLocaleString()}</div>
          </div>
          {FINANCIAL_DATA.scholarshipAmt>0 && (
            <div style={{ marginTop:14, background:dark?"rgba(26,92,42,.1)":"#f0f9f0", borderRadius:10, padding:"10px 14px", display:"flex", gap:10, alignItems:"center" }}>
              <span style={{ fontSize:20 }}>🏅</span>
              <div><div style={{ fontSize:13, fontWeight:700, color:C.navy }}>Merit Scholarship Applied</div><div style={{ fontSize:12, color:C.muted }}>SDG {FINANCIAL_DATA.scholarshipAmt.toLocaleString()} discount applied to your account</div></div>
            </div>
          )}
        </div>

        {/* Pay Now Modal */}
        {showPayModal && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", zIndex:800, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
            <div style={{ background:C.card, borderRadius:20, padding:28, width:"100%", maxWidth:420, boxShadow:"0 24px 60px rgba(0,0,0,.4)" }}>
              <div style={{ fontSize:18, fontWeight:900, color:C.text, marginBottom:20 }}>💳 Make a Payment</div>
              <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:C.muted, display:"block", marginBottom:5, textTransform:"uppercase", letterSpacing:.4 }}>Amount (SDG)</label>
                  <input type="number" value={payAmount} onChange={e=>setPayAmount(e.target.value)} placeholder={`Max: ${balance.toLocaleString()}`} style={{ ...inp }} min="1" max={balance} />
                  <div style={{ display:"flex", gap:8, marginTop:8 }}>
                    {[balance, Math.round(balance/2), 10000, 5000].filter((v,i,a)=>v>0&&a.indexOf(v)===i).slice(0,4).map(v=>(
                      <button key={v} onClick={()=>setPayAmount(String(v))} style={{ flex:1, padding:"5px 4px", background:C.card2, border:`1px solid ${C.border}`, borderRadius:8, fontSize:11, cursor:"pointer", color:C.muted, fontWeight:700 }}>SDG {v.toLocaleString()}</button>
                    ))}
                  </div>
                </div>
                <div>
                  <label style={{ fontSize:12, fontWeight:700, color:C.muted, display:"block", marginBottom:8, textTransform:"uppercase", letterSpacing:.4 }}>Payment Method</label>
                  <div style={{ display:"flex", gap:8 }}>
                    {[["bank","🏦 Bank Transfer"],["mobile","📱 Mobile Money"],["card","💳 Debit Card"]].map(([v,l])=>(
                      <button key={v} onClick={()=>setPayMethod(v)} style={{ flex:1, padding:"8px 4px", background:payMethod===v?`linear-gradient(135deg,${C.navy},${C.nDark})`:C.card2, color:payMethod===v?"#fff":C.muted, border:`1px solid ${payMethod===v?C.navy:C.border}`, borderRadius:10, fontSize:11, cursor:"pointer", fontWeight:700 }}>{l}</button>
                    ))}
                  </div>
                </div>
                <div style={{ background:dark?"rgba(26,92,42,.08)":"#f0f9f0", borderRadius:12, padding:"12px 16px", fontSize:12, color:C.muted, lineHeight:1.6 }}>
                  🔒 Payments are processed securely. A receipt will be added to your transaction history.
                </div>
                <div style={{ display:"flex", gap:10 }}>
                  <button onClick={()=>{
                    const amt = parseFloat(payAmount);
                    if (!amt || amt<=0 || amt>balance) { push("Enter a valid amount","error"); return; }
                    const newPaid = finPaid + amt;
                    setFinPaid(newPaid);
                    setFinTxns(ts=>[{ id:Date.now(), date:new Date().toISOString().slice(0,10), desc:`Payment via ${payMethod==="bank"?"Bank Transfer":payMethod==="mobile"?"Mobile Money":"Debit Card"}`, amount:amt, type:"payment" }, ...ts]);
                    setShowPayModal(false); setPayAmount("");
                    push(`SDG ${amt.toLocaleString()} paid successfully! ✅`,"success");
                    setNotifs(ns=>[{id:Date.now(),icon:"💳",text:`Payment of SDG ${amt.toLocaleString()} confirmed`,time:"just now",read:false},...ns]);
                  }} style={{ ...btnP, flex:1, padding:"11px" }}>✅ Confirm Payment</button>
                  <button onClick={()=>setShowPayModal(false)} style={{ flex:1, padding:"11px", background:C.card2, color:C.muted, border:`1px solid ${C.border}`, borderRadius:12, fontSize:14, fontWeight:700, cursor:"pointer" }}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ ...crd, overflow:"hidden" }}>
          <div style={{ padding:"14px 18px", borderBottom:`1px solid ${C.border}` }}><div style={{ fontSize:14, fontWeight:800, color:C.navy }}>Transaction History</div></div>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
            <thead><tr style={{ background:dark?"rgba(255,255,255,.03)":"#f8faf8" }}>{["Date","Description","Amount"].map(h=><th key={h} style={{ padding:"10px 18px", textAlign:"left", fontSize:10, fontWeight:800, color:C.muted, textTransform:"uppercase", letterSpacing:.4, borderBottom:`1px solid ${C.border}` }}>{h}</th>)}</tr></thead>
            <tbody>{finTxns.map(t=>(
              <tr key={t.id} style={{ borderBottom:`1px solid ${C.border}` }}>
                <td style={{ padding:"10px 18px", color:C.muted, fontSize:12 }}>{t.date}</td>
                <td style={{ padding:"10px 18px", color:C.text, fontWeight:600 }}>{t.desc}</td>
                <td style={{ padding:"10px 18px", fontWeight:800, color:t.type==="charge"?"#c62828":"#2e7d32" }}>{t.type==="charge"?"-":"+"}SDG {Math.abs(t.amount).toLocaleString()}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </div>
    );
  };

  useEffect(() => { tutorEnd.current?.scrollIntoView({behavior:"smooth"}); }, [tutorMsgs]);

  // ── PRAYER TIMES ──────────────────────────────────────────────────────────
  const renderPrayer = () => {
    const now = new Date();
    const nowMins = now.getHours()*60 + now.getMinutes();
    const toMins = t => { const [h,m]=t.split(":").map(Number); return h*60+m; };
    const nextIdx = PRAYER_TIMES.findIndex(p=>toMins(p.time)>nowMins);
    const currentIdx = nextIdx===-1?4:Math.max(0,nextIdx-1);
    return (
      <div style={{ maxWidth:680, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
          <div>
            <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🕌 Prayer Times</h2>
            <p style={{ color:C.muted, fontSize:13, margin:"4px 0 0", fontFamily:"'Amiri',serif" }}>Khartoum, Sudan — بسم الله الرحمن الرحيم</p>
          </div>
          <div style={{ textAlign:"right" }}>
            <div style={{ fontSize:28, fontWeight:900, color:C.navy, fontFamily:"'Amiri',serif" }}>{now.toLocaleDateString("ar-SD",{weekday:"long"})}</div>
            <div style={{ fontSize:12, color:C.muted }}>{now.toLocaleDateString("en-GB",{day:"numeric",month:"long",year:"numeric"})}</div>
          </div>
        </div>

        {/* Next prayer banner */}
        {nextIdx!==-1 && (
          <div style={{ background:`linear-gradient(135deg,${C.nDark},${C.navy})`, borderRadius:18, padding:"22px 26px", marginBottom:20, position:"relative", overflow:"hidden" }}>
            <div style={{ position:"absolute", top:-30, right:-30, width:140, height:140, borderRadius:"50%", background:"rgba(201,164,62,.1)" }}></div>
            <div style={{ position:"absolute", bottom:-20, left:10, fontSize:80, opacity:.08 }}>🌙</div>
            <div style={{ position:"relative" }}>
              <div style={{ fontSize:12, color:"rgba(255,255,255,.5)", fontWeight:700, textTransform:"uppercase", letterSpacing:1, marginBottom:6 }}>Next Prayer</div>
              <div style={{ display:"flex", alignItems:"center", gap:16 }}>
                <div style={{ fontSize:40 }}>{PRAYER_TIMES[nextIdx].icon}</div>
                <div>
                  <div style={{ fontSize:26, fontWeight:900, color:"#fff" }}>{PRAYER_TIMES[nextIdx].name}</div>
                  <div style={{ fontSize:14, color:"rgba(255,255,255,.6)", fontFamily:"'Amiri',serif" }}>{PRAYER_TIMES[nextIdx].arabic}</div>
                </div>
                <div style={{ marginLeft:"auto", textAlign:"right" }}>
                  <div style={{ fontSize:38, fontWeight:900, color:C.gold, fontVariantNumeric:"tabular-nums" }}>{PRAYER_TIMES[nextIdx].time}</div>
                  <div style={{ fontSize:12, color:"rgba(255,255,255,.4)" }}>
                    {Math.floor((toMins(PRAYER_TIMES[nextIdx].time)-nowMins)/60)}h {(toMins(PRAYER_TIMES[nextIdx].time)-nowMins)%60}m away
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* All prayers */}
        <div style={{ ...crd, overflow:"hidden", marginBottom:20 }}>
          {PRAYER_TIMES.map((p,i)=>{
            const isPast = toMins(p.time)<nowMins;
            const isCurrent = i===currentIdx && nextIdx!==-1;
            return (
              <div key={p.name} style={{ display:"flex", alignItems:"center", gap:16, padding:"16px 22px", borderBottom:i<4?`1px solid ${C.border}`:"none", background:isCurrent?(dark?"rgba(201,164,62,.1)":"rgba(201,164,62,.06)"):"transparent", transition:"background .2s" }}>
                <div style={{ width:44, height:44, borderRadius:14, background:isCurrent?`linear-gradient(135deg,${C.gold},#b8922d)`:(dark?"rgba(255,255,255,.05)":"rgba(26,92,42,.05)"), display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0 }}>{p.icon}</div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:15, fontWeight:isCurrent?900:700, color:isCurrent?C.gold:C.text }}>{p.name}</div>
                  <div style={{ fontSize:12, color:C.muted, fontFamily:"'Amiri',serif" }}>{p.arabic}</div>
                </div>
                <div style={{ textAlign:"right" }}>
                  <div style={{ fontSize:20, fontWeight:900, color:isPast?C.muted:C.navy, fontVariantNumeric:"tabular-nums", textDecoration:isPast?"line-through":"none", opacity:isPast?.6:1 }}>{p.time}</div>
                  {isCurrent && <div style={{ fontSize:10, color:C.gold, fontWeight:800, textTransform:"uppercase", marginTop:2 }}>Current</div>}
                  {isPast && i!==currentIdx && <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>Passed</div>}
                </div>
              </div>
            );
          })}
        </div>

        {/* Islamic calendar note */}
        <div style={{ ...crd, padding:20, background:dark?undefined:`linear-gradient(135deg,#f8f5ec,#faf7f0)` }}>
          <div style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
            <div style={{ fontSize:32 }}>📿</div>
            <div>
              <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:6 }}>Daily Dhikr Reminder</div>
              <div style={{ fontSize:13, color:C.muted, lineHeight:1.7, fontFamily:"'Amiri',serif", textAlign:"right", direction:"rtl", marginBottom:10 }}>
                سُبْحَانَ اللَّهِ — الْحَمْدُ لِلَّهِ — اللَّهُ أَكْبَرُ
              </div>
              <div style={{ fontSize:12, color:C.muted }}>Recite 33 times each after every prayer.</div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // ── AI TUTOR ──────────────────────────────────────────────────────────────
  const sendTutorMsg = async () => {
    if (!tutorInput.trim() || tutorLoading) return;
    const userMsg = tutorInput.trim();
    setTutorInput("");
    setTutorMsgs(m => [...m, { role:"user", text:userMsg }]);
    setTutorLoading(true);
    const kaidoSystem = `أنت كيدو (Kaido) — المساعد الذكي لبوابة جامعة أم درمان الإسلامية (OIU). أنت تتحدث اللغات التالية بطلاقة تامة:
- العربية السودانية الدارجة (Sudanese colloquial Arabic) — هذه لغتك الأساسية مع الطلاب السودانيين
- الفصحى (Modern Standard Arabic)
- English (British and American)
- Français
- Deutsch
- Türkçe
- Русский
- Español
- 中文 (Mandarin)

قواعد مهمة:
1. اكتشف لغة المستخدم تلقائياً وردّ بنفس اللغة
2. إذا كان الطالب يكتب بالعربية السودانية (مثل: "شنو، كيف، ليه، انت، ما عارف") فردّ بالعامية السودانية بشكل طبيعي
3. يمكنك كتابة كود برمجي بشكل احترافي مع شرح واضح
4. أنت مساعد أكاديمي لطلاب OIU — تساعد في: الدراسة، البرمجة، الفقه، اللغة العربية، الرياضيات، وأي موضوع آخر
5. شخصيتك ودية، ذكية، وتحب المزاح بشكل لائق
6. الطالب الحالي: ${ME.name}، السنة ${ME.year}، كلية: ${ME.college}، القسم: ${ME.department}، المادة المختارة: ${tutorSubject}
7. إذا طُلب منك كود برمجي، اكتبه داخل \`\`\`code blocks\`\`\` واضحة
8. كن مختصراً ومفيداً — لا تطوّل الردود بدون داعٍ`;

    try {
      const history = tutorMsgs.filter(m=>m.role==="user"||m.role==="assistant");
      const reply = await callClaudeAI([...history, { role:"user", text:userMsg }], kaidoSystem);
      setTutorMsgs(m => [...m, { role:"assistant", text:reply }]);
    } catch(e) {
      setTutorMsgs(m => [...m, { role:"assistant", text:"عذراً يا صاحبي 😅 في مشكلة في الاتصال بالذكاء الاصطناعي.\n\nSorry! There was a connection issue with the AI. Please check your internet and try again." }]);
    }
    setTutorLoading(false);
  };

  const renderTutor = () => (
    <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 110px)", maxWidth:820, margin:"0 auto" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14, flexShrink:0 }}>
        <div>
          <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>{t.kaidoTitle}</h2>
          <p style={{ color:C.muted, fontSize:13, margin:"4px 0 0" }}>{t.kaidoSub}</p>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          <select value={tutorSubject} onChange={e=>setTutorSubject(e.target.value)} style={{ ...inp, width:"auto", padding:"7px 12px", fontSize:12 }}>
            {["General","CS201 – Data Structures","CS301 – Algorithms","ISL301 – Fiqh","ARA101 – Arabic Grammar","MATH201 – Linear Algebra","ISL201 – Islamic History"].map(s=><option key={s}>{s}</option>)}
          </select>
          <button onClick={()=>{setTutorMsgs([{ role:"assistant", text:"تم مسح المحادثة! 🧹 Chat cleared! How can I help you?" }]);}} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"7px 12px", fontSize:12, cursor:"pointer", color:C.muted }}>🗑 Clear</button>
        </div>
      </div>

      {/* Quick prompts — multilingual */}
      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap", flexShrink:0 }}>
        {[
          "شرحلي binary search tree بالعربي 🇸🇩",
          "Write me a Python sorting algorithm",
          "ما هو الفرق بين الحلال والحرام في المعاملات؟",
          "Explique-moi la récursivité en français",
          "Give me a DSA practice problem",
          "اشرح AVL rotations بطريقة بسيطة",
        ].map(q=>(
          <button key={q} onClick={()=>setTutorInput(q)} style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:20, padding:"5px 12px", fontSize:11, cursor:"pointer", color:C.muted, whiteSpace:"nowrap" }}>{q}</button>
        ))}
      </div>

      {/* Messages */}
      <div style={{ flex:1, overflowY:"auto", display:"flex", flexDirection:"column", gap:14, padding:"4px 0", minHeight:0 }}>
        {tutorMsgs.map((m,i)=>{
          const isCode = m.text && m.text.includes("```");
          const parts = isCode ? m.text.split(/(```[\s\S]*?```)/g) : [m.text];
          return (
            <div key={i} style={{ display:"flex", gap:12, justifyContent:m.role==="user"?"flex-end":"flex-start" }}>
              {m.role==="assistant" && (
                <div style={{ width:40, height:40, borderRadius:14, background:`linear-gradient(135deg,#1a5c2a,#0f3d1a)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0, boxShadow:"0 2px 10px rgba(15,61,26,.3)" }}>🤖</div>
              )}
              <div style={{ maxWidth:"78%", background:m.role==="user"?`linear-gradient(135deg,${C.navy},${C.nDark})`:(dark?"rgba(255,255,255,.07)":"#fff"), color:m.role==="user"?"#fff":C.text, borderRadius:m.role==="user"?"18px 18px 4px 18px":"4px 18px 18px 18px", padding:"12px 16px", fontSize:14, lineHeight:1.7, border:m.role!=="user"?`1px solid ${C.border}`:"none", boxShadow:m.role!=="user"?(dark?"0 2px 12px rgba(0,0,0,.3)":"0 1px 6px rgba(26,92,42,.07)"):"none" }}>
                {parts.map((part,pi) => {
                  if (part.startsWith("```")) {
                    const code = part.replace(/```\w*\n?/,"").replace(/```$/,"");
                    return <pre key={pi} style={{ background:dark?"#0b1409":"#1e1e1e", color:"#d4edaa", borderRadius:10, padding:"12px 14px", fontSize:12, overflowX:"auto", margin:"8px 0", fontFamily:"'Courier New',monospace", whiteSpace:"pre-wrap" }}>{code}</pre>;
                  }
                  return <span key={pi} style={{ whiteSpace:"pre-wrap" }}>{part}</span>;
                })}
              </div>
              {m.role==="user" && <AvatarDisplay name={ME.name} photo={myPhoto} size={36} />}
            </div>
          );
        })}
        {tutorLoading && (
          <div style={{ display:"flex", gap:12 }}>
            <div style={{ width:40, height:40, borderRadius:14, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>🤖</div>
            <div style={{ background:dark?"rgba(255,255,255,.07)":"#fff", border:`1px solid ${C.border}`, borderRadius:"4px 18px 18px 18px", padding:"14px 18px", display:"flex", gap:5, alignItems:"center" }}>
              <span style={{ fontSize:12, color:C.muted, marginRight:6 }}>كيدو يفكر…</span>
              {[0,1,2].map(i=><div key={i} style={{ width:8, height:8, borderRadius:"50%", background:C.gold, animation:`bounce .9s ${i*.18}s infinite alternate` }}></div>)}
            </div>
          </div>
        )}
        <div ref={tutorEnd} />
      </div>

      {/* Input */}
      <div style={{ display:"flex", gap:10, marginTop:14, flexShrink:0 }}>
        <input value={tutorInput} onChange={e=>setTutorInput(e.target.value)}
          onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendTutorMsg();}}}
          placeholder={t.kaidoPlaceholder}
          style={{ ...inp, flex:1, borderRadius:22, direction:"auto" }} />
        <button onClick={sendTutorMsg} disabled={!tutorInput.trim()||tutorLoading}
          style={{ width:48, height:48, borderRadius:"50%", background:tutorInput.trim()&&!tutorLoading?`linear-gradient(135deg,${C.navy},${C.nDark})`:"#ccc", border:"none", cursor:tutorInput.trim()&&!tutorLoading?"pointer":"not-allowed", color:"#fff", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0, transition:"background .2s" }}>➤</button>
      </div>
      <style>{`@keyframes bounce{from{transform:translateY(0)}to{transform:translateY(-6px)}}`}</style>
    </div>
  );

  // ── EXAM QUIZ ─────────────────────────────────────────────────────────────
  const renderQuiz = () => {
    const questions = QUIZ_BANK[quizCourse] || [];
    const q = questions[quizIdx];
    const resetQuiz = () => { setQuizIdx(0); setQuizSelected(null); setQuizShowExp(false); setQuizScore(0); setQuizDone(false); setQuizAnswered([]); };

    if (quizDone) return (
      <div style={{ maxWidth:580, margin:"0 auto", textAlign:"center" }}>
        <div style={{ ...crd, padding:40 }}>
          <div style={{ fontSize:72, marginBottom:16 }}>{quizScore===questions.length?"🏆":quizScore>=questions.length*0.7?"🎉":"📚"}</div>
          <div style={{ fontSize:32, fontWeight:900, color:C.navy, marginBottom:8 }}>{quizScore}/{questions.length}</div>
          <div style={{ fontSize:16, color:C.muted, marginBottom:24 }}>{quizScore===questions.length?"Perfect score! Mashallah! 🌟":quizScore>=questions.length*0.7?"Great job! Keep it up!":"Keep studying — you've got this!"}</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)", gap:8, marginBottom:28 }}>
            {quizAnswered.map((correct,i)=>(
              <div key={i} style={{ width:"100%", aspectRatio:"1", borderRadius:10, background:correct?"#e8f5e9":"#ffebee", display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>{correct?"✅":"❌"}</div>
            ))}
          </div>
          <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
            <button onClick={resetQuiz} style={btnP}>🔄 Try Again</button>
            <button onClick={()=>{resetQuiz(); setQuizCourse(Object.keys(QUIZ_BANK)[(Object.keys(QUIZ_BANK).indexOf(quizCourse)+1)%Object.keys(QUIZ_BANK).length]);}} style={{ background:C.input, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"8px 18px", fontSize:13, fontWeight:700, cursor:"pointer" }}>Next Course →</button>
          </div>
        </div>
      </div>
    );

    return (
      <div style={{ maxWidth:640, margin:"0 auto" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
          <div>
            <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🧠 Exam Prep Quiz</h2>
            <p style={{ color:C.muted, fontSize:13, margin:"4px 0 0" }}>Test your knowledge before exams</p>
          </div>
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <select value={quizCourse} onChange={e=>{setQuizCourse(e.target.value);resetQuiz();}} style={{ ...inp, width:"auto", padding:"7px 12px", fontSize:12 }}>
              {Object.keys(QUIZ_BANK).map(k=><option key={k}>{k}</option>)}
            </select>
          </div>
        </div>

        {/* Progress bar */}
        <div style={{ ...crd, padding:"14px 18px", marginBottom:16 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
            <span style={{ fontSize:13, fontWeight:700, color:C.muted }}>Question {quizIdx+1} of {questions.length}</span>
            <span style={{ fontSize:13, fontWeight:800, color:C.navy }}>Score: {quizScore}/{quizAnswered.length}</span>
          </div>
          <div style={{ height:6, background:C.border, borderRadius:3, overflow:"hidden" }}>
            <div style={{ height:"100%", width:`${((quizIdx)/questions.length)*100}%`, background:`linear-gradient(90deg,${C.navy},${C.gold})`, borderRadius:3, transition:"width .4s" }}></div>
          </div>
          <div style={{ display:"flex", gap:6, marginTop:10 }}>
            {questions.map((_,i)=>(
              <div key={i} style={{ flex:1, height:4, borderRadius:2, background:i<quizAnswered.length?(quizAnswered[i]?"#2e7d32":"#c62828"):i===quizIdx?C.gold:C.border }}></div>
            ))}
          </div>
        </div>

        {q && (
          <div style={{ ...crd, padding:26 }}>
            <div style={{ fontSize:17, fontWeight:800, color:C.text, lineHeight:1.5, marginBottom:22 }}>{q.q}</div>
            <div style={{ display:"flex", flexDirection:"column", gap:10, marginBottom:20 }}>
              {q.opts.map((opt,i)=>{
                let bg = C.card2, border = `1.5px solid ${C.border}`, col = C.text;
                if (quizSelected!==null) {
                  if (i===q.ans) { bg=dark?"rgba(46,125,50,.2)":"#e8f5e9"; border=`2px solid #2e7d32`; col="#2e7d32"; }
                  else if (i===quizSelected&&i!==q.ans) { bg=dark?"rgba(198,40,40,.2)":"#ffebee"; border=`2px solid #c62828`; col="#c62828"; }
                }
                return (
                  <button key={i} onClick={()=>{if(quizSelected!==null)return; setQuizSelected(i); setQuizShowExp(true); const correct=i===q.ans; setQuizAnswered(a=>[...a,correct]); if(correct)setQuizScore(s=>s+1);}}
                    style={{ background:bg, border, borderRadius:12, padding:"13px 18px", textAlign:"left", fontSize:14, fontWeight:600, cursor:quizSelected!==null?"default":"pointer", color:col, transition:"all .2s", display:"flex", gap:12, alignItems:"center" }}>
                    <span style={{ width:28, height:28, borderRadius:"50%", background:quizSelected!==null&&i===q.ans?"#2e7d32":quizSelected===i&&i!==q.ans?"#c62828":C.border.replace("rgba","rgba"), display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, fontWeight:800, color:quizSelected!==null&&(i===q.ans||i===quizSelected)?"#fff":C.muted, flexShrink:0 }}>{String.fromCharCode(65+i)}</span>
                    {opt}
                    {quizSelected!==null && i===q.ans && <span style={{ marginLeft:"auto" }}>✅</span>}
                    {quizSelected!==null && i===quizSelected && i!==q.ans && <span style={{ marginLeft:"auto" }}>❌</span>}
                  </button>
                );
              })}
            </div>

            {quizShowExp && (
              <div style={{ background:dark?"rgba(26,92,42,.1)":"#f0f9f0", borderRadius:12, padding:"12px 16px", marginBottom:16, borderLeft:`3px solid ${C.navy}` }}>
                <div style={{ fontSize:12, fontWeight:800, color:C.navy, marginBottom:4 }}>💡 Explanation</div>
                <div style={{ fontSize:13, color:C.text, lineHeight:1.6 }}>{q.exp}</div>
              </div>
            )}

            {quizSelected!==null && (
              <button onClick={()=>{ if(quizIdx<questions.length-1){setQuizIdx(i=>i+1);setQuizSelected(null);setQuizShowExp(false);}else{setQuizDone(true);}}}
                style={{ ...btnP, width:"100%", justifyContent:"center", padding:"12px" }}>
                {quizIdx<questions.length-1?"Next Question →":"See Results 🏆"}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  // ── CAMPUS MAP ────────────────────────────────────────────────────────────
  const renderMap = () => {
    const categories = ["All", ...new Set(CAMPUS_LOCATIONS.map(l=>l.category))];
    const filtered = mapCategory==="All"?CAMPUS_LOCATIONS:CAMPUS_LOCATIONS.filter(l=>l.category===mapCategory);
    const sel = mapSelected!==null ? CAMPUS_LOCATIONS.find(l=>l.id===mapSelected) : null;
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div>
            <h2 style={{ fontSize:22, fontWeight:900, color:C.text, margin:0 }}>🗺 Campus Map</h2>
            <p style={{ color:C.muted, fontSize:13, margin:"4px 0 0" }}>Omdurman Islamic University Campus</p>
          </div>
          <div style={{ display:"flex", gap:4, background:C.card2, borderRadius:10, padding:3, border:`1px solid ${C.border}`, flexWrap:"wrap" }}>
            {categories.map(cat=>(
              <button key={cat} onClick={()=>setMapCategory(cat)} style={{ background:mapCategory===cat?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none", color:mapCategory===cat?"#fff":C.muted, border:"none", borderRadius:7, padding:"5px 11px", fontSize:11, fontWeight:700, cursor:"pointer" }}>{cat}</button>
            ))}
          </div>
        </div>

        <div style={{ display:"grid", gridTemplateColumns:"1fr 320px", gap:16, alignItems:"start" }}>
          {/* Map canvas */}
          <div style={{ ...crd, padding:0, overflow:"hidden", position:"relative" }}>
            <div style={{ position:"relative", width:"100%", paddingBottom:"65%", background:dark?"#142018":"#e8f0e4" }}>
              {/* Grid lines */}
              <svg style={{ position:"absolute", inset:0, width:"100%", height:"100%", opacity:.15 }} viewBox="0 0 100 65" preserveAspectRatio="none">
                {[10,20,30,40,50,60,70,80,90].map(x=><line key={x} x1={x} y1="0" x2={x} y2="65" stroke={C.navy} strokeWidth=".3"/>)}
                {[10,20,30,40,50,60].map(y=><line key={y} x1="0" y1={y} x2="100" y2={y} stroke={C.navy} strokeWidth=".3"/>)}
                {/* Roads */}
                <path d="M0 35 L100 35" stroke={C.gold} strokeWidth="1.5" opacity={.4}/>
                <path d="M50 0 L50 65" stroke={C.gold} strokeWidth="1.5" opacity={.4}/>
                <path d="M20 0 L20 65" stroke={C.gold} strokeWidth=".8" opacity={.3}/>
                <path d="M75 0 L75 65" stroke={C.gold} strokeWidth=".8" opacity={.3}/>
              </svg>
              {/* University boundary */}
              <div style={{ position:"absolute", inset:"5%", border:`2px solid ${C.navy}33`, borderRadius:8 }}></div>
              {/* Locations */}
              {filtered.map(loc=>(
                <button key={loc.id} onClick={()=>setMapSelected(mapSelected===loc.id?null:loc.id)}
                  style={{ position:"absolute", left:`${loc.x}%`, top:`${loc.y}%`, transform:"translate(-50%,-50%)", background:mapSelected===loc.id?`linear-gradient(135deg,${C.navy},${C.nDark})`:dark?"rgba(255,255,255,.9)":"#fff", border:mapSelected===loc.id?`2px solid ${C.gold}`:`2px solid ${C.navy}`, borderRadius:12, padding:"5px 8px", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:1, boxShadow:mapSelected===loc.id?"0 4px 20px rgba(0,0,0,.3)":"0 2px 8px rgba(0,0,0,.15)", zIndex:mapSelected===loc.id?10:1, transition:"all .2s", minWidth:52 }}>
                  <span style={{ fontSize:18 }}>{loc.icon}</span>
                  <span style={{ fontSize:8, fontWeight:800, color:mapSelected===loc.id?"#fff":C.navy, textAlign:"center", lineHeight:1.2, whiteSpace:"nowrap", maxWidth:60, overflow:"hidden", textOverflow:"ellipsis" }}>{loc.name.split(" ").slice(0,2).join(" ")}</span>
                </button>
              ))}
              {/* Campus label */}
              <div style={{ position:"absolute", bottom:"4%", right:"3%", fontSize:9, fontWeight:800, color:C.muted, opacity:.6, fontFamily:"'Amiri',serif" }}>جامعة أم درمان الإسلامية</div>
            </div>
          </div>

          {/* Location detail / list */}
          <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
            {sel && (
              <div style={{ ...crd, padding:18, borderLeft:`4px solid ${C.gold}` }}>
                <div style={{ display:"flex", gap:12, alignItems:"center", marginBottom:10 }}>
                  <div style={{ width:48, height:48, borderRadius:14, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:24 }}>{sel.icon}</div>
                  <div><div style={{ fontSize:15, fontWeight:900, color:C.text }}>{sel.name}</div><div style={{ fontSize:11, color:C.muted }}><Tag label={sel.category} bg={C.navy+"22"} fg={C.navy} /></div></div>
                </div>
                <p style={{ fontSize:13, color:C.muted, lineHeight:1.6, margin:"0 0 12px" }}>{sel.desc}</p>
                <button onClick={()=>setMapSelected(null)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 12px", fontSize:11, cursor:"pointer", color:C.muted }}>✕ Close</button>
              </div>
            )}
            <div style={{ ...crd, maxHeight:420, overflowY:"auto" }}>
              <div style={{ padding:"12px 14px", borderBottom:`1px solid ${C.border}`, fontSize:12, fontWeight:800, color:C.navy }}>All Locations ({filtered.length})</div>
              {filtered.map(loc=>(
                <div key={loc.id} onClick={()=>setMapSelected(mapSelected===loc.id?null:loc.id)} style={{ display:"flex", gap:10, padding:"10px 14px", borderBottom:`1px solid ${C.border}`, cursor:"pointer", background:mapSelected===loc.id?(dark?"rgba(26,92,42,.15)":"rgba(26,92,42,.05)"):"transparent", transition:"background .15s" }}>
                  <span style={{ fontSize:18, flexShrink:0 }}>{loc.icon}</span>
                  <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{loc.name}</div><div style={{ fontSize:11, color:C.muted }}>{loc.category}</div></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSettings = () => (
    <div style={{ maxWidth:640 }}>
      <h2 style={{ fontSize:22, fontWeight:900, color:C.text, marginBottom:20 }}>⚙️ {lang==="ar"?"الإعدادات":"Settings"}</h2>

      {/* Appearance */}
      <div style={{ ...crd, padding:22, marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:16 }}>🎨 {lang==="ar"?"المظهر":"Appearance"}</div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{lang==="ar"?"الوضع الداكن":"Dark Mode"}</div><div style={{ fontSize:11, color:C.muted }}>{lang==="ar"?"تبديل إلى واجهة داكنة":"Switch to a darker interface"}</div></div>
          <button onClick={()=>setDark(d=>!d)} style={{ width:52, height:28, borderRadius:14, background:dark?`linear-gradient(90deg,${C.navy},${C.nDark})`:"#ddd", border:"none", cursor:"pointer", position:"relative", transition:"background .3s" }}>
            <div style={{ width:22, height:22, borderRadius:"50%", background:"#fff", position:"absolute", top:3, left:dark?27:3, transition:"left .3s", boxShadow:"0 1px 4px rgba(0,0,0,.3)" }}></div>
          </button>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
          <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{lang==="ar"?"لغة الواجهة":"Interface Language"}</div><div style={{ fontSize:11, color:C.muted }}>{lang==="ar"?"اختر لغة العرض":"Choose display language"}</div></div>
          <button onClick={()=>setLang(l=>l==="en"?"ar":"en")} style={{ background:`linear-gradient(135deg,${C.navy},${C.nDark})`, color:"#fff", border:"none", borderRadius:10, padding:"7px 16px", fontSize:13, fontWeight:700, cursor:"pointer" }}>{lang==="ar"?"English 🌐":"العربية 🌐"}</button>
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
          <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{lang==="ar"?"اللغة":"Language"}</div><div style={{ fontSize:11, color:C.muted }}>{lang==="ar"?"تفضيل اللغة":"Language preference"}</div></div>
          <select value={settingsLang} onChange={e=>setSettingsLang(e.target.value)} style={{ ...inp, width:"auto", padding:"6px 10px", fontSize:12 }}>
            <option>English</option><option>العربية</option><option>Français</option><option>Deutsch</option><option>Türkçe</option>
          </select>
        </div>
      </div>

      {/* Notifications */}
      <div style={{ ...crd, padding:22, marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:16 }}>🔔 {lang==="ar"?"الإشعارات":"Notifications"}</div>
        {[
          {label:lang==="ar"?"إشعارات البريد الإلكتروني":"Email Notifications", desc:lang==="ar"?"استقبال التحديثات بالبريد":"Receive updates by email", val:settingsNotifEmail, set:setSettingsNotifEmail},
          {label:lang==="ar"?"إشعارات المنصة":"Push Notifications", desc:lang==="ar"?"تنبيهات داخل التطبيق":"In-app alerts and badges", val:settingsNotifPush, set:setSettingsNotifPush}
        ].map((s,i)=>(
          <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
            <div><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.label}</div><div style={{ fontSize:11, color:C.muted }}>{s.desc}</div></div>
            <button onClick={()=>s.set(v=>!v)} style={{ width:52, height:28, borderRadius:14, background:s.val?`linear-gradient(90deg,${C.navy},${C.nDark})`:"#ddd", border:"none", cursor:"pointer", position:"relative", transition:"background .3s" }}>
              <div style={{ width:22, height:22, borderRadius:"50%", background:"#fff", position:"absolute", top:3, left:s.val?27:3, transition:"left .3s", boxShadow:"0 1px 4px rgba(0,0,0,.3)" }}></div>
            </button>
          </div>
        ))}
        <button onClick={()=>push("Test notification sent! 🔔","success")} style={{ background:C.input, color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"7px 16px", fontSize:12, fontWeight:700, cursor:"pointer" }}>🔔 {lang==="ar"?"إرسال إشعار تجريبي":"Send Test Notification"}</button>
      </div>

      {/* Privacy */}
      <div style={{ ...crd, padding:22, marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:16 }}>🔒 {lang==="ar"?"الخصوصية":"Privacy"}</div>
        <div style={{ marginBottom:12 }}>
          <div style={{ fontSize:13, fontWeight:700, color:C.text, marginBottom:8 }}>{lang==="ar"?"من يمكنه رؤية ملفي؟":"Who can see my profile?"}</div>
          {[{v:"everyone",l:lang==="ar"?"الجميع":"Everyone"},{v:"friends",l:lang==="ar"?"الأصدقاء فقط":"Friends only"},{v:"private",l:lang==="ar"?"خاص":"Private"}].map(opt=>(
            <label key={opt.v} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, cursor:"pointer" }} onClick={()=>setSettingsPrivacy(opt.v)}>
              <div style={{ width:18, height:18, borderRadius:"50%", border:`2px solid ${settingsPrivacy===opt.v?C.navy:C.border}`, background:settingsPrivacy===opt.v?C.navy:"transparent", display:"flex", alignItems:"center", justifyContent:"center" }}>
                {settingsPrivacy===opt.v && <div style={{ width:6, height:6, borderRadius:"50%", background:"#fff" }}></div>}
              </div>
              <span style={{ fontSize:13, color:C.text, fontWeight:settingsPrivacy===opt.v?700:400 }}>{opt.l}</span>
            </label>
          ))}
        </div>
      </div>

      {/* Change Password */}
      <div style={{ ...crd, padding:22, marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:16 }}>🔑 {lang==="ar"?"تغيير كلمة المرور":"Change Password"}</div>
        {chgPassErr && <div style={{ background:chgPassErr.startsWith("✅")?"#e8f5e9":"#ffebee", color:chgPassErr.startsWith("✅")?"#2e7d32":"#c62828", borderRadius:10, padding:"9px 14px", fontSize:13, fontWeight:600, marginBottom:12 }}>{chgPassErr}</div>}
        <div style={{ display:"flex", flexDirection:"column", gap:10 }}>
          <input type="password" value={chgPassCurrent} onChange={e=>setChgPassCurrent(e.target.value)} placeholder={lang==="ar"?"كلمة المرور الحالية":"Current password"} style={{ ...inp }} />
          <input type="password" value={chgPassNew} onChange={e=>setChgPassNew(e.target.value)} placeholder={lang==="ar"?"كلمة المرور الجديدة":"New password (min 6 chars)"} style={{ ...inp }} />
          <input type="password" value={chgPassConfirm} onChange={e=>setChgPassConfirm(e.target.value)} placeholder={lang==="ar"?"تأكيد كلمة المرور الجديدة":"Confirm new password"} style={{ ...inp }} />
          <button onClick={()=>{
            setChgPassErr("");
            const users = DB.getUsers();
            const me = users.find(u=>u.id===currentUser.id);
            if (!me || me.password !== chgPassCurrent) { setChgPassErr(lang==="ar"?"كلمة المرور الحالية غير صحيحة":"Current password is incorrect"); return; }
            if (chgPassNew.length < 6) { setChgPassErr(lang==="ar"?"كلمة المرور يجب أن تكون 6 أحرف على الأقل":"Password must be at least 6 characters"); return; }
            if (chgPassNew !== chgPassConfirm) { setChgPassErr(lang==="ar"?"كلمتا المرور غير متطابقتين":"Passwords do not match"); return; }
            me.password = chgPassNew;
            DB.saveUsers(users);
            DB.saveSession(me);
            setChgPassCurrent(""); setChgPassNew(""); setChgPassConfirm("");
            setChgPassErr("✅ "+(lang==="ar"?"تم تحديث كلمة المرور بنجاح":"Password updated successfully"));
            push(lang==="ar"?"تم تحديث كلمة المرور ✅":"Password updated! ✅","success");
          }} style={{ ...btnP, padding:"9px 18px", width:"fit-content" }}>{lang==="ar"?"تحديث كلمة المرور":"Update Password"}</button>
        </div>
      </div>

      {/* Account */}
      <div style={{ ...crd, padding:22, marginBottom:14 }}>
        <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:16 }}>👤 {lang==="ar"?"معلومات الحساب":"Account"}</div>
        {[["Student ID", ME.sid],["Name", ME.name],["Email", currentUser.email||"—"],["Phone", currentUser.phone||"—"],["College", ME.college],["Department", ME.department],["Year", "Year "+ME.year]].map(([k,v])=>(
          <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"8px 0", borderBottom:`1px solid ${C.border}` }}>
            <span style={{ fontSize:13, color:C.muted }}>{k}</span>
            <span style={{ fontSize:13, fontWeight:700, color:C.text }}>{v}</span>
          </div>
        ))}
      </div>

      {/* Danger Zone */}
      <div style={{ ...crd, padding:22, marginBottom:14, borderColor:"#ffcdd2" }}>
        <div style={{ fontSize:14, fontWeight:800, color:"#c62828", marginBottom:16 }}>⚠️ {lang==="ar"?"منطقة الخطر":"Danger Zone"}</div>
        <button onClick={()=>{ DB.clearSession(); ServerDB.clearToken(); onLogout(); }} style={{ background:"#ffebee", color:"#c62828", border:"1px solid #ffcdd2", borderRadius:10, padding:"9px 18px", fontSize:13, fontWeight:700, cursor:"pointer", marginRight:10 }}>↩ {lang==="ar"?"تسجيل الخروج":"Sign Out"}</button>
        <button onClick={()=>push(lang==="ar"?"تم إرسال طلب حذف الحساب":"Account deletion request sent","info")} style={{ background:"none", color:C.muted, border:`1px solid ${C.border}`, borderRadius:10, padding:"9px 18px", fontSize:13, fontWeight:700, cursor:"pointer" }}>{lang==="ar"?"حذف الحساب":"Delete Account"}</button>
      </div>

      <button onClick={()=>push(lang==="ar"?"تم حفظ الإعدادات ✅":"Settings saved! ✅","success")} style={{ ...btnP, padding:"11px 32px", fontSize:14 }}>{lang==="ar"?"حفظ الإعدادات":"Save Settings"}</button>
    </div>
  );

  // ── STUDY PLANNER ─────────────────────────────────────────────────────────
  const renderPlanner = () => {
    const PRIO = { urgent:{bg:"#ffebee",fg:"#c62828",label:"🔴 Urgent"}, high:{bg:"#fff3e0",fg:"#e65100",label:"🟠 High"}, normal:{bg:"#e8f5e9",fg:"#2e7d32",label:"🟢 Normal"} };
    const filtered = plannerTasks.filter(t => plannerFilter==="all"?true:plannerFilter==="done"?t.done:plannerFilter==="pending"?!t.done:t.priority===plannerFilter);
    const done = plannerTasks.filter(t=>t.done).length;
    const pct  = plannerTasks.length ? Math.round(done/plannerTasks.length*100) : 0;
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>📅 Study Planner</h2>
          <button onClick={()=>setShowPlannerForm(s=>!s)} style={{...btnP,padding:"8px 18px",fontSize:13}}>+ Add Task</button>
        </div>
        {/* Progress bar */}
        <div style={{...crd,padding:18,marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
            <span style={{fontSize:14,fontWeight:800,color:C.text}}>Overall Progress</span>
            <span style={{fontSize:14,fontWeight:900,color:C.navy}}>{done}/{plannerTasks.length} done · {pct}%</span>
          </div>
          <div style={{height:12,background:C.input,borderRadius:8,overflow:"hidden"}}>
            <div style={{height:"100%",width:pct+"%",background:`linear-gradient(90deg,${C.navy},${C.gold})`,borderRadius:8,transition:"width .5s"}}/>
          </div>
          <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
            {[["all","All",plannerTasks.length],["pending","Pending",plannerTasks.filter(x=>!x.done).length],["done","Done",done],["urgent","Urgent",plannerTasks.filter(x=>x.priority==="urgent").length],["high","High",plannerTasks.filter(x=>x.priority==="high").length]].map(([k,l,n])=>(
              <button key={k} onClick={()=>setPlannerFilter(k)} style={{background:plannerFilter===k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none",color:plannerFilter===k?"#fff":C.muted,border:`1px solid ${C.border}`,borderRadius:20,padding:"5px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l} {n}</button>
            ))}
          </div>
        </div>
        {/* Add task form */}
        {showPlannerForm && (
          <div style={{...crd,padding:18,marginBottom:18,borderLeft:`3px solid ${C.gold}`}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:12}}>➕ New Task</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
              <input value={plannerNew.title} onChange={e=>setPlannerNew(s=>({...s,title:e.target.value}))} placeholder="Task title…" style={{...inp,gridColumn:"1/-1"}}/>
              <input value={plannerNew.course} onChange={e=>setPlannerNew(s=>({...s,course:e.target.value}))} placeholder="Course code…" style={inp}/>
              <input type="date" value={plannerNew.due} onChange={e=>setPlannerNew(s=>({...s,due:e.target.value}))} style={inp}/>
            </div>
            <div style={{display:"flex",gap:8,alignItems:"center"}}>
              <select value={plannerNew.priority} onChange={e=>setPlannerNew(s=>({...s,priority:e.target.value}))} style={{...inp,width:"auto",padding:"8px 12px"}}>
                <option value="normal">🟢 Normal</option><option value="high">🟠 High</option><option value="urgent">🔴 Urgent</option>
              </select>
              <button onClick={()=>{if(!plannerNew.title.trim())return push("Enter a title","error");setPlannerTasks(ts=>[...ts,{id:Date.now(),...plannerNew,done:false,tags:[]}]);setPlannerNew({title:"",course:"",due:"",priority:"normal"});setShowPlannerForm(false);push("Task added ✅","success");}} style={{...btnP,padding:"8px 20px"}}>Add</button>
              <button onClick={()=>setShowPlannerForm(false)} style={{background:"none",border:`1px solid ${C.border}`,borderRadius:10,padding:"8px 14px",cursor:"pointer",color:C.muted,fontSize:13}}>Cancel</button>
            </div>
          </div>
        )}
        {/* Task list */}
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          {filtered.map(task=>{
            const p=PRIO[task.priority]||PRIO.normal;
            const daysLeft = task.due ? Math.ceil((new Date(task.due)-Date.now())/86400000) : null;
            return (
              <div key={task.id} style={{...crd,padding:16,opacity:task.done?.6:1,transition:"opacity .2s"}}>
                <div style={{display:"flex",alignItems:"center",gap:12}}>
                  <button onClick={()=>setPlannerTasks(ts=>ts.map(x=>x.id===task.id?{...x,done:!x.done}:x))} style={{width:22,height:22,borderRadius:"50%",border:`2px solid ${task.done?C.navy:C.border}`,background:task.done?C.navy:"transparent",cursor:"pointer",flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:12}}>
                    {task.done?"✓":""}
                  </button>
                  <div style={{flex:1}}>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:14,fontWeight:700,color:C.text,textDecoration:task.done?"line-through":"none"}}>{task.title}</span>
                      <span style={{fontSize:11,fontWeight:700,background:p.bg,color:p.fg,borderRadius:20,padding:"2px 8px"}}>{p.label}</span>
                      {task.course && <span style={{fontSize:11,color:C.muted,background:C.card2,borderRadius:20,padding:"2px 8px",border:`1px solid ${C.border}`}}>{task.course}</span>}
                    </div>
                    {task.due && <div style={{fontSize:11,color:daysLeft<0?"#c62828":daysLeft<=2?"#e65100":C.muted,marginTop:3}}>
                      {daysLeft<0?"⚠️ Overdue":daysLeft===0?"⏰ Due today":`📅 ${daysLeft}d left`} · {fmtDate(task.due)}
                    </div>}
                  </div>
                  <button onClick={()=>setPlannerTasks(ts=>ts.filter(x=>x.id!==task.id))} style={{background:"none",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"4px"}}>🗑</button>
                </div>
              </div>
            );
          })}
          {filtered.length===0 && <div style={{...crd,padding:40,textAlign:"center",color:C.muted}}><div style={{fontSize:36,marginBottom:8}}>✅</div>Nothing here!</div>}
        </div>
      </div>
    );
  };

  // ── POMODORO TIMER ─────────────────────────────────────────────────────────
  const renderPomodoro = () => {
    const mins = String(Math.floor(pomodoroSecs/60)).padStart(2,"0");
    const secs = String(pomodoroSecs%60).padStart(2,"0");
    const total = pomodoroMode==="work"?25*60:pomodoroMode==="longbreak"?15*60:5*60;
    const pct   = ((total-pomodoroSecs)/total)*100;
    const modeColors = { work:C.navy, break:"#2e7d32", longbreak:"#7b3f00" };
    const modeLabels = { work:"🍅 Focus", break:"☕ Short Break", longbreak:"🌙 Long Break" };
    const pendingForPomodoro = plannerTasks.filter(t=>!t.done);
    return (
      <div style={{maxWidth:560,margin:"0 auto"}}>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:18}}>⏱️ Pomodoro Timer</h2>
        {/* Mode selector */}
        <div style={{display:"flex",gap:6,marginBottom:20,background:C.card2,borderRadius:12,padding:5,border:`1px solid ${C.border}`}}>
          {[["work","🍅 Focus (25m)"],["break","☕ Break (5m)"],["longbreak","🌙 Long (15m)"]].map(([m,l])=>(
            <button key={m} onClick={()=>{setPomodoroMode(m);setPomodoroRunning(false);setPomodoroSecs(m==="work"?25*60:m==="longbreak"?15*60:5*60);}} style={{flex:1,background:pomodoroMode===m?`linear-gradient(135deg,${modeColors[m]},${modeColors[m]}cc)`:"none",color:pomodoroMode===m?"#fff":C.muted,border:"none",borderRadius:9,padding:"8px 6px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        {/* Clock face */}
        <div style={{...crd,padding:36,textAlign:"center",marginBottom:18}}>
          <div style={{position:"relative",width:200,height:200,margin:"0 auto 20px"}}>
            <svg viewBox="0 0 200 200" style={{position:"absolute",inset:0,width:"100%",height:"100%"}}>
              <circle cx="100" cy="100" r="90" fill="none" stroke={C.border} strokeWidth="8"/>
              <circle cx="100" cy="100" r="90" fill="none" stroke={modeColors[pomodoroMode]} strokeWidth="8" strokeDasharray={`${2*Math.PI*90}`} strokeDashoffset={`${2*Math.PI*90*(1-pct/100)}`} strokeLinecap="round" style={{transform:"rotate(-90deg)",transformOrigin:"center",transition:"stroke-dashoffset .5s"}}/>
            </svg>
            <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center"}}>
              <div style={{fontSize:42,fontWeight:900,color:C.text,fontVariantNumeric:"tabular-nums"}}>{mins}:{secs}</div>
              <div style={{fontSize:12,color:C.muted,fontWeight:700}}>{modeLabels[pomodoroMode]}</div>
            </div>
          </div>
          {/* Session dots */}
          <div style={{display:"flex",justifyContent:"center",gap:8,marginBottom:20}}>
            {[1,2,3,4].map(i=><div key={i} style={{width:12,height:12,borderRadius:"50%",background:pomodoroSession>i?C.navy:i===pomodoroSession?C.gold:C.border}}/>)}
          </div>
          {/* Current task */}
          <input value={pomodoroTask} onChange={e=>setPomodoroTask(e.target.value)} placeholder="What are you working on?" style={{...inp,textAlign:"center",marginBottom:16,borderRadius:20}}/>
          <div style={{display:"flex",gap:10,justifyContent:"center"}}>
            <button onClick={()=>setPomodoroRunning(r=>!r)} style={{...btnP,padding:"12px 36px",fontSize:16,background:`linear-gradient(135deg,${modeColors[pomodoroMode]},${modeColors[pomodoroMode]}cc)`}}>
              {pomodoroRunning?"⏸ Pause":"▶ Start"}
            </button>
            <button onClick={()=>{setPomodoroRunning(false);setPomodoroSecs(pomodoroMode==="work"?25*60:pomodoroMode==="longbreak"?15*60:5*60);}} style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:12,padding:"12px 20px",fontSize:14,cursor:"pointer",color:C.muted}}>↺ Reset</button>
          </div>
        </div>
        {/* Quick-pick from planner */}
        {pendingForPomodoro.length>0 && (
          <div style={{...crd,padding:16}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>📋 Pick from your planner</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {pendingForPomodoro.slice(0,4).map(t=>(
                <div key={t.id} onClick={()=>setPomodoroTask(t.title)} style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",borderRadius:10,border:`1px solid ${C.border}`,cursor:"pointer",transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background=dark?"rgba(26,92,42,.15)":"rgba(26,92,42,.05)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                  <span style={{fontSize:13,color:C.text,flex:1}}>{t.title}</span>
                  <span style={{fontSize:11,color:C.muted}}>{t.course}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ── SHARED NOTES ───────────────────────────────────────────────────────────
  const renderNotes = () => {
    const allStudents = [{...ME,id:1},...STUDENTS];
    const myNotes     = notes.filter(n=>n.author===ME.id);
    const sharedWithMe= notes.filter(n=>n.author!==1&&n.sharedWith.includes(1));
    const displayNotes= noteTab==="mine"?myNotes:sharedWithMe;
    const tagColors   = {"cs":"#1565c0","fiqh":"#7b3f00","math":"#6a1b9a","arabic":"#2e7d32","algorithms":"#0277bd","grammar":"#558b2f","economics":"#c62828","writing":"#e65100","study":"#1a5c2a","coding":"#1565c0"};

    if(activeNote) {
      const n = notes.find(x=>x.id===activeNote);
      if(!n) { setActiveNote(null); return null; }
      const author = allStudents.find(s=>s.id===n.author);
      return (
        <div>
          <button onClick={()=>{setActiveNote(null);setNoteEdit(false);}} style={{...btnP,padding:"7px 14px",fontSize:12,marginBottom:16,background:C.card2,color:C.muted,border:`1px solid ${C.border}`}}>← Back to Notes</button>
          <div style={{...crd,padding:24}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:16,flexWrap:"wrap",gap:10}}>
              <div>
                <div style={{fontSize:20,fontWeight:900,color:C.text}}>{n.title}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:4}}>📚 {n.course} · By {author?.name||"Unknown"} · Updated {fmtDate(n.updatedAt)}</div>
                <div style={{display:"flex",gap:5,marginTop:6,flexWrap:"wrap"}}>
                  {n.tags.map(tag=><span key={tag} style={{fontSize:11,background:tagColors[tag]||C.navy,color:"#fff",borderRadius:20,padding:"2px 9px",fontWeight:700}}>#{tag}</span>)}
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                {n.author===ME.id && <button onClick={()=>setNoteEdit(e=>!e)} style={{...btnP,padding:"7px 14px",fontSize:12}}>{noteEdit?"👁 View":"✏️ Edit"}</button>}
                <button onClick={()=>push("Link copied! 🔗","success")} style={{background:C.card2,border:`1px solid ${C.border}`,borderRadius:10,padding:"7px 12px",fontSize:12,cursor:"pointer",color:C.muted}}>🔗 Share</button>
              </div>
            </div>
            {noteEdit && n.author===ME.id ? (
              <div>
                <textarea value={n.content} onChange={e=>setNotes(ns=>ns.map(x=>x.id===n.id?{...x,content:e.target.value,updatedAt:new Date().toISOString().slice(0,10)}:x))} rows={16} style={{...inp,resize:"vertical",fontFamily:"'DM Sans',monospace",fontSize:13,lineHeight:1.7}}/>
                <button onClick={()=>{setNoteEdit(false);push("Note saved ✅","success");}} style={{...btnP,padding:"8px 20px",marginTop:10}}>💾 Save</button>
              </div>
            ) : (
              <div style={{background:dark?"rgba(255,255,255,.03)":"rgba(0,0,0,.02)",borderRadius:12,padding:20,fontSize:14,color:C.text,lineHeight:1.9,whiteSpace:"pre-wrap",fontFamily:"'DM Sans',sans-serif"}}>{n.content}</div>
            )}
            {/* Shared with */}
            <div style={{marginTop:16,paddingTop:16,borderTop:`1px solid ${C.border}`}}>
              <div style={{fontSize:12,fontWeight:800,color:C.muted,marginBottom:8}}>👥 Shared with</div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {n.sharedWith.map(id=>{const s=allStudents.find(x=>x.id===id);return s?<div key={id} style={{display:"flex",alignItems:"center",gap:5,background:C.card2,border:`1px solid ${C.border}`,borderRadius:20,padding:"4px 10px"}}><AvatarDisplay name={s.name} size={18}/><span style={{fontSize:11,color:C.text,fontWeight:700}}>{s.name.split(" ")[0]}</span></div>:null;})}
                {n.sharedWith.length===0 && <span style={{fontSize:12,color:C.muted}}>Not shared with anyone</span>}
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>📝 Shared Notes</h2>
          <button onClick={()=>{setNoteDraft({title:"",course:"",content:"",tags:""});const newN={id:Date.now(),title:"Untitled Note",course:"",content:"Start typing…",author:1,sharedWith:[],updatedAt:new Date().toISOString().slice(0,10),pinned:false,tags:[]};setNotes(ns=>[newN,...ns]);setActiveNote(newN.id);setNoteEdit(true);}} style={{...btnP,padding:"8px 18px",fontSize:13}}>📝 New Note</button>
        </div>
        <div style={{display:"flex",gap:4,marginBottom:18,background:C.card2,borderRadius:12,padding:4,width:"fit-content",border:`1px solid ${C.border}`}}>
          {[["mine",`📓 My Notes (${myNotes.length})`],["shared",`🤝 Shared with Me (${sharedWithMe.length})`]].map(([k,l])=>(
            <button key={k} onClick={()=>setNoteTab(k)} style={{background:noteTab===k?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none",color:noteTab===k?"#fff":C.muted,border:"none",borderRadius:9,padding:"7px 16px",fontSize:13,fontWeight:700,cursor:"pointer"}}>{l}</button>
          ))}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
          {displayNotes.map(n=>{
            const author=allStudents.find(s=>s.id===n.author);
            return (
              <div key={n.id} onClick={()=>setActiveNote(n.id)} style={{...crd,padding:18,cursor:"pointer",borderTop:`3px solid ${tagColors[n.tags[0]]||C.navy}`,transition:"transform .15s,box-shadow .15s"}} onMouseEnter={e=>{e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow="0 8px 24px rgba(0,0,0,.12)";}} onMouseLeave={e=>{e.currentTarget.style.transform="none";e.currentTarget.style.boxShadow="";}}>
                {n.pinned && <div style={{fontSize:10,color:C.gold,fontWeight:800,marginBottom:6}}>📌 PINNED</div>}
                <div style={{fontSize:14,fontWeight:800,color:C.text,marginBottom:4}}>{n.title}</div>
                <div style={{fontSize:11,color:C.muted,marginBottom:8}}>📚 {n.course} · {fmtDate(n.updatedAt)}</div>
                <div style={{fontSize:12,color:C.muted,lineHeight:1.5,marginBottom:10,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:3,WebkitBoxOrient:"vertical"}}>{n.content.replace(/\*/g,"").slice(0,120)}…</div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {n.tags.slice(0,3).map(tag=><span key={tag} style={{fontSize:10,background:tagColors[tag]||C.navy,color:"#fff",borderRadius:20,padding:"1px 7px",fontWeight:700}}>#{tag}</span>)}
                  </div>
                  {n.author!==1 && <div style={{display:"flex",alignItems:"center",gap:4}}><AvatarDisplay name={author?.name||"?"} size={18}/><span style={{fontSize:11,color:C.muted}}>{author?.name?.split(" ")[0]}</span></div>}
                </div>
              </div>
            );
          })}
          {displayNotes.length===0 && <div style={{gridColumn:"1/-1",...crd,padding:40,textAlign:"center",color:C.muted}}><div style={{fontSize:36,marginBottom:8}}>📝</div>No notes here yet</div>}
        </div>
      </div>
    );
  };

  // ── GPA GOAL TRACKER ───────────────────────────────────────────────────────
  const renderGpaGoals = () => {
    const weighted = gpaGoals.reduce((a,g)=>a+g.current,0)/gpaGoals.length;
    const targetW  = gpaGoals.reduce((a,g)=>a+g.target,0)/gpaGoals.length;
    const onTrack  = gpaGoals.filter(g=>g.current>=g.target).length;
    return (
      <div>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:18}}>🏅 GPA Goal Tracker</h2>
        {/* Summary cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:12,marginBottom:20}}>
          {[["🎯","Overall Target",overallTarget.toFixed(1)],["📊","Current GPA",weighted.toFixed(2)],["✅","On Track",`${onTrack}/${gpaGoals.length}`],["📈","Gap",`${Math.max(0,overallTarget-weighted).toFixed(2)} pts`]].map(([icon,label,val])=>(
            <div key={label} style={{...crd,padding:16,textAlign:"center"}}>
              <div style={{fontSize:26,marginBottom:4}}>{icon}</div>
              <div style={{fontSize:20,fontWeight:900,color:C.navy}}>{val}</div>
              <div style={{fontSize:11,color:C.muted}}>{label}</div>
            </div>
          ))}
        </div>
        {/* Overall target slider */}
        <div style={{...crd,padding:18,marginBottom:18}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:14,fontWeight:800,color:C.navy}}>🎯 Set Your Target GPA</span>
            <span style={{fontSize:18,fontWeight:900,color:C.gold}}>{overallTarget.toFixed(1)}</span>
          </div>
          <input type="range" min="2.0" max="4.0" step="0.1" value={overallTarget} onChange={e=>{ const v=parseFloat(e.target.value); setOverallTarget(v); DB.saveUserData(currentUser.id,"gpaTarget",v); }} style={{width:"100%",accentColor:C.navy}}/>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.muted,marginTop:4}}><span>2.0</span><span>3.0</span><span>4.0</span></div>
        </div>
        {/* Per-course goals */}
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {gpaGoals.map((g,i)=>{
            const pct  = Math.min(100,Math.round(g.current/g.target*100));
            const ok   = g.current>=g.target;
            const diff = (g.target-g.current).toFixed(1);
            return (
              <div key={i} style={{...crd,padding:18}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800,color:C.text}}>{g.course}</div>
                    <div style={{fontSize:11,color:C.muted,marginTop:2}}>
                      Current: <strong style={{color:ok?"#2e7d32":"#c62828"}}>{g.current}</strong> · Target: <strong style={{color:C.navy}}>{g.target}</strong>
                      {ok ? <span style={{color:"#2e7d32",fontWeight:700}}> ✅ On target!</span> : <span style={{color:"#e65100",fontWeight:700}}> Need +{diff} pts</span>}
                    </div>
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>setGpaGoals(gs=>gs.map((x,j)=>j===i?{...x,target:Math.min(4.0,parseFloat((x.target+0.1).toFixed(1)))}:x))} style={{width:28,height:28,borderRadius:8,background:C.card2,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:14,fontWeight:800,color:C.navy}}>+</button>
                    <button onClick={()=>setGpaGoals(gs=>gs.map((x,j)=>j===i?{...x,target:Math.max(1.0,parseFloat((x.target-0.1).toFixed(1)))}:x))} style={{width:28,height:28,borderRadius:8,background:C.card2,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:14,fontWeight:800,color:C.muted}}>−</button>
                  </div>
                </div>
                <div style={{height:10,background:C.input,borderRadius:6,overflow:"hidden"}}>
                  <div style={{height:"100%",width:pct+"%",background:ok?`linear-gradient(90deg,#2e7d32,#4caf50)`:`linear-gradient(90deg,${C.navy},${C.gold})`,borderRadius:6,transition:"width .5s"}}/>
                </div>
                <div style={{fontSize:10,color:C.muted,textAlign:"right",marginTop:3}}>{pct}% of target</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── CAFETERIA ──────────────────────────────────────────────────────────────
  const renderCafeteria = () => {
    const days = ["Sunday","Monday","Tuesday","Wednesday","Thursday"];
    const meals = ["breakfast","lunch","dinner"];
    const mealEmoji = {breakfast:"🌅",lunch:"☀️",dinner:"🌙"};
    const todayMenu = CAFETERIA_MENU[cafDay]?.[cafMeal] || [];
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>🍽️ Campus Cafeteria</h2>
          <div style={{display:"flex",gap:6,alignItems:"center"}}>
            <span style={{fontSize:12,color:C.muted}}>All items are</span>
            <span style={{background:"#e8f5e9",color:"#2e7d32",fontSize:11,fontWeight:800,borderRadius:20,padding:"3px 10px"}}>✅ حلال HALAL</span>
          </div>
        </div>
        {/* Day selector */}
        <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
          {days.map(d=>(
            <button key={d} onClick={()=>setCafDay(d)} style={{background:cafDay===d?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none",color:cafDay===d?"#fff":C.muted,border:`1px solid ${C.border}`,borderRadius:20,padding:"6px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{d}</button>
          ))}
        </div>
        {/* Meal selector */}
        <div style={{display:"flex",gap:4,marginBottom:18,background:C.card2,borderRadius:12,padding:4,width:"fit-content",border:`1px solid ${C.border}`}}>
          {meals.map(m=>(
            <button key={m} onClick={()=>setCafMeal(m)} style={{background:cafMeal===m?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none",color:cafMeal===m?"#fff":C.muted,border:"none",borderRadius:9,padding:"7px 20px",fontSize:13,fontWeight:700,cursor:"pointer"}}>{mealEmoji[m]} {m.charAt(0).toUpperCase()+m.slice(1)}</button>
          ))}
        </div>
        {/* Menu grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:14,marginBottom:20}}>
          {todayMenu.map((item,i)=>(
            <div key={i} style={{...crd,padding:18,transition:"transform .15s"}} onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="none"}>
              <div style={{fontSize:40,textAlign:"center",marginBottom:10}}>{item.emoji}</div>
              <div style={{fontSize:15,fontWeight:800,color:C.text,textAlign:"center",marginBottom:3}}>{item.name}</div>
              <div style={{fontSize:12,color:C.muted,textAlign:"center",marginBottom:10,fontFamily:"'Amiri',serif"}}>{item.ar}</div>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingTop:10,borderTop:`1px solid ${C.border}`}}>
                <span style={{fontSize:14,fontWeight:900,color:C.navy}}>{item.price} SDG</span>
                <span style={{fontSize:11,color:C.muted}}>{item.cal} kcal</span>
                <button onClick={()=>setCafFavs(f=>f.includes(i+cafDay+cafMeal)?f.filter(x=>x!==i+cafDay+cafMeal):[...f,i+cafDay+cafMeal])} style={{background:"none",border:"none",cursor:"pointer",fontSize:18}}>{cafFavs.includes(i+cafDay+cafMeal)?"❤️":"🤍"}</button>
              </div>
            </div>
          ))}
          {todayMenu.length===0 && <div style={{gridColumn:"1/-1",...crd,padding:40,textAlign:"center",color:C.muted}}><div style={{fontSize:36,marginBottom:8}}>🍽️</div>Menu not available</div>}
        </div>
        {/* Info cards */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
          {[["⏰","Hours","Breakfast: 7–9am · Lunch: 12–3pm · Dinner: 6–9pm"],["💳","Payment","Student card, cash, or mobile money accepted"],["📍","Location","Main Building, Ground Floor, East Wing"],["☎️","Contact","Ext. 1240 · cafeteria@oiu.edu"]].map(([icon,title,text])=>(
            <div key={title} style={{...crd,padding:14}}>
              <div style={{fontSize:22,marginBottom:6}}>{icon}</div>
              <div style={{fontSize:12,fontWeight:800,color:C.navy,marginBottom:3}}>{title}</div>
              <div style={{fontSize:11,color:C.muted,lineHeight:1.5}}>{text}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── SPORTS BOOKING ─────────────────────────────────────────────────────────
  const renderSports = () => {
    const myBookings = sportsBookings.filter(b=>b.userId===1);
    return (
      <div>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:18}}>🏋️ Sports Booking</h2>
        {/* My bookings */}
        {myBookings.length>0 && (
          <div style={{...crd,padding:16,marginBottom:18,borderLeft:`3px solid ${C.gold}`}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>📋 Your Bookings</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {myBookings.map(b=>{
                const fac=SPORTS_FACILITIES.find(f=>f.id===b.facId);
                return (
                  <div key={b.id} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",background:C.card2,borderRadius:10,border:`1px solid ${C.border}`}}>
                    <span style={{fontSize:22}}>{fac?.icon}</span>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:700,color:C.text}}>{fac?.name}</div>
                      <div style={{fontSize:11,color:C.muted}}>{b.date} · {b.slot}</div>
                    </div>
                    <button onClick={()=>setSportsBookings(bs=>bs.filter(x=>x.id!==b.id))} style={{background:"#ffebee",color:"#c62828",border:"none",borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>Cancel</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {/* Date picker */}
        <div style={{...crd,padding:14,marginBottom:18,display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:700,color:C.text}}>📅 Booking date:</span>
          <input type="date" value={sportsDate} onChange={e=>setSportsDate(e.target.value)} style={{...inp,width:"auto",padding:"8px 12px"}}/>
        </div>
        {/* Facilities grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:14}}>
          {SPORTS_FACILITIES.map(fac=>{
            const bookedSlots = sportsBookings.filter(b=>b.facId===fac.id&&b.date===sportsDate).map(b=>b.slot);
            return (
              <div key={fac.id} style={{...crd,padding:0,overflow:"hidden",border:`1px solid ${C.border}`}}>
                <div style={{height:8,background:fac.color}}/>
                <div style={{padding:16}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:30}}>{fac.icon}</span>
                    <div>
                      <div style={{fontSize:15,fontWeight:800,color:C.text}}>{fac.name}</div>
                      <div style={{fontSize:11,color:C.muted}}>{fac.desc}</div>
                    </div>
                  </div>
                  <div style={{fontSize:11,color:C.muted,marginBottom:10}}>👥 Capacity: {fac.capacity}</div>
                  <div style={{fontSize:12,fontWeight:700,color:C.navy,marginBottom:8}}>Available slots:</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {fac.slots.map(slot=>{
                      const booked = bookedSlots.includes(slot);
                      const isMyBook = sportsBookings.find(b=>b.facId===fac.id&&b.date===sportsDate&&b.slot===slot&&b.userId===1);
                      return (
                        <button key={slot} onClick={()=>{
                          if(isMyBook){setSportsBookings(bs=>bs.filter(b=>!(b.facId===fac.id&&b.date===sportsDate&&b.slot===slot&&b.userId===1)));push("Booking cancelled","");return;}
                          if(booked){push("Slot already booked","error");return;}
                          setSportsBookings(bs=>[...bs,{id:Date.now(),facId:fac.id,userId:1,date:sportsDate,slot}]);
                          push(`${fac.name} booked for ${slot} ✅`,"success");
                        }} style={{background:isMyBook?`linear-gradient(135deg,${fac.color},${fac.color}cc)`:booked?"#f5f5f5":C.card2,color:isMyBook?"#fff":booked?"#bbb":C.text,border:`1px solid ${isMyBook?fac.color:C.border}`,borderRadius:8,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:booked&&!isMyBook?"not-allowed":"pointer"}}>
                          {isMyBook?"✓ ":"⏰ "}{slot}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── STUDENT DIRECTORY ──────────────────────────────────────────────────────
  const renderDirectory = () => {
    const allStudents = [...STUDENTS,...ALL_DIRECTORY];
    const colleges = ["All",...new Set(allStudents.map(s=>s.college.replace("Faculty of ","")))];
    const years = ["All","1","2","3","4"];
    let filtered = allStudents.filter(s=>{
      if(dirSearch && !s.name.toLowerCase().includes(dirSearch.toLowerCase()) && !s.bio?.toLowerCase().includes(dirSearch.toLowerCase())) return false;
      if(dirCollege!=="All" && !s.college.includes(dirCollege)) return false;
      if(dirYear!=="All" && String(s.year)!==dirYear) return false;
      return true;
    });
    if(dirSort==="gpa") filtered=[...filtered].sort((a,b)=>b.gpa-a.gpa);
    else if(dirSort==="points") filtered=[...filtered].sort((a,b)=>b.points-a.points);
    else filtered=[...filtered].sort((a,b)=>a.name.localeCompare(b.name));
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>🔎 Student Directory</h2>
          <div style={{fontSize:12,color:C.muted}}>{filtered.length} students found</div>
        </div>
        {/* Filters */}
        <div style={{...crd,padding:14,marginBottom:18,display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
          <input value={dirSearch} onChange={e=>setDirSearch(e.target.value)} placeholder="🔍 Search name, bio, skills…" style={{...inp,flex:1,minWidth:200}}/>
          <select value={dirCollege} onChange={e=>setDirCollege(e.target.value)} style={{...inp,width:"auto",padding:"8px 12px",fontSize:12}}>
            {colleges.map(c=><option key={c}>{c}</option>)}
          </select>
          <select value={dirYear} onChange={e=>setDirYear(e.target.value)} style={{...inp,width:"auto",padding:"8px 12px",fontSize:12}}>
            {years.map(y=><option key={y}>{y==="All"?"All Years":"Year "+y}</option>)}
          </select>
          <select value={dirSort} onChange={e=>setDirSort(e.target.value)} style={{...inp,width:"auto",padding:"8px 12px",fontSize:12}}>
            <option value="name">Sort: Name</option>
            <option value="gpa">Sort: GPA</option>
            <option value="points">Sort: Points</option>
          </select>
        </div>
        {/* Results */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:12}}>
          {filtered.map(s=>{
            const st=fStatus(s.id);
            return (
              <div key={s.id} style={{...crd,padding:16}}>
                <div style={{display:"flex",gap:10,alignItems:"center",marginBottom:10}}>
                  <AvatarDisplay name={s.name} size={46} badge={s.status==="online"}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,fontWeight:800,color:C.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{s.name}</div>
                    <div style={{fontSize:10,color:C.muted}}>{s.college.replace("Faculty of "," ")}</div>
                    <div style={{display:"flex",gap:6,marginTop:2}}>
                      <span style={{fontSize:10,background:C.card2,border:`1px solid ${C.border}`,borderRadius:20,padding:"1px 6px",color:C.muted}}>Y{s.year}</span>
                      <span style={{fontSize:10,background:"rgba(201,164,62,.1)",color:C.gold,borderRadius:20,padding:"1px 6px",fontWeight:700}}>GPA {s.gpa}</span>
                    </div>
                  </div>
                </div>
                {s.bio && <p style={{fontSize:11,color:C.muted,margin:"0 0 10px",lineHeight:1.5,overflow:"hidden",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{s.bio}</p>}
                {s.skills && <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:10}}>{s.skills.map(sk=><span key={sk} style={{fontSize:9,background:C.navy+"22",color:C.navy,borderRadius:20,padding:"1px 7px",fontWeight:700}}>{sk}</span>)}</div>}
                <div style={{display:"flex",gap:6}}>
                  {st==="friend"?<button onClick={()=>openChat(s.id)} style={{...btnP,flex:1,padding:"6px",fontSize:11}}>💬 Message</button>:st==="sent"?<button disabled style={{flex:1,background:C.input,color:C.muted,border:"none",borderRadius:10,padding:"6px",fontSize:11,fontWeight:700}}>Sent ✓</button>:st==="incoming"?<button onClick={()=>acceptReq(incoming.find(r=>r.from===s.id)?.id,s.id)} style={{...btnP,flex:1,padding:"6px",fontSize:11}}>✅ Accept</button>:<button onClick={()=>sendReq(s.id)} style={{...btnP,flex:1,padding:"6px",fontSize:11}}>+ Add</button>}
                  <button onClick={()=>push(s.status==="online"?"Student is online now 🟢":"Student is offline","info")} style={{background:s.status==="online"?"#e8f5e9":"#f5f5f5",color:s.status==="online"?"#2e7d32":"#999",border:"none",borderRadius:10,padding:"6px 8px",fontSize:10,fontWeight:700,cursor:"pointer"}}>{s.status==="online"?"● Online":"○ Offline"}</button>
                </div>
              </div>
            );
          })}
          {filtered.length===0 && <div style={{gridColumn:"1/-1",...crd,padding:40,textAlign:"center",color:C.muted}}><div style={{fontSize:36,marginBottom:8}}>🔎</div>No students found</div>}
        </div>
      </div>
    );
  };

  // ── CLUBS & SOCIETIES ──────────────────────────────────────────────────────
  const renderClubs = () => {
    const categories = ["All","Academic","Religious","Language","Arts","Social","Business","Sports"];
    const myClubs = clubs.filter(c=>c.joined);
    const filtered = clubs.filter(c=>(clubFilter==="All"||c.category===clubFilter)&&c.name.toLowerCase().includes(clubSearch.toLowerCase()));
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>🎙️ Clubs & Societies</h2>
          <span style={{fontSize:12,color:C.muted}}>You have joined {myClubs.length} clubs</span>
        </div>
        {/* My clubs strip */}
        {myClubs.length>0 && (
          <div style={{...crd,padding:16,marginBottom:18}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>⭐ My Clubs</div>
            <div style={{display:"flex",gap:10,overflowX:"auto",paddingBottom:4}}>
              {myClubs.map(c=>(
                <div key={c.id} style={{flexShrink:0,background:`linear-gradient(135deg,${C.navy},${C.nDark})`,borderRadius:14,padding:"10px 16px",color:"#fff",minWidth:140}}>
                  <div style={{fontSize:24,marginBottom:4}}>{c.icon}</div>
                  <div style={{fontSize:12,fontWeight:800}}>{c.name}</div>
                  <div style={{fontSize:10,opacity:.7,marginTop:2}}>👥 {c.members} members</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Search & filter */}
        <div style={{display:"flex",gap:10,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
          <input value={clubSearch} onChange={e=>setClubSearch(e.target.value)} placeholder="Search clubs…" style={{...inp,flex:1,minWidth:180}}/>
        </div>
        <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
          {categories.map(cat=>(
            <button key={cat} onClick={()=>setClubFilter(cat)} style={{background:clubFilter===cat?`linear-gradient(135deg,${C.navy},${C.nDark})`:"none",color:clubFilter===cat?"#fff":C.muted,border:`1px solid ${C.border}`,borderRadius:20,padding:"5px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{cat}</button>
          ))}
        </div>
        {/* Clubs grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
          {filtered.map(c=>(
            <div key={c.id} style={{...crd,padding:20}}>
              <div style={{display:"flex",gap:12,alignItems:"flex-start",marginBottom:10}}>
                <div style={{width:52,height:52,borderRadius:16,background:`linear-gradient(135deg,${C.navy},${C.nDark})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>{c.icon}</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:15,fontWeight:800,color:C.text}}>{c.name}</div>
                  <div style={{display:"flex",gap:6,marginTop:3}}>
                    <span style={{fontSize:10,background:`${C.navy}22`,color:C.navy,borderRadius:20,padding:"2px 8px",fontWeight:700}}>{c.category}</span>
                    <span style={{fontSize:10,color:C.muted}}>👥 {c.members}</span>
                  </div>
                </div>
              </div>
              <p style={{fontSize:12,color:C.muted,lineHeight:1.55,margin:"0 0 12px"}}>{c.desc}</p>
              {c.events.length>0 && (
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:C.navy,marginBottom:5}}>📅 Upcoming</div>
                  {c.events.map(ev=><div key={ev} style={{fontSize:11,color:C.muted,padding:"3px 0",borderBottom:`1px dashed ${C.border}`}}>• {ev}</div>)}
                </div>
              )}
              <button onClick={()=>{setClubs(cs=>cs.map(x=>x.id===c.id?{...x,joined:!x.joined,members:x.joined?x.members-1:x.members+1}:x));push(c.joined?`Left ${c.name}`:`Joined ${c.name}! 🎉`,c.joined?"":"success");}} style={{...btnP,width:"100%",padding:"9px",fontSize:13,background:c.joined?"#ffebee":"",color:c.joined?"#c62828":"",border:c.joined?"1px solid #ffcdd2":""}}>
                {c.joined?"🚪 Leave Club":"✅ Join Club"}
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── ELECTIONS / VOTING ─────────────────────────────────────────────────────
  const renderElections = () => {
    if(elecDetail) {
      const el = elections.find(e=>e.id===elecDetail);
      if(!el){setElecDetail(null);return null;}
      const total = el.candidates.reduce((s,c)=>s+c.votes,0);
      const winner = el.candidates.reduce((a,b)=>a.votes>b.votes?a:b);
      return (
        <div>
          <button onClick={()=>setElecDetail(null)} style={{...btnP,padding:"7px 14px",fontSize:12,marginBottom:16,background:C.card2,color:C.muted,border:`1px solid ${C.border}`}}>← Back to Elections</button>
          <div style={{...crd,padding:24,marginBottom:18}}>
            <div style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:10,flexWrap:"wrap"}}>
              <div style={{flex:1}}>
                <div style={{fontSize:20,fontWeight:900,color:C.text}}>{el.title}</div>
                <div style={{fontSize:12,color:C.muted,marginTop:4}}>{el.desc}</div>
                <div style={{display:"flex",gap:8,marginTop:8}}>
                  <span style={{fontSize:11,fontWeight:700,background:el.status==="active"?"#e8f5e9":"#f5f5f5",color:el.status==="active"?"#2e7d32":"#999",borderRadius:20,padding:"3px 10px"}}>{el.status==="active"?"🔴 Live":"✅ Closed"}</span>
                  <span style={{fontSize:11,color:C.muted}}>Ends {fmtDate(el.endDate)}</span>
                  <span style={{fontSize:11,color:C.muted}}>👥 {total} votes cast</span>
                </div>
              </div>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:14}}>
            {el.candidates.map(c=>{
              const pct = total ? Math.round(c.votes/total*100) : 0;
              const isWinner = c.id===winner.id;
              const isMyVote = el.myVote===c.id;
              return (
                <div key={c.id} style={{...crd,padding:20,borderLeft:`4px solid ${isWinner?"#c9a43e":C.border}`,position:"relative"}}>
                  {isWinner && <div style={{position:"absolute",top:12,right:14,fontSize:11,fontWeight:800,color:C.gold,background:"rgba(201,164,62,.1)",borderRadius:20,padding:"3px 10px"}}>🏆 Leading</div>}
                  <div style={{display:"flex",gap:14,alignItems:"flex-start",marginBottom:14}}>
                    <div style={{width:56,height:56,borderRadius:16,background:`linear-gradient(135deg,${C.navy},${C.nDark})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0}}>{c.icon}</div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:16,fontWeight:900,color:C.text}}>{c.name}</div>
                      <div style={{fontSize:12,color:C.muted}}>{c.college.replace("Faculty of ","")}</div>
                      <p style={{fontSize:13,color:C.muted,lineHeight:1.55,margin:"8px 0 0",fontStyle:"italic"}}>"{c.manifesto}"</p>
                    </div>
                  </div>
                  {/* Vote bar */}
                  <div style={{height:10,background:C.input,borderRadius:6,overflow:"hidden",marginBottom:6}}>
                    <div style={{height:"100%",width:pct+"%",background:isWinner?`linear-gradient(90deg,${C.gold},#e6a800)`:`linear-gradient(90deg,${C.navy},${C.nDark})`,borderRadius:6,transition:"width .6s"}}/>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <span style={{fontSize:12,color:C.muted}}>{c.votes} votes ({pct}%)</span>
                    {isMyVote && <span style={{fontSize:11,fontWeight:700,color:C.gold}}>✓ Your vote</span>}
                  </div>
                  {el.status==="active" && !el.voted && (
                    <button onClick={()=>{setElections(es=>es.map(e=>e.id===el.id?{...e,voted:true,myVote:c.id,candidates:e.candidates.map(x=>x.id===c.id?{...x,votes:x.votes+1}:x)}:e));push(`Voted for ${c.name}! 🗳️`,"success");setElecDetail(null);setTimeout(()=>setElecDetail(el.id),100);}} style={{...btnP,width:"100%",padding:"10px",fontSize:13}}>
                      🗳️ Vote for {c.name.split(" ")[0]}
                    </button>
                  )}
                  {el.voted && isMyVote && <div style={{background:"#e8f5e9",borderRadius:10,padding:"8px 14px",fontSize:13,color:"#2e7d32",fontWeight:700,textAlign:"center"}}>✅ You voted for this candidate</div>}
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>🗳️ Student Elections</h2>
          <div style={{fontSize:12,color:C.muted}}>{elections.filter(e=>e.status==="active").length} active elections</div>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {elections.map(el=>{
            const total=el.candidates.reduce((s,c)=>s+c.votes,0);
            const leader=el.candidates.reduce((a,b)=>a.votes>b.votes?a:b);
            return (
              <div key={el.id} style={{...crd,padding:20,cursor:"pointer",transition:"transform .15s"}} onClick={()=>setElecDetail(el.id)} onMouseEnter={e=>e.currentTarget.style.transform="translateY(-2px)"} onMouseLeave={e=>e.currentTarget.style.transform="none"}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12,flexWrap:"wrap",gap:8}}>
                  <div>
                    <div style={{fontSize:16,fontWeight:900,color:C.text}}>{el.title}</div>
                    <div style={{fontSize:12,color:C.muted,marginTop:3}}>{el.desc}</div>
                  </div>
                  <div style={{display:"flex",gap:6,flexShrink:0}}>
                    <span style={{fontSize:11,fontWeight:700,background:el.status==="active"?"#e8f5e9":"#f5f5f5",color:el.status==="active"?"#2e7d32":"#999",borderRadius:20,padding:"4px 12px"}}>{el.status==="active"?"🔴 Live":"✅ Closed"}</span>
                    {el.voted && <span style={{fontSize:11,fontWeight:700,background:"rgba(201,164,62,.1)",color:C.gold,borderRadius:20,padding:"4px 12px"}}>✓ Voted</span>}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                  {el.candidates.slice(0,3).map(c=>(
                    <div key={c.id} style={{display:"flex",alignItems:"center",gap:5,background:C.card2,borderRadius:20,padding:"4px 10px",border:`1px solid ${C.border}`}}>
                      <span style={{fontSize:14}}>{c.icon}</span><span style={{fontSize:11,color:C.text,fontWeight:700}}>{c.name.split(" ")[0]}</span>
                    </div>
                  ))}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:12,color:C.muted}}>👥 {total} total votes · 🏆 Leading: {leader.name.split(" ")[0]}</span>
                  <span style={{fontSize:12,color:C.navy,fontWeight:700}}>{el.status==="active"&&!el.voted?"Vote Now →":"View Results →"}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── REPORT SYSTEM ──────────────────────────────────────────────────────────
  const renderReport = () => {
    const reasons = ["Harassment or bullying","Spam or fake content","Inappropriate language","Hate speech","Academic dishonesty","Impersonation","Other"];
    return (
      <div style={{maxWidth:580,margin:"0 auto"}}>
        <h2 style={{fontSize:22,fontWeight:900,color:C.text,marginBottom:18}}>🚨 Report Content</h2>
        {/* Past reports */}
        {reportsDone.length>0 && (
          <div style={{...crd,padding:16,marginBottom:18,borderLeft:`3px solid ${C.gold}`}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>📋 Your Reports ({reportsDone.length})</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {reportsDone.map(r=>(
                <div key={r.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:C.card2,borderRadius:10,border:`1px solid ${C.border}`}}>
                  <div>
                    <div style={{fontSize:12,fontWeight:700,color:C.text}}>{r.reason}</div>
                    <div style={{fontSize:11,color:C.muted}}>Reported on {r.date}</div>
                  </div>
                  <span style={{fontSize:10,fontWeight:700,background:"#e8f5e9",color:"#2e7d32",borderRadius:20,padding:"3px 9px"}}>Under Review</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <div style={{...crd,padding:24}}>
          <div style={{fontSize:15,fontWeight:800,color:C.navy,marginBottom:16}}>📝 Submit a Report</div>
          {/* What to report */}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.5,display:"block",marginBottom:8}}>Reporting about</label>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[["💬","A Message"],["👤","A User"],["📝","A Post"],["👥","A Group"]].map(([icon,label])=>(
                <button key={label} onClick={()=>setReportTarget(label)} style={{background:reportTarget===label?`linear-gradient(135deg,${C.navy},${C.nDark})`:C.card2,color:reportTarget===label?"#fff":C.muted,border:`1px solid ${reportTarget===label?C.navy:C.border}`,borderRadius:10,padding:"8px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>{icon} {label}</button>
              ))}
            </div>
          </div>
          {/* Reason */}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.5,display:"block",marginBottom:8}}>Reason</label>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {reasons.map(r=>(
                <label key={r} style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer",padding:"8px 12px",borderRadius:10,border:`1px solid ${reportReason===r?C.navy:C.border}`,background:reportReason===r?"rgba(26,92,42,.05)":"transparent"}}>
                  <input type="radio" name="reason" value={r} checked={reportReason===r} onChange={()=>setReportReason(r)} style={{accentColor:C.navy}}/>
                  <span style={{fontSize:13,color:C.text}}>{r}</span>
                </label>
              ))}
            </div>
          </div>
          {/* Details */}
          <div style={{marginBottom:18}}>
            <label style={{fontSize:12,fontWeight:700,color:C.muted,textTransform:"uppercase",letterSpacing:.5,display:"block",marginBottom:8}}>Additional details (optional)</label>
            <textarea value={reportDetails} onChange={e=>setReportDetails(e.target.value)} placeholder="Describe what happened…" rows={4} style={{...inp,resize:"vertical",borderRadius:12}}/>
          </div>
          <div style={{background:dark?"rgba(201,164,62,.06)":"rgba(201,164,62,.05)",borderRadius:12,padding:12,marginBottom:16,fontSize:12,color:C.muted,lineHeight:1.6}}>
            🔒 Reports are <strong>confidential</strong>. Our moderation team reviews all reports within 24 hours. False reports may result in account restrictions.
          </div>
          <button onClick={()=>{
            if(!reportReason){push("Please select a reason","error");return;}
            if(!reportTarget){push("Please select what you are reporting","error");return;}
            setReportsDone(rs=>[...rs,{id:Date.now(),reason:reportReason,target:reportTarget,details:reportDetails,date:new Date().toLocaleDateString("en-GB")}]);
            setReportReason(""); setReportTarget(null); setReportDetails("");
            push("Report submitted. Thank you! 🙏","success");
          }} style={{...btnP,width:"100%",padding:"12px",fontSize:14}}>🚨 Submit Report</button>
        </div>
      </div>
    );
  };

  // ── PERSONAL ANALYTICS ────────────────────────────────────────────────────
  const renderAnalytics = () => {
    const d  = analyticsData;
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const maxW = Math.max(...d.weekActivity,1);
    return (
      <div>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18,flexWrap:"wrap",gap:10}}>
          <h2 style={{fontSize:22,fontWeight:900,color:C.text,margin:0}}>📊 My Analytics</h2>
          <span style={{background:"rgba(201,164,62,.1)",color:C.gold,fontSize:12,fontWeight:800,borderRadius:20,padding:"4px 14px",border:`1px solid rgba(201,164,62,.2)`}}>🔥 {d.loginStreak}-day streak</span>
        </div>
        {/* KPI grid */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10,marginBottom:20}}>
          {[["🔐",d.loginStreak+"d","Login Streak",C.gold],["📨",d.msgsToday,"Messages Today",C.navy],["📝",d.postsThisWeek,"Posts This Week","#2e7d32"],["✅",d.assignmentsSubmitted,"Assignments In","#e65100"],["⏱️",d.studyHours+"h","Study Hours","#7b3f00"],["📓",d.notesCreated,"Notes Created","#4a148c"],["👥",d.groupsJoined,"Groups Joined",C.navy],["🧠",d.quizzesTaken,"Quizzes Taken","#006064"]].map(([icon,val,lbl,col])=>(
            <div key={lbl} style={{...crd,padding:14,textAlign:"center",borderTop:`3px solid ${col}`}}>
              <div style={{fontSize:22,marginBottom:4}}>{icon}</div>
              <div style={{fontSize:22,fontWeight:900,color:col}}>{val}</div>
              <div style={{fontSize:10,color:C.muted}}>{lbl}</div>
            </div>
          ))}
        </div>
        {/* Weekly bar chart */}
        <div style={{...crd,padding:20,marginBottom:18}}>
          <div style={{fontSize:14,fontWeight:800,color:C.navy,marginBottom:16}}>📅 Activity This Week</div>
          <div style={{display:"flex",gap:8,alignItems:"flex-end",height:120}}>
            {d.weekActivity.map((v,i)=>(
              <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <div style={{fontSize:10,color:C.muted,fontWeight:700}}>{v}</div>
                <div style={{width:"100%",background:`linear-gradient(180deg,${C.navy},${C.nDark})`,borderRadius:"4px 4px 0 0",height:Math.max(4,v/maxW*80)+"px",transition:"height .4s"}}/>
                <div style={{fontSize:10,color:C.muted}}>{days[i]}</div>
              </div>
            ))}
          </div>
        </div>
        {/* Activity heatmap */}
        <div style={{...crd,padding:20,marginBottom:18}}>
          <div style={{fontSize:14,fontWeight:800,color:C.navy,marginBottom:12}}>🗓 Activity Heatmap — March 2026</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
            {["S","M","T","W","T","F","S"].map((d,i)=><div key={i} style={{fontSize:9,color:C.muted,textAlign:"center",fontWeight:700,padding:"2px 0"}}>{d}</div>)}
            {d.monthHeatmap.map((day)=>{
              const intensity = Math.min(1, day.count/8);
              const bg = day.count===0?C.input:day.count<=2?`rgba(26,92,42,.2)`:day.count<=5?`rgba(26,92,42,.5)`:C.navy;
              return (
                <div key={day.day} title={`${day.day} Mar: ${day.count} actions`} style={{height:22,borderRadius:4,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:8,color:intensity>.5?"#fff":C.muted,fontWeight:700,cursor:"default"}}>{day.day}</div>
              );
            })}
          </div>
          <div style={{display:"flex",gap:6,alignItems:"center",marginTop:10,justifyContent:"flex-end"}}>
            <span style={{fontSize:10,color:C.muted}}>Less</span>
            {[C.input,"rgba(26,92,42,.2)","rgba(26,92,42,.5)",C.navy].map((bg,i)=><div key={i} style={{width:14,height:14,borderRadius:3,background:bg}}/>)}
            <span style={{fontSize:10,color:C.muted}}>More</span>
          </div>
        </div>
        {/* Highlights */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
          <div style={{...crd,padding:18}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>🏆 Best Streak</div>
            <div style={{fontSize:28,fontWeight:900,color:C.gold}}>🔥 {d.loginStreak}</div>
            <div style={{fontSize:12,color:C.muted}}>consecutive days logged in</div>
          </div>
          <div style={{...crd,padding:18}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>🏅 Top Course</div>
            <div style={{fontSize:13,fontWeight:700,color:C.text}}>{d.topCourse}</div>
            <div style={{fontSize:11,color:C.muted,marginTop:4}}>Most activity this semester</div>
          </div>
          <div style={{...crd,padding:18}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>🧠 Quiz Average</div>
            <div style={{fontSize:28,fontWeight:900,color:C.navy}}>{d.quizAvgScore}%</div>
            <div style={{height:6,background:C.input,borderRadius:4,overflow:"hidden",marginTop:6}}><div style={{height:"100%",width:d.quizAvgScore+"%",background:`linear-gradient(90deg,${C.navy},${C.gold})`,borderRadius:4}}/></div>
          </div>
          <div style={{...crd,padding:18}}>
            <div style={{fontSize:13,fontWeight:800,color:C.navy,marginBottom:10}}>📱 Total Logins</div>
            <div style={{fontSize:28,fontWeight:900,color:"#2e7d32"}}>{d.totalLogins}</div>
            <div style={{fontSize:12,color:C.muted}}>sessions this semester</div>
          </div>
        </div>
      </div>
    );
  };

  // ── GROUP CHATS ───────────────────────────────────────────────────────────
  const renderGroups = () => {
    const myGroups = groups.filter(g=>g.members.find(m=>m.id===ME.id));
    const curGroup = groups.find(g=>g.id===activeGroup);
    const iAmAdmin = curGroup && isGroupAdmin(curGroup);
    const canMsg   = curGroup && canSendInGroup(curGroup);
    const allStudents = [{...ME, id:1},...STUDENTS];
    const getMember = id => allStudents.find(s=>s.id===id);

    // ── GROUP INFO PANEL ──────────────────────────────────────────────────
    if (showGroupInfo && curGroup) {
      const eligible = STUDENTS.filter(s=>!curGroup.members.find(m=>m.id===s.id)&&s.name.toLowerCase().includes(groupAddSearch.toLowerCase()));
      // Sync edit fields when entering info panel (use App-level state)
      const editName  = groupEditName  || curGroup.name;
      const editBio   = groupEditBio   || curGroup.bio;
      const editOnly  = groupEditOnly !== undefined ? groupEditOnly : curGroup.onlyAdminsCanMsg;
      const addSearch = groupAddSearch;
      const setEditName  = setGroupEditName;
      const setEditBio   = setGroupEditBio;
      const setEditOnly  = setGroupEditOnly;
      const setAddSearch = setGroupAddSearch;
      return (
        <div style={{ display:"flex", height:"calc(100vh - 96px)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, background:C.card }}>
          {/* Back panel */}
          <div style={{ width:280, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", background:C.card2, flexShrink:0 }}>
            <div style={{ padding:"14px", borderBottom:`1px solid ${C.border}`, display:"flex", alignItems:"center", gap:10 }}>
              <button onClick={()=>setShowGroupInfo(false)} style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 10px", cursor:"pointer", fontSize:12, color:C.muted }}>← Back</button>
              <span style={{ fontWeight:800, color:C.navy, fontSize:14 }}>Group Info</span>
            </div>
            <div style={{ flex:1, overflowY:"auto", padding:16, display:"flex", flexDirection:"column", gap:14 }}>
              {/* Group avatar */}
              <div style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
                <div style={{ width:80, height:80, borderRadius:24, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:36, border:`3px solid ${C.gold}` }}>
                  {curGroup.photo ? <img src={curGroup.photo} style={{ width:"100%",height:"100%",borderRadius:24,objectFit:"cover" }} alt="" /> : curGroup.icon}
                </div>
                {iAmAdmin && (
                  <label style={{ fontSize:11, color:C.gold, cursor:"pointer", fontWeight:700 }}>
                    📷 Change Photo
                    <input type="file" accept="image/*" style={{ display:"none" }} onChange={e=>{
                      const f=e.target.files?.[0]; if(!f) return;
                      const r=new FileReader(); r.onload=ev=>updateGroupInfo(curGroup.id,{photo:ev.target.result}); r.readAsDataURL(f);
                    }} />
                  </label>
                )}
              </div>
              {/* Name / bio edit */}
              {iAmAdmin ? (
                <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                  <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.5 }}>Group Name</div>
                  <input value={editName} onChange={e=>setEditName(e.target.value)} style={{ ...inp }} />
                  <div style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.5 }}>Group Bio</div>
                  <textarea value={editBio} onChange={e=>setEditBio(e.target.value)} rows={3} style={{ ...inp, resize:"vertical" }} />
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", background:dark?"rgba(255,255,255,.04)":"rgba(26,92,42,.04)", borderRadius:10, padding:"10px 14px" }}>
                    <div>
                      <div style={{ fontSize:13, fontWeight:700, color:C.text }}>Only admins can message</div>
                      <div style={{ fontSize:11, color:C.muted }}>Members can only read</div>
                    </div>
                    <button onClick={()=>setEditOnly(v=>!v)} style={{ width:48,height:26,borderRadius:13,background:editOnly?`linear-gradient(90deg,${C.navy},${C.nDark})`:"#ccc",border:"none",cursor:"pointer",position:"relative",transition:"background .3s" }}>
                      <div style={{ width:20,height:20,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:editOnly?25:3,transition:"left .3s",boxShadow:"0 1px 4px rgba(0,0,0,.3)" }}></div>
                    </button>
                  </div>
                  <button onClick={()=>{ updateGroupInfo(curGroup.id,{name:editName,bio:editBio,onlyAdminsCanMsg:editOnly}); }} style={{ ...btnP, padding:"8px" }}>💾 Save Changes</button>
                </div>
              ) : (
                <div style={{ ...crd, padding:14 }}>
                  <div style={{ fontSize:15, fontWeight:900, color:C.text, marginBottom:4 }}>{curGroup.name}</div>
                  <div style={{ fontSize:12, color:C.muted, lineHeight:1.6 }}>{curGroup.bio}</div>
                  {curGroup.onlyAdminsCanMsg && <div style={{ marginTop:8, fontSize:11, color:C.gold, fontWeight:700 }}>🔒 Only admins can send messages</div>}
                </div>
              )}
              {/* Stats */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                {[["👥",curGroup.members.length,"Members"],["👑",curGroup.members.filter(m=>m.role==="admin").length,"Admins"],["💬",curGroup.msgs.length,"Messages"],["📅",curGroup.createdAt,"Created"]].map(([icon,val,lbl])=>(
                  <div key={lbl} style={{ ...crd, padding:"10px 12px", textAlign:"center" }}>
                    <div style={{ fontSize:18 }}>{icon}</div>
                    <div style={{ fontSize:13, fontWeight:800, color:C.navy }}>{val}</div>
                    <div style={{ fontSize:10, color:C.muted }}>{lbl}</div>
                  </div>
                ))}
              </div>
              {/* Leave group */}
              {myRoleInGroup(curGroup)!=="none" && (
                <button onClick={()=>{ leaveGroup(curGroup.id); setShowGroupInfo(false); }} style={{ background:"#ffebee", color:"#c62828", border:"1px solid #ffcdd2", borderRadius:10, padding:"9px", fontSize:13, fontWeight:700, cursor:"pointer", width:"100%" }}>
                  🚪 Leave Group
                </button>
              )}
            </div>
          </div>

          {/* Members list */}
          <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
            <div style={{ padding:"14px 18px", borderBottom:`1px solid ${C.border}`, background:dark?"rgba(9,21,9,.4)":"rgba(247,243,235,.9)" }}>
              <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:6 }}>👥 Members ({curGroup.members.length} / {curGroup.maxMembers.toLocaleString()})</div>
              {iAmAdmin && (
                <input value={addSearch} onChange={e=>setAddSearch(e.target.value)} placeholder="Add member by name…" style={{ ...inp, fontSize:12, padding:"7px 12px" }} />
              )}
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {/* Add member suggestions */}
              {iAmAdmin && addSearch && eligible.slice(0,5).map(s=>(
                <div key={s.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 18px", borderBottom:`1px solid ${C.border}`, background:dark?"rgba(201,164,62,.04)":"rgba(201,164,62,.03)" }}>
                  <AvatarDisplay name={s.name} size={36} badge={s.status==="online"} />
                  <div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.name}</div><div style={{ fontSize:11, color:C.muted }}>{s.college.replace("Faculty of ","")}</div></div>
                  <button onClick={()=>{ addMemberToGroup(curGroup.id,s.id); setAddSearch(""); }} style={{ ...btnP, padding:"5px 12px", fontSize:11 }}>+ Add</button>
                </div>
              ))}
              {/* Current members */}
              {curGroup.members.map(m=>{
                const s=getMember(m.id); if(!s) return null;
                return (
                  <div key={m.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"12px 18px", borderBottom:`1px solid ${C.border}` }}>
                    <AvatarDisplay name={s.name} photo={s.id===1?myPhoto:null} size={40} badge={s.id!==1&&s.status==="online"} />
                    <div style={{ flex:1 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                        <span style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.name}{s.id===1?" (You)":""}</span>
                        {m.role==="admin" && <span style={{ background:"rgba(201,164,62,.15)", color:C.gold, fontSize:9, fontWeight:800, padding:"2px 7px", borderRadius:8 }}>👑 ADMIN</span>}
                      </div>
                      <div style={{ fontSize:11, color:C.muted }}>{s.college?.replace("Faculty of ","")}</div>
                    </div>
                    {/* Admin controls */}
                    {iAmAdmin && m.id!==1 && (
                      <div style={{ display:"flex", gap:4 }}>
                        {m.role==="member" ?
                          <button onClick={()=>promoteMember(curGroup.id,m.id)} title="Make Admin" style={{ background:"rgba(201,164,62,.1)", color:C.gold, border:"none", borderRadius:7, padding:"4px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}>👑</button> :
                          <button onClick={()=>demoteMember(curGroup.id,m.id)} title="Remove Admin" style={{ background:"rgba(200,40,40,.1)", color:"#c62828", border:"none", borderRadius:7, padding:"4px 8px", cursor:"pointer", fontSize:11, fontWeight:700 }}>⬇</button>
                        }
                        <button onClick={()=>removeMemberFromGroup(curGroup.id,m.id)} title="Remove from group" style={{ background:"rgba(200,40,40,.08)", color:"#c62828", border:"none", borderRadius:7, padding:"4px 8px", cursor:"pointer", fontSize:11 }}>✕</button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      );
    }

    // ── NEW GROUP MODAL ─────────────────────────────────────────────────────
    const NewGroupModal = () => {
      if (!showNewGroup) return null;
      return (
        <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.55)", zIndex:500, display:"flex", alignItems:"center", justifyContent:"center", padding:20 }}>
          <div style={{ background:C.card, borderRadius:20, padding:28, width:"100%", maxWidth:480, maxHeight:"80vh", overflowY:"auto", boxShadow:"0 20px 60px rgba(0,0,0,.4)" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:20 }}>
              <div style={{ fontSize:18, fontWeight:900, color:C.navy }}>💬 New Group</div>
              <button onClick={()=>setShowNewGroup(false)} style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:8, padding:"5px 10px", cursor:"pointer", fontSize:13, color:C.muted }}>✕</button>
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div>
                <label style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.5, display:"block", marginBottom:5 }}>Group Name *</label>
                <input value={newGroupName} onChange={e=>setNewGroupName(e.target.value)} placeholder="e.g. CS Study Team" style={{ ...inp }} />
              </div>
              <div>
                <label style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.5, display:"block", marginBottom:5 }}>Group Description</label>
                <input value={newGroupDesc} onChange={e=>setNewGroupDesc(e.target.value)} placeholder="What's this group about?" style={{ ...inp }} />
              </div>
              <div>
                <label style={{ fontSize:11, fontWeight:700, color:C.muted, textTransform:"uppercase", letterSpacing:.5, display:"block", marginBottom:8 }}>Add Members</label>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
                  {newGroupMembers.map(id=>{
                    const s=STUDENTS.find(x=>x.id===id);
                    return s ? (
                      <span key={id} style={{ background:`linear-gradient(135deg,${C.navy},${C.nDark})`, color:"#fff", borderRadius:20, padding:"4px 10px", fontSize:12, display:"flex", alignItems:"center", gap:6 }}>
                        {s.name.split(" ")[0]}
                        <button onClick={()=>setNewGroupMembers(m=>m.filter(x=>x!==id))} style={{ background:"none", border:"none", color:"rgba(255,255,255,.7)", cursor:"pointer", fontSize:14, lineHeight:1 }}>×</button>
                      </span>
                    ) : null;
                  })}
                </div>
                <div style={{ maxHeight:180, overflowY:"auto", border:`1px solid ${C.border}`, borderRadius:10, overflow:"hidden" }}>
                  {STUDENTS.filter(s=>!newGroupMembers.includes(s.id)).map(s=>(
                    <div key={s.id} onClick={()=>setNewGroupMembers(m=>[...m,s.id])} style={{ display:"flex", alignItems:"center", gap:10, padding:"9px 14px", cursor:"pointer", borderBottom:`1px solid ${C.border}`, transition:"background .15s" }} onMouseEnter={e=>e.currentTarget.style.background=dark?"rgba(26,92,42,.15)":"rgba(26,92,42,.05)"} onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <AvatarDisplay name={s.name} size={32} badge={s.status==="online"} />
                      <div style={{ flex:1 }}><div style={{ fontSize:13, fontWeight:700, color:C.text }}>{s.name}</div><div style={{ fontSize:11, color:C.muted }}>{s.college.replace("Faculty of ","")}</div></div>
                      <div style={{ width:20, height:20, borderRadius:"50%", border:`2px solid ${C.border}`, background:"transparent" }}></div>
                    </div>
                  ))}
                </div>
              </div>
              <button onClick={createGroup} style={{ ...btnP, padding:"11px", fontSize:14, marginTop:4 }}>
                🚀 Create Group ({newGroupMembers.length + 1} members)
              </button>
            </div>
          </div>
        </div>
      );
    };

    // ── MAIN GROUP CHAT UI ──────────────────────────────────────────────────
    return (
      <div style={{ position:"relative" }}>
        <NewGroupModal />
        <div style={{ display:"flex", height:"calc(100vh - 96px)", borderRadius:16, overflow:"hidden", border:`1px solid ${C.border}`, background:C.card }}>

          {/* LEFT: Group List */}
          <div style={{ width:280, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", background:C.card2, flexShrink:0 }}>
            <div style={{ padding:"14px 14px 10px", borderBottom:`1px solid ${C.border}` }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
                <h3 style={{ fontSize:15, fontWeight:900, color:C.navy, margin:0 }}>👥 Groups</h3>
                <button onClick={()=>setShowNewGroup(true)} style={{ ...btnP, padding:"5px 12px", fontSize:11 }}>+ New</button>
              </div>
              <input placeholder="Search groups…" style={{ ...inp, fontSize:12, padding:"7px 11px" }} />
            </div>
            <div style={{ flex:1, overflowY:"auto" }}>
              {myGroups.length===0 && (
                <div style={{ padding:30, textAlign:"center", color:C.muted }}>
                  <div style={{ fontSize:36, marginBottom:8 }}>👥</div>
                  <div style={{ fontSize:13 }}>No groups yet</div>
                  <button onClick={()=>setShowNewGroup(true)} style={{ ...btnP, padding:"7px 16px", fontSize:12, marginTop:10 }}>Create a group</button>
                </div>
              )}
              {myGroups.map(g=>{
                const lastMsg = g.msgs[g.msgs.length-1];
                const lastSender = lastMsg ? allStudents.find(s=>s.id===lastMsg.from) : null;
                const myRole = myRoleInGroup(g);
                const isAdmin = myRole==="admin";
                return (
                  <div key={g.id} onClick={()=>{setActiveGroup(g.id);setShowGroupInfo(false);}} style={{ display:"flex", gap:10, padding:"11px 14px", cursor:"pointer", background:activeGroup===g.id?(dark?"rgba(26,92,42,.25)":"rgba(26,92,42,.06)"):"transparent", borderBottom:`1px solid ${C.border}`, transition:"background .15s" }}>
                    <div style={{ width:46, height:46, borderRadius:14, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:22, flexShrink:0, position:"relative" }}>
                      {g.photo ? <img src={g.photo} style={{ width:"100%",height:"100%",borderRadius:14,objectFit:"cover" }} alt="" /> : g.icon}
                      {isAdmin && <div style={{ position:"absolute", bottom:-2, right:-2, fontSize:10, background:C.gold, borderRadius:"50%", width:16, height:16, display:"flex", alignItems:"center", justifyContent:"center" }}>👑</div>}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                        <div style={{ fontSize:13, fontWeight:700, color:C.text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{g.name}</div>
                        <div style={{ fontSize:10, color:C.muted, flexShrink:0 }}>{lastMsg?.time||""}</div>
                      </div>
                      <div style={{ fontSize:11, color:C.muted, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                        {lastMsg ? `${lastSender?.name?.split(" ")[0]||"?"}: ${lastMsg.text}` : g.bio}
                      </div>
                      <div style={{ fontSize:10, color:C.muted, marginTop:2 }}>👥 {g.members.length} members</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* RIGHT: Chat or empty state */}
          {!curGroup ? (
            <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:14, color:C.muted }}>
              <div style={{ fontSize:64 }}>👥</div>
              <div style={{ fontSize:20, fontWeight:800, color:C.text }}>Select a Group</div>
              <div style={{ fontSize:14, color:C.muted }}>or</div>
              <button onClick={()=>setShowNewGroup(true)} style={{ ...btnP, padding:"10px 24px", fontSize:14 }}>+ Create New Group</button>
            </div>
          ) : (
            <div style={{ flex:1, display:"flex", flexDirection:"column" }}>
              {/* Header */}
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 18px", borderBottom:`1px solid ${C.border}`, background:dark?"rgba(9,21,9,.5)":"rgba(247,243,235,.9)" }}>
                <div style={{ width:42, height:42, borderRadius:13, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0, cursor:"pointer" }} onClick={()=>setShowGroupInfo(true)}>
                  {curGroup.photo ? <img src={curGroup.photo} style={{ width:"100%",height:"100%",borderRadius:13,objectFit:"cover" }} alt="" /> : curGroup.icon}
                </div>
                <div style={{ flex:1, cursor:"pointer" }} onClick={()=>setShowGroupInfo(true)}>
                  <div style={{ fontSize:15, fontWeight:800, color:C.text }}>{curGroup.name}</div>
                  <div style={{ fontSize:11, color:C.muted }}>
                    {curGroup.members.length} members
                    {curGroup.onlyAdminsCanMsg && " · 🔒 Admins only"}
                    {iAmAdmin && " · 👑 You're an admin"}
                  </div>
                </div>
                <button onClick={()=>setShowGroupInfo(true)} style={{ background:C.card2, border:`1px solid ${C.border}`, borderRadius:9, padding:"6px 12px", fontSize:12, cursor:"pointer", color:C.muted, fontWeight:700 }}>ℹ️ Info</button>
              </div>

              {/* Messages */}
              <div style={{ flex:1, overflowY:"auto", padding:"16px", display:"flex", flexDirection:"column", gap:10 }}>
                {/* Locked notice */}
                {curGroup.onlyAdminsCanMsg && !iAmAdmin && (
                  <div style={{ textAlign:"center", background:dark?"rgba(201,164,62,.08)":"rgba(201,164,62,.06)", borderRadius:10, padding:"10px 18px", fontSize:12, color:C.gold, fontWeight:700 }}>
                    🔒 Only admins can send messages in this group
                  </div>
                )}
                {curGroup.msgs.map(m=>{
                  const mine = m.from===ME.id;
                  const sender = getMember(m.from);
                  const isAdmin = curGroup.members.find(x=>x.id===m.from)?.role==="admin";
                  const showR = groupMsgHover === m.id;
                  return (
                    <div key={m.id} style={{ display:"flex", justifyContent:mine?"flex-end":"flex-start", flexDirection:"column", alignItems:mine?"flex-end":"flex-start" }}>
                      <div style={{ display:"flex", alignItems:"flex-end", gap:7 }}>
                        {!mine && <AvatarDisplay name={sender?.name||"?"} photo={null} size={28} badge={sender?.id!==1&&sender?.status==="online"} />}
                        <div style={{ maxWidth:"72%" }}>
                          {!mine && (
                            <div style={{ fontSize:10, color:C.muted, marginBottom:2, fontWeight:700 }}>
                              {sender?.name}{isAdmin && <span style={{ color:C.gold, marginLeft:4 }}>👑</span>}
                            </div>
                          )}
                          <div
                            onMouseEnter={()=>setGroupMsgHover(m.id)}
                            onMouseLeave={()=>setGroupMsgHover(null)}
                            style={{ position:"relative", background:mine?`linear-gradient(135deg,${C.navy},${C.nDark})`:(dark?"rgba(255,255,255,.08)":"#f5f2eb"), color:mine?"#fff":C.text, borderRadius:mine?"16px 16px 4px 16px":"4px 16px 16px 16px", padding:"10px 14px", fontSize:13, lineHeight:1.55 }}>
                            {m.text}
                            {/* Hover action bar */}
                            {showR && (
                              <div style={{ position:"absolute", top:-30, right:mine?0:"auto", left:mine?"auto":0, background:C.card, border:`1px solid ${C.border}`, borderRadius:10, padding:"3px 6px", display:"flex", gap:3, boxShadow:"0 4px 16px rgba(0,0,0,.2)", zIndex:10 }}>
                                {["❤️","👍","😂","🙏","🔥"].map(r=>(
                                  <button key={r} onClick={()=>{reactGroupMsg(curGroup.id,m.id,r);setGroupMsgHover(null);}} style={{ background:"none", border:"none", cursor:"pointer", fontSize:16, padding:"2px" }}>{r}</button>
                                ))}
                                {(mine||iAmAdmin) && <button onClick={()=>deleteGroupMsg(curGroup.id,m.id)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:14, color:"#c62828", padding:"2px 4px" }}>🗑</button>}
                              </div>
                            )}
                          </div>
                          {/* Reactions */}
                          {Object.keys(m.reactions||{}).length>0 && (
                            <div style={{ display:"flex", gap:3, marginTop:3, flexWrap:"wrap" }}>
                              {Object.entries(m.reactions).filter(([,v])=>v>0).map(([k,v])=>(
                                <span key={k} onClick={()=>reactGroupMsg(curGroup.id,m.id,k)} style={{ background:dark?"rgba(255,255,255,.08)":"rgba(26,92,42,.06)", borderRadius:20, padding:"2px 7px", fontSize:12, cursor:"pointer" }}>{k} {v}</span>
                              ))}
                            </div>
                          )}
                          <div style={{ fontSize:9, color:C.muted, marginTop:3, textAlign:mine?"right":"left" }}>{m.time}{mine&&" ✓✓"}</div>
                        </div>
                        {mine && <AvatarDisplay name={ME.name} photo={myPhoto} size={28} />}
                      </div>
                    </div>
                  );
                })}
                <div ref={groupEnd} />
              </div>

              {/* Input */}
              <div style={{ padding:"12px 16px", borderTop:`1px solid ${C.border}`, display:"flex", gap:8, alignItems:"center" }}>
                {canMsg ? (
                  <>
                    <button onClick={()=>{const emojis=["😊","😂","🙏","❤️","🔥","💯","👍","😮","السلام عليكم!","جزاكم الله خيراً"]; setGroupDraft(d=>d+emojis[Math.floor(Math.random()*emojis.length)]);}} style={{ width:36,height:36,borderRadius:"50%",background:C.card2,border:`1px solid ${C.border}`,cursor:"pointer",fontSize:18,flexShrink:0 }}>😊</button>
                    <input value={groupDraft} onChange={e=>setGroupDraft(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendGroupMsg();}}} placeholder="Message group…" style={{ ...inp, borderRadius:22, flex:1 }} />
                    <button onClick={sendGroupMsg} style={{ width:42,height:42,borderRadius:"50%",background:`linear-gradient(135deg,${C.navy},${C.nDark})`,border:"none",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:18,color:"#fff",flexShrink:0 }}>➤</button>
                  </>
                ) : (
                  <div style={{ flex:1, textAlign:"center", color:C.muted, fontSize:13, padding:"8px" }}>🔒 Only admins can send messages</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  // ── STUDENT PROFILE VIEWER ────────────────────────────────────────────────
  const renderStudentProfile = () => {
    const allStudents = [{...ME,id:1,bio:"Computer Science student at OIU. Passionate about algorithms and AI.",skills:["Python","React","DSA"],status:"online"},...STUDENTS.map(s=>({...s,skills:["Research","Study"]}))];
    const s = allStudents.find(x=>x.id===viewingProfile);
    if(!s) return null;
    const st = fStatus(s.id);
    const myGroupsWith = groups.filter(g=>g.members.find(m=>m.id===ME.id)&&g.members.find(m=>m.id===s.id));
    const mutualFriends = STUDENTS.filter(x=>friends.includes(x.id)&&x.id!==s.id).slice(0,4);
    const theirPosts = posts.filter(p=>p.author_id===s.id);
    return (
      <div>
        <button onClick={()=>setViewingProfile(null)} style={{ ...btnP, padding:"7px 14px", fontSize:12, marginBottom:16, background:C.card2, color:C.muted, border:`1px solid ${C.border}` }}>← Back</button>
        {/* Cover + Avatar */}
        <div style={{ ...crd, overflow:"hidden", marginBottom:16 }}>
          <div style={{ height:160, background:`linear-gradient(135deg,${C.nDark},${C.navy},${C.gold}33)`, position:"relative" }}>
            <div style={{ position:"absolute", bottom:-28, left:24, width:80, height:80, borderRadius:24, border:`4px solid ${C.card}`, background:C.card, overflow:"hidden" }}>
              <AvatarDisplay name={s.name} photo={s.id===1?myPhoto:null} size={80}/>
            </div>
          </div>
          <div style={{ padding:"38px 24px 20px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", flexWrap:"wrap", gap:10 }}>
              <div>
                <div style={{ fontSize:22, fontWeight:900, color:C.text }}>{s.name}</div>
                <div style={{ fontSize:13, color:C.muted }}>{s.college?.replace("Faculty of ","")} · Year {s.year}</div>
                <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:4 }}>
                  <div style={{ width:8, height:8, borderRadius:"50%", background:s.status==="online"?"#2e7d32":"#bbb" }}/>
                  <span style={{ fontSize:12, color:s.status==="online"?"#2e7d32":C.muted }}>{s.status==="online"?"Online now":"Offline"}</span>
                </div>
              </div>
              <div style={{ display:"flex", gap:8 }}>
                {s.id!==1 && (
                  st==="friend"
                    ? <><button onClick={()=>openChat(s.id)} style={{ ...btnP, padding:"9px 20px" }}>💬 Message</button>
                        <button onClick={()=>{ callState?setCallState(null):setCallState({type:"voice",person:s,active:true}); }} style={{ background:"#e8f5e9", color:"#2e7d32", border:"none", borderRadius:10, padding:"9px 16px", fontWeight:700, cursor:"pointer" }}>📞 Call</button></>
                    : st==="sent"
                      ? <button disabled style={{ background:C.input, color:C.muted, border:"none", borderRadius:10, padding:"9px 20px", fontWeight:700 }}>Sent ✓</button>
                      : <button onClick={()=>sendReq(s.id)} style={{ ...btnP, padding:"9px 20px" }}>👋 Add Friend</button>
                )}
              </div>
            </div>
            {/* Bio */}
            {s.bio && <p style={{ fontSize:13, color:C.muted, lineHeight:1.6, marginTop:12, borderTop:`1px solid ${C.border}`, paddingTop:12 }}>{s.bio}</p>}
          </div>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10, marginBottom:16 }}>
          {[["🎓",s.gpa,"GPA"],["🏆","#"+(s.rank||"?"),"Rank"],["⭐",s.points||"—","Points"]].map(([icon,val,lbl])=>(
            <div key={lbl} style={{ ...crd, padding:14, textAlign:"center" }}>
              <div style={{ fontSize:20 }}>{icon}</div>
              <div style={{ fontSize:18, fontWeight:900, color:C.navy }}>{val}</div>
              <div style={{ fontSize:10, color:C.muted }}>{lbl}</div>
            </div>
          ))}
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14 }}>
          {/* Mutual Friends */}
          <div style={{ ...crd, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:800, color:C.navy, marginBottom:10 }}>👥 Mutual Friends</div>
            {mutualFriends.length>0 ? mutualFriends.map(mf=>(
              <div key={mf.id} onClick={()=>setViewingProfile(mf.id)} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", cursor:"pointer" }}>
                <AvatarDisplay name={mf.name} size={32} badge={mf.status==="online"}/>
                <div style={{ fontSize:12, color:C.text, fontWeight:600 }}>{mf.name.split(" ")[0]}</div>
              </div>
            )) : <div style={{ fontSize:12, color:C.muted }}>No mutual friends</div>}
          </div>
          {/* Shared Groups */}
          <div style={{ ...crd, padding:16 }}>
            <div style={{ fontSize:13, fontWeight:800, color:C.navy, marginBottom:10 }}>🫂 Groups in Common</div>
            {myGroupsWith.length>0 ? myGroupsWith.map(g=>(
              <div key={g.id} onClick={()=>{setActiveGroup(g.id);nav("groups");}} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", cursor:"pointer" }}>
                <div style={{ width:28, height:28, borderRadius:8, background:`linear-gradient(135deg,${C.navy},${C.nDark})`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:14 }}>{g.icon}</div>
                <div style={{ fontSize:12, color:C.text, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{g.name}</div>
              </div>
            )) : <div style={{ fontSize:12, color:C.muted }}>No groups in common</div>}
          </div>
        </div>
        {/* Their posts */}
        {theirPosts.length>0 && (
          <div style={{ marginTop:16 }}>
            <div style={{ fontSize:14, fontWeight:800, color:C.navy, marginBottom:10 }}>📝 Posts</div>
            {theirPosts.map(p=>(
              <PostCard key={p.id} post={p} me={ME} myPhoto={myPhoto} friends={friends} fStatus={fStatus} sendReq={sendReq} openChat={openChat}
                onReact={reactPost} onComment={addComment} onPin={pinPost} onDelete={deletePost} onVotePoll={votePoll} dark={dark} C={C} push={push}/>
            ))}
          </div>
        )}
      </div>
    );
  };

  // ── CALL UI (inlined, no nested component to avoid hooks-in-nested-component error) ──
  const renderCallOverlay = () => {
    if(!callState) return null;
    const mins = String(Math.floor(callDuration/60)).padStart(2,"0");
    const secs = String(callDuration%60).padStart(2,"0");
    return (
      <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.85)", zIndex:900, display:"flex", alignItems:"center", justifyContent:"center" }}>
        <div style={{ background:`linear-gradient(160deg,${C.nDark},#0a2410)`, borderRadius:28, padding:40, width:"100%", maxWidth:360, textAlign:"center", boxShadow:"0 32px 80px rgba(0,0,0,.6)", border:`1px solid rgba(201,164,62,.2)` }}>
          <div style={{ fontSize:12, fontWeight:700, color:C.gold, letterSpacing:1.5, textTransform:"uppercase", marginBottom:20 }}>
            {callState.active ? `${callState.type==="video"?"📹 Video":"📞 Voice"} Call — ${mins}:${secs}` : `Incoming ${callState.type} call…`}
          </div>
          <div style={{ width:100, height:100, borderRadius:30, margin:"0 auto 16px", border:`4px solid ${C.gold}`, overflow:"hidden", position:"relative" }}>
            <AvatarDisplay name={callState.person?.name||"Unknown"} size={100}/>
            {callState.type==="video"&&callState.active&&!callCamOff && <div style={{ position:"absolute", inset:0, background:"rgba(0,100,0,.4)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:32 }}>📹</div>}
          </div>
          <div style={{ fontSize:20, fontWeight:900, color:"#fff", marginBottom:4 }}>{callState.person?.name||"Unknown"}</div>
          <div style={{ fontSize:13, color:"rgba(255,255,255,.5)", marginBottom:30 }}>{callState.person?.college?.replace("Faculty of ","")||""}</div>
          {callState.active ? (
            <div style={{ display:"flex", justifyContent:"center", gap:14 }}>
              {[
                {icon:callMuted?"🔇":"🎙️",label:callMuted?"Unmute":"Mute",fn:()=>setCallMuted(m=>!m),bg:callMuted?"#c62828":null},
                callState.type==="video"&&{icon:callCamOff?"📵":"📹",label:callCamOff?"Start Cam":"Stop Cam",fn:()=>setCallCamOff(m=>!m),bg:callCamOff?"#c62828":null},
                {icon:callSpeaker?"🔊":"🔈",label:"Speaker",fn:()=>setCallSpeaker(s=>!s)},
                {icon:"📞",label:"End Call",fn:()=>setCallState(null),bg:"#c62828",lg:true},
              ].filter(Boolean).map(b=>(
                <div key={b.label} onClick={b.fn} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:5, cursor:"pointer" }}>
                  <div style={{ width:56, height:56, borderRadius:18, background:b.bg?`linear-gradient(135deg,${b.bg},${b.bg}bb)`:"rgba(255,255,255,.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:24, border:`1.5px solid ${b.bg?"transparent":"rgba(255,255,255,.15)"}`, transition:"background .2s" }}>{b.icon}</div>
                  <span style={{ fontSize:10, color:"rgba(255,255,255,.5)", fontWeight:600 }}>{b.label}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ display:"flex", justifyContent:"center", gap:24 }}>
              <div onClick={()=>setCallState(null)} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:"pointer" }}>
                <div style={{ width:64, height:64, borderRadius:20, background:"linear-gradient(135deg,#c62828,#b71c1c)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:28 }}>📵</div>
                <span style={{ fontSize:11, color:"rgba(255,255,255,.5)" }}>Decline</span>
              </div>
              <div onClick={()=>setCallState(cs=>({...cs,active:true}))} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, cursor:"pointer" }}>
                <div style={{ width:64, height:64, borderRadius:20, background:"linear-gradient(135deg,#2e7d32,#1b5e20)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:28 }}>📞</div>
                <span style={{ fontSize:11, color:"rgba(255,255,255,.5)" }}>Accept</span>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  };

  const pageMap = {
    dashboard:     renderDashboard,
    feed:          renderFeed,
    channels:      renderChannels,
    chat:          renderChat,
    groups:        renderGroups,
    people:        renderPeople,
    assignments:   renderAssignments,
    timetable:     renderTimetable,
    announcements: renderAnnouncements,
    events:        renderEvents,
    leaderboard:   renderLeaderboard,
    rooms:         renderRooms,
    notifications: renderNotifications,
    profile:       renderProfile,
    grades:        renderGrades,
    library:       renderLibrary,
    finance:       renderFinance,
    prayer:        renderPrayer,
    tutor:         renderTutor,
    quiz:          renderQuiz,
    map:           renderMap,
    settings:      renderSettings,
    // ── NEW PAGES ──────────────────────────────────────────────────────────
    planner:       renderPlanner,
    pomodoro:      renderPomodoro,
    notes:         renderNotes,
    gpagoals:      renderGpaGoals,
    cafeteria:     renderCafeteria,
    sports:        renderSports,
    directory:     renderDirectory,
    clubs:         renderClubs,
    elections:     renderElections,
    report:        renderReport,
    analytics:     renderAnalytics,
    studentprofile: renderStudentProfile,
  };

  return (
    <div style={{ minHeight:"100vh", background:C.bg, fontFamily:"'DM Sans','Segoe UI',sans-serif", color:C.text, direction:t.dir }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;9..40,600;9..40,700;9..40,800;9..40,900&family=Amiri:wght@400;700&display=swap');*{box-sizing:border-box;margin:0;padding:0}::-webkit-scrollbar{width:5px;height:5px}::-webkit-scrollbar-thumb{background:rgba(26,92,42,.2);border-radius:3px}@keyframes fadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.5;transform:scale(1.4)}}`}</style>

      {/* HEADER */}
      <header style={{ background:C.header, height:62, display:"flex", alignItems:"center", padding:"0 22px", gap:12, position:"sticky", top:0, zIndex:300, boxShadow:"0 2px 20px rgba(0,0,0,.25)" }}>
        <div style={{ display:"flex", alignItems:"center", gap:11, flexShrink:0 }}>
          <svg width="36" height="36" viewBox="0 0 100 120" fill="none"><path d="M50 5 L92 24 L92 72 Q92 102 50 118 Q8 102 8 72 L8 24 Z" fill="#0f3d1a" stroke="#c9a43e" strokeWidth="3"/><path d="M50 13 L85 30 L85 70 Q85 97 50 111 Q15 97 15 70 L15 30 Z" fill="none" stroke="#c9a43e" strokeWidth="1.5"/><text x="50" y="73" textAnchor="middle" fontFamily="Georgia,serif" fontWeight="900" fontSize="24" fill="#c9a43e">OIU</text><line x1="32" y1="80" x2="68" y2="80" stroke="#c9a43e" strokeWidth="1.2"/><text x="50" y="91" textAnchor="middle" fontFamily="serif" fontSize="8.5" fill="rgba(201,164,62,.7)">١٣٣٢ هـ</text></svg>
          <div><div style={{ fontFamily:"'Amiri',serif", fontSize:14, color:"#fff", fontWeight:700 }}>{t.portal}</div><div style={{ fontSize:9, color:"rgba(255,255,255,.4)", letterSpacing:.6 }}>جامعة أم درمان الإسلامية</div></div>
        </div>
        <div style={{ flex:1, display:"flex", justifyContent:"center", gap:4 }}>
          {[
            {icon:"🏠",pg:"dashboard",tip:"Home"},
            {icon:"📣",pg:"feed",tip:"Feed"},
            {icon:"👥",pg:"people",tip:"People",badge:incomingCount},
            {icon:"💬",pg:"chat",tip:"Messages",badge:unreadCount},
            {icon:"🫂",pg:"groups",tip:"Groups",badge:unreadGroupCount},
            {icon:"🔔",pg:"notifications",tip:"Notifications",badge:unreadNotifs},
          ].map(({icon,pg,tip,badge})=>(
            <button key={pg} onClick={()=>nav(pg)} title={tip} style={{ position:"relative", width:44, height:44, borderRadius:12, background:page===pg?"rgba(201,164,62,.25)":"rgba(255,255,255,.08)", color:"#fff", border:`1.5px solid ${page===pg?"rgba(201,164,62,.5)":"rgba(255,255,255,.12)"}`, cursor:"pointer", fontSize:20, display:"flex", alignItems:"center", justifyContent:"center", transition:"background .15s" }}>
              {icon}
              {badge>0 && <span style={{ position:"absolute", top:-2, right:-2, minWidth:17, height:17, background:"#c62828", borderRadius:9, fontSize:9, fontWeight:800, display:"grid", placeItems:"center", color:"#fff", border:"2px solid #0f3d1a" }}>{badge}</span>}
              {page===pg && <div style={{ position:"absolute", bottom:-6, width:20, height:3, background:C.gold, borderRadius:2 }}/>}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <button onClick={()=>setLang(l=>l==="en"?"ar":"en")} style={{ height:34, borderRadius:20, background:"rgba(201,164,62,.18)", color:C.gold, border:`1px solid rgba(201,164,62,.35)`, cursor:"pointer", fontSize:12, fontWeight:800, padding:"0 13px", letterSpacing:.3 }}>{t.langBtn}</button>
          <button onClick={()=>setDark(d=>!d)} title={dark?"Light mode":"Dark mode"} style={{ width:36, height:36, borderRadius:"50%", background:"rgba(255,255,255,.08)", color:"#fff", border:"1px solid rgba(255,255,255,.12)", cursor:"pointer", fontSize:16, display:"flex", alignItems:"center", justifyContent:"center" }}>{dark?"☀️":"🌙"}</button>
          {/* Status picker */}
          <div style={{ position:"relative" }}>
            <button onClick={()=>setShowStatusPicker(s=>!s)} title="Set status" style={{ height:36, borderRadius:20, background:"rgba(255,255,255,.08)", border:"1px solid rgba(255,255,255,.12)", cursor:"pointer", padding:"0 10px", display:"flex", alignItems:"center", gap:5, color:"#fff", fontSize:12, fontWeight:700 }}>
              <span style={{ fontSize:16 }}>{myStatus.emoji}</span>
              <span style={{ maxWidth:70, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{myStatus.text}</span>
            </button>
            {showStatusPicker && (
              <div style={{ position:"absolute", top:"calc(100% + 8px)", right:0, background:C.card, border:`1px solid ${C.border}`, borderRadius:16, padding:10, zIndex:400, width:220, boxShadow:"0 8px 32px rgba(0,0,0,.25)" }}>
                <div style={{ fontSize:12, fontWeight:800, color:C.navy, marginBottom:8, padding:"0 4px" }}>Set your status</div>
                <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                  {STATUS_OPTIONS.map(s=>(
                    <button key={s.text} onClick={()=>{setMyStatus(s);setShowStatusPicker(false);push("Status updated: "+s.emoji+" "+s.text,"success");}} style={{ display:"flex", alignItems:"center", gap:8, background:myStatus.text===s.text?`rgba(26,92,42,.1)`:"none", border:"none", borderRadius:8, padding:"7px 10px", cursor:"pointer", textAlign:"left", width:"100%" }}>
                      <span style={{ fontSize:18 }}>{s.emoji}</span>
                      <span style={{ fontSize:13, color:C.text, fontWeight:myStatus.text===s.text?700:400 }}>{s.text}</span>
                      {myStatus.text===s.text && <span style={{ marginLeft:"auto", color:C.gold }}>✓</span>}
                    </button>
                  ))}
                  <div style={{ borderTop:`1px solid ${C.border}`, marginTop:6, paddingTop:6 }}>
                    <input onKeyDown={e=>{if(e.key==="Enter"&&e.target.value.trim()){setMyStatus({emoji:"✏️",text:e.target.value.trim()});setShowStatusPicker(false);push("Custom status set!","success");}}} placeholder="Custom status…" style={{ width:"100%", padding:"7px 10px", border:`1px solid ${C.border}`, borderRadius:8, fontSize:12, fontFamily:"inherit", outline:"none", background:C.input, color:C.text, boxSizing:"border-box" }}/>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div onClick={()=>nav("profile")} style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(255,255,255,.08)", borderRadius:22, padding:"4px 14px 4px 4px", cursor:"pointer", border:"1px solid rgba(255,255,255,.12)" }}>
            <AvatarDisplay name={ME.name} photo={myPhoto} size={28} />
            <span style={{ color:"#fff", fontSize:12, fontWeight:700 }}>{ME.name.split(" ")[0]}</span>
          </div>
        </div>
      </header>

      <div style={{ display:"flex" }}>
        {/* SIDEBAR */}
        <nav style={{ width:228, background:C.sidebar, borderRight:`1px solid ${C.border}`, display:"flex", flexDirection:"column", position:"sticky", top:62, height:"calc(100vh - 62px)", overflowY:"auto", flexShrink:0 }}>
          <div style={{ padding:"14px 14px", borderBottom:`1px solid ${C.border}` }}>
            <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:10 }}>
              <AvatarDisplay name={ME.name} photo={myPhoto} size={44} ring />
              <div><div style={{ fontSize:13, fontWeight:800, color:C.text }}>{ME.name}</div><div style={{ fontSize:10, color:C.muted }}>{ME.department}</div><div style={{ fontSize:10, color:C.muted }}>Year {ME.year} · GPA {ME.gpa}</div></div>
            </div>
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:4 }}>
              {[["#"+ME.rank,"Rank"],[""+ME.gpa,"GPA"],[""+friends.length,"Friends"]].map(([v,l])=>(
                <div key={l} style={{ background:C.card2, borderRadius:8, padding:"5px 3px", textAlign:"center", border:`1px solid ${C.border}` }}><div style={{ fontSize:13, fontWeight:900, color:C.navy }}>{v}</div><div style={{ fontSize:9, color:C.muted, marginTop:1 }}>{l}</div></div>
              ))}
            </div>
          </div>
          <div style={{ flex:1, padding:"8px" }}>
            {[
              {section:"🏠",sectionLabel:"Home",items:[
                {icon:"🏠",label:"Home",pg:"dashboard"},
                {icon:"📣",label:"Feed",pg:"feed"},
                {icon:"📡",label:"Channels",pg:"channels"},
              ]},
              {section:"🎓",sectionLabel:"Academic",items:[
                {icon:"📝",label:"Assignments",pg:"assignments",badge:pendingAsgn},
                {icon:"🎓",label:"Grades",pg:"grades"},
                {icon:"🗓",label:"Timetable",pg:"timetable"},
                {icon:"📢",label:"Notices",pg:"announcements"},
                {icon:"📅",label:"Events",pg:"events"},
                {icon:"🏆",label:"Leaderboard",pg:"leaderboard"},
                {icon:"🧑‍💻",label:"Study Rooms",pg:"rooms"},
              ]},
              {section:"🛎️",sectionLabel:"Services",items:[
                {icon:"📚",label:"Library",pg:"library"},
                {icon:"💰",label:"Finance",pg:"finance"},
                {icon:"🕌",label:"Prayer",pg:"prayer"},
                {icon:"🗺",label:"Map",pg:"map"},
                {icon:"🍽️",label:"Cafeteria",pg:"cafeteria"},
                {icon:"🏋️",label:"Sports",pg:"sports"},
                {icon:"🔎",label:"Directory",pg:"directory"},
                {icon:"🎙️",label:"Clubs",pg:"clubs"},
              ]},
              {section:"🧠",sectionLabel:"Study Tools",items:[
                {icon:"🤖",label:"Kaido AI",pg:"tutor"},
                {icon:"🧠",label:"Exam Quiz",pg:"quiz"},
                {icon:"📅",label:"Planner",pg:"planner"},
                {icon:"⏱️",label:"Pomodoro",pg:"pomodoro"},
                {icon:"📝",label:"Notes",pg:"notes"},
                {icon:"🏅",label:"GPA Goals",pg:"gpagoals"},
              ]},
              {section:"👥",sectionLabel:"Connect",items:[
                {icon:"👥",label:"People",pg:"people",badge:incomingCount},
                {icon:"💬",label:"Messages",pg:"chat",badge:unreadCount},
                {icon:"🫂",label:"Groups",pg:"groups",badge:unreadGroupCount},
                {icon:"🔔",label:"Notifications",pg:"notifications",badge:unreadNotifs},
                {icon:"👤",label:"Profile",pg:"profile"},
                {icon:"⚙️",label:"Settings",pg:"settings"},
              ]},
              {section:"➕",sectionLabel:"More",items:[
                {icon:"🗳️",label:"Elections",pg:"elections"},
                {icon:"📊",label:"My Stats",pg:"analytics"},
                {icon:"🚨",label:"Report",pg:"report"},
              ]},
            ].map(({section,sectionLabel,items})=>(
              <div key={section+items[0].pg}>
                <div style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 12px 4px" }}>
                  <span style={{ fontSize:13 }}>{section}</span>
                  <span style={{ fontSize:9, fontWeight:800, color:C.muted, textTransform:"uppercase", letterSpacing:1 }}>{sectionLabel}</span>
                </div>
                {items.map(it=><NavItem key={it.pg} {...it} />)}
              </div>
            ))}
          </div>
          <div style={{ padding:"10px 12px", borderTop:`1px solid ${C.border}` }}>
            <div style={{ fontFamily:"'Amiri',serif", fontSize:10, color:C.gold, textAlign:"center", marginBottom:6 }}>أُوتُوا الْعِلْمَ دَرَجَاتٍ</div>
            {/* Network & Sync status */}
            <div style={{ display:"flex", alignItems:"center", gap:6, padding:"5px 10px", borderRadius:8, marginBottom:6,
              background: syncStatus==="offline" ? "rgba(198,40,40,.08)" : syncStatus==="syncing" ? "rgba(201,164,62,.08)" : "rgba(26,92,42,.07)" }}>
              <div style={{ width:7, height:7, borderRadius:"50%", flexShrink:0,
                background: syncStatus==="offline" ? "#c62828" : syncStatus==="syncing" ? "#c9a43e" : "#2e7d32",
                boxShadow: syncStatus==="syncing" ? "0 0 6px #c9a43e" : "none",
                animation: syncStatus==="syncing" ? "pulse 1s infinite" : "none" }} />
              <span style={{ fontSize:10, fontWeight:700, color: syncStatus==="offline" ? "#c62828" : syncStatus==="syncing" ? "#b8922d" : "#2e7d32" }}>
                {syncStatus==="offline" ? "Offline — local only" : syncStatus==="syncing" ? "Syncing to server…" : "Live · Server DB ✅"}
              </span>
            </div>
            <button onClick={()=>{ DB.clearSession(); ServerDB.clearToken(); onLogout(); }} style={{ display:"flex", alignItems:"center", gap:8, width:"100%", background:"none", border:"none", padding:"7px 10px", borderRadius:9, fontSize:12, fontWeight:700, color:"#c62828", cursor:"pointer" }}>↩ {t.signOut}</button>
          </div>
        </nav>

        {/* MAIN */}
        <main style={{ flex:1, overflowY:"auto", maxHeight:"calc(100vh - 62px)", padding:["chat","channels"].includes(page)?16:24 }}>
          <div style={{ animation:"fadeIn .25s ease" }}>
            {viewingProfile ? renderStudentProfile() : (pageMap[page]||renderDashboard)()}
          </div>
        </main>
      </div>

      {/* CALL OVERLAY */}
      {renderCallOverlay()}

      {/* TOASTS */}
      <div style={{ position:"fixed", bottom:20, right:20, zIndex:9000, display:"flex", flexDirection:"column", gap:8 }}>
        {toasts.map(t=>(
          <div key={t.id} style={{ background:t.type==="success"?"#1a5c2a":t.type==="error"?"#c62828":"#1a3022", color:"#fff", padding:"11px 18px", borderRadius:12, fontSize:13, fontWeight:700, boxShadow:"0 4px 24px rgba(0,0,0,.3)", display:"flex", alignItems:"center", gap:9, borderLeft:`3px solid ${t.type==="success"?"#c9a43e":t.type==="error"?"#ff5252":"rgba(255,255,255,.25)"}`, animation:"fadeIn .3s ease" }}>
            {t.type==="success"?"✅":t.type==="error"?"⚠️":"ℹ️"} {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── OUTER APP WITH AUTH GATE ─────────────────────────────────────────────────
export default function App() {
  const [currentUser, setCurrentUser] = useState(() => DB.getSession());

  const handleLogin = (user) => {
    DB.saveSession(user);
    setCurrentUser(user);
  };

  const handleLogout = () => {
    DB.clearSession();
    setCurrentUser(null);
  };

  if (!currentUser) {
    return <AuthGate onLogin={handleLogin} />;
  }

  return <PortalApp key={currentUser.id} currentUser={currentUser} onLogout={handleLogout} />;
}
