import { getLiveService, handleLiveMandate } from "@/server/live";

/** One owner tx of a Live /mandate (link, window or mandate), sent by the server (ADR-0001). */
export async function POST(request: Request) {
  return handleLiveMandate(process.env, getLiveService, request);
}
