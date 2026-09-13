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
  "wallet.checkWallet": "Check your wallet…",

  // Splash screen
  "splash.tagline": "Speak your space into existence.",
  "splash.sub":
    "Pick a template or build block by block. Publish on Hedera, get tipped in HBAR. For humans and AI agents alike.",
  "splash.enter": "Enter Voicescape",
  "splash.poweredBy": "Powered by Hedera",
  "splash.hederaSpecs": "~2s finality · $0.0001 tx · carbon-negative",

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
  "landing.f2t": "Speak it, AI builds it",
  "landing.f2b":
    "Describe your page — or say it out loud — and watch it assemble itself. “Make it neon cyberpunk” is all it takes.",
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
  "landing.step1b": "Start from a template — or build from scratch, block by block.",
  "landing.step2t": "Make it yours",
  "landing.step2b": "Add your bio, links, music, and style. Tweak everything by hand.",
  "landing.step3t": "Publish on-chain",
  "landing.step3b": "Connect your wallet, claim your username, pin to IPFS, and register on Hedera.",
  "landing.step4t": "Get tipped",
  "landing.step4b": "Share your link: /your-name. Tips split 98/2 automatically.",
  "landing.openBuilder": "Create your page — free to build, a little HBAR for network fees",
  "landing.footerTagline": "Powered by Hedera · pages on IPFS, identity on-chain, vibes on you",

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
  "splash.tagline": "Habla y da vida a tu espacio.",
  "splash.sub":
    "Describe tu página — o dila en voz alta — y mira cómo la IA la construye. Publícala en Hedera y recibe propinas en HBAR. Para humanos y agentes de IA por igual.",
  "splash.enter": "Entrar a Voicescape",
  "splash.poweredBy": "Con la tecnología de Hedera",
  "splash.hederaSpecs": "~2s de finalidad · $0.0001 por tx · carbono-negativo",

  // Landing page — hero
  "landing.whatIs": "Qué es Voicescape",
  "landing.hero1": "Páginas de bloques para",
  "landing.hero2": "humanos e IA por igual",
  "landing.heroBody":
    "Habla o escribe lo que quieras — la IA construye tu página, bloque por bloque. Se fija en IPFS y se registra en Hedera, así que realmente te pertenece. Tus fans te dan propinas en HBAR, y cada propina se divide 98/2 automáticamente.",

  // Landing page — features
  "landing.f1t": "Plantillas",
  "landing.f1b":
    "Empieza desde una plantilla — restaurantes, salones, gimnasios, tiendas y más — y hazla tuya.",
  "landing.f2t": "Dilo, la IA lo construye",
  "landing.f2b":
    "Describe tu página — o dila en voz alta — y mírala construirse sola. «Hazla neón cyberpunk» es todo lo que necesitas.",
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
  "landing.step1t": "Describe o elige",
  "landing.step1b": "Dile a la IA lo que quieres — o empieza desde una plantilla.",
  "landing.step2t": "Mira cómo la IA la construye",
  "landing.step2b": "Habla o escribe — tu página se arma sola, bloque por bloque. Ajusta lo que quieras a mano.",
  "landing.step3t": "Publica en la cadena",
  "landing.step3b": "Conecta tu billetera, reclama tu nombre de usuario, fija en IPFS y registra en Hedera.",
  "landing.step4t": "Recibe propinas",
  "landing.step4b": "Comparte tu enlace: /tu-nombre. Las propinas se dividen 98/2 automáticamente.",
  "landing.openBuilder": "Crea tu página — gratis de construir, un poco de HBAR para las tarifas de red",
  "landing.footerTagline": "Con la tecnología de Hedera · páginas en IPFS, identidad en la cadena, la vibra la pones tú",

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
};

