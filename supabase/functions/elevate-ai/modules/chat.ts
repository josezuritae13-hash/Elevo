// Chat con el tutor. Los mensajes (del estudiante y del asistente) los guarda el servidor.

import { adminWrite, type Admin } from "./admin.ts";
import { callModel, tutorInstructions, type ModelConfig } from "./ai-provider.ts";
import { consumeQuota } from "./quota.ts";
import {
  HttpError, isRecord, selectRows, type ConversationMessage, type Session
} from "./shared.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleChat(
  session: Session,
  admin: Admin,
  message: string,
  requestedConversationId: string | null,
  context: Record<string, unknown>,
  model: ModelConfig
): Promise<Record<string, unknown>> {
  let history: ConversationMessage[] = [];
  if (requestedConversationId) {
    if (!UUID.test(requestedConversationId)) {
      throw new HttpError(400, "La conversación seleccionada no es válida.");
    }
    // Se comprueba la propiedad con el token del estudiante (RLS) antes de escribir con el servidor.
    const conversations = await selectRows<{ id: string }>(session, "ai_conversations", {
      id: `eq.${requestedConversationId}`, user_id: `eq.${session.userId}`, select: "id", limit: "1"
    });
    if (!conversations.length) throw new HttpError(404, "No se encontró esa conversación.");
    const previous = await selectRows<ConversationMessage>(session, "ai_messages", {
      conversation_id: `eq.${requestedConversationId}`,
      user_id: `eq.${session.userId}`,
      select: "role,content",
      order: "created_at.desc",
      limit: "12"
    });
    history = previous.reverse();
  }

  await consumeQuota(session);
  const answer = await callModel(model, [
    {
      role: "system",
      content: `${tutorInstructions} Contexto académico actualizado y verificado por Elevate (JSON): ${JSON.stringify(context)}`
    },
    ...history,
    { role: "user", content: message }
  ]);

  const now = Date.now();
  let conversationId = requestedConversationId;
  if (!conversationId) {
    const created = await adminWrite(admin, "ai_conversations", {
      method: "POST",
      query: "?select=id",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        user_id: session.userId,
        title: message.slice(0, 96) || "Nueva conversación",
        updated_at: new Date(now + 1000).toISOString()
      })
    });
    if (!Array.isArray(created) || !isRecord(created[0]) || typeof created[0].id !== "string") {
      throw new HttpError(502, "No se pudo guardar la conversación.");
    }
    conversationId = created[0].id;
  } else {
    await adminWrite(admin, "ai_conversations", {
      method: "PATCH",
      query: `?id=eq.${conversationId}&user_id=eq.${session.userId}`,
      body: JSON.stringify({ updated_at: new Date(now + 1000).toISOString() })
    });
  }

  await adminWrite(admin, "ai_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        conversation_id: conversationId,
        user_id: session.userId,
        role: "user",
        content: message,
        created_at: new Date(now).toISOString()
      },
      {
        conversation_id: conversationId,
        user_id: session.userId,
        role: "assistant",
        content: answer.slice(0, 6000),
        created_at: new Date(now + 1).toISOString()
      }
    ])
  });
  return { conversation_id: conversationId, answer };
}
