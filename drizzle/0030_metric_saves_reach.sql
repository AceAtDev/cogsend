-- 0030: Instagram reports saves and reach for each post.
ALTER TABLE delivery_metrics ADD COLUMN saves INTEGER;
ALTER TABLE delivery_metrics ADD COLUMN reach INTEGER;
ALTER TABLE delivery_metric_snapshots ADD COLUMN saves INTEGER;
ALTER TABLE delivery_metric_snapshots ADD COLUMN reach INTEGER;
