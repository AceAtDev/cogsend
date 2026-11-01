-- 0024: review before publishing, per-brand pause, and an activity log.
-- Deliveries an agent (API key or MCP) creates on a brand that requires
-- approval wait in `publish_targets.status = 'awaiting_review'`, which the
-- scheduler never claims, until the operator approves or rejects them. The
-- review columns keep the reviewer's note for the agent to read, when it was
-- reviewed, and when the tick first saw a held delivery's time pass (so the
-- overdue alert fires once). `require_approval` defaults to 1, so existing
-- brands hold agent writes too; `paused_at` set means the brand publishes
-- nothing until it is cleared. The activity log records who changed what.
ALTER TABLE `brands` ADD COLUMN `require_approval` integer NOT NULL DEFAULT 1;
ALTER TABLE `brands` ADD COLUMN `paused_at` integer;
ALTER TABLE `publish_targets` ADD COLUMN `review_note` text;
ALTER TABLE `publish_targets` ADD COLUMN `reviewed_at` integer;
ALTER TABLE `publish_targets` ADD COLUMN `review_overdue_at` integer;
CREATE TABLE IF NOT EXISTS `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`actor_type` text NOT NULL,
	`actor_id` text,
	`actor_label` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`summary` text NOT NULL,
	`before_summary` text,
	`after_summary` text,
	`created_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `activity_log_user_created_idx` ON `activity_log` (`user_id`, `created_at`);
CREATE INDEX IF NOT EXISTS `activity_log_created_idx` ON `activity_log` (`created_at`);
