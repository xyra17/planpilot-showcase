import uuid
from datetime import datetime
from typing import Any

from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    FetchedValue,
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

from src.core.time import utc_now
from src.database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    __table_args__ = (UniqueConstraint("email", name="users_email_key"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    email: Mapped[str] = mapped_column(String, unique=True, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    hashed_password: Mapped[str] = mapped_column(String, nullable=False)
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    timezone: Mapped[str] = mapped_column(String(64), default="Asia/Shanghai")
    language: Mapped[str] = mapped_column(String(16), default="zh-CN")
    week_start: Mapped[str] = mapped_column(String(16), default="monday")
    study_days: Mapped[list[str]] = mapped_column(
        JSON, default=lambda: ["mon", "tue", "wed", "thu", "fri"]
    )
    availability_windows: Mapped[list[str]] = mapped_column(JSON, default=lambda: ["evening"])
    weekly_availability: Mapped[dict[str, list[dict[str, str]]] | None] = mapped_column(
        JSON, nullable=True, default=None
    )
    ui_experience: Mapped[str] = mapped_column(String(24), default="technology")
    ui_theme: Mapped[str] = mapped_column(String(24), default="base")
    ui_accent: Mapped[str] = mapped_column(String(32), default="violet")
    font_density: Mapped[str] = mapped_column(String(24), default="comfortable")
    preferred_start_method: Mapped[str] = mapped_column(String(32), default="create_goal")
    account_preferences: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    onboarding_completed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goals: Mapped[list["Goal"]] = relationship(
        "Goal", back_populates="user", cascade="all, delete-orphan"
    )
    checkin_records: Mapped[list["CheckinRecord"]] = relationship(
        "CheckinRecord", back_populates="user"
    )


class UserDataConsent(Base):
    """Current, user-controlled purposes for learning-data processing."""

    __tablename__ = "user_data_consents"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    personalization_enabled: Mapped[bool] = mapped_column(
        Boolean, default=True, server_default="true", nullable=False
    )
    experiments_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    product_analytics_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    sensitive_inference_enabled: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false", nullable=False
    )
    policy_version: Mapped[str] = mapped_column(String(32), default="2026-08", nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )


class ConsentAuditEvent(Base):
    """Append-only proof of consent grant, change, or withdrawal."""

    __tablename__ = "consent_audit_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    purposes: Mapped[dict[str, bool]] = mapped_column(JSON, nullable=False)
    policy_version: Mapped[str] = mapped_column(String(32), nullable=False)
    source: Mapped[str] = mapped_column(String(32), default="account_settings", nullable=False)
    request_id: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class DataExportAudit(Base):
    """Minimal export audit; exported content is never duplicated in the database."""

    __tablename__ = "data_export_audits"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    section_counts: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)
    requested_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class DataQualitySnapshot(Base):
    """Versioned, reproducible quality checks for real-user learning evidence."""

    __tablename__ = "data_quality_snapshots"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    window_days: Mapped[int] = mapped_column(Integer, nullable=False)
    quality_score: Mapped[float] = mapped_column(Float, nullable=False)
    report: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    sampled_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class LearningExperimentReport(Base):
    """Immutable evidence report for one of the four product-learning claims."""

    __tablename__ = "learning_experiment_reports"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    experiment_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    scope_key: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class ProductFeedbackSignal(Base):
    """Consent-backed, user-authored product-value evidence."""

    __tablename__ = "product_feedback_signals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    signal_type: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    request_id: Mapped[str] = mapped_column(String(100), nullable=False, unique=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class ProductValidationSnapshot(Base):
    """Versioned PMF and behavioral-retention evidence."""

    __tablename__ = "product_validation_snapshots"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    schema_version: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    report: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class ProductionReadinessDecision(Base):
    """Append-only go/hold/rollback decision with complete evidence snapshot."""

    __tablename__ = "production_readiness_decisions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    decision: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    reason_codes: Mapped[list[str]] = mapped_column(JSON, default=list)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    canary_release_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("canary_releases.id", ondelete="SET NULL"), nullable=True, index=True
    )
    actor: Mapped[str] = mapped_column(String, nullable=False)
    generated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)


class AuthSession(Base):
    """Server-side refresh-token state used for rotation and replay detection."""

    __tablename__ = "auth_sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    family_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    refresh_token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    remember_me: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    replaced_by_session_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("auth_sessions.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (Index("ix_auth_sessions_user_family", "user_id", "family_id"),)


class CoachConversation(Base):
    """Account-owned Pilo conversation archive; browsers are only an offline cache."""

    __tablename__ = "coach_conversations"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(String, nullable=False)
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    goal_title: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    pilo_feedback: Mapped[str] = mapped_column(Text, default="")
    messages: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list)
    association: Mapped[str] = mapped_column(String, default="")
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    __table_args__ = (Index("ix_coach_conversations_user_updated", "user_id", "updated_at"),)


class CoachPreference(Base):
    """Account-level Pilo response preferences shared by web and desktop clients."""

    __tablename__ = "coach_preferences"

    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    preferences: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    type: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    deadline: Mapped[str] = mapped_column(String, nullable=False)
    daily_hours: Mapped[float] = mapped_column(Float, default=2.0)
    current_level: Mapped[str] = mapped_column(String, default="beginner")
    status: Mapped[str] = mapped_column(String, default="active")
    # 直接列（从 meta JSON 提升）
    knowledge_base_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("knowledge_bases.id", ondelete="SET NULL"), nullable=True, index=True
    )
    work_schedule: Mapped[str] = mapped_column(String, default="all")
    # meta 保留用于向后兼容，新代码不应写入 ai 状态到此字段
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)

    __mapper_args__ = {"version_id_col": version}

    user: Mapped["User"] = relationship("User", back_populates="goals")
    tasks: Mapped[list["Task"]] = relationship(
        "Task", back_populates="goal", cascade="all, delete-orphan"
    )
    checkin_records: Mapped[list["CheckinRecord"]] = relationship(
        "CheckinRecord", back_populates="goal", cascade="all, delete-orphan"
    )
    plans: Mapped[list["Plan"]] = relationship(
        "Plan", back_populates="goal", cascade="all, delete-orphan"
    )
    knowledge_item_links: Mapped[list["KnowledgeItemGoalLink"]] = relationship(
        "KnowledgeItemGoalLink",
        back_populates="goal",
        cascade="all, delete-orphan",
    )


class Plan(Base):
    __tablename__ = "plans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    baseline: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    content: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    replan_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String, default="ai")  # user | ai | import
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    goal: Mapped["Goal"] = relationship("Goal", back_populates="plans")


