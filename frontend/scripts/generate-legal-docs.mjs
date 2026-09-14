/**
 * Generates the human-readable review copies of the legal documents from the
 * single source of truth (lib/legal/legal.ts) so they never drift.
 *
 * Usage: node scripts/generate-legal-docs.mjs
 */
import { buildSync } from "esbuild";
import { writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";

const outDir = join(tmpdir(), "legal-gen");
mkdirSync(outDir, { recursive: true });

buildSync({
  entryPoints: ["lib/legal/legal.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: join(outDir, "legal.cjs"),
  logLevel: "silent",
});

const require = createRequire(import.meta.url);
const { TERMS_OF_SERVICE, PRIVACY_POLICY } = require(join(outDir, "legal.cjs"));

function toMarkdown(doc) {
  const lines = [
    `# ${doc.title}`,
    "",
    `**Effective ${doc.effectiveDate}**`,
    "",
    doc.intro,
    "",
  ];
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`, "");
    for (const p of s.paragraphs) lines.push(p, "");
    if (s.bullets) {
      for (const b of s.bullets) lines.push(`- ${b}`);
      lines.push("");
    }
  }
  lines.push("---", "", "_Research memo, not legal advice — have a startup attorney review before relying on these documents._");
  return lines.join("\n");
}

const dest = join(homedir(), "workspace", "your_files", "legal");
mkdirSync(dest, { recursive: true });
writeFileSync(join(dest, "terms-of-service.md"), toMarkdown(TERMS_OF_SERVICE));
writeFileSync(join(dest, "privacy-policy.md"), toMarkdown(PRIVACY_POLICY));
console.log("wrote", dest);
