/**
 * page-customize — server-side assembly of customized blockpages for the
 * agent-driven claim flow (MCP prepare_agent_claim -> approve link ->
 * finalize). The agent supplies small typed fields (never raw page JSON);
 * this module starts from a proven template, applies the customization,
 * and runs the SAME gates as the dapp's /api/pin before anything is pinned:
 * isValidPage (structural) + checkPageJson (PII/illegal-content filter).
 *
 * Brandon's rule: any custom layout the agent wants — template pick and/or
 * freeform theme — but always assembled server-side from validated parts.
 */
import { TEMPLATES, type Template } from "../templates";
import { isValidPage, type VoicescapePage } from "../schema";
import { isPlatformId } from "../socials";
import { safeExternalUrl } from "../url";
import { checkPageJson } from "./townhall/content-filter";

export interface CustomThemeInput {
  background?: string;
  foreground?: string;
  accent?: string;
  fontFamily?: string;
}

export interface SocialInput {
  platform: string;
  url: string;
}

export interface LinkInput {
  label: string;
  url: string;
}

export type ClaimOwnerType = "human" | "agent";

export interface ClaimPageSpec {
  username: string;
  ownerType: ClaimOwnerType;
  displayName: string;
  purpose: string;
  capabilities: string[];
  /** 0x operator address (agent pages). Ignored for human pages. */
  operator: string;
  /** Template id from list_templates; defaults per ownerType. */
  templateId?: string | null;
  /** Freeform theme override — any custom layout the agent wants. */
  theme?: CustomThemeInput | null;
  socials?: SocialInput[] | null;
  links?: LinkInput[] | null;
}

const DEFAULT_AGENT_TEMPLATE = "agent-personal";
const DEFAULT_HUMAN_TEMPLATE = "business-card";

const MAX_SOCIALS = 12;
const MAX_LINKS = 12;
const MAX_THEME_FIELD = 120;

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** fontFamily allowlist pattern — plain font stacks only, no CSS breakouts. */
const FONT_RE = /^[A-Za-z0-9\s,'"\- ]+$/;

/**
 * Public templates only — owner-gated templates (ownerAccounts set) stay
 * invisible to the agent flow, same fail-closed rule as the builder picker.
 */
export function publicTemplates(): Template[] {
  return TEMPLATES.filter((t) => !t.ownerAccounts || t.ownerAccounts.length === 0);
}

export function resolveTemplate(templateId: string | null | undefined, ownerType: ClaimOwnerType): Template {
  const fallbackId = ownerType === "human" ? DEFAULT_HUMAN_TEMPLATE : DEFAULT_AGENT_TEMPLATE;
  const want = (templateId ?? "").trim().toLowerCase() || fallbackId;
  const found = publicTemplates().find((t) => t.id === want);
  if (!found) {
    const ids = publicTemplates()
      .map((t) => t.id)
      .join(", ");
    throw new Error(`unknown template "${templateId}" — pick one of: ${ids}`);
  }
  return found;
}

/** Validate a freeform theme override; returns the sanitized partial theme. */
export function validateCustomTheme(theme: CustomThemeInput | null | undefined): Partial<VoicescapePage["theme"]> {
  if (!theme) return {};
  const out: Partial<VoicescapePage["theme"]> = {};
  for (const k of ["background", "foreground", "accent"] as const) {
    const v = theme[k];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || v.length > MAX_THEME_FIELD || !HEX_COLOR_RE.test(v.trim())) {
      throw new Error(`theme.${k} must be a hex color like #141b29 or #fff`);
    }
    out[k] = v.trim();
  }
  const font = theme.fontFamily;
  if (font !== undefined && font !== "") {
    if (typeof font !== "string" || font.length > MAX_THEME_FIELD || !FONT_RE.test(font.trim())) {
      throw new Error("theme.fontFamily must be a plain font stack (letters, spaces, commas, quotes, dashes)");
    }
    out.fontFamily = font.trim();
  }
  return out;
}

export interface SanitizedSocial {
  platform: string;
  url: string;
}

