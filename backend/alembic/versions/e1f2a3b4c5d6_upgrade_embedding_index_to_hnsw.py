"""upgrade embedding index from ivfflat to hnsw

Revision ID: e1f2a3b4c5d6
Revises: d2e3f4g5h6i7
Create Date: 2026-07-23

ivfflat 在数据量超过约 50 万条时召回率明显下降（需要加大 probes 参数补偿）。
hnsw 索引在任意数据规模下都能保持高召回率，且查询速度不随数据量线性下降。
代价：构建时间更长（一次性），内存占用略高（约 1.3x）。
"""
from alembic import op

revision = "e1f2a3b4c5d6"
down_revision = "d2e3f4g5h6i7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 删除旧的 ivfflat 索引
    op.execute("DROP INDEX IF EXISTS ix_knowledge_items_embedding")

    # 创建 hnsw 索引（余弦距离，m=16 ef_construction=64 为推荐默认值）
    # m：每个节点的最大连接数，越大召回率越高但内存更多；16 是常用均衡点
    # ef_construction：构建期搜索宽度，越大质量越好但构建更慢；64 是推荐起点
    op.execute("""
        CREATE INDEX ix_knowledge_items_embedding_hnsw
        ON knowledge_items
        USING hnsw (embedding vector_cosine_ops)
        WITH (m = 16, ef_construction = 64)
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_knowledge_items_embedding_hnsw")
    op.execute("""
        CREATE INDEX ix_knowledge_items_embedding
        ON knowledge_items
        USING ivfflat (embedding vector_cosine_ops)
        WITH (lists = 100)
    """)
