"""add_note_id_to_knowledge_items

Revision ID: g1h2i3j4k5l6
Revises: e1f2a3b4c5d6
Create Date: 2026-07-24

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'g1h2i3j4k5l6'
down_revision: Union[str, None] = 'e1f2a3b4c5d6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('knowledge_items', sa.Column('note_id', sa.String(), nullable=True))
    op.create_index(op.f('ix_knowledge_items_note_id'), 'knowledge_items', ['note_id'], unique=False)
    op.create_foreign_key(
        'fk_knowledge_items_note_id', 'knowledge_items', 'knowledge_items',
        ['note_id'], ['id'], ondelete='SET NULL'
    )


def downgrade() -> None:
    op.drop_constraint('fk_knowledge_items_note_id', 'knowledge_items', type_='foreignkey')
    op.drop_index(op.f('ix_knowledge_items_note_id'), table_name='knowledge_items')
    op.drop_column('knowledge_items', 'note_id')
