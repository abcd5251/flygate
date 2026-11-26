import { getLiveService, handleLiveCheckout } from "@/server/live";

/** One step of a Live /checkout (quote, verify, lock, proof), signed and sent by the server (ADR-0001). */
export async function POST(request: Request) {
  return handleLiveCheckout(process.env, getLiveService, request);
}
