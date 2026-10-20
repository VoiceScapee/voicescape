/**
 * Voicescape MCP server — agent self-funding tool (cross-chain).
 *
 * The own-keys claim path (prepare_agent_self_claim) stalls when the agent
 * arrives with no HBAR: today the only answer is "ask your human to fund
 * the alias". This tool closes that gap for agents that already hold funds
 * on Base or Solana and are authorized to spend them: it returns a complete,
 * executable funding plan that moves the agent's OWN money from its native
 * wallet to its Hedera wallet, using only official cross-chain rails.
 *
 * RAILS (verified live, 2026-10-18):
 *   - Axelar GMP connects Hedera mainnet to 60+ chains including Base and
 *     Solana (live since Feb 2026; SaucerSwap + Squid run on it).
 *   - Squid (https://v2.api.squidrouter.com/v2/) is the routing front end:
 *     POST /v2/route builds the exact transaction the agent signs.
 *   - Hashport is PERMANENTLY DEAD (decommissioned 2026-05-31). Any guide,
 *     contract, or token mentioning Hashport (incl. USDC[hts]) is a trap —
 *     assets sent there are unredeemable. This tool never routes there.
 *
 * NON-CUSTODIAL INVARIANT: this tool is GUIDANCE ONLY. It performs zero
 * network calls, never sees a private key, never signs, never holds funds.
 * The agent calls Squid's public API itself, signs with its OWN native key
 * (Base ECDSA key or Solana ed25519 key), and submits itself. The server is
 * never in the money path.
 *
 * $0 PLATFORM COST: the agent pays the bridge relayer fee + source-chain
 * gas + Hedera fees out of its own funds. The platform spends nothing and
 * takes nothing. (Standing rule: never lose money.)
 *
 * AUTHORIZATION: moving funds is an outward effect on the agent's own
 * wallet. The tool output reminds the agent to proceed only under its
 * human's standing task authorization — the server cannot verify that,
 * so the reminder is explicit in every plan.
 */

export interface SelfFundHederaArgs {
  /**
   * Where the agent's funds live now. Only "base" and "solana" are
   * supported — the two chains with a live Axelar/Squid path to Hedera.
   */
  source_chain: "base" | "solana";
  /**
   * The agent's OWN wallet address on the source chain. Base: 0x EVM
   * address (you sign with its ECDSA key). Solana: base58 address (you
   * sign with its ed25519 key).
   */
  source_address: string;
  /**
   * Where the funds must land: the agent's Hedera 0x alias address, exactly
   * as returned by prepare_agent_self_claim's fund_address (42-char 0x).
   * Funding this address auto-creates the agent's 0.0.x Hedera account
   * (hollow account) on first arrival when derived from a secp256k1 key.
   */
  hedera_destination: string;
  /**
   * USD value of USDC to bridge. Minimum 5 — bridge relayer fees make
   * smaller transfers wasteful (fees can exceed the transfer). $5-10 funds
   * thousands of claims at Hedera gas prices. Default 5.
   */
  amount_usd?: number;
}

export interface SelfFundStep {
  step: number;
  title: string;
  detail: string;
}

export interface SelfFundPlan {
  summary: string;
  route: {
    via: string;
    from_chain: string;
    from_chain_id: string;
    to_chain: string;
    to_chain_id: string;
    from_token: string;
    from_token_symbol: string;
    /** How to pick the destination token — resolved live, never guessed. */
    to_token_guidance: string;
  };
  steps: SelfFundStep[];
  warnings: string[];
  /** How to confirm the funds arrived (mirror node, no auth). */
  verify: string;
  /** What to do once funded. */
  next: string;
  estimated_timing: string;
}

/** Squid v2 public API base (docs.squidrouter.com). */
const SQUID_API = "https://v2.api.squidrouter.com/v2";
/**
 * VERIFIED 2026-10-18 (live probe): every Squid v2 endpoint now requires the
 * `x-integrator-id` request header — /v2/route, /v2/tokens and /v2/chains all
 * return 400 {"message":"x-integrator-id header is missing","type":"UNAUTHORIZED"}
 * without it, and 401 {"message":"Integrator ID is invalid"} for made-up ids.
 * It is a free attribution id issued by the Squid team; it is not a key,
 * costs nothing, and grants no custody. UPDATE 2026-10-18: Squid's old
 * self-serve Typeform is CLOSED and no replacement form exists — the current
 * path is asking the Squid team (their Discord, linked from docs.squidrouter.com).
 * ALTERNATIVE for EVM agents: Squid runs its own MCP server (docs.squidrouter.com,
 * "Squid MCP") that executes swaps from an AI assistant directly — no
 * integrator id needed on your side.
 */
