
// Elevate AI — punto de entrada de la Edge Function.
// La lógica vive en ./modules: auth, context, academic, chat, recommendations, ai-provider, quota.

import { loadModelConfig } from "./modules/ai-provider.ts";
import { authenticateStudent, loadFunctionConfig } from "./modules/auth.ts";
import { handleChat } from "./modules/chat.ts";
import { getQuota } from "./modules/quota.ts";
import { adminWrite } from "./modules/admin.ts";
import { buildAcademicContext } from "./modules/context.ts";
import { corsHeaders, isOriginAllowed, jsonResponse } from "./modules/http.ts";
import { getRecommendations } from "./modules/recommendations.ts";
import { HttpError, isRecord, selectRows } from "./modules/shared.ts";

const MAX_BODY_CHARS = 12000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(request) });
  }

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Método no permitido." }, 405);
  }

  try {
    if (!isOriginAllowed(request)) {
      throw new HttpError(403, "Origen no permitido.");
    }

    const contentLength = Number(
      request.headers.get("content-length") || 0
    );

    if (contentLength > MAX_BODY_CHARS) {
      throw new HttpError(413, "La solicitud es demasiado grande.");
    }

    const rawBody = await request.text();

    if (rawBody.length > MAX_BODY_CHARS) {
      throw new HttpError(413, "La solicitud es demasiado grande.");
    }

    let input: unknown;

    try {
      input = JSON.parse(rawBody);
    } catch {
      throw new HttpError(400, "La solicitud no tiene un formato JSON válido.");
    }

    if (!isRecord(input)) {
      throw new HttpError(400, "La solicitud no es válida.");
    }

    const config = loadFunctionConfig();
    const session = await authenticateStudent(request, config);

    const admin = {
      baseUrl: config.baseUrl,
      serviceKey: config.serviceKey
    };

    const action = input.action;

    if (action !== "chat" && action !== "recommendations" && action !== "quota" && action !== "rename_conversation") {
      throw new HttpError(400, "La acción solicitada no es válida.");
    }

    const message =
      typeof input.message === "string"
        ? input.message.trim()
        : "";

    if (action === "chat" && (!message || message.length > 2000)) {
      throw new HttpError(
        400,
        "Escribe un mensaje de hasta 2000 caracteres."
      );
    }

    const conversationId =
      typeof input.conversation_id === "string"
        ? input.conversation_id
        : null;

    const refresh = input.refresh === true;

    if (action === "quota") {
      return jsonResponse(request, { quota: await getQuota(session) });
    }

    if (action === "rename_conversation") {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (!conversationId || !UUID.test(conversationId) || !title || title.length > 100) {
        throw new HttpError(400, "Indica una conversación válida y un nombre de hasta 100 caracteres.");
      }
      const owned = await selectRows<{ id: string }>(session, "ai_conversations", {
        id: `eq.${conversationId}`, user_id: `eq.${session.userId}`, select: "id", limit: "1"
      });
      if (!owned.length) throw new HttpError(404, "No se encontró esa conversación.");
      await adminWrite(admin, "ai_conversations", {
        method: "PATCH", query: `?id=eq.${conversationId}&user_id=eq.${session.userId}`,
        body: JSON.stringify({ title, updated_at: new Date().toISOString() })
      });
      return jsonResponse(request, { success: true });
    }

    const model = loadModelConfig();
    const context = await buildAcademicContext(session);

    if (action === "recommendations") {
      const result = await getRecommendations(
        session,
        admin,
        context,
        model,
        refresh
      );

      return jsonResponse(request, result);
    }

    const temporaryHistory = Array.isArray(input.history)
      ? input.history.slice(-12).filter((item): item is Record<string, unknown> =>
          isRecord(item) && (item.role === "user" || item.role === "assistant") &&
          typeof item.content === "string" && item.content.length <= 6000
        ).map(item => ({ role: item.role as "user" | "assistant", content: String(item.content) }))
      : [];

    const result = await handleChat(
      session,
      admin,
      message,
      conversationId,
      context,
      model,
      input.temporary === true,
      temporaryHistory
    );

    return jsonResponse(request, result);

  } catch (error) {
    console.error("========== ELEVATE AI ERROR ==========");
    console.error("Error:", error);

    console.error(
      "Message:",
      error instanceof Error ? error.message : String(error)
    );

    console.error(
      "Stack:",
      error instanceof Error ? error.stack : "No stack available"
    );

    console.error("======================================");

    if (error instanceof HttpError) {
      return jsonResponse(
        request,
        { error: error.message },
        error.status
      );
    }

    return jsonResponse(
      request,
      {
        error: "Ocurrió un error inesperado en Elevate AI."
      },
      500
    );
  }
});
