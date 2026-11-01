-- 0027: performance metrics of published deliveries. `delivery_metrics` holds
-- one row per published delivery: the latest counts, when the next snapshot is
-- due (about 1h, 24h and 7d after publishing) and why it could not be read.
-- `delivery_metric_snapshots` keeps every read with its timestamp. Both carry
-- user_id so every read is scoped to one account without a join.
CREATE TABLE IF NOT EXISTS `delivery_metrics` (
	`target_id` text PRIMARY KEY NOT NULL REFERENCES `publish_targets`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`platform` text NOT NULL,
	`published_at` integer NOT NULL,
	`stage` integer NOT NULL DEFAULT 0,
	`next_due_at` integer,
	`state` text NOT NULL DEFAULT 'pending',
	`state_detail` text,
	`failures` integer NOT NULL DEFAULT 0,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`quotes` integer,
	`views` integer,
	`impressions` integer,
	`clicks` integer,
	`collected_at` integer,
	`updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `delivery_metrics_due_idx` ON `delivery_metrics` (`next_due_at`);
CREATE INDEX IF NOT EXISTS `delivery_metrics_user_published_idx` ON `delivery_metrics` (`user_id`, `published_at`);
CREATE TABLE IF NOT EXISTS `delivery_metric_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL REFERENCES `publish_targets`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`kind` text NOT NULL,
	`collected_at` integer NOT NULL,
	`likes` integer,
	`comments` integer,
	`shares` integer,
	`quotes` integer,
	`views` integer,
	`impressions` integer,
	`clicks` integer
);
CREATE INDEX IF NOT EXISTS `delivery_metric_snapshots_target_idx` ON `delivery_metric_snapshots` (`target_id`, `collected_at`);
CREATE INDEX IF NOT EXISTS `delivery_metric_snapshots_user_idx` ON `delivery_metric_snapshots` (`user_id`);
