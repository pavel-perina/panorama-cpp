# Self-hosted deployment (podman quadlet)

Stock `nginx:1-alpine-slim` + three named volumes; nothing is baked into an
image, so `AutoUpdate=registry` keeps nginx current and app/data update by
rerunning the deploy script.

```sh
cp deploy/panorama.container ~/.config/containers/systemd/
systemctl --user daemon-reload
deploy/deploy.sh data          # first time: config + app + ~800 MB tiles
systemctl --user start panorama
curl -sI localhost:8081/       # 200 -> point Cloudflare at :8081
```

The app is served at `/` (deploy.sh puts index.html at the volume root, so
there is no `/web/` in URLs and no redirect).

After a `cmake --build build-wasm` or web/ change: `deploy/deploy.sh` and
hard-refresh (app is served `no-cache`). After a data refresh:
`deploy/deploy.sh data` (rsync, only new tiles transfer). Neither needs a
container restart.

The health check asserts both volumes are mounted (fetches one file from
each), so a started-but-empty deployment shows up as `unhealthy` in
`podman ps` rather than as silent 404s.

`GET /data/hgt3-zst/` returns the tile list as JSON (nginx autoindex) — the
data-discovery endpoint for the app once it learns to consult it instead of
probing tiles blindly.
