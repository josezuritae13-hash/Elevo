// ===== Configuración: pega aquí los datos de Supabase (Project Settings -> API) =====
const SUPABASE_URL = "https://kirskefjvqjnngltwwwv.supabase.co";
const SUPABASE_KEY = "sb_publishable_GbWTpJsqzrSFHEMC283BOw_WRCgBkvQ";
const db = window.supabase?.createClient
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
  : null;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeColor = value => /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#6d9cff";
const normalizeName = value => String(value ?? "").trim().toLocaleLowerCase("es");
// Corta a 2 decimales (sin redondear), como Idukay
const fmt = n => (n === null ? "–" : String(Math.trunc(n * 100 + (n < 0 ? -1e-6 : 1e-6)) / 100));
const trunc2 = n => Math.trunc(n * 100 + (n < 0 ? -1e-6 : 1e-6)) / 100;
let subjects = [], allAssessments = [], assessments = [], goals = [], plan = [], editId = null, editSubj = null, termFilter = "all";
const charts = {};

// ===== Cálculo académico (funciones puras, sin interfaz) =====
const normalize = (a, scaleMax) => (a.score / a.max_score) * scaleMax;

// Ignora evaluaciones pendientes (score null). Si todas las calificadas tienen peso, usa promedio ponderado.
const simpleAvg = (done, scaleMax) => {
  const weighted = done.every(a => a.weight > 0);
  let sum = 0, w = 0;
  for (const a of done) {
    const p = weighted ? Number(a.weight) : 1;
    sum += normalize(a, scaleMax) * p;
    w += p;
  }
  return sum / w;
};
const typeOf = a => (a.type || "").toLowerCase();

// Si la materia tiene pesos por categoría (ej. aporte 70 / sumativa 30), cada categoría
// calcula su promedio y luego se combinan; solo cuentan las categorías que ya tienen notas.
function average(list, scaleMax) {
  const done = list.filter(a => a.score !== null);
  if (!done.length) return null;
  // Con notas de varios trimestres, el promedio del año es el promedio de los trimestres
  const terms = [...new Set(done.map(a => a.term ?? 1))];
  if (terms.length > 1) {
    const vals = terms.map(t => average(done.filter(a => (a.term ?? 1) === t), scaleMax)).filter(v => v !== null);
    return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : null;
  }
  const cats = subjects.find(s => s.id === done[0].subject_id)?.category_weights;
  if (!cats) return simpleAvg(done, scaleMax);
  let sum = 0, w = 0;
  for (const [c, cw] of Object.entries(cats)) {
    const items = done.filter(a => typeOf(a) === c);
    if (items.length) { sum += simpleAvg(items, scaleMax) * cw; w += cw; }
  }
  return w > 0 ? sum / w : null;
}

// ===== Avisos =====
let tt;
function toast(msg, err = false) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.className = "toast show" + (err ? " err" : "");
  clearTimeout(tt);
  tt = setTimeout(() => (t.className = "toast"), 3600);
}

// ===== Preferencias de interfaz =====
function applyTheme(theme) {
  const selected = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = selected;
  const button = $("btnTheme");
  if (button) {
    button.innerHTML = selected === "dark" ? "<span aria-hidden=\"true\">☼</span>" : "<span aria-hidden=\"true\">◐</span>";
    button.setAttribute("aria-label", selected === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro");
    button.title = selected === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro";
  }
  try { localStorage.setItem("elevate-theme", selected); } catch (_) { /* El almacenamiento puede estar desactivado. */ }
  if (subjects.length && typeof Chart !== "undefined") renderInsights();
}

$("btnTheme")?.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || "dark";
  applyTheme(current === "dark" ? "light" : "dark");
});
applyTheme(document.documentElement.dataset.theme || "dark");

$("yearNow").textContent = String(new Date().getFullYear());
$("authForm")?.addEventListener("submit", event => {
  event.preventDefault();
  $("btnLogin").click();
});
$("togglePass")?.addEventListener("click", () => {
  const input = $("pass");
  const visible = input.type === "password";
  input.type = visible ? "text" : "password";
  $("togglePass").setAttribute("aria-label", visible ? "Ocultar contraseña" : "Mostrar contraseña");
  $("togglePass").title = visible ? "Ocultar contraseña" : "Mostrar contraseña";
});

// ===== Autenticación =====
const creds = () => ({ email: $("email").value.trim(), password: $("pass").value });
function setAuthBusy(busy) {
  $("btnLogin").disabled = busy;
  $("btnSignup").disabled = busy;
  $("btnLogin").innerHTML = busy ? "Conectando…" : "<span>Iniciar sesión</span><span aria-hidden=\"true\">→</span>";
}
function validateCredentials() {
  const email = $("email"), pass = $("pass");
  if (!email.value.trim() || !email.validity.valid) {
    $("authMsg").textContent = "Escribe un correo electrónico válido.";
    email.focus();
    return false;
  }
  if (pass.value.length < 6) {
    $("authMsg").textContent = "La contraseña debe tener al menos 6 caracteres.";
    pass.focus();
    return false;
  }
  $("authMsg").textContent = "";
  $("authMsg").classList.remove("success");
  return true;
}

