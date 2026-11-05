// Autenticación del estudiante y acceso de escritura acotado.

import { HttpError, isRecord, readJson, requireEnv, selectRows, type Session } from "./shared.ts";

export type FunctionConfig = {
  baseUrl: string;
  anonKey: string;
  serviceKey: string;
};

export function loadFunctionConfig(): FunctionConfig {
  const baseUrl = requireEnv("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  if (!anonKey) throw new HttpError(503, "Falta la clave pública de Supabase en la configuración de la función.");
  // Solo se usa en el servidor, para guardar mensajes del asistente (ver admin.ts).
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("ELEVATE_SERVICE_ROLE_KEY");
  if (!serviceKey) throw new HttpError(503, "Falta configurar el secreto SUPABASE_SERVICE_ROLE_KEY en Supabase.");
  return { baseUrl, anonKey, serviceKey };
}

export function parseBearer(request: Request): string {
  const value = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(value);
  if (!match) throw new HttpError(401, "Inicia sesión para usar Elevate AI.");
  return match[1];
}

/** Valida el token con Supabase Auth y exige una cuenta de estudiante. */
export async function authenticateStudent(request: Request, config: FunctionConfig): Promise<Session> {
  const token = parseBearer(request);
  const authResponse = await fetch(`${config.baseUrl.replace(/\/$/, "")}/auth/v1/user`, {
    headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` }
  });
  const authUser = await readJson(authResponse);
  if (!authResponse.ok || !isRecord(authUser) || typeof authUser.id !== "string") {
    throw new HttpError(401, "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  const session: Session = { baseUrl: config.baseUrl, anonKey: config.anonKey, token, userId: authUser.id };
  const profiles = await selectRows<{ id: string; role: string }>(session, "profiles", {
    id: `eq.${session.userId}`, select: "id,role", limit: "1"
  });
  if (!profiles[0] || profiles[0].role !== "student") {
    throw new HttpError(403, "Elevate AI está disponible para cuentas de estudiante.");
  }
  return session;
}
