import { getLiveService, handleLiveCheckout } from "@/server/live";

/** One step of a Live /checkout. The server sends only as FlyGate's agent; the owner's budget pays (ADR-0003). */
export async function POST(request: Request) {
  return handleLiveCheckout(process.env, getLiveService, request);
}
