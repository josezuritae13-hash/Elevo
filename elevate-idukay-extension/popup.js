'use strict';

const API_PATH = '/colegios/api/my_academic_calendar';
const DAY_SECONDS = 24 * 60 * 60;
const CHUNK_DAYS = 34;
const LOOKBACK_DAYS = 365;
const LOOKAHEAD_DAYS = 90;

const copyButton = document.getElementById('copy');
const diagnosticButton = document.getElementById('diag');
const messageElement = document.getElementById('msg');
const statsElement = document.getElementById('stats');
const detailsElement = document.getElementById('details');

function setMessage(message, type = '') {
  messageElement.textContent = message;
  messageElement.className = 'message' + (type ? ` ${type}` : '');
}

function setBusy(isBusy) {
  copyButton.disabled = isBusy;
  diagnosticButton.disabled = isBusy;
}

function hideExtraInfo() {
  statsElement.style.display = 'none';
  detailsElement.style.display = 'none';
  statsElement.textContent = '';
  detailsElement.textContent = '';
}

function getUtcMidnightTimestamp(date) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

// El año escolar empieza el 1 de septiembre: no se piden fechas anteriores
// (Idukay puede rechazar con 403 los rangos del año escolar anterior).
function getSchoolYearStart(now) {
  const year = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return Math.floor(Date.UTC(year, 8, 1) / 1000);
}

function getAcademicRange() {
  const now = new Date();
  const todayUtc = getUtcMidnightTimestamp(now);
  return {
    start: Math.max(todayUtc - LOOKBACK_DAYS * DAY_SECONDS, getSchoolYearStart(now)),
    end: todayUtc + LOOKAHEAD_DAYS * DAY_SECONDS
  };
}

function buildRequestUrl(startTimestamp, endTimestamp) {
  const requestUrl = new URL(API_PATH, 'https://idukay.net');
  requestUrl.searchParams.set('start_date', String(startTimestamp));
  requestUrl.searchParams.set('end_date', String(endTimestamp));
  return requestUrl.toString();
}

function timestampToDate(timestamp) {
  if (timestamp === null || timestamp === undefined || timestamp === '') return null;
  const numericTimestamp = Number(timestamp);
  if (!Number.isFinite(numericTimestamp)) return null;

  // Idukay entrega estos valores como segundos Unix. Se usa UTC para evitar
  // que la zona horaria del computador cambie el día de la actividad.
  return new Date(numericTimestamp * 1000).toISOString().slice(0, 10);
}

function normalizeScore(rawScore) {
  if (rawScore === null || rawScore === undefined || rawScore === '') return null;
  const score = Number(rawScore);
  return Number.isFinite(score) ? score : null;
}

function normalizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeActivity(activity) {
  const score = normalizeScore(activity.score);
  const normalized = {
    subject: normalizeText(activity.course) || 'Sin asignatura',
    title: normalizeText(activity.title) || 'Actividad sin título',
    score,
    date: timestampToDate(activity.start),
    endDate: timestampToDate(activity.end),
    description: normalizeText(activity.description),
    notes: normalizeText(activity.notes),
    status: score === null ? 'pending' : 'graded'
  };

  // No inventamos el tipo, el máximo de puntos ni un ID único: el _id de la
  // respuesta observada se repite entre varias actividades de una asignatura.
  const activityType = normalizeText(activity.type || activity.category);
  if (activityType) normalized.type = activityType;

  return normalized;
}

function makeActivityKey(activity) {
  return JSON.stringify([
    normalizeText(activity.course).toLocaleLowerCase(),
    normalizeText(activity.title).toLocaleLowerCase(),
    activity.start ?? null,
    activity.end ?? null,
    normalizeText(activity.description),
    normalizeText(activity.notes),
    activity.score ?? null
  ]);
}

async function getActiveIdukayTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.id || !tab.url) {
    throw new Error('No encuentro una pestaña activa. Abre Idukay e inténtalo de nuevo.');
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(tab.url);
  } catch {
    throw new Error('No se pudo identificar la página activa.');
  }

  if (parsedUrl.hostname !== 'idukay.net' || !parsedUrl.pathname.startsWith('/colegios')) {
    throw new Error('Abre https://idukay.net/colegios/ en esta pestaña y vuelve a intentarlo.');
  }

  return tab;
}

