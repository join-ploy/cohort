#!/bin/bash
# Generate app icons from the source chain SVG.
# The source SVG is JUST the chain icon (no background). This script composites
# it onto a charcoal rounded-squircle with a drop shadow on a transparent canvas,
# suitable for macOS/Windows app icons.
#
# Requires: brew install librsvg imagemagick libicns
# Produces:
#   resources/build/icon.png   (1024x1024)
#   resources/build/icon.icns  (macOS)
#   resources/build/icon.ico   (Windows, multi-size)
#   resources/icon.png         (256x256, tray/dev)
#   resources/icon-dev.png     (256x256 with "DEV" banner)
#   resources/logo.svg         (standalone chain icon copy)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$(dirname "$SCRIPT_DIR")")"
SVG_SOURCE="$SCRIPT_DIR/icon.icon/Assets/logo.svg"
BUILD_DIR="$PROJECT_DIR/resources/build"
RESOURCES_DIR="$PROJECT_DIR/resources"
TMP_DIR=$(mktemp -d)

trap 'rm -rf "$TMP_DIR"' EXIT

if [ ! -f "$SVG_SOURCE" ]; then
  echo "Error: source SVG not found at $SVG_SOURCE" >&2
  exit 1
fi

missing=()
command -v rsvg-convert &>/dev/null || missing+=(librsvg)
command -v magick &>/dev/null       || missing+=(imagemagick)
command -v png2icns &>/dev/null     || missing+=(libicns)
if [ ${#missing[@]} -gt 0 ]; then
  echo "Error: missing dependencies: ${missing[*]}" >&2
  echo "Install with: brew install ${missing[*]}" >&2
  exit 1
fi

echo "Generating icons from $SVG_SOURCE..."

# --- Step 1: Render the chain icon to a transparent PNG, sized to fit
#     inside the squircle with comfortable padding (~55% of canvas).
rsvg-convert -w 560 -h 560 "$SVG_SOURCE" -o "$TMP_DIR/chain.png"

# --- Step 2: Build the rounded squircle on a transparent canvas.
#     The squircle is 824x824 with 164px radius, centered in 1024x1024.
#     A subtle radial gradient fill gives it depth.

# Create the squircle mask (white rounded rect on black)
magick -size 824x824 xc:black \
  -fill white -draw "roundrectangle 0,0,823,823,164,164" \
  "$TMP_DIR/mask.png"

# Create the squircle fill with radial gradient (lighter center, darker edges)
magick -size 824x824 radial-gradient:"#2E3034-#1C1D1F" "$TMP_DIR/fill.png"

# Apply mask to fill
magick "$TMP_DIR/fill.png" "$TMP_DIR/mask.png" \
  -alpha off -compose CopyOpacity -composite \
  "$TMP_DIR/squircle-raw.png"

# Add drop shadow behind the squircle
magick -size 1024x1024 xc:none \
  "$TMP_DIR/squircle-raw.png" -gravity center -geometry +0-6 -composite \
  \( "$TMP_DIR/squircle-raw.png" -gravity center -background none -shadow 50x12+0+10 \) \
  -gravity center -compose DstOver -composite \
  "$TMP_DIR/base.png"

# --- Step 3: Composite chain icon onto the squircle
magick "$TMP_DIR/base.png" \
  "$TMP_DIR/chain.png" -gravity center -composite \
  "$BUILD_DIR/icon.png"
echo "  -> resources/build/icon.png (1024x1024)"

# --- Step 4: 256px tray/dev icon
magick "$BUILD_DIR/icon.png" -resize 256x256 "$RESOURCES_DIR/icon.png"
echo "  -> resources/icon.png (256x256)"

# --- Step 5: Dev icon with "DEV" banner
BOLD_FONT="/System/Library/Fonts/Helvetica.ttc"
if [ ! -f "$BOLD_FONT" ]; then
  BOLD_FONT="$(fc-list :bold -f '%{file}\n' 2>/dev/null | head -1)"
fi
magick "$RESOURCES_DIR/icon.png" \
  -gravity South \
  -font "$BOLD_FONT" -fill "#E53E3E" -pointsize 48 \
  -stroke black -strokewidth 3 -annotate +0+24 "DEV" \
  -stroke none -fill white -annotate +0+24 "DEV" \
  "$RESOURCES_DIR/icon-dev.png"
echo "  -> resources/icon-dev.png (256x256 with DEV banner)"

# --- Step 6: macOS .icns
png2icns "$BUILD_DIR/icon.icns" "$BUILD_DIR/icon.png"
echo "  -> resources/build/icon.icns"

# --- Step 7: Windows .ico (multi-size)
magick "$BUILD_DIR/icon.png" -define icon:auto-resize=256,128,64,48,32,16 "$BUILD_DIR/icon.ico"
echo "  -> resources/build/icon.ico"

# --- Step 8: Copy source SVG to top-level resources
cp "$SVG_SOURCE" "$RESOURCES_DIR/logo.svg"
echo "  -> resources/logo.svg"

echo "Done!"
