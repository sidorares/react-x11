#!/bin/sh
# Build examples/form/build/Guestbook.app — the form example as a macOS app
# bundle, so it launches from the Finder and the Dock with its own name,
# icon and bundle identifier.
#
#   sh examples/form/make-app.sh
#
# The executable is a real binary: `bun build --compile` bundles main.js,
# the example and react-x11 into one Mach-O with bun's runtime inside, and
# AppKit takes its main bundle from the running executable's path, so the
# app is the app — no launcher, no runtime found at launch time. What a
# binary cannot contain is the Cocoa bridge's native addon, which the
# backend loads with `require` from a file; the bundle carries it in
# Contents/Resources and main.js names it before the backend goes looking.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
app="$here/build/Guestbook.app"

command -v bun >/dev/null || { echo "bun not found" >&2; exit 1; }
case "$(uname -m)" in
  arm64) arch=arm64 ;;
  x86_64) arch=x64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/Info.plist" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# the executable Info.plist names
bun build --compile --target="bun-darwin-$arch" "$here/main.js" \
  --outfile "$app/Contents/MacOS/Guestbook"

# the bridge's addon, for main.js to find
cp "$root/node_modules/@windowkit/appkit/prebuilds/darwin-$arch/calayers.node" \
  "$app/Contents/Resources/calayers.node"

# the icon: the SVG rendered by Quick Look, cut into the sizes an icon set
# wants, packed by iconutil
iconset="$here/build/Guestbook.iconset"
rm -rf "$iconset"; mkdir -p "$iconset"
qlmanage -t -s 1024 -o "$here/build" "$here/icon.svg" >/dev/null 2>&1
master="$here/build/icon.svg.png"
for size in 16 32 128 256 512; do
  sips -z $size $size "$master" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  sips -z $double $double "$master" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/Guestbook.icns"
rm -rf "$iconset" "$master"

echo "built $app"