if (!db) {
  $("authMsg").textContent = "No se pudo cargar Supabase. Comprueba tu conexión a internet y recarga la página.";
  $("btnLogin").disabled = true;
  $("btnSignup").disabled = true;
} else {
  $("btnLogin").onclick = async () => {
    if (!validateCredentials()) return;
    setAuthBusy(true);
    try {
      const { error } = await db.auth.signInWithPassword(creds());
      $("authMsg").textContent = error ? error.message : "";
      $("authMsg").classList.remove("success");
    } catch (error) {
      $("authMsg").textContent = error.message || "No se pudo iniciar sesión. Inténtalo de nuevo.";
      $("authMsg").classList.remove("success");
    } finally { setAuthBusy(false); }
  };
  $("btnSignup").onclick = async () => {
    if (!validateCredentials()) return;
    setAuthBusy(true);
    try {
      const { data, error } = await db.auth.signUp(creds());
      $("authMsg").textContent = error ? error.message : data.session ? "Cuenta creada correctamente." : "Revisa tu correo para confirmar la cuenta.";
      $("authMsg").classList.toggle("success", !error);
    } catch (error) {
      $("authMsg").textContent = error.message || "No se pudo crear la cuenta. Inténtalo de nuevo.";
      $("authMsg").classList.remove("success");
    } finally { setAuthBusy(false); }
  };
  $("btnOut").onclick = async () => {
    const { error } = await db.auth.signOut();
    if (error) toast(error.message, true);
  };

  db.auth.onAuthStateChange((_event, session) => {
    $("auth").hidden = !!session;
    $("app").hidden = !session;
    if (session) {
      const email = session.user.email || "Estudiante";
      $("who").textContent = email;
      $("sidebarEmail").textContent = email;
      load();
    } else {
      subjects = []; allAssessments = []; assessments = []; goals = []; plan = [];
      Object.values(charts).forEach(chart => chart?.destroy());
    }
  });
}

// ===== Datos =====
let loadingData = false;
async function load() {
  if (!db || loadingData) return;
  loadingData = true;
  try {
    const [s, a, g, p] = await Promise.all([
      db.from("subjects").select("*").order("created_at"),
      db.from("assessments").select("*").order("date", { ascending: false, nullsFirst: false }),
      db.from("goals").select("*").order("created_at", { ascending: false }),
      db.from("actions").select("*").order("created_at")
    ]);
    const err = s.error || a.error || g.error || p.error;
    if (err) { toast(err.message, true); return; }
    subjects = s.data || [];
    allAssessments = a.data || [];
    assessments = termView();
    goals = g.data || [];
    plan = p.data || [];
    render();
    renderInsights();
    renderGoals();
    fillCalc();
  } catch (error) {
    toast(error.message || "No se pudieron cargar tus datos.", true);
  } finally {
    loadingData = false;
  }
}

function render() {
  const sel = $("aSubject"), prev = sel.value;
  sel.innerHTML = subjects.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  if (prev) sel.value = prev;
  syncMax();

  const pcts = [];
  $("subjects").innerHTML = subjects.map(s => {
    const list = assessments.filter(a => a.subject_id === s.id);
    const avg = average(list, s.scale_max);
    const pending = list.filter(a => a.score === null).length;
    const pct = avg === null ? 0 : (avg / s.scale_max) * 100;
    if (avg !== null) pcts.push((trunc2(avg) / s.scale_max) * 10); // como Idukay: cada materia cortada a 2 decimales
    return `<article class="card subj" style="--c:${safeColor(s.color)}">
      <strong>${esc(s.name)}</strong>
      <span class="muted">${esc(s.period || "Sin periodo")} · escala 0–${s.scale_max}${s.category_weights ? " · " + Object.entries(s.category_weights).map(([k, v]) => k + " " + v + "%").join(" + ") : ""}</span>
      <div class="big">${fmt(avg)}</div>
      <span class="muted">${catSummary(s, list)}</span>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <span class="muted">${list.length} evaluaciones${s.category_weights && list.some(a => !(typeOf(a) in s.category_weights)) ? " · hay notas sin categoría: edita su tipo" : ""}${missingCats(s, list).length ? " · falta " + missingCats(s, list).join(", ") + " (provisional)" : ""}${pending ? ` · ${pending} pendientes (promedio provisional)` : ""}</span>
      <div class="row" style="justify-content:flex-start"><button class="ghost" data-edit-s="${s.id}">Editar</button><button class="ghost" data-del-s="${s.id}">Eliminar</button></div>
    </article>`;
  }).join("") || `<p class="muted">Aún no tienes materias. Crea la primera arriba.</p>`;

  const byId = Object.fromEntries(subjects.map(s => [s.id, s]));
  $("assessments").innerHTML = assessments.map(a => `<tr>
    <td>${esc(byId[a.subject_id]?.name)}</td><td>${esc(a.name)}</td><td>${esc(a.type)}</td><td>${a.term ?? 1}</td>
    <td>${a.score === null ? "Pendiente" : `${a.score}/${a.max_score}`}</td>
    <td>${a.weight === null ? "–" : a.weight + "%"}</td><td>${esc(a.date || "–")}</td>
    <td><button class="ghost" data-edit-a="${a.id}">Editar</button> <button class="ghost" data-del-a="${a.id}">Eliminar</button></td></tr>`).join("")
    || `<tr><td colspan="8" class="empty-table">Sin evaluaciones todavía.</td></tr>`;
  if ($("assessmentCount")) $("assessmentCount").textContent = `${assessments.length} REGISTROS`;

  $("avgAll").textContent = pcts.length ? fmt(pcts.reduce((x, y) => x + y, 0) / pcts.length) : "–";
  $("countSub").textContent = subjects.length;
  $("countPend").textContent = assessments.filter(a => a.score === null).length;
}

function syncMax() {
  const s = subjects.find(x => x.id === $("aSubject").value);
  if (s) { $("aMax").value = s.scale_max; fillTypes(s); }
}
$("aSubject").onchange = syncMax;

// ===== Formularios =====
$("subjForm").onsubmit = async e => {
  e.preventDefault();
  if (!db) return toast("No hay conexión con el servicio de datos.", true);
  const row = {
    name: $("sName").value.trim(),
    period: $("sPeriod").value.trim() || null,
    scale_max: +$("sScale").value,
    color: $("sColor").value,
    category_weights: $("sSystem").value === "ap70" ? { formativa: 70, sumativa: 30 } : null
  };
  const q = db.from("subjects");
  const { error } = editSubj ? await q.update(row).eq("id", editSubj) : await q.insert(row);
  if (error) return toast(error.message, true);
  editSubj = null;
  $("sSave").innerHTML = "Agregar materia <span aria-hidden=\"true\">＋</span>";
  $("subjectFormHeading").textContent = "Agregar materia";
  $("sCancel").hidden = true;
  e.target.reset();
  toast("Materia guardada");
  load();
};

