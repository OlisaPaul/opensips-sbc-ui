#!/usr/bin/env bash
set -euo pipefail

DB_HOST="${DB_HOST:-127.0.0.1}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-opensips}"
DB_NAME="${DB_NAME:-opensips}"

if [[ -z "${DB_PASSWORD:-}" ]]; then
  echo "Set DB_PASSWORD before running this check."
  exit 1
fi

mysql_cmd=(
  mysql
  -h "$DB_HOST"
  -P "$DB_PORT"
  -u "$DB_USER"
  "-p$DB_PASSWORD"
  --batch
  --skip-column-names
  "$DB_NAME"
)

required_tables=(registrant dispatcher address did_mapping prefix_mapping)

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
for column in did dispatcher_set application_name enabled; do check_column did_mapping "$column"; done
for column in prefix dispatcher_set strip_prefix pilot_cli enabled; do check_column prefix_mapping "$column"; done

echo "Database preflight passed."
