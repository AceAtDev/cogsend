# Backups

Drafts, schedules, publish history, accounts and settings all live in D1; media
lives in R2.

D1 keeps its own history for 30 days on the Workers Paid plan and 7 days on
Free. Time Travel reports what it holds and rewinds the database to an earlier
point:

```sh
node scripts/wrangler.mjs d1 time-travel info DB
node scripts/wrangler.mjs d1 time-travel restore DB --timestamp 2026-09-21T09:00:00Z
```

## Automatic weekly backups

CogSend also copies the database into its own R2 bucket once a week, under
`backups/<date>/`, and keeps the last 8 (about two months). The copy is written
a few files per minute on whatever the scheduler has left over, so it never
delays a post; a small install finishes within a minute or two. Each backup is:

- `000-schema.sql`: every table and index, as `CREATE ... IF NOT EXISTS`.
- One or more files per table, 2,000 rows each, as `INSERT OR REPLACE`
  statements, numbered so parents come before the tables that reference them.
- `manifest.json`: the list of files, written last. A folder without one is a
  backup still in progress.

Sign-in sessions, pending connects and MCP replay guards are left out; after a
restore everyone signs in again. Progress and the list of kept backups are in
the `backup_state` row of `app_settings`.

To restore, fetch the manifest of the backup you want, then run its files in
order. Restore into an empty database, or one Time Travel has just rewound:

```sh
B=backups/2026-11-01T12-00-00-000Z   # the backup's folder
node scripts/wrangler.mjs r2 object get cogsend-media/$B/manifest.json --remote --file manifest.json
for key in $(jq -r '.files[]' manifest.json); do
  node scripts/wrangler.mjs r2 object get "cogsend-media/$key" --remote --file restore.sql
  node scripts/wrangler.mjs d1 execute DB --remote --yes --file restore.sql
done
```

The weekly copy sits in the same Cloudflare account as the database. For a copy
outside it, take an export now and then.

## Exports

For a copy of your own, export the database to SQL. `DB` is the binding in your
config, so the same command works on a database you renamed:

```sh
node scripts/wrangler.mjs d1 export DB --remote --skip-confirmation --output ~/cogsend-$(date +%F).sql
node scripts/wrangler.mjs d1 execute DB --remote --yes --file ~/cogsend-2026-09-22.sql
```

`--no-schema` exports rows without the schema and `--table` narrows the export to
one table. Restore into an empty database, or one Time Travel has just rewound: an
export carries `CREATE TABLE` statements, and its rows collide with rows that are
already there.

R2 has no export command. Copy the bucket with any S3 client (`rclone`, `aws s3
sync`) against its S3 endpoint, or fetch objects one at a time with:

```sh
node scripts/wrangler.mjs r2 object get cogsend-media/<key> --remote --file ./<key>
```

The bucket name is `bucket_name` in `wrangler.personal.jsonc`.
