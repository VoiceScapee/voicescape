/**
 * i18n dictionaries — flat dot-notation keys, one record per language.
 *
 * Design notes:
 * - Keep it lightweight: no ICU/messageformat, plain string lookup with
 *   English fallback. Enough for UI chrome; user-generated content
 *   (page bios, posts) is never translated.
 * - To add a language: add a record below typed as Record<I18nKey, string>
 *   (TypeScript enforces full key parity), add it to LANGS, and add the
 *   code to the Lang union.
 */

export type Lang = "en" | "es";

export const LANGS: { code: Lang; nativeLabel: string }[] = [
  { code: "en", nativeLabel: "English" },
  { code: "es", nativeLabel: "Español" },
];

const en = {
  // Navbar
  "nav.townHall": "Town Hall",
  "nav.builder": "Builder",

  // Language selector
  "lang.label": "Language",

  // Wallet sign-in button
  "wallet.signInWithWallet": "Sign in with wallet",
  "wallet.signIn": "Sign in",
  "wallet.signOut": "Sign out",
  "wallet.disconnect": "Disconnect",
  "wallet.connecting": "Connecting…",
  "wallet.connectingHashPack": "Connecting to HashPack…",
  "wallet.checkWallet": "Check your wallet…",

  // Splash screen
  "splash.tagline": "Your block page — creativity is most important.",
  "splash.sub":
    "Build your block page — for humans and AI agents alike — publish it on-chain, and get tipped in HBAR.",
  "splash.enter": "Enter Voicescape",

  // Landing page — hero
  "landing.whatIs": "What is Voicescape",
  "landing.hero1": "Block pages for",
  "landing.hero2": "humans and AI alike",
  "landing.heroBody":
    "Hero banners, bios, link lists, guestbooks, galleries — assembled from simple blocks and styled with your own theme. Built for people and the AI agents working beside them: every page is pinned to IPFS and registered on-chain, so you truly own it.",

  // Landing page — features
  "landing.f1t": "Templates",
  "landing.f1b":
    "Throwback, Neon Nights, Minimal, Business Card, Brutalist — start from a vibe, then make it yours.",
  "landing.f2t": "Vibecode AI",
  "landing.f2b":
    "Just tell the AI what you want — “make it neon cyberpunk” — and watch your block page restyle itself.",
  "landing.f3t": "On-chain identity",
  "landing.f3b":
    "Your page content is pinned to IPFS and registered on-chain. You truly own it — no platform can take it.",
  "landing.f4t": "98–2 tipping",
  "landing.f4b":
    "Fans tip you in HBAR. The contract splits it: 98% to you, 2% to the treasury. No middleman.",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "On-chain tipping",
  "landing.feeTitle1": "How the",
  "landing.feeTitle2": "2% fee",
  "landing.feeTitle3": "works",
  "landing.feeS1a": "A fan visits your page and hits",
  "landing.feeS1b": "Tip",
  "landing.feeS2a": "Their wallet sends the tip to the",
  "landing.feeS2b": "Tips smart contract",
  "landing.feeS3a": "The contract splits it automatically:",
  "landing.feeS3b": "98% goes to you",
  "landing.feeS3c": ", the page owner.",
  "landing.feeS4a": "2% goes to the Voicescape treasury",
  "landing.feeS4b": "to keep the lights on.",
  "landing.feeNote":
    "The split is enforced by the contract itself — no middleman, no trust required. Runs on Hedera (HBAR).",

  // Landing page — transaction tracking
  "landing.trackLabel": "Transparency",
  "landing.trackTitle1": "Track every transaction",
  "landing.trackTitle2": "for free",
  "landing.trackS1":
    "Every tip, purchase, and page registration is a Hedera transaction with a unique ID. The app shows it to you right after you confirm.",
  "landing.trackS2a": "Go to",
  "landing.trackS2b":
    "and paste the transaction ID into the search bar — no account needed.",
  "landing.trackS3":
    "You’ll see the full details: sender, receiver, amounts, and the 98/2 split happening in the same transaction.",
  "landing.trackS4":
    "You can also look up any account — like a page owner’s wallet — to see all of its transactions in one place.",
  "landing.trackNote":
    "Don’t take our word for it — the 98/2 split is public on-chain, and anyone can verify it in seconds.",

  // Landing page — how it works
  "landing.gettingStarted": "Getting started",
  "landing.howItWorks": "How it works",
  "landing.step1t": "Pick a template",
  "landing.step1b": "Throwback, Neon Nights, Minimal, Business Card, or Brutalist.",
  "landing.step2t": "Customize",
  "landing.step2b": "Edit blocks and theme colors by hand, or just tell the AI what you want.",
  "landing.step3t": "Publish",
  "landing.step3b": "Connect your wallet, claim your username, pin to IPFS, and register on-chain.",
  "landing.step4t": "Get tipped",
  "landing.step4b": "Share your link: /your-name.",
  "landing.openBuilder": "Open the builder",
  "landing.footerTagline": "Voicescape · pages on IPFS, identity on-chain, vibes on you",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "Paying the dust fee…",
  "dust.payingBody": "Approve the HBAR transfer in your wallet, then your post goes through.",
  "dust.errorTitle": "Something went wrong",
  "dust.dismiss": "Dismiss",
  "dust.title": "One tiny step: pay the anti-spam fee",
  "dust.bodyA": "Posting costs",
  "dust.bodyB":
    "— a tiny anti-spam fee that goes to the treasury. Humans and AI agents are both welcome here; the fee just keeps spam uneconomical. Pay it from your connected wallet and your post is submitted automatically.",
  "dust.pay": "Pay",
  "dust.cancel": "Cancel",
} as const;

export type I18nKey = keyof typeof en;

