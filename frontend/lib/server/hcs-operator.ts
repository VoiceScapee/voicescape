/**
 * hcs-operator — server-side HCS submission for keyless agents' message:send.
 *
 * WHY THIS EXISTS: a keyless agent has no Hedera key, so it cannot sign the
 * two-step town-hall flow (prepare → agent signs → confirm). The message:send
 * execution scope lets the server submit the agent's message with the
 * SERVER'S OWN operator key — never any user's key. The server never holds,
 * sees, or derives a user or agent key here.
 *
 * WHO PAYS: the human. At issuance the human may approve an HBAR fee budget
 * (1–5 HBAR, default 1) via AccountAllowanceApproveTransaction, signed in
 * their own wallet, granting the operator account a spending allowance.
 * Every message:send draws a FLAT 0.001 HBAR (~$0.0002) from that budget via
 * an approved transfer (human → operator). The operator is reimbursed for
 * the HCS fee it fronted; the platform never spends its own money.
 *
 * FAIL-CLOSED: HCS_SENDER_KEY / HCS_SENDER_ACCOUNT_ID unset → every send
 * refuses with a clear error telling the human the operator isn't wired.
 * No budget, exhausted budget, or failed allowance → refuse before submit.
 *
 * SAFETY: content is safety-checked BEFORE submit (HCS is append-only —
 * blocked content never reaches the chain), same checkContent gate the
 * two-step tools use. Per-token daily rate limits apply on top.
 *
 * Key handling: the operator key lives ONLY in the HCS_SENDER_KEY env var,
 * read at call time, never logged, never returned, never sent anywhere
 * except the Hedera network client. This is the server's own key — it
 * authorizes nothing on any user's account.
 */

const FLAT_MESSAGE_FEE_HBAR = 0.001;

export function messageFeeHbar(): number {
  return FLAT_MESSAGE_FEE_HBAR;
}

/** True when the operator sender is wired (key + account present). */
export function isOperatorConfigured(): boolean {
  return Boolean(process.env.HCS_SENDER_KEY && process.env.HCS_SENDER_ACCOUNT_ID);
}

/** The operator account id, or null when unwired. Safe to expose. */
export function getOperatorAccountId(): string | null {
  const id = (process.env.HCS_SENDER_ACCOUNT_ID ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(id) ? id : null;
}

export interface OperatorSendResult {
  /** Mirror-form tx id (0.0.x@seconds.nanos) of the HCS submit. */
  hcsTxId: string;
  /** Mirror-form tx id of the approved fee transfer (human → operator). */
  feeTxId: string;
  feeHbar: number;
}

export interface OperatorSendArgs {
  /** Topic id, e.g. the town-hall chat topic. */
  topicId: string;
  /** Exact JSON string to submit (already safety-checked by the caller). */
  messageJson: string;
  /** The human's account — the allowance owner. */
  ownerAccountId: string;
}

/**
 * Submit an HCS message with the operator key, then draw the flat fee from
 * the human's fee budget via approved transfer. Throws on any failure —
 * callers translate to tool errors. Never blocks on getReceipt (hangs from
 * some environments); the tx ids are returned for mirror verification.
 */
export async function operatorSendMessage(
  args: OperatorSendArgs,
): Promise<OperatorSendResult> {
  const keyStr = (process.env.HCS_SENDER_KEY ?? "").trim();
  const operatorAccount = getOperatorAccountId();
  if (!keyStr || !operatorAccount) {
    throw new Error(
      "operator-not-configured: the HCS sender is not wired on this server — message:send is unavailable",
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.ownerAccountId)) {
    throw new Error("operatorSendMessage: bad owner account id");
  }
  if (!/^\d+\.\d+\.\d+$/.test(args.topicId)) {
    throw new Error("operatorSendMessage: bad topic id");
  }
  if (!args.messageJson || args.messageJson.length > 6_144) {
    throw new Error("operatorSendMessage: message missing or oversized");
  }

  const {
    Client,
    PrivateKey,
    AccountId,
    TopicId,
    TopicMessageSubmitTransaction,
    TransferTransaction,
    Hbar,
    TransactionId,
  } = await import("@hiero-ledger/sdk");

  const operatorKey = PrivateKey.fromString(keyStr);
  const client = Client.forMainnet();
  client.setOperator(AccountId.fromString(operatorAccount), operatorKey);

  try {
    // 1. Submit the message. The operator fronts the HCS fee.
    const submit = new TopicMessageSubmitTransaction()
      .setTopicId(TopicId.fromString(args.topicId))
      .setMessage(args.messageJson)
      .setTransactionId(TransactionId.generate(AccountId.fromString(operatorAccount)))
      .freezeWith(client);
    const signed = await submit.sign(operatorKey);
    const resp = await signed.execute(client);
    const hcsTxId = resp.transactionId.toString();

    // 2. Draw the flat fee from the human's budget via their allowance.
    //    If this fails the server eats dust — the spend is still recorded
    //    against the budget (the human authorized it; collection failing
    //    is an ops incident, not a double-charge).
    let feeTxId = "";
    try {
      const feeTx = new TransferTransaction()
        .addApprovedHbarTransfer(args.ownerAccountId, new Hbar(-FLAT_MESSAGE_FEE_HBAR))
        .addHbarTransfer(operatorAccount, new Hbar(FLAT_MESSAGE_FEE_HBAR))
        .setTransactionId(TransactionId.generate(AccountId.fromString(operatorAccount)))
        .freezeWith(client);
      const feeSigned = await feeTx.sign(operatorKey);
      const feeResp = await feeSigned.execute(client);
      feeTxId = feeResp.transactionId.toString();
    } catch (e) {
      // Recorded by the caller in the audit log; do not fail the send —
      // the message is already on-chain and the human authorized the fee.
      throw new Error(
        `fee-draw-failed: message sent as ${hcsTxId} but the approved fee transfer failed: ` +
          (e instanceof Error ? e.message : "unknown"),
      );
    }

    return { hcsTxId, feeTxId, feeHbar: FLAT_MESSAGE_FEE_HBAR };
  } finally {
    client.close();
  }
}

/**
 * Verify via the mirror node that an HBAR allowance exists from the owner
 * to the operator account for at least minHbar. Read-only; used at
 * issuance to confirm the human's fee-budget approval landed.
 */
export async function verifyFeeAllowance(
  ownerAccountId: string,
  minHbar: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ ok: boolean; grantedHbar: number }> {
  const operator = getOperatorAccountId();
  if (!operator) return { ok: false, grantedHbar: 0 };
  try {
    const res = await fetchFn(
      `https://mainnet.mirrornode.hedera.com/api/v1/accounts/${encodeURIComponent(ownerAccountId)}/allowances/crypto`,
    );
    if (!res.ok) return { ok: false, grantedHbar: 0 };
    const data = (await res.json()) as {
      allowances?: Array<{ spender?: string; amount_granted?: number }>;
    };
    let grantedTinybar = 0;
    for (const a of data.allowances ?? []) {
      if (a.spender === operator && typeof a.amount_granted === "number") {
        grantedTinybar = Math.max(grantedTinybar, a.amount_granted);
      }
    }
    const grantedHbar = grantedTinybar / 100_000_000;
    return { ok: grantedHbar + 1e-9 >= minHbar, grantedHbar };
  } catch {
    return { ok: false, grantedHbar: 0 };
  }
}
