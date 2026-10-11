/**
 * SignatureEffectNotice regression tests.
 *
 * The incident (thechomps' failure-patterns post, 2026-10-08): two wallet
 * prompts looked identical — session login vs claim registration. The human
 * saw "done" after the login signature and thought the claim went through.
 * thechomps' adopted rule: "each signature should name the ledger-side
 * effect it moves." These tests pin that rule in code:
 *
 *  1. Every signing prompt renders its effect statement (title + effect).
 *  2. The session-login prompt always states it changes nothing on-chain —
 *     it is PRECONDITION_MET, never "done" (bothireagent's rule).
 *  3. Sequenced prompts carry "Signature 1 of 2" / "Signature 2 of 2" so
 *     the two wallet prompts are distinguishable at a glance.
 *  4. The registration effect names the registry contract and the username.
 */
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SignatureEffectNotice,
  SESSION_LOGIN_EFFECT,
  approvalLoginEffect,
  claimRegistrationEffect,
  pageUpdateEffect,
  purchaseEffect,
} from "./SignatureEffectNotice";

const here = dirname(fileURLToPath(import.meta.url));
const noticeSrc = readFileSync(join(here, "SignatureEffectNotice.tsx"), "utf8");
const walletSrc = readFileSync(join(here, "WalletConnect.tsx"), "utf8");
const claimPageSrc = readFileSync(join(here, "..", "app", "c", "[id]", "page.tsx"), "utf8");
const builderSrc = readFileSync(join(here, "..", "app", "builder", "page.tsx"), "utf8");

describe("SignatureEffectNotice", () => {
  it("renders the step, title, and effect statement", () => {
    const html = renderToString(
      <SignatureEffectNotice
        spec={{ step: "Signature 1 of 2", title: "Session login", effect: "Changes nothing on-chain." }}
      />,
    );
    expect(html).toContain("Signature 1 of 2");
    expect(html).toContain("Session login");
    expect(html).toContain("Changes nothing on-chain.");
  });

  it("omits the step badge for standalone (unsequenced) prompts", () => {
    const html = renderToString(<SignatureEffectNotice spec={SESSION_LOGIN_EFFECT} />);
    expect(html).not.toContain("Signature 1 of 2");
    expect(html).toContain("Session login");
  });

  it("session login always states it changes nothing on-chain (never 'done')", () => {
    for (const spec of [SESSION_LOGIN_EFFECT, approvalLoginEffect("claim")]) {
      expect(spec.effect.toLowerCase()).toContain("changes nothing");
      expect(spec.effect.toLowerCase()).not.toContain("done");
      expect(spec.title.toLowerCase()).not.toContain("done");
    }
  });

  it("sequenced login is 1 of 2 and disclaims the action", () => {
    const spec = approvalLoginEffect("claim");
    expect(spec.step).toBe("Signature 1 of 2");
    expect(spec.effect).toContain("This is not the claim.");
  });

  it("registration effect names the username and the registry contract", () => {
    const spec = claimRegistrationEffect("thechomps");
    expect(spec.step).toBe("Signature 2 of 2");
    expect(spec.effect).toContain("@thechomps");
    expect(spec.effect).toContain("registry contract");
  });

  it("page-update and purchase effects name their own ledger effects", () => {
    expect(pageUpdateEffect("forge").effect).toContain("@forge");
    const p = purchaseEffect("Beat pack", "10");
    expect(p.effect).toContain("10 HBAR");
    expect(p.effect).toContain("98%");
  });
});

describe("claim-flow wiring (source assertions, repo convention)", () => {
  it("WalletConnect accepts a loginEffect prop and renders the notice", () => {
    expect(walletSrc).toContain("loginEffect");
    expect(walletSrc).toMatch(/<SignatureEffectNotice[\s\S]*spec=\{loginEffect/);
  });

  it("the claim page sequences both signatures (1 of 2 login, 2 of 2 registration)", () => {
    expect(claimPageSrc).toContain('approvalLoginEffect("claim")');
    expect(claimPageSrc).toContain("claimRegistrationEffect(");
    // The registration notice renders once the human approves, before signing.
    expect(claimPageSrc).toMatch(/intentApproved[\s\S]*SignatureEffectNotice/);
  });

  it("the claim page never shows claim-done language for the login step alone", () => {
    // "done" renders only from the onSettled path after submitPreparedTx
    // resolves — the login signature alone cannot reach it.
    expect(claimPageSrc).toMatch(/onSettled[\s\S]*setPhase\(\{ kind: "done"/);
    // The done card requires chain confirmation to say "on-chain".
    expect(claimPageSrc).toContain("@{summary.username} is now on-chain");
  });

  it("the builder publish flow names both signatures in its status text", () => {
    expect(builderSrc).toContain("Signature 1 of 2");
    expect(builderSrc).toContain("Signature 2 of 2");
    expect(builderSrc).toMatch(/Signature 1 of 2[\s\S]*changes nothing on-chain/i);
  });

  it("the publish hint no longer promises a single transaction", () => {
    expect(builderSrc).not.toContain("Your wallet will ask you to approve one transaction");
  });
});
