"""migrate embeddings to Qwen3 1024 dimensions

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-07-25
"""

from typing import Sequence, Union

from alembic import op

revision: str = "j4k5l6m7n8o9"
down_revision: Union[str, None] = "i3j4k5l6m7n8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _recreate_indexes() -> None:
    op.execute(
        "CREATE INDEX ix_knowledge_items_embedding_hnsw "
        "ON knowledge_items USING hnsw (embedding vector_cosine_ops) "
        "WITH (m = 16, ef_construction = 64)"
    )
    op.execute(
        "CREATE INDEX ix_knowledge_chunks_embedding_hnsw "
        "ON knowledge_chunks USING hnsw (embedding vector_cosine_ops) "
        "WITH (m = 16, ef_construction = 64)"
    )


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_knowledge_items_embedding_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_hnsw")
    op.execute(
        "ALTER TABLE knowledge_items ALTER COLUMN embedding "
        "TYPE vector(1024) USING NULL"
    )
    op.execute(
        "ALTER TABLE knowledge_chunks ALTER COLUMN embedding "
        "TYPE vector(1024) USING NULL"
    )
    _recreate_indexes()


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_knowledge_items_embedding_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_knowledge_chunks_embedding_hnsw")
    op.execute(
        "ALTER TABLE knowledge_items ALTER COLUMN embedding "
        "TYPE vector(1536) USING NULL"
    )
    op.execute(
        "ALTER TABLE knowledge_chunks ALTER COLUMN embedding "
        "TYPE vector(1536) USING NULL"
    )
    _recreate_indexes()
