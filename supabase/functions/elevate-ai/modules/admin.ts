// Escrituras del servidor con service_role, limitadas a las tablas de Elevate AI.
//
// Por qué existe: el cliente (el navegador) ya NO puede insertar en ai_messages,
// ai_recommendations ni ai_conversations. Así un estudiante no puede fabricar
// respuestas del asistente en su historial. Solo esta función, después de autenticar
// al estudiante, escribe en esas tablas.
//
// La clave service_role vive únicamente en los secretos de la Edge Function.
// Nunca la pongas en app.js, en el HTML ni en GitHub.

import { HttpError } from "./shared.ts";

const ADMIN_TABLES = new Set(["ai_conversations", "ai_messages", "ai_recommendations"]);

export type Admin = { baseUrl: string; serviceKey: string };

export async function adminWrite(
  admin: Admin,
  table: string,
  init: RequestInit & { query?: string }
): Promise<unknown> {
  if (!ADMIN_TABLES.has(table)) throw new HttpError(500, "Tabla no permitida para escritura del servidor.");
  const { query, ...rest } = init;
  const response = await fetch(`${admin.baseUrl.replace(/\/$/, "")}/rest/v1/${table}${query || ""}`, {
    ...rest,
    headers: {
      apikey: admin.serviceKey,
      Authorization: `Bearer ${admin.serviceKey}`,
      "Content-Type": "application/json",
      ...(rest.headers || {})
    }
  });
  if (!response.ok) throw new HttpError(502, "No se pudieron guardar los datos de Elevate AI.");
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
