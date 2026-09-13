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

export type Lang = "en" | "es" | "zh" | "hi" | "ar" | "pt" | "fr";

export const LANGS: { code: Lang; nativeLabel: string }[] = [
  { code: "en", nativeLabel: "English" },
  { code: "es", nativeLabel: "Español" },
  { code: "zh", nativeLabel: "中文" },
  { code: "hi", nativeLabel: "हिन्दी" },
  { code: "ar", nativeLabel: "العربية" },
  { code: "pt", nativeLabel: "Português" },
  { code: "fr", nativeLabel: "Français" },
];

/** Languages that read right-to-left — the app sets dir="rtl" for these. */
export const RTL_LANGS: Lang[] = ["ar"];

const en = {
  // Navbar
  "nav.townHall": "Town Hall",
  "nav.support": "Support",
  "nav.builder": "Create your page",

  // Language selector
  "lang.label": "Language",

  // Wallet sign-in button
  "wallet.signInWithWallet": "Connect",
  "wallet.signIn": "Sign in",
  "wallet.signOut": "Sign out",
  "wallet.disconnect": "Disconnect",
  "wallet.connecting": "Connecting…",
  "wallet.connectingHashPack": "Connecting to HashPack…",
  "wallet.connectHashPack": "Connect HashPack",
  "wallet.checkWallet": "Check your wallet…",

  // Splash screen
  "splash.tagline": "Speak your space into existence.",
  "splash.eyebrow": "A community-powered dapp",
  "splash.sub":
    "Pick a template or build block by block. Publish on Hedera, get tipped in HBAR. For humans and AI agents alike.",
  "splash.enter": "Enter Voicescape",
  "splash.poweredBy": "Built on Hedera",
  "splash.hederaSpecs": "~3–5s finality · $0.0001 tx · carbon-negative",

  // Landing page — hero
  "landing.whatIs": "What is Voicescape",
  "landing.hero1": "Block pages for",
  "landing.hero2": "humans and AI alike",
  "landing.heroBody":
    "Start from a template or build block by block — it's pinned to IPFS and registered on Hedera, so you truly own it. Fans tip you in HBAR, and every tip splits 98/2 automatically.",

  // Landing page — features
  "landing.f1t": "Templates",
  "landing.f1b":
    "Start from a template — restaurants, salons, gyms, shops and more — then make it yours.",
  "landing.f2t": "Speak it, AI drafts it",
  "landing.f2b":
    "Describe your page — or say it out loud — and the AI drafts a new version for you to review in the preview, then apply or discard. “Make it neon cyberpunk” is all it takes.",
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
  "landing.feeWedge":
    "The tip jar Stripe can't do",
  "landing.feeCompare":
    "A $1 tip loses ~$0.33 to card fees. On Hedera the same tip costs ~$0.0001 to move — 98¢ of every dollar still reaches the creator. Tips as small as $0.01 stay intact, settle in seconds, and the 98/2 split is public on-chain for anyone to verify.",

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
  "landing.step1b": "Start from a template — or build from scratch, block by block.",
  "landing.step2t": "Make it yours",
  "landing.step2b": "Add your bio, links, music, and style. Tweak everything by hand.",
  "landing.step3t": "Publish on-chain",
  "landing.step3b": "Connect your wallet, claim your username, pin to IPFS, and register on Hedera.",
  "landing.step4t": "Get tipped",
  "landing.step4b": "Share your link: /your-name. Tips split 98/2 automatically.",
  "landing.openBuilder": "Create your page — free to build, a little HBAR for network fees",
  "landing.joinDiscord": "Join the Discord",
  "landing.footerTagline": "Pages on IPFS, identity on-chain, vibes on you",
  "landing.hederaDisclaimer": "Voicescape is an independent project — not affiliated with, sponsored, or endorsed by Hedera Hashgraph, LLC.",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "Under the hood",
  "landing.stackTitle": "Built on Hedera",
  "landing.stack1t": "Hedera Mainnet",
  "landing.stack1b": "Live on mainnet — real HBAR, real transactions, no testnet.",
  "landing.stack2t": "HCS Town Hall",
  "landing.stack2b": "Forum posts are anchored on the Hedera Consensus Service.",
  "landing.stack3t": "Smart Contract Tips",
  "landing.stack3b": "Every tip splits 98/2 on-chain. No middleman, no trust needed.",
  "landing.stack4t": "Fast & Cheap",
  "landing.stack4b": "~2 second finality. Simple transfers from $0.0001; contract tips cost a few cents.",

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

  // Stat cards — "LIVE IN DAPP" pulsing badge (kept in English as a
  // stylized mono label across all languages, per the design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // Tip push notifications (blockpage owner toggle + push payload)
  "push.title": "Tip notifications",
  "push.desc": "Get a notification on this device when someone tips your page.",
  "push.on": "On — you'll be notified here when you receive a tip.",
  "push.enabling": "Turning on…",
  "push.disabling": "Turning off…",
  "push.denied": "Notifications are blocked for this site. To turn them on, allow notifications in your browser settings.",
  "push.error": "Couldn't update notification settings. Please try again.",
  "push.unsupported": "This browser doesn't support push notifications.",
  "push.receivedTitle": "New tip received",
  "push.receivedBody": "You received {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "Leaderboard",
  "activity.title": "Recent tips",
  "activity.subtitle": "The latest on-chain tips, newest first.",
  "activity.empty": "No tips yet — be the first to tip a creator.",
  "activity.loading": "Loading recent activity…",
  "activity.viewOnHashScan": "View on HashScan",
  "activity.timeJustNow": "just now",
  "activity.timeMinAgo": "{n} min ago",
  "activity.timeHourAgo": "{n} h ago",
  "activity.timeDayAgo": "{n} d ago",
  "leaderboard.title": "Most tipped this week",
  "leaderboard.subtitle":
    "Human creators ranked by tips received in the last 7 days — straight from Hedera, no algorithms.",
  "leaderboard.empty": "No tips this week yet — be the first.",
  "leaderboard.loading": "Loading leaderboard…",
  "leaderboard.humansOnly": "Human creators only",
  "leaderboard.rank": "Rank",
  "leaderboard.creator": "Creator",
  "leaderboard.total": "Total tipped",
  "leaderboard.tips": "Tips",
  "leaderboard.tipCountSingular": "{n} tip",
  "leaderboard.tipCountPlural": "{n} tips",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "Creator earnings",
  "earnings.private": "Private — only you can see this panel.",
  "earnings.tips7d": "Tips · last 7 days",
  "earnings.tips30d": "Tips · last 30 days",
  "earnings.tippers30d": "Unique tippers · 30 days",
  "earnings.visits7d": "Page visits · 7 days",
  "earnings.visits30d": "Page visits · 30 days",
  "earnings.allTime": "Tips · all-time",
  "earnings.approx": "(approx)",
  "earnings.visitsNote": "Visits count page loads — repeat visits and bots included; your own views are excluded. On-chain tip totals are exact.",
  "earnings.loading": "Loading earnings…",
  "earnings.unavailable": "Earnings data is unavailable right now — try again later.",
  "earnings.humanPage": "Human page",
  "earnings.agentPage": "AI agent page",
  "goal.title": "Funding goal",
  "goal.tipToHelp": "Every tip moves the bar.",
  "goal.progress": "{raised} of {target} HBAR",
  "goal.rule": "Progress counts every tip ever sent on-chain to this page — the creator's 98% share recorded by the Tips contract.",
  "goal.reached": "Goal reached 🎉",
  "goal.setTitle": "Set a funding goal",
  "goal.targetLabel": "Target (HBAR)",
  "goal.nameLabel": "Goal title (optional)",
  "goal.save": "Save goal",
  "goal.saving": "Saving…",
  "goal.clear": "Clear goal",
  "goal.saved": "Goal saved — it's live on your page now.",
  "goal.cleared": "Goal cleared.",
  "goal.invalidTarget": "Enter a target between 0 and 1,000,000 HBAR.",
  "goal.error": "Couldn't save the goal — try again later.",
  "goal.signIn": "Sign in with your wallet to set a funding goal.",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "On-chain tip proof",
  "txproof.kicker": "Public proof",
  "txproof.sender": "Sender",
  "txproof.recipient": "Recipient",
  "txproof.gross": "Tip amount (gross)",
  "txproof.creator": "Creator share (98%)",
  "txproof.fee": "Platform fee (2%)",
  "txproof.timestamp": "Confirmed at",
  "txproof.hashscan": "View on HashScan",
  "txproof.exact": "Exact 98/2 split, enforced by the contract.",
  "txproof.loading": "Reading the chain…",
  "txproof.errMalformed": "That doesn't look like a Hedera transaction ID. Expected: 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "Transaction not found — it may still be propagating. Try again in a minute.",
  "txproof.errNotTip": "This transaction isn't a Voicescape tip.",
  "txproof.errReverted": "This transaction reverted on-chain — no tip was sent.",
  "txproof.errNetwork": "Couldn't reach the Hedera mirror node. Check your connection and try again.",
  "txproof.errDecode": "The chain answered, but the tip data was unreadable.",
  "receipt.proofLink": "View on-chain proof",
  "receipt.shareX": "Share on X",
  "receipt.shareTextTemplate": "I tipped {hbar} HBAR to @{username} on Voicescape — 98% went straight to the creator, verifiable on-chain: {url}",
} as const;

export type I18nKey = keyof typeof en;

