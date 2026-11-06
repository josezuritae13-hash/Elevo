// Límites diarios controlados de forma atómica por Supabase.
import { HttpError, supabaseRequest, type Session } from "./shared.ts";

export type Quota = {
  allowed?: boolean;
  role: string;
  used: number;
  remaining: number;
  limit: number;
  conversations_used: number;
  conversations_remaining: number;
  conversations_limit: number;
};

export async function getQuota(session: Session): Promise<Quota> {
  const result = await supabaseRequest(session, "/rest/v1/rpc/elevate_get_ai_quota", { method: "POST", body: "{}" });
  if (!result || typeof result !== "object") throw new HttpError(502, "No se pudo consultar tu límite diario.");
  return result as Quota;
}

export async function consumeQuota(session: Session, newConversation: boolean): Promise<Quota> {
  const result = await supabaseRequest(session, "/rest/v1/rpc/elevate_consume_ai_quota", {
    method: "POST", body: JSON.stringify({ p_new_conversation: newConversation })
  });
  if (!result || typeof result !== "object") throw new HttpError(502, "No se pudo validar tu límite diario.");
  const quota = result as Quota;
  if (quota.allowed !== true) {
    const reason = quota.remaining <= 0
      ? `Llegaste al límite diario de ${quota.limit} mensajes de Elevate AI. Vuelve mañana.`
      : `Llegaste al límite de ${quota.conversations_limit} conversaciones diarias de Elevate AI. Vuelve mañana.`;
    throw new HttpError(429, reason);
  }
  return quota;
}
