import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from src.database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goals: Mapped[list["Goal"]] = relationship("Goal", back_populates="user", cascade="all, delete-orphan")
    checkin_records: Mapped[list["CheckinRecord"]] = relationship("CheckinRecord", back_populates="user")


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    deadline: Mapped[str] = mapped_column(String, nullable=False)
    daily_hours: Mapped[float] = mapped_column(Float, default=2.0)
    current_level: Mapped[str] = mapped_column(String, default="beginner")
    status: Mapped[str] = mapped_column(String, default="active")
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates="goals")
    tasks: Mapped[list["Task"]] = relationship("Task", back_populates="goal", cascade="all, delete-orphan")
    checkin_records: Mapped[list["CheckinRecord"]] = relationship("CheckinRecord", back_populates="goal", cascade="all, delete-orphan")
    plans: Mapped[list["Plan"]] = relationship("Plan", back_populates="goal", cascade="all, delete-orphan")


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    # 原始计划快照（生成时存入，重规划时不覆盖）
    baseline: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    # 当前执行中的计划内容
    content: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    replan_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goal: Mapped["Goal"] = relationship("Goal", back_populates="plans")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    plan_id: Mapped[str | None] = mapped_column(String, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    estimated_mins: Mapped[int] = mapped_column(Integer, default=30)
    actual_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    type: Mapped[str] = mapped_column(String, default="study")
    kb_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    mastery_level: Mapped[str] = mapped_column(String, default="unknown")
    priority: Mapped[str] = mapped_column(String, default="medium")
    scheduled_date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goal: Mapped["Goal"] = relationship("Goal", back_populates="tasks")


class CheckinRecord(Base):
    __tablename__ = "checkin_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    mode: Mapped[str] = mapped_column(String, nullable=False)
    quick_status: Mapped[str | None] = mapped_column(String, nullable=True)
    natural_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    completion_rate: Mapped[float] = mapped_column(Float, default=0.0)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    feedback: Mapped[str] = mapped_column(Text, default="")
    replan_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goal: Mapped["Goal"] = relationship("Goal", back_populates="checkin_records")
    user: Mapped["User"] = relationship("User", back_populates="checkin_records")


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    items: Mapped[list["KnowledgeItem"]] = relationship("KnowledgeItem", back_populates="kb")


class KnowledgeItem(Base):
    __tablename__ = "knowledge_items"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    goal_id: Mapped[str | None] = mapped_column(String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True)
    kb_id: Mapped[str | None] = mapped_column(String, ForeignKey("knowledge_bases.id", ondelete="SET NULL"), nullable=True, index=True)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source_type: Mapped[str] = mapped_column(String, default="upload")  # upload | url | search | system
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    task_id: Mapped[str | None] = mapped_column(String, ForeignKey("tasks.id"), nullable=True, index=True)
    note_id: Mapped[str | None] = mapped_column(String, ForeignKey("knowledge_items.id", ondelete="SET NULL"), nullable=True, index=True)
    note_date: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
    processing_status: Mapped[str] = mapped_column(String, default="uploaded", index=True)
    processing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    content_length: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    kb: Mapped["KnowledgeBase | None"] = relationship("KnowledgeBase", back_populates="items")
    chunks: Mapped[list["KnowledgeChunk"]] = relationship(
        "KnowledgeChunk",
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="KnowledgeChunk.chunk_index",
    )

    __table_args__ = (
        Index(
            "ix_knowledge_items_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
            postgresql_with={"m": 16, "ef_construction": 64},
        ),
    )


class KnowledgeChunk(Base):
    __tablename__ = "knowledge_chunks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    item_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("knowledge_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    start_char: Mapped[int] = mapped_column(Integer, nullable=False)
    end_char: Mapped[int] = mapped_column(Integer, nullable=False)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    item: Mapped["KnowledgeItem"] = relationship("KnowledgeItem", back_populates="chunks")

    __table_args__ = (
        UniqueConstraint("item_id", "chunk_index", name="uq_knowledge_chunks_item_index"),
        Index(
            "ix_knowledge_chunks_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
            postgresql_with={"m": 16, "ef_construction": 64},
        ),
    )


class DailyBriefCache(Base):
    __tablename__ = "daily_brief_caches"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    content: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    generated_by: Mapped[str] = mapped_column(String, default="on_demand")
    generated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "date", name="uq_daily_brief_cache_user_date"),
    )


class DailySchedule(Base):
    __tablename__ = "daily_schedules"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    blocks: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_daily_schedule_user_date"),)


class LearningDebt(Base):
    __tablename__ = "learning_debts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True)
    task_id: Mapped[str | None] = mapped_column(String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    estimated_hours: Mapped[float] = mapped_column(Float, default=0.0)
    skip_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    impact: Mapped[str] = mapped_column(String, default="medium")  # low | medium | high
    status: Mapped[str] = mapped_column(String, default="open")    # open | resolved
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
