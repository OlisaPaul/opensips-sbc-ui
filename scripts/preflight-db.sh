#!/usr/bin/env bash
set -euo pipefail

db_host_value="${DB_HOST:-}"
db_port_value="${DB_PORT:-}"
db_user_value="${DB_USER:-}"
db_password_value="${DB_PASSWORD:-}"
db_name_value="${DB_NAME:-}"

if [[ -n "${ENV_FILE:-}" ]]; then
  if [[ ! -r "$ENV_FILE" ]]; then
    echo "Cannot read ENV_FILE: $ENV_FILE"
    exit 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* || "$line" != *=* ]] && continue
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$value" == \"*\" && "$value" == *\" ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
      value="${value:1:${#value}-2}"
    fi

    case "$key" in
      DB_HOST) [[ -z "$db_host_value" ]] && db_host_value="$value" ;;
      DB_PORT) [[ -z "$db_port_value" ]] && db_port_value="$value" ;;
      DB_USER) [[ -z "$db_user_value" ]] && db_user_value="$value" ;;
      DB_PASSWORD) [[ -z "$db_password_value" ]] && db_password_value="$value" ;;
      DB_NAME) [[ -z "$db_name_value" ]] && db_name_value="$value" ;;
    esac
  done < "$ENV_FILE"
fi

DB_HOST="${db_host_value:-127.0.0.1}"
DB_PORT="${db_port_value:-3306}"
DB_USER="${db_user_value:-opensips}"
DB_PASSWORD="$db_password_value"
DB_NAME="${db_name_value:-opensips}"

if [[ -z "${DB_PASSWORD:-}" ]]; then
  echo "Set DB_PASSWORD before running this check."
  exit 1
fi

if command -v mariadb >/dev/null 2>&1; then
  database_client="mariadb"
elif command -v mysql >/dev/null 2>&1; then
  database_client="mysql"
else
  echo "Install a MariaDB or MySQL command-line client before running this check."
  exit 1
fi

mysql_cmd=(
  "$database_client"
  -h "$DB_HOST"
  -P "$DB_PORT"
  -u "$DB_USER"
  "-p$DB_PASSWORD"
  --batch
  --skip-column-names
  "$DB_NAME"
)

required_tables=(registrant dispatcher address did_mapping did_provider_mapping prefix_mapping sbc_trunks sbc_audit_log)

echo "Checking required OpenSIPS tables in $DB_NAME..."
for table in "${required_tables[@]}"; do
  count="$("${mysql_cmd[@]}" -e "select count(*) from information_schema.tables where table_schema = database() and table_name = '$table';")"
  if [[ "$count" != "1" ]]; then
    echo "Missing table: $table"
    exit 1
  fi
  echo "OK table: $table"
done

check_column() {
  local table="$1"
  local column="$2"
  local count
  count="$("${mysql_cmd[@]}" -e "select count(*) from information_schema.columns where table_schema = database() and table_name = '$table' and column_name = '$column';")"
  if [[ "$count" != "1" ]]; then
    echo "Missing column: $table.$column"
    exit 1
  fi
}

echo "Checking required columns..."
for column in registrar proxy aor username password binding_uri; do check_column registrant "$column"; done
for column in setid destination state weight priority attrs description; do check_column dispatcher "$column"; done
for column in grp ip mask port proto pattern context_info; do check_column address "$column"; done
for column in id start_did end_did destination_set_id description; do check_column did_mapping "$column"; done
for column in id start_did end_did provider sipline_set_id description; do check_column did_provider_mapping "$column"; done
for column in id prefix sipline_set_id description routing_mode strip_prefix; do check_column prefix_mapping "$column"; done
for column in id name provider_ip provider_port username encrypted_password registration_enabled registration_server application_name application_ip application_port access_prefix strip_prefix pilot_cli provider_dispatcher_set application_dispatcher_set created_at updated_at; do check_column sbc_trunks "$column"; done
for column in id action actor target payload_json created_at; do check_column sbc_audit_log "$column"; done

for column in application_name application_ip application_port access_prefix strip_prefix pilot_cli application_dispatcher_set; do
  nullable="$("${mysql_cmd[@]}" -e "select is_nullable from information_schema.columns where table_schema = database() and table_name = 'sbc_trunks' and column_name = '$column';")"
  if [[ "$nullable" != "YES" ]]; then
    echo "Migration required: sbc_trunks.$column must be nullable."
    echo "Run: $database_client -h $DB_HOST -P $DB_PORT -u $DB_USER -p $DB_NAME < database/migrations/001_separate_routing.sql"
    exit 1
  fi
done

echo "Database preflight passed."
