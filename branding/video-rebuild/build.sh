#!/bin/bash
# Rebuilds Voicescape marketing videos from CURRENT live-site screenshots.
# Keeps Brandon-approved narration audio, captions, and end card untouched —
# only the visuals are refreshed (old screenshots were from 2026-09-14,
# pre-98%-hero / pre-agent-directory-fix / pre-Buddy-rebrand).
#
# Usage:
#   1. Drop 6 PNGs into shots/ (see SHOT_LIST.md for the exact capture spec)
#   2. ./build.sh
# Outputs land in ../../ with the ORIGINAL filenames:
#   voicescape-demo-video.mp4, voicescape-hype-v2.mp4,
#   voicescape-hype-v2-vertical.mp4
set -euo pipefail
cd "$(dirname "$0")"

BRAND="$PWD/.."
FPS=30
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
OUTDIR="$PWD/out"

need() { [ -f "$1" ] || { echo "MISSING INPUT: $1" >&2; exit 1; }; }
for s in shot-landing-hero shot-founder-page shot-founder-tips shot-agents shot-builder shot-townhall shot-forge-buddy; do
  need "shots/$s.png"
done
need "$BRAND/voicescape-demo-video.mp4"
need "$BRAND/voicescape-hype-v2.mp4"
[ -f "$FONT" ] || { echo "MISSING FONT: $FONT" >&2; exit 1; }

mkdir -p segs "$OUTDIR"
rm -f segs/*.mp4

# kenburns <shot> <frames> <motion: zin|panR|panL> <captionfile|none> <out>
kenburns() {
  local shot=$1 frames=$2 motion=$3 cap=$4 out=$5 zb
  case $motion in
    zin)  zb="z='min(1+0.10*on/$frames,1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" ;;
    panR) zb="z=1.12:x='(iw-iw/zoom)*on/$frames':y='ih/2-(ih/zoom/2)'" ;;
    panL) zb="z=1.12:x='(iw-iw/zoom)*(1-on/$frames)':y='ih/2-(ih/zoom/2)'" ;;
  esac
  local vf="scale=1920:1080,zoompan=$zb:d=$frames:s=1280x720:fps=$FPS,format=yuv420p"
  if [ "$cap" != "none" ]; then
    vf="$vf,drawtext=fontfile=$FONT:textfile=captions/$cap:fontsize=54:fontcolor=white:borderw=3:bordercolor=black:x=(w-text_w)/2:y=h-text_h-90"
  fi
  ffmpeg -y -v error -loop 1 -i "shots/$shot.png" -vf "$vf" \
    -frames:v "$frames" -c:v libx264 -preset medium -crf 20 "segs/$out"
}

echo "== building segments =="
# --- demo-video: 6 x 7.8s = 46.8s, no captions ---
kenburns shot-landing-hero 234 zin  none demo-1.mp4
kenburns shot-founder-page 234 panR none demo-2.mp4
kenburns shot-founder-tips 234 zin  none demo-3.mp4
kenburns shot-agents       234 panL none demo-4.mp4
kenburns shot-builder       234 zin  none demo-5.mp4
kenburns shot-townhall      234 panR none demo-6.mp4

# --- hype-v2: 63.5s content + 2.97s end card = 66.47s, burned-in captions ---
kenburns shot-founder-tips 352 zin  cap1.txt h2-1.mp4
kenburns shot-landing-hero 401 panR cap2.txt h2-2.mp4
kenburns shot-forge-buddy 272 zin  cap3.txt h2-3.mp4
kenburns shot-agents       263 panL cap4.txt h2-4.mp4
kenburns shot-builder       204 zin  cap5.txt h2-5.mp4
kenburns shot-townhall      413 panR cap6.txt h2-6.mp4

# end card: extract verbatim from the original (logo + URL + tagline, all current)
ffmpeg -y -v error -ss 63.5 -i "$BRAND/voicescape-hype-v2.mp4" -an \
  -vf "fps=$FPS,scale=1280:720,format=yuv420p,setsar=1" \
  -c:v libx264 -preset medium -crf 20 segs/h2-endcard.mp4

echo "== assembling demo-video =="
ffmpeg -y -v error \
  -i segs/demo-1.mp4 -i segs/demo-2.mp4 -i segs/demo-3.mp4 \
  -i segs/demo-4.mp4 -i segs/demo-5.mp4 -i segs/demo-6.mp4 \
  -i "$BRAND/voicescape-demo-video.mp4" \
  -filter_complex "[0:v][1:v][2:v][3:v][4:v][5:v]concat=n=6:v=1:a=0[v]" \
  -map "[v]" -map 6:a -c:v libx264 -preset medium -crf 20 -c:a copy \
  -movflags +faststart "$OUTDIR/voicescape-demo-video.mp4"

echo "== assembling hype-v2 (16:9) =="
ffmpeg -y -v error \
  -i segs/h2-1.mp4 -i segs/h2-2.mp4 -i segs/h2-3.mp4 \
  -i segs/h2-4.mp4 -i segs/h2-5.mp4 -i segs/h2-6.mp4 -i segs/h2-endcard.mp4 \
  -i "$BRAND/voicescape-hype-v2.mp4" \
  -filter_complex "[0:v][1:v][2:v][3:v][4:v][5:v][6:v]concat=n=7:v=1:a=0[v]" \
  -map "[v]" -map 7:a -c:v libx264 -preset medium -crf 20 -c:a copy \
  -movflags +faststart "$OUTDIR/voicescape-hype-v2.mp4"

echo "== building vertical cut (720x1280 blurred-bg) =="
ffmpeg -y -v error -i "$OUTDIR/voicescape-hype-v2.mp4" -filter_complex \
  "[0:v]split[a][b];[a]scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,gblur=sigma=40[bg];[b]scale=720:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]" \
  -map "[v]" -map 0:a -c:v libx264 -preset medium -crf 22 -c:a copy \
  -movflags +faststart "$OUTDIR/voicescape-hype-v2-vertical.mp4"

echo "== verifying =="
for f in voicescape-demo-video.mp4 voicescape-hype-v2.mp4 voicescape-hype-v2-vertical.mp4; do
  ffprobe -v error -show_entries format=duration,size \
    -show_entries stream=codec_name,width,height \
    -of default=noprint_wrappers=1 "$OUTDIR/$f" | sed "s|^|  $f: |"
done

echo "== installing to branding/ =="
cp "$OUTDIR"/voicescape-*.mp4 "$BRAND/"
ls -la "$BRAND"/voicescape-demo-video.mp4 "$BRAND"/voicescape-hype-v2.mp4 "$BRAND"/voicescape-hype-v2-vertical.mp4
echo DONE
