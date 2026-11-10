#!/usr/bin/env bash
# Daily PostgreSQL backup with 30-day retention (NFR-9). Run from cron, e.g.:
#   15 2 * * *  cd ~/vms-stack && ./ops/backup.sh >> ~/vms-stack/backup.log 2>&1
# Restore drill:  gunzip -c <file> | docker compose -f docker-compose.prod.yml exec -T vms-db psql -U vms -d vms
set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/mnt/disks/data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_ROOT/backups/vms}"
KEEP_DAYS="${KEEP_DAYS:-30}"
COMPOSE=(docker compose -f docker-compose.prod.yml)

umask 077 # dumps contain personal data: owner-only
mkdir -p "$BACKUP_DIR"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/vms-$stamp.sql.gz"

"${COMPOSE[@]}" exec -T vms-db pg_dump -U vms --no-owner vms | gzip -9 > "$out.partial"
gzip -t "$out.partial"                       # refuse to keep a corrupt dump
[ "$(stat -c %s "$out.partial")" -gt 1024 ]  # ...or an empty one
mv "$out.partial" "$out"

find "$BACKUP_DIR" -name 'vms-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "$(date -Is) backup ok: $out ($(du -h "$out" | cut -f1))"
