/**
 * Human/agent label honesty (Clearance first pass, 2026-11-27, F2).
 *
 * `registerPage` takes `ownerType` from the caller, and HUMAN pages skip
 * operator/purpose disclosure entirely — so a page served back as "human"
 * with zero operator and empty purpose proves nothing about who runs it.
 * The label is a self-declared claim, never a verified fact.
 *
 * What CAN be verified on-chain: an AGENT registration is only accepted
 * by the Registry when it discloses a non-zero operator AND a non-empty
 * purpose (else `DisclosureRequired`), so an agent page whose record
 * carries both has verifiably disclosed an operator. Everything else —
 * every HUMAN page, and any AGENT page whose record lacks the disclosure
 * (e.g. registered before enforcement) — is unverified.
 *
 * That disclosure check is tier one. Tier two is HCS-10 registration —
 * the operator's inbound + outbound topics and the registry `register`
 * message — checked by the existing standard route
 * GET /api/agents/verify-registration (mirror-node REST only, cached +
 * rate-limited; see lib/server/agents/verify-registration.ts). The
 * HCS-10 fan-out (topic scan + registry scan) is deliberately NOT run
 * inside this helper or inside lookupBlockpage: it lives behind its own
 * cached endpoint, and every surface that shows the label carries an
 * `hcs10_verification_url` pointing at it for agent pages. No custom
 * chain plumbing anywhere: mirror-node REST + the Registry's own
 * resolvePage, nothing else.
 *
 * One shared assessment for every surface that shows the label: the MCP
 * lookup_blockpage tool, /api/resolve, the agent directory, search_agents,
 * the profile page, and the following digest. The `owner_type` field
 * itself stays (it is the registered claim); it is always accompanied by
 * `owner_type_verified` + `owner_type_note` so no consumer can mistake
 * the claim for a verified fact.
 */

export type OwnerTypeClaim = "human" | "agent";

export interface OwnerTypeAssessment {
  /** The self-declared label from the Registry record — a claim, not a verified fact. */
  owner_type: OwnerTypeClaim;
  /**
   * True only when the on-chain record backs the claim: an AGENT page
   * with a non-zero operator and a non-empty purpose disclosed at
   * registration. HUMAN pages are never verified — the Registry does not
   * verify human identity.
   */
  owner_type_verified: boolean;
  /** Plain-language note for API consumers and UI copy. */
  owner_type_note: string;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function assessOwnerType(
  ownerType: number | bigint,
  operator?: string | null,
  purpose?: string | null,
): OwnerTypeAssessment {
  const isAgent = Number(ownerType) === 1;
  const operatorPresent =
    typeof operator === "string" &&
    operator.trim() !== "" &&
    operator.toLowerCase() !== ZERO_ADDRESS;
  const purposePresent = typeof purpose === "string" && purpose.trim() !== "";
  if (isAgent) {
    const verified = operatorPresent && purposePresent;
    return {
      owner_type: "agent",
      owner_type_verified: verified,
      owner_type_note: verified
        ? "agent — operator and purpose disclosed on-chain at registration (verified)"
        : "agent — claimed at registration; operator or purpose disclosure is missing on-chain, so the agent claim is unverified",
    };
  }
  return {
    owner_type: "human",
    owner_type_verified: false,
    owner_type_note:
      "human — self-declared at registration; the Registry does not verify human identity, so this label is unverified",
  };
}
