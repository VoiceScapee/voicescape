import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * GET /api/intros is the PUBLIC agent-intros board. A claim code is a
 * one-time bearer secret: listing it publicly lets anyone claim someone
 * else's intro (this exact defect was observed live 2026-10-01). The
 * mapped feed shape must never carry claim_code. ip_hash stays out too.
 */
describe("GET /api/intros (public feed privacy)", () => {
  const routeSrc = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

  it("never maps claim_code into the public response", () => {
    expect(routeSrc).not.toMatch(/claim_code:\s*i\.claim_code/);
  });

  it("never maps ip_hash into the public response", () => {
    expect(routeSrc).not.toMatch(/ip_hash:\s*i\.ip_hash/);
  });

  it("the public intros array shape carries only the safe fields", () => {
    const shape = routeSrc.match(/Array<\{([\s\S]*?)\}>/);
    expect(shape).not.toBeNull();
    expect(String(shape?.[1])).not.toMatch(/claim_code/);
    expect(String(shape?.[1])).not.toMatch(/ip_hash/);
  });

  it("documents the privacy rule in the file header", () => {
    expect(routeSrc).toMatch(/never exposes claim_code/i);
  });
});
