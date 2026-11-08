#!/bin/sh
# Fails when a tracked image carries EXIF, XMP, IPTC, Photoshop, GPS, PNG text or comment metadata.
# PNG pixel and colour chunks (IHDR, sRGB, gAMA, pHYs, ...) are not metadata and are ignored.
# Checks the committed blobs (the index), so a stale working copy cannot hide anything.
#   check-image-metadata.sh            every tracked image (CI)
#   check-image-metadata.sh --staged   staged added/modified/renamed images (pre-commit)
set -u

# Everything exiftool reports in these groups, except the structural PNG tags.
TAGS="-exif:all -xmp:all -iptc:all -gps:all -photoshop:all -comment -png:all
  --png:ImageWidth --png:ImageHeight --png:BitDepth --png:ColorType --png:Compression
  --png:Filter --png:Interlace --png:Gamma --png:SRGBRendering --png:PixelsPerUnitX
  --png:PixelsPerUnitY --png:PixelUnits --png:WhitePoint --png:PrimaryChromaticities
  --png:Transparency --png:Background --png:SignificantBits --png:Palette --png:ModifyDate"

IMAGES=':(icase)*.jpg :(icase)*.jpeg :(icase)*.png :(icase)*.gif :(icase)*.webp :(icase)*.tif :(icase)*.tiff :(icase)*.heic'

if ! command -v exiftool >/dev/null 2>&1; then
  echo "exiftool is required to check image metadata (macOS: brew install exiftool, Ubuntu: sudo apt-get install libimage-exiftool-perl)" >&2
  exit 1
fi

if [ "${1:-}" = "--staged" ]; then
  # shellcheck disable=SC2086
  files=$(git diff --cached --name-only --diff-filter=ACMR -- $IMAGES)
else
  # shellcheck disable=SC2086
  files=$(git ls-files -- $IMAGES)
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Reports every offending image on stderr, and prints its name on stdout.
# An image that cannot be read counts as offending: it must not pass unchecked.
bad=$(printf '%s\n' "$files" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  if ! git show ":$f" >"$tmp"; then
    echo "cannot read $f" >&2
    echo "$f"
    continue
  fi
  # exiftool exits 0 on content it cannot parse and calls it plain text, so check the type as well.
  type=$(exiftool -q -q -s3 -FileType "$tmp") || type=
  if [ -z "$type" ] || [ "$type" = TXT ]; then
    echo "cannot read $f (not a readable image)" >&2
    echo "$f"
    continue
  fi
  # shellcheck disable=SC2086
  found=$(exiftool -q -q -G1 -a -s $TAGS "$tmp") || {
    echo "cannot read $f (exiftool failed)" >&2
    echo "$f"
    continue
  }
  [ -z "$found" ] && continue
  echo "metadata in $f:" >&2
  echo "$found" | sed 's/^/  /' >&2
  echo "$f"
done)

[ -z "$bad" ]
