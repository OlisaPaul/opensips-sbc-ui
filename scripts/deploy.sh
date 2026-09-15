#!/usr/bin/env bash
set -euo pipefail

deploy_config="${DEPLOY_CONFIG:-/etc/opensips-sbc-ui/deploy.env}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this script as root: sudo bash scripts/deploy.sh"
  exit 1
fi

if [[ ! -f "$deploy_config" ]]; then
  echo "Deployment settings file not found: $deploy_config"
  echo "Create it from deploy/deploy.env.example and protect it with mode 600."
  exit 1
fi

if [[ "$(stat -c '%U' "$deploy_config")" != "root" ]]; then
  echo "Deployment settings must be owned by root: $deploy_config"
  exit 1
fi

if [[ -n "$(find "$deploy_config" -prune -perm /077 -print -quit)" ]]; then
  echo "Deployment settings must not be accessible by group or other users."
  echo "Run: chmod 600 $deploy_config"
  exit 1
fi

# This file is trusted because it is root-owned and private. Export its values
# so the existing installer remains the single implementation of deployment.
set -a
# shellcheck disable=SC1090
source "$deploy_config"
set +a

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$script_dir/install-https-nginx.sh"
