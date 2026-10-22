/**
 * Lock: every module that names a Tips-contract event must agree on the
 * topic hash. The strict decoders (lib/leaderboard.ts) keep their own
 * string constant on purpose (dependency-free module); this test catches
 * drift between that constant and the shared contract-events source.
 */
import { describe, expect, it } from "vitest";
import { PURCHASE_TOPIC0, TIPSENT_TOPIC0 } from "./contract-events";
import { TIPSENT_TOPIC } from "../leaderboard";

describe("contract-events topic hashes", () => {
  it("TipSent topic matches the leaderboard's strict-decoder constant", () => {
    expect(TIPSENT_TOPIC0).toBe(TIPSENT_TOPIC);
    expect(TIPSENT_TOPIC0).toBe(
      "0xddb557901a5c7e767f2276c1190ca61ae148d62a74cfa61e4f7fa5319eaa431e",
    );
  });

  it("PurchaseCompleted topic matches the value every purchase reader already used", () => {
    expect(PURCHASE_TOPIC0).toBe(
      "0x8555727c6813e10ae0b5a9b0a53a88a93176679845f5a005a248cdb9f1c05f2e",
    );
  });
});
