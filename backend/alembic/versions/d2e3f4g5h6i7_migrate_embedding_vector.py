"""migrate_embedding_vector

Revision ID: d2e3f4g5h6i7
Revises: c1d2e3f4a5b6
Create Date: 2026-07-20

"""
from alembic import op
import sqlalchemy as sa

revision = "d2e3f4g5h6i7"
down_revision = "c1d2e3f4a5b6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.drop_column("knowledge_items", "embedding")
    op.add_column("knowledge_items", sa.Column("embedding", sa.Text(), nullable=True))
    op.execute("ALTER TABLE knowledge_items ALTER COLUMN embedding TYPE vector(1536) USING NULL")
    op.execute(
        "CREATE INDEX IF NOT EXISTS ix_knowledge_items_embedding "
        "ON knowledge_items USING hnsw (embedding vector_cosine_ops)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_knowledge_items_embedding")
    op.drop_column("knowledge_items", "embedding")
    op.add_column("knowledge_items", sa.Column("embedding", sa.JSON(), nullable=True))
