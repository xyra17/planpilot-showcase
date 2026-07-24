"""add_task_id_to_knowledge_items

Revision ID: f2c8d1e04a7b
Revises: 49426109cb1d
Create Date: 2026-07-15

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f2c8d1e04a7b'
down_revision: Union[str, None] = 'e7a3b9c12d45'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('knowledge_items', sa.Column('task_id', sa.String(), nullable=True))
    op.create_index(op.f('ix_knowledge_items_task_id'), 'knowledge_items', ['task_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_knowledge_items_task_id'), table_name='knowledge_items')
    op.drop_column('knowledge_items', 'task_id')
