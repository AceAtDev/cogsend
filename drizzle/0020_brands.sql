-- 0020: brands group connected accounts, so an agent can address a channel as
-- `<brand>.<platform>` instead of an opaque connection id. A connection with no
-- brand is "unbranded"; deleting a brand leaves its accounts connected and
-- unbranded rather than removing them.
CREATE TABLE IF NOT EXISTS `brands` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `brands_user_slug_uq` ON `brands` (`user_id`, `slug`);
ALTER TABLE `connections` ADD COLUMN `brand_id` text REFERENCES `brands`(`id`) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS `connections_brand_idx` ON `connections` (`brand_id`);