class Task(Base):
    __tablename__ = "tasks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    plan_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("plans.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    estimated_mins: Mapped[int] = mapped_column(Integer, default=30)
    actual_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str] = mapped_column(String, default="pending")
    # status values: pending | in_progress | completed | skipped | abandoned
    type: Mapped[str] = mapped_column(String, default="study")
    kb_refs: Mapped[list[str]] = mapped_column(JSON, default=list)
    mastery_level: Mapped[str] = mapped_column(String, default="unknown")
    # mastery audit trail → task_mastery_records
    priority: Mapped[str] = mapped_column(String, default="medium")
    scheduled_date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    stage_label: Mapped[str | None] = mapped_column(String, nullable=True)
    sequence_in_plan: Mapped[int | None] = mapped_column(Integer, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1", nullable=False)

    __mapper_args__ = {"version_id_col": version}

    goal: Mapped["Goal"] = relationship("Goal", back_populates="tasks")


class CheckinRecord(Base):
    __tablename__ = "checkin_records"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "goal_id",
            "date",
            name="uq_checkin_user_goal_date",
        ),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(String, ForeignKey("goals.id"), nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    mode: Mapped[str] = mapped_column(String, nullable=False)
    quick_status: Mapped[str | None] = mapped_column(String, nullable=True)
    natural_text: Mapped[str | None] = mapped_column(Text, nullable=True)
    completion_rate: Mapped[float] = mapped_column(Float, default=0.0)
    stats: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    duration_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # feedback / replan_triggered 已废弃，停止写入新数据，列保留用于历史数据读取
    feedback: Mapped[str] = mapped_column(Text, default="")
    replan_triggered: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    goal: Mapped["Goal"] = relationship("Goal", back_populates="checkin_records")
    user: Mapped["User"] = relationship("User", back_populates="checkin_records")


class KnowledgeBase(Base):
    __tablename__ = "knowledge_bases"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    goal_id: Mapped[str | None] = mapped_column(
        String,
        ForeignKey(
            "goals.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_knowledge_bases_goal_id_goals",
        ),
        nullable=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    items: Mapped[list["KnowledgeItem"]] = relationship("KnowledgeItem", back_populates="kb")
    item_links: Mapped[list["KnowledgeItemLibraryLink"]] = relationship(
        "KnowledgeItemLibraryLink",
        back_populates="library",
        cascade="all, delete-orphan",
    )


class KnowledgeItem(Base):
    __tablename__ = "knowledge_items"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    kb_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("knowledge_bases.id", ondelete="SET NULL"), nullable=True, index=True
    )
    title: Mapped[str] = mapped_column(Text, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_format: Mapped[str] = mapped_column(String, default="plain", server_default="plain")
    source_type: Mapped[str] = mapped_column(
        String, default="upload"
    )  # upload | url | search | system
    source_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    file_size_bytes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    media_preview_status: Mapped[str] = mapped_column(
        String, default="none", server_default="none", index=True
    )
    media_preview_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_metadata: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, server_default="{}")
    media_source_version: Mapped[str | None] = mapped_column(String, nullable=True)
    media_playback_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_poster_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_waveform_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    media_previewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    task_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    task_title_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    note_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("knowledge_items.id", ondelete="SET NULL"), nullable=True, index=True
    )
    note_date: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(1024), nullable=True)
    processing_status: Mapped[str] = mapped_column(String, default="uploaded", index=True)
    processing_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    content_length: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    kb: Mapped["KnowledgeBase | None"] = relationship("KnowledgeBase", back_populates="items")
    goal_links: Mapped[list["KnowledgeItemGoalLink"]] = relationship(
        "KnowledgeItemGoalLink",
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="KnowledgeItemGoalLink.goal_id",
    )
    library_links: Mapped[list["KnowledgeItemLibraryLink"]] = relationship(
        "KnowledgeItemLibraryLink",
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="KnowledgeItemLibraryLink.kb_id",
    )
    file_versions: Mapped[list["KnowledgeItemFileVersion"]] = relationship(
        "KnowledgeItemFileVersion",
        back_populates="item",
        cascade="all, delete-orphan",
        order_by="KnowledgeItemFileVersion.created_at.desc()",
    )
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