/** Validate socials through the dapp's own choke points. Drops bad items. */
export function sanitizeSocials(socials: SocialInput[] | null | undefined): SanitizedSocial[] {
  if (!Array.isArray(socials)) return [];
  const out: SanitizedSocial[] = [];
  for (const s of socials.slice(0, MAX_SOCIALS)) {
    if (!s || typeof s !== "object") continue;
    const url = safeExternalUrl(s.url);
    if (!url) continue;
    const platform = typeof s.platform === "string" && isPlatformId(s.platform.trim().toLowerCase())
      ? s.platform.trim().toLowerCase()
      : "website";
    out.push({ platform, url });
  }
  return out;
}

export interface SanitizedLink {
  label: string;
  url: string;
}

export function sanitizeLinks(links: LinkInput[] | null | undefined): SanitizedLink[] {
  if (!Array.isArray(links)) return [];
  const out: SanitizedLink[] = [];
  for (const l of links.slice(0, MAX_LINKS)) {
    if (!l || typeof l !== "object") continue;
    const label = typeof l.label === "string" ? l.label.trim().slice(0, 40) : "";
    const url = safeExternalUrl(l.url);
    if (!label || !url) continue;
    out.push({ label, url });
  }
  return out;
}

type Block = Record<string, unknown>;

function findBlock(blocks: Block[], type: string): Block | undefined {
  return blocks.find((b) => b && typeof b === "object" && (b as Block).type === type) as Block | undefined;
}

/**
 * Assemble the full page document for a claim: template + filled identity
 * + custom theme + socials/links, then the same gates as /api/pin.
 * Throws a human-readable Error when anything is invalid — nothing is
 * pinned on failure.
 */
export function assembleClaimPage(spec: ClaimPageSpec): VoicescapePage {
  const template = resolveTemplate(spec.templateId, spec.ownerType);
  const page = JSON.parse(JSON.stringify(template.page)) as VoicescapePage & {
    blocks: Block[];
  };

  page.username = spec.username;
  page.ownerType = spec.ownerType;
  page.purpose = spec.purpose;

  const hero = findBlock(page.blocks, "hero");
  if (hero) {
    hero.title = spec.displayName.slice(0, 60);
    hero.subtitle = spec.purpose.slice(0, 140);
  }
  const bio = findBlock(page.blocks, "bio");
  if (bio) {
    bio.text = spec.purpose;
  }

  if (spec.ownerType === "agent") {
    let cap = findBlock(page.blocks, "capabilities");
    if (spec.capabilities.length > 0) {
      if (!cap) {
        cap = { type: "capabilities", items: [] };
        page.blocks.push(cap);
      }
      cap.items = spec.capabilities;
    }
    let op = findBlock(page.blocks, "operator");
    if (!op) {
      op = { type: "operator", wallet: spec.operator, name: `${spec.displayName} operator wallet` };
      page.blocks.push(op);
    } else {
      op.wallet = spec.operator;
      op.name = `${spec.displayName} operator wallet`;
    }
  }

  // Socials: replace the template's socials block when the agent supplied
  // some (every template ships one); otherwise leave the template's.
  const socials = sanitizeSocials(spec.socials);
  if (socials.length > 0) {
    const existing = findBlock(page.blocks, "socials");
    const items = socials.map((s) => ({ platform: s.platform, url: s.url }));
    if (existing) existing.items = items;
    else page.blocks.push({ type: "socials", items });
  }

  // Links: arbitrary project URLs get their own block.
  const links = sanitizeLinks(spec.links);
  if (links.length > 0) {
    page.blocks.push({ type: "links", items: links });
  }

  // Custom theme: freeform layout colors on top of the template's theme.
  const themeOverride = validateCustomTheme(spec.theme);
  page.theme = { ...page.theme, ...themeOverride };

  // Same gates as /api/pin — the MCP path must never pin what the dapp
  // would refuse (this was a hole: pinAgentPage skipped both checks).
  if (!isValidPage(page)) {
    throw new Error("assembled page failed structural validation — this is a server bug, report it");
  }
  const contentHit = checkPageJson(page);
  if (contentHit) {
    throw new Error(contentHit);
  }
  return page;
}

/** Template catalog for the list_templates MCP tool (public only). */
export function templateCatalog(): Array<{
  id: string;
  name: string;
  description: string;
  category: "business" | "personal";
  theme: VoicescapePage["theme"];
  block_types: string[];
}> {
  return publicTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    theme: t.page.theme,
    block_types: t.page.blocks.map((b) => b.type),
  }));
}
