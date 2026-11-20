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
stamp="$(date -u +%Y%m%d-%H%M%S)"
out="$backup_dir/${prefix}-${stamp}.sql"
# Дамп лише даних — для відновлення (R-2 В1): повний дамп пише INSERT дочірньої таблиці до CREATE TABLE батьківської
# і в чисту БД не відновлюється. Рецепт: міграції в нову БД → execute --file цього файлу (RUNBOOK).
data="$backup_dir/${prefix}-${stamp}-data.sql"

# Будь-який вихід з помилкою — прибрати недописані файли.
trap 'code=$?; if [ $code -ne 0 ]; then rm -f "$out" "$data" "$data.tmp"; echo "Бекап не вдався (код $code), $out і $data видалено" >&2; fi' EXIT

"${NPX:-npx}" wrangler d1 export "$db" --remote --env "$env_name" --output "$out"
"${NPX:-npx}" wrangler d1 export "$db" --remote --env "$env_name" --no-schema --output "$data.tmp"
# d1_migrations у новій БД пише сам `migrations apply` — його рядки в дампі даних дали б конфлікт PK.
grep -v -e '^INSERT INTO "d1_migrations"' -e "^INSERT INTO \"sqlite_sequence\" (\"name\",\"seq\") VALUES('d1_migrations'" "$data.tmp" > "$data" || true
rm -f "$data.tmp"

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

# Дані на місці: рядків INSERT кожної таблиці в дампі даних = COUNT(*) у БД (R-2 В1). Одним рядком із підзапитами —
# D1 не приймає довгий UNION ALL. Розбіжність — запис між export і COUNT або обрізаний дамп: повтори бекап.
data_tables=$(printf '%s\n' $tables | grep -vx 'd1_migrations' || true)
if [ -n "$data_tables" ]; then
  count_sql="SELECT $(printf '%s\n' $data_tables | sed 's/.*/(SELECT count(*) FROM "&") AS "&"/' | paste -sd, -)"
  counts=$("${NPX:-npx}" wrangler d1 execute "$db" --remote --env "$env_name" --json --command "$count_sql" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const[k,v]of Object.entries(JSON.parse(s)[0].results[0]))console.log(k+" "+v)})')
  summary=""
  while read -r table n; do
    [ -z "$table" ] && continue
    got=$(grep -c "^INSERT INTO \"${table}\"" "$data" || true)
    if [ "$got" != "$n" ]; then
      echo "У дампі даних $table: $got рядків, у БД: $n — дані змінились під час бекапу або дамп неповний; повтори" >&2
      exit 1
    fi
    summary="$summary $table=$n"
  done <<< "$counts"
  echo "Рядки (дамп = БД):$summary"
fi

echo "Бекап: $out ($(wc -c < "$out") байт); дані для відновлення: $data ($(wc -c < "$data") байт)"