class KnowledgeItemGoalLink(Base):
    __tablename__ = "knowledge_item_goal_links"

    item_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("knowledge_items.id", ondelete="CASCADE"),
        primary_key=True,
    )
    goal_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("goals.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    item: Mapped["KnowledgeItem"] = relationship("KnowledgeItem", back_populates="goal_links")
    goal: Mapped["Goal"] = relationship("Goal", back_populates="knowledge_item_links")


class KnowledgeItemLibraryLink(Base):
    """Many-to-many archive index; the physical resource remains a single KnowledgeItem."""

    __tablename__ = "knowledge_item_library_links"

    item_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("knowledge_items.id", ondelete="CASCADE"),
        primary_key=True,
    )
    kb_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("knowledge_bases.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    item: Mapped["KnowledgeItem"] = relationship("KnowledgeItem", back_populates="library_links")
    library: Mapped["KnowledgeBase"] = relationship("KnowledgeBase", back_populates="item_links")


class KnowledgeItemFileVersion(Base):
    __tablename__ = "knowledge_item_file_versions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    item_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("knowledge_items.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    file_path: Mapped[str] = mapped_column(Text, nullable=False)
    filename: Mapped[str] = mapped_column(Text, nullable=False)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    content: Mapped[str] = mapped_column(Text, default="")
    content_format: Mapped[str] = mapped_column(String, default="plain")
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    item: Mapped["KnowledgeItem"] = relationship("KnowledgeItem", back_populates="file_versions")


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

    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_daily_brief_cache_user_date"),)


class DailySchedule(Base):
    __tablename__ = "daily_schedules"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(String, ForeignKey("users.id"), nullable=False, index=True)
    date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    blocks: Mapped[list] = mapped_column(JSON, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("user_id", "date", name="uq_daily_schedule_user_date"),)


class LearningDebt(Base):
    __tablename__ = "learning_debts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    task_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    estimated_hours: Mapped[float] = mapped_column(Float, default=0.0)
    skip_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    impact: Mapped[str] = mapped_column(String, default="medium")  # low | medium | high
    status: Mapped[str] = mapped_column(String, default="open")  # open | resolved
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class AgentRun(Base):
    __tablename__ = "agent_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    request_text: Mapped[str] = mapped_column(Text, nullable=False)
    conversation_turn_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    insight_id: Mapped[str | None] = mapped_column(
        String,
        ForeignKey(
            "decision_proposals.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_agent_runs_insight_id_decision_proposals",
        ),
        nullable=True,
        index=True,
    )
    trace_context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    input_received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    preview_ready_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    objective: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    plan: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    plan_history: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    run_kind: Mapped[str] = mapped_column(String, default="user")
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    plan_version: Mapped[int] = mapped_column(Integer, default=1)
    state_version: Mapped[int] = mapped_column(Integer, default=0)
    current_step: Mapped[int] = mapped_column(Integer, default=0)
    step_budget: Mapped[int] = mapped_column(Integer, default=10)
    steps_consumed: Mapped[int] = mapped_column(Integer, default=0)
    token_budget: Mapped[int] = mapped_column(Integer, default=20000)
    tokens_consumed: Mapped[int] = mapped_column(Integer, default=0)
    tool_time_budget_ms: Mapped[int] = mapped_column(Integer, default=600000)
    tool_time_consumed_ms: Mapped[int] = mapped_column(Integer, default=0)
    replan_budget: Mapped[int] = mapped_column(Integer, default=2)
    replan_count: Mapped[int] = mapped_column(Integer, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, default=0)
    worker_id: Mapped[str | None] = mapped_column(String, nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    result: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class AgentStep(Base):
    __tablename__ = "agent_steps"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "plan_version", "step_index", name="uq_agent_step_run_plan_index"
        ),
        UniqueConstraint("run_id", "step_key", name="uq_agent_step_run_key"),
        UniqueConstraint("idempotency_key", name="uq_agent_step_idempotency_key"),
    )

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    run_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_index: Mapped[int] = mapped_column(Integer, nullable=False)
    step_key: Mapped[str] = mapped_column(String, nullable=False)
    plan_version: Mapped[int] = mapped_column(Integer, default=1)
    agent_role: Mapped[str] = mapped_column(String, default="main")
    tool_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    risk: Mapped[str] = mapped_column(String, default="low")
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    input_data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    resolved_input_summary: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    input_refs: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    depends_on: Mapped[list[str]] = mapped_column(JSON, default=list)
    on_failure: Mapped[str] = mapped_column(String, default="fail")
    rationale: Mapped[str] = mapped_column(Text, default="")
    output_data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    error_data: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    state_version: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    tool_time_ms: Mapped[int] = mapped_column(Integer, default=0)
    token_usage: Mapped[int] = mapped_column(Integer, default=0)
    idempotency_key: Mapped[str | None] = mapped_column(String, nullable=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AgentApproval(Base):
    __tablename__ = "agent_approvals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    run_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_steps.id", ondelete="CASCADE"), nullable=False, index=True
    )
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    change_set: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    change_hash: Mapped[str] = mapped_column(String, nullable=False)
    change_set_version: Mapped[int] = mapped_column(Integer, default=1)
    run_state_version: Mapped[int] = mapped_column(Integer, default=0)
    review_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    reviewed_change_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    review_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    policy_decision: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Phase-2A 新表 ──────────────────────────────────────────────────────────────


class GoalVersion(Base):
    """目标演化历史快照，每次用户/AI 修改 title/objective/constraints 时追加一条。"""

    __tablename__ = "goal_versions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    goal_id: Mapped[str] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    title_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    objective_snapshot: Mapped[str | None] = mapped_column(Text, nullable=True)
    constraints_snapshot: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)
    change_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[str] = mapped_column(String, default="user")  # user | ai | system
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("goal_id", "version", name="uq_goal_versions_goal_version"),)


class TaskMasteryRecord(Base):
    """任务掌握度变更审计轨迹，用于追踪每次 mastery_level 变更的来源。"""

    __tablename__ = "task_mastery_records"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    task_id: Mapped[str] = mapped_column(
        String, ForeignKey("tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    mastery_level: Mapped[str] = mapped_column(String, nullable=False)
    # source values: checkin_submission | system_estimate | manual | ai_assessment
    source: Mapped[str] = mapped_column(String, default="checkin_submission")
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AgentAuditEvent(Base):
    __tablename__ = "agent_audit_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    sequence: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), nullable=False, unique=True, index=True
    )
    run_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    step_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_steps.id", ondelete="SET NULL"), nullable=True, index=True
    )
    event_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    actor: Mapped[str] = mapped_column(String, default="system")
    schema_version: Mapped[int] = mapped_column(Integer, default=1)
    safe_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"

    __table_args__ = (UniqueConstraint("token", name="password_reset_tokens_token_key"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EmailVerificationToken(Base):
    __tablename__ = "email_verification_tokens"

    __table_args__ = (UniqueConstraint("token", name="email_verification_tokens_token_key"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


# ── Phase-2B Learning Events ───────────────────────────────────────────────


class LearningEvent(Base):
    """学习事件流：append-only 事件日志，由 Domain Service 写入，Intelligence Layer 消费。"""

    __tablename__ = "learning_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    aggregate_type: Mapped[str] = mapped_column(
        String, nullable=False
    )  # goal | task | plan | checkin
    aggregate_id: Mapped[str] = mapped_column(String, nullable=False)
    event_type: Mapped[str] = mapped_column(String, nullable=False)
    source: Mapped[str] = mapped_column(
        String, default="user_action"
    )  # user_action | ai_agent | system
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, server_default=func.now(), nullable=False
    )
    version: Mapped[int] = mapped_column(Integer, default=1)
    correlation_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    causation_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String, nullable=True, unique=True)

    __table_args__ = (
        Index("ix_learning_events_user_timeline", "user_id", "occurred_at"),
        Index("ix_learning_events_goal_type", "goal_id", "event_type"),
        Index("ix_learning_events_aggregate", "aggregate_type", "aggregate_id"),
        Index("ix_learning_events_event_type", "event_type", "occurred_at"),
        Index("ix_learning_events_event_type_col", "event_type"),
    )


# ── Phase-2C Learner Model ─────────────────────────────────────────────────


class LearnerProfile(Base):
    """用户学习行为当前状态快照（State）。

    批处理每日重算，观测窗口内的聚合统计。不含 confidence。
    与 LearnerPattern 的关键区别：Profile = 现在是什么，Pattern = 长期规律是什么。
    """

    __tablename__ = "learner_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=True, index=True
    )

    # ── 坚持度 ──────────────────────────────────────────────────────────────
    consistency_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    weekly_active_days: Mapped[float | None] = mapped_column(Float, nullable=True)

    # ── 投入时长 ─────────────────────────────────────────────────────────────
    avg_session_duration_mins: Mapped[float | None] = mapped_column(Float, nullable=True)
    avg_daily_investment_mins: Mapped[float | None] = mapped_column(Float, nullable=True)

    # ── 完成率 / 掌握率 ──────────────────────────────────────────────────────
    completion_rate_30d: Mapped[float | None] = mapped_column(Float, nullable=True)
    mastery_rate_30d: Mapped[float | None] = mapped_column(Float, nullable=True)
    mastery_velocity: Mapped[float | None] = mapped_column(Float, nullable=True)  # items/week

    # ── 时段偏好（小时，0-23） ────────────────────────────────────────────────
    preferred_hour_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preferred_hour_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preferred_weekdays: Mapped[list | None] = mapped_column(JSON, nullable=True)  # [0-6]

    # ── 估时准确性 ───────────────────────────────────────────────────────────
    estimation_accuracy: Mapped[float | None] = mapped_column(
        Float, nullable=True
    )  # actual/estimated ratio
    debt_tendency: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-1
    reschedule_rate: Mapped[float | None] = mapped_column(Float, nullable=True)  # 0-1

    # ── 元数据 ───────────────────────────────────────────────────────────────
    observation_window_days: Mapped[int] = mapped_column(Integer, default=30)
    event_count: Mapped[int] = mapped_column(Integer, default=0)
    last_computed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_learner_profiles_last_computed", "last_computed_at"),
        Index(
            "uq_learner_profiles_user_scope",
            "user_id",
            unique=True,
            postgresql_where=goal_id.is_(None),
            sqlite_where=goal_id.is_(None),
        ),
        Index(
            "uq_learner_profiles_goal_scope",
            "user_id",
            "goal_id",
            unique=True,
            postgresql_where=goal_id.isnot(None),
            sqlite_where=goal_id.isnot(None),
        ),
    )


