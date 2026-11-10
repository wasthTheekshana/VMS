# Visitor Management System (VMS)

Implements SRS-2026-VMS-001 following the "VMS Implementation Plan".
Stack: Next.js 15 (three portals) · NestJS 11 + Socket.IO · PostgreSQL 16 · Redis + BullMQ · Docker.

```
apps/api   NestJS REST + WebSocket API, Prisma schema/migrations, tests
apps/web   Next.js app: /guard (console), /host (portal), /admin (admin + department admin)
ops/       backup script, nginx snippet for the shared server
```

## Status: all 29 functional requirements and the 11 non-functional requirements are implemented

| Area | Requirements | Where |
|---|---|---|
| Login, roles, sessions | FR-1, NFR-3, NFR-5 | `auth`, `common/guards.ts` |
| Departments, guard rooms, users, guard assignment, pass categories | FR-2 – FR-6 | `departments`, `guard-rooms`, `users`, `pass-categories` |
| Host pre-registration, edit/cancel, groups | FR-7 – FR-9 | `visits` (`/api/visits`) · `/host` |
| Guard console: expected list, search, verify/edit, walk-in, check-in/out, returning visitor | FR-10 – FR-17 | `visits` (`/api/guard`) · `/guard` |
| Notifications: guard alert + sound, admin, host, visitor SMS, overstay | FR-18 – FR-22 | `notifications` (Socket.IO `/ws`, BullMQ) |
| Records search/filter/sort, department view | FR-23, FR-24 | `records` · `/admin` |
| Real-time dashboard, Excel/PDF export | FR-25, FR-26 | `dashboard`, `records/export` |
| Pass slip (print) | FR-27 | `/api/guard/visits/:id/slip` · guard console |
| Audit trail + viewer | FR-28, NFR-10 | `audit` (append-only table, DB trigger) |
| Watch list + single-use administrator approval | FR-29, UC-4 | `blacklist` |
| Retention + backups | NFR-9 | `common/retention.service.ts`, `ops/backup.sh` |

**SMS and e-mail are logged, not sent, until a gateway is chosen** (the plan's open question). Only
`apps/api/src/notifications/providers.ts` changes when the client picks Dialog / Mobitel / Notify.lk; SMTP works as soon as the `SMTP_*` variables are set.

## Run locally

```bash
cp .env.example .env            # fill in the secrets (commands are in the comments)
docker compose up -d            # Postgres :5432, Redis :6380 (localhost only)
cd apps/api && npm install
set -a; . ../../.env; set +a    # Prisma CLI reads DATABASE_URL from the environment
npx prisma migrate deploy
npm run seed                    # departments, 5 pass categories, 3 placeholder guard rooms, first super admin
npm run start:dev               # API on :4000
cd ../web && npm install && npm run dev    # UI on :3000, proxies /api to :4000
# optional, for live alerts in dev: NEXT_PUBLIC_WS_URL=http://localhost:4000
cd ../api && npm test           # 160+ unit/e2e tests (e2e needs Postgres and Redis running)
```

## Deploy (shared DOK server, domain vms.testsys.shop)

Full step-by-step commands (data folders, certificate, nginx, first start, updates) are in `ops/DEPLOY.md`.
In short: clone to `~/vms-stack`, create `.env` (secrets generated fresh, see the end of `.env.example`), create the data
folders on `/mnt/disks/data`, run the commands at the top of `docker-compose.prod.yml`, add `ops/nginx-vms.conf` to the shared
nginx, issue the certificate, then cron `ops/backup.sh` and do one restore drill before go-live.

The stack publishes no ports, joins `shared-nginx` only with `vms-web` and `vms-api`, keeps data on the data disk,
limits CPU/RAM/pids on every container, and never exposes Postgres or Redis.

## Security decisions (and the requirement each serves)

- **Deny by default**: global `AuthGuard` + `RolesGuard`; a route is open only if marked `@Public()` (NFR-5).
- **Sessions**: JWT in an `HttpOnly`, `SameSite=Strict`, `Secure` (production) cookie, so scripts cannot read it. Sliding idle expiry (`JWT_EXPIRES_IN`); the user is re-read from the DB on every request so deactivation is immediate; sockets are dropped on expiry/deactivation (NFR-3).
- **Passwords**: bcrypt cost 12, 10+ chars with a letter and a digit; same error and timing for unknown username vs wrong password; login limited to 5/min; self-service change requires the current password.
- **Data segregation**: `visitScope()` is the single place that decides which visits a role sees (FR-17, FR-24); unauthorised records return 404, not 403. Raw SQL for the dashboard has a tested twin (`scopeSql`).
- **PII** (NFR-4, PDPA): NIC/licence encrypted with AES-256-GCM, looked up via an HMAC hash; masked in lists, SMS, notifications and exports; shown in full only on a single in-scope record. Ciphertext/hash never leave the API.
- **Input / output**: `ValidationPipe` with whitelist + forbid unknown fields; sort fields are an allow-list; spreadsheet formulas in exported text are neutralised; `helmet`/CSP on the API, security headers on the web app; CORS limited to `WEB_ORIGIN`.
- **Audit**: logins, master-data changes, visit actions, exports, approvals; secrets stripped; `audit_log` rejects UPDATE/DELETE/TRUNCATE in the database.
- **Blacklist**: blocked at check-in and walk-in; override is a single-use administrator approval bound to the visitor and guard room.
- **Secrets**: none hard-coded; the API refuses to boot with weak or missing keys; `.env`/`.env.prod` are git-ignored.

## Known limits and decisions for the client

- Guard room names are placeholders until the client supplies them (seed data).
- A visitor can only be checked out at the guard room they entered (open question in the plan).
- Real-time delivery runs in a single API process; scaling out needs the Socket.IO Redis adapter.
- The audit log is never purged by the application (append-only). Retire old rows by archiving partitions as a DBA task.
- `npm audit` reports advisories in build-time tooling (Prisma CLI) and `multer` (unused: no file uploads); no fix is available without a major-version jump.
- Visitor e-mail is not collected (SMS only); adding a field is a small change if required.
- Offline guard-room operation (NFR-6 "where feasible") is not implemented: the console shows a clear reconnect banner instead.
- Sinhala labels (NFR-7) are not included; the UI is English.