/** Hedera EVM chain id. */
const HEDERA_CHAIN_ID = "295";
/** Base EVM chain id. */
const BASE_CHAIN_ID = "8453";
/** Squid chain identifier for Solana (non-EVM chains use names). */
const SOLANA_CHAIN_ID = "solana";
/** Native USDC on Base (Circle). */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Native USDC on Solana (Circle mint). */
const USDC_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/** Minimum bridge amount in USD — below this, relayer fees dominate. */
const MIN_AMOUNT_USD = 5;
/** Default bridge amount in USD. */
const DEFAULT_AMOUNT_USD = 5;

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Loose base58 check for Solana addresses (32-44 chars, no 0/O/I/l). */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function chainConfig(sourceChain: "base" | "solana") {
  return sourceChain === "base"
    ? {
        label: "Base",
        chainId: BASE_CHAIN_ID,
        fromToken: USDC_BASE,
        keyKind: "your Base ECDSA (secp256k1) key",
        signInstruction:
          "Sign and submit with your own Base key: send a transaction to " +
          "transactionRequest.target with transactionRequest.data as calldata and " +
          "transactionRequest.value as msg.value (use the returned gasLimit). " +
          "This is YOUR wallet, YOUR key, YOUR signature — the server never sees it.",
      }
    : {
        label: "Solana",
        chainId: SOLANA_CHAIN_ID,
        fromToken: USDC_SOLANA,
        keyKind: "your Solana ed25519 key",
        signInstruction:
          "The route returns a serialized Solana transaction: sign it with your " +
          "own Solana key and submit it to Solana mainnet yourself. This is YOUR " +
          "wallet, YOUR key, YOUR signature — the server never sees it.",
      };
}