class LearnerPattern(Base):
    """用户长期行为知识（Knowledge）。

    事件驱动近实时更新，confidence 随时间衰减。
    scope 三级：user / skill_category / goal（Agent 查询时 fallback chain）。
    lifecycle: candidate → active → decayed → archived
    """

    __tablename__ = "learner_patterns"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # ── 模式定义 ─────────────────────────────────────────────────────────────
    pattern_type: Mapped[str] = mapped_column(String, nullable=False)
    # 取值：preferred_study_time | session_duration_preference |
    #       weekly_capacity | task_completion_pattern |
    #       learning_pace | difficulty_preference |
    #       consistency_pattern | estimation_bias |
    #       goal_commitment | mastery_threshold
    pattern_value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 结构见 Phase_2C-1 文档 §5

    # ── 置信度 ───────────────────────────────────────────────────────────────
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    # 通用 Pattern 公式：confidence_new = confidence_old + contribution × lr × (1 - confidence_old)
    # delay_pattern 使用 pattern_value.evidence_strength 重算；它表示证据强度，不表示用户动机概率。
    # 衰减：每 14 天未收到 evidence 开始按 decay_rate 衰减
    evidence_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── 范围与参数 ───────────────────────────────────────────────────────────
    scope: Mapped[str] = mapped_column(String, nullable=False, default="goal")
    # "user" | "skill_category" | "goal"
    decay_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.05)
    # 每次衰减步长（归一化，0-1）

    # ── 生命周期 ─────────────────────────────────────────────────────────────
    status: Mapped[str] = mapped_column(String, nullable=False, default="candidate")
    # "candidate" | "active" | "decayed" | "archived"
    first_observed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    last_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    user_review_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    user_override: Mapped[dict[str, Any]] = mapped_column(
        JSON, default=dict, server_default="{}", nullable=False
    )
    user_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    # ── 元数据 ───────────────────────────────────────────────────────────────
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_learner_patterns_status_confidence", "status", "confidence"),
        Index("ix_learner_patterns_type_status", "pattern_type", "status"),
    )


class LearnerPatternAudit(Base):
    """Append-only user-visible history for learner-memory controls."""

    __tablename__ = "learner_pattern_audits"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    pattern_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    actor_type: Mapped[str] = mapped_column(String(24), default="user", nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    before_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    after_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    reversible: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    undone_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    __table_args__ = (Index("ix_learner_pattern_audits_user_created", "user_id", "created_at"),)


class LearnerPatternSuppression(Base):
    """Minimal tombstone preventing a forgotten inference from being rebuilt."""

    __tablename__ = "learner_pattern_suppressions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    pattern_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    scope: Mapped[str] = mapped_column(String, nullable=False)
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=True
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        Index(
            "ix_learner_pattern_suppressions_lookup",
            "user_id",
            "pattern_type",
            "scope",
            "goal_id",
            unique=True,
        ),
    )


class PatternEvidence(Base):
    """Pattern 支撑证据（Traceability）。

    溯源链：LearnerPattern → LearningEvent。
    Append-only，永久保留（未来冷热分层时迁移，不删除）。
    """

    __tablename__ = "pattern_evidences"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    pattern_id: Mapped[str] = mapped_column(
        String, ForeignKey("learner_patterns.id", ondelete="CASCADE"), nullable=False, index=True
    )
    learning_event_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("learning_events.id", ondelete="SET NULL"), nullable=True, index=True
    )

    # ── 贡献量 ───────────────────────────────────────────────────────────────
    contribution: Mapped[float] = mapped_column(Float, nullable=False, default=1.0)
    # contribution = base_contribution × reliability（来自 extraction rule YAML）

    # ── 时间 & 元信息 ────────────────────────────────────────────────────────
    recorded_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 存放 extraction rule name、base_contribution、reliability 等调试信息
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_pattern_evidences_recorded_at", "recorded_at"),
        UniqueConstraint(
            "pattern_id",
            "learning_event_id",
            name="uq_pattern_evidence_event",
        ),
    )


# ── Phase-2C Intelligence Infrastructure ──────────────────────────────────


class IntelligenceCursor(Base):
    """Intelligence Layer 游标表：记录各 consumer 处理到的 LearningEvent 位置。

    多个 consumer（pattern_analyzer / profile_builder / recommendation_engine 等）
    各自维护独立游标，互不干扰。游标以 created_at 为坐标（单调递增，补录安全）。
    """

    __tablename__ = "intelligence_cursors"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    consumer_name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    # 标识 consumer，如 "pattern_analyzer" / "profile_builder"

    last_event_id: Mapped[str | None] = mapped_column(String, nullable=True)
    # 最后一条已处理 LearningEvent 的 id（用于日志/调试）

    last_processed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 游标时间戳（对应 LearningEvent.created_at）
    # 下次查询：WHERE created_at > last_processed_at

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


