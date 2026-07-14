#!/bin/sh
# Populate the named volumes for panorama.container from this checkout.
#
#   deploy/deploy.sh          # conf + app (fast: config, web/, pano.js/wasm)
#   deploy/deploy.sh data     # also sync heightmaps + peaks DB (~800 MB, rsync)
#
# Run before the first `systemctl --user start panorama`, and after every
# `cmake --build build-wasm` / data refresh. Rootless podman keeps volume
# contents under the user's own uid, so we write straight into the volume
# mountpoint from the host — no helper container, and rsync can do delta
# updates on the tile mirror.

set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)

vol() {
    podman volume exists "$1" || podman volume create "$1" >/dev/null
    podman volume inspect "$1" --format '{{.Mountpoint}}'
}

conf=$(vol panorama-conf)
app=$(vol panorama-app)

install -m 644 "$repo/deploy/nginx-panorama.conf" "$conf/default.conf"

# App goes to the volume root (no /web/ in URLs); index.html's relative
# ../build-wasm and ../data references still resolve from /.
rm -rf "$app/web"    # layout of earlier deploys
mkdir -p "$app/build-wasm"
install -m 644 "$repo/web/index.html" "$repo/web/app.js" "$app/"
install -m 644 "$repo/build-wasm/pano.js" "$repo/build-wasm/pano.wasm" "$app/build-wasm/"
echo "conf + app deployed"

if [ "${1:-}" = "data" ]; then
    data=$(vol panorama-data)
    # Only what the web app fetches; fonts/ and the raw pipeline outputs are
    # native-side. No --delete: extra tiles dropped in by hand stay.
    rsync -a --info=stats1 "$repo/data/hgt3-zst" "$data/"
    rsync -a "$repo/data/peaks-rated.tsv" "$repo/data/summits.tsv" "$data/"
    echo "data deployed"
fi
