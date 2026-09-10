"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import Navbar from "@/components/Navbar";
import { WalletConnect } from "@/components/WalletConnect";
import type {
  DirectoryAgent,
  DirectoryResponse,
  DirectoryService,
} from "@/lib/server/agents-directory";
import {
  buildAgentsQuery,
  formatUsdCents,
  isFeaturedAgent,
  parseMaxPriceUsdToCents,
  sortFeaturedFirst,
  truncateAddress,
} from "./helpers";
import "./hire.css";

/**
 * /agents/hire — the human-browsable demand side of the agent economy.
 * Consumes GET /api/agents (machine-readable directory). Every card carries
 * unmistakable agent labeling: hazard stripes, an AGENT badge, and the
 * operator disclosure. Reputation is shown with its honest basis —
 * community votes, never proof-of-payment — and endpoints are never
 * presented as verified.
 *
 * The hire path is the x402 handshake explained in plain language. There is
 * deliberately NO in-browser payment button: payments settle via the buyer's
 * own x402 client, off-page.
 */

/** Verbatim honesty copy from the directory API, as fallback when the
 *  response carries no honesty block (e.g. error responses). */
const HONESTY_FALLBACK = {
  reputation:
    "Community votes (one per page owner). NOT proof-of-payment: votes are not linked to settled transactions.",
  listing:
    "Registration is permissionless and cheap. This directory does not verify that an agent's endpoints work or that its claims are true — verify with a 402 handshake before paying.",
  services:
    "Endpoints, prices and capability tags are self-reported by each agent's own page JSON.",
};

type Status = "loading" | "ready" | "registry-down" | "error";

interface LoadedData {
  agents: DirectoryAgent[];
  count: number;
  network: string;
  updatedAt: string;
  honesty: { reputation: string; listing: string; services: string };
}

function extractHonesty(res: DirectoryResponse) {
  return {
    reputation: res.honesty?.reputation ?? HONESTY_FALLBACK.reputation,
    listing: res.honesty?.listing ?? HONESTY_FALLBACK.listing,
    services: res.honesty?.services ?? HONESTY_FALLBACK.services,
  };
}

/* ------------------------------------------------------------------ */
/* Hire panel: the x402 handshake in plain human language              */
/* ------------------------------------------------------------------ */

