#!/bin/sh
# Build examples/form/build/Guestbook.app — the form example as a macOS app
# bundle, so it launches from the Finder and the Dock with its own name,
# icon and bundle identifier.
#
#   sh examples/form/make-app.sh        # node, through tsx
#   sh examples/form/make-app.sh --bun  # bun runs the JSX itself
#
# The runtime goes *inside* the bundle: AppKit takes its main bundle from
# the path of the running executable, so a launcher that exec'd a node
# outside Contents/MacOS would leave the app named "node" with no icon and
# with the `node` (or `bun`) defaults domain — where a tab bar an earlier
# process turned on is remembered. A hard link where the filesystem allows
# it, a copy where it does not; either way the executable path is the
# bundle's. The launcher then hands the runtime its arguments, which Launch
# Services never passes.
set -e
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
app="$here/build/Guestbook.app"
entry="$here/index.jsx"

if [ "$1" = "--bun" ]; then
  runtime=$(command -v bun) || { echo "bun not found" >&2; exit 1; }
  args=""
else
  runtime=$(command -v node) || { echo "node not found" >&2; exit 1; }
  args="--import tsx"
fi

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$here/Info.plist" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

# the runtime, at a path inside the bundle
ln "$runtime" "$app/Contents/MacOS/runtime" 2>/dev/null || cp "$runtime" "$app/Contents/MacOS/runtime"

# the executable Info.plist names: a launcher that runs the example on that
# runtime, from the repo root so `tsx` and the example's imports resolve
cat > "$app/Contents/MacOS/Guestbook" <<LAUNCHER
#!/bin/sh
cd "$root"
exec "\$(dirname "\$0")/runtime" $args "$entry"
LAUNCHER
chmod +x "$app/Contents/MacOS/Guestbook"

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

echo "built $app ($(basename "$runtime")$( [ -n "$args" ] && echo " $args"))"
