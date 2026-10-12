#!/usr/bin/env bash
set -euo pipefail

# Deliberately separate from the web installer; installs but never enables capture.
[[ "$EUID" -eq 0 ]] || { echo "Run with sudo bash scripts/install-dtmf-monitor.sh"; exit 1; }
project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v node >/dev/null || { echo "Install Node.js 20+ first."; exit 1; }
node_major="$(node -p 'process.versions.node.split(".")[0]')"
(( node_major >= 20 )) || { echo "Node.js 20+ is required."; exit 1; }
node_path="$(command -v node)"
[[ "$node_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo "Unsupported Node executable path."; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required."; exit 1; }
if ! id sbc-dtmf >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --shell /sbin/nologin sbc-dtmf
fi
install -d -o root -g root -m 755 /opt/sbc-dtmf
for file in "$project_dir"/monitoring/dtmf/*.mjs; do
  target="/opt/sbc-dtmf/$(basename "$file")"
  if [[ "$(readlink -f "$file")" != "$(readlink -m "$target")" ]]; then install -o root -g root -m 644 "$file" "$target"; fi
done
install -d -o root -g sbc-dtmf -m 750 /etc/sbc-dtmf
install -d -o sbc-dtmf -g sbc-dtmf -m 700 /var/lib/sbc-dtmf/capture /var/lib/sbc-dtmf/results
if [[ ! -e /etc/sbc-dtmf/monitor.json ]]; then
  install -o root -g sbc-dtmf -m 640 "$project_dir/deploy/dtmf-monitor.example.json" /etc/sbc-dtmf/monitor.json
fi
for unit in sbc-dtmf-capture sbc-dtmf-worker; do
  sed "s|/usr/bin/node |$node_path |" "$project_dir/deploy/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload
echo "Installed, not started/enabled. Edit /etc/sbc-dtmf/monitor.json and follow DEPLOYMENT.md."
echo "No SIP, RTPengine, Nginx or database settings were changed."