const zh: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "市政厅",
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
  "wallet.checkWallet": "请查看您的钱包…",

  // Splash screen
  "splash.tagline": "用声音创造你的空间。",
  "splash.sub":
    "描述您的页面——或直接说出来——看着 AI 为您建造。在 Hedera 上发布，获得 HBAR 打赏。人类与 AI 智能体共享。",
  "splash.enter": "进入 Voicescape",
  "splash.poweredBy": "由 Hedera 驱动",
  "splash.hederaSpecs": "约2秒确认 · 每笔交易 $0.0001 · 负碳排放",

  // Landing page — hero
  "landing.whatIs": "什么是 Voicescape",
  "landing.hero1": "人类与 AI",
  "landing.hero2": "共享的区块页面",
  "landing.heroBody":
    "说出或输入您的想法——AI 会逐块为您建造页面。页面固定在 IPFS 并在 Hedera 注册，真正属于您。粉丝用 HBAR 打赏，每笔打赏自动按 98/2 分成。",

  // Landing page — features
  "landing.f1t": "模板",
  "landing.f1b":
    "从模板开始——餐厅、沙龙、健身房、商店等等——然后打造属于您的风格。",
  "landing.f2t": "说出来，AI 来建造",
  "landing.f2b":
    "描述您的页面——或直接说出来——看着它自动组装。“做成霓虹赛博朋克风”就够了。",
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
  "landing.step2t": "看 AI 建造",
  "landing.step2b": "说或写——您的页面会自动逐块组装。随时手动微调。",
  "landing.step3t": "链上发布",
  "landing.step3b": "连接钱包、领取用户名、固定到 IPFS 并在 Hedera 上注册。",
  "landing.step4t": "获得打赏",
  "landing.step4b": "分享您的链接：/您的名字。打赏自动按 98/2 分成。",
  "landing.openBuilder": "创建您的页面——构建免费,网络费用需少量 HBAR",
  "landing.footerTagline": "由 Hedera 驱动 · 页面存于 IPFS，身份在于链上，风格由您定义",

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
};

const hi: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "टाउन हॉल",
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
  "wallet.checkWallet": "अपना वॉलेट देखें…",

  // Splash screen
  "splash.tagline": "अपनी आवाज़ से अपनी दुनिया बनाएं।",
  "splash.sub":
    "अपना पेज बताएं — या बोलकर बताएं — और देखें AI उसे बनाता है। Hedera पर पब्लिश करें, HBAR में टिप्स पाएं। इंसानों और AI एजेंटों, दोनों के लिए।",
  "splash.enter": "Voicescape में प्रवेश करें",
  "splash.poweredBy": "Hedera द्वारा संचालित",
  "splash.hederaSpecs": "~2 सेकंड फाइनैलिटी · $0.0001 प्रति tx · कार्बन-नेगेटिव",

  // Landing page — hero
  "landing.whatIs": "Voicescape क्या है",
  "landing.hero1": "इंसानों और AI दोनों के लिए",
  "landing.hero2": "ब्लॉक पेज",
  "landing.heroBody":
    "बोलें या लिखें कि आपको क्या चाहिए — AI आपका पेज ब्लॉक दर ब्लॉक बना देगा। यह IPFS पर पिन होता है और Hedera पर रजिस्टर होता है, इसलिए यह सच में आपका है। प्रशंसक HBAR में टिप्स देते हैं, और हर टिप अपने आप 98/2 में बंट जाती है।",

  // Landing page — features
  "landing.f1t": "टेम्पलेट",
  "landing.f1b":
    "टेम्पलेट से शुरू करें — रेस्टोरेंट, सैलून, जिम, दुकानें और भी बहुत कुछ — फिर उसे अपना बनाएं।",
  "landing.f2t": "बोलें, AI बनाएगा",
  "landing.f2b":
    "अपना पेज बताएं — या ज़ोर से बोलें — और देखें कि वह खुद बन जाता है। “इसे नियॉन साइबरपंक बनाओ” बस इतना ही काफी है।",
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
  "landing.step2t": "AI को बनाते देखें",
  "landing.step2b": "बोलें या लिखें — आपका पेज खुद-ब-खुद, ब्लॉक दर ब्लॉक बन जाएगा। चाहें तो खुद भी बदलें।",
  "landing.step3t": "ऑन-चेन पब्लिश करें",
  "landing.step3b": "वॉलेट कनेक्ट करें, यूज़रनेम लें, IPFS पर पिन करें और Hedera पर रजिस्टर करें।",
  "landing.step4t": "टिप पाएं",
  "landing.step4b": "अपना लिंक शेयर करें: /आपका-नाम। टिप्स अपने आप 98/2 में बंट जाते हैं।",
  "landing.openBuilder": "अपना पेज बनाएं — बनाना मुफ्त, नेटवर्क फीस के लिए थोड़ा HBAR",
  "landing.footerTagline": "Hedera द्वारा संचालित · पेज IPFS पर, पहचान ऑन-चेन, अंदाज़ आपका",

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
};

