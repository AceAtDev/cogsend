-- 0025: per-account notification emails. One settings row per user (the
-- sender: a Gmail address with its app password encrypted with
-- APP_ENCRYPTION_KEY, or the instance's Resend; the digest's local time), the
-- addresses that receive them with what each one subscribed to, and per alert
-- kind how far the account has been told and when it was last emailed, which
-- is what batches alerts into at most one email per kind per window.
CREATE TABLE IF NOT EXISTS `notification_settings` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`enabled` integer NOT NULL DEFAULT 1,
	`provider` text NOT NULL DEFAULT 'gmail',
	`sender_email` text,
	`sender_secret_enc` text,
	`smtp_port` integer NOT NULL DEFAULT 465,
	`digest_minute` integer NOT NULL DEFAULT 480,
	`last_digest_on` text,
	`last_test_at` integer,
	`last_sent_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE TABLE IF NOT EXISTS `notification_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`email` text NOT NULL,
	`subscriptions` text NOT NULL DEFAULT '[]',
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `notification_recipients_user_email_uq` ON `notification_recipients` (`user_id`, `email`);
CREATE TABLE IF NOT EXISTS `notification_alerts` (
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`kind` text NOT NULL,
	`cursor_at` integer NOT NULL,
	`last_sent_at` integer,
	PRIMARY KEY (`user_id`, `kind`)
);