$("assForm").onsubmit = async e => {
  e.preventDefault();
  if (!db) return toast("No hay conexión con el servicio de datos.", true);
  if (!$("aSubject").value) return toast("Primero crea una materia", true);
  const score = $("aScore").value, max = +$("aMax").value, w = $("aWeight").value;
  if (!(max > 0) || !Number.isFinite(max)) return toast("La nota máxima debe ser mayor que cero.", true);
  if (score !== "" && (+score < 0 || +score > max)) return toast(`La nota debe estar entre 0 y ${max}.`, true);
  if (w !== "" && (+w < 0 || +w > 100)) return toast("El peso debe estar entre 0 y 100.", true);
  const row = {
    subject_id: $("aSubject").value,
    name: $("aName").value.trim(),
    type: $("aType").value,
    score: score === "" ? null : +score,
    max_score: max,
    term: +$("aTerm").value,
    weight: w === "" ? null : +w,
    date: $("aDate").value || null
  };
  const q = db.from("assessments");
  const { error } = editId ? await q.update(row).eq("id", editId) : await q.insert(row);
  if (error) return toast(error.message, true);
  const keep = $("aSubject").value, keepT = $("aTerm").value;
  e.target.reset();
  $("aSubject").value = keep;
  $("aTerm").value = keepT;
  syncMax();
  editId = null;
  $("aSave").innerHTML = "Guardar evaluación <span aria-hidden=\"true\">＋</span>";
  $("assessmentFormHeading").textContent = "Nueva evaluación";
  $("aCancel").hidden = true;
  toast("Evaluación guardada");
  load();
};

// ===== Eliminar (con confirmación) =====
document.addEventListener("click", async e => {
  const sid = e.target.dataset.delS, aid = e.target.dataset.delA;
  if (e.target.dataset.editA) return startEdit(e.target.dataset.editA);
  if (e.target.dataset.editS) return startEditSubject(e.target.dataset.editS);
  if (sid) {
    const n = assessments.filter(a => a.subject_id === sid).length;
    if (!confirm(`¿Eliminar la materia? Se borrarán también sus ${n} evaluaciones.`)) return;
    const { error } = await db.from("subjects").delete().eq("id", sid);
    if (error) return toast(error.message, true);
    toast("Materia eliminada"); load();
  } else if (aid) {
    if (!confirm("¿Eliminar esta evaluación?")) return;
    const { error } = await db.from("assessments").delete().eq("id", aid);
    if (error) return toast(error.message, true);
    toast("Evaluación eliminada"); load();
  }
});

