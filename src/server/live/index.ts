import "server-only";
import { readLiveConfig } from "./config";
import { createDianaChain } from "./diana";
import { createLiveService, type LiveService } from "./service";

export { handleLiveStatus } from "./http";

const globalForLive = globalThis as typeof globalThis & { __flygateLive?: LiveService };

/**
 * The process-wide Live service, built from the server environment on first use. Kept on
 * globalThis so dev hot reloads keep its status cache (and, from #20, its idempotency table).
 */
export function getLiveService(): LiveService {
  if (!globalForLive.__flygateLive) {
    const config = readLiveConfig(process.env);
    globalForLive.__flygateLive = createLiveService({
      chain: createDianaChain(config.network),
      config,
      clock: { now: () => Date.now() },
    });
  }
  return globalForLive.__flygateLive;
}
