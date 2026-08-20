"""Reconcile unique constraints missing from legacy databases.

Revision ID: a4b5c6d7e8f9
Revises: z3a4b5c6d7e8
Create Date: 2026-08-21
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "a4b5c6d7e8f9"
down_revision: str | None = "z3a4b5c6d7e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _ensure_unique_constraint(table_name: str, constraint_name: str, column: str) -> None:
    existing = {
        constraint["name"]
        for constraint in sa.inspect(op.get_bind()).get_unique_constraints(table_name)
    }
    if constraint_name not in existing:
        op.create_unique_constraint(constraint_name, table_name, [column])


def upgrade() -> None:
    _ensure_unique_constraint("users", "users_email_key", "email")
    _ensure_unique_constraint(
        "password_reset_tokens",
        "password_reset_tokens_token_key",
        "token",
    )
    _ensure_unique_constraint(
        "email_verification_tokens",
        "email_verification_tokens_token_key",
        "token",
    )


def downgrade() -> None:
    # These constraints were declared by earlier migrations. This revision only
    # repairs legacy databases where they are missing, so removing them on
    # downgrade would recreate the historical schema drift.
    pass
