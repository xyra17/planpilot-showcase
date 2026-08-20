"""Pattern Analyzer Tests — Phase 2C-3 Step 7

单元测试：
- ExtractionRule.condition_check()
- Confidence formula (_update_confidence)
- Decay formula (apply_decay)
- Lifecycle state machine (_run_lifecycle)

集成测试：
- Full pipeline: LearningEvent → process_event() → PatternEvidence + LearnerPattern
- Idempotency: 同一 event 不会重复创建 evidence
- Batch processing: run_batch() + cursor management
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.intelligence.event_processor import CONSUMER_NAME, process_event, run_batch
from src.intelligence.extraction_rules.base import ExtractionRule
from src.intelligence.pattern_update_engine import (
    CANDIDATE_TO_ACTIVE_CONFIDENCE,
    CONFIDENCE_INIT,
    PatternUpdateEngine,
)
from src.models import IntelligenceCursor, LearnerPattern, LearningEvent, PatternEvidence, User

# ── Test helpers ─────────────────────────────────────────────────────────────


def _uid() -> str:
    return f"u_{uuid.uuid4().hex[:8]}"


def _evid() -> str:
    return f"evt_{uuid.uuid4().hex[:8]}"


def _make_event(user_id: str, **overrides) -> LearningEvent:
    """构造有效的 LearningEvent（所有 NOT NULL 字段已填充默认值）。

    可通过 overrides 传入 created_at 来控制游标测试中的时间顺序。
    """
    defaults = dict(
        id=_evid(),
        user_id=user_id,
        aggregate_type="task",
        aggregate_id=f"task_{uuid.uuid4().hex[:8]}",
        event_type="TaskCompleted",
        occurred_at=utc_now(),
        payload={"actual_mins": 30},
    )
    defaults.update(overrides)
    return LearningEvent(**defaults)


def _make_user(uid: str | None = None) -> User:
    """构造测试用户。"""
    uid = uid or _uid()
    return User(
        id=uid,
        email=f"{uid}@test.com",
        username=uid,
        hashed_password="fakehash",
    )


# ── Unit Tests ───────────────────────────────────────────────────────────────


class TestExtractionRuleConditionCheck:
    """测试 ExtractionRule.condition_check() 方法"""

    def test_condition_none_always_true(self):
        """condition=None 时总是返回 True"""
        rule = ExtractionRule(
            rule_id="test_none",
            source_event_type="TaskCompleted",
            target_pattern_type="test_pattern",
            target_scope="user",
            base_contribution=1.0,
            reliability=0.9,
            condition=None,
        )
        event = _make_event(_uid())
        assert rule.condition_check(event) is True

    def test_condition_true_expression(self):
        """条件满足时返回 True"""
        rule = ExtractionRule(
            rule_id="test_true",
            source_event_type="TaskCompleted",
            target_pattern_type="test_pattern",
            target_scope="user",
            base_contribution=1.0,
            reliability=0.9,
            condition="payload.get('actual_mins', 0) > 0",
        )
        event = _make_event(_uid(), payload={"actual_mins": 10})
        assert rule.condition_check(event) is True

    def test_condition_false_expression(self):
        """条件不满足时返回 False"""
        rule = ExtractionRule(
            rule_id="test_false",
            source_event_type="TaskCompleted",
            target_pattern_type="test_pattern",
            target_scope="user",
            base_contribution=1.0,
            reliability=0.9,
            condition="payload.get('actual_mins', 0) > 0",
        )
        event = _make_event(_uid(), payload={"actual_mins": 0})
        assert rule.condition_check(event) is False

    def test_condition_invalid_expression_returns_false(self):
        """无效的条件表达式返回 False（不抛出异常）"""
        rule = ExtractionRule(
            rule_id="test_invalid",
            source_event_type="TaskCompleted",
            target_pattern_type="test_pattern",
            target_scope="user",
            base_contribution=1.0,
            reliability=0.9,
            condition="payload['nonexistent_key']",  # KeyError
        )
        event = _make_event(_uid(), payload={})
        assert rule.condition_check(event) is False

    def test_contribution_property(self):
        """contribution = base_contribution × reliability"""
        rule = ExtractionRule(
            rule_id="test_contrib",
            source_event_type="TaskCompleted",
            target_pattern_type="test_pattern",
            target_scope="user",
            base_contribution=1.0,
            reliability=0.9,
            condition=None,
        )
        assert abs(rule.contribution - 0.9) < 1e-9


# ── Confidence Formula ────────────────────────────────────────────────────────


class TestConfidenceFormula:
    """测试 _update_confidence() 公式"""

    def test_first_evidence_delta(self):
        """首条 evidence（count=0）：confidence 0.3 → 约 0.363"""
        confidence_new = PatternUpdateEngine._update_confidence(
            confidence_old=CONFIDENCE_INIT,  # 0.3
            contribution=0.9,
            evidence_count=0,
        )
        # lr = min(0.1, 5.0/1) = 0.1
        # delta = 0.9 × 0.1 × (1 - 0.3) = 0.063
        # new = 0.3 + 0.063 = 0.363
        assert abs(confidence_new - 0.363) < 0.001

    def test_confidence_converges_upward(self):
        """多条高 contribution evidence 后 confidence 明显增长"""
        confidence = CONFIDENCE_INIT  # 0.3
        for i in range(30):
            confidence = PatternUpdateEngine._update_confidence(
                confidence, contribution=0.9, evidence_count=i
            )
        # 30 条后应 > 0.9
        assert confidence > 0.9

    def test_confidence_clamped_at_one(self):
        """confidence 不超过 1.0"""
        confidence_new = PatternUpdateEngine._update_confidence(
            confidence_old=0.99,
            contribution=1.0,
            evidence_count=0,
        )
        assert confidence_new <= 1.0

    def test_low_contribution_slower_growth(self):
        """低 contribution 比高 contribution 增长更慢"""
        conf_low = PatternUpdateEngine._update_confidence(
            confidence_old=0.3, contribution=0.1, evidence_count=0
        )
        conf_high = PatternUpdateEngine._update_confidence(
            confidence_old=0.3, contribution=0.9, evidence_count=0
        )
        assert conf_high > conf_low

    def test_high_evidence_count_smaller_step(self):
        """evidence 多时学习率下降，步长变小"""
        delta_early = (
            PatternUpdateEngine._update_confidence(
                confidence_old=0.5, contribution=0.9, evidence_count=1
            )
            - 0.5
        )
        delta_late = (
            PatternUpdateEngine._update_confidence(
                confidence_old=0.5, contribution=0.9, evidence_count=100
            )
            - 0.5
        )
        assert delta_early > delta_late


# ── Decay Formula ─────────────────────────────────────────────────────────────


class TestDecayFormula:
    """测试 apply_decay() 公式"""

    def _make_pattern(
        self, confidence: float, last_confirmed_days_ago: int | None
    ) -> LearnerPattern:
        last_confirmed = (
            utc_now() - timedelta(days=last_confirmed_days_ago)
            if last_confirmed_days_ago is not None
            else None
        )
        return LearnerPattern(
            id=f"p_{uuid.uuid4().hex[:8]}",
            user_id="u1",
            pattern_type="preferred_learning_time",
            pattern_value={},
            confidence=confidence,
            evidence_count=10,
            scope="user",
            decay_rate=0.05,
            status="active",
            first_observed_at=utc_now(),
            last_confirmed_at=last_confirmed,
        )

    def test_within_grace_period_no_decay(self):
        """宽限期内（7天）：confidence 不变"""
        pattern = self._make_pattern(0.8, last_confirmed_days_ago=7)
        result = PatternUpdateEngine.apply_decay(pattern, utc_now())
        assert result == 0.8

    def test_at_grace_period_boundary_no_decay(self):
        """宽限期临界值（14天）：不衰减"""
        pattern = self._make_pattern(0.8, last_confirmed_days_ago=14)
        result = PatternUpdateEngine.apply_decay(pattern, utc_now())
        assert result == 0.8

    def test_after_grace_period_decays(self):
        """宽限期后（21天 = 3周）：按公式衰减"""
        pattern = self._make_pattern(0.8, last_confirmed_days_ago=21)
        result = PatternUpdateEngine.apply_decay(pattern, utc_now())
        # decay_weeks = 3 - 2 = 1; new = 0.8 × (1 - 0.05)^1 = 0.76
        assert abs(result - 0.76) < 0.001

    def test_no_last_confirmed_no_decay(self):
        """last_confirmed_at=None：不衰减"""
        pattern = self._make_pattern(0.8, last_confirmed_days_ago=None)
        result = PatternUpdateEngine.apply_decay(pattern, utc_now())
        assert result == 0.8

    def test_longer_absence_deeper_decay(self):
        """宽限期后越久衰减越多"""
        p3_weeks = self._make_pattern(0.8, last_confirmed_days_ago=21)
        p6_weeks = self._make_pattern(0.8, last_confirmed_days_ago=42)
        now = utc_now()
        conf_3w = PatternUpdateEngine.apply_decay(p3_weeks, now)
        conf_6w = PatternUpdateEngine.apply_decay(p6_weeks, now)
        assert conf_3w > conf_6w


# ── Lifecycle State Machine ───────────────────────────────────────────────────


class TestLifecycleStateMachine:
    """测试 _run_lifecycle() 状态机转换"""

    def _make_pattern(self, status: str, confidence: float, evidence_count: int) -> LearnerPattern:
        return LearnerPattern(
            id=f"p_{uuid.uuid4().hex[:8]}",
            user_id="u1",
            pattern_type="preferred_learning_time",
            pattern_value={},
            confidence=confidence,
            evidence_count=evidence_count,
            scope="user",
            decay_rate=0.05,
            status=status,
            first_observed_at=utc_now(),
        )

    def test_candidate_to_active_when_conditions_met(self):
        """candidate → active：evidence_count ≥ 5 且 confidence ≥ 0.6"""
        p = self._make_pattern("candidate", confidence=0.65, evidence_count=5)
        assert PatternUpdateEngine._run_lifecycle(p) == "active"

    def test_candidate_stays_when_low_confidence(self):
        """candidate 保持：confidence < 0.6"""
        p = self._make_pattern("candidate", confidence=0.55, evidence_count=5)
        assert PatternUpdateEngine._run_lifecycle(p) == "candidate"

    def test_candidate_stays_when_low_evidence(self):
        """candidate 保持：evidence_count < 5"""
        p = self._make_pattern("candidate", confidence=0.7, evidence_count=4)
        assert PatternUpdateEngine._run_lifecycle(p) == "candidate"

    def test_candidate_stays_when_both_low(self):
        """candidate 保持：两个条件都不满足"""
        p = self._make_pattern("candidate", confidence=0.4, evidence_count=2)
        assert PatternUpdateEngine._run_lifecycle(p) == "candidate"

    def test_decayed_to_active(self):
        """decayed → active：confidence ≥ 0.5"""
        p = self._make_pattern("decayed", confidence=0.55, evidence_count=15)
        assert PatternUpdateEngine._run_lifecycle(p) == "active"

    def test_decayed_stays_when_low_confidence(self):
        """decayed 保持：confidence < 0.5"""
        p = self._make_pattern("decayed", confidence=0.4, evidence_count=15)
        assert PatternUpdateEngine._run_lifecycle(p) == "decayed"

    def test_active_stays_active(self):
        """active 收到新 evidence 后保持 active"""
        p = self._make_pattern("active", confidence=0.8, evidence_count=20)
        assert PatternUpdateEngine._run_lifecycle(p) == "active"

    def test_archived_stays_archived(self):
        """archived 收到新 evidence 后保持 archived（不自动复活）"""
        p = self._make_pattern("archived", confidence=0.9, evidence_count=100)
        assert PatternUpdateEngine._run_lifecycle(p) == "archived"


# ── Integration Tests ────────────────────────────────────────────────────────


@pytest.mark.asyncio
class TestProcessEventIntegration:
    """集成测试：process_event() 完整流程（使用 SQLite in-memory db fixture）"""

    async def test_full_pipeline_creates_pattern_and_evidence(self, db: AsyncSession):
        """TaskCompleted → process_event() → LearnerPattern × 3 + PatternEvidence × 3

        H-1 (preferred_learning_time) + H-2 (preferred_session_length) + Pl-1 (delay_pattern)
        三条规则均对 TaskCompleted 触发。
        """
        user = _make_user()
        db.add(user)
        await db.flush()

        event = _make_event(user.id, payload={"actual_mins": 30})
        db.add(event)
        await db.flush()

        await process_event(db, event)
        await db.commit()

        # 验证 LearnerPattern（H-1 + H-2 + Pl-1，均是 scope=user）
        patterns = (
            (await db.execute(select(LearnerPattern).where(LearnerPattern.user_id == user.id)))
            .scalars()
            .all()
        )
        assert len(patterns) == 3

        pattern_types = {p.pattern_type for p in patterns}
        assert "preferred_learning_time" in pattern_types
        assert "preferred_session_length" in pattern_types
        assert "delay_pattern" in pattern_types

        # 验证每个 Pattern 的初始状态
        for p in patterns:
            assert p.evidence_count == 1
            assert p.confidence > CONFIDENCE_INIT  # 已收到首条 evidence
            assert p.status == "candidate"
            assert p.last_confirmed_at is not None

        # 验证 PatternEvidence（每条规则一条）
        evidences = (
            (
                await db.execute(
                    select(PatternEvidence).where(PatternEvidence.learning_event_id == event.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(evidences) == 3

    async def test_event_without_actual_mins_skips_h2(self, db: AsyncSession):
        """payload actual_mins=0 时，H-2 condition 不满足，只触发 H-1 + Pl-1（共2条）"""
        user = _make_user()
        db.add(user)
        await db.flush()

        event = _make_event(user.id, payload={"actual_mins": 0})
        db.add(event)
        await db.flush()

        await process_event(db, event)
        await db.commit()

        patterns = (
            (await db.execute(select(LearnerPattern).where(LearnerPattern.user_id == user.id)))
            .scalars()
            .all()
        )

        # H-2 跳过（actual_mins=0），H-1 + Pl-1 各触发一次
        assert len(patterns) == 2
        pattern_types = {p.pattern_type for p in patterns}
        assert "preferred_learning_time" in pattern_types
        assert "delay_pattern" in pattern_types
        assert "preferred_session_length" not in pattern_types

    async def test_idempotency_same_event_processed_twice(self, db: AsyncSession):
        """幂等性：同一 event 处理两次，PatternEvidence 不重复（H-1 + H-2 + Pl-1 各1条）"""
        user = _make_user()
        db.add(user)
        await db.flush()

        event = _make_event(user.id, payload={"actual_mins": 45})
        db.add(event)
        await db.flush()

        # 第一次处理
        await process_event(db, event)
        await db.commit()

        # 第二次处理（模拟重试）
        await process_event(db, event)
        await db.commit()

        # 验证：3 条 evidence（H-1, H-2, Pl-1 各一条，不重复）
        evidences = (
            (
                await db.execute(
                    select(PatternEvidence).where(PatternEvidence.learning_event_id == event.id)
                )
            )
            .scalars()
            .all()
        )
        assert len(evidences) == 3

        # Pattern evidence_count 未被重复累加
        patterns = (
            (await db.execute(select(LearnerPattern).where(LearnerPattern.user_id == user.id)))
            .scalars()
            .all()
        )
        for p in patterns:
            assert p.evidence_count == 1

    async def test_lifecycle_candidate_to_active_after_enough_evidence(self, db: AsyncSession):
        """Lifecycle：5 条 evidence + confidence ≥ 0.6 → candidate 升级为 active"""
        user = _make_user()
        db.add(user)
        await db.flush()

        # 创建并处理 6 条 TaskCompleted（H-2: preferred_session_length，每条 contribution=0.9）
        for i in range(6):
            event = _make_event(
                user.id,
                occurred_at=utc_now() + timedelta(seconds=i),
                payload={"actual_mins": 30},
            )
            db.add(event)
            await db.flush()
            await process_event(db, event)

        await db.commit()

        # preferred_session_length pattern 应已升级到 active
        pattern = await db.scalar(
            select(LearnerPattern).where(
                LearnerPattern.user_id == user.id,
                LearnerPattern.pattern_type == "preferred_session_length",
            )
        )
        assert pattern is not None
        assert pattern.evidence_count == 6
        assert pattern.confidence >= CANDIDATE_TO_ACTIVE_CONFIDENCE
        assert pattern.status == "active"

    async def test_pattern_value_aggregated_correctly(self, db: AsyncSession):
        """pattern_value 按最近 evidence 重算（preferred_session_length → percentiles）"""
        user = _make_user()
        db.add(user)
        await db.flush()

        # 3 条不同时长的 TaskCompleted
        for mins in [20, 40, 60]:
            event = _make_event(user.id, payload={"actual_mins": mins})
            db.add(event)
            await db.flush()
            await process_event(db, event)

        await db.commit()

        pattern = await db.scalar(
            select(LearnerPattern).where(
                LearnerPattern.user_id == user.id,
                LearnerPattern.pattern_type == "preferred_session_length",
            )
        )
        assert pattern is not None
        pv = pattern.pattern_value
        assert "median_mins" in pv
        assert pv["median_mins"] == 40.0  # 中位数 = 40
        assert pv["sample_count"] == 3


# ── Batch Processing ──────────────────────────────────────────────────────────
# Batch 测试共享同一个 SQLite DB 和游标（consumer_name='pattern_analyzer'）。
# 为了隔离每个测试，事件的 created_at 使用递增的"未来"时间偏移，
# 确保无论前序测试把游标推到哪，本次测试的事件都在游标之后。
# 各测试时间窗口（以 utc_now 为基准）：
#   test1 → +1h 段，test2 → +2h 段，test3 → +3h 段，test4 → +4h 段


@pytest.mark.asyncio
class TestBatchProcessing:
    """集成测试：run_batch() 批处理和游标推进"""

    async def test_run_batch_processes_events_and_advances_cursor(self, db: AsyncSession):
        """run_batch() 处理新事件并推进游标"""
        user = _make_user()
        db.add(user)

        base = utc_now() + timedelta(hours=1)
        event_ids = []
        for i in range(3):
            event = _make_event(
                user.id,
                created_at=base + timedelta(seconds=i),
                occurred_at=base + timedelta(seconds=i),
            )
            event_ids.append(event.id)
            db.add(event)

        await db.commit()

        processed = await run_batch(db, batch_size=100)
        assert processed >= 3  # 至少处理了本次创建的 3 条

        # 游标已创建并更新
        cursor = await db.scalar(
            select(IntelligenceCursor).where(IntelligenceCursor.consumer_name == CONSUMER_NAME)
        )
        assert cursor is not None
        assert cursor.last_processed_at is not None
        assert cursor.last_event_id is not None

    async def test_run_batch_cursor_prevents_reprocessing(self, db: AsyncSession):
        """游标推进后，再次 run_batch() 不重复处理已处理事件"""
        user = _make_user()
        db.add(user)

        base = utc_now() + timedelta(hours=2)
        for i in range(2):
            event = _make_event(
                user.id,
                created_at=base + timedelta(seconds=i),
                occurred_at=base + timedelta(seconds=i),
            )
            db.add(event)

        await db.commit()

        processed_1 = await run_batch(db, batch_size=100)
        assert processed_1 >= 2

        # 不新增事件，再次批处理应返回 0
        processed_2 = await run_batch(db, batch_size=100)
        assert processed_2 == 0

    async def test_run_batch_respects_batch_size_limit(self, db: AsyncSession):
        """batch_size 限制单批处理数量"""
        user = _make_user()
        db.add(user)

        base = utc_now() + timedelta(hours=3)
        for i in range(5):
            event = _make_event(
                user.id,
                created_at=base + timedelta(seconds=i),
                occurred_at=base + timedelta(seconds=i),
            )
            db.add(event)

        await db.commit()

        # batch_size=3：只处理 3 条
        processed = await run_batch(db, batch_size=3)
        assert processed == 3

        # 再处理剩余 2 条
        processed_2 = await run_batch(db, batch_size=3)
        assert processed_2 == 2

    async def test_run_batch_returns_zero_when_no_new_events(self, db: AsyncSession):
        """没有新事件时 run_batch() 返回 0"""
        # 先推进游标到当前最新（+4h 段不创建任何事件）
        await run_batch(db, batch_size=1000)

        processed = await run_batch(db, batch_size=100)
        assert processed == 0
