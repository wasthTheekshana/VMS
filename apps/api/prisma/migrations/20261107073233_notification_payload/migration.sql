-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "payload" JSONB,
ADD COLUMN     "read_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "notifications_recipient_user_id_channel_created_at_idx" ON "notifications"("recipient_user_id", "channel", "created_at");

-- CreateIndex
CREATE INDEX "notifications_status_channel_idx" ON "notifications"("status", "channel");

-- CreateIndex
CREATE INDEX "notifications_visit_id_event_idx" ON "notifications"("visit_id", "event");
