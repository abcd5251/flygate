import { getLiveService, handleLiveMandate } from "@/server/live";

/** The owner's side of a Live /mandate: build the wallet tx, confirm it, close, read (ADR-0003). */
export async function POST(request: Request) {
  return handleLiveMandate(process.env, getLiveService, request);
}
