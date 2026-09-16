#!/usr/bin/env bash
# make-loop.sh — turn any source clip (or a synthesized lavfi: source) into the
# five files engine/bg-video.mjs's bgVideo() call needs: a desktop mp4, a webm,
# a mobile mp4, and two poster fallbacks (webp + jpg). Every output is silent,
# 24fps, cropped to 16:9, and the loop seam is sealed with a 1s crossfade of
# the clip's own tail into its own head so nothing pops when the <video loop>
# repeats.
#
# usage:
#   tools/make-loop.sh <input> <outdir> <name> [--seconds 8] [--width 1920] \
#     [--tint '#rrggbb'] [--tint-strength 0.6] [--start 0]
#
#   <input>   a path to a source clip, OR "lavfi:<filtergraph spec>" to
#             synthesize one with no stock footage and no download, e.g.
#             lavfi:'gradients=size=1920x1080:duration=10:speed=0.015:nb_colors=3:c0=#0c0a12:c1=#5b2a86:c2=#ff6b4a'
#   <outdir>  written if it doesn't exist
#   <name>    the output basename: <name>.mp4, <name>.webm, <name>-mobile.mp4,
#             <name>-poster.webp, <name>-poster.jpg
#
# flags (all optional):
#   --seconds N        output duration in seconds (default 8)
#   --width N           desktop width in px, 16:9 crop (default 1920)
#   --tint '#rrggbb'    blend a solid color over the clip (softlight blend)
#   --tint-strength N   0-1, how strong the tint blend is (default 0.6)
#   --start N           seconds into the SOURCE to start trimming (default 0)
#
# Requires ffmpeg. This machine's copy: /opt/homebrew/bin/ffmpeg (v9).
#
# Targets printed in the size table: desktop mp4 under 2.5 MB for an 8s loop,
# mobile mp4 under 1 MB. Over either prints a WARN line, never fails the run —
# a slow loop or a busier tint pushes both up, and that is a judgment call for
# whoever is looking at the table, not a hard gate.

set -euo pipefail

FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-/opt/homebrew/bin/ffprobe}"
command -v "$FFMPEG" >/dev/null 2>&1 || { echo "FAIL: ffmpeg not found at $FFMPEG" >&2; exit 2; }

if [ "$#" -lt 3 ]; then
  echo "usage: make-loop.sh <input> <outdir> <name> [--seconds 8] [--width 1920] [--tint '#rrggbb'] [--tint-strength 0.6] [--start 0]" >&2
  exit 2
fi

INPUT="$1"; OUTDIR="$2"; NAME="$3"; shift 3

SECONDS_ARG=8
WIDTH=1920
TINT=""
TINT_STRENGTH=0.6
START=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --seconds) SECONDS_ARG="$2"; shift 2 ;;
    --width) WIDTH="$2"; shift 2 ;;
    --tint) TINT="$2"; shift 2 ;;
    --tint-strength) TINT_STRENGTH="$2"; shift 2 ;;
    --start) START="$2"; shift 2 ;;
    *) echo "FAIL: unknown flag $1" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUTDIR"

# The loop-seam crossfade, in seconds. Fixed at 1s per the spec; guarded so a
# very short --seconds request can't ask for a crossfade longer than the clip.
XF=1
XF=$(awk -v s="$SECONDS_ARG" -v xf="$XF" 'BEGIN{ m=s/4; print (xf<m)?xf:m }')
BODY_DUR=$(awk -v s="$SECONDS_ARG" -v xf="$XF" 'BEGIN{ printf "%.3f", s-xf }')
TAIL_START=$(awk -v s="$SECONDS_ARG" -v xf="$XF" 'BEGIN{ printf "%.3f", s-xf }')

# ---- input args: a real file, or a synthesized lavfi: source ----
if [[ "$INPUT" == lavfi:* ]]; then
  SPEC="${INPUT#lavfi:}"
  IN_ARGS=(-f lavfi -i "$SPEC")
else
  IN_ARGS=(-ss "$START" -i "$INPUT")
fi

# 16:9 crop after scaling to WIDTH, keeping aspect on the way in.
CROP_H='round(iw*9/16/2)*2'
SCALE_CROP="scale=${WIDTH}:-2,crop=${WIDTH}:${CROP_H}"

# ---- the loop-seal + optional tint filter graph ----
# 1. trim to exactly $SECONDS_ARG, drop audio, 24fps, scale+crop to WIDTH:16:9
# 2. split into three copies: the body (0..D-XF), the future seam's tail half
#    (D-XF..D) and head half (0..XF)
# 3. xfade the tail into the head over XF seconds -> the seam
# 4. concat body + seam -> a $SECONDS_ARG-long clip whose end is a blend of
#    its own true tail and true head, so a <video loop> repeat never pops
# 5. optional tint: partially desaturate, then soft-light blend a solid color
FILTER="[0:v]trim=0:${SECONDS_ARG},setpts=PTS-STARTPTS,fps=24,${SCALE_CROP},format=yuv420p[base];"
FILTER+="[base]split=3[a][b][c];"
FILTER+="[a]trim=0:${BODY_DUR},setpts=PTS-STARTPTS[body];"
FILTER+="[b]trim=0:${XF},setpts=PTS-STARTPTS[head];"
FILTER+="[c]trim=${TAIL_START}:${SECONDS_ARG},setpts=PTS-STARTPTS[tail];"
FILTER+="[tail][head]xfade=transition=fade:duration=${XF}:offset=0[seam];"
FILTER+="[body][seam]concat=n=2:v=1:a=0[looped]"