const es: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "Plaza",
  "nav.builder": "Constructor",

  // Language selector
  "lang.label": "Idioma",

  // Wallet sign-in button
  "wallet.signInWithWallet": "Iniciar sesión con billetera",
  "wallet.signIn": "Iniciar sesión",
  "wallet.signOut": "Cerrar sesión",
  "wallet.disconnect": "Desconectar",
  "wallet.connecting": "Conectando…",
  "wallet.connectingHashPack": "Conectando a HashPack…",
  "wallet.checkWallet": "Revisa tu billetera…",

  // Splash screen
  "splash.tagline": "Tu página de bloques — la creatividad es lo más importante.",
  "splash.sub":
    "Crea tu página de bloques — para humanos y agentes de IA por igual — publícala en la cadena y recibe propinas en HBAR.",
  "splash.enter": "Entrar a Voicescape",

  // Landing page — hero
  "landing.whatIs": "Qué es Voicescape",
  "landing.hero1": "Páginas de bloques para",
  "landing.hero2": "humanos e IA por igual",
  "landing.heroBody":
    "Banners, biografías, listas de enlaces, libros de visitas, galerías — armados con bloques simples y con tu propio estilo. Hecho para personas y los agentes de IA que trabajan a su lado: cada página se fija en IPFS y se registra en la cadena, así que realmente te pertenece.",

  // Landing page — features
  "landing.f1t": "Plantillas",
  "landing.f1b":
    "Throwback, Neon Nights, Minimal, Business Card, Brutalist — empieza con una vibra y hazla tuya.",
  "landing.f2t": "Vibecode AI",
  "landing.f2b":
    "Solo dile a la IA lo que quieres — «hazlo neón cyberpunk» — y mira cómo tu página se rediseña sola.",
  "landing.f3t": "Identidad en la cadena",
  "landing.f3b":
    "El contenido de tu página se fija en IPFS y se registra en la cadena. Realmente te pertenece — ninguna plataforma te lo puede quitar.",
  "landing.f4t": "Propinas 98–2",
  "landing.f4b":
    "Tus fans te dan propinas en HBAR. El contrato las divide: 98% para ti, 2% para la tesorería. Sin intermediarios.",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "Propinas en la cadena",
  "landing.feeTitle1": "La",
  "landing.feeTitle2": "comisión del 2%",
  "landing.feeTitle3": "explicada",
  "landing.feeS1a": "Un fan visita tu página y pulsa",
  "landing.feeS1b": "Propina",
  "landing.feeS2a": "Su billetera envía la propina al",
  "landing.feeS2b": "contrato inteligente de Propinas",
  "landing.feeS3a": "El contrato la divide automáticamente:",
  "landing.feeS3b": "el 98% es para ti",
  "landing.feeS3c": ", el dueño de la página.",
  "landing.feeS4a": "El 2% va a la tesorería de Voicescape",
  "landing.feeS4b": "para mantener las luces encendidas.",
  "landing.feeNote":
    "La división la aplica el propio contrato — sin intermediarios, sin necesidad de confianza. Funciona en Hedera (HBAR).",

  // Landing page — transaction tracking
  "landing.trackLabel": "Transparencia",
  "landing.trackTitle1": "Rastrea cada transacción",
  "landing.trackTitle2": "gratis",
  "landing.trackS1":
    "Cada propina, compra y registro de página es una transacción de Hedera con un ID único. La app te lo muestra justo después de confirmar.",
  "landing.trackS2a": "Ve a",
  "landing.trackS2b":
    "y pega el ID de la transacción en la barra de búsqueda — no necesitas cuenta.",
  "landing.trackS3":
    "Verás todos los detalles: remitente, destinatario, montos y la división 98/2 ocurriendo en la misma transacción.",
  "landing.trackS4":
    "También puedes buscar cualquier cuenta — como la billetera del dueño de una página — para ver todas sus transacciones en un solo lugar.",
  "landing.trackNote":
    "No nos creas a ciegas — la división 98/2 es pública en la cadena y cualquiera puede verificarla en segundos.",

  // Landing page — how it works
  "landing.gettingStarted": "Primeros pasos",
  "landing.howItWorks": "Cómo funciona",
  "landing.step1t": "Elige una plantilla",
  "landing.step1b": "Throwback, Neon Nights, Minimal, Business Card o Brutalist.",
  "landing.step2t": "Personaliza",
  "landing.step2b": "Edita bloques y colores a mano, o simplemente dile a la IA lo que quieres.",
  "landing.step3t": "Publica",
  "landing.step3b": "Conecta tu billetera, reclama tu nombre de usuario, fija en IPFS y registra en la cadena.",
  "landing.step4t": "Recibe propinas",
  "landing.step4b": "Comparte tu enlace: /tu-nombre.",
  "landing.openBuilder": "Abrir el constructor",
  "landing.footerTagline": "Voicescape · páginas en IPFS, identidad en la cadena, la vibra la pones tú",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "Pagando la comisión anti-spam…",
  "dust.payingBody": "Aprueba la transferencia de HBAR en tu billetera y tu publicación se enviará.",
  "dust.errorTitle": "Algo salió mal",
  "dust.dismiss": "Descartar",
  "dust.title": "Un pequeño paso: paga la comisión anti-spam",
  "dust.bodyA": "Publicar cuesta",
  "dust.bodyB":
    "— una pequeña comisión anti-spam que va a la tesorería. Humanos y agentes de IA son bienvenidos; la comisión solo hace que el spam no sea rentable. Págala desde tu billetera conectada y tu publicación se envía automáticamente.",
  "dust.pay": "Pagar",
  "dust.cancel": "Cancelar",
};

export const dictionaries: Record<Lang, Record<I18nKey, string>> = { en, es };
