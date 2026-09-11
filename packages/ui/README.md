# @voicescape/ui

Voicescape's shared presentational components. React only — no Next.js
imports (the `next/image` in `Splash` was replaced with a plain `<img>`),
so these work in any React app: `apps/web`, `apps/admin`,
`apps/marketplace`.

## Components

- `Logo` — Voicescape wordmark + microphone/sound-wave mark
- `Splash` — animated launch splash screen
- `Lattice` — animated background lattice canvas
- `InstallAppButton` — PWA install prompt button (shows on
  `beforeinstallprompt`, hides when installed)
- `icons` — SVG icon set (wallet, tip, spark, link, music, book, grid,
  close, check, arrow, plus, trash, users, bolt, globe, external, play,
  pause)

## Usage

```tsx
import { Logo, Splash, InstallAppButton } from "@voicescape/ui";
```

## Status

Extracted from the production monolith (`frontend/components/`) during the
modular refactor. The monolith still uses its own copies; `apps/web` will
switch to this package once the migration lands.
