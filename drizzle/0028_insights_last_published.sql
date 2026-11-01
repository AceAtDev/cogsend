-- 0028: lets Insights find each account's last published post with one index
-- lookup per account, instead of reading every delivery the account ever made.
CREATE INDEX IF NOT EXISTS `publish_targets_conn_status_updated_idx` ON `publish_targets` (`connection_id`, `status`, `updated_at`);
