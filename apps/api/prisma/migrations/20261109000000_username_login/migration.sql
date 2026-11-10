-- Login by username. Backfill from the email local part, de-duplicating with a numeric suffix.
ALTER TABLE "users" ADD COLUMN "username" TEXT;

UPDATE "users" u SET "username" = s.uname FROM (
  SELECT id,
         CASE WHEN rn = 1 THEN base ELSE base || rn::text END AS uname
  FROM (
    SELECT id, base, row_number() OVER (PARTITION BY base ORDER BY created_at, id) AS rn
    FROM (SELECT id, created_at, lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9._-]', '', 'g')) AS base FROM "users") b
  ) r
) s WHERE u.id = s.id;

ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;

-- Which guard recorded the exit (per-guard check-out summary).
ALTER TABLE "visits" ADD COLUMN "checked_out_by" UUID;
-- Best effort for history: the audit log knows who performed each check_out.
UPDATE "visits" v SET "checked_out_by" = a.user_id
FROM (SELECT DISTINCT ON (entity_id) entity_id, user_id FROM "audit_log" WHERE action = 'check_out' ORDER BY entity_id, created_at DESC) a
WHERE a.entity_id = v.id::text AND v.status = 'checked_out';
ALTER TABLE "visits" ADD CONSTRAINT "visits_checked_out_by_fkey" FOREIGN KEY ("checked_out_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "visits_checked_out_by_time_out_idx" ON "visits"("checked_out_by", "time_out");