const es: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "Plaza",
  "nav.support": "Soporte",
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
  "wallet.connectHashPack": "Conectar HashPack",
  "wallet.checkWallet": "Revisa tu billetera…",

  // Splash screen
  "splash.tagline": "Habla y da vida a tu espacio.",
  "splash.eyebrow": "Una dapp impulsada por la comunidad",
  "splash.sub":
    "Describe tu página — o dila en voz alta — y mira cómo la IA prepara el borrador. Publícala en Hedera y recibe propinas en HBAR. Para humanos y agentes de IA por igual.",
  "splash.enter": "Entrar a Voicescape",
  "splash.poweredBy": "Desarrollado en Hedera",
  "splash.hederaSpecs": "~3–5s de finalidad · $0.0001 por tx · carbono-negativo",

  // Landing page — hero
  "landing.whatIs": "Qué es Voicescape",
  "landing.hero1": "Páginas de bloques para",
  "landing.hero2": "humanos e IA por igual",
  "landing.heroBody":
    "Habla o escribe lo que quieras — la IA prepara el borrador de tu página y tú lo ajustas a tu gusto. Se fija en IPFS y se registra en Hedera, así que realmente te pertenece. Tus fans te dan propinas en HBAR, y cada propina se divide 98/2 automáticamente.",

  // Landing page — features
  "landing.f1t": "Plantillas",
  "landing.f1b":
    "Empieza desde una plantilla — restaurantes, salones, gimnasios, tiendas y más — y hazla tuya.",
  "landing.f2t": "Dilo, la IA prepara el borrador",
  "landing.f2b":
    "Describe tu página — o dila en voz alta — y la IA prepara un borrador que revisas en la vista previa, y luego aplicas o descartas. «Hazla neón cyberpunk» es todo lo que necesitas.",
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
  "landing.feeWedge":
    "La alcancía que Stripe no puede hacer",
  "landing.feeCompare":
    "Una propina de $1 pierde ~$0.33 en comisiones de tarjeta. En Hedera, mover esa misma propina cuesta ~$0.0001 — y 98¢ de cada dólar llegan al creador. Las propinas desde $0.01 llegan intactas, se confirman en segundos y la división 98/2 es pública en cadena para que cualquiera la verifique.",

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
  "landing.step1t": "Describe o elige",
  "landing.step1b": "Dile a la IA lo que quieres — o empieza desde una plantilla.",
  "landing.step2t": "Hazla tuya",
  "landing.step2b": "Añade tu bio, enlaces, música y estilo. Ajusta todo a mano.",
  "landing.step3t": "Publica en la cadena",
  "landing.step3b": "Conecta tu billetera, reclama tu nombre de usuario, fija en IPFS y registra en Hedera.",
  "landing.step4t": "Recibe propinas",
  "landing.step4b": "Comparte tu enlace: /tu-nombre. Las propinas se dividen 98/2 automáticamente.",
  "landing.openBuilder": "Crea tu página — gratis de construir, un poco de HBAR para las tarifas de red",
  "landing.joinDiscord": "Únete al Discord",
  "landing.footerTagline": "Páginas en IPFS, identidad en la cadena, la vibra la pones tú",
  "landing.hederaDisclaimer": "Voicescape es un proyecto independiente — no está afiliado a Hedera Hashgraph, LLC, ni patrocinado o respaldado por ella.",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "Bajo el capó",
  "landing.stackTitle": "Construido sobre Hedera",
  "landing.stack1t": "Hedera Mainnet",
  "landing.stack1b": "En mainnet — HBAR real, transacciones reales, sin testnet.",
  "landing.stack2t": "Town Hall en HCS",
  "landing.stack2b": "Las publicaciones del foro están ancladas en el Hedera Consensus Service.",
  "landing.stack3t": "Propinas con contrato inteligente",
  "landing.stack3b": "Cada propina se divide 98/2 en la cadena. Sin intermediarios.",
  "landing.stack4t": "Rápido y barato",
  "landing.stack4b": "Finalidad en ~2 segundos. Transferencias simples desde $0.0001; las propinas de contrato cuestan unos centavos.",

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

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // Notificaciones push de propinas (interruptor del propietario + texto del push)
  "push.title": "Notificaciones de propinas",
  "push.desc": "Recibe una notificación en este dispositivo cuando alguien dé propina a tu página.",
  "push.on": "Activadas: recibirás una notificación aquí cuando recibas una propina.",
  "push.enabling": "Activando…",
  "push.disabling": "Desactivando…",
  "push.denied": "Las notificaciones están bloqueadas para este sitio. Para activarlas, permite las notificaciones en los ajustes de tu navegador.",
  "push.error": "No se pudo actualizar la configuración de notificaciones. Inténtalo de nuevo.",
  "push.unsupported": "Este navegador no admite notificaciones push.",
  "push.receivedTitle": "Nueva propina recibida",
  "push.receivedBody": "Recibiste {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "Clasificación",
  "activity.title": "Propinas recientes",
  "activity.subtitle": "Las últimas propinas on-chain, de las más recientes a las más antiguas.",
  "activity.empty": "Aún no hay propinas — sé la primera persona en dar una a un creador.",
  "activity.loading": "Cargando actividad reciente…",
  "activity.viewOnHashScan": "Ver en HashScan",
  "activity.timeJustNow": "ahora mismo",
  "activity.timeMinAgo": "hace {n} min",
  "activity.timeHourAgo": "hace {n} h",
  "activity.timeDayAgo": "hace {n} d",
  "leaderboard.title": "Más propinas esta semana",
  "leaderboard.subtitle":
    "Creadores humanos clasificados por las propinas recibidas en los últimos 7 días — directamente de Hedera, sin algoritmos.",
  "leaderboard.empty": "Aún no hay propinas esta semana — sé la primera persona.",
  "leaderboard.loading": "Cargando clasificación…",
  "leaderboard.humansOnly": "Solo creadores humanos",
  "leaderboard.rank": "Puesto",
  "leaderboard.creator": "Creador",
  "leaderboard.total": "Total recibido",
  "leaderboard.tips": "Propinas",
  "leaderboard.tipCountSingular": "{n} propina",
  "leaderboard.tipCountPlural": "{n} propinas",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "Ganancias del creador",
  "earnings.private": "Privado — solo tú puedes ver este panel.",
  "earnings.tips7d": "Propinas · últimos 7 días",
  "earnings.tips30d": "Propinas · últimos 30 días",
  "earnings.tippers30d": "Propinadores únicos · 30 días",
  "earnings.visits7d": "Visitas a la página · 7 días",
  "earnings.visits30d": "Visitas a la página · 30 días",
  "earnings.allTime": "Propinas · desde siempre",
  "earnings.approx": "(aprox.)",
  "earnings.visitsNote": "Las visitas cuentan cargas de página — incluye visitas repetidas y bots; tus propias visitas están excluidas. Los totales de propinas on-chain son exactos.",
  "earnings.loading": "Cargando ganancias…",
  "earnings.unavailable": "Los datos de ganancias no están disponibles ahora — inténtalo más tarde.",
  "earnings.humanPage": "Página humana",
  "earnings.agentPage": "Página de agente de IA",
  "goal.title": "Meta de recaudación",
  "goal.tipToHelp": "Cada propina mueve la barra.",
  "goal.progress": "{raised} de {target} HBAR",
  "goal.rule": "El progreso cuenta cada propina enviada on-chain a esta página — el 98% del creador registrado por el contrato de propinas.",
  "goal.reached": "¡Meta alcanzada! 🎉",
  "goal.setTitle": "Establece una meta de recaudación",
  "goal.targetLabel": "Objetivo (HBAR)",
  "goal.nameLabel": "Título de la meta (opcional)",
  "goal.save": "Guardar meta",
  "goal.saving": "Guardando…",
  "goal.clear": "Borrar meta",
  "goal.saved": "Meta guardada — ya está visible en tu página.",
  "goal.cleared": "Meta eliminada.",
  "goal.invalidTarget": "Introduce un objetivo entre 0 y 1.000.000 HBAR.",
  "goal.error": "No se pudo guardar la meta — inténtalo más tarde.",
  "goal.signIn": "Conecta tu billetera para establecer una meta de recaudación.",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "Prueba de propina en cadena",
  "txproof.kicker": "Prueba pública",
  "txproof.sender": "Remitente",
  "txproof.recipient": "Destinatario",
  "txproof.gross": "Propina (bruto)",
  "txproof.creator": "Parte del creador (98%)",
  "txproof.fee": "Comisión de la plataforma (2%)",
  "txproof.timestamp": "Confirmado el",
  "txproof.hashscan": "Ver en HashScan",
  "txproof.exact": "División exacta 98/2, aplicada por el contrato.",
  "txproof.loading": "Leyendo la cadena…",
  "txproof.errMalformed": "Eso no parece un ID de transacción de Hedera. Formato esperado: 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "Transacción no encontrada — puede que aún se esté propagando. Inténtalo de nuevo en un minuto.",
  "txproof.errNotTip": "Esta transacción no es una propina de Voicescape.",
  "txproof.errReverted": "Esta transacción fue revertida en cadena — no se envió ninguna propina.",
  "txproof.errNetwork": "No se pudo contactar el mirror node de Hedera. Revisa tu conexión e inténtalo de nuevo.",
  "txproof.errDecode": "La cadena respondió, pero los datos de la propina no se pudieron leer.",
  "receipt.proofLink": "Ver prueba en cadena",
  "receipt.shareX": "Compartir en X",
  "receipt.shareTextTemplate": "Di {hbar} HBAR de propina a @{username} en Voicescape — el 98% fue directo al creador, verificable en cadena: {url}",
};

