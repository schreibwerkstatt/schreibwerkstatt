#!/bin/bash
# Schreibwerkstatt – Installer
# Läuft auf dem LXC wo writing.david-berger.ch läuft
# Usage: bash install.sh

set -euo pipefail

INSTALL_DIR="/opt/schreibwerkstatt"
SERVICE="schreibwerkstatt"
PORT=3737

echo ""
echo "=== Schreibwerkstatt Installer ==="
echo ""

# Node.js prüfen — fehlt es oder ist es älter als package.json#engines (>=22),
# wird Node 22 installiert. Native Module wie better-sqlite3 liefern für ältere
# Majors keine Prebuilds mehr; ohne Build-Toolchain scheitert dann `npm install`.
NODE_MAJOR=24
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if ! command -v node &>/dev/null || [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Node.js fehlt oder ist zu alt. Installiere Node.js ${NODE_MAJOR} (LTS)..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
if [ "$(node_major)" -lt "$NODE_MAJOR" ]; then
  echo "Node.js $(node -v) ist noch zu alt — altes nodejs/npm-Paket entfernen (apt-get remove nodejs npm) und erneut starten." >&2
  exit 1
fi
echo "Node.js: $(node -v)"

# Zielverzeichnis anlegen
echo "Installiere nach $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r . "$INSTALL_DIR/"

# npm install
cd "$INSTALL_DIR"
echo "Installiere npm-Abhängigkeiten..."
npm install --omit=dev --quiet

# Systemd Service installieren
echo "Installiere systemd service..."
cp deploy/schreibwerkstatt.service "/etc/systemd/system/${SERVICE}.service"

# Backup-Service + täglicher Timer (Config via .env; siehe deploy/backup.sh)
echo "Installiere Backup-Timer..."
cp deploy/schreibwerkstatt-backup.service /etc/systemd/system/
cp deploy/schreibwerkstatt-backup.timer   /etc/systemd/system/
chmod +x "$INSTALL_DIR/deploy/backup.sh"

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl enable --now schreibwerkstatt-backup.timer
systemctl restart "$SERVICE"

# Status prüfen
sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "✓ Schreibwerkstatt läuft auf http://$(hostname -I | awk '{print $1}'):${PORT}"
  echo ""
  echo "Nützliche Befehle:"
  echo "  systemctl status $SERVICE"
  echo "  journalctl -u $SERVICE -f"
  echo "  systemctl restart $SERVICE"
else
  echo ""
  echo "✗ Service konnte nicht gestartet werden. Logs:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi
