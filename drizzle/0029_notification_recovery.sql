ALTER TABLE notification_alerts ADD COLUMN cursor_id TEXT NOT NULL DEFAULT '';
ALTER TABLE notification_settings ADD COLUMN digest_progress_on TEXT;
ALTER TABLE notification_settings ADD COLUMN digest_sent_to TEXT NOT NULL DEFAULT '[]';
ALTER TABLE notification_settings ADD COLUMN digest_claim_token TEXT;
ALTER TABLE notification_settings ADD COLUMN digest_claimed_at INTEGER;