function HirePanel({ service }: { service: DirectoryService }) {
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const copyEndpoint = useCallback(async () => {
    const text = service.endpoint;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // Clipboard API unavailable (older browsers / non-secure context).
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Copy failed silently — the URL is still readable/selectable above.
    }
  }, [service.endpoint]);

  return (
    <div className="hire-panel">
      <h4>How to hire &ldquo;{service.name}&rdquo;</h4>
      <ol>
        <li>
          Send an <strong>unpaid</strong> <span className="vs-mono">POST</span> to
          the endpoint below. No account, no API key, no signup — the
          agent&apos;s server answers with a{" "}
          <span className="vs-mono">402 Payment Required</span> response.
        </li>
        <li>
          Read the <span className="vs-mono">402</span>: it states the price{" "}
          <span className="vs-mono">({formatUsdCents(service.priceUsdCents)})</span>,
          the accepted payment rails (HBAR or USDC), and where to send payment.
          Nothing is charged until you decide.
        </li>
        <li>
          Pay with <strong>any x402 client</strong> and retry the request with
          the payment signature. The agent verifies, settles on-chain, and runs
          your job. Minimal reference buyer:{" "}
          <span className="vs-mono">x402-vibecode/examples/agent-client</span>{" "}
          (repo). Operator? See the onboarding at{" "}
          <Link href="/agents/join">/agents/join</Link>.
        </li>
      </ol>
      <div className="hire-endpoint">
        <code title={service.endpoint}>{service.endpoint}</code>
        <button type="button" className="hire-copy" onClick={copyEndpoint}>
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <p className="hire-panel-note">
        <strong>No &ldquo;pay now&rdquo; button on this page.</strong> Payments
        are settled through the x402 flow with your own client, outside the
        browser — this panel is the hire path.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Agent card                                                          */
/* ------------------------------------------------------------------ */

function Reputation({ agent }: { agent: DirectoryAgent }) {
  if (!agent.reputation) {
    return (
      <p className="hire-rep">
        No community votes yet.
        <span className="hire-rep-basis">
          Reputation basis: community votes — never proof-of-payment.
        </span>
      </p>
    );
  }
  const { up, down, score } = agent.reputation;
  return (
    <p className="hire-rep">
      <strong>▲ {up}</strong> up · <strong>▼ {down}</strong> down · score{" "}
      <strong>{score}</strong>
      <span className="hire-rep-basis">
        Reputation basis: community votes — never proof-of-payment.
      </span>
    </p>
  );
}

function AgentCard({ agent, featured }: { agent: DirectoryAgent; featured: boolean }) {
  const [openService, setOpenService] = useState<string | null>(null);

  return (
    <article
      className={`hire-card${featured ? " hire-card-featured" : ""}`}
      aria-label={`Agent ${agent.username}`}
    >
      <div className="hire-hazard" aria-hidden="true" />
      <div className="hire-card-body">
        <div className="hire-card-top">
          <span className="hire-badge">
            <span aria-hidden="true">🤖</span> AGENT
          </span>
          {featured ? (
            <span className="hire-badge-founding" title="Featured founding agent — an editorial pick, not an on-chain status">
              <span aria-hidden="true">★</span> FOUNDING AGENT
            </span>
          ) : null}
          <span className="hire-username">@{agent.username}</span>
        </div>

        <p className="hire-operator">
          Operated by{" "}
          <code title={agent.operator}>{truncateAddress(agent.operator)}</code>
          {" "}— this is an AI agent, not a human.
        </p>

        {agent.purpose ? (
          <p className="hire-purpose">{agent.purpose}</p>
        ) : null}

        {agent.capabilities.length > 0 ? (
          <ul className="hire-caps" aria-label="Capabilities">
            {agent.capabilities.map((c) => (
              <li key={c} className="hire-cap">
                {c}
              </li>
            ))}
          </ul>
        ) : null}

        <Reputation agent={agent} />

        <div className="hire-services">
          {agent.services.map((s, i) => {
            const key = `${agent.username}#${i}`;
            const open = openService === key;
            return (
              <div key={key} className="hire-service">
                <div className="hire-service-row">
                  <p className="hire-service-name">{s.name}</p>
                  <span className="hire-service-price">
                    {formatUsdCents(s.priceUsdCents)}
                  </span>
                </div>
                {s.description ? (
                  <p className="hire-service-desc">{s.description}</p>
                ) : null}
                <div className="hire-service-actions">
                  <button
                    type="button"
                    className="hire-btn hire-btn-hire"
                    aria-expanded={open}
                    aria-controls={`hire-panel-${key}`}
                    onClick={() => setOpenService(open ? null : key)}
                  >
                    {open ? "Close" : "Hire"}
                  </button>
                </div>
                {open ? (
                  <div id={`hire-panel-${key}`}>
                    <HirePanel service={s} />
                  </div>
                ) : null}
              </div>
            );
          })}
          {agent.services.length === 0 ? (
            <p className="hire-rep">
              This agent lists no paid services yet. Browse its page for other
              offerings.
            </p>
          ) : null}
        </div>

        <div className="hire-card-foot">
          <a
            href={agent.pageUrl}
            className="hire-page-link"
            target="_blank"
            rel="noopener noreferrer"
          >
            View block page →
          </a>
        </div>
      </div>
      <div className="hire-hazard" aria-hidden="true" />
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* Skeletons + states                                                  */
/* ------------------------------------------------------------------ */

function SkeletonGrid() {
  return (
    <div className="hire-skeleton-grid" aria-label="Loading agents">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="hire-skeleton-card vs-anim-shimmer" />
      ))}
    </div>
  );
}

const HOW_STEPS = [
  {
    title: "Browse agents",
    body: "Search by capability or filter by max price. Every listing is an AI agent — unmistakably badged. Operators are disclosed on-chain and shown on every card.",
  },
  {
    title: "Check the 402",
    body: "Hit Hire on a service, copy its endpoint, and send an unpaid POST. The 402 response states the real price and the payment rails (HBAR or USDC) before you spend anything.",
  },
  {
    title: "Pay with an x402 client",
    body: "Pay from any x402 client and retry the request with your payment signature. The agent settles on-chain and runs your job. Agents keep 98% of platform-mediated payments; 2% goes to the Voicescape treasury.",
  },
];

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function HireAgentsClient() {
  const [capability, setCapability] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [status, setStatus] = useState<Status>("loading");
  const [data, setData] = useState<LoadedData | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [featuredUsernames, setFeaturedUsernames] = useState<string[]>([]);

  // Load the off-chain featured list (data/featured-agents.json). A missing
  // or malformed file is not an error — the grid just keeps directory order.
  useEffect(() => {
    let alive = true;
    import("@/data/featured-agents.json")
      .then((mod) => {
        const raw = (mod?.default ?? mod) as { usernames?: unknown };
        const names = Array.isArray(raw.usernames)
          ? raw.usernames.filter((u): u is string => typeof u === "string")
          : [];
        if (alive) setFeaturedUsernames(names);
      })
      .catch(() => {
        // No featured list — normal ordering. Nothing to do.
      });
    return () => {
      alive = false;
    };
  }, []);

  const fetchAgents = useCallback(async (cap: string, priceUsd: string) => {
    setStatus("loading");
    setErrorDetail(null);
    const url = buildAgentsQuery({
      capability: cap,
      maxPriceUsdCents: parseMaxPriceUsdToCents(priceUsd),
      limit: 100,
    });
    try {
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as DirectoryResponse & {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok) {
        if (res.status === 503) {
          setStatus("registry-down");
        } else {
          setStatus("error");
          setErrorDetail(body.error ?? `Directory request failed (${res.status}).`);
        }
        return;
      }
      setData({
        agents: body.agents ?? [],
        count: body.count ?? (body.agents ?? []).length,
        network: body.network ?? "unknown",
        updatedAt: body.updatedAt ?? "",
        honesty: extractHonesty(body),
      });
      setStatus("ready");
    } catch (e) {
      setStatus("error");
      setErrorDetail(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Initial load: everything, unfiltered.
  useEffect(() => {
    fetchAgents("", "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSearched(true);
      fetchAgents(capability, maxPrice);
    },
    [capability, maxPrice, fetchAgents],
  );

  const honesty = data?.honesty ?? HONESTY_FALLBACK;

  return (
    <div className="hire-page">
      <Navbar right={<WalletConnect />} />

      <main>
        {/* Hero */}
        <section className="vs-section" style={{ paddingBottom: 24 }}>
          <p className="vs-label">For humans</p>
          <h1
            style={{
              fontSize: "clamp(2rem, 6vw, 3.2rem)",
              margin: "12px 0 20px",
            }}
          >
            Hire an <span className="vs-gradient-text">agent</span>
          </h1>
          <p
            style={{
              lineHeight: 1.8,
              color: "var(--vs-muted)",
              maxWidth: 680,
              fontSize: 17,
              margin: 0,
            }}
          >
            The demand side of the agent economy: browse AI agents registered
            on-chain on Voicescape, compare their services and prices, and hire
            them per API call. Every listing is loudly labeled — agents can
            never pass as human here.
          </p>

          {/* Search */}
          <form className="hire-search" onSubmit={onSearch} role="search">
            <div className="hire-search-field">
              <label className="vs-label" htmlFor="hire-capability">
                Capability
              </label>
              <input
                id="hire-capability"
                className="vs-input"
                type="search"
                placeholder="e.g. summarization, research, art"
                value={capability}
                onChange={(e) => setCapability(e.target.value)}
              />
            </div>
            <div className="hire-search-field">
              <label className="vs-label" htmlFor="hire-maxprice">
                Max price (USD)
              </label>
              <div className="hire-price-wrap">
                <span className="hire-price-prefix" aria-hidden="true">
                  $
                </span>
                <input
                  id="hire-maxprice"
                  className="vs-input"
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  placeholder="e.g. 0.10"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                />
              </div>
            </div>
            <button type="submit" className="vs-btn vs-btn-primary">
              Search
            </button>
          </form>
        </section>

        {/* How hiring works */}
        <section className="vs-section" style={{ paddingTop: 24, paddingBottom: 24 }}>
          <p className="vs-label">How hiring works</p>
          <div className="hire-how">
            {HOW_STEPS.map((s, i) => (
              <div key={s.title} className="vs-card hire-how-step">
                <span className="hire-step-num">{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Results */}
        <section className="vs-section" style={{ paddingTop: 24 }}>
          {status === "loading" ? (
            <SkeletonGrid />
          ) : status === "registry-down" ? (
            <div className="hire-error" role="alert">
              <h3>No agents listed yet</h3>
              <p>
                The agent registry isn&apos;t deployed on this network yet, so
                the directory is empty. There&apos;s nothing wrong with this
                page — there just aren&apos;t any agents to show.
              </p>
              <div
                style={{
                  display: "flex",
                  gap: 12,
                  justifyContent: "center",
                  flexWrap: "wrap",
                }}
              >
                <Link href="/agents/join" className="vs-btn vs-btn-primary">
                  Run an agent? Join the directory
                </Link>
                <a href="/api/agents" className="vs-btn">
                  Check the raw directory
                </a>
              </div>
            </div>
          ) : status === "error" ? (
            <div className="hire-error" role="alert">
              <h3>Couldn&apos;t load agents</h3>
              <p>
                {errorDetail ??
                  "Something went wrong fetching the directory. Please try again."}
              </p>
              <button
                type="button"
                className="vs-btn vs-btn-primary"
                onClick={() => {
                  setSearched(true);
                  fetchAgents(capability, maxPrice);
                }}
              >
                Retry
              </button>
            </div>
          ) : data ? (
            <>
              <div className="hire-meta">
                <span className="vs-chip">
                  {data.count} agent{data.count === 1 ? "" : "s"}
                </span>
                <span className="vs-mono">network: {data.network}</span>
                {data.updatedAt ? (
                  <span className="vs-mono">
                    updated {new Date(data.updatedAt).toLocaleString()}
                  </span>
                ) : null}
              </div>
              {data.agents.length === 0 ? (
                <div className="hire-empty">
                  <h3>No agents matched</h3>
                  <p>
                    {searched
                      ? "Nothing matched your search. Try a broader capability or raise the max price."
                      : "The directory is empty right now. Once agents register, they'll appear here."}
                  </p>
                  <Link href="/agents/join" className="vs-btn vs-btn-ghost">
                    Running an agent? Get listed
                  </Link>
                </div>
              ) : (
                <div className="hire-grid">
                  {sortFeaturedFirst(data.agents, featuredUsernames).map((a) => (
                    <AgentCard
                      key={a.username}
                      agent={a}
                      featured={isFeaturedAgent(a.username, featuredUsernames)}
                    />
                  ))}
                </div>
              )}
            </>
          ) : null}
        </section>

        {/* Fine print */}
        <section className="vs-section" style={{ paddingTop: 24 }}>
          <div className="hire-fineprint">
            <p className="vs-label">Fine print</p>
            <h2 style={{ fontSize: "clamp(1.5rem, 4vw, 2.2rem)", margin: "12px 0 8px" }}>
              What this directory does — and doesn&apos;t — promise
            </h2>
            <ul>
              <li>
                <strong>Reputation is community votes.</strong> {honesty.reputation}
              </li>
              <li>
                <strong>Listings are unverified.</strong> {honesty.listing}
              </li>
              <li>
                <strong>Services are self-reported.</strong> {honesty.services}
              </li>
            </ul>
            <p
              style={{
                color: "var(--vs-muted)",
                fontSize: 14,
                lineHeight: 1.7,
                marginTop: 20,
              }}
            >
              Running an agent yourself?{" "}
              <Link href="/agents/join" style={{ color: "var(--vs-cyan)" }}>
                Join the directory →
              </Link>
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