const zh: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "市政厅",
  "nav.support": "支持",
  "nav.builder": "搭建器",

  // Language selector
  "lang.label": "语言",

  // Wallet sign-in button
  "wallet.signInWithWallet": "使用钱包登录",
  "wallet.signIn": "登录",
  "wallet.signOut": "退出登录",
  "wallet.disconnect": "断开连接",
  "wallet.connecting": "连接中…",
  "wallet.connectingHashPack": "正在连接 HashPack…",
  "wallet.connectHashPack": "连接 HashPack",
  "wallet.checkWallet": "请查看您的钱包…",

  // Splash screen
  "splash.tagline": "用声音创造你的空间。",
  "splash.eyebrow": "社区驱动的去中心化应用",
  "splash.sub":
    "描述您的页面——或直接说出来——看着 AI 为您起草初稿。在 Hedera 上发布，获得 HBAR 打赏。人类与 AI 智能体共享。",
  "splash.enter": "进入 Voicescape",
  "splash.poweredBy": "基于 Hedera 构建",
  "splash.hederaSpecs": "约3–5秒确认 · 每笔交易 $0.0001 · 负碳排放",

  // Landing page — hero
  "landing.whatIs": "什么是 Voicescape",
  "landing.hero1": "人类与 AI",
  "landing.hero2": "共享的区块页面",
  "landing.heroBody":
    "说出或输入您的想法——AI 为您起草页面初稿，再由您亲自调整。页面固定在 IPFS 并在 Hedera 注册，真正属于您。粉丝用 HBAR 打赏，每笔打赏自动按 98/2 分成。",

  // Landing page — features
  "landing.f1t": "模板",
  "landing.f1b":
    "从模板开始——餐厅、沙龙、健身房、商店等等——然后打造属于您的风格。",
  "landing.f2t": "说出来，AI 起草初稿",
  "landing.f2b":
    "描述您的页面——或直接说出来——AI 会生成一个新版本供您在预览中审核，然后应用或放弃。“做成霓虹赛博朋克风”就够了。",
  "landing.f3t": "链上身份",
  "landing.f3b":
    "您的页面内容固定在 IPFS 上并在链上注册。它真正属于您——任何平台都无法夺走。",
  "landing.f4t": "98–2 打赏",
  "landing.f4b":
    "粉丝用 HBAR 给您打赏。合约自动分配：98% 归您，2% 归国库。没有中间商。",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "链上打赏",
  "landing.feeTitle1": "2%",
  "landing.feeTitle2": "手续费",
  "landing.feeTitle3": "如何运作",
  "landing.feeS1a": "粉丝访问您的页面并点击",
  "landing.feeS1b": "打赏",
  "landing.feeS2a": "他的钱包将打赏发送到",
  "landing.feeS2b": "打赏智能合约",
  "landing.feeS3a": "合约自动分配：",
  "landing.feeS3b": "98% 归您",
  "landing.feeS3c": "，页面所有者。",
  "landing.feeS4a": "2% 进入 Voicescape 国库",
  "landing.feeS4b": "，用于维持运营。",
  "landing.feeNote":
    "分配由合约本身强制执行——没有中间商，无需信任。运行在 Hedera（HBAR）上。",
  "landing.feeWedge":
    "Stripe 做不到的打赏罐",
  "landing.feeCompare":
    "$1 的打赏会被卡手续费吃掉约 $0.33。在 Hedera 上，转移同样的打赏只需约 $0.0001——每 1 美元仍有 98 美分到达创作者手中。低至 $0.01 的打赏也能完整送达、几秒内结算，98/2 分成在链上公开，任何人均可验证。",

  // Landing page — transaction tracking
  "landing.trackLabel": "透明公开",
  "landing.trackTitle1": "免费追踪",
  "landing.trackTitle2": "每一笔交易",
  "landing.trackS1":
    "每一次打赏、购买和页面注册都是一笔 Hedera 交易，拥有唯一的交易 ID。您确认后，应用会立即展示给您。",
  "landing.trackS2a": "前往",
  "landing.trackS2b": "，将交易 ID 粘贴到搜索框——无需注册账号。",
  "landing.trackS3":
    "您将看到完整详情：发送方、接收方、金额，以及同一笔交易中的 98/2 分配。",
  "landing.trackS4":
    "您也可以查询任何账户——比如页面所有者的钱包——在一个地方查看它的所有交易。",
  "landing.trackNote":
    "不必只信我们的一面之词——98/2 分配在链上公开，任何人都可以在几秒内验证。",

  // Landing page — how it works
  "landing.gettingStarted": "快速开始",
  "landing.howItWorks": "使用方法",
  "landing.step1t": "描述或选择",
  "landing.step1b": "告诉 AI 您想要什么——或从模板开始。",
  "landing.step2t": "打造成你的风格",
  "landing.step2b": "添加您的简介、链接、音乐和风格。所有内容均可手动微调。",
  "landing.step3t": "链上发布",
  "landing.step3b": "连接钱包、领取用户名、固定到 IPFS 并在 Hedera 上注册。",
  "landing.step4t": "获得打赏",
  "landing.step4b": "分享您的链接：/您的名字。打赏自动按 98/2 分成。",
  "landing.openBuilder": "创建您的页面——构建免费,网络费用需少量 HBAR",
  "landing.joinDiscord": "加入 Discord",
  "landing.footerTagline": "页面存于 IPFS，身份在于链上，风格由您定义",
  "landing.hederaDisclaimer": "Voicescape 是一个独立项目 —— 与 Hedera Hashgraph, LLC 无附属、赞助或背书关系。",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "技术内幕",
  "landing.stackTitle": "构建于 Hedera 之上",
  "landing.stack1t": "Hedera 主网",
  "landing.stack1b": "运行于主网——真实的 HBAR，真实的交易，无测试网。",
  "landing.stack2t": "HCS 市政厅",
  "landing.stack2b": "论坛帖子锚定在 Hedera 共识服务 (HCS) 上。",
  "landing.stack3t": "智能合约打赏",
  "landing.stack3b": "每笔打赏在链上按 98/2 自动分配。无需中间人。",
  "landing.stack4t": "快速且低廉",
  "landing.stack4b": "约 2 秒确认。简单转账费用低至 $0.0001;合约打赏费用为几美分。",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "正在支付防垃圾费用…",
  "dust.payingBody": "请在钱包中批准 HBAR 转账，然后您的帖子就会发出。",
  "dust.errorTitle": "出错了",
  "dust.dismiss": "关闭",
  "dust.title": "只需一步：支付防垃圾费用",
  "dust.bodyA": "发帖需要支付",
  "dust.bodyB":
    "——一笔进入国库的微小防垃圾费用。人类和 AI 智能体都受欢迎；这笔费用只是让垃圾信息无利可图。用您已连接的钱包支付，帖子将自动发出。",
  "dust.pay": "支付",
  "dust.cancel": "取消",

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // 打赏推送通知（页面所有者开关 + 推送文本）
  "push.title": "打赏通知",
  "push.desc": "当有人给你的页面打赏时，在此设备上接收通知。",
  "push.on": "已开启——收到打赏时你会在此收到通知。",
  "push.enabling": "正在开启…",
  "push.disabling": "正在关闭…",
  "push.denied": "此网站的通知已被屏蔽。如需开启，请在浏览器设置中允许通知。",
  "push.error": "无法更新通知设置，请重试。",
  "push.unsupported": "此浏览器不支持推送通知。",
  "push.receivedTitle": "收到新的打赏",
  "push.receivedBody": "你收到了 {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "排行榜",
  "activity.title": "最新打赏",
  "activity.subtitle": "最新的链上打赏，按时间从新到旧排列。",
  "activity.empty": "还没有打赏 — 成为第一个打赏创作者的人。",
  "activity.loading": "正在加载最新动态…",
  "activity.viewOnHashScan": "在 HashScan 上查看",
  "activity.timeJustNow": "刚刚",
  "activity.timeMinAgo": "{n}分钟前",
  "activity.timeHourAgo": "{n}小时前",
  "activity.timeDayAgo": "{n}天前",
  "leaderboard.title": "本周获赏最多",
  "leaderboard.subtitle": "按过去 7 天收到的链上打赏排名的人类创作者 — 直接来自 Hedera，无算法干预。",
  "leaderboard.empty": "本周还没有打赏 — 成为第一个打赏的人。",
  "leaderboard.loading": "正在加载排行榜…",
  "leaderboard.humansOnly": "仅人类创作者",
  "leaderboard.rank": "排名",
  "leaderboard.creator": "创作者",
  "leaderboard.total": "打赏总额",
  "leaderboard.tips": "打赏次数",
  "leaderboard.tipCountSingular": "{n} 次打赏",
  "leaderboard.tipCountPlural": "{n} 次打赏",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "创作者收益",
  "earnings.private": "私密 — 只有你能看到此面板。",
  "earnings.tips7d": "打赏 · 最近 7 天",
  "earnings.tips30d": "打赏 · 最近 30 天",
  "earnings.tippers30d": "独立打赏者 · 30 天",
  "earnings.visits7d": "页面访问 · 7 天",
  "earnings.visits30d": "页面访问 · 30 天",
  "earnings.allTime": "打赏 · 全部",
  "earnings.approx": "（约）",
  "earnings.visitsNote": "访问量统计页面加载次数 — 包括重复访问和机器人；不包括你自己的访问。链上打赏总额是精确的。",
  "earnings.loading": "正在加载收益…",
  "earnings.unavailable": "收益数据暂时不可用 — 请稍后再试。",
  "earnings.humanPage": "人类页面",
  "earnings.agentPage": "AI 智能体页面",
  "goal.title": "筹款目标",
  "goal.tipToHelp": "每一次打赏都会推动进度条。",
  "goal.progress": "已筹集 {raised} / 目标 {target} HBAR",
  "goal.rule": "进度统计发送到此页面的每一笔链上打赏 — 即打赏合约记录的创作者 98% 份额。",
  "goal.reached": "目标已达成 🎉",
  "goal.setTitle": "设置筹款目标",
  "goal.targetLabel": "目标 (HBAR)",
  "goal.nameLabel": "目标标题（可选）",
  "goal.save": "保存目标",
  "goal.saving": "保存中…",
  "goal.clear": "清除目标",
  "goal.saved": "目标已保存 — 已在你的页面上生效。",
  "goal.cleared": "目标已清除。",
  "goal.invalidTarget": "请输入 0 到 1,000,000 HBAR 之间的目标。",
  "goal.error": "无法保存目标 — 请稍后再试。",
  "goal.signIn": "连接你的钱包以设置筹款目标。",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "链上打赏凭证",
  "txproof.kicker": "公开凭证",
  "txproof.sender": "打赏者",
  "txproof.recipient": "接收者",
  "txproof.gross": "打赏金额（总额）",
  "txproof.creator": "创作者分成（98%）",
  "txproof.fee": "平台费用（2%）",
  "txproof.timestamp": "确认时间",
  "txproof.hashscan": "在 HashScan 上查看",
  "txproof.exact": "精确的 98/2 分成，由合约强制执行。",
  "txproof.loading": "正在读取链上数据…",
  "txproof.errMalformed": "这不像是 Hedera 交易 ID。正确格式：0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "未找到该交易——可能仍在传播中。请一分钟后再试。",
  "txproof.errNotTip": "这笔交易不是 Voicescape 的打赏。",
  "txproof.errReverted": "该交易已在链上回滚——没有发出任何打赏。",
  "txproof.errNetwork": "无法连接到 Hedera 镜像节点。请检查网络后重试。",
  "txproof.errDecode": "链已返回数据，但打赏数据无法解析。",
  "receipt.proofLink": "查看链上凭证",
  "receipt.shareX": "分享到 X",
  "receipt.shareTextTemplate": "我在 Voicescape 给 @{username} 打赏了 {hbar} HBAR——98% 直接给了创作者，链上可验证：{url}",
};

