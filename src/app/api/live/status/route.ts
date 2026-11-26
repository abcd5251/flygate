import { connection } from "next/server";
import { getLiveService, handleLiveStatus } from "@/server/live";

/** Whether Live mode can run, with public addresses and the reason when it cannot. */
export async function GET() {
  // Run at request time: the answer depends on runtime env vars and chain reads.
  await connection();
  return handleLiveStatus(process.env, getLiveService);
}
