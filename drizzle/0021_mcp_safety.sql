-- 0021: the MCP server's two-step writes and idempotency keys. A confirmation
-- binds a short-lived token (only its hash is stored) to the exact plan a dry
-- run previewed; an idempotency row keeps the answer a write gave for a key,
-- so a retried call replays it instead of scheduling twice. Both expire.
CREATE TABLE IF NOT EXISTS `mcp_confirmations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`token_hash` text NOT NULL,
	`tool` text NOT NULL,
	`payload_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `mcp_confirmations_token_uq` ON `mcp_confirmations` (`token_hash`);
CREATE INDEX IF NOT EXISTS `mcp_confirmations_expires_idx` ON `mcp_confirmations` (`expires_at`);
CREATE TABLE IF NOT EXISTS `mcp_idempotency` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`key` text NOT NULL,
	`tool` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS `mcp_idempotency_user_key_uq` ON `mcp_idempotency` (`user_id`, `key`);
CREATE INDEX IF NOT EXISTS `mcp_idempotency_expires_idx` ON `mcp_idempotency` (`expires_at`);
