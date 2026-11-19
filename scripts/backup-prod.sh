#!/usr/bin/env bash
# Бекап D1 у backups/<prefix>-YYYYMMDD-HHMMSS.sql (UTC). Перед кожною міграцією прода.
#   bash scripts/backup-prod.sh              # production (npm run backup:prod)
#   bash scripts/backup-prod.sh preview      # репетиція на preview
set -euo pipefail

env_name="${1:-production}"
case "$env_name" in
  production) db="trener-prod"; prefix="prod" ;;
  preview) db="trener-preview"; prefix="preview" ;;
  *) echo "Невідоме середовище: $env_name (production | preview)" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."
backup_dir="${BACKUP_DIR:-backups}"
mkdir -p "$backup_dir"
out="$backup_dir/${prefix}-$(date -u +%Y%m%d-%H%M%S).sql"

# Будь-який вихід з помилкою — прибрати недописаний файл.
trap 'code=$?; if [ $code -ne 0 ]; then rm -f "$out"; echo "Бекап не вдався (код $code), $out видалено" >&2; fi' EXIT

"${NPX:-npx}" wrangler d1 export "$db" --remote --env "$env_name" --output "$out"

if [ ! -s "$out" ]; then
  echo "Порожній файл бекапу" >&2
  exit 1
fi
# Таблиці беремо з самої БД, а не списком у скрипті: нові фази додають свої.
tables=$("${NPX:-npx}" wrangler d1 execute "$db" --remote --env "$env_name" --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s)[0].results)console.log(r.name)})')
if [ -z "$tables" ]; then
  # Порожня БД (перший реліз прода) — легітимно, але лише коли export рівно «порожній»: один рядок PRAGMA.
  # Будь-що інше (CREATE TABLE, сміття) при порожньому списку — список прочитано хибно.
  if [ "$(tr -d '[:space:]' < "$out")" != "PRAGMAdefer_foreign_keys=TRUE;" ]; then
    echo "Список таблиць порожній, але export не схожий на export порожньої БД" >&2
    exit 1
  fi
  echo "БД порожня (таблиць немає): перевірку CREATE TABLE пропущено, файл бекапу — лише для репетиції" >&2
fi
for table in $tables; do
  # export пише і `CREATE TABLE \`users\``, і `CREATE TABLE IF NOT EXISTS "d1_migrations"`.
  if ! grep -qiE "CREATE TABLE (IF NOT EXISTS )?[\`\"']?${table}[\`\"' (]" "$out"; then
    echo "У бекапі немає CREATE TABLE для $table" >&2
    exit 1
  fi
done

echo "Бекап: $out ($(wc -c < "$out") байт)"
