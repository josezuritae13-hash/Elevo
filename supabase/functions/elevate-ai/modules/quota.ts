// Límite diario de solicitudes por estudiante (20).

import { HttpError, supabaseRequest, type Session } from "./shared.ts";

export async function consumeQuota(session: Session): Promise<void> {
  const result = await supabaseRequest(session, "/rest/v1/rpc/elevate_consume_ai_quota", {
    method: "POST",
    body: "{}"
  });
  if (result !== true) throw new HttpError(429, "Llegaste al límite de 20 solicitudes de Elevate AI por hoy.");
}