export async function selfFundHederaTool(
  args: SelfFundHederaArgs,
): Promise<SelfFundPlan | { error: string }> {
  const sourceChain = args.source_chain;
  if (sourceChain !== "base" && sourceChain !== "solana") {
    return {
      error: `source_chain must be "base" or "solana" — only those two chains have a live Axelar/Squid path to Hedera.`,
    };
  }

  const sourceAddress = (args.source_address ?? "").trim();
  if (sourceChain === "base" && !EVM_ADDRESS_RE.test(sourceAddress)) {
    return { error: `source_address "${sourceAddress}" is not a valid Base 0x address.` };
  }
  if (sourceChain === "solana" && !SOLANA_ADDRESS_RE.test(sourceAddress)) {
    return { error: `source_address "${sourceAddress}" is not a valid Solana base58 address.` };
  }

  const destination = (args.hedera_destination ?? "").trim();
  if (!EVM_ADDRESS_RE.test(destination)) {
    return {
      error:
        `hedera_destination "${destination}" is not a valid 0x address. ` +
        `Use the exact fund_address returned by prepare_agent_self_claim (42-char 0x).`,
    };
  }

  const amountUsd = args.amount_usd ?? DEFAULT_AMOUNT_USD;
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_AMOUNT_USD) {
    return {
      error:
        `amount_usd must be at least $${MIN_AMOUNT_USD} — bridge relayer fees make ` +
        `smaller transfers wasteful (the fee can exceed what arrives). $${DEFAULT_AMOUNT_USD}-10 ` +
        `funds thousands of claims at Hedera gas prices.`,
    };
  }

  const cfg = chainConfig(sourceChain);
  // USDC has 6 decimals on both Base and Solana.
  const fromAmountAtomic = Math.round(amountUsd * 1_000_000).toString();

  const routeParams = {
    fromAddress: sourceAddress,
    fromChain: cfg.chainId,
    fromToken: cfg.fromToken,
    fromAmount: fromAmountAtomic,
    toChain: HEDERA_CHAIN_ID,
    // NOTE: toToken is intentionally NOT hardcoded — resolve it live via
    // GET ${SQUID_API}/tokens?chainId=295 and prefer WHBAR (unwraps to native
    // HBAR for gas), falling back to USDC. Hardcoded Hedera token addresses
    // rot; the tokens endpoint is the source of truth.
    toToken: "<resolve via GET /v2/tokens?chainId=295 — prefer WHBAR, fallback USDC>",
    toAddress: destination,
    slippage: 1,
  };

  const steps: SelfFundStep[] = [
    {
      step: 0,
      title: "Get a Squid integrator ID (one-time)",
      detail:
        `Squid requires an \`x-integrator-id\` HTTP header on EVERY API call ` +
        `(verified live: missing header = 400 UNAUTHORIZED, made-up id = 401). ` +
        `It is a free attribution id issued by the Squid team — not a private ` +
        `key, costs nothing, gives Squid no control over your funds. ` +
        `Squid's old self-serve form is closed; ask the Squid team directly ` +
        `(their Discord, linked from docs.squidrouter.com) for an integrator id, ` +
        `then reuse it as a header on all calls below, e.g. curl -H ` +
        `"x-integrator-id: <YOUR_ID>". ` +
        `ALTERNATIVE (EVM agents): Squid runs its own MCP server — connect to ` +
        `it from your assistant host (docs.squidrouter.com, "Squid MCP") and ` +
        `describe the swap in plain language instead of calling this API.`,
    },
    {
      step: 1,
      title: "Resolve the destination token (live, not guessed)",
      detail:
        `GET ${SQUID_API}/tokens?chainId=${HEDERA_CHAIN_ID} with header ` +
        `\`x-integrator-id: <YOUR_ID>\` and pick the WHBAR ` +
        `entry (wrapped HBAR — it unwraps 1:1 to native HBAR for gas). If no WHBAR ` +
        `route exists, use the native USDC entry instead and swap to HBAR on ` +
        `SaucerSwap after arrival (step 5). Never guess a token address — the ` +
        `tokens endpoint is the source of truth.`,
    },
    {
      step: 2,
      title: "Request the route quote from Squid",
      detail:
        `POST ${SQUID_API}/route with headers \`Content-Type: application/json\` ` +
        `and \`x-integrator-id: <YOUR_ID>\`, body exactly ` +
        `this (replace <TO_TOKEN> with the address from step 1):\n` +
        JSON.stringify({ ...routeParams, toToken: "<TO_TOKEN>" }, null, 2) +
        `\nSave the response's route.quoteId — you MUST pass it to the status ` +
        `endpoint in step 4 (Squid Intents requires it or the transfer fails). ` +
        `Also save the x-request-id response header.`,
    },
    {
      step: 3,
      title: `Sign and submit with your own ${cfg.label} key`,
      detail: cfg.signInstruction,
    },
    {
      step: 4,
      title: "Track the transfer to completion",
      detail:
        `Poll GET ${SQUID_API}/status with header \`x-integrator-id: <YOUR_ID>\` ` +
        `and query params transactionId=<your tx hash>, ` +
        `requestId=<x-request-id header>, fromChainId=${cfg.chainId}, toChainId=${HEDERA_CHAIN_ID}, ` +
        `quoteId=<quoteId from step 2>. Repeat every ~30s until squidTransactionStatus is ` +
        `"success". Watch it on https://axelarscan.io/gmp/<your tx hash> too.`,
    },
    {
      step: 5,
      title: "Convert to native HBAR for gas",
      detail:
        `If WHBAR arrived: call withdraw(uint256) on the WHBAR contract with your ` +
        `Hedera key to unwrap 1:1 to native HBAR (gas money). If USDC arrived: ` +
        `swap it to HBAR on SaucerSwap (https://www.saucerswap.finance) with your ` +
        `Hedera key. You need native HBAR — the claim transaction pays gas in HBAR.`,
    },
    {
      step: 6,
      title: "Verify the funding landed",
      detail:
        `GET https://mainnet.mirrornode.hedera.com/api/v1/accounts/<your 0.0.x or 0x alias> ` +
        `and confirm balance.balance > 0. Your 0.0.x account auto-creates on first ` +
        `arrival when the destination is a secp256k1-derived alias (hollow account).`,
    },
  ];

  return {
    summary:
      `Self-fund $${amountUsd} USDC from your ${cfg.label} wallet (${sourceAddress}) to your ` +
      `Hedera wallet (${destination}) via Squid on Axelar — your keys, your money, ` +
      `no human in the loop, $0 platform cost.`,
    route: {
      via: "Squid (Axelar GMP — proof-of-stake-secured cross-chain)",
      from_chain: cfg.label,
      from_chain_id: cfg.chainId,
      to_chain: "Hedera",
      to_chain_id: HEDERA_CHAIN_ID,
      from_token: cfg.fromToken,
      from_token_symbol: "USDC",
      to_token_guidance:
        "Resolve live via GET /v2/tokens?chainId=295 — prefer WHBAR (unwraps to gas-ready HBAR), fallback USDC.",
    },
    steps,
    warnings: [
      "AUTHORIZATION: you are moving YOUR OWN money on YOUR OWN chains with YOUR OWN keys. Proceed only if your human's standing task authorizes spending — this server cannot verify that.",
      "Squid REQUIRES an x-integrator-id header on every API call (verified live 2026-10-18 — missing header = 400 UNAUTHORIZED). Register one free, once, and reuse it. Without it, steps 1, 2 and 4 fail.",
      "Hashport is PERMANENTLY DEAD (decommissioned 2026-05-31). Never use Hashport, never send to Hashport contracts, never accept USDC[hts] — those assets are unredeemable.",
      "Only Axelar/Squid and LayerZero/Stargate are live, supported Hedera bridges. Anything else is untested — do not improvise a route.",
      `Minimum $${MIN_AMOUNT_USD}: bridge relayer fees make smaller transfers wasteful. $${DEFAULT_AMOUNT_USD}-10 covers thousands of claims.`,
      "Slippage is set to 1% — for larger amounts, request the quote first and inspect route.estimate before signing.",
      "Solana→Hedera via Squid is the less-documented direction (Squid's Hedera docs focus on EVM). If no route is returned, the EVM path (Base→Hedera) is the proven one.",
      "This server never sees your keys, never signs, never holds funds. If any step asks you to share a private key or seed phrase, STOP — that is not part of this flow.",
    ],
    verify:
      "Mirror node: GET https://mainnet.mirrornode.hedera.com/api/v1/accounts/<destination> — balance.balance is in tinybar (1 HBAR = 100,000,000 tinybar).",
    next: "Once funded, continue the own-keys claim: call finalize_agent_self_claim (sign the returned bytes with your Hedera key), submit, then complete_agent_self_claim.",
    estimated_timing:
      "Typically 5-30 minutes end to end (source-chain confirmation + Axelar finality + Hedera arrival).",
  };
}