# ── Phase-2C Decision & Feedback Loop ─────────────────────────────────────


class DecisionProposal(Base):
    """Agent 的待审决策；业务数据只能在用户接受后经 apply gateway 修改。"""

    __tablename__ = "decision_proposals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    proposal_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    reasoning: Mapped[list[str]] = mapped_column(JSON, default=list)
    proposed_changes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    action_capability: Mapped[str | None] = mapped_column(String, nullable=True)
    action_seed: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    converted_run_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    evidence_references: Mapped[list[str]] = mapped_column(JSON, default=list)
    confidence: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    status: Mapped[str] = mapped_column(String, nullable=False, default="pending", index=True)
    lifecycle_status: Mapped[str] = mapped_column(
        String, nullable=False, default="insight", server_default="insight", index=True
    )
    requires_user_confirmation: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String, nullable=False, default="ai_agent")
    model_name: Mapped[str | None] = mapped_column(String, nullable=True)
    agent_trace: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    application_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    applied_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "confidence >= 0.0 AND confidence <= 1.0",
            name="ck_decision_proposals_confidence",
        ),
        Index("ix_decision_proposals_user_status", "user_id", "status"),
    )


class InsightActionRun(Base):
    """Append-only Insight→Run history with one active conversion per Insight."""

    __tablename__ = "insight_action_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    insight_id: Mapped[str] = mapped_column(
        String, ForeignKey("decision_proposals.id", ondelete="CASCADE"), nullable=False, index=True
    )
    run_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="CASCADE"), nullable=False, unique=True
    )
    status: Mapped[str] = mapped_column(String, nullable=False, default="converted", index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    change_set_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    approval_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    history: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index(
            "uq_insight_action_run_active",
            "insight_id",
            unique=True,
            postgresql_where=is_active.is_(True),
            sqlite_where=is_active.is_(True),
        ),
    )


class PendingActionIntent(Base):
    __tablename__ = "pending_action_intents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(String, nullable=False)
    conversation_turn_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    missing_slots: Mapped[list[str]] = mapped_column(JSON, default=list)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "session_id", name="uq_pending_action_user_session"),
    )


class ProposalFeedback(Base):
    """用户对已执行 Proposal 的一次效果反馈。"""

    __tablename__ = "proposal_feedback"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    proposal_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("decision_proposals.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    outcome: Mapped[str] = mapped_column(String, nullable=False, index=True)
    rating: Mapped[int | None] = mapped_column(Integer, nullable=True)
    comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    observed_metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "rating IS NULL OR (rating >= 1 AND rating <= 5)",
            name="ck_proposal_feedback_rating",
        ),
        UniqueConstraint("proposal_id", name="proposal_feedback_proposal_id_key"),
    )


# ── Phase-4 Intelligence Enhancement ─────────────────────────────────────


class LearnerCognitiveProfile(Base):
    """Recomputable cognitive and behavioral capability snapshot."""

    __tablename__ = "learner_cognitive_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=True, index=True
    )
    learning_speed: Mapped[float | None] = mapped_column(Float, nullable=True)
    retention_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    forgetting_rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    transfer_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    persistence_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    procrastination_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    recovery_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    difficulty_preference: Mapped[float | None] = mapped_column(Float, nullable=True)
    challenge_tolerance: Mapped[float | None] = mapped_column(Float, nullable=True)
    feedback_acceptance: Mapped[float | None] = mapped_column(Float, nullable=True)
    observation_window_days: Mapped[int] = mapped_column(Integer, default=90)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    last_computed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("confidence >= 0.0 AND confidence <= 1.0", name="ck_cognitive_confidence"),
        Index(
            "uq_cognitive_profiles_user_scope",
            "user_id",
            unique=True,
            postgresql_where=goal_id.is_(None),
            sqlite_where=goal_id.is_(None),
        ),
        Index(
            "uq_cognitive_profiles_goal_scope",
            "user_id",
            "goal_id",
            unique=True,
            postgresql_where=goal_id.isnot(None),
            sqlite_where=goal_id.isnot(None),
        ),
    )


class LearningMemory(Base):
    """Append-only episodic memory distilled from learning events."""

    __tablename__ = "learning_memories"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    memory_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    source_event_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("learning_events.id", ondelete="SET NULL"), nullable=True, index=True
    )
    importance: Mapped[float] = mapped_column(Float, default=0.5)
    metadata_json: Mapped[dict[str, Any]] = mapped_column("metadata", JSON, default=dict)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        CheckConstraint("importance >= 0.0 AND importance <= 1.0", name="ck_memory_importance"),
        UniqueConstraint("source_event_id", "memory_type", name="uq_memory_event_type"),
        Index("ix_learning_memories_user_recency", "user_id", "occurred_at"),
    )


class LearningConcept(Base):
    """A learner-owned concept node with mastery and retention state."""

    __tablename__ = "learning_concepts"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    normalized_name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    mastery_score: Mapped[float] = mapped_column(Float, default=0.0)
    initial_strength: Mapped[float] = mapped_column(Float, default=0.5)
    forgetting_rate: Mapped[float] = mapped_column(Float, default=0.05)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="learning", index=True)
    last_reviewed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    next_review_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("mastery_score >= 0.0 AND mastery_score <= 1.0", name="ck_concept_mastery"),
        CheckConstraint(
            "initial_strength >= 0.0 AND initial_strength <= 1.0", name="ck_concept_strength"
        ),
        Index(
            "uq_learning_concepts_user_scope",
            "user_id",
            "normalized_name",
            unique=True,
            postgresql_where=goal_id.is_(None),
            sqlite_where=goal_id.is_(None),
        ),
        Index(
            "uq_learning_concepts_goal_scope",
            "user_id",
            "goal_id",
            "normalized_name",
            unique=True,
            postgresql_where=goal_id.isnot(None),
            sqlite_where=goal_id.isnot(None),
        ),
    )