// Esta función se ejecuta dentro de la página de Idukay (MAIN world), para que
// el navegador utilice la sesión normal de la página mediante credentials: include.
async function fetchCalendarChunk(startTimestamp, endTimestamp) {
  const path = '/colegios/api/my_academic_calendar';
  const clientVersion = '12.0.3';
  const requestUrl = new URL(path, window.location.origin);
  requestUrl.searchParams.set('start_date', String(startTimestamp));
  requestUrl.searchParams.set('end_date', String(endTimestamp));
  const fail = extra => ({ ok: false, requestUrl: requestUrl.toString(), ...extra });

  let status = null;
  let data = null;
  let bodyText = '';
  let via = 'fetch';
  try {
    // 1) Se usa el cliente HTTP de la propia página (AngularJS): ya sabe autenticarse,
    //    así que la extensión no lee ni copia cookies, tokens ni contraseñas.
    const root = document.querySelector('[ng-app]') || document.documentElement;
    const injector = window.angular && window.angular.element(root).injector();
    if (injector) {
      via = 'angular';
      try {
        const res = await injector.get('$http').get(path, { params: { start_date: startTimestamp, end_date: endTimestamp }, headers: { clientversion: clientVersion } });
        status = res.status;
        data = res.data;
      } catch (httpError) {
        status = (httpError && httpError.status) || null;
        data = (httpError && httpError.data) || null;
      }
      bodyText = typeof data === 'string' ? data : JSON.stringify(data === undefined ? null : data);
    } else {
      // 2) Sin AngularJS: petición normal con la sesión de la página.
      const response = await fetch(requestUrl.toString(), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', clientversion: clientVersion }
      });
      status = response.status;
      bodyText = await response.text();
      try { data = JSON.parse(bodyText); } catch (parseError) { data = null; }
    }
  } catch (error) {
    return fail({ via, error: error instanceof Error ? error.message : 'No se pudo consultar Idukay.' });
  }

  const apiErrors = data && Array.isArray(data.errors) ? data.errors : [];
  const first = apiErrors[0];
  const errorCode = typeof first === 'string' ? first : (first && first.message) || null;
  const errorText = typeof first === 'string' ? first : (first && (first.custom_message || first.message)) || null;
  if (status === null || status < 200 || status >= 300 || apiErrors.length > 0) {
    return fail({
      via,
      httpStatus: status,
      error: errorText ? `Idukay respondió: ${errorText}.` : `Error HTTP ${status}.`,
      errorCode,
      requiredVersion: (first && first.required_version) || null,
      bodySnippet: String(bodyText).slice(0, 300)
    });
  }

  const payload = data && data.response;
  if (!payload || typeof payload !== 'object') {
    return fail({ via, httpStatus: status, error: 'La respuesta no contiene el objeto response esperado.', bodySnippet: String(bodyText).slice(0, 300) });
  }
  const activities = payload.courses && payload.courses.activities;
  return {
    ok: true,
    via,
    httpStatus: status,
    requestUrl: requestUrl.toString(),
    activities: Array.isArray(activities) ? activities : [],
    responseKeys: Object.keys(payload),
    errors: apiErrors
  };
}

async function runCalendarRequest(tabId, startTimestamp, endTimestamp) {
  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: fetchCalendarChunk,
    args: [startTimestamp, endTimestamp]
  });

  const result = injectionResults?.[0]?.result;
  if (!result) throw new Error('Idukay no devolvió ningún resultado a la extensión.');
  if (!result.ok) {
    const version = result.requiredVersion ? ` Versión requerida: ${result.requiredVersion}.` : '';
    const code = result.errorCode ? ` (${result.errorCode}).` : '';
    const error = new Error(`${result.error || 'No se pudo consultar Idukay.'}${version}${code}`);
    error.requestUrl = result.requestUrl || buildRequestUrl(startTimestamp, endTimestamp);
    error.errorCode = result.errorCode || null;
    error.requiredVersion = result.requiredVersion || null;
    error.httpStatus = result.httpStatus || null;
    error.bodySnippet = result.bodySnippet || null;
    error.contentType = result.contentType || null;
    throw error;
  }
  return result;
}

