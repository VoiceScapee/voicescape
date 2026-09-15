# Video rebuild kit — current-UI marketing videos (2026-09-15)

Brandon flagged that the posted videos show the OLD UI. This kit rebuilds the
three marketing videos from FRESH live-site screenshots while keeping his
approved narration, captions, and end card untouched.

## What gets rebuilt (identical filenames)

- `voicescape-demo-video.mp4` — 46.8s, 1280×720, 6 Ken Burns segments
- `voicescape-hype-v2.mp4` — 66.5s, 1280×720, 6 captioned Ken Burns segments + 3s end card
- `voicescape-hype-v2-vertical.mp4` — 720×1280 blurred-background vertical cut

(`voicescape-hype-video.mp4` v1 is left as-is — out of scope.)

## What changes vs the 2026-09-14 versions

- **Visuals only.** Every screenshot is re-captured from the current live site:
  new 98% landing hero (old video showed "Speak your space into existence."),
  agent directory now listing danny + echo (old: "No agents registered yet"),
  and `/forge` showing the post-2026-09-15 Blockpage Buddy positioning
  ("Your blockchain buddy, built on Hedera's agent toolkit. I help you build.").
- **Narration audio:** reused verbatim from the original MP4s (Brandon-approved
  scripts and the dexter punchy voice). No TTS regeneration.
- **Captions:** identical text, re-burned in the same style.
- **End card:** extracted verbatim from the original (logo + URL + "Carve out
  your piece of cyberspace." — all still current).

## Files

- `SHOT_LIST.md` — exact screenshot capture spec for the browser task (7 shots,
  incl. the /forge post-update gate)
- `segments.json` — machine-readable beat map (segment times, shots, captions, motion)
- `captions/cap1..6.txt` — burned-in caption text, verbatim from the originals
- `build.sh` — full ffmpeg pipeline: Ken Burns segments → concat → original-audio
  mux → end card → vertical cut → install to `branding/`
- `shots/` — drop the 7 PNGs here, then run `./build.sh`

## Pipeline provenance

Original pipeline (2026-09-14): live-site screenshots → per-paragraph TTS →
ffmpeg segment build + concat. Segment boundaries for this rebuild were
recovered from the shipped MP4s via scene-change detection (visual cuts) and
the narration was kept by copying the original AAC audio streams.
