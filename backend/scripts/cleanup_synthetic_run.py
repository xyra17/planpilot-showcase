#!/usr/bin/env python3
"""Exact-manifest cleanup for a synthetic-v1 run (dry-run by default)."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

from sqlalchemy import text

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from src.database import AsyncSessionLocal

PROJECT_ROOT = Path(__file__).resolve().parents[2]


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("run_id")
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="defaults to documents/evaluations/<run_id>/manifest.json",
    )
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--confirm-run-id")
    args = parser.parse_args()
    manifest_path = args.manifest or (
        PROJECT_ROOT / "documents" / "evaluations" / args.run_id / "manifest.json"
    )
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("run_id") != args.run_id:
        raise RuntimeError("manifest run_id mismatch")
    user_ids = list(manifest.get("user_ids") or [])
    if len(user_ids) != 30 or len(set(user_ids)) != 30:
        raise RuntimeError("manifest must contain exactly 30 unique user IDs")

    async with AsyncSessionLocal() as db:
        database = await db.scalar(text("select current_database()"))
        if database != "planpilot":
            raise RuntimeError(f"refusing cleanup against {database!r}")
        rows = (
            await db.execute(
                text("select id,email from users where id = any(cast(:ids as text[])) order by id"),
                {"ids": user_ids},
            )
        ).all()
        invalid = [email for _, email in rows if not email.endswith("@synthetic.planpilot.invalid")]
        report = {
            "run_id": args.run_id,
            "manifest_users": len(user_ids),
            "matched_users": len(rows),
            "missing_user_ids": sorted(set(user_ids) - {row[0] for row in rows}),
            "invalid_emails": invalid,
            "execute": args.execute,
        }
        print(json.dumps(report, ensure_ascii=False, indent=2))
        if not args.execute:
            await db.rollback()
            return
        if args.confirm_run_id != args.run_id:
            raise RuntimeError("--execute requires --confirm-run-id equal to run_id")
        if invalid or len(rows) != 30:
            raise RuntimeError("exact cleanup boundary verification failed")

        await db.execute(text("lock table users in share row exclusive mode"))
        await db.execute(
            text("create temporary table cleanup_user_ids(id text primary key) on commit drop")
        )
        await db.execute(
            text("insert into cleanup_user_ids(id) select unnest(cast(:ids as text[]))"),
            {"ids": user_ids},
        )
        await db.execute(
            text(
                "update goals set knowledge_base_id=null where user_id in(select id from cleanup_user_ids)"
            )
        )
        for statement in (
            "delete from daily_schedules where user_id in(select id from cleanup_user_ids)",
            "delete from checkin_records where user_id in(select id from cleanup_user_ids)",
            "delete from knowledge_items where user_id in(select id from cleanup_user_ids)",
            "delete from knowledge_bases where user_id in(select id from cleanup_user_ids)",
            "delete from tasks where goal_id in(select id from goals where user_id in(select id from cleanup_user_ids))",
            "delete from plans where goal_id in(select id from goals where user_id in(select id from cleanup_user_ids))",
            "delete from goals where user_id in(select id from cleanup_user_ids)",
        ):
            await db.execute(text(statement))
        await db.execute(
            text("""
        do $$ declare r record; begin
          for r in select table_name from information_schema.columns
            where table_schema='public' and column_name='user_id'
              and table_name not in('users','goals','knowledge_bases','knowledge_items','checkin_records','daily_schedules')
          loop execute format('delete from %I where user_id in(select id from cleanup_user_ids)',r.table_name); end loop;
        end $$
        """)
        )
        result = await db.execute(
            text("delete from users where id in(select id from cleanup_user_ids)")
        )
        if result.rowcount != 30:
            raise RuntimeError(f"expected to delete 30 users, deleted {result.rowcount}")
        residual = await db.scalar(
            text("""
        select count(*) from information_schema.columns c
        where c.table_schema='public' and c.column_name='user_id'
          and exists (
            select 1 from pg_class pc where pc.relname=c.table_name
          )
        """)
        )
        # FK constraints and the exact users DELETE are checked before commit.
        await db.execute(text("set constraints all immediate"))
        await db.commit()
        print(
            json.dumps(
                {
                    "run_id": args.run_id,
                    "deleted_users": 30,
                    "status": "committed",
                    "catalog_user_id_tables": residual,
                },
                ensure_ascii=False,
                indent=2,
            )
        )


if __name__ == "__main__":
    asyncio.run(main())
