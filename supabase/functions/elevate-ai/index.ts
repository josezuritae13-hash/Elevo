
// Elevate AI — punto de entrada de la Edge Function.
// La lógica vive en ./modules: auth, context, academic, chat, recommendations, ai-provider, quota.

import { loadModelConfig } from "./modules/ai-provider.ts";
import { authenticateStudent, loadFunctionConfig } from "./modules/auth.ts";
import { handleChat } from "./modules/chat.ts";
import { buildAcademicContext } from "./modules/context.ts";
import { corsHeaders, isOriginAllowed, jsonResponse } from "./modules/http.ts";
import { getRecommendations } from "./modules/recommendations.ts";
import { HttpError, isRecord } from "./modules/shared.ts";

const MAX_BODY_CHARS = 12000;

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

    if (action !== "chat" && action !== "recommendations") {
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

    const result = await handleChat(
      session,
      admin,
      message,
      conversationId,
      context,
      model
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
