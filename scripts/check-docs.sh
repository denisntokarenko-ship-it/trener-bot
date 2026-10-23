#!/bin/sh
# Червоніє, якщо файл, який читає агент, переріс бюджет 40 КБ.
LIMIT=40960
fail=0
for f in docs/spec/*.md CLAUDE.md docs/PROGRESS.md; do
  [ -f "$f" ] || continue
  size=$(wc -c < "$f")
  [ "$size" -le "$LIMIT" ] && continue
  echo "ЧЕРВОНЕ: $f — $size Б > $LIMIT Б: ріж на зрізи"
  fail=1
done
exit $fail
