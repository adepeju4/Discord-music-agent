#!/usr/bin/env bash
#
# Provisions a Debian/Ubuntu host (Contabo VPS, Raspberry Pi, anything apt-based)
# to run the bot as a systemd service.
#
#   git clone https://github.com/adepeju4/Discord-music-agent.git
#   cd Discord-music-agent
#   ./deploy/setup.sh
#
# Safe to re-run: it installs what is missing, rebuilds, and restarts.

set -euo pipefail

SERVICE_NAME="discord-music"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$1"; }
die() {
  printf '\033[1;31m !! %s\033[0m\n' "$1" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "Run with sudo: sudo ./deploy/setup.sh"
command -v apt-get >/dev/null || die "This script expects a Debian/Ubuntu host."

say "Installing system packages"
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl git ffmpeg python3-pip build-essential

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
say "Node $(node -v)"

say "Installing/updating yt-dlp"
# --break-system-packages is needed on Debian 12+ (PEP 668); harmless elsewhere.
sudo -u "$RUN_USER" pip3 install --user --upgrade --break-system-packages yt-dlp 2>/dev/null ||
  sudo -u "$RUN_USER" pip3 install --user --upgrade yt-dlp
YT_DLP="$RUN_HOME/.local/bin/yt-dlp"
[ -x "$YT_DLP" ] || YT_DLP="$(command -v yt-dlp || true)"
[ -n "$YT_DLP" ] || die "yt-dlp did not install. Install it manually and set YTDLP_PATH in .env."
say "yt-dlp $("$YT_DLP" --version)"

if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  chown "$RUN_USER" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  warn "Created .env from the example — fill in DISCORD_TOKEN, CLIENT_ID and GEMINI_API_KEY, then re-run this script."
  exit 1
fi

for key in DISCORD_TOKEN CLIENT_ID GEMINI_API_KEY; do
  grep -qE "^${key}=.+" "$REPO_DIR/.env" || die ".env is missing $key"
done

if grep -qE '^YT_COOKIES_FROM_BROWSER=' "$REPO_DIR/.env"; then
  warn "YT_COOKIES_FROM_BROWSER is set, but a server has no browser or keychain."
  warn "Copy a cookies file over instead and set YT_COOKIES_FILE. See the README."
fi

say "Installing dependencies and building"
sudo -u "$RUN_USER" npm ci --prefix "$REPO_DIR"
sudo -u "$RUN_USER" npm run build --prefix "$REPO_DIR"

say "Installing the $SERVICE_NAME service"
sed -e "s|__USER__|$RUN_USER|g" \
  -e "s|__WORKDIR__|$REPO_DIR|g" \
  -e "s|__HOME__|$RUN_HOME|g" \
  -e "s|__NODE__|$(command -v node)|g" \
  "$REPO_DIR/deploy/$SERVICE_NAME.service" >"/etc/systemd/system/$SERVICE_NAME.service"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  say "Running. Follow the logs with: journalctl -u $SERVICE_NAME -f"
  warn "Slash commands are registered separately — run this once, and again whenever commands change:"
  printf '    sudo -u %s npm run deploy --prefix %s\n' "$RUN_USER" "$REPO_DIR"
else
  systemctl status "$SERVICE_NAME" --no-pager -l | tail -20
  die "Service failed to start — see the output above."
fi