class KnowledgeEdge(Base):
    """Typed edge from a concept to another concept or an existing resource node."""

    __tablename__ = "knowledge_edges"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    source_concept_id: Mapped[str] = mapped_column(
        String, ForeignKey("learning_concepts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    target_concept_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("learning_concepts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    resource_item_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("knowledge_items.id", ondelete="CASCADE"), nullable=True, index=True
    )
    relation_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    weight: Mapped[float] = mapped_column(Float, default=1.0)
    confidence: Mapped[float] = mapped_column(Float, default=0.5)
    evidence_count: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "(target_concept_id IS NOT NULL AND resource_item_id IS NULL) OR "
            "(target_concept_id IS NULL AND resource_item_id IS NOT NULL)",
            name="ck_knowledge_edge_target",
        ),
        CheckConstraint("confidence >= 0.0 AND confidence <= 1.0", name="ck_edge_confidence"),
        Index(
            "uq_knowledge_edge_concept_target",
            "source_concept_id",
            "target_concept_id",
            "relation_type",
            unique=True,
            postgresql_where=target_concept_id.isnot(None),
            sqlite_where=target_concept_id.isnot(None),
        ),
        Index(
            "uq_knowledge_edge_resource_target",
            "source_concept_id",
            "resource_item_id",
            "relation_type",
            unique=True,
            postgresql_where=resource_item_id.isnot(None),
            sqlite_where=resource_item_id.isnot(None),
        ),
    )


class AgentEval(Base):
    """Persisted benchmark result for longitudinal Agent quality tracking."""

    __tablename__ = "agent_evals"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    benchmark_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    case_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    category: Mapped[str] = mapped_column(String, nullable=False, index=True)
    input_case: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    expected_output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    actual_output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    planning_quality: Mapped[float] = mapped_column(Float, default=0.0)
    recommendation_accuracy: Mapped[float] = mapped_column(Float, default=0.0)
    user_acceptance: Mapped[float | None] = mapped_column(Float, nullable=True)
    long_term_improvement: Mapped[float | None] = mapped_column(Float, nullable=True)
    passed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    model_name: Mapped[str | None] = mapped_column(String, nullable=True)
    prompt_version: Mapped[str | None] = mapped_column(String, nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("benchmark_name", "case_id", name="uq_agent_eval_benchmark_case"),
    )


# ── Phase-5 Production-grade Learning Agent ───────────────────────────────


class PromptVersion(Base):
    __tablename__ = "prompt_versions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False)
    template: Mapped[str] = mapped_column(Text, nullable=False)
    variables_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    output_schema: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    change_note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("agent_type", "name", "version", name="uq_prompt_agent_name_version"),
    )


class ModelConfig(Base):
    __tablename__ = "model_configs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False)
    provider: Mapped[str] = mapped_column(String, nullable=False)
    model_name: Mapped[str] = mapped_column(String, nullable=False)
    temperature: Mapped[float] = mapped_column(Float, default=0.2)
    max_tokens: Mapped[int] = mapped_column(Integer, default=700)
    timeout_ms: Mapped[int] = mapped_column(Integer, default=60000)
    retry_policy: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    credential_alias: Mapped[str] = mapped_column(String, default="default")
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("name", "version", name="uq_model_config_version"),)


class AgentPolicyVersion(Base):
    __tablename__ = "agent_policy_versions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False)
    rules: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rules_schema_version: Mapped[str] = mapped_column(String, default="v1")
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    change_note: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String, nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint("agent_type", "name", "version", name="uq_policy_agent_name_version"),
    )


class AgentDeployment(Base):
    __tablename__ = "agent_deployments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    environment: Mapped[str] = mapped_column(String, nullable=False, index=True)
    prompt_version_id: Mapped[str] = mapped_column(
        String, ForeignKey("prompt_versions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    model_config_id: Mapped[str] = mapped_column(
        String, ForeignKey("model_configs.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    policy_version_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    status: Mapped[str] = mapped_column(String, default="active", index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    deployed_by: Mapped[str] = mapped_column(String, nullable=False)
    rollback_of_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_deployments.id", ondelete="SET NULL"), nullable=True
    )
    deployed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index(
            "uq_agent_deployment_active",
            "agent_type",
            "environment",
            unique=True,
            postgresql_where=status == "active",
            sqlite_where=status == "active",
        ),
    )


class AgentInvocation(Base):
    __tablename__ = "agent_invocations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    agent_run_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_step_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_steps.id", ondelete="SET NULL"), nullable=True
    )
    proposal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("decision_proposals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    prompt_version_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("prompt_versions.id", ondelete="SET NULL"), nullable=True, index=True
    )
    model_config_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("model_configs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    policy_version_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_policy_versions.id", ondelete="SET NULL"), nullable=True
    )
    experiment_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="SET NULL"), nullable=True, index=True
    )
    variant_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("experiment_variants.id", ondelete="SET NULL"), nullable=True, index=True
    )
    input_context_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    prompt_render_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    fallback: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    error_category: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    trace_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("trace_id", name="uq_agent_invocation_trace"),)


class EvaluationDataset(Base):
    __tablename__ = "evaluation_datasets"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False)
    version: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    source_type: Mapped[str] = mapped_column(String, default="curated")
    context_schema_version: Mapped[str] = mapped_column(String, default="decision-context-v2")
    label_schema_version: Mapped[str] = mapped_column(String, default="agent-label-v1")
    split: Mapped[str] = mapped_column(String, default="validation")
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    case_count: Mapped[int] = mapped_column(Integer, default=0)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("name", "version", name="uq_eval_dataset_version"),)


class EvaluationCase(Base):
    __tablename__ = "evaluation_cases"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    dataset_id: Mapped[str] = mapped_column(
        String, ForeignKey("evaluation_datasets.id", ondelete="CASCADE"), nullable=False, index=True
    )
    case_key: Mapped[str] = mapped_column(String, nullable=False)
    category: Mapped[str] = mapped_column(String, nullable=False, index=True)
    input_context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    expected_output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    reference_evidence: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    safety_expectations: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    label_source: Mapped[str] = mapped_column(String, default="curated")
    label_confidence: Mapped[float] = mapped_column(Float, default=1.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("dataset_id", "case_key", name="uq_eval_case_key"),)


class EvaluationRun(Base):
    __tablename__ = "evaluation_runs"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    dataset_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("evaluation_datasets.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    prompt_version_id: Mapped[str] = mapped_column(
        String, ForeignKey("prompt_versions.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    model_config_id: Mapped[str] = mapped_column(
        String, ForeignKey("model_configs.id", ondelete="RESTRICT"), nullable=False, index=True
    )
    policy_version_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    baseline_run_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("evaluation_runs.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    seed: Mapped[int | None] = mapped_column(Integer, nullable=True)
    summary_metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class EvaluationResult(Base):
    __tablename__ = "evaluation_results"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    evaluation_run_id: Mapped[str] = mapped_column(
        String, ForeignKey("evaluation_runs.id", ondelete="CASCADE"), nullable=False, index=True
    )
    case_id: Mapped[str] = mapped_column(
        String, ForeignKey("evaluation_cases.id", ondelete="CASCADE"), nullable=False, index=True
    )
    agent_invocation_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_invocations.id", ondelete="SET NULL"), nullable=True
    )
    actual_output: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    recommendation_score: Mapped[float] = mapped_column(Float, default=0.0)
    planning_score: Mapped[float] = mapped_column(Float, default=0.0)
    evidence_score: Mapped[float] = mapped_column(Float, default=0.0)
    safety_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    safety_findings: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    token_usage: Mapped[int] = mapped_column(Integer, default=0)
    evaluator_versions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    passed: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("evaluation_run_id", "case_id", name="uq_eval_result_case"),)


