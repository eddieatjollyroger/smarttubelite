#!/bin/sh
# Deploy TubeTV to the Raspberry Pi and rebuild the container.
#
#   ./deploy.sh                 # eddie@192.168.1.69
#   ./deploy.sh eddie@192.168.1.69
#
# The Pi moved to 192.168.1.69 (DHCP). Give it a DHCP reservation in the router
# so the TV's bookmark does not break again. The host account is `eddie`
# (`edberry5`), not `pi`/`joao`.
set -eu

TARGET="${1:-eddie@192.168.1.69}"
HOST="${TARGET#*@}"
DEST="/mnt/ssd1/tubetv/smarttubelite"
SRC="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

echo "==> source: $SRC"
echo "==> target: $TARGET:$DEST"

# data/ holds auth.json on the Pi and must never be overwritten from here.
# bin/ is the Mac's yt-dlp; the container downloads its own.
rsync -av --delete \
  --exclude 'data/' \
  --exclude 'bin/' \
  --exclude 'node_modules/' \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude '*.part' \
  --exclude '*.ytdl' \
  --exclude '*.mp4' \
  --exclude '*.webm' \
  "$SRC/" "$TARGET:$DEST/"

echo "==> rebuilding container (this can take a few minutes on the Pi)"
ssh "$TARGET" "cd '$DEST' && docker compose up -d --build tubetv"

echo "==> waiting for health"
i=0
while [ "$i" -lt 20 ]; do
  i=$((i + 1))
  sleep 3
  if out=$(curl -fsS --max-time 5 "http://$HOST:8484/healthz" 2>/dev/null); then
    echo "$out"
    case "$out" in
      *'"build":"2026-11-11.2"'*) echo "==> deployed"; exit 0 ;;
      *) echo "!! health responded but the build is not 2026-11-11.2" >&2; exit 1 ;;
    esac
  fi
done

echo "!! health check never came up; check: ssh $TARGET 'docker logs --tail 80 tubetv'" >&2
exit 1