if [ -n "$TINT" ]; then
  DESAT=$(awk -v t="$TINT_STRENGTH" 'BEGIN{ s=1-(t*0.5); printf "%.3f", (s<0.2?0.2:s) }')
  FILTER+=";[looped]hue=s=${DESAT}[desat];"
  FILTER+="color=c=${TINT}:s=${WIDTH}x$(awk -v w="$WIDTH" 'BEGIN{printf "%d", int(w*9/16/2)*2}'):d=${SECONDS_ARG},fps=24[tintsrc];"
  FILTER+="[desat][tintsrc]blend=all_mode=softlight:all_opacity=${TINT_STRENGTH}[out]"
  OUT_LABEL="[out]"
else
  OUT_LABEL="[looped]"
fi

TMP_DIR=$(mktemp -d -t bbe-loop-master)
TMP_MASTER="$TMP_DIR/master.mp4"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "[1/6] rendering master (loop-sealed$( [ -n "$TINT" ] && echo ", tinted $TINT" ))..."
"$FFMPEG" -y -loglevel error "${IN_ARGS[@]}" -filter_complex "$FILTER" -map "$OUT_LABEL" \
  -c:v libx264 -crf 18 -preset veryfast -an "$TMP_MASTER"

DESKTOP_MP4="$OUTDIR/${NAME}.mp4"
DESKTOP_WEBM="$OUTDIR/${NAME}.webm"
MOBILE_MP4="$OUTDIR/${NAME}-mobile.mp4"
POSTER_WEBP="$OUTDIR/${NAME}-poster.webp"
POSTER_JPG="$OUTDIR/${NAME}-poster.jpg"

echo "[2/6] desktop mp4..."
"$FFMPEG" -y -loglevel error -i "$TMP_MASTER" \
  -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$DESKTOP_MP4"

echo "[3/6] desktop webm..."
"$FFMPEG" -y -loglevel error -i "$TMP_MASTER" \
  -c:v libvpx-vp9 -crf 36 -b:v 0 -an "$DESKTOP_WEBM"

echo "[4/6] mobile mp4 (960w)..."
MOBILE_CROP_H=$(awk 'BEGIN{printf "%d", int(960*9/16/2)*2}')
"$FFMPEG" -y -loglevel error -i "$TMP_MASTER" \
  -vf "scale=960:-2,crop=960:${MOBILE_CROP_H}" \
  -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p -movflags +faststart -an "$MOBILE_MP4"

echo "[5/6] poster jpg + webp..."
"$FFMPEG" -y -loglevel error -ss 0.5 -i "$TMP_MASTER" -frames:v 1 -q:v 4 "$POSTER_JPG"

# This build's ffmpeg (v9, homebrew) has no libwebp muxer wired to -f image2
# for a single frame (`Default encoder for format webp ... probably disabled`).
# cwebp (also homebrew, part of the same libwebp) takes the jpg this script
# already made and re-encodes it, so the poster pair still comes from the
# exact same frame either way.
if command -v cwebp >/dev/null 2>&1; then
  cwebp -quiet -q 80 "$POSTER_JPG" -o "$POSTER_WEBP"
else
  "$FFMPEG" -y -loglevel error -ss 0.5 -i "$TMP_MASTER" -frames:v 1 -quality 80 "$POSTER_WEBP" \
    || echo "  WARN: no cwebp and ffmpeg's webp encoder is unavailable — ${NAME}-poster.webp NOT written"
fi

echo "[6/6] done"

# ---- the size table ----
sz() { [ -f "$1" ] && stat -f%z "$1" 2>/dev/null || stat -c%s "$1" 2>/dev/null || echo 0; }
human() { awk -v b="$1" 'BEGIN{ printf "%.2f MB", b/1024/1024 }'; }

DESKTOP_BYTES=$(sz "$DESKTOP_MP4")
MOBILE_BYTES=$(sz "$MOBILE_MP4")

echo ""
echo "  ${NAME} — ${SECONDS_ARG}s @ ${WIDTH}w, loop seam sealed (${XF}s crossfade)"
printf "  %-28s %10s\n" "${NAME}.mp4" "$(human "$DESKTOP_BYTES")"
printf "  %-28s %10s\n" "${NAME}.webm" "$(human "$(sz "$DESKTOP_WEBM")")"
printf "  %-28s %10s\n" "${NAME}-mobile.mp4" "$(human "$MOBILE_BYTES")"
printf "  %-28s %10s\n" "${NAME}-poster.webp" "$(human "$(sz "$POSTER_WEBP")")"
printf "  %-28s %10s\n" "${NAME}-poster.jpg" "$(human "$(sz "$POSTER_JPG")")"

# Targets scale linearly with --seconds off the spec's 8s baseline.
DESKTOP_TARGET=$(awk -v s="$SECONDS_ARG" 'BEGIN{ printf "%d", 2.5*1024*1024*s/8 }')
MOBILE_TARGET=$(awk -v s="$SECONDS_ARG" 'BEGIN{ printf "%d", 1*1024*1024*s/8 }')
[ "$DESKTOP_BYTES" -gt "$DESKTOP_TARGET" ] && echo "  WARN: ${NAME}.mp4 is over target ($(human "$DESKTOP_BYTES") > $(human "$DESKTOP_TARGET") for ${SECONDS_ARG}s)"
[ "$MOBILE_BYTES" -gt "$MOBILE_TARGET" ] && echo "  WARN: ${NAME}-mobile.mp4 is over target ($(human "$MOBILE_BYTES") > $(human "$MOBILE_TARGET") for ${SECONDS_ARG}s)"

echo ""
echo "done: $OUTDIR/${NAME}.{mp4,webm} ${NAME}-mobile.mp4 ${NAME}-poster.{webp,jpg}"
