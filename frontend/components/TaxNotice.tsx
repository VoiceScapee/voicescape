"use client";

/**
 * <TaxNotice> — plain-language creator tax notice.
 *
 * The compliance brief (IRS §2.4): crypto received as payment for goods or
 * services is taxable income at fair market value on receipt — the
 * platform has no 1099-DA obligation as a non-custodial service, but the
 * creator still owes the tax. This notice says exactly that, in plain
 * language, and explicitly is not tax advice.
 *
 * Placed on tip and purchase surfaces (blockpage tip box, marketplace
 * listing, creator earnings panel).
 */
export default function TaxNotice({ compact = false }: { compact?: boolean }) {
  return (
    <p
      className="th-muted"
      style={{ fontSize: compact ? 11 : 12, margin: "8px 0 0", lineHeight: 1.5 }}
    >
      🧾 <strong>Tax note for creators:</strong> tips and sale proceeds you receive are generally
      taxable income you&apos;re responsible for reporting — this isn&apos;t tax advice. When in
      doubt, ask a tax professional.
    </p>
  );
}