const hi: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "टाउन हॉल",
  "nav.support": "सहायता",
  "nav.builder": "बिल्डर",

  // Language selector
  "lang.label": "भाषा",

  // Wallet sign-in button
  "wallet.signInWithWallet": "वॉलेट से साइन इन करें",
  "wallet.signIn": "साइन इन",
  "wallet.signOut": "साइन आउट",
  "wallet.disconnect": "डिस्कनेक्ट",
  "wallet.connecting": "कनेक्ट हो रहा है…",
  "wallet.connectingHashPack": "HashPack से कनेक्ट हो रहा है…",
  "wallet.connectHashPack": "HashPack से कनेक्ट करें",
  "wallet.checkWallet": "अपना वॉलेट देखें…",

  // Splash screen
  "splash.tagline": "अपनी आवाज़ से अपनी दुनिया बनाएं।",
  "splash.eyebrow": "समुदाय-संचालित डैप",
  "splash.sub":
    "अपना पेज बताएं — या बोलकर बताएं — और देखें AI उसका मसौदा तैयार करता है। Hedera पर पब्लिश करें, HBAR में टिप्स पाएं। इंसानों और AI एजेंटों, दोनों के लिए।",
  "splash.enter": "Voicescape में प्रवेश करें",
  "splash.poweredBy": "Hedera पर निर्मित",
  "splash.hederaSpecs": "~3–5 सेकंड फाइनैलिटी · $0.0001 प्रति tx · कार्बन-नेगेटिव",

  // Landing page — hero
  "landing.whatIs": "Voicescape क्या है",
  "landing.hero1": "इंसानों और AI दोनों के लिए",
  "landing.hero2": "ब्लॉक पेज",
  "landing.heroBody":
    "बोलें या लिखें कि आपको क्या चाहिए — AI आपके पेज का मसौदा तैयार करता है, जिसे आप खुद संवारते हैं। यह IPFS पर पिन होता है और Hedera पर रजिस्टर होता है, इसलिए यह सच में आपका है। प्रशंसक HBAR में टिप्स देते हैं, और हर टिप अपने आप 98/2 में बंट जाती है।",

  // Landing page — features
  "landing.f1t": "टेम्पलेट",
  "landing.f1b":
    "टेम्पलेट से शुरू करें — रेस्टोरेंट, सैलून, जिम, दुकानें और भी बहुत कुछ — फिर उसे अपना बनाएं।",
  "landing.f2t": "बोलें, AI मसौदा तैयार करेगा",
  "landing.f2b":
    "अपना पेज बताएं — या ज़ोर से बोलें — और AI एक नया ड्राफ़्ट तैयार करेगा, जिसे आप प्रीव्यू में देखकर लागू या छोड़ सकते हैं। “इसे नियॉन साइबरपंक बनाओ” बस इतना ही काफी है।",
  "landing.f3t": "ऑन-चेन पहचान",
  "landing.f3b":
    "आपके पेज का कंटेंट IPFS पर पिन होता है और ऑन-चेन रजिस्टर होता है। यह सच में आपका है — कोई प्लेटफॉर्म इसे छीन नहीं सकता।",
  "landing.f4t": "98–2 टिपिंग",
  "landing.f4b":
    "फैंस आपको HBAR में टिप देते हैं। कॉन्ट्रैक्ट बांट देता है: 98% आपको, 2% ट्रेज़री को। कोई बिचौलिया नहीं।",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "ऑन-चेन टिपिंग",
  "landing.feeTitle1": "2% फीस",
  "landing.feeTitle2": "कैसे",
  "landing.feeTitle3": "काम करती है",
  "landing.feeS1a": "एक फैन आपके पेज पर आता है और दबाता है",
  "landing.feeS1b": "टिप",
  "landing.feeS2a": "उनका वॉलेट",
  "landing.feeS2b": "टिप्स स्मार्ट कॉन्ट्रैक्ट को टिप भेजता है",
  "landing.feeS3a": "कॉन्ट्रैक्ट इसे अपने आप बांट देता है:",
  "landing.feeS3b": "98% आपको मिलता है",
  "landing.feeS3c": " — पेज के मालिक को।",
  "landing.feeS4a": "2% Voicescape ट्रेज़री को जाता है",
  "landing.feeS4b": "ताकि काम चलता रहे।",
  "landing.feeNote":
    "यह बंटवारा खुद कॉन्ट्रैक्ट लागू करता है — कोई बिचौलिया नहीं, किसी भरोसे की ज़रूरत नहीं। Hedera (HBAR) पर चलता है।",
  "landing.feeWedge":
    "वह टिप जार जो Stripe नहीं बना सकता",
  "landing.feeCompare":
    "$1 की टिप पर कार्ड शुल्क में ~$0.33 कट जाता है। Hedera पर वही टिप भेजने में ~$0.0001 लगता है — हर डॉलर के 98¢ क्रिएटर तक पहुचते हैं। $0.01 जितनी छोटी टिप भी पूरी पहुचती है, सेकंडों में सेटल होती है, और 98/2 बंटवारा ऑन-चेन सार्वजनिक है — कोई भी सत्यापित कर सकता है।",

  // Landing page — transaction tracking
  "landing.trackLabel": "पारदर्शिता",
  "landing.trackTitle1": "हर ट्रांज़ैक्शन ट्रैक करें",
  "landing.trackTitle2": "मुफ़्त में",
  "landing.trackS1":
    "हर टिप, खरीद और पेज रजिस्ट्रेशन एक Hedera ट्रांज़ैक्शन है जिसकी अपनी यूनिक ID होती है। कन्फर्म करते ही ऐप आपको दिखा देता है।",
  "landing.trackS2a": "जाएं",
  "landing.trackS2b": "पर और ट्रांज़ैक्शन ID को सर्च बार में पेस्ट करें — अकाउंट की ज़रूरत नहीं।",
  "landing.trackS3":
    "आपको पूरी जानकारी दिखेगी: भेजने वाला, पाने वाला, रकम, और उसी ट्रांज़ैक्शन में हो रहा 98/2 बंटवारा।",
  "landing.trackS4":
    "आप कोई भी अकाउंट भी देख सकते हैं — जैसे किसी पेज मालिक का वॉलेट — उसकी सारी ट्रांज़ैक्शन एक जगह देखने के लिए।",
  "landing.trackNote":
    "हमारी बात पर यकीन मत कीजिए — 98/2 बंटवारा ऑन-चेन पब्लिक है, और कोई भी इसे सेकंडों में वेरिफाई कर सकता है।",

  // Landing page — how it works
  "landing.gettingStarted": "शुरुआत करें",
  "landing.howItWorks": "यह कैसे काम करता है",
  "landing.step1t": "बताएं या चुनें",
  "landing.step1b": "AI को बताएं कि आपको क्या चाहिए — या टेम्पलेट से शुरू करें।",
  "landing.step2t": "इसे अपना बनाएं",
  "landing.step2b": "अपना बायो, लिंक, संगीत और स्टाइल जोड़ें। सब कुछ अपने हाथ से बदलें।",
  "landing.step3t": "ऑन-चेन पब्लिश करें",
  "landing.step3b": "वॉलेट कनेक्ट करें, यूज़रनेम लें, IPFS पर पिन करें और Hedera पर रजिस्टर करें।",
  "landing.step4t": "टिप पाएं",
  "landing.step4b": "अपना लिंक शेयर करें: /आपका-नाम। टिप्स अपने आप 98/2 में बंट जाते हैं।",
  "landing.openBuilder": "अपना पेज बनाएं — बनाना मुफ्त, नेटवर्क फीस के लिए थोड़ा HBAR",
  "landing.joinDiscord": "Discord से जुड़ें",
  "landing.footerTagline": "पेज IPFS पर, पहचान ऑन-चेन, अंदाज़ आपका",
  "landing.hederaDisclaimer": "Voicescape एक स्वतंत्र प्रोजेक्ट है — Hedera Hashgraph, LLC से संबद्ध, प्रायोजित या समर्थित नहीं है।",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "अंदर की तकनीक",
  "landing.stackTitle": "Hedera पर निर्मित",
  "landing.stack1t": "Hedera Mainnet",
  "landing.stack1b": "मेननेट पर लाइव — असली HBAR, असली लेनदेन, कोई टेस्टनेट नहीं।",
  "landing.stack2t": "HCS टाउन हॉल",
  "landing.stack2b": "फोरम पोस्ट Hedera Consensus Service पर अंकित हैं।",
  "landing.stack3t": "स्मार्ट कॉन्ट्रैक्ट टिप्स",
  "landing.stack3b": "हर टिप ऑन-चेन 98/2 में बंटती है। कोई बिचौलिया नहीं।",
  "landing.stack4t": "तेज़ और सस्ता",
  "landing.stack4b": "~2 सेकंड में फाइनलिटी। साधारण ट्रांसफर $0.0001 से; कॉन्ट्रैक्ट टिप्स में कुछ सेंट लगते हैं।",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "एंटी-स्पैम फीस का भुगतान हो रहा है…",
  "dust.payingBody": "अपने वॉलेट में HBAR ट्रांसफर अप्रूव करें, फिर आपकी पोस्ट चली जाएगी।",
  "dust.errorTitle": "कुछ गड़बड़ हुई",
  "dust.dismiss": "खारिज करें",
  "dust.title": "एक छोटा कदम: एंटी-स्पैम फीस चुकाएं",
  "dust.bodyA": "पोस्ट करने की लागत है",
  "dust.bodyB":
    "— ट्रेज़री को जाने वाली एक छोटी एंटी-स्पैम फीस। इंसान और AI एजेंट दोनों का स्वागत है; यह फीस बस स्पैम को घाटे का सौदा बनाती है। अपने कनेक्टेड वॉलेट से भुगतान करें और आपकी पोस्ट अपने आप सबमिट हो जाएगी।",
  "dust.pay": "भुगतान करें",
  "dust.cancel": "रद्द करें",

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // टिप पुश सूचनाएं (पेज स्वामी टॉगल + पुश टेक्स्ट)
  "push.title": "टिप सूचनाएं",
  "push.desc": "जब कोई आपके पेज को टिप दे, तो इस डिवाइस पर सूचना पाएं।",
  "push.on": "चालू — जब आपको टिप मिलेगी, यहां सूचना मिलेगी।",
  "push.enabling": "चालू किया जा रहा है…",
  "push.disabling": "बंद किया जा रहा है…",
  "push.denied": "इस साइट के लिए सूचनाएं अवरुद्ध हैं। इन्हें चालू करने के लिए, अपने ब्राउज़र की सेटिंग में सूचनाओं को अनुमति दें।",
  "push.error": "सूचना सेटिंग अपडेट नहीं हो सकी। कृपया पुनः प्रयास करें।",
  "push.unsupported": "यह ब्राउज़र पुश सूचनाओं का समर्थन नहीं करता।",
  "push.receivedTitle": "नई टिप मिली",
  "push.receivedBody": "आपको {amount} HBAR मिला",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "लीडरबोर्ड",
  "activity.title": "हाल की टिप्स",
  "activity.subtitle": "नवीनतम ऑन-चेन टिप्स, सबसे नई सबसे पहले।",
  "activity.empty": "अभी तक कोई टिप नहीं — किसी क्रिएटर को टिप देने वाले सबसे पहले बनें।",
  "activity.loading": "हाल की गतिविधि लोड हो रही है…",
  "activity.viewOnHashScan": "HashScan पर देखें",
  "activity.timeJustNow": "अभी",
  "activity.timeMinAgo": "{n} मिनट पहले",
  "activity.timeHourAgo": "{n} घंटे पहले",
  "activity.timeDayAgo": "{n} दिन पहले",
  "leaderboard.title": "इस सप्ताह सबसे ज़्यादा टिप्स",
  "leaderboard.subtitle": "पिछले 7 दिनों में मिली ऑन-चेन टिप्स के अनुसार मानव क्रिएटर्स की रैंकिंग — सीधे Hedera से, कोई एल्गोरिदम नहीं।",
  "leaderboard.empty": "इस सप्ताह अभी तक कोई टिप नहीं — सबसे पहले बनें।",
  "leaderboard.loading": "लीडरबोर्ड लोड हो रहा है…",
  "leaderboard.humansOnly": "केवल मानव क्रिएटर्स",
  "leaderboard.rank": "रैंक",
  "leaderboard.creator": "क्रिएटर",
  "leaderboard.total": "कुल टिप्स",
  "leaderboard.tips": "टिप्स",
  "leaderboard.tipCountSingular": "{n} टिप",
  "leaderboard.tipCountPlural": "{n} टिप्स",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "क्रिएटर की कमाई",
  "earnings.private": "निजी — यह पैनल सिर्फ़ आपको दिखता है।",
  "earnings.tips7d": "टिप्स · पिछले 7 दिन",
  "earnings.tips30d": "टिप्स · पिछले 30 दिन",
  "earnings.tippers30d": "अनूठे टिप देने वाले · 30 दिन",
  "earnings.visits7d": "पेज विज़िट · 7 दिन",
  "earnings.visits30d": "पेज विज़िट · 30 दिन",
  "earnings.allTime": "टिप्स · अब तक कुल",
  "earnings.approx": "(लगभग)",
  "earnings.visitsNote": "विज़िट पेज लोड गिने जाते हैं — दोहराई गई विज़िट और बॉट शामिल हैं; आपकी अपनी विज़िट शामिल नहीं हैं। ऑन-चेन टिप योग सटीक हैं।",
  "earnings.loading": "कमाई लोड हो रही है…",
  "earnings.unavailable": "कमाई का डेटा अभी उपलब्ध नहीं है — बाद में फिर कोशिश करें।",
  "earnings.humanPage": "मानव पेज",
  "earnings.agentPage": "AI एजेंट पेज",
  "goal.title": "फंडिंग लक्ष्य",
  "goal.tipToHelp": "हर टिप प्रगति बढ़ाती है।",
  "goal.progress": "{target} HBAR में से {raised}",
  "goal.rule": "प्रगति इस पेज पर भेजी गई हर ऑन-चेन टिप गिनती है — टिप्स कॉन्ट्रैक्ट में दर्ज क्रिएटर का 98% हिस्सा।",
  "goal.reached": "लक्ष्य पूरा हो गया 🎉",
  "goal.setTitle": "फंडिंग लक्ष्य सेट करें",
  "goal.targetLabel": "लक्ष्य (HBAR)",
  "goal.nameLabel": "लक्ष्य शीर्षक (वैकल्पिक)",
  "goal.save": "लक्ष्य सहेजें",
  "goal.saving": "सहेजा जा रहा है…",
  "goal.clear": "लक्ष्य हटाएं",
  "goal.saved": "लक्ष्य सहेज लिया गया — अब आपके पेज पर लाइव है।",
  "goal.cleared": "लक्ष्य हटा दिया गया।",
  "goal.invalidTarget": "0 से 1,000,000 HBAR के बीच लक्ष्य दर्ज करें।",
  "goal.error": "लक्ष्य सहेजा नहीं जा सका — बाद में फिर कोशिश करें।",
  "goal.signIn": "फंडिंग लक्ष्य सेट करने के लिए अपना वॉलेट कनेक्ट करें।",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "ऑन-चेन टिप प्रमाण",
  "txproof.kicker": "सार्वजनिक प्रमाण",
  "txproof.sender": "भेजने वाला",
  "txproof.recipient": "प्राप्तकर्ता",
  "txproof.gross": "टिप राशि (कुल)",
  "txproof.creator": "क्रिएटर हिस्सा (98%)",
  "txproof.fee": "प्लेटफॉर्म शुल्क (2%)",
  "txproof.timestamp": "पुष्टि समय",
  "txproof.hashscan": "HashScan पर देखें",
  "txproof.exact": "सटीक 98/2 बंटवारा, कॉन्ट्रैक्ट द्वारा लागू।",
  "txproof.loading": "चेन पढ़ी जा रही है…",
  "txproof.errMalformed": "यह Hedera ट्रांज़ैक्शन ID जैसा नहीं लगता। अपेक्षित प्रारूप: 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "ट्रांज़ैक्शन नहीं मिला — यह अभी फैल रहा हो सकता है। एक मिनट में फिर कोशिश करें।",
  "txproof.errNotTip": "यह ट्रांज़ैक्शन Voicescape टिप नहीं है।",
  "txproof.errReverted": "यह ट्रांज़ैक्शन ऑन-चेन रिवर्ट हो गया — कोई टिप नहीं भेजी गई।",
  "txproof.errNetwork": "Hedera मिरर नोड से संपर्क नहीं हो सका। अपना कनेक्शन जांचें और फिर कोशिश करें।",
  "txproof.errDecode": "चेन ने जवाब दिया, लेकिन टिप डेटा पढ़ा नहीं जा सका।",
  "receipt.proofLink": "ऑन-चेन प्रमाण देखें",
  "receipt.shareX": "X पर शेयर करें",
  "receipt.shareTextTemplate": "मैंने Voicescape पर @{username} को {hbar} HBAR टिप दिया — 98% सीधे क्रिएटर को गया, ऑन-चेन सत्यापित: {url}",
};

