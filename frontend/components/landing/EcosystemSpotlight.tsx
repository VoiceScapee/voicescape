/**
 * Ecosystem spotlight — interesting projects building on Hedera.
 *
 * Sits under the halving countdowns: Neuron (drone radar on HCS, verified via
 * Hedera's official blog) and PharmaTrace (DePIN pharma track-and-trace).
 * Official URLs only; nothing listed without direct verification.
 */
import { T } from "@/components/T";
import type { I18nKey } from "@/lib/i18n/dictionaries";

const SPOTS: { name: string; url: string; domain: string; descKey: I18nKey }[] = [
  {
    name: "Neuron",
    url: "https://www.neuron.world/",
    domain: "neuron.world",
    descKey: "landing.neuronDesc",
  },
  {
    name: "PharmaTrace",
    url: "https://www.pharmatrace.io",
    domain: "pharmatrace.io",
    descKey: "landing.pharmaDesc",
  },
];

export function EcosystemSpotlight() {
  return (
    <section className="vs-section" style={{ paddingTop: 0 }}>
      <p className="vs-label" style={{ textAlign: "center" }}>
        <T k="landing.spotlightLabel" />
      </p>
      <h2
        style={{
          fontSize: "clamp(1.6rem, 4.5vw, 2.4rem)",
          margin: "12px 0 12px",
          textAlign: "center",
        }}
      >
        <T k="landing.spotlightTitle" />
      </h2>
      <p
        style={{
          textAlign: "center",
          color: "var(--vs-muted)",
          fontSize: 16,
          maxWidth: 640,
          margin: "0 auto 28px",
          lineHeight: 1.7,
        }}
      >
        <T k="landing.spotlightSub" />
      </p>
      <div className="vs-grid-2">
        {SPOTS.map((s) => (
          <a
            key={s.name}
            href={s.url}
            target="_blank"
            rel="noopener noreferrer"
            className="vs-card"
            style={{ textDecoration: "none", color: "inherit", display: "block" }}
          >
            <h3 style={{ margin: "0 0 8px", fontSize: 19 }}>{s.name}</h3>
            <p
              style={{
                margin: "0 0 16px",
                color: "var(--vs-muted)",
                fontSize: 15,
                lineHeight: 1.7,
              }}
            >
              <T k={s.descKey} />
            </p>
            <span style={{ color: "var(--vs-accent)", fontSize: 14, fontWeight: 600 }}>
              {s.domain} →
            </span>
          </a>
        ))}
      </div>
    </section>
  );
}
