"""add_note_date_to_knowledge_items

Revision ID: k5l6m7n8o9p0
Revises: j4k5l6m7n8o9
Create Date: 2026-07-25

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'k5l6m7n8o9p0'
down_revision: Union[str, None] = 'j4k5l6m7n8o9'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('knowledge_items', sa.Column('note_date', sa.String(), nullable=True))
    op.create_index(op.f('ix_knowledge_items_note_date'), 'knowledge_items', ['note_date'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_knowledge_items_note_date'), table_name='knowledge_items')
    op.drop_column('knowledge_items', 'note_date')
