"""add_priority_to_tasks

Revision ID: b3f7e9a12cd0
Revises: 49426109cb1d
Create Date: 2026-07-15 03:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3f7e9a12cd0'
down_revision: Union[str, None] = '49426109cb1d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('tasks', sa.Column('priority', sa.String(), nullable=False, server_default='medium'))


def downgrade() -> None:
    op.drop_column('tasks', 'priority')
