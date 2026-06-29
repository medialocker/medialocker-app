# Backup Strategy

A backup strategy for self-hosted MediaLocker. Postgres backups are handled by Supabase Cloud — you are responsible for the self-hosted Redis and Caddy state.

## What to Backup

| Component | Data | Tool | Frequency |
|---|---|---|---|
| Postgres | User data, metadata, billing | Supabase Cloud (automated + PITR) | Managed |
| Media objects | Stored in Hetzner Object Storage | Provider durability | N/A |
| Redis | Session/rate-limit data | AOF persistence + `redis-backup` | Continuous |
| Caddy | TLS certificates | Volume backup | Weekly |
| Environment | `.env` file | Git/encrypted backup | On change |

## Postgres Backup (Supabase Cloud)

Postgres runs on Supabase Cloud, so database backups are **managed for you** — there is no self-hosted `pg-backup` service (the old `pg_dump` + GPG container has been removed, along with the `POSTGRES_PASSWORD` and `BACKUP_GPG_PASSPHRASE` variables).

Supabase Cloud provides:

- **Automated daily backups** of your project's Postgres database.
- **Point-in-time recovery (PITR)** on supported plans, letting you restore to any moment within the retention window.

Configure the retention period and PITR window, and run restores, from the **Supabase dashboard → Database → Backups**. Verify your retention settings match your recovery objectives.

::: tip
The Hetzner object durability plus the Supabase-managed Postgres backup together cover a full restore — the database remains the source of truth for object metadata.
:::

## Media Objects

Media objects are stored in Hetzner Object Storage and are not backed up by your deployment — durability and redundancy are handled by the provider. There is no local object-storage volume to mirror. The Postgres database remains the source of truth for object metadata, so the Supabase-managed database backup plus the provider's object durability together cover a full restore.

## Redis Backup

Redis is self-hosted. AOF persistence is enabled by default, and the `redis-backup` service snapshots the data on a schedule:

```yaml
redis:
  command: redis-server --appendonly yes --appendfsync everysec
```

AOF files are stored in the `redis_data` volume. To take an on-demand snapshot:

```bash
docker exec medialocker-redis-1 redis-cli BGSAVE
# AOF + RDB are now consistent
# Backup the redis_data volume
```

The `redis-backup` companion service writes periodic copies; confirm its target location has its own retention and off-host copy.

## Caddy Certificate Backup

Caddy certificates are in the `caddy_data` volume. Backup:

```bash
docker run --rm \
  -v medialocker_caddy_data:/data \
  -v /backups:/backup \
  alpine tar czf /backup/caddy-data-$(date +%Y%m%d).tar.gz -C /data .
```

## Full System Backup Schedule

Postgres is backed up by Supabase Cloud automatically. For the self-hosted pieces, a recommended cron schedule:

```
0 4 * * 0 /opt/medialocker/scripts/backup-caddy.sh
```

Redis snapshots are produced continuously by the `redis-backup` service; ensure its output is copied off-host.

## Disaster Recovery

To restore on a new server:

1. Install Docker and Docker Compose
2. Clone the medialocker repo
3. Copy `.env` from backup (including the Hetzner Object Storage master credential and Supabase Cloud values)
4. If recovering the database, restore from Supabase Cloud (dashboard → Database → Backups, or PITR)
5. Restore the `redis_data` and `caddy_data` volumes from backup
6. Start the self-hosted services — media objects are already durable in Hetzner Object Storage
7. Verify with health checks

## Backup Testing

Test recovery periodically:

- Use the Supabase dashboard to perform a test restore (e.g. into a staging project) and verify row counts.
- Restore the `redis_data` volume into a staging stack and confirm the services start cleanly.
