// CORS y respuestas JSON.

const BASE_HEADERS = {
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

/**
 * Orígenes permitidos: secreto ELEVATE_ALLOWED_ORIGINS, separados por comas
 * (por ejemplo "https://elevate.netlify.app,http://127.0.0.1:5500").
 * Si no está configurado se mantiene el comportamiento anterior ("*") para no romper la app.
 */
export function allowedOrigins(): string[] {
  return (Deno.env.get("ELEVATE_ALLOWED_ORIGINS") || "")
    .split(",")
    .map(origin => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function isOriginAllowed(request: Request): boolean {
  const allowed = allowedOrigins();
  const origin = request.headers.get("origin");
  if (!allowed.length || !origin) return true;
  return allowed.includes(origin);
}

export function corsHeaders(request: Request): Record<string, string> {
  const allowed = allowedOrigins();
  if (!allowed.length) return { ...BASE_HEADERS, "Access-Control-Allow-Origin": "*" };
  const origin = request.headers.get("origin");
  if (origin && allowed.includes(origin)) {
    return { ...BASE_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }
  return { ...BASE_HEADERS, Vary: "Origin" };
}

export function jsonResponse(request: Request, body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request) });
}
