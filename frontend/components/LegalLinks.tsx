import Link from "next/link";

/**
 * Terms / Privacy links for page footers. Kept untranslated ("Terms" and
 * "Privacy" are legal-document titles; the English versions govern).
 */
export default function LegalLinks() {
  return (
    <nav
      aria-label="Legal"
      style={{
        display: "flex",
        gap: 20,
        justifyContent: "center",
        margin: "16px 0",
        fontSize: 13,
      }}
    >
      <Link href="/terms" style={{ color: "var(--vs-muted)", textDecoration: "underline" }}>
        Terms
      </Link>
      <Link href="/privacy" style={{ color: "var(--vs-muted)", textDecoration: "underline" }}>
        Privacy
      </Link>
    </nav>
  );
}
