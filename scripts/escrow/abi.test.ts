import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { toEventSelector, toFunctionSelector } from "viem";
import { escrowAbi } from "../../src/lib/escrow";

// Source of truth: the compiled contract, via `forge inspect` (needs forge on PATH).
const root = resolve(import.meta.dirname, "../..");
const inspect = (field: string) =>
  JSON.parse(execFileSync("forge", ["inspect", "FlightEscrow", field, "--json"], { cwd: root, encoding: "utf8" }));

test("escrowAbi selectors match the compiled FlightEscrow", () => {
  const fns: Record<string, string> = inspect("methodIdentifiers");
  const events: Record<string, string> = inspect("events");
  const want = {
    fns: Object.fromEntries(Object.entries(fns).map(([sig, id]) => [id, sig])),
    events: Object.fromEntries(Object.entries(events).map(([sig, id]) => [id, sig])),
  };
  for (const item of escrowAbi) {
    if (item.type === "function") {
      const id = toFunctionSelector(item).slice(2);
      assert.ok(want.fns[id], `function ${item.name} (${id}) not in FlightEscrow`);
    } else if (item.type === "event") {
      const id = toEventSelector(item);
      assert.ok(want.events[id] ?? want.events[id.slice(2)], `event ${item.name} not in FlightEscrow`);
    }
  }
});