function buildExportJson(rawActivities, range) {
  const uniqueActivities = new Map();
  for (const activity of rawActivities) {
    if (!activity || typeof activity !== 'object') continue;
    uniqueActivities.set(makeActivityKey(activity), activity);
  }

  const activities = [...uniqueActivities.values()]
    .map(normalizeActivity)
    .sort((a, b) => {
      const dateCompare = (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31');
      return dateCompare || a.subject.localeCompare(b.subject, 'es');
    });

  const gradedCount = activities.filter(item => item.status === 'graded').length;
  const pendingCount = activities.length - gradedCount;
  const subjects = [...new Set(activities.map(item => item.subject))].sort((a, b) => a.localeCompare(b, 'es'));

  return {
    source: 'idukay',
    version: 1,
    exportedAt: new Date().toISOString(),
    dateRange: {
      startDate: timestampToDate(range.start),
      endDate: timestampToDate(range.end)
    },
    totals: {
      activities: activities.length,
      graded: gradedCount,
      pending: pendingCount,
      subjects: subjects.length
    },
    activities
  };
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch (clipboardError) {
    // Alternativa compatible con ventanas emergentes de extensiones de Chrome.
    const temporaryTextarea = document.createElement('textarea');
    temporaryTextarea.value = text;
    temporaryTextarea.setAttribute('readonly', '');
    temporaryTextarea.style.position = 'fixed';
    temporaryTextarea.style.opacity = '0';
    temporaryTextarea.style.pointerEvents = 'none';
    document.body.appendChild(temporaryTextarea);
    temporaryTextarea.select();
    temporaryTextarea.setSelectionRange(0, temporaryTextarea.value.length);
    const copied = document.execCommand('copy');
    temporaryTextarea.remove();

    if (!copied) {
      throw new Error('Chrome no permitió copiar el JSON. Comprueba el permiso de portapapeles.');
    }
  }
}

function showExportStats(exportData) {
  statsElement.style.display = 'block';
  statsElement.textContent =
    `${exportData.totals.activities} actividades · ` +
    `${exportData.totals.graded} calificadas · ` +
    `${exportData.totals.pending} pendientes · ` +
    `${exportData.totals.subjects} asignaturas`;
}

async function copyMyGrades() {
  hideExtraInfo();
  setBusy(true);
  try {
    setMessage('Conectando con Idukay…');
    const tab = await getActiveIdukayTab();
    const range = getAcademicRange();
    const span = CHUNK_DAYS * DAY_SECONDS;
    const chunks = [];

    for (let start = range.start; start <= range.end;) {
      const end = Math.min(start + span, range.end);
      chunks.push({ start, end });
      start = end + DAY_SECONDS;
    }

    const allActivities = [];
    const failures = [];
    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index];
      setMessage(`Consultando Idukay… bloque ${index + 1} de ${chunks.length}.`);
      try {
        const result = await runCalendarRequest(tab.id, chunk.start, chunk.end);
        allActivities.push(...result.activities);
      } catch (chunkError) {
        failures.push(chunkError);
      }
    }

    if (failures.length === chunks.length) {
      const first = failures[0];
      const hint = first && first.httpStatus === 403
        ? ' Recarga la página de Idukay, comprueba que tu sesión siga iniciada y vuelve a intentarlo.'
        : '';
      const failure = new Error(`${first ? first.message : 'No se pudo consultar Idukay.'}${hint}`);
      Object.assign(failure, {
        httpStatus: first?.httpStatus || null,
        requestUrl: first?.requestUrl || null,
        contentType: first?.contentType || null,
        bodySnippet: first?.bodySnippet || null
      });
      throw failure;
    }

    if (allActivities.length === 0) {
      throw new Error('Idukay respondió correctamente, pero no devolvió actividades en el período consultado.');
    }

    const exportData = buildExportJson(allActivities, range);
    const jsonText = JSON.stringify(exportData, null, 2);
    await copyTextToClipboard(jsonText);

    showExportStats(exportData);
    const warning = failures.length ? ` Ojo: ${failures.length} de ${chunks.length} bloques de fechas fallaron, así que pueden faltar actividades.` : '';
    setMessage('¡JSON copiado! Ahora pégalo en el importador de Elevate.' + warning, failures.length ? '' : 'success');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Ocurrió un error inesperado.', 'error');
    // Con el error, se muestran y se copian los detalles técnicos (la respuesta de Idukay, sin credenciales)
    const info = {
      error: error instanceof Error ? error.message : String(error),
      httpStatus: error?.httpStatus || null,
      requestUrl: error?.requestUrl || null,
      contentType: error?.contentType || null,
      bodySnippet: error?.bodySnippet || null
    };
    detailsElement.style.display = 'block';
    detailsElement.textContent = JSON.stringify(info, null, 2);
    try {
      await copyTextToClipboard(detailsElement.textContent);
      setMessage(`${messageElement.textContent} (Detalles copiados al portapapeles: pégalos en el chat.)`, 'error');
    } catch (copyError) { /* se pueden copiar a mano */ }
  } finally {
    setBusy(false);
  }
}