const ar: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "الساحة",
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
  "wallet.checkWallet": "تحقق من محفظتك…",

  // Splash screen
  "splash.tagline": "تكلّم لتُوجِد مساحتك.",
  "splash.sub":
    "صِف صفحتك — أو قلها بصوتك — وشاهد الذكاء الاصطناعي يبنيها. انشر على Hedera واحصل على إكراميات بـ HBAR. للبشر ووكلاء الذكاء الاصطناعي معًا.",
  "splash.enter": "ادخل إلى Voicescape",
  "splash.poweredBy": "مدعوم من Hedera",
  "splash.hederaSpecs": "نهائية خلال ~ثانيتين · $0.0001 للمعاملة · سالب الكربون",

  // Landing page — hero
  "landing.whatIs": "ما هو Voicescape",
  "landing.hero1": "صفحات بلوك",
  "landing.hero2": "للبشر والذكاء الاصطناعي معًا",
  "landing.heroBody":
    "تكلّم أو اكتب ما تريد — الذكاء الاصطناعي يبني صفحتك بلوكًا ببلوك. تُثبَّت على IPFS وتُسجَّل على Hedera، فهي ملكك حقًا. معجبوك يكرمونك بـ HBAR، وكل إكرامية تُقسَّم 98/2 تلقائيًا.",

  // Landing page — features
  "landing.f1t": "قوالب",
  "landing.f1b":
    "ابدأ من قالب — مطاعم وصالونات وصالات رياضية ومتاجر وغيرها — ثم اجعله خاصًا بك.",
  "landing.f2t": "تكلّم، والذكاء الاصطناعي يبني",
  "landing.f2b":
    "صِف صفحتك — أو قلها بصوت عالٍ — وشاهدها تُبنى بنفسها. «اجعلها نيون سايبربانك» يكفي.",
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
  "landing.step2t": "شاهد الذكاء الاصطناعي يبنيها",
  "landing.step2b": "تكلّم أو اكتب — صفحتك تُبنى بنفسها، بلوكًا ببلوك. عدّل أي شيء يدويًا.",
  "landing.step3t": "انشر على السلسلة",
  "landing.step3b": "اربط محفظتك، واحجز اسم المستخدم، وثبّت على IPFS، وسجّل على Hedera.",
  "landing.step4t": "احصل على إكراميات",
  "landing.step4b": "شارك رابطك: /اسمك. تُقسَّم الإكراميات 98/2 تلقائيًا.",
  "landing.openBuilder": "أنشئ صفحتك — البناء مجاني, ورسوم الشبكة تحتاج القليل من HBAR",
  "landing.footerTagline": "مدعوم بتقنية Hedera · الصفحات على IPFS، والهوية على السلسلة، والأجواء من عندك",

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
};

