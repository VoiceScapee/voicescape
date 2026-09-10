import TownhallShell from "@/components/townhall/TownhallShell";

/**
 * Route group layout for the Social Town Hall layer.
 * (Route groups don't change URLs — /forum etc. stay as-is.)
 *
 * Wallet + session providers live at the root layout; the shell consumes
 * them directly.
 */
export default function TownhallLayout({ children }: { children: React.ReactNode }) {
  return <TownhallShell>{children}</TownhallShell>;
}