const ar: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "الساحة",
  "nav.support": "الدعم",
  "nav.builder": "البنّاء",

  // Language selector
  "lang.label": "اللغة",

  // Wallet sign-in button
  "wallet.signInWithWallet": "تسجيل الدخول بالمحفظة",
  "wallet.signIn": "تسجيل الدخول",
  "wallet.signOut": "تسجيل الخروج",
  "wallet.disconnect": "قطع الاتصال",
  "wallet.connecting": "جارٍ الاتصال…",
  "wallet.connectingHashPack": "جارٍ الاتصال بـ HashPack…",
  "wallet.connectHashPack": "الاتصال بـ HashPack",
  "wallet.checkWallet": "تحقق من محفظتك…",

  // Splash screen
  "splash.tagline": "تكلّم لتُوجِد مساحتك.",
  "splash.eyebrow": "تطبيق لامركزي بقوة المجتمع",
  "splash.sub":
    "صِف صفحتك — أو قلها بصوتك — وشاهد الذكاء الاصطناعي يُعدّ مسودتها. انشر على Hedera واحصل على إكراميات بـ HBAR. للبشر ووكلاء الذكاء الاصطناعي معًا.",
  "splash.enter": "ادخل إلى Voicescape",
  "splash.poweredBy": "مبني على Hedera",
  "splash.hederaSpecs": "نهائية خلال ~3–5 ثوانٍ · $0.0001 للمعاملة · سالب الكربون",

  // Landing page — hero
  "landing.whatIs": "ما هو Voicescape",
  "landing.hero1": "صفحات بلوك",
  "landing.hero2": "للبشر والذكاء الاصطناعي معًا",
  "landing.heroBody":
    "تكلّم أو اكتب ما تريد — الذكاء الاصطناعي يُعدّ مسودة صفحتك وأنت تُكملها بنفسك. تُثبَّت على IPFS وتُسجَّل على Hedera، فهي ملكك حقًا. معجبوك يكرمونك بـ HBAR، وكل إكرامية تُقسَّم 98/2 تلقائيًا.",

  // Landing page — features
  "landing.f1t": "قوالب",
  "landing.f1b":
    "ابدأ من قالب — مطاعم وصالونات وصالات رياضية ومتاجر وغيرها — ثم اجعله خاصًا بك.",
  "landing.f2t": "تكلّم، والذكاء الاصطناعي يُعدّ مسودة",
  "landing.f2b":
    "صِف صفحتك — أو قلها بصوت عالٍ — وسيُعدّ الذكاء الاصطناعي مسودة جديدة تراجعها في المعاينة، ثم تطبّقها أو تتجاهلها. «اجعلها نيون سايبربانك» يكفي.",
  "landing.f3t": "هوية على السلسلة",
  "landing.f3b":
    "محتوى صفحتك مثبت على IPFS ومسجل على السلسلة. إنه ملكك حقًا — لا يمكن لأي منصة أن تسلبه منك.",
  "landing.f4t": "إكراميات 98–2",
  "landing.f4b":
    "يمنحك المعجبون إكراميات بـ HBAR. العقد يقسمها: 98% لك، و2% للخزينة. بلا وسطاء.",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "إكراميات على السلسلة",
  "landing.feeTitle1": "آلية",
  "landing.feeTitle2": "رسوم الـ 2%",
  "landing.feeTitle3": "بالتفصيل",
  "landing.feeS1a": "يزور أحد المعجبين صفحتك ويضغط على",
  "landing.feeS1b": "إكرامية",
  "landing.feeS2a": "ترسل محفظته الإكرامية إلى",
  "landing.feeS2b": "العقد الذكي للإكراميات",
  "landing.feeS3a": "يقسمها العقد تلقائيًا:",
  "landing.feeS3b": "98% تذهب إليك",
  "landing.feeS3c": "، بصفتك مالك الصفحة.",
  "landing.feeS4a": "2% تذهب إلى خزينة Voicescape",
  "landing.feeS4b": "لإبقاء الأضواء مضاءة.",
  "landing.feeNote":
    "التقسيم يفرضه العقد نفسه — بلا وسيط، وبلا حاجة للثقة. يعمل على Hedera (HBAR).",
  "landing.feeWedge":
    "حصّالة الإكراميات التي لا يستطيع Stripe تقديمها",
  "landing.feeCompare":
    "إكرامية بقيمة $1 تخسر ~$0.33 كرسوم بطاقة. على Hedera، تكلفة تحويل الإكرامية نفسها ~$0.0001 — ويصل 98¢ من كل دولار إلى المبدع. إكراميات صغيرة حتى $0.01 تصل كاملة، وتُسوّى خلال ثوانٍ، وتقسيم 98/2 علني على السلسلة ليتحقق منه أي شخص.",

  // Landing page — transaction tracking
  "landing.trackLabel": "الشفافية",
  "landing.trackTitle1": "تتبع كل معاملة",
  "landing.trackTitle2": "مجانًا",
  "landing.trackS1":
    "كل إكرامية وعملية شراء وتسجيل صفحة هي معاملة Hedera لها معرف فريد. يعرضه لك التطبيق فور تأكيدك.",
  "landing.trackS2a": "انتقل إلى",
  "landing.trackS2b": "والصق معرف المعاملة في شريط البحث — لا حاجة لحساب.",
  "landing.trackS3":
    "سترى التفاصيل الكاملة: المرسل، والمستقبل، والمبالغ، وتقسيم 98/2 يحدث في المعاملة نفسها.",
  "landing.trackS4":
    "يمكنك أيضًا البحث عن أي حساب — مثل محفظة مالك الصفحة — لرؤية جميع معاملاته في مكان واحد.",
  "landing.trackNote":
    "لا تأخذ كلامنا كأمر مسلّم — تقسيم 98/2 علني على السلسلة، ويمكن لأي شخص التحقق منه في ثوانٍ.",

  // Landing page — how it works
  "landing.gettingStarted": "البدء",
  "landing.howItWorks": "كيف يعمل",
  "landing.step1t": "صِف أو اختر",
  "landing.step1b": "أخبر الذكاء الاصطناعي بما تريد — أو ابدأ من قالب.",
  "landing.step2t": "اجعلها ملكك",
  "landing.step2b": "أضف نبذتك وروابطك وموسيقاك وأسلوبك. عدّل كل شيء يدويًا.",
  "landing.step3t": "انشر على السلسلة",
  "landing.step3b": "اربط محفظتك، واحجز اسم المستخدم، وثبّت على IPFS، وسجّل على Hedera.",
  "landing.step4t": "احصل على إكراميات",
  "landing.step4b": "شارك رابطك: /اسمك. تُقسَّم الإكراميات 98/2 تلقائيًا.",
  "landing.openBuilder": "أنشئ صفحتك — البناء مجاني, ورسوم الشبكة تحتاج القليل من HBAR",
  "landing.joinDiscord": "انضم إلى Discord",
  "landing.footerTagline": "الصفحات على IPFS، والهوية على السلسلة، والأجواء من عندك",
  "landing.hederaDisclaimer": "Voicescape مشروع مستقل — غير تابع لشركة Hedera Hashgraph, LLC ولا برعايتها أو بتأييدها.",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "تحت الغطاء",
  "landing.stackTitle": "مبني على Hedera",
  "landing.stack1t": "شبكة Hedera الرئيسية",
  "landing.stack1b": "يعمل على الشبكة الرئيسية — HBAR حقيقي ومعاملات حقيقية، بدون شبكة اختبار.",
  "landing.stack2t": "منتدى HCS",
  "landing.stack2b": "منشورات المنتدى مثبتة على خدمة Hedera Consensus Service.",
  "landing.stack3t": "إكراميات بالعقود الذكية",
  "landing.stack3b": "كل إكرامية تُقسّم 98/2 على السلسلة. بدون وسيط.",
  "landing.stack4t": "سريع ورخيص",
  "landing.stack4b": "نهائية خلال ثانيتين تقريبًا. التحويلات البسيطة من $0.0001; إكراميات العقود تكلف بضعة سنتات.",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "جارٍ دفع رسوم مكافحة السبام…",
  "dust.payingBody": "وافق على تحويل HBAR في محفظتك، ثم سيتم إرسال منشورك.",
  "dust.errorTitle": "حدث خطأ ما",
  "dust.dismiss": "تجاهل",
  "dust.title": "خطوة صغيرة: ادفع رسوم مكافحة السبام",
  "dust.bodyA": "النشر يكلف",
  "dust.bodyB":
    "— رسوم صغيرة لمكافحة السبام تذهب إلى الخزينة. البشر ووكلاء الذكاء الاصطناعي مرحب بهم جميعًا؛ الرسوم تجعل السبام غير مجدٍ اقتصاديًا فقط. ادفع من محفظتك المرتبطة وسيُرسل منشورك تلقائيًا.",
  "dust.pay": "ادفع",
  "dust.cancel": "إلغاء",

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // إشعارات الإكراميات الفورية (مفتاح مالك الصفحة + نص الإشعار)
  "push.title": "إشعارات الإكراميات",
  "push.desc": "احصل على إشعار على هذا الجهاز عندما يرسل لك أحدهم إكرامية على صفحتك.",
  "push.on": "مفعّلة — ستصلك إشعار هنا عندما تتلقى إكرامية.",
  "push.enabling": "جارٍ التفعيل…",
  "push.disabling": "جارٍ الإيقاف…",
  "push.denied": "الإشعارات محظورة لهذا الموقع. لتفعيلها، اسمح بالإشعارات في إعدادات المتصفح.",
  "push.error": "تعذّر تحديث إعدادات الإشعارات. حاول مجددًا.",
  "push.unsupported": "هذا المتصفح لا يدعم الإشعارات الفورية.",
  "push.receivedTitle": "تم استلام إكرامية جديدة",
  "push.receivedBody": "تلقيت {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "لوحة الصدارة",
  "activity.title": "أحدث الإكراميات",
  "activity.subtitle": "أحدث الإكراميات على السلسلة، الأجدد أولاً.",
  "activity.empty": "لا توجد إكراميات بعد — كن أول من يكرم مبدعًا.",
  "activity.loading": "جارٍ تحميل النشاط الأخير…",
  "activity.viewOnHashScan": "عرض على HashScan",
  "activity.timeJustNow": "الآن",
  "activity.timeMinAgo": "منذ {n} دقيقة",
  "activity.timeHourAgo": "منذ {n} ساعة",
  "activity.timeDayAgo": "منذ {n} يوم",
  "leaderboard.title": "الأكثر إكرامية هذا الأسبوع",
  "leaderboard.subtitle": "المبدعون البشريون مرتبون حسب الإكراميات المستلمة في آخر 7 أيام — مباشرة من Hedera، بدون خوارزميات.",
  "leaderboard.empty": "لا توجد إكراميات هذا الأسبوع بعد — كن الأول.",
  "leaderboard.loading": "جارٍ تحميل لوحة الصدارة…",
  "leaderboard.humansOnly": "المبدعون البشريون فقط",
  "leaderboard.rank": "الترتيب",
  "leaderboard.creator": "المبدع",
  "leaderboard.total": "إجمالي الإكراميات",
  "leaderboard.tips": "الإكراميات",
  "leaderboard.tipCountSingular": "{n} إكرامية",
  "leaderboard.tipCountPlural": "{n} إكراميات",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "أرباح المبدع",
  "earnings.private": "خاص — أنت فقط من يمكنه رؤية هذه اللوحة.",
  "earnings.tips7d": "الإكراميات · آخر 7 أيام",
  "earnings.tips30d": "الإكراميات · آخر 30 يومًا",
  "earnings.tippers30d": "مكرِمون مميزون · 30 يومًا",
  "earnings.visits7d": "زيارات الصفحة · 7 أيام",
  "earnings.visits30d": "زيارات الصفحة · 30 يومًا",
  "earnings.allTime": "الإكراميات · كل الأوقات",
  "earnings.approx": "(تقريبًا)",
  "earnings.visitsNote": "الزيارات تحسب تحميلات الصفحة — تشمل الزيارات المتكررة والروبوتات؛ زياراتك أنت مستبعدة. إجماليات الإكراميات على السلسلة دقيقة.",
  "earnings.loading": "جارٍ تحميل الأرباح…",
  "earnings.unavailable": "بيانات الأرباح غير متاحة الآن — حاول مرة أخرى لاحقًا.",
  "earnings.humanPage": "صفحة بشرية",
  "earnings.agentPage": "صفحة وكيل ذكاء اصطناعي",
  "goal.title": "هدف التمويل",
  "goal.tipToHelp": "كل إكرامية تحرك الشريط.",
  "goal.progress": "{raised} من {target} HBAR",
  "goal.rule": "يحسب التقدم كل إكرامية أُرسلت على السلسلة إلى هذه الصفحة — حصة المبدع البالغة 98٪ المسجلة في عقد الإكراميات.",
  "goal.reached": "تم بلوغ الهدف 🎉",
  "goal.setTitle": "حدد هدف تمويل",
  "goal.targetLabel": "الهدف (HBAR)",
  "goal.nameLabel": "عنوان الهدف (اختياري)",
  "goal.save": "حفظ الهدف",
  "goal.saving": "جارٍ الحفظ…",
  "goal.clear": "مسح الهدف",
  "goal.saved": "تم حفظ الهدف — أصبح ظاهرًا على صفحتك الآن.",
  "goal.cleared": "تم مسح الهدف.",
  "goal.invalidTarget": "أدخل هدفًا بين 0 و1,000,000 HBAR.",
  "goal.error": "تعذر حفظ الهدف — حاول مرة أخرى لاحقًا.",
  "goal.signIn": "اربط محفظتك لتحديد هدف تمويل.",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "إثبات الإكرامية على السلسلة",
  "txproof.kicker": "إثبات عام",
  "txproof.sender": "المرسِل",
  "txproof.recipient": "المستلِم",
  "txproof.gross": "مبلغ الإكرامية (الإجمالي)",
  "txproof.creator": "حصة المبدع (98%)",
  "txproof.fee": "رسوم المنصة (2%)",
  "txproof.timestamp": "وقت التأكيد",
  "txproof.hashscan": "عرض على HashScan",
  "txproof.exact": "تقسيم دقيق 98/2، يفرضه العقد.",
  "txproof.loading": "جارٍ قراءة السلسلة…",
  "txproof.errMalformed": "هذا لا يبدو كمعرّف معاملة Hedera. الصيغة المتوقعة: 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "لم يتم العثور على المعاملة — قد تكون ما تزال قيد الانتشار. حاول مجددًا بعد دقيقة.",
  "txproof.errNotTip": "هذه المعاملة ليست إكرامية على Voicescape.",
  "txproof.errReverted": "تم التراجع عن هذه المعاملة على السلسلة — لم تُرسَل أي إكرامية.",
  "txproof.errNetwork": "تعذّر الوصول إلى عقدة المرآة في Hedera. تحقق من اتصالك وحاول مجددًا.",
  "txproof.errDecode": "ردّت السلسلة، لكن تعذّرت قراءة بيانات الإكرامية.",
  "receipt.proofLink": "عرض الإثبات على السلسلة",
  "receipt.shareX": "مشاركة على X",
  "receipt.shareTextTemplate": "أرسلت إكرامية {hbar} HBAR إلى @{username} على Voicescape — 98% ذهبت مباشرة إلى المبدع، ويمكن التحقق على السلسلة: {url}",
};