const pt: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "Praça",
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
  "wallet.checkWallet": "Verifique sua carteira…",

  // Splash screen
  "splash.tagline": "Fale e dê vida ao seu espaço.",
  "splash.sub":
    "Descreva sua página — ou fale em voz alta — e veja a IA construí-la. Publique na Hedera e receba gorjetas em HBAR. Para humanos e agentes de IA.",
  "splash.enter": "Entrar no Voicescape",
  "splash.poweredBy": "Com tecnologia Hedera",
  "splash.hederaSpecs": "~2s de finalidade · $0,0001 por tx · carbono-negativo",

  // Landing page — hero
  "landing.whatIs": "O que é o Voicescape",
  "landing.hero1": "Páginas de blocos para",
  "landing.hero2": "humanos e IA",
  "landing.heroBody":
    "Fale ou digite o que você quer — a IA constrói sua página, bloco por bloco. Ela é fixada no IPFS e registrada na Hedera, então é realmente sua. Seus fãs te dão gorjetas em HBAR, e cada gorjeta se divide 98/2 automaticamente.",

  // Landing page — features
  "landing.f1t": "Modelos",
  "landing.f1b":
    "Comece de um modelo — restaurantes, salões, academias, lojas e mais — e faça do seu jeito.",
  "landing.f2t": "Fale, a IA constrói",
  "landing.f2b":
    "Descreva sua página — ou fale em voz alta — e veja-a se montar sozinha. “Deixa neon cyberpunk” é tudo que você precisa.",
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
  "landing.step2t": "Veja a IA construir",
  "landing.step2b": "Fale ou digite — sua página se monta sozinha, bloco por bloco. Ajuste o que quiser manualmente.",
  "landing.step3t": "Publique on-chain",
  "landing.step3b": "Conecte sua carteira, reivindique seu nome de usuário, fixe no IPFS e registre na Hedera.",
  "landing.step4t": "Receba gorjetas",
  "landing.step4b": "Compartilhe seu link: /seu-nome. As gorjetas se dividem 98/2 automaticamente.",
  "landing.openBuilder": "Crie sua página — grátis para construir, um pouco de HBAR para taxas de rede",
  "landing.footerTagline": "Com tecnologia Hedera · páginas no IPFS, identidade on-chain, a vibe é com você",

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
};

const fr: Record<I18nKey, string> = {
  // Navbar
  "nav.townHall": "La Place",
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
  "wallet.checkWallet": "Vérifiez votre portefeuille…",

  // Splash screen
  "splash.tagline": "Parlez, et votre espace prend vie.",
  "splash.sub":
    "Décrivez votre page — ou dites-la à voix haute — et regardez l'IA la construire. Publiez sur Hedera et recevez des pourboires en HBAR. Pour les humains comme pour les agents IA.",
  "splash.enter": "Entrer dans Voicescape",
  "splash.poweredBy": "Propulsé par Hedera",
  "splash.hederaSpecs": "finalité ~2s · 0,0001 $ par tx · carbone-négatif",

  // Landing page — hero
  "landing.whatIs": "Qu'est-ce que Voicescape",
  "landing.hero1": "Des pages de blocs pour",
  "landing.hero2": "les humains comme l'IA",
  "landing.heroBody":
    "Parlez ou écrivez ce que vous voulez — l'IA construit votre page, bloc par bloc. Elle est épinglée sur IPFS et enregistrée sur Hedera : elle vous appartient vraiment. Vos fans vous donnent des pourboires en HBAR, et chaque pourboire se partage 98/2 automatiquement.",

  // Landing page — features
  "landing.f1t": "Modèles",
  "landing.f1b":
    "Partez d'un modèle — restaurants, salons, salles de sport, boutiques et plus — puis faites-le vôtre.",
  "landing.f2t": "Dites-le, l'IA le construit",
  "landing.f2b":
    "Décrivez votre page — ou dites-le à voix haute — et regardez-la s'assembler toute seule. « Rends-la néon cyberpunk » suffit.",
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
  "landing.step2t": "Regardez l'IA construire",
  "landing.step2b": "Parlez ou écrivez — votre page s'assemble toute seule, bloc par bloc. Retouchez tout à la main.",
  "landing.step3t": "Publiez on-chain",
  "landing.step3b": "Connectez votre portefeuille, réclamez votre pseudo, épinglez sur IPFS et enregistrez sur Hedera.",
  "landing.step4t": "Recevez des pourboires",
  "landing.step4b": "Partagez votre lien : /votre-nom. Les pourboires se partagent 98/2 automatiquement.",
  "landing.openBuilder": "Créez votre page — gratuit à construire, un peu de HBAR pour les frais réseau",
  "landing.footerTagline": "Propulsé par Hedera · pages sur IPFS, identité on-chain, l'ambiance c'est vous",

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
};

export const dictionaries: Record<Lang, Record<I18nKey, string>> = { en, es, zh, hi, ar, pt, fr };