// ===== Pestañas =====
function showTab(t) {
  const labels = { panel: "Panel general", metas: "Metas y plan", calc: "Calculadora", importar: "Importar de Idukay" };
  document.querySelectorAll("[data-view]").forEach(section => { section.hidden = section.dataset.view !== t; });
  document.querySelectorAll("[data-go]").forEach(button => {
    const active = button.dataset.go === t;
    button.classList.toggle("on", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  if ($("topbarSection")) $("topbarSection").textContent = labels[t] || "Elevate";
}
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => showTab(button.dataset.go)));
showTab("panel");

// ===== Editar evaluación (sirve también para poner la nota a una pendiente) =====
function startEdit(id) {
  const a = assessments.find(x => x.id === id);
  if (!a) return;
  editId = id;
  $("aSubject").value = a.subject_id;
  $("aName").value = a.name;
  fillTypes(subjects.find(x => x.id === a.subject_id), a.type);
  $("aScore").value = a.score ?? "";
  $("aMax").value = a.max_score;
  $("aWeight").value = a.weight ?? "";
  $("aDate").value = a.date ?? "";
  $("aTerm").value = a.term ?? 1;
  $("aSave").textContent = "Actualizar evaluación";
  $("assessmentFormHeading").textContent = "Editar evaluación";
  $("aCancel").hidden = false;
  $("assForm").scrollIntoView({ behavior: "smooth" });
}

// ===== Calculadora: ¿qué nota necesito? =====
function neededScore(list, scaleMax, target, pendingW) {
  const done = list.filter(a => a.score !== null);
  const weighted = done.length > 0 && done.every(a => a.weight > 0);
  let S = 0, W = 0;
  for (const a of done) {
    const p = weighted ? Number(a.weight) : 1;
    S += normalize(a, scaleMax) * p;
    W += p;
  }
  return { need: (target * (W + pendingW) - S) / pendingW, S, W };
}

function fillCalc() {
  const sel = $("cSubject"), prev = sel.value;
  sel.innerHTML = $("aSubject").innerHTML;
  if (prev) sel.value = prev;
  const s = subjects.find(x => x.id === sel.value);
  if (!s) return;
  const cats = s.category_weights;
  $("cCatWrap").hidden = !cats;
  $("cPendWrap").hidden = !!cats;
  if (cats) {
    const pv = $("cCat").value;
    $("cCat").innerHTML = Object.keys(cats).map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    if (pv) $("cCat").value = pv;
    $("cTarget").max = s.scale_max;
    return;
  }
  const done = assessments.filter(a => a.subject_id === s.id && a.score !== null);
  const weighted = done.length > 0 && done.every(a => a.weight > 0);
  $("cPendLabel").textContent = weighted ? "Peso que falta (%)" : "Evaluaciones que faltan";
  $("cPend").value = weighted ? Math.max(0, 100 - done.reduce((x, a) => x + Number(a.weight), 0)) : 1;
  $("cTarget").max = s.scale_max;
}
$("cSubject").onchange = fillCalc;

$("calcForm").onsubmit = e => {
  e.preventDefault();
  const s = subjects.find(x => x.id === $("cSubject").value);
  if (!s) return toast("Primero crea una materia", true);
  const t = +$("cTarget").value, p = +$("cPend").value, max = s.scale_max;
  if (!Number.isFinite(t) || t < 0 || t > max) return toast(`El objetivo debe estar entre 0 y ${max}.`, true);
  if (!s.category_weights && !(p > 0)) return toast("Indica cuánto falta por evaluar", true);
  if (s.category_weights && !$("cCat").value) return toast("Selecciona la categoría que falta.", true);
  const list = assessments.filter(a => a.subject_id === s.id);
  const r = s.category_weights ? neededByCategory(list, s, t) : neededScore(list, max, t, p);
  const pp = r.p ?? p;
  let msg;
  if (r.need <= 0) msg = "¡Ya tienes asegurado ese objetivo, incluso con 0 en lo que falta!";
  else if (r.need > max) msg = `No es posible: necesitarías ${ceil2(r.need)} y el máximo es ${max}.`;
  else msg = `Necesitas al menos ${ceil2(r.need)} de ${max} en lo que falta.`;
  $("calcOut").hidden = false;
  $("calcOut").innerHTML = `<p class="big">${msg}</p><p class="muted">Cálculo: (${fmt(t)} × ${fmt(r.W + pp)} − ${fmt(r.S)}) ÷ ${fmt(pp)} = ${ceil2(r.need)}.${r.p ? " Se asume que tu promedio en «" + esc($("cCat").value) + "» será esa nota." : ""}</p>`;
};

// ===== Metas (el avance sale de tus notas reales) =====
const currentAvg = id => {
  const s = subjects.find(x => x.id === id);
  return s ? average(allAssessments.filter(a => a.subject_id === id), s.scale_max) : null; // las metas usan todo el año
};
function goalProgress(g) {
  const cur = currentAvg(g.subject_id);
  if (cur === null || g.start_value === null) return 0;
  if (g.target_value <= g.start_value) return Math.min(100, (cur / g.target_value) * 100); // meta de mantener
  return Math.max(0, Math.min(100, ((cur - g.start_value) / (g.target_value - g.start_value)) * 100));
}

function renderGoals() {
  $("gSubject").innerHTML = $("aSubject").innerHTML;
  $("countGoals").textContent = goals.filter(g => g.status === "active").length;
  const label = { active: "Activa", paused: "Pausada", completed: "Completada", cancelled: "Cancelada" };
  const btn = (st, txt, cls, id) => `<button class="${cls}" data-g="${st}" data-id="${id}">${txt}</button>`;
  $("goals").innerHTML = goals.map(g => {
    const s = subjects.find(x => x.id === g.subject_id), pct = Math.round(goalProgress(g));
    const open = g.status === "active" || g.status === "paused";
    return `<article class="card subj" style="--c:${safeColor(s?.color)}">
      <div class="row"><strong>${esc(g.title)}</strong><span class="tag">${label[g.status]}</span></div>
      <span class="muted">${esc(s?.name || "Sin materia")} · de ${fmt(g.start_value)} a ${fmt(g.target_value)}${g.deadline ? " · hasta " + esc(g.deadline) : ""}</span>
      <div class="big">${pct}%</div><div class="bar"><i style="width:${pct}%"></i></div>
      <span class="muted">Promedio actual: ${fmt(currentAvg(g.subject_id))}</span>
      ${actionsHtml(g)}
      <div class="row">
        ${g.status === "active" ? btn("completed", "Completar", "", g.id) + btn("paused", "Pausar", "ghost", g.id) : ""}
        ${g.status === "paused" ? btn("active", "Reanudar", "", g.id) : ""}
        ${open ? btn("cancelled", "Cancelar", "ghost", g.id) : ""}
        ${btn("del", "Eliminar", "ghost", g.id)}
      </div></article>`;
  }).join("") || `<p class="muted">Aún no tienes metas. Crea la primera arriba.</p>`;
}

$("goalForm").onsubmit = async e => {
  e.preventDefault();
  if (!db) return toast("No hay conexión con el servicio de datos.", true);
  const sid = $("gSubject").value, cur = currentAvg(sid), target = +$("gTarget").value;
  if (!sid) return toast("Primero crea una materia", true);
  if (cur === null) return toast("Registra al menos una nota en esa materia para fijar el punto de partida", true);
  const max = subjects.find(x => x.id === sid).scale_max;
  if (target <= 0 || target > max) return toast(`El objetivo debe estar entre 0 y ${max}`, true);
  const { error } = await db.from("goals").insert({
    subject_id: sid,
    title: $("gTitle").value.trim(),
    start_value: Math.round(cur * 100) / 100,
    target_value: target,
    deadline: $("gDeadline").value || null
  });
  if (error) return toast(error.message, true);
  e.target.reset();
  toast("Meta creada");
  load();
};

document.addEventListener("click", async e => {
  const st = e.target.dataset.g, id = e.target.dataset.id;
  if (!st) return;
  let res;
  if (st === "del") {
    if (!confirm("¿Eliminar esta meta?")) return;
    res = await db.from("goals").delete().eq("id", id);
  } else {
    res = await db.from("goals").update({ status: st }).eq("id", id);
  }
  if (res.error) return toast(res.error.message, true);
  load();
});

// ===== Plan de mejora: acciones ligadas a cada meta =====
const SUGGESTED = [
  "Repasar el tema que más me cuesta",
  "Resolver ejercicios de práctica",
  "Revisar los errores de mi última evaluación",
  "Prepararme para la siguiente prueba"
];
const run = res => (res.error ? toast(res.error.message, true) : load());

function actionsHtml(g) {
  const list = plan.filter(x => x.goal_id === g.id);
  const done = list.filter(x => x.status === "done").length;
  const open = g.status === "active" || g.status === "paused";
  const items = list.map(x => `<li class="act ${x.status}">
    <label class="chk"><input type="checkbox" data-act="toggle" data-id="${x.id}" ${x.status === "done" ? "checked" : ""}>
    <span>${esc(x.description)}${x.due_date ? ` <small class="muted">· ${esc(x.due_date)}</small>` : ""}</span></label>
    <button class="ghost sm" data-act="del" data-id="${x.id}" title="Eliminar acción">✕</button></li>`).join("");
  const have = list.map(x => x.description);
  const chips = SUGGESTED.filter(t => !have.includes(t))
    .map(t => `<button class="chip" data-act="add" data-goal="${g.id}" data-text="${esc(t)}">+ ${esc(t)}</button>`).join("");
  return `<div class="plan"><strong>Plan de mejora</strong> <span class="muted">${done}/${list.length} acciones</span>
    <ul>${items || `<li class="muted">Aún no hay acciones.</li>`}</ul>
    ${open ? `<form class="actForm" data-goal="${g.id}"><input placeholder="Nueva acción" required maxlength="120"><input type="date"><button>Añadir</button></form><div class="chips">${chips}</div>` : ""}</div>`;
}

const saveAction = (goal_id, description, due_date) =>
  db.from("actions").insert({ goal_id, description, due_date }).then(run);

document.addEventListener("click", async e => {
  const d = e.target.dataset;
  if (d.act === "add") saveAction(d.goal, d.text, null);
  else if (d.act === "del") run(await db.from("actions").delete().eq("id", d.id));
});

document.addEventListener("change", async e => {
  if (e.target.dataset.act !== "toggle") return;
  run(await db.from("actions").update({ status: e.target.checked ? "done" : "pending" }).eq("id", e.target.dataset.id));
});

document.addEventListener("submit", e => {
  const f = e.target.closest(".actForm");
  if (!f) return;
  e.preventDefault();
  saveAction(f.dataset.goal, f.children[0].value.trim(), f.children[1].value || null);
});

// ===== Panel inteligente y gráficos =====
const LOW = 60; // % de la escala bajo el cual una materia pide atención
const localDate = ms => new Date(ms).toLocaleDateString("sv-SE");
const pctOf = (list, s) => {
  const v = average(list, s.scale_max);
  return v === null ? null : (v / s.scale_max) * 100;
};
const generalPct = cutoff => {
  const v = subjects
    .map(s => pctOf(assessments.filter(a => a.subject_id === s.id && (!cutoff || (a.date && a.date <= cutoff))), s))
    .filter(x => x !== null);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
};
// Promedio acumulado de una materia después de cada evaluación con fecha
function evolution(s) {
  const dated = assessments
    .filter(a => a.subject_id === s.id && a.score !== null && a.date)
    .sort((x, y) => x.date.localeCompare(y.date));
  return dated.map((a, i) => ({ date: a.date, pct: pctOf(dated.slice(0, i + 1), s) }));
}

function draw(id, cfg) {
  charts[id]?.destroy();
  charts[id] = new Chart($(id), cfg);
}

function renderInsights() {
  const rows = subjects
    .map(s => ({ s, pct: pctOf(assessments.filter(a => a.subject_id === s.id), s), ev: evolution(s) }))
    .filter(r => r.pct !== null);

  const attn = rows.map(r => {
    const n = r.ev.length, down = n >= 2 && r.ev[n - 1].pct < r.ev[n - 2].pct - 0.5;
    const reason = r.pct < LOW ? `promedio bajo (${fmt(r.pct)}%)` : down ? "su promedio va bajando" : null;
    return reason && { ...r, reason };
  }).filter(Boolean);
  $("attn").innerHTML = attn.map(r => `<li><strong style="color:${safeColor(r.s.color)}">●</strong> ${esc(r.s.name)} · <span class="muted">${esc(r.reason)}</span></li>`).join("")
    || `<li class="muted">${rows.length ? "Ninguna por ahora. ¡Buen trabajo!" : "Aún no hay notas registradas."}</li>`;

  const up = assessments.filter(a => a.score === null && a.date && a.date >= localDate(Date.now()))
    .sort((x, y) => x.date.localeCompare(y.date)).slice(0, 5);
  const byId = Object.fromEntries(subjects.map(s => [s.id, s]));
  $("upcoming").innerHTML = up.map(a => `<li>${esc(a.date)} · ${esc(a.name)} <span class="muted">(${esc(byId[a.subject_id]?.name)})</span></li>`).join("")
    || `<li class="muted">No hay evaluaciones pendientes con fecha.</li>`;

  let tip;
  if (!rows.length) tip = "Registra tu primera nota para ver aquí tu análisis y recomendaciones.";
  else if (attn.length) tip = `Prioriza ${attn[0].s.name}: ${attn[0].reason}. Revisa los errores de su última evaluación y añade una acción a tu plan de mejora.`;
  else if (up.length) tip = `Tu próxima evaluación es "${up[0].name}" el ${up[0].date}. Reserva unos días antes para repasar.`;
  else tip = "Vas con buen ritmo. Mantén tus hábitos y registra cada nota para seguir tu avance.";
  $("tip").textContent = tip;

  const now = generalPct(), before = generalPct(localDate(Date.now() - 30 * 864e5));
  $("chg").textContent = now !== null && before !== null ? (now >= before ? "+" : "") + fmt(now - before) + " pts" : "–";

  if (typeof Chart === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue("--muted").trim();
  Chart.defaults.borderColor = css.getPropertyValue("--border").trim();

  const evs = rows.filter(r => r.ev.length);
  $("chEmpty").hidden = evs.length > 0;
  const labels = [...new Set(evs.flatMap(r => r.ev.map(p => p.date)))].sort();
  draw("chEvo", {
    type: "line",
    data: { labels, datasets: evs.map(r => ({
      label: r.s.name, borderColor: safeColor(r.s.color), backgroundColor: safeColor(r.s.color), tension: 0.3, spanGaps: true,
      data: labels.map(d => { const p = r.ev.filter(q => q.date === d).pop(); return p ? Math.round(p.pct * 10) / 10 : null; })
    })) },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } }
  });
  draw("chBar", {
    type: "bar",
    data: { labels: rows.map(r => r.s.name), datasets: [{
      data: rows.map(r => Math.round(r.pct * 10) / 10), backgroundColor: rows.map(r => safeColor(r.s.color)), borderRadius: 8
    }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100 } } }
  });
}

// ===== Categorías con peso (aporte / sumativa) =====
function missingCats(s, list) {
  if (!s.category_weights) return [];
  return Object.keys(s.category_weights).filter(c => !list.some(a => a.score !== null && typeOf(a) === c));
}

// Nota necesaria en la categoría pendiente, suponiendo que las demás categorías mantienen su promedio
function neededByCategory(list, s, target) {
  const cats = s.category_weights, pend = $("cCat").value, cwp = cats[pend];
  let S = 0, W = 0;
  for (const [c, cw] of Object.entries(cats)) {
    const items = list.filter(a => a.score !== null && typeOf(a) === c);
    if (c !== pend && items.length) { S += simpleAvg(items, s.scale_max) * cw; W += cw; }
  }
  return { need: (target * (W + cwp) - S) / cwp, S, W, p: cwp };
}

// ===== Tipo de evaluación: formativa / sumativa =====
const BASE_TYPES = ["formativa", "sumativa", "examen", "prueba corta", "tarea", "proyecto", "otro"];
// Si la materia tiene categorías con peso, solo se ofrecen esas (así no se cuela un tipo que no cuenta)
function fillTypes(s, extra) {
  const list = s?.category_weights ? Object.keys(s.category_weights) : BASE_TYPES;
  const opts = extra && !list.includes(extra) ? [extra, ...list] : list;
  const want = extra || $("aType").value;
  $("aType").innerHTML = opts.map(t => `<option>${esc(t)}</option>`).join("");
  $("aType").value = opts.includes(want) ? want : opts[0];
}

// ===== Editar materia =====
function startEditSubject(id) {
  const s = subjects.find(x => x.id === id);
  if (!s) return;
  editSubj = id;
  $("sName").value = s.name;
  $("sPeriod").value = s.period ?? "";
  $("sScale").value = String(s.scale_max);
  $("sColor").value = safeColor(s.color);
  $("sSystem").value = s.category_weights ? "ap70" : "";
  $("sSave").textContent = "Actualizar materia";
  $("subjectFormHeading").textContent = "Editar materia";
  $("sCancel").hidden = false;
  $("subjForm").scrollIntoView({ behavior: "smooth" });
}

$("sCancel").onclick = () => {
  editSubj = null;
  $("subjForm").reset();
  $("sSave").innerHTML = "Agregar materia <span aria-hidden=\"true\">＋</span>";
  $("subjectFormHeading").textContent = "Agregar materia";
  $("sCancel").hidden = true;
};
$("aCancel").onclick = () => {
  editId = null;
  $("assForm").reset();
  $("aSave").innerHTML = "Guardar evaluación <span aria-hidden=\"true\">＋</span>";
  $("assessmentFormHeading").textContent = "Nueva evaluación";
  $("aCancel").hidden = true;
  syncMax();
};

// Resumen por categoría en la tarjeta: promedio y cantidad de notas (sirve para comparar con Idukay)
function catSummary(s, list) {
  if (!s.category_weights) return "";
  return Object.keys(s.category_weights).map(c => {
    const items = list.filter(a => a.score !== null && typeOf(a) === c);
    return `${c}: ${items.length ? fmt(simpleAvg(items, s.scale_max)) + " (" + items.length + ")" : "–"}`;
  }).join(" · ");
}

// ===== Trimestres =====
const ceil2 = n => Math.ceil(n * 100 - 1e-6) / 100; // la nota necesaria se redondea hacia arriba
function termView() {
  return termFilter === "all" ? allAssessments : allAssessments.filter(a => (a.term ?? 1) === +termFilter);
}
$("termSel").onchange = e => {
  termFilter = e.target.value;
  if (termFilter !== "all") $("aTerm").value = termFilter;
  assessments = termView();
  render();
  renderInsights();
  renderGoals();
  fillCalc();
};

// ===== Importar desde Idukay (tabla copiada: Aporte y Sumativa por trimestre) =====
const CATS = { formativa: 70, sumativa: 30 };
const PALETTE = ["#4f46e5", "#16a34a", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#ec4899", "#14b8a6"];
let pendingImport = [];

function parseIdukay(text) {
  const rows = text.split(/\r?\n/).map(l => l.split("\t").map(c => c.trim())).filter(r => r.some(Boolean));
  const hi = rows.findIndex(r => r.some(c => /^aporte/i.test(c)) && r.some(c => /^sumativa/i.test(c)));
  if (hi < 0) return { error: "No encontré las columnas Aporte y Sumativa. ¿Copiaste la tabla de calificaciones?" };
  const head = rows[hi];
  let term = 1, cat = null;
  const KNOWN = /^(asignaturas|promedio|trimestre\s*\d*|parcial|examen|proyecto|pro\.\s*recup\.?|pro\.\s*clase|ex\.\s*recup\.?|sup\.?)$/i;
  const cols = head.map(h => {
    const m = h.match(/^trimestre\s*(\d)/i);
    if (m) term = +m[1];
    if (/^aporte/i.test(h)) { cat = "formativa"; return { type: cat, term, label: "Aporte formativo", kind: "agg" }; }
    if (/^sumativa/i.test(h)) { cat = "sumativa"; return { type: cat, term, label: "Sumativa", kind: "agg" }; }
    if (KNOWN.test(h)) { cat = null; return null; }
    // columna desconocida después de Aporte o Sumativa = una actividad
    return cat && h ? { type: cat, term, label: h, kind: "act" } : null;
  });
  const items = [], skipped = new Set();
  for (const r of rows.slice(hi + 1)) {
    const subject = r[0];
    if (!subject || /^[\d.,\-–]+$/.test(subject)) continue;
    const off = Math.max(r.length - head.length, 0); // la fila puede traer una columna más
    cols.forEach((c, i) => {
      const raw = c && r[i + off];
      if (!raw || /^[-–]$/.test(raw)) return;
      const v = parseFloat(raw.replace(",", "."));
      if (Number.isNaN(v)) { skipped.add(subject); return; }
      items.push({ subject, type: c.type, term: c.term, label: c.label, kind: c.kind, score: v });
    });
  }
  return { items, skipped: [...skipped] };
}

function importPlan(text) {
  const r = parseIdukay(text);
  if (r.error) return r;
  const plan = r.items.map(it => {
    const s = subjects.find(x => x.name.trim().toLowerCase() === it.subject.toLowerCase());
    const name = `${it.label} (Idukay)`;
    const inTerm = a => s && a.subject_id === s.id && (a.term ?? 1) === it.term;
    const own = allAssessments.some(a => inTerm(a) && !a.name.endsWith("(Idukay)"));
    const prev = allAssessments.find(a => inTerm(a) && a.name === name);
    const bad = it.score < 0 || it.score > (s?.scale_max ?? 10);
    const hasActs = it.kind === "agg" && r.items.some(x => x.kind === "act" && x.subject === it.subject && x.term === it.term && x.type === it.type);
    const why = own ? "ya tiene tus notas en este trimestre" : bad ? "nota fuera de escala" : hasActs ? "se usan las actividades" : "";
    return { ...it, name, s, prev, why, action: why ? "omitir" : prev ? "actualizar" : "crear" };
  });
  return { plan, skipped: r.skipped };
}

$("impPreview").onclick = () => {
  const rawImport = $("impText").value.trim();
  const acts = parseJsonImport(rawImport);
  if (acts) return previewJson(acts);
  if (rawImport.startsWith("{") || rawImport.startsWith("[")) {
    $("impOut").hidden = false;
    $("impOut").innerHTML = "<p class=\"muted\">El contenido parece JSON, pero no tiene un formato válido de Idukay. Vuelve a copiarlo desde la extensión y pégalo completo.</p>";
    return;
  }
  lastActs = null;
  const r = importPlan(rawImport), out = $("impOut");
  out.hidden = false;
  if (r.error) { pendingImport = []; out.innerHTML = `<p class="muted">${esc(r.error)}</p>`; return; }
  pendingImport = r.plan;
  out.innerHTML = `<div class="wrap"><table><thead><tr><th>Materia</th><th>Trim.</th><th>Actividad</th><th>Tipo</th><th>Nota</th><th>Qué pasará</th></tr></thead><tbody>
    ${r.plan.map(p => `<tr><td>${esc(p.subject)}</td><td>${p.term}</td><td>${esc(p.label)}</td><td>${p.type}</td><td>${fmt(p.score)}</td><td>${p.action}${p.why ? ` <span class="muted">(${esc(p.why)})</span>` : ""}</td></tr>`).join("")}</tbody></table></div>
    ${r.skipped.length ? `<p class="muted">No se importan (nota en letras): ${esc(r.skipped.join(", "))}.</p>` : ""}
    <p class="muted">Las materias importadas usan Formativa 70% + Sumativa 30%. Se omiten las que ya tienen notas tuyas en ese trimestre, para no duplicar.</p>
    <button id="impGo" type="button">Importar</button>`;
  $("impGo").onclick = applyImport;
};

async function applyImport() {
  if (!db) return toast("No hay conexión con el servicio de datos.", true);
  const todo = pendingImport.filter(p => p.action !== "omitir"), made = {};
  if (!todo.length) return toast("No hay nada que importar", true);
  for (const p of todo) {
    let s = p.s || made[normalizeName(p.subject)];
    if (!s) {
      const res = await db.from("subjects").insert({
        name: p.subject, scale_max: 10, color: PALETTE[Object.keys(made).length % PALETTE.length], category_weights: CATS
      }).select().single();
      if (res.error) return toast(res.error.message, true);
      s = made[normalizeName(p.subject)] = res.data;
    } else if (!s.category_weights) {
      const res = await db.from("subjects").update({ category_weights: CATS }).eq("id", s.id);
      if (res.error) return toast(res.error.message, true);
      s.category_weights = CATS;
    }
    const row = { type: p.type, score: p.score, max_score: s.scale_max, term: p.term };
    if (p.kind === "act") {
      // al traer las actividades, se quitan los promedios de Aporte/Sumativa importados antes (no se cuentan dos veces)
      const aggs = allAssessments.filter(a => a.subject_id === s.id && (a.term ?? 1) === p.term && a.type === p.type && /^(Aporte formativo|Sumativa) \(Idukay\)$/.test(a.name));
      for (const a of aggs) await db.from("assessments").delete().eq("id", a.id);
    }
    const { error } = p.prev
      ? await db.from("assessments").update(row).eq("id", p.prev.id)
      : await db.from("assessments").insert({ ...row, subject_id: s.id, name: p.name, date: localDate(Date.now()) });
    if (error) return toast(error.message, true);
  }
  toast("Notas importadas");
  $("impOut").hidden = true;
  $("impText").value = "";
  load();
}

// ===== Importar actividades desde la extensión (JSON de Idukay) =====
const schoolYearStart = () => {
  const d = new Date();
  return `${d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1}-09-01`;
};
$("jFrom").value = schoolYearStart();
$("jT1").value = `${schoolYearStart().slice(0, 4)}-12-18`;
$("jT2").value = `${+schoolYearStart().slice(0, 4) + 1}-03-26`;
let lastActs = null, jsonRows = [];

function parseJsonImport(text) {
  let data;
  try { data = JSON.parse(text.trim()); } catch (e) { return null; }
  if (!data || data.source !== "idukay" || !Array.isArray(data.activities)) return null;
  return data.activities.filter(item => item && typeof item === "object" && typeof item.subject === "string" && typeof item.title === "string")
    .map(item => ({ ...item, score: item.score === null || item.score === undefined || item.score === "" ? null : Number(item.score) }))
    .filter(item => item.score === null || Number.isFinite(item.score));
}

// La extensión no informa si una actividad es formativa o sumativa: se adivina y se puede corregir en la tabla
function guessType(a) {
  const t = String(a.type || "").toLowerCase();
  if (/sumativ/.test(t)) return "sumativa";
  if (/formativ|aporte/.test(t)) return "formativa";
  return /sumativ|\bexamen\b|\bexam\b|control de lectura/i.test(`${a.title} ${a.description}`) ? "sumativa" : "formativa";
}

function planJson(acts) {
  const uniqueActivities = new Map();
  for (const item of acts) {
    const stableKey = [normalizeName(item.subject), normalizeName(item.title), item.date || "sin-fecha"].join("|");
    uniqueActivities.set(stableKey, item);
  }
  const normalizedActivities = [...uniqueActivities.values()];
  const from = $("jFrom").value || "0000";
  const t1 = $("jT1").value || "9999-12-31";
  const t2 = $("jT2").value || "9999-12-31";
  const past = $("jPast").checked;
  const today = localDate(Date.now());
  return normalizedActivities.filter(a => (a.date || "9999") >= from).map(a => {
    const subjectName = String(a.subject || "Sin asignatura").trim();
    const title = String(a.title || "Actividad sin título").trim();
    const date = typeof a.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : null;
    const term = !date || date <= t1 ? 1 : date <= t2 ? 2 : 3;
    const s = subjects.find(x => normalizeName(x.name) === normalizeName(subjectName));
    const candidates = s ? allAssessments.filter(x =>
      x.subject_id === s.id && (x.term ?? 1) === term && normalizeName(x.name) === normalizeName(title)
    ) : [];
    // Primero se busca coincidencia exacta por fecha; solo se usa una coincidencia alternativa si es única.
    const prev = candidates.find(x => (x.date || null) === date) || (candidates.length === 1 ? candidates[0] : null);
    const pendingPast = a.score === null && date && date < today;
    return { ...a, subject: subjectName, title, date, term, s, prev, type: guessType(a), on: !(pendingPast && !past) };
  });
}

function previewJson(acts) {
  lastActs = acts;
  jsonRows = planJson(acts);
  const out = $("impOut");
  out.hidden = false;
  const rows = jsonRows.map((p, i) => `<tr>
    <td><input type="checkbox" data-jrow="${i}" ${p.on ? "checked" : ""}></td>
    <td>${esc(p.subject)}</td><td>${esc(p.title)}</td><td>${esc(p.date || "–")}</td><td>T${p.term}</td>
    <td>${p.score === null ? "Pendiente" : fmt(p.score)}</td>
    <td><select data-jtype="${i}"><option${p.type === "formativa" ? " selected" : ""}>formativa</option><option${p.type === "sumativa" ? " selected" : ""}>sumativa</option></select></td>
    <td>${p.prev ? (p.prev.score === p.score && p.prev.type === p.type ? "ya existe" : "actualizar") : "crear"}</td></tr>`).join("");
  out.innerHTML = `<p class="muted">${jsonRows.length} actividades desde el ${esc($("jFrom").value)}. Revisa el tipo de cada una (formativa o sumativa): la extensión no lo informa y lo adivino por el título.</p>
    <div class="wrap"><table><thead><tr><th></th><th>Materia</th><th>Actividad</th><th>Fecha</th><th>Trim.</th><th>Nota</th><th>Tipo</th><th>Qué pasará</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted">Las materias importadas usan Formativa 70% + Sumativa 30%. Las actividades que ya tienes se reconocen por el nombre y solo se actualiza su nota. Desmarca las que no quieras traer (por ejemplo, materias con nota en letras).</p>
    <button id="impGo" type="button">Importar seleccionadas</button>`;
  $("impGo").onclick = applyJson;
}

$("impOut").addEventListener("change", e => {
  const d = e.target.dataset;
  if (d.jrow !== undefined) jsonRows[+d.jrow].on = e.target.checked;
  if (d.jtype !== undefined) jsonRows[+d.jtype].type = e.target.value;
});
["jFrom", "jT1", "jT2", "jPast"].forEach(id => $(id).addEventListener("change", () => lastActs && previewJson(lastActs)));

async function applyJson() {
  if (!db) return toast("No hay conexión con el servicio de datos.", true);
  const todo = jsonRows.filter(p => p.on);
  if (!todo.length) return toast("No hay actividades seleccionadas", true);
  const made = {}, inserts = [], cleaned = new Set();
  let skipped = 0;
  for (const p of todo) {
    let s = p.s || made[normalizeName(p.subject)];
    if (!s) {
      const res = await db.from("subjects").insert({
        name: p.subject, scale_max: 10, color: PALETTE[Object.keys(made).length % PALETTE.length], category_weights: CATS
      }).select().single();
      if (res.error) return toast(res.error.message, true);
      s = made[normalizeName(p.subject)] = res.data;
    } else if (!s.category_weights) {
      const res = await db.from("subjects").update({ category_weights: CATS }).eq("id", s.id);
      if (res.error) return toast(res.error.message, true);
      s.category_weights = CATS;
    }
    if (p.score !== null && (p.score < 0 || p.score > s.scale_max)) { skipped++; continue; }
    if (!cleaned.has(s.id)) {
      // al traer actividades, se quitan los promedios "(Idukay)" importados antes para no contarlos dos veces
      cleaned.add(s.id);
      for (const a of allAssessments.filter(x => x.subject_id === s.id && /^(Aporte formativo|Sumativa) \(Idukay\)$/.test(x.name))) {
        await db.from("assessments").delete().eq("id", a.id);
      }
    }
    if (p.prev) {
      if (p.prev.score === p.score && p.prev.type === p.type && (p.prev.date || null) === (p.date || null)) continue;
      const patch = { score: p.score, date: p.date || p.prev.date || null };
      if (p.prev.type !== p.type) patch.type = p.type;
      const res = await db.from("assessments").update(patch).eq("id", p.prev.id);
      if (res.error) return toast(res.error.message, true);
    } else {
      inserts.push({
        subject_id: s.id, name: p.title.slice(0, 200), type: p.type, score: p.score, max_score: s.scale_max,
        term: p.term, date: p.date, comment: [p.description, p.notes].filter(Boolean).join("\n").slice(0, 500) || null
      });
    }
  }
  if (inserts.length) {
    const res = await db.from("assessments").insert(inserts);
    if (res.error) return toast(res.error.message, true);
  }
  toast(`Listo: ${inserts.length} actividades nuevas${skipped ? ` (${skipped} fuera de escala omitidas)` : ""}`);
  $("impOut").hidden = true;
  $("impText").value = "";
  lastActs = null;
  load();
}