# PlanPilot production recovery runbook

The recovery unit is one timestamped backup set containing `database.dump`,
the private object-store mirror, and `SHA256SUMS`. Database and objects must
always be restored from the same set.

## Backup

Set `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, and `OBJECT_STORAGE_PASSWORD` in the
deployment environment. Optionally set `BACKUP_DIR` to an encrypted mounted
backup volume, then run:

```bash
./ops/backup.sh
```

Copy the completed set off-host using the organization's encrypted backup
transport. Retain daily sets for 14 days and monthly sets for 12 months unless
the data-retention policy requires earlier deletion.

The PostgreSQL, MinIO, and backup volumes must use encrypted disks. For AWS S3,
set `STORAGE_S3_SERVER_SIDE_ENCRYPTION=AES256`; for MinIO, configure KMS before
setting that flag because MinIO correctly rejects SSE requests without KMS.

## Restore drill

Run quarterly in an isolated deployment first. Stop writes, choose one exact
backup directory, verify that its storage target is the intended environment,
then run:

```bash
./ops/restore.sh /absolute/path/to/backups/20260818T010203Z --confirm
```

The script verifies checksums, restores PostgreSQL with clean replacement,
mirrors the matching private objects, reapplies migrations, and restarts the
application processes. Afterward verify `/ready`, login, one knowledge-file
download, one retrieval query, and one Agent preview before reopening traffic.
External orchestrators may set `RESTORE_SKIP_RESTART=1` and perform their own
controlled rollout after the script returns successfully.

Record RPO (newest recoverable event) and RTO (time until validation passed) for
every drill. A failed checksum, missing object set, or migration failure means
the recovery is not complete and traffic must remain closed.