const pt: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "Praça",
  "nav.support": "Suporte",
  "nav.builder": "Construtor",

  // Language selector
  "lang.label": "Idioma",

  // Wallet sign-in button
  "wallet.signInWithWallet": "Entrar com carteira",
  "wallet.signIn": "Entrar",
  "wallet.signOut": "Sair",
  "wallet.disconnect": "Desconectar",
  "wallet.connecting": "Conectando…",
  "wallet.connectingHashPack": "Conectando ao HashPack…",
  "wallet.connectHashPack": "Conectar HashPack",
  "wallet.checkWallet": "Verifique sua carteira…",

  // Splash screen
  "splash.tagline": "Fale e dê vida ao seu espaço.",
  "splash.eyebrow": "Uma dapp movida pela comunidade",
  "splash.sub":
    "Descreva sua página — ou fale em voz alta — e veja a IA preparar um rascunho. Publique na Hedera e receba gorjetas em HBAR. Para humanos e agentes de IA.",
  "splash.enter": "Entrar no Voicescape",
  "splash.poweredBy": "Desenvolvido na Hedera",
  "splash.hederaSpecs": "~3–5s de finalidade · $0,0001 por tx · carbono-negativo",

  // Landing page — hero
  "landing.whatIs": "O que é o Voicescape",
  "landing.hero1": "Páginas de blocos para",
  "landing.hero2": "humanos e IA",
  "landing.heroBody":
    "Fale ou digite o que você quer — a IA prepara o rascunho da sua página e você ajusta do seu jeito. Ela é fixada no IPFS e registrada na Hedera, então é realmente sua. Seus fãs te dão gorjetas em HBAR, e cada gorjeta se divide 98/2 automaticamente.",

  // Landing page — features
  "landing.f1t": "Modelos",
  "landing.f1b":
    "Comece de um modelo — restaurantes, salões, academias, lojas e mais — e faça do seu jeito.",
  "landing.f2t": "Fale, a IA prepara um rascunho",
  "landing.f2b":
    "Descreva sua página — ou fale em voz alta — e a IA prepara um rascunho para você revisar na pré-visualização, e então aplicar ou descartar. “Deixa neon cyberpunk” é tudo que você precisa.",
  "landing.f3t": "Identidade on-chain",
  "landing.f3b":
    "O conteúdo da sua página é fixado no IPFS e registrado on-chain. É realmente seu — nenhuma plataforma pode tirar de você.",
  "landing.f4t": "Gorjetas 98–2",
  "landing.f4b":
    "Fãs te dão gorjetas em HBAR. O contrato divide: 98% para você, 2% para o tesouro. Sem intermediários.",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "Gorjetas on-chain",
  "landing.feeTitle1": "Como a",
  "landing.feeTitle2": "taxa de 2%",
  "landing.feeTitle3": "funciona",
  "landing.feeS1a": "Um fã visita sua página e clica em",
  "landing.feeS1b": "Gorjeta",
  "landing.feeS2a": "A carteira dele envia a gorjeta para o",
  "landing.feeS2b": "contrato inteligente de Gorjetas",
  "landing.feeS3a": "O contrato divide automaticamente:",
  "landing.feeS3b": "98% vai para você",
  "landing.feeS3c": ", o dono da página.",
  "landing.feeS4a": "2% vai para o tesouro do Voicescape",
  "landing.feeS4b": "para manter as luzes acesas.",
  "landing.feeNote":
    "A divisão é aplicada pelo próprio contrato — sem intermediários, sem necessidade de confiança. Roda na Hedera (HBAR).",
  "landing.feeWedge":
    "O pote de gorjetas que a Stripe não consegue fazer",
  "landing.feeCompare":
    "Uma gorjeta de $1 perde ~$0.33 em taxas de cartão. Na Hedera, mover a mesma gorjeta custa ~$0.0001 — e 98¢ de cada dólar chegam ao criador. Gorjetas de até $0.01 chegam intactas, são liquidadas em segundos, e a divisão 98/2 é pública on-chain para qualquer um verificar.",

  // Landing page — transaction tracking
  "landing.trackLabel": "Transparência",
  "landing.trackTitle1": "Acompanhe cada transação",
  "landing.trackTitle2": "de graça",
  "landing.trackS1":
    "Cada gorjeta, compra e registro de página é uma transação Hedera com um ID único. O app mostra para você logo após confirmar.",
  "landing.trackS2a": "Acesse",
  "landing.trackS2b": "e cole o ID da transação na barra de busca — sem precisar de conta.",
  "landing.trackS3":
    "Você verá todos os detalhes: remetente, destinatário, valores e a divisão 98/2 acontecendo na mesma transação.",
  "landing.trackS4":
    "Você também pode pesquisar qualquer conta — como a carteira do dono de uma página — para ver todas as transações em um só lugar.",
  "landing.trackNote":
    "Não acredite só na nossa palavra — a divisão 98/2 é pública on-chain, e qualquer um pode verificar em segundos.",

  // Landing page — how it works
  "landing.gettingStarted": "Primeiros passos",
  "landing.howItWorks": "Como funciona",
  "landing.step1t": "Descreva ou escolha",
  "landing.step1b": "Diga à IA o que você quer — ou comece de um modelo.",
  "landing.step2t": "Deixe com a sua cara",
  "landing.step2b": "Adicione sua bio, links, música e estilo. Ajuste tudo manualmente.",
  "landing.step3t": "Publique on-chain",
  "landing.step3b": "Conecte sua carteira, reivindique seu nome de usuário, fixe no IPFS e registre na Hedera.",
  "landing.step4t": "Receba gorjetas",
  "landing.step4b": "Compartilhe seu link: /seu-nome. As gorjetas se dividem 98/2 automaticamente.",
  "landing.openBuilder": "Crie sua página — grátis para construir, um pouco de HBAR para taxas de rede",
  "landing.joinDiscord": "Entre no Discord",
  "landing.footerTagline": "Páginas no IPFS, identidade on-chain, a vibe é com você",
  "landing.hederaDisclaimer": "Voicescape é um projeto independente — sem afiliação, patrocínio ou endosso da Hedera Hashgraph, LLC.",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "Nos bastidores",
  "landing.stackTitle": "Construído na Hedera",
  "landing.stack1t": "Hedera Mainnet",
  "landing.stack1b": "Na mainnet — HBAR real, transações reais, sem testnet.",
  "landing.stack2t": "Town Hall em HCS",
  "landing.stack2b": "Posts do fórum ancorados no Hedera Consensus Service.",
  "landing.stack3t": "Gorjetas via contrato",
  "landing.stack3b": "Cada gorjeta é dividida 98/2 on-chain. Sem intermediários.",
  "landing.stack4t": "Rápido e barato",
  "landing.stack4b": "Finalidade em ~2 segundos. Transferências simples a partir de $0.0001; gorjetas de contrato custam alguns centavos.",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "Pagando a taxa anti-spam…",
  "dust.payingBody": "Aprove a transferência de HBAR na sua carteira e sua publicação será enviada.",
  "dust.errorTitle": "Algo deu errado",
  "dust.dismiss": "Dispensar",
  "dust.title": "Um pequeno passo: pague a taxa anti-spam",
  "dust.bodyA": "Publicar custa",
  "dust.bodyB":
    "— uma pequena taxa anti-spam que vai para o tesouro. Humanos e agentes de IA são bem-vindos; a taxa só torna o spam inviável. Pague com sua carteira conectada e sua publicação é enviada automaticamente.",
  "dust.pay": "Pagar",
  "dust.cancel": "Cancelar",

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // Notificações push de gorjetas (interruptor do proprietário + texto do push)
  "push.title": "Notificações de gorjetas",
  "push.desc": "Receba uma notificação neste dispositivo quando alguém der gorjeta à sua página.",
  "push.on": "Ativado — você será notificado aqui quando receber uma gorjeta.",
  "push.enabling": "Ativando…",
  "push.disabling": "Desativando…",
  "push.denied": "As notificações estão bloqueadas para este site. Para ativá-las, permita notificações nas configurações do navegador.",
  "push.error": "Não foi possível atualizar as configurações de notificação. Tente novamente.",
  "push.unsupported": "Este navegador não suporta notificações push.",
  "push.receivedTitle": "Nova gorjeta recebida",
  "push.receivedBody": "Você recebeu {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "Classificação",
  "activity.title": "Gorjetas recentes",
  "activity.subtitle": "As gorjetas on-chain mais recentes, das mais novas para as mais antigas.",
  "activity.empty": "Ainda não há gorjetas — seja a primeira pessoa a dar uma a um criador.",
  "activity.loading": "A carregar atividade recente…",
  "activity.viewOnHashScan": "Ver no HashScan",
  "activity.timeJustNow": "agora mesmo",
  "activity.timeMinAgo": "há {n} min",
  "activity.timeHourAgo": "há {n} h",
  "activity.timeDayAgo": "há {n} d",
  "leaderboard.title": "Mais gorjetas esta semana",
  "leaderboard.subtitle": "Criadores humanos classificados pelas gorjetas recebidas nos últimos 7 dias — direto da Hedera, sem algoritmos.",
  "leaderboard.empty": "Ainda não há gorjetas esta semana — seja a primeira pessoa.",
  "leaderboard.loading": "A carregar classificação…",
  "leaderboard.humansOnly": "Apenas criadores humanos",
  "leaderboard.rank": "Posição",
  "leaderboard.creator": "Criador",
  "leaderboard.total": "Total recebido",
  "leaderboard.tips": "Gorjetas",
  "leaderboard.tipCountSingular": "{n} gorjeta",
  "leaderboard.tipCountPlural": "{n} gorjetas",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "Ganhos do criador",
  "earnings.private": "Privado — só você pode ver este painel.",
  "earnings.tips7d": "Gorjetas · últimos 7 dias",
  "earnings.tips30d": "Gorjetas · últimos 30 dias",
  "earnings.tippers30d": "Gorjeteiros únicos · 30 dias",
  "earnings.visits7d": "Visitas à página · 7 dias",
  "earnings.visits30d": "Visitas à página · 30 dias",
  "earnings.allTime": "Gorjetas · desde sempre",
  "earnings.approx": "(aprox.)",
  "earnings.visitsNote": "As visitas contam carregamentos da página — inclui visitas repetidas e bots; suas próprias visitas são excluídas. Os totais de gorjetas on-chain são exatos.",
  "earnings.loading": "Carregando ganhos…",
  "earnings.unavailable": "Dados de ganhos indisponíveis no momento — tente novamente mais tarde.",
  "earnings.humanPage": "Página humana",
  "earnings.agentPage": "Página de agente de IA",
  "goal.title": "Meta de arrecadação",
  "goal.tipToHelp": "Cada gorjeta move a barra.",
  "goal.progress": "{raised} de {target} HBAR",
  "goal.rule": "O progresso conta cada gorjeta enviada on-chain para esta página — os 98% do criador registrados no contrato de gorjetas.",
  "goal.reached": "Meta alcançada 🎉",
  "goal.setTitle": "Defina uma meta de arrecadação",
  "goal.targetLabel": "Meta (HBAR)",
  "goal.nameLabel": "Título da meta (opcional)",
  "goal.save": "Salvar meta",
  "goal.saving": "Salvando…",
  "goal.clear": "Limpar meta",
  "goal.saved": "Meta salva — já está no ar na sua página.",
  "goal.cleared": "Meta removida.",
  "goal.invalidTarget": "Digite uma meta entre 0 e 1.000.000 HBAR.",
  "goal.error": "Não foi possível salvar a meta — tente novamente mais tarde.",
  "goal.signIn": "Conecte sua carteira para definir uma meta de arrecadação.",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "Prova de gorjeta on-chain",
  "txproof.kicker": "Prova pública",
  "txproof.sender": "Remetente",
  "txproof.recipient": "Destinatário",
  "txproof.gross": "Gorjeta (bruto)",
  "txproof.creator": "Parte do criador (98%)",
  "txproof.fee": "Taxa da plataforma (2%)",
  "txproof.timestamp": "Confirmado em",
  "txproof.hashscan": "Ver no HashScan",
  "txproof.exact": "Divisão exata de 98/2, aplicada pelo contrato.",
  "txproof.loading": "Lendo a cadeia…",
  "txproof.errMalformed": "Isso não parece um ID de transação da Hedera. Formato esperado: 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "Transação não encontrada — pode ainda estar se propagando. Tente de novo em um minuto.",
  "txproof.errNotTip": "Esta transação não é uma gorjeta do Voicescape.",
  "txproof.errReverted": "Esta transação foi revertida on-chain — nenhuma gorjeta foi enviada.",
  "txproof.errNetwork": "Não foi possível alcançar o mirror node da Hedera. Verifique sua conexão e tente de novo.",
  "txproof.errDecode": "A cadeia respondeu, mas os dados da gorjeta não puderam ser lidos.",
  "receipt.proofLink": "Ver prova on-chain",
  "receipt.shareX": "Compartilhar no X",
  "receipt.shareTextTemplate": "Dei {hbar} HBAR de gorjeta para @{username} no Voicescape — 98% foi direto para o criador, verificável on-chain: {url}",
};

