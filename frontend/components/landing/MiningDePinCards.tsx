"use client";

/**
 * Project cards for the Mining & DePIN page.
 *
 * Client component because the "Verified {date}" badge interpolates the
 * per-project verification date into the translated string.
 */
import { useLanguage } from "@/lib/i18n/LanguageContext";
import { IconBolt, IconCheck, IconExternal, IconGlobe } from "@/components/icons";
import {
  MINING_DEPIN_PROJECTS,
  type MiningDePinProject,
} from "@/lib/landing/mining-depin";

function ProjectCard({ p }: { p: MiningDePinProject }) {
  const { t } = useLanguage();
  const Icon = p.category === "mining" ? IconBolt : IconGlobe;
  const href = p.url;
  return (
    <div className="vs-card" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div
          style={{
            flexShrink: 0,
            width: 44,
            height: 44,
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background:
              "linear-gradient(135deg, rgba(130,89,239,0.25), rgba(145,168,255,0.18))",
            border: "1px solid var(--vs-border)",
            color: "var(--vs-cyan)",
          }}
        >
          <Icon size={22} />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 18 }}>{p.name}</h3>
          <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--vs-muted)" }}>
            {p.tagline}
          </p>
        </div>
      </div>

      <p style={{ margin: 0, color: "var(--vs-muted)", lineHeight: 1.7, fontSize: 15 }}>
        {p.description}
      </p>

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6 }}>
        <span style={{ color: "var(--vs-cyan)", display: "inline-flex", verticalAlign: -2, marginRight: 6 }}>
          <IconCheck size={14} />
        </span>
        <strong>{t("mining.whyTrusted")}: </strong>
        <span style={{ color: "var(--vs-muted)" }}>{p.whyTrusted}</span>
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: "auto", flexWrap: "wrap" }}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="vs-btn vs-btn-primary"
          style={{ padding: "10px 22px", fontSize: 14, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 8 }}
        >
          {t("mining.visitSite")}
          <IconExternal size={14} />
        </a>
        <span
          className="vs-mono"
          style={{
            fontSize: 11,
            color: "var(--vs-muted)",
            border: "1px solid var(--vs-border)",
            borderRadius: 999,
            padding: "4px 10px",
          }}
        >
          {t("mining.verifiedOn").replace("{date}", p.verifiedAt)}
        </span>
      </div>
    </div>
  );
}

export function MiningDePinCards({ category }: { category: "mining" | "depin" }) {
  const projects = MINING_DEPIN_PROJECTS.filter((p) => p.category === category);
  return (
    <div className="vs-grid-2">
      {projects.map((p) => (
        <ProjectCard key={p.id} p={p} />
      ))}
    </div>
  );
}
