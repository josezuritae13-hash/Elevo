// Tipos, errores y utilidades compartidas por los módulos de Elevate AI.

export type SubjectRow = {
  id: string;
  name: string;
  scale_max: number | string;
  category_weights: Record<string, number> | null;
};

export type AssessmentRow = {
  id: string;
  subject_id: string;
  name: string;
  type: string;
  score: number | string | null;
  max_score: number | string;
  weight: number | string | null;
  term: number;
  date: string | null;
  created_at: string;
};

export type GoalRow = {
  id: string;
  subject_id: string | null;
  title: string;
  description: string | null;
  start_value: number | string | null;
  target_value: number | string | null;
  deadline: string | null;
  status: string;
};

export type ActionRow = {
  goal_id: string;
  description: string;
  status: string;
  due_date: string | null;
};

export type StudySessionRow = {
  study_date: string;
  duration_minutes: number;
  subject: string;
};

export type AssignmentRow = {
  id: string;
  title: string;
  due_at: string;
};

export type SubmissionRow = {
  assignment_id: string;
  completed: boolean;
};

export type AttendanceRow = {
  attendance_date: string;
  status: string;
};

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

/** Mensaje enviado al modelo (incluye el rol "system", que nunca se guarda en el historial). */
export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type Recommendation = {
  title: string;
  reason: string;
  action: string;
  subject: string | null;
};

/** Sesión del estudiante ya autenticada. Todas las lecturas usan SU token (RLS). */
export type Session = {
  baseUrl: string;
  anonKey: string;
  token: string;
  userId: string;
  email: string;
  role: "student" | "teacher";
};

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new HttpError(503, `Falta configurar el secreto ${name} en Supabase.`);
  return value;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Recorta texto libre del estudiante antes de enviarlo al modelo (menos datos, menos superficie de inyección). */
export function clip(text: string | null | undefined, max: number): string | null {
  if (typeof text !== "string") return null;
  const clean = text.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Petición a la API REST de Supabase con el token del estudiante (respeta RLS). */
export async function supabaseRequest(
  session: Session,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const response = await fetch(`${session.baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      apikey: session.anonKey,
      Authorization: `Bearer ${session.token}`,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(response.status, "No tienes permiso para consultar estos datos.");
    }
    throw new HttpError(502, "No se pudieron leer o guardar los datos de Elevate AI.");
  }
  return await readJson(response);
}

export async function selectRows<T>(
  session: Session,
  table: string,
  params: Record<string, string>
): Promise<T[]> {
  const query = new URLSearchParams(params);
  const result = await supabaseRequest(session, `/rest/v1/${table}?${query}`);
  if (!Array.isArray(result)) throw new HttpError(502, `Respuesta inesperada al consultar ${table}.`);
  return result as T[];
}
