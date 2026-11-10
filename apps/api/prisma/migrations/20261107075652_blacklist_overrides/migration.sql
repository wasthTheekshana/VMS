-- AlterTable
ALTER TABLE "blacklist" ADD COLUMN     "nic_masked" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "blacklist_overrides" (
    "id" UUID NOT NULL,
    "nic_hash" TEXT NOT NULL,
    "guard_room_id" UUID NOT NULL,
    "visit_id" UUID,
    "remark" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requested_by" UUID NOT NULL,
    "decided_by" UUID,
    "decision_note" TEXT,
    "decided_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blacklist_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "blacklist_overrides_status_created_at_idx" ON "blacklist_overrides"("status", "created_at");

-- CreateIndex
CREATE INDEX "blacklist_overrides_nic_hash_guard_room_id_status_idx" ON "blacklist_overrides"("nic_hash", "guard_room_id", "status");