class Experiment(Base):
    __tablename__ = "experiments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    hypothesis: Mapped[str] = mapped_column(Text, nullable=False)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    environment: Mapped[str] = mapped_column(String, default="production")
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    allocation_percent: Mapped[float] = mapped_column(Float, default=0.0)
    primary_metric: Mapped[str] = mapped_column(String, nullable=False)
    secondary_metrics: Mapped[list[str]] = mapped_column(JSON, default=list)
    guardrail_metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    eligibility_rules: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    minimum_sample_size: Mapped[int] = mapped_column(Integer, default=100)
    analysis_plan: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    approved_by: Mapped[str | None] = mapped_column(String, nullable=True)
    start_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    end_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )


class ExperimentVariant(Base):
    __tablename__ = "experiment_variants"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    experiment_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    key: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    traffic_weight: Mapped[float] = mapped_column(Float, nullable=False)
    prompt_version_id: Mapped[str] = mapped_column(
        String, ForeignKey("prompt_versions.id", ondelete="RESTRICT"), nullable=False
    )
    model_config_id: Mapped[str] = mapped_column(
        String, ForeignKey("model_configs.id", ondelete="RESTRICT"), nullable=False
    )
    policy_version_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_policy_versions.id", ondelete="RESTRICT"), nullable=False
    )
    is_control: Mapped[bool] = mapped_column(Boolean, default=False)
    treatment_config: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("experiment_id", "key", name="uq_experiment_variant"),)


class ExperimentAssignment(Base):
    __tablename__ = "experiment_assignments"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    experiment_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    variant_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiment_variants.id", ondelete="CASCADE"), nullable=False
    )
    bucket: Mapped[int] = mapped_column(Integer, nullable=False)
    assignment_version: Mapped[str] = mapped_column(String, default="v1")
    eligibility_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    assigned_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    __table_args__ = (
        UniqueConstraint("experiment_id", "user_id", name="uq_experiment_assignment_user"),
    )


class ExperimentExposure(Base):
    __tablename__ = "experiment_exposures"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    assignment_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("experiment_assignments.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    agent_invocation_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("agent_invocations.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
    )
    context_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    exposed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)


class AgentFeedbackEvent(Base):
    __tablename__ = "agent_feedback_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_invocation_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_invocations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    proposal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("decision_proposals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    run_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    source_event_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("learning_events.id", ondelete="SET NULL"), nullable=True
    )
    feedback_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    attribution_window: Mapped[str] = mapped_column(String, default="immediate")
    metric_version: Mapped[str] = mapped_column(String, default="v1")
    dedupe_key: Mapped[str] = mapped_column(String(200), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (UniqueConstraint("dedupe_key", name="uq_agent_feedback_dedupe"),)


class AgentMetricsDaily(Base):
    __tablename__ = "agent_metrics_daily"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    metric_date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    prompt_version_id: Mapped[str | None] = mapped_column(String, nullable=True)
    model_config_id: Mapped[str | None] = mapped_column(String, nullable=True)
    policy_version_id: Mapped[str | None] = mapped_column(String, nullable=True)
    experiment_id: Mapped[str | None] = mapped_column(String, nullable=True)
    variant_id: Mapped[str | None] = mapped_column(String, nullable=True)
    segment_key: Mapped[str] = mapped_column(String, default="all")
    dimension_key: Mapped[str] = mapped_column(String(64), nullable=False)
    metric_version: Mapped[str] = mapped_column(String, default="v1")
    metrics: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    health_status: Mapped[str] = mapped_column(String, default="healthy", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "metric_date",
            "agent_type",
            "dimension_key",
            "metric_version",
            name="uq_agent_metrics_daily_dimensions",
        ),
    )


class AgentIncident(Base):
    __tablename__ = "agent_incidents"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    severity: Mapped[str] = mapped_column(String, nullable=False, index=True)
    agent_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    deployment_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_deployments.id", ondelete="SET NULL"), nullable=True
    )
    experiment_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="SET NULL"), nullable=True
    )
    trigger_metric: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    evidence_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String, default="open", index=True)
    action_taken: Mapped[str | None] = mapped_column(String, nullable=True)
    rollback_deployment_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_deployments.id", ondelete="SET NULL"), nullable=True
    )
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    resolved_by: Mapped[str | None] = mapped_column(String, nullable=True)


# ── Phase-6 Production hardening and canary release ────────────────────────


class OfflineEvaluationGate(Base):
    """Immutable release decision derived from one versioned evaluation run."""

    __tablename__ = "offline_evaluation_gates"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    evaluation_run_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("evaluation_runs.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    status: Mapped[str] = mapped_column(String, nullable=False, index=True)
    criteria_version: Mapped[str] = mapped_column(String, default="production-gate-v1")
    criteria: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    metrics_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    failures: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    dataset_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    decided_by: Mapped[str] = mapped_column(String, nullable=False)
    decided_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class CanaryRelease(Base):
    """Mutable pointer for a release; its transitions remain append-only."""

    __tablename__ = "canary_releases"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    experiment_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("experiments.id", ondelete="RESTRICT"),
        nullable=False,
        unique=True,
    )
    offline_gate_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("offline_evaluation_gates.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    baseline_deployment_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("agent_deployments.id", ondelete="RESTRICT"),
        nullable=False,
    )
    agent_type: Mapped[str] = mapped_column(String, default="coach", index=True)
    environment: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="draft", index=True)
    current_stage: Mapped[str] = mapped_column(String, default="internal", index=True)
    traffic_percent: Mapped[float] = mapped_column(Float, default=0.0)
    guardrails: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "traffic_percent >= 0.0 AND traffic_percent <= 100.0",
            name="ck_canary_traffic_percent",
        ),
    )


