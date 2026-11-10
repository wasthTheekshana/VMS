-- Session revocation: tokens carry the user's token_version; bumping it logs every session out.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;

-- Visit-level copy of the visitor details so hosts never read or edit the shared visitor record.
ALTER TABLE "visits" ADD COLUMN "visitor_name" TEXT,
ADD COLUMN "visitor_phone" TEXT,
ADD COLUMN "visitor_company" TEXT;

-- Backfill existing visits from the visitor each one points to.
UPDATE "visits" v
SET "visitor_name" = vr."full_name", "visitor_phone" = vr."phone", "visitor_company" = vr."company"
FROM "visitors" vr
WHERE vr."id" = v."visitor_id";
