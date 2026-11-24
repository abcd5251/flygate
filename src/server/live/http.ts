import "server-only";
import type { Env } from "./config";
import type { LiveService } from "./service";

/** Every Live route answers 404 unless the server runs with LIVE_MODE=on (D-08). */
export function liveEnabled(env: Env): boolean {
  return env.LIVE_MODE?.trim() === "on";
}

export function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

const NO_STORE = { "cache-control": "no-store" };

/** GET /api/live/status. `getService` is only called when Live is enabled. */
export async function handleLiveStatus(env: Env, getService: () => LiveService): Promise<Response> {
  if (!liveEnabled(env)) return notFound();
  return Response.json(await getService().status(), { headers: NO_STORE });
}
