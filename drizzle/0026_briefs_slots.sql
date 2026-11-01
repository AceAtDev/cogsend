-- 0026: what an agent needs before it writes or schedules for a brand. A brief
-- holds the brand's rules as markdown sections plus notes per platform; a
-- posting schedule holds one account's weekly slots (local times in the
-- operator's zone) and its cadence limits. Both belong to one user and go with
-- the brand or account they describe.
CREATE TABLE IF NOT EXISTS `brand_briefs` (
	`brand_id` text PRIMARY KEY NOT NULL REFERENCES `brands`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`sections_json` text NOT NULL DEFAULT '{}',
	`platform_notes_json` text NOT NULL DEFAULT '{}',
	`updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `brand_briefs_user_idx` ON `brand_briefs` (`user_id`);
CREATE TABLE IF NOT EXISTS `posting_schedules` (
	`connection_id` text PRIMARY KEY NOT NULL REFERENCES `connections`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`slots_json` text NOT NULL DEFAULT '{}',
	`max_per_day` integer,
	`min_gap_minutes` integer,
	`updated_at` integer NOT NULL
);
CREATE INDEX IF NOT EXISTS `posting_schedules_user_idx` ON `posting_schedules` (`user_id`);
