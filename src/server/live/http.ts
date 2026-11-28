import "server-only";
import type { Env } from "./config";
import { BadRequest } from "./mandate";
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

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400, headers: NO_STORE });
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return Response.json({ error: "Body must be an object" }, { status: 400, headers: NO_STORE });
  return body as Record<string, unknown>;
}

/**
 * POST /api/live/checkout with `{ step, offerId?, scenario?, mandate?, bookingId?, pnr?, owner?,
 * sessionKey? }`: one /checkout step. Only those structured fields are read (D-08). 400 for
 * malformed input.
 */
export async function handleLiveCheckout(env: Env, getService: () => LiveService, request: Request): Promise<Response> {
  if (!liveEnabled(env)) return notFound();
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const { step, offerId, scenario, mandate, bookingId, pnr, owner, sessionKey } = body;
  try {
    return Response.json(await getService().checkout({ step, offerId, scenario, mandate, bookingId, pnr, owner, sessionKey }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BadRequest) return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    throw err;
  }
}

/**
 * POST /api/live/mandate with `{ action, mandate?, owner?, controlHash?, txHash? }`: the owner's
 * side of /mandate. The server builds every message and calldata itself (D-08); the owner's QoreX
 * wallet signs and sends them (ADR-0003). 400 for malformed input.
 */
export async function handleLiveMandate(env: Env, getService: () => LiveService, request: Request): Promise<Response> {
  if (!liveEnabled(env)) return notFound();
  const body = await readBody(request);
  if (body instanceof Response) return body;
  const { action, mandate, owner, controlHash, txHash } = body;
  try {
    return Response.json(await getService().mandate({ action, mandate, owner, controlHash, txHash }), { headers: NO_STORE });
  } catch (err) {
    if (err instanceof BadRequest) return Response.json({ error: err.message }, { status: 400, headers: NO_STORE });
    throw err;
  }
}