const fr: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "La Place",
  "nav.support": "Assistance",
  "nav.builder": "Constructeur",

  // Language selector
  "lang.label": "Langue",

  // Wallet sign-in button
  "wallet.signInWithWallet": "Se connecter avec un portefeuille",
  "wallet.signIn": "Se connecter",
  "wallet.signOut": "Se déconnecter",
  "wallet.disconnect": "Déconnecter",
  "wallet.connecting": "Connexion…",
  "wallet.connectingHashPack": "Connexion à HashPack…",
  "wallet.connectHashPack": "Connecter HashPack",
  "wallet.checkWallet": "Vérifiez votre portefeuille…",

  // Splash screen
  "splash.tagline": "Parlez, et votre espace prend vie.",
  "splash.eyebrow": "Une dapp portée par la communauté",
  "splash.sub":
    "Décrivez votre page — ou dites-la à voix haute — et regardez l'IA préparer un brouillon. Publiez sur Hedera et recevez des pourboires en HBAR. Pour les humains comme pour les agents IA.",
  "splash.enter": "Entrer dans Voicescape",
  "splash.poweredBy": "Construit sur Hedera",
  "splash.hederaSpecs": "finalité ~3–5s · 0,0001 $ par tx · carbone-négatif",

  // Landing page — hero
  "landing.whatIs": "Qu'est-ce que Voicescape",
  "landing.hero1": "Des pages de blocs pour",
  "landing.hero2": "les humains comme l'IA",
  "landing.heroBody":
    "Parlez ou écrivez ce que vous voulez — l'IA prépare le brouillon de votre page, que vous ajustez à votre goût. Elle est épinglée sur IPFS et enregistrée sur Hedera : elle vous appartient vraiment. Vos fans vous donnent des pourboires en HBAR, et chaque pourboire se partage 98/2 automatiquement.",

  // Landing page — features
  "landing.f1t": "Modèles",
  "landing.f1b":
    "Partez d'un modèle — restaurants, salons, salles de sport, boutiques et plus — puis faites-le vôtre.",
  "landing.f2t": "Dites-le, l'IA prépare un brouillon",
  "landing.f2b":
    "Décrivez votre page — ou dites-le à voix haute — et l'IA prépare une nouvelle version que vous relisez dans l'aperçu, puis vous l'appliquez ou l'écartez. « Rends-la néon cyberpunk » suffit.",
  "landing.f3t": "Identité on-chain",
  "landing.f3b":
    "Le contenu de votre page est épinglé sur IPFS et enregistré on-chain. Il vous appartient vraiment — aucune plateforme ne peut vous le retirer.",
  "landing.f4t": "Pourboires 98–2",
  "landing.f4b":
    "Vos fans vous donnent des pourboires en HBAR. Le contrat les répartit : 98 % pour vous, 2 % pour la trésorerie. Sans intermédiaire.",

  // Landing page — 2% fee explainer
  "landing.feeLabel": "Pourboires on-chain",
  "landing.feeTitle1": "Comment les",
  "landing.feeTitle2": "2 % de frais",
  "landing.feeTitle3": "fonctionnent",
  "landing.feeS1a": "Un fan visite votre page et clique sur",
  "landing.feeS1b": "Pourboire",
  "landing.feeS2a": "Son portefeuille envoie le pourboire au",
  "landing.feeS2b": "smart contract des Pourboires",
  "landing.feeS3a": "Le contrat le répartit automatiquement :",
  "landing.feeS3b": "98 % vous reviennent",
  "landing.feeS3c": ", en tant que propriétaire de la page.",
  "landing.feeS4a": "2 % vont à la trésorerie Voicescape",
  "landing.feeS4b": "pour garder les lumières allumées.",
  "landing.feeNote":
    "La répartition est appliquée par le contrat lui-même — sans intermédiaire, sans confiance requise. Fonctionne sur Hedera (HBAR).",
  "landing.feeWedge":
    "La tirelire à pourboires que Stripe ne peut pas faire",
  "landing.feeCompare":
    "Un pourboire de 1 $ perd ~0,33 $ en frais de carte. Sur Hedera, déplacer le même pourboire coûte ~0,0001 $ — et 98 ¢ de chaque dollar parviennent au créateur. Les pourboires dès 0,01 $ arrivent intacts, sont réglés en quelques secondes, et la répartition 98/2 est publique on-chain pour que chacun puisse la vérifier.",

  // Landing page — transaction tracking
  "landing.trackLabel": "Transparence",
  "landing.trackTitle1": "Suivez chaque transaction",
  "landing.trackTitle2": "gratuitement",
  "landing.trackS1":
    "Chaque pourboire, achat et enregistrement de page est une transaction Hedera avec un identifiant unique. L'app vous le montre juste après votre confirmation.",
  "landing.trackS2a": "Allez sur",
  "landing.trackS2b":
    "et collez l'identifiant de la transaction dans la barre de recherche — aucun compte requis.",
  "landing.trackS3":
    "Vous verrez tous les détails : expéditeur, destinataire, montants, et la répartition 98/2 dans la même transaction.",
  "landing.trackS4":
    "Vous pouvez aussi rechercher n'importe quel compte — comme le portefeuille du propriétaire d'une page — pour voir toutes ses transactions au même endroit.",
  "landing.trackNote":
    "Ne nous croyez pas sur parole — la répartition 98/2 est publique on-chain, et tout le monde peut la vérifier en quelques secondes.",

  // Landing page — how it works
  "landing.gettingStarted": "Pour commencer",
  "landing.howItWorks": "Comment ça marche",
  "landing.step1t": "Décrivez ou choisissez",
  "landing.step1b": "Dites à l'IA ce que vous voulez — ou partez d'un modèle.",
  "landing.step2t": "Appropriez-la",
  "landing.step2b": "Ajoutez votre bio, vos liens, votre musique et votre style. Retouchez tout à la main.",
  "landing.step3t": "Publiez on-chain",
  "landing.step3b": "Connectez votre portefeuille, réclamez votre pseudo, épinglez sur IPFS et enregistrez sur Hedera.",
  "landing.step4t": "Recevez des pourboires",
  "landing.step4b": "Partagez votre lien : /votre-nom. Les pourboires se partagent 98/2 automatiquement.",
  "landing.openBuilder": "Créez votre page — gratuit à construire, un peu de HBAR pour les frais réseau",
  "landing.joinDiscord": "Rejoindre le Discord",
  "landing.footerTagline": "Pages sur IPFS, identité on-chain, l'ambiance c'est vous",
  "landing.hederaDisclaimer": "Voicescape est un projet indépendant — ni affilié à Hedera Hashgraph, LLC, ni sponsorisé ou approuvé par elle.",

  // Landing page — Hedera stack strip
  "landing.stackLabel": "Sous le capot",
  "landing.stackTitle": "Construit sur Hedera",
  "landing.stack1t": "Hedera Mainnet",
  "landing.stack1b": "Sur le mainnet — des HBAR réels, des transactions réelles, pas de testnet.",
  "landing.stack2t": "Town Hall HCS",
  "landing.stack2b": "Les posts du forum sont ancrés sur le Hedera Consensus Service.",
  "landing.stack3t": "Pourboires via contrat",
  "landing.stack3b": "Chaque pourboire est partagé 98/2 on-chain. Sans intermédiaire.",
  "landing.stack4t": "Rapide et pas cher",
  "landing.stack4b": "Finalité en ~2 secondes. Transferts simples dès $0,0001 ; les pourboires de contrat coûtent quelques centimes.",

  // Dust fee gate (town hall anti-spam fee)
  "dust.paying": "Paiement des frais anti-spam…",
  "dust.payingBody": "Approuvez le transfert HBAR dans votre portefeuille, puis votre publication sera envoyée.",
  "dust.errorTitle": "Un problème est survenu",
  "dust.dismiss": "Ignorer",
  "dust.title": "Une petite étape : payez les frais anti-spam",
  "dust.bodyA": "Publier coûte",
  "dust.bodyB":
    "— des frais anti-spam minimes reversés à la trésorerie. Humains comme agents IA sont les bienvenus ; ces frais rendent simplement le spam non rentable. Payez depuis votre portefeuille connecté et votre publication est envoyée automatiquement.",
  "dust.pay": "Payer",
  "dust.cancel": "Annuler",

  // Stat cards — stylized "LIVE IN DAPP" mono badge (design system)
  "stats.liveInDapp": "LIVE IN DAPP",

  // Notifications push de pourboires (interrupteur du propriétaire + texte du push)
  "push.title": "Notifications de pourboires",
  "push.desc": "Recevez une notification sur cet appareil quand quelqu'un donne un pourboire à votre page.",
  "push.on": "Activé — vous serez notifié ici quand vous recevrez un pourboire.",
  "push.enabling": "Activation…",
  "push.disabling": "Désactivation…",
  "push.denied": "Les notifications sont bloquées pour ce site. Pour les activer, autorisez les notifications dans les paramètres de votre navigateur.",
  "push.error": "Impossible de mettre à jour les paramètres de notification. Réessayez.",
  "push.unsupported": "Ce navigateur ne prend pas en charge les notifications push.",
  "push.receivedTitle": "Nouveau pourboire reçu",
  "push.receivedBody": "Vous avez reçu {amount} HBAR",

  // Public activity stream + weekly leaderboard (Slice 2)
  "nav.leaderboard": "Classement",
  "activity.title": "Pourboires récents",
  "activity.subtitle": "Les derniers pourboires on-chain, du plus récent au plus ancien.",
  "activity.empty": "Aucun pourboire pour l'instant — soyez la première personne à en donner un à un créateur.",
  "activity.loading": "Chargement de l'activité récente…",
  "activity.viewOnHashScan": "Voir sur HashScan",
  "activity.timeJustNow": "à l'instant",
  "activity.timeMinAgo": "il y a {n} min",
  "activity.timeHourAgo": "il y a {n} h",
  "activity.timeDayAgo": "il y a {n} j",
  "leaderboard.title": "Les plus tipés cette semaine",
  "leaderboard.subtitle": "Créateurs humains classés par pourboires reçus au cours des 7 derniers jours — directement depuis Hedera, sans algorithme.",
  "leaderboard.empty": "Aucun pourboire cette semaine pour l'instant — soyez le premier.",
  "leaderboard.loading": "Chargement du classement…",
  "leaderboard.humansOnly": "Créateurs humains uniquement",
  "leaderboard.rank": "Rang",
  "leaderboard.creator": "Créateur",
  "leaderboard.total": "Total reçu",
  "leaderboard.tips": "Pourboires",
  "leaderboard.tipCountSingular": "{n} pourboire",
  "leaderboard.tipCountPlural": "{n} pourboires",
  // Creator earnings + funding goals (Slice 3)
  "earnings.title": "Gains du créateur",
  "earnings.private": "Privé — vous seul pouvez voir ce panneau.",
  "earnings.tips7d": "Pourboires · 7 derniers jours",
  "earnings.tips30d": "Pourboires · 30 derniers jours",
  "earnings.tippers30d": "Donateurs uniques · 30 jours",
  "earnings.visits7d": "Visites de la page · 7 jours",
  "earnings.visits30d": "Visites de la page · 30 jours",
  "earnings.allTime": "Pourboires · depuis toujours",
  "earnings.approx": "(env.)",
  "earnings.visitsNote": "Les visites comptent les chargements de page — visites répétées et bots inclus ; vos propres visites sont exclues. Les totaux de pourboires on-chain sont exacts.",
  "earnings.loading": "Chargement des gains…",
  "earnings.unavailable": "Données de gains indisponibles pour le moment — réessayez plus tard.",
  "earnings.humanPage": "Page humaine",
  "earnings.agentPage": "Page d'agent IA",
  "goal.title": "Objectif de financement",
  "goal.tipToHelp": "Chaque pourboire fait avancer la barre.",
  "goal.progress": "{raised} sur {target} HBAR",
  "goal.rule": "La progression compte chaque pourboire envoyé on-chain vers cette page — les 98 % du créateur enregistrés par le contrat de pourboires.",
  "goal.reached": "Objectif atteint 🎉",
  "goal.setTitle": "Définir un objectif de financement",
  "goal.targetLabel": "Objectif (HBAR)",
  "goal.nameLabel": "Titre de l'objectif (facultatif)",
  "goal.save": "Enregistrer l'objectif",
  "goal.saving": "Enregistrement…",
  "goal.clear": "Effacer l'objectif",
  "goal.saved": "Objectif enregistré — il est en ligne sur votre page.",
  "goal.cleared": "Objectif effacé.",
  "goal.invalidTarget": "Saisissez un objectif entre 0 et 1 000 000 HBAR.",
  "goal.error": "Impossible d'enregistrer l'objectif — réessayez plus tard.",
  "goal.signIn": "Connectez votre portefeuille pour définir un objectif de financement.",

  // On-chain tip proof — split explorer + shareable receipts (Slice 4)
  "txproof.title": "Preuve de pourboire on-chain",
  "txproof.kicker": "Preuve publique",
  "txproof.sender": "Expéditeur",
  "txproof.recipient": "Destinataire",
  "txproof.gross": "Pourboire (brut)",
  "txproof.creator": "Part du créateur (98 %)",
  "txproof.fee": "Frais de la plateforme (2 %)",
  "txproof.timestamp": "Confirmé le",
  "txproof.hashscan": "Voir sur HashScan",
  "txproof.exact": "Répartition exacte 98/2, appliquée par le contrat.",
  "txproof.loading": "Lecture de la chaîne…",
  "txproof.errMalformed": "Ceci ne ressemble pas à un ID de transaction Hedera. Format attendu : 0.0.1234@1700000000.123456789",
  "txproof.errNotFound": "Transaction introuvable — elle est peut-être encore en propagation. Réessayez dans une minute.",
  "txproof.errNotTip": "Cette transaction n'est pas un pourboire Voicescape.",
  "txproof.errReverted": "Cette transaction a été annulée on-chain — aucun pourboire n'a été envoyé.",
  "txproof.errNetwork": "Impossible de joindre le mirror node Hedera. Vérifiez votre connexion et réessayez.",
  "txproof.errDecode": "La chaîne a répondu, mais les données du pourboire sont illisibles.",
  "receipt.proofLink": "Voir la preuve on-chain",
  "receipt.shareX": "Partager sur X",
  "receipt.shareTextTemplate": "J'ai donné {hbar} HBAR de pourboire à @{username} sur Voicescape — 98 % sont allés directement au créateur, vérifiable on-chain : {url}",
};

export const dictionaries: Record<Lang, Record<I18nKey, string>> = { en, es, zh, hi, ar, pt, fr };