class CanaryStageTransition(Base):
    """Append-only audit trail for stage changes, pauses and rollbacks."""

    __tablename__ = "canary_stage_transitions"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    canary_release_id: Mapped[str] = mapped_column(
        String,
        ForeignKey("canary_releases.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    from_stage: Mapped[str | None] = mapped_column(String, nullable=True)
    to_stage: Mapped[str] = mapped_column(String, nullable=False)
    action: Mapped[str] = mapped_column(String, nullable=False, index=True)
    reason: Mapped[str] = mapped_column(Text, default="")
    metrics_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    actor: Mapped[str] = mapped_column(String, nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class PredictionObservation(Base):
    """A prediction and its eventual real-world outcome for calibration."""

    __tablename__ = "prediction_observations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    user_id: Mapped[str] = mapped_column(
        String, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="CASCADE"), nullable=True, index=True
    )
    task_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("tasks.id", ondelete="SET NULL"), nullable=True, index=True
    )
    prediction_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    algorithm_version: Mapped[str] = mapped_column(String, nullable=False, index=True)
    predicted_probability: Mapped[float] = mapped_column(Float, nullable=False)
    feature_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    target_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    target_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    target_scheduled_date: Mapped[str | None] = mapped_column(String, nullable=True)
    outcome_event_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("learning_events.id", ondelete="SET NULL"), nullable=True, index=True
    )
    prediction_key: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    predicted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    outcome_due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    actual_outcome: Mapped[bool | None] = mapped_column(Boolean, nullable=True, index=True)
    actual_value: Mapped[float | None] = mapped_column(Float, nullable=True)
    outcome_source: Mapped[str | None] = mapped_column(String, nullable=True)
    outcome_recorded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        CheckConstraint(
            "predicted_probability >= 0.0 AND predicted_probability <= 1.0",
            name="ck_prediction_probability",
        ),
        Index(
            "ix_prediction_observations_calibration",
            "prediction_type",
            "algorithm_version",
            "predicted_at",
        ),
    )


class PredictionCalibrationSnapshot(Base):
    """Versioned aggregate; it never changes the prediction heuristic."""

    __tablename__ = "prediction_calibration_snapshots"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    prediction_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    algorithm_version: Mapped[str] = mapped_column(String, nullable=False, index=True)
    window_start: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    window_end: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    outcome_count: Mapped[int] = mapped_column(Integer, default=0)
    brier_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    expected_calibration_error: Mapped[float | None] = mapped_column(Float, nullable=True)
    buckets: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String, default="insufficient_data", index=True)
    calculated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "prediction_type",
            "algorithm_version",
            "window_start",
            "window_end",
            name="uq_prediction_calibration_window",
        ),
    )


class AgentTraceSpan(Base):
    """OpenTelemetry-compatible persisted span without raw prompt content."""

    __tablename__ = "agent_trace_spans"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    trace_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    span_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    parent_span_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    agent_invocation_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_invocations.id", ondelete="CASCADE"), nullable=True, index=True
    )
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    goal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("goals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    name: Mapped[str] = mapped_column(String, nullable=False)
    span_kind: Mapped[str] = mapped_column(String, default="internal")
    status: Mapped[str] = mapped_column(String, default="ok", index=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    latency_ms: Mapped[float] = mapped_column(Float, default=0.0)
    input_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    output_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    estimated_cost: Mapped[float | None] = mapped_column(Float, nullable=True)
    attributes: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    error_category: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (Index("ix_agent_trace_spans_trace_started", "trace_id", "started_at"),)


class CanaryObservation(Base):
    """Append-only real exposure, decision and delayed outcome facts."""

    __tablename__ = "canary_observations"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    canary_release_id: Mapped[str] = mapped_column(
        String, ForeignKey("canary_releases.id", ondelete="CASCADE"), nullable=False, index=True
    )
    experiment_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiments.id", ondelete="CASCADE"), nullable=False, index=True
    )
    variant_id: Mapped[str] = mapped_column(
        String, ForeignKey("experiment_variants.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True
    )
    agent_invocation_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_invocations.id", ondelete="SET NULL"), nullable=True, index=True
    )
    proposal_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("decision_proposals.id", ondelete="SET NULL"), nullable=True, index=True
    )
    observation_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    metric_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    metric_value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    attribution_window: Mapped[str] = mapped_column(String, default="immediate")
    dedupe_key: Mapped[str] = mapped_column(String(200), nullable=False, unique=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    __table_args__ = (
        Index(
            "ix_canary_observations_release_metric",
            "canary_release_id",
            "observation_type",
            "metric_name",
        ),
    )


# ── Beta evidence foundation ────────────────────────────────────────────────


class AgentBetaControl(Base):
    """Server-side boundary for Action beta exposure and emergency stops."""

    __tablename__ = "agent_beta_controls"

    id: Mapped[str] = mapped_column(String, primary_key=True, default="action-beta")
    beta_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    new_action_runs_enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    cohort_mode: Mapped[str] = mapped_column(String(24), default="allowlist", nullable=False)
    traffic_percent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    allowlisted_user_ids: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    metric_version: Mapped[str] = mapped_column(
        String(64), default="action-beta-funnel-v2", nullable=False
    )
    measurement_started_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, nullable=False
    )
    paused_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    safety_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    updated_by: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "traffic_percent IN (0, 5, 20, 50)", name="ck_agent_beta_traffic_stage"
        ),
        CheckConstraint(
            "cohort_mode IN ('allowlist', 'percentage')", name="ck_agent_beta_cohort_mode"
        ),
    )


class AgentBetaControlEvent(Base):
    """Append-only audit trail for every beta control change."""

    __tablename__ = "agent_beta_control_events"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    control_id: Mapped[str] = mapped_column(
        String, ForeignKey("agent_beta_controls.id", ondelete="CASCADE"), nullable=False, index=True
    )
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    actor_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str] = mapped_column(Text, default="", nullable=False)
    before_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    after_state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())


class AgentBetaReviewSample(Base):
    """Privacy-safe review item derived only from persisted production facts."""

    __tablename__ = "agent_beta_review_samples"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=new_uuid)
    source_kind: Mapped[str] = mapped_column(String(32), nullable=False)
    source_id: Mapped[str] = mapped_column(String, nullable=False)
    run_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    conversation_turn_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    pseudonymous_user_key: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    sample_type: Mapped[str] = mapped_column(String(48), nullable=False, index=True)
    structured_context: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
    redacted_summary: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", nullable=False, index=True)
    reviewer_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewer_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    candidate_dataset_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("evaluation_datasets.id", ondelete="SET NULL"), nullable=True
    )
    retention_expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "source_kind", "source_id", "sample_type", name="uq_agent_beta_review_source_type"
        ),
        CheckConstraint(
            "status IN ('pending', 'reviewed', 'confirmed', 'dismissed')",
            name="ck_agent_beta_review_status",
        ),
    )