// Muestra los campos de una actividad (con textos cortos) para saber qué datos entrega Idukay
function describeActivity(activity) {
  if (!activity) return null;
  return Object.fromEntries(Object.entries(activity).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 80) : value]));
}

async function runDiagnostic() {
  hideExtraInfo();
  setBusy(true);
  try {
    setMessage('Comprobando la conexión con Idukay…');
    const tab = await getActiveIdukayTab();
    const range = getAcademicRange();
    const center = getUtcMidnightTimestamp(new Date());
    const halfWindow = Math.floor((CHUNK_DAYS * DAY_SECONDS) / 2);
    const start = Math.max(range.start, center - halfWindow);
    const end = Math.min(range.end, center + halfWindow);
    const result = await runCalendarRequest(tab.id, start, end);

    const diagnostic = {
      application: 'Elevate',
      diagnosis: 'OK',
      requestUrl: result.requestUrl,
      httpStatus: result.httpStatus,
      via: result.via,
      activitiesCount: result.activities.length,
      sample: describeActivity(result.activities[0]),
      responseKeys: result.responseKeys,
      errors: []
    };

    detailsElement.style.display = 'block';
    detailsElement.textContent = JSON.stringify(diagnostic, null, 2);
    try { await copyTextToClipboard(detailsElement.textContent); } catch (copyError) { /* se puede copiar a mano */ }
    setMessage(`Conexión correcta. Idukay devolvió ${result.activities.length} actividades en esta consulta. Diagnóstico copiado.`, 'success');
  } catch (error) {
    const diagnosticRange = getAcademicRange();
    const diagnosticCenter = getUtcMidnightTimestamp(new Date());
    const diagnosticHalfWindow = Math.floor((CHUNK_DAYS * DAY_SECONDS) / 2);
    const diagnosticStart = Math.max(diagnosticRange.start, diagnosticCenter - diagnosticHalfWindow);
    const diagnosticEnd = Math.min(diagnosticRange.end, diagnosticCenter + diagnosticHalfWindow);
    const diagnostic = {
      application: 'Elevate',
      diagnosis: 'ERROR',
      requestUrl: error?.requestUrl || buildRequestUrl(diagnosticStart, diagnosticEnd),
      httpStatus: error?.httpStatus || null,
      error: error instanceof Error ? error.message : 'Error desconocido',
      errorCode: error?.errorCode || null,
      bodySnippet: error?.bodySnippet || null,
      contentType: error?.contentType || null,
      requiredVersion: error?.requiredVersion || null,
      errors: []
    };
    detailsElement.style.display = 'block';
    detailsElement.textContent = JSON.stringify(diagnostic, null, 2);
    try { await copyTextToClipboard(detailsElement.textContent); } catch (copyError) { /* se puede copiar a mano */ }
    setMessage('No se pudo completar la prueba. Diagnóstico copiado al portapapeles.', 'error');
  } finally {
    setBusy(false);
  }
}

copyButton.addEventListener('click', copyMyGrades);
diagnosticButton.addEventListener('click', runDiagnostic);