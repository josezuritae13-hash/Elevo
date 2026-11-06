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
const localDate = ms => new Date(ms).toLocaleDateString("sv-SE");
// Corta a 2 decimales (sin redondear), como Idukay
const fmt = n => (n === null ? "–" : String(Math.trunc(n * 100 + (n < 0 ? -1e-6 : 1e-6)) / 100));
const trunc2 = n => Math.trunc(n * 100 + (n < 0 ? -1e-6 : 1e-6)) / 100;
let subjects = [], allAssessments = [], assessments = [], goals = [], plan = [], editId = null, editSubj = null, termFilter = "all";
const charts = {};
const accountIsTeacher = email => {
  const [name, domain, extra] = String(email || "").trim().toLowerCase().split("@");
  return Boolean(name && domain === "highlandsquito.edu.ec" && extra === undefined && !name.startsWith("est"));
};
let currentUser = null, isTeacher = false, teacherClasses = [], selectedClassId = "", classStudents = [],
  classAssignments = [], classSubmissions = [], classSnapshots = [], classAttendance = [],
  studentClasses = [], studentAssignments = [], studentSubmissions = [], studySessions = [],
  notifications = [], selectedStudentChatClass = "";
let aiConversations = [], aiConversationId = null, aiMessages = [], aiBusy = false, aiWorkspaceLoading = false;

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
function setAuthMessage(message, success = false) {
  const node = $("authMsg");
  node.textContent = message;
  node.classList.toggle("success", success);
}

function setResendVisible(visible) {
  const button = $("btnResendVerification");
  if (button) button.hidden = !visible;
}

const authRedirectUrl = () => window.location.href.split(/[?#]/)[0];
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

      if (error) {
        const unverified = /email not confirmed/i.test(error.message || "");

        setAuthMessage(
          unverified
            ? "Tu correo todavía no está verificado. Solicita un nuevo correo."
            : error.message
        );

        setResendVisible(unverified);
      } else {
        setAuthMessage("");
        setResendVisible(false);
      }
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
      const { data, error } = await db.auth.signUp({
        ...creds(),
        options: { emailRedirectTo: authRedirectUrl() }
      });

      if (error) {
        setAuthMessage(error.message);
        setResendVisible(/already registered|already exists/i.test(error.message || ""));
      } else if (data.session) {
        setAuthMessage("Tu cuenta está lista. Ya puedes entrar.", true);
        setResendVisible(false);
      } else {
        setAuthMessage(`Cuenta creada. Enviamos un correo a ${creds().email}. Revisa Recibidos, Spam y Promociones.`, true);
        setResendVisible(true);
      }
    } catch (error) {
      setAuthMessage(error.message || "No se pudo crear la cuenta.");
    } finally {
      setAuthBusy(false);
    }
  };

  $("btnResendVerification")?.addEventListener("click", async () => {
  const email = $("email").value.trim();

  if (!email || !$("email").validity.valid) {
    setAuthMessage("Escribe tu correo electrónico.");
    $("email").focus();
    return;
  }

  const button = $("btnResendVerification");
  button.disabled = true;
  button.textContent = "Enviando...";

  setAuthMessage("Solicitando un nuevo correo de verificación...");

  try {
    const { error } = await db.auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: authRedirectUrl() }
    });

    if (error) {
      setAuthMessage(error.message || "No se pudo reenviar el correo.");
    } else {
      setAuthMessage("Solicitud aceptada. Revisa tu bandeja de entrada, Spam y Promociones.", true);
    }
  } catch (error) {
    setAuthMessage(error.message || "Error al reenviar el correo.");
  } finally {
    button.disabled = false;
    button.textContent = "Reenviar correo de verificación";
  }
});

  db.auth.onAuthStateChange((_event, session) => {
    $("auth").hidden = !!session;
    $("app").hidden = !session;
    if (session) {
      currentUser = session.user;
      const email = currentUser.email || "Estudiante";
      isTeacher = accountIsTeacher(email);
      $("who").textContent = email;
      $("sidebarEmail").textContent = email;
      setRoleView();
      load();
    } else {
      currentUser = null;
      isTeacher = false;
      teacherClasses = []; selectedClassId = ""; classStudents = []; classAssignments = [];
      classSubmissions = []; classSnapshots = []; classAttendance = [];
      studentClasses = []; studentAssignments = []; studentSubmissions = []; notifications = []; selectedStudentChatClass = "";
      studySessions = [];
      aiConversations = []; aiConversationId = null; aiMessages = [];
      $("aiRecommendationList").replaceChildren();
      $("aiRecommendationStatus").textContent = "";
      $("aiContextSummary").textContent = "Inicia sesión para consultar tu progreso con Elevate AI.";
      $("aiConversationList").replaceChildren();
      $("aiMessages").replaceChildren();
      $("aiChatStatus").textContent = "";
      subjects = []; allAssessments = []; assessments = []; goals = []; plan = [];
      Object.values(charts).forEach(chart => chart?.destroy());
    }
  });
}

function setRoleView() {
  document.querySelectorAll("[data-teacher-only]").forEach(node => { node.hidden = !isTeacher; });
  document.querySelectorAll("[data-go]").forEach(node => {
    const studentTab = ["panel", "metas", "tareas", "elevate-ai", "calc", "extension", "importar"].includes(node.dataset.go);
    node.hidden = isTeacher ? studentTab : node.dataset.go === "docente";
  });
  $("sidebarEmail").textContent = `${currentUser?.email || ""} · ${isTeacher ? "Profesor" : "Estudiante"}`;
  $("who").textContent = `${isTeacher ? "Profesor" : "Estudiante"} · ${currentUser?.email || ""}`;

  const savedTab = localStorage.getItem(`elevate-last-tab-${isTeacher ? "teacher" : "student"}`);
  const allowedTabs = isTeacher ? ["docente", "notificaciones"] : ["panel", "metas", "tareas", "elevate-ai", "notificaciones", "calc", "importar", "extension"];

  showTab(allowedTabs.includes(savedTab) ? savedTab : (isTeacher ? "docente" : "panel"));
}

// ===== Datos =====
let loadingData = false;
async function load() {
  if (!db || loadingData) return;
  loadingData = true;
  try {
    if (isTeacher) {
      await loadTeacherWorkspace();
      return;
    }
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
    await loadStudentWorkspace();
    renderAchievements();
    renderAIContextSummary();
    await saveStudentSnapshot();
    await generateStudentReminders();
    try {
      await loadAIRecommendations();
    } catch (error) {
      $("aiRecommendationStatus").textContent = `No se pudieron actualizar las recomendaciones de Elevate AI: ${error.message}`;
      $("aiRecommendationStatus").classList.add("is-error");
    }
  } catch (error) {
    toast(error.message || "No se pudieron cargar tus datos.", true);
  } finally {
    loadingData = false;
  }
}

// ===== Elevate AI: recomendaciones y chat con contexto del estudiante =====
async function invokeElevateAI(body) {
  const { data, error } = await db.functions.invoke("elevate-ai", { body });
  if (error) {
    let message = error.message || "No se pudo conectar con Elevate AI.";
    try {
      const response = error.context;
      const text = await response?.text?.();
      let detail = null;
      try { detail = JSON.parse(text); } catch { /* no era JSON */ }
      const reason = detail?.error || detail?.message || text;
      message = `${reason || message}${response?.status ? ` (código ${response.status})` : ""}`;
    } catch { /* se queda con el mensaje genérico */ }
    throw new Error(message);
  }
  if (!data || typeof data !== "object") throw new Error("Elevate AI devolvió una respuesta vacía.");
  if (data.error) throw new Error(String(data.error));
  return data;
}

function renderAIContextSummary() {
  const average = generalPct();
  const pending = allAssessments.filter(item => item.score === null).length;
  const activeGoals = goals.filter(item => item.status === "active").length;
  const tasksDue = studentAssignments.filter(item =>
    !studentSubmissions.some(submission => submission.assignment_id === item.id && submission.completed)
  ).length;
  const pieces = [
    average === null ? "Aún no hay notas suficientes para calcular un promedio" : `promedio general aproximado de ${fmt(average / 10)}/10`,
    `${subjects.length} ${subjects.length === 1 ? "materia" : "materias"}`,
    `${pending} ${pending === 1 ? "evaluación pendiente" : "evaluaciones pendientes"}`,
    `${activeGoals} ${activeGoals === 1 ? "meta activa" : "metas activas"}`,
    `${weeklyStudyMinutes()} min de estudio esta semana`,
    `${tasksDue} ${tasksDue === 1 ? "deber pendiente" : "deberes pendientes"}`
  ];
  $("aiContextSummary").textContent = `Contexto actual: ${pieces.join(" · ")}. El chat y las recomendaciones usan estos mismos datos de tu cuenta.`;
}

function renderAIRecommendations(items) {
  const container = $("aiRecommendationList");
  if (!items.length) {
    container.innerHTML = `<p class="muted">Todavía no hay recomendaciones disponibles.</p>`;
    return;
  }
  container.innerHTML = items.map((item, index) => {
    const title = esc(item.title || "Siguiente paso");
    const reason = esc(item.reason || "");
    const action = esc(item.action || "");
    const subject = typeof item.subject === "string" && item.subject ? item.subject : "";
    const question = `Ayúdame a trabajar en esta recomendación: ${item.title}. ${item.action}`;
    return `<article class="ai-recommendation">
      <span class="ai-recommendation-index">0${index + 1}</span>
      <div class="ai-recommendation-copy">
        <div class="ai-recommendation-title">${subject ? `<span class="tag">${esc(subject)}</span>` : ""}<h3>${title}</h3></div>
        <p>${reason}</p><p class="ai-action"><strong>Prueba esto:</strong> ${action}</p>
        <button class="ghost" type="button" data-ai-question="${esc(question)}">Preguntar cómo hacerlo <span aria-hidden="true">→</span></button>
      </div>
    </article>`;
  }).join("");
}

async function loadAIRecommendations(refresh = false) {
  const button = $("refreshAiRecommendations");
  if (button) button.disabled = true;
  $("aiRecommendationStatus").classList.remove("is-error");
  $("aiRecommendationStatus").textContent = refresh ? "Actualizando análisis…" : "Analizando tus datos académicos…";
  try {
    const data = await invokeElevateAI({ action: "recommendations", refresh });
    if (!Array.isArray(data.recommendations)) throw new Error("Elevate AI no devolvió recomendaciones en un formato válido.");
    renderAIRecommendations(data.recommendations);
    const generated = data.generated_at ? new Date(data.generated_at).toLocaleString("es-EC") : "";
    $("aiRecommendationStatus").textContent = `${data.cached ? "Análisis actualizado" : "Análisis generado"}${generated ? ` · ${generated}` : ""}. Se renueva cuando cambian tus datos.`;
  } catch (error) {
    $("aiRecommendationStatus").classList.add("is-error");
    throw error;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderAIConversationList() {
  $("aiConversationList").innerHTML = aiConversations.map(conversation => `
    <button class="ai-conversation ${conversation.id === aiConversationId ? "is-current" : ""}" type="button" data-ai-conversation="${conversation.id}" ${aiBusy ? "disabled" : ""}>
      <strong>${esc(conversation.title || "Conversación")}</strong>
      <small>${esc(new Date(conversation.updated_at).toLocaleDateString("es-EC"))}</small>
    </button>`).join("") || `<p class="muted ai-empty-history">Tus conversaciones aparecerán aquí.</p>`;
}


function renderAIMessages(showTyping = false) {
  const rows = aiMessages.length ? aiMessages : [{
    role: "assistant",
    content: "¡Hola! Puedo ayudarte a entender tu progreso y pensar un plan de estudio. Pregúntame sobre tus materias, evaluaciones o metas."
  }];

  const container = $("aiMessages");

  container.innerHTML = rows.map(message => {
    const isUser = message.role === "user";

    const content = isUser
      ? esc(message.content).replace(/\n/g, "<br>")
      : DOMPurify.sanitize(
          marked.parse(message.content, {
            breaks: true,
            gfm: true
          })
        );

    return `
      <article class="ai-message ${isUser ? "user" : "assistant"}">
        <strong>${isUser ? "Tú" : "Elevate AI"}</strong>
        <div class="ai-message-content">${content}</div>
      </article>
    `;
  }).join("") + (showTyping ? `
    <article class="ai-message assistant ai-typing" role="status">
      <strong>Elevate AI</strong>
      <p><span></span><span></span><span></span> Analizando tu pregunta…</p>
    </article>
  ` : "");

  // Renderizar fórmulas matemáticas
  if (window.MathJax?.typesetPromise) {
    MathJax.typesetPromise([container]).catch(error => {
      console.error("Error al renderizar fórmulas:", error);
    });
  }

  container.scrollTop = container.scrollHeight;
}


async function loadAIConversations() {
  $("aiHistoryStatus").textContent = "Cargando tus conversaciones…";
  const { data, error } = await db.from("ai_conversations")
    .select("id,title,updated_at")
    .order("updated_at", { ascending: false })
    .limit(40);
  if (error) throw error;
  aiConversations = data || [];
  $("aiHistoryStatus").textContent = "Tus conversaciones son privadas.";
  renderAIConversationList();
}

async function loadAIConversation(id) {
  $("aiChatStatus").textContent = "Cargando conversación…";
  const { data, error } = await db.from("ai_messages")
    .select("role,content,created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(100);
  if (error) throw error;
  aiConversationId = id;
  aiMessages = data || [];
  renderAIConversationList();
  renderAIMessages();
  $("aiChatStatus").textContent = "";
}

async function openAIWorkspace() {
  if (aiWorkspaceLoading || aiBusy) return;
  aiWorkspaceLoading = true;
  renderAIContextSummary();
  try {
    await loadAIConversations();
    if (aiConversationId && aiConversations.some(item => item.id === aiConversationId)) {
      await loadAIConversation(aiConversationId);
    } else {
      aiConversationId = null;
      aiMessages = [];
      renderAIConversationList();
      renderAIMessages();
    }
  } catch (error) {
    $("aiChatStatus").textContent = `No se pudo cargar el historial: ${error.message}`;
    $("aiChatStatus").classList.add("is-error");
  } finally {
    aiWorkspaceLoading = false;
  }
}

function startNewAIConversation() {
  if (aiBusy) return;
  aiConversationId = null;
  aiMessages = [];
  $("aiChatStatus").textContent = "";
  $("aiChatStatus").classList.remove("is-error");
  renderAIConversationList();
  renderAIMessages();
  $("aiPrompt").focus();
}

async function sendAIMessage(message) {
  if (aiBusy) return;
  const content = String(message || "").trim();
  if (!content || content.length > 2000) return;
  const priorMessages = aiMessages;
  aiMessages = [...priorMessages, { role: "user", content }];
  aiBusy = true;
  $("aiChatStatus").textContent = "";
  $("aiChatStatus").classList.remove("is-error");
  $("aiPrompt").disabled = true;
  $("sendAiMessage").disabled = true;
  $("newAiConversation").disabled = true;
  renderAIConversationList();
  renderAIMessages(true);
  try {
    const data = await invokeElevateAI({
      action: "chat",
      conversation_id: aiConversationId,
      message: content
    });
    if (typeof data.answer !== "string" || !data.answer.trim() || typeof data.conversation_id !== "string") {
      throw new Error("Elevate AI devolvió una respuesta incompleta.");
    }
    aiConversationId = data.conversation_id;
    aiMessages = [...aiMessages, { role: "assistant", content: data.answer }];
    $("aiPrompt").value = "";
    renderAIMessages();
    try {
      await loadAIConversations();
    } catch (error) {
      $("aiHistoryStatus").textContent = `La respuesta se guardó, pero no se pudo actualizar el historial: ${error.message}`;
    }
  } catch (error) {
    aiMessages = priorMessages;
    renderAIMessages();
    $("aiChatStatus").textContent = `No se pudo obtener una respuesta: ${error.message}`;
    $("aiChatStatus").classList.add("is-error");
  } finally {
    aiBusy = false;
    $("aiPrompt").disabled = false;
    $("sendAiMessage").disabled = false;
    $("newAiConversation").disabled = false;
    renderAIConversationList();
    $("aiPrompt").focus();
  }
}

// ===== Funciones de clase, deberes, seguimiento y recordatorios =====
const isoToday = () => localDate(Date.now());
const formatDue = value => value ? new Date(value).toLocaleString("es-EC", { dateStyle: "medium", timeStyle: "short" }) : "Sin fecha";

async function loadStudentWorkspace() {
  const [classesRes, assignmentsRes, submissionsRes, sessionsRes, notificationsRes] = await Promise.all([
    db.from("teacher_classes").select("*").order("created_at"),
    db.from("class_assignments").select("*").order("due_at"),
    db.from("assignment_submissions").select("*").eq("student_id", currentUser.id),
    db.from("study_sessions").select("*").eq("student_id", currentUser.id).gte("study_date", localDate(Date.now() - 30 * 864e5)).order("study_date", { ascending: false }),
    db.from("student_notifications").select("*").order("created_at", { ascending: false }).limit(50)
  ]);
  const error = classesRes.error || assignmentsRes.error || submissionsRes.error || sessionsRes.error || notificationsRes.error;
  if (error) throw error;
  studentClasses = classesRes.data || [];
  studentAssignments = assignmentsRes.data || [];
  studentSubmissions = submissionsRes.data || [];
  studySessions = sessionsRes.data || [];
  notifications = notificationsRes.data || [];
  renderStudentAssignments();
  renderStudySessions();
  renderNotifications();
  if (!studentClasses.some(item => item.id === selectedStudentChatClass)) selectedStudentChatClass = studentClasses[0]?.id || "";
  $("studentChatClass").innerHTML = studentClasses.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join("")
    || `<option value="">Únete a una clase para iniciar el chat</option>`;
  $("studentChatClass").value = selectedStudentChatClass;
  updateTaskRecommendation();
  await loadClassMessages(selectedStudentChatClass, "studentChatMessages");
}

function updateTaskRecommendation() {
  const completed = new Set(studentSubmissions.filter(item => item.completed).map(item => item.assignment_id));
  const pending = studentAssignments
    .filter(item => !completed.has(item.id))
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
  if (!pending.length) {
    if (!weeklyStudyMinutes() && $("tip").textContent.startsWith("Vas con buen ritmo")) {
      $("tip").textContent = "Registra tus sesiones de estudio para descubrir hábitos que te ayudan a progresar.";
    }
    return;
  }
  const due = new Date(pending[0].due_at).getTime(), now = Date.now();
  if (due < now) $("tip").textContent = `Prioriza el deber atrasado «${pending[0].title}». Completarlo te ayudará a mantener tu plan académico al día.`;
  else if (due <= now + 3 * 864e5) $("tip").textContent = `Tu siguiente deber, «${pending[0].title}», vence el ${formatDue(pending[0].due_at)}. Reserva tiempo para terminarlo.`;
  else if ($("tip").textContent.startsWith("Vas con buen ritmo")) $("tip").textContent = `Avanza con «${pending[0].title}» antes de su fecha de entrega.`;
}

function weeklyStudyMinutes() {
  const since = localDate(Date.now() - 6 * 864e5), today = isoToday();
  return studySessions
    .filter(item => item.study_date >= since && item.study_date <= today)
    .reduce((sum, item) => sum + Number(item.duration_minutes), 0);
}

function renderStudySessions() {
  $("weeklyStudyMinutes").textContent = String(weeklyStudyMinutes());
  $("studySessionsList").innerHTML = studySessions.slice(0, 8).map(item =>
    `<li><span><strong>${esc(item.subject)}</strong> · ${esc(item.study_date)}</span><span>${item.duration_minutes} min</span></li>`
  ).join("") || `<li class="muted">Aún no registras sesiones de estudio.</li>`;
}

function renderStudentAssignments() {
  const byClass = Object.fromEntries(studentClasses.map(item => [item.id, item.name]));
  const submitted = Object.fromEntries(studentSubmissions.map(item => [item.assignment_id, item]));
  $("studentAssignments").innerHTML = studentAssignments.map(item => {
    const submission = submitted[item.id];
    const due = new Date(item.due_at), late = due < new Date() && !submission?.completed;
    return `<article class="card assignment-card ${late ? "is-overdue" : ""}">
      <div class="assignment-card-top"><span class="tag">${esc(byClass[item.class_id] || "Clase")}</span><span class="tag ${late ? "tag-danger" : submission?.completed ? "tag-success" : "tag-warning"}">${late ? "Atrasada" : submission?.completed ? "Entregada" : "Pendiente"}</span></div>
      <h3>${esc(item.title)}</h3><p class="muted">${esc(item.description || "Sin instrucciones adicionales.")}</p>
      <p class="assignment-due">Entrega: ${esc(formatDue(item.due_at))}</p>
      <form class="submission-form" data-assignment="${item.id}">
        <label class="field-label">Tu entrega<textarea name="response" rows="3" maxlength="5000" placeholder="Escribe tu respuesta o pega un enlace…">${esc(submission?.response || "")}</textarea></label>
        <label class="chk"><input name="completed" type="checkbox" ${submission?.completed ? "checked" : ""}><span>Marcar como entregada</span></label>
        <button class="btn btn-primary" type="submit">Guardar entrega</button>
      </form>
    </article>`;
  }).join("") || `<p class="muted">${studentClasses.length ? "Tus profesores todavía no han publicado deberes." : "Únete a una clase para ver los deberes publicados por tus profesores."}</p>`;
}

function renderNotifications() {
  const unread = notifications.filter(item => !item.read_at).length;
  const count = $("notificationCount");
  count.textContent = unread > 9 ? "9+" : String(unread);
  count.hidden = unread === 0;
  $("notificationsList").innerHTML = notifications.map(item => `
    <article class="notification-card ${item.read_at ? "is-read" : ""}">
      <div class="notification-symbol" aria-hidden="true">${item.notification_type === "assignment" ? "✓" : item.notification_type === "goal" ? "◎" : "✦"}</div>
      <div class="notification-copy"><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><small>${esc(new Date(item.created_at).toLocaleString("es-EC"))}</small></div>
      ${item.read_at ? "" : `<button class="ghost" type="button" data-read-notification="${item.id}">Marcar leída</button>`}
    </article>`).join("") || `<p class="muted">No tienes notificaciones por ahora.</p>`;
}

function renderAchievements() {
  const completedTasks = studentSubmissions.filter(item => item.completed).length;
  const badges = [
    { title: "Primer paso", detail: "Registra una calificación", earned: allAssessments.some(item => item.score !== null), icon: "✦" },
    { title: "Constancia", detail: "Completa 5 deberes", earned: completedTasks >= 5, icon: "✓" },
    { title: "Planificador", detail: "Crea una meta académica", earned: goals.length > 0, icon: "◎" },
    { title: "Meta alcanzada", detail: "Completa una meta", earned: goals.some(item => item.status === "completed"), icon: "◆" }
  ];
  $("achievements").innerHTML = badges.map(item => `<div class="achievement ${item.earned ? "earned" : ""}" title="${esc(item.detail)}"><span>${item.icon}</span><strong>${esc(item.title)}</strong></div>`).join("");
}

async function generateStudentReminders() {
  const today = isoToday(), now = Date.now(), soon = now + 3 * 864e5;
  const pending = studentSubmissions.filter(item => !item.completed);
  const byId = Object.fromEntries(pending.map(item => [item.assignment_id, item]));
  const reminders = [];
  for (const assignment of studentAssignments) {
    if (!byId[assignment.id]) {
      const due = new Date(assignment.due_at).getTime();
      if (due < now) reminders.push({
        notification_type: "assignment", title: "Deber atrasado",
        body: `Completa «${assignment.title}» cuanto antes.`,
        dedupe_key: `assignment:overdue:${assignment.id}`
      });
      else if (due <= soon) reminders.push({
        notification_type: "assignment", title: "Deber próximo a vencer",
        body: `«${assignment.title}» vence el ${formatDue(assignment.due_at)}.`,
        dedupe_key: `assignment:soon:${assignment.id}`
      });
    }
  }
  for (const exam of allAssessments.filter(item => item.score === null && item.date && item.date >= today && item.date <= localDate(soon))) {
    reminders.push({
      notification_type: "exam", title: "Examen próximo",
      body: `Reserva tiempo para estudiar: «${exam.name}» es el ${exam.date}.`,
      dedupe_key: `exam:${exam.id}:${exam.date}`
    });
  }
  for (const goal of goals.filter(item => item.status === "active" && item.deadline && item.deadline <= localDate(soon))) {
    reminders.push({
      notification_type: "goal", title: "Revisa tu meta académica",
      body: `La meta «${goal.title}» vence el ${goal.deadline}.`,
      dedupe_key: `goal:${goal.id}:${goal.deadline}`
    });
  }
  const recommendation = $("tip").textContent.trim();
  if (recommendation && !recommendation.startsWith("Registra tu primera nota")) {
    const key = recommendation.toLocaleLowerCase("es").replace(/[^a-z0-9]+/g, "-").slice(0, 80);
    reminders.push({
      notification_type: "recommendation", title: "Tu recomendación de hoy",
      body: recommendation, dedupe_key: `recommendation:${today}:${key}`
    });
  }
  const activeKeys = new Set(reminders.map(item => item.dedupe_key));
  const resolvedIds = notifications
    .filter(item => ["assignment", "exam", "goal"].includes(item.notification_type) && !item.read_at && !activeKeys.has(item.dedupe_key))
    .map(item => item.id);
  if (resolvedIds.length) {
    const { error } = await db.from("student_notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("student_id", currentUser.id)
      .in("id", resolvedIds);
    if (error) throw error;
    notifications = notifications.map(item => resolvedIds.includes(item.id) ? { ...item, read_at: new Date().toISOString() } : item);
    renderNotifications();
  }
  if (!reminders.length) return;
  const { error } = await db.from("student_notifications").upsert(
    reminders.map(item => ({ ...item, student_id: currentUser.id })),
    { onConflict: "student_id,dedupe_key", ignoreDuplicates: true }
  );
  if (error) throw error;
  const result = await db.from("student_notifications").select("*").order("created_at", { ascending: false }).limit(50);
  if (result.error) throw result.error;
  notifications = result.data || [];
  renderNotifications();
}

async function saveStudentSnapshot() {
  const rows = subjects.map(subject => {
    const avg = average(allAssessments.filter(item => item.subject_id === subject.id), subject.scale_max);
    return avg === null ? null : { name: subject.name, average: Math.round(avg * 100) / 100, scale_max: subject.scale_max, average_pct: Math.round(avg / subject.scale_max * 10000) / 100 };
  }).filter(Boolean);
  const snapshot = {
    student_id: currentUser.id,
    snapshot_date: isoToday(),
    average_pct: rows.length ? Math.round(rows.reduce((sum, item) => sum + item.average_pct, 0) / rows.length * 100) / 100 : null,
    subjects: rows,
    goals: goals.filter(item => item.status === "active").map(item => ({
      title: item.title, period: item.goal_period || "term", deadline: item.deadline,
      target_value: item.target_value, subject: subjects.find(subject => subject.id === item.subject_id)?.name || ""
    })),
    active_goals: goals.filter(item => item.status === "active").length,
    completed_assessments: allAssessments.filter(item => item.score !== null).length,
    pending_assessments: allAssessments.filter(item => item.score === null).length,
    weekly_study_minutes: weeklyStudyMinutes(),
    updated_at: new Date().toISOString()
  };
  const { error } = await db.from("student_progress").upsert(snapshot, { onConflict: "student_id,snapshot_date" });
  if (error) throw error;
}

async function loadTeacherWorkspace() {
  const classesResult = await db.from("teacher_classes").select("*").eq("teacher_id", currentUser.id).order("created_at");
  if (classesResult.error) throw classesResult.error;
  teacherClasses = classesResult.data || [];
  if (!teacherClasses.some(item => item.id === selectedClassId)) selectedClassId = teacherClasses[0]?.id || "";
  $("teacherClass").innerHTML = teacherClasses.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join("")
    || `<option value="">Crea tu primera clase</option>`;
  $("teacherClass").value = selectedClassId;
  const currentClass = teacherClasses.find(item => item.id === selectedClassId);
  $("classJoinCode").textContent = currentClass ? `Código para tus estudiantes: ${currentClass.join_code}` : "Todavía no tienes clases.";
  if (!currentClass) {
    classStudents = []; classAssignments = []; classSubmissions = []; classSnapshots = []; classAttendance = [];
    renderTeacherWorkspace();
    await loadClassMessages("", "teacherChatMessages");
    return;
  }

  const [enrollmentsRes, assignmentsRes, attendanceRes] = await Promise.all([
    db.from("class_enrollments").select("student_id").eq("class_id", selectedClassId),
    db.from("class_assignments").select("*").eq("class_id", selectedClassId).order("due_at"),
    db.from("class_attendance").select("*").eq("class_id", selectedClassId).order("attendance_date")
  ]);
  const error = enrollmentsRes.error || assignmentsRes.error || attendanceRes.error;
  if (error) throw error;
  const studentIds = (enrollmentsRes.data || []).map(item => item.student_id);
  classAssignments = assignmentsRes.data || [];
  classAttendance = attendanceRes.data || [];
  if (!studentIds.length) {
    classStudents = []; classSubmissions = []; classSnapshots = [];
    renderTeacherWorkspace();
    await loadClassMessages(selectedClassId, "teacherChatMessages");
    return;
  }
  const [profilesRes, snapshotsRes, submissionsRes] = await Promise.all([
    db.from("profiles").select("user_id,email").in("user_id", studentIds),
    db.from("student_progress").select("*").in("student_id", studentIds).order("snapshot_date"),
    classAssignments.length
      ? db.from("assignment_submissions").select("*").in("assignment_id", classAssignments.map(item => item.id))
      : Promise.resolve({ data: [], error: null })
  ]);
  const detailError = profilesRes.error || snapshotsRes.error || submissionsRes.error;
  if (detailError) throw detailError;
  classStudents = profilesRes.data || [];
  classSnapshots = snapshotsRes.data || [];
  classSubmissions = submissionsRes.data || [];
  renderTeacherWorkspace();
  await loadClassMessages(selectedClassId, "teacherChatMessages");
}

async function loadClassMessages(classId, targetId) {
  const target = $(targetId);
  if (!classId) {
    target.innerHTML = `<p class="muted">Selecciona o únete a una clase para ver el chat.</p>`;
    return;
  }
  const { data, error } = await db.from("class_messages").select("*").eq("class_id", classId).order("sent_at", { ascending: false }).limit(100);
  if (error) throw error;
  const names = Object.fromEntries(classStudents.map(student => [student.user_id, student.email]));
  target.innerHTML = (data || []).reverse().map(message => {
    const sender = message.sender_id === currentUser.id
      ? "Tú"
      : names[message.sender_id] || `Miembro · ${message.sender_id.slice(0, 8)}`;
    return `<article class="chat-message ${message.sender_id === currentUser.id ? "mine" : ""}"><strong>${esc(sender)}</strong><p>${esc(message.body)}</p><small>${esc(new Date(message.sent_at).toLocaleString("es-EC"))}</small></article>`;
  }).join("") || `<p class="muted">Todavía no hay mensajes. Inicia la conversación.</p>`;
  target.scrollTop = target.scrollHeight;
}

async function sendClassMessage(classId, text, form, targetId) {
  if (!classId) return toast("Selecciona o únete a una clase primero.", true);
  const { error } = await db.from("class_messages").insert({
    class_id: classId, sender_id: currentUser.id, body: text.trim()
  });
  if (error) return toast(error.message, true);
  form.reset();
  try { await loadClassMessages(classId, targetId); } catch (loadError) { toast(loadError.message, true); }
}

function latestSnapshotFor(studentId) {
  return classSnapshots.filter(item => item.student_id === studentId).at(-1);
}

function renderTeacherWorkspace() {
  $("teacherStudentCount").textContent = String(classStudents.length);
  const latest = classStudents.map(student => latestSnapshotFor(student.user_id)).filter(item => item?.average_pct !== null && item?.average_pct !== undefined);
  $("teacherAverage").textContent = latest.length ? `${fmt(latest.reduce((sum, item) => sum + Number(item.average_pct), 0) / latest.length)}%` : "–";
  $("teacherPending").textContent = String(Math.max(0, classAssignments.length * classStudents.length - classSubmissions.filter(item => item.completed).length));
  const attendanceCounts = { present: 0, late: 0, absent: 0, excused: 0 };
  classAttendance.forEach(item => { if (attendanceCounts[item.status] !== undefined) attendanceCounts[item.status]++; });
  const recorded = attendanceCounts.present + attendanceCounts.late + attendanceCounts.absent;
  $("teacherAttendance").textContent = recorded ? `${fmt((attendanceCounts.present + attendanceCounts.late) / recorded * 100)}%` : "–";
  const submissionByStudent = classSubmissions.reduce((groups, item) => {
    (groups[item.student_id] ||= []).push(item);
    return groups;
  }, {});
  $("teacherRoster").innerHTML = classStudents.map(student => {
    const snapshot = latestSnapshotFor(student.user_id), average = snapshot?.average_pct;
    const tasks = submissionByStudent[student.user_id] || [];
    const completed = tasks.filter(item => item.completed).length;
    const subjectLine = (snapshot?.subjects || []).map(item => `${item.name}: ${fmt(item.average)}`).join(" · ");
    const goals = (snapshot?.goals || []).map(item => `${item.title}${item.deadline ? ` (${item.deadline})` : ""}`).join(", ");
    const risk = average !== null && average !== undefined && Number(average) < LOW;
    return `<tr>
      <td>${esc(student.email)}</td><td>${average === null || average === undefined ? "Sin reporte" : `${fmt(average)}%`}</td>
      <td title="${esc(subjectLine)}">${esc(subjectLine || "–")}</td>
      <td title="${esc(goals)}">${snapshot?.active_goals ?? 0}${goals ? ` · ${esc(goals)}` : ""}</td>
      <td>${snapshot?.weekly_study_minutes ?? 0} min</td>
      <td>${completed}/${classAssignments.length} entregados</td>
      <td><span class="tag ${risk ? "tag-danger" : "tag-success"}">${risk ? "Requiere apoyo" : average === null || average === undefined ? "Sin datos" : "Al día"}</span></td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="empty-table">${teacherClasses.length ? "Comparte el código de la clase para que tus estudiantes se inscriban." : "Crea una clase para comenzar."}</td></tr>`;
  renderTeacherCharts(attendanceCounts);
  renderAttendanceRoster();
  renderTeacherAssignments();
}

function renderTeacherCharts(attendanceCounts) {
  if (typeof Chart === "undefined") return;
  const css = getComputedStyle(document.documentElement);
  Chart.defaults.color = css.getPropertyValue("--muted").trim();
  Chart.defaults.borderColor = css.getPropertyValue("--border").trim();
  const palette = ["#6d9cff", "#46d6a0", "#f4bd68", "#9b83ff", "#ff7b89", "#46c7d6"];
  const dates = [...new Set(classSnapshots.map(item => item.snapshot_date))].sort();
  draw("teacherProgressChart", {
    type: "line",
    data: { labels: dates, datasets: classStudents.map((student, index) => ({
      label: student.email.split("@")[0],
      data: dates.map(date => classSnapshots.find(item => item.student_id === student.user_id && item.snapshot_date === date)?.average_pct ?? null),
      borderColor: palette[index % palette.length], backgroundColor: palette[index % palette.length], tension: .3, spanGaps: true
    })) },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } }
  });
  draw("teacherAttendanceChart", {
    type: "doughnut",
    data: {
      labels: ["Presente", "Atraso", "Ausente", "Justificado"],
      datasets: [{ data: [attendanceCounts.present, attendanceCounts.late, attendanceCounts.absent, attendanceCounts.excused], backgroundColor: ["#46d6a0", "#f4bd68", "#ff7b89", "#6d9cff"] }]
    },
    options: { maintainAspectRatio: false }
  });
  const completionRate = student => {
    if (!classAssignments.length) return 0;
    const done = classSubmissions.filter(item => item.student_id === student.user_id && item.completed).length;
    return Math.round(done / classAssignments.length * 100);
  };
  draw("teacherTaskChart", {
    type: "bar",
    data: {
      labels: classStudents.map(student => student.email.split("@")[0]),
      datasets: [{ label: "Deberes completados (%)", data: classStudents.map(completionRate), backgroundColor: "#6d9cff", borderRadius: 7 }]
    },
    options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } }
  });
}

function renderAttendanceRoster() {
  const day = $("attendanceDate").value || isoToday();
  const records = Object.fromEntries(classAttendance.filter(item => item.attendance_date === day).map(item => [item.student_id, item.status]));
  $("attendanceRoster").innerHTML = classStudents.map(student => `<label class="attendance-row">
    <span>${esc(student.email)}</span>
    <select data-attendance-student="${student.user_id}">
      <option value="">Sin registrar</option>
      <option value="present" ${records[student.user_id] === "present" ? "selected" : ""}>Presente</option>
      <option value="late" ${records[student.user_id] === "late" ? "selected" : ""}>Atraso</option>
      <option value="absent" ${records[student.user_id] === "absent" ? "selected" : ""}>Ausente</option>
      <option value="excused" ${records[student.user_id] === "excused" ? "selected" : ""}>Justificado</option>
    </select>
  </label>`).join("") || `<p class="muted">No hay estudiantes inscritos.</p>`;
  if (classStudents.length && !$("saveAttendance")) {
    $("attendanceRoster").insertAdjacentHTML("beforeend", `<button id="saveAttendance" class="btn btn-primary attendance-save" type="button">Guardar asistencia</button>`);
  }
}

function renderTeacherAssignments() {
  $("teacherAssignments").innerHTML = classAssignments.map(item => {
    const submissions = classSubmissions.filter(submission => submission.assignment_id === item.id);
    const byId = Object.fromEntries(classStudents.map(student => [student.user_id, student.email]));
    return `<article class="card assignment-card">
      <div class="assignment-card-top"><span class="tag">${submissions.filter(submission => submission.completed).length}/${classStudents.length} entregas</span><button class="ghost" type="button" data-delete-assignment="${item.id}">Eliminar</button></div>
      <h3>${esc(item.title)}</h3><p class="muted">${esc(item.description || "Sin instrucciones adicionales.")}</p><p class="assignment-due">Vence: ${esc(formatDue(item.due_at))}</p>
      <details class="submission-review"><summary>Revisar entregas (${submissions.filter(submission => submission.completed).length})</summary>
        ${submissions.filter(submission => submission.completed).map(submission => `<p><strong>${esc(byId[submission.student_id] || "Estudiante")}</strong><br>${esc(submission.response || "Marcó la tarea como entregada sin añadir texto.")}</p>`).join("") || `<p class="muted">Todavía no hay entregas.</p>`}
      </details>
    </article>`;
  }).join("") || `<p class="muted">Publica el primer deber de esta clase.</p>`;
}

$("classForm").addEventListener("submit", async event => {
  event.preventDefault();
  const { data, error } = await db.from("teacher_classes").insert({
    teacher_id: currentUser.id, name: $("className").value.trim()
  }).select().single();
  if (error) return toast(error.message, true);
  selectedClassId = data.id;
  $("classForm").reset();
  toast("Clase creada. Comparte el código de acceso.");
  try { await loadTeacherWorkspace(); } catch (loadError) { toast(loadError.message, true); }
});

$("teacherClass").addEventListener("change", async event => {
  selectedClassId = event.target.value;
  try { await loadTeacherWorkspace(); } catch (error) { toast(error.message, true); }
});

$("studentChatClass").addEventListener("change", async event => {
  selectedStudentChatClass = event.target.value;
  try { await loadClassMessages(selectedStudentChatClass, "studentChatMessages"); } catch (error) { toast(error.message, true); }
});
$("studentChatForm").addEventListener("submit", event => {
  event.preventDefault();
  sendClassMessage(selectedStudentChatClass, $("studentChatText").value, event.currentTarget, "studentChatMessages");
});
$("teacherChatForm").addEventListener("submit", event => {
  event.preventDefault();
  sendClassMessage(selectedClassId, $("teacherChatText").value, event.currentTarget, "teacherChatMessages");
});
$("refreshStudentChat").addEventListener("click", async () => {
  try { await loadClassMessages(selectedStudentChatClass, "studentChatMessages"); } catch (error) { toast(error.message, true); }
});
$("refreshTeacherChat").addEventListener("click", async () => {
  try { await loadClassMessages(selectedClassId, "teacherChatMessages"); } catch (error) { toast(error.message, true); }
});

$("joinClassForm").addEventListener("submit", async event => {
  event.preventDefault();
  const { error } = await db.rpc("elevate_join_class", { p_join_code: $("joinCode").value.trim() });
  if (error) return toast(error.message, true);
  $("joinClassForm").reset();
  toast("Te uniste a la clase.");
  try { await loadStudentWorkspace(); } catch (loadError) { toast(loadError.message, true); }
});

$("assignmentForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (!selectedClassId) return toast("Crea o selecciona una clase primero.", true);
  const due = new Date($("assignmentDue").value);
  if (Number.isNaN(due.getTime())) return toast("Selecciona una fecha de entrega válida.", true);
  const { error } = await db.from("class_assignments").insert({
    class_id: selectedClassId, teacher_id: currentUser.id,
    title: $("assignmentTitle").value.trim(),
    description: $("assignmentDescription").value.trim(),
    due_at: due.toISOString()
  });
  if (error) return toast(error.message, true);
  $("assignmentForm").reset();
  toast("Deber publicado.");
  try { await loadTeacherWorkspace(); } catch (loadError) { toast(loadError.message, true); }
});

document.addEventListener("submit", async event => {
  const form = event.target.closest(".submission-form");
  if (!form) return;
  event.preventDefault();
  const completed = form.elements.completed.checked;
  const { error } = await db.from("assignment_submissions").upsert({
    assignment_id: form.dataset.assignment,
    student_id: currentUser.id,
    response: form.elements.response.value.trim(),
    completed,
    submitted_at: completed ? new Date().toISOString() : null,
    updated_at: new Date().toISOString()
  }, { onConflict: "assignment_id,student_id" });
  if (error) return toast(error.message, true);
  toast(completed ? "Entrega guardada." : "Progreso guardado.");
  try {
    await loadStudentWorkspace();
    updateTaskRecommendation();
    renderAchievements();
    await generateStudentReminders();
  } catch (loadError) { toast(loadError.message, true); }
});

document.addEventListener("click", async event => {
  const markRead = event.target.closest("[data-read-notification]")?.dataset.readNotification;
  const deleteAssignment = event.target.closest("[data-delete-assignment]")?.dataset.deleteAssignment;
  if (markRead) {
    const { error } = await db.from("student_notifications").update({ read_at: new Date().toISOString() }).eq("id", markRead);
    if (error) return toast(error.message, true);
    notifications = notifications.map(item => item.id === markRead ? { ...item, read_at: new Date().toISOString() } : item);
    renderNotifications();
  } else if (deleteAssignment && confirm("¿Eliminar este deber y sus entregas?")) {
    const { error } = await db.from("class_assignments").delete().eq("id", deleteAssignment);
    if (error) return toast(error.message, true);
    try { await loadTeacherWorkspace(); } catch (loadError) { toast(loadError.message, true); }
  }
});

$("attendanceDate").value = isoToday();
$("attendanceDate").addEventListener("change", renderAttendanceRoster);
$("studyDate").value = isoToday();
$("studySessionForm").addEventListener("submit", async event => {
  event.preventDefault();
  const minutes = Number($("studyMinutes").value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 600) return toast("La duración debe estar entre 5 y 600 minutos.", true);
  const { error } = await db.from("study_sessions").insert({
    student_id: currentUser.id,
    subject: $("studySubject").value.trim(),
    duration_minutes: minutes,
    study_date: $("studyDate").value
  });
  if (error) return toast(error.message, true);
  $("studySessionForm").reset();
  $("studyMinutes").value = "30";
  $("studyDate").value = isoToday();
  toast("Sesión de estudio registrada.");
  try {
    await loadStudentWorkspace();
    updateTaskRecommendation();
    renderAchievements();
    await saveStudentSnapshot();
    await generateStudentReminders();
  } catch (loadError) { toast(loadError.message, true); }
});
document.addEventListener("click", async event => {
  if (!event.target.closest("#saveAttendance")) return;
  const rows = [...$("attendanceRoster").querySelectorAll("[data-attendance-student]")];
  const records = rows.filter(row => row.value).map(row => ({
    class_id: selectedClassId, student_id: row.dataset.attendanceStudent,
    attendance_date: $("attendanceDate").value || isoToday(),
    status: row.value, recorded_by: currentUser.id
  }));
  if (!records.length) return toast("Selecciona al menos un estado de asistencia.", true);
  const { error } = await db.from("class_attendance").upsert(records, { onConflict: "class_id,student_id,attendance_date" });
  if (error) return toast(error.message, true);
  toast("Asistencia guardada.");
  try { await loadTeacherWorkspace(); } catch (loadError) { toast(loadError.message, true); }
});

$("exportReport").addEventListener("click", () => window.print());

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
  const labels = {
    panel: "Panel general", metas: "Metas y plan", tareas: "Deberes",
    "elevate-ai": "Elevate AI", notificaciones: "Notificaciones", docente: "Panel docente", calc: "Calculadora",
    importar: "Importar de Idukay", extension: "Extensión de Chrome"
  };
  if (isTeacher && ["panel", "metas", "tareas", "elevate-ai", "calc", "extension", "importar"].includes(t)) t = "docente";
  if (!isTeacher && t === "docente") t = "panel";
  if (currentUser) {
    localStorage.setItem(`elevate-last-tab-${isTeacher ? "teacher" : "student"}`, t);
  }
  document.querySelectorAll("[data-view]").forEach(section => { section.hidden = section.dataset.view !== t; });
  document.querySelectorAll("[data-go]").forEach(button => {
    const active = button.dataset.go === t;
    button.classList.toggle("on", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  if ($("topbarSection")) $("topbarSection").textContent = labels[t] || "Elevate";
  if (t === "elevate-ai" && currentUser) openAIWorkspace();
}
document.querySelectorAll("[data-go]").forEach(button => button.addEventListener("click", () => showTab(button.dataset.go)));
showTab("panel");

$("newAiConversation").addEventListener("click", startNewAIConversation);
$("aiChatForm").addEventListener("submit", event => {
  event.preventDefault();
  sendAIMessage($("aiPrompt").value);
});
$("refreshAiRecommendations").addEventListener("click", async () => {
  try { await loadAIRecommendations(true); }
  catch (error) { $("aiRecommendationStatus").textContent = `No se pudieron actualizar las recomendaciones: ${error.message}`; }
});
document.addEventListener("click", async event => {
  const conversationId = event.target.closest("[data-ai-conversation]")?.dataset.aiConversation;
  const question = event.target.closest("[data-ai-question]")?.dataset.aiQuestion;
  if (conversationId) {
    try { await loadAIConversation(conversationId); }
    catch (error) {
      $("aiChatStatus").textContent = `No se pudo cargar la conversación: ${error.message}`;
      $("aiChatStatus").classList.add("is-error");
    }
  } else if (question) {
    showTab("elevate-ai");
    $("aiPrompt").value = question;
    $("aiPrompt").focus();
  }
});

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
      <span class="muted">${esc(s?.name || "Sin materia")} · ${g.goal_period === "week" ? "meta semanal" : g.goal_period === "month" ? "meta mensual" : "meta académica"} · de ${fmt(g.start_value)} a ${fmt(g.target_value)}${g.deadline ? " · hasta " + esc(g.deadline) : ""}</span>
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
    deadline: $("gDeadline").value || null,
    goal_period: $("gPeriod").value
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
  const projected = rows.map(row => {
    const values = row.ev.slice(-5).map(item => item.pct);
    if (values.length < 2) return null;
    const meanX = (values.length - 1) / 2;
    const meanY = values.reduce((sum, value) => sum + value, 0) / values.length;
    const denominator = values.reduce((sum, _value, index) => sum + (index - meanX) ** 2, 0);
    const slope = values.reduce((sum, value, index) => sum + (index - meanX) * (value - meanY), 0) / denominator;
    const nextPct = Math.max(0, Math.min(100, values.at(-1) + slope));
    return { subject: row.s.name, grade: nextPct / 100 * row.s.scale_max, scale: row.s.scale_max };
  }).filter(Boolean);
  $("predictions").innerHTML = projected.map(item => `<li>${esc(item.subject)} · tendencia próxima: <strong>${fmt(item.grade)}/${item.scale}</strong></li>`).join("")
    || `<li class="muted">Necesitas al menos dos evaluaciones con fecha en una materia.</li>`;

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