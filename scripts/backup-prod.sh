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
mkdir -p backups
out="backups/${prefix}-$(date -u +%Y%m%d-%H%M%S).sql"

# Будь-який вихід з помилкою — прибрати недописаний файл.
trap 'code=$?; if [ $code -ne 0 ]; then rm -f "$out"; echo "Бекап не вдався (код $code), $out видалено" >&2; fi' EXIT

npx wrangler d1 export "$db" --remote --env "$env_name" --output "$out"

if [ ! -s "$out" ]; then
  echo "Порожній файл бекапу" >&2
  exit 1
fi
# Таблиці беремо з самої БД, а не списком у скрипті: нові фази додають свої.
tables=$(npx wrangler d1 execute "$db" --remote --env "$env_name" --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s)[0].results)console.log(r.name)})')
if [ -z "$tables" ]; then
  echo "Не вдалося прочитати список таблиць" >&2
  exit 1
fi
for table in $tables; do
  if ! grep -qiE "CREATE TABLE [\`\"']?${table}[\`\"']?" "$out"; then
    echo "У бекапі немає CREATE TABLE для $table" >&2
    exit 1
  fi
done

echo "Бекап: $out ($(wc -c < "$out") байт)"
