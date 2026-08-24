"""Pattern Update Engine — Phase 2C-3

职责：
1. Upsert LearnerPattern（找到或创建 candidate）
2. 幂等检查（同一 event 对同一 pattern 只处理一次）
3. Append PatternEvidence（append-only）
4. 更新 confidence（公式：渐近 + 学习率衰减）
5. 更新 pattern_value（evidence window 50条重算）
6. Lifecycle 状态机（candidate / active / decayed / archived）

设计约束（来自 Phase_2C-3_Pattern_Analyzer_Design.md）：
- pattern_value 使用最近50条 evidence.meta 重算，不直接累积 JSON
- 不引入 Celery / APScheduler；调用方直接 await process()
- 整批事件由调用方统一 commit
"""

from __future__ import annotations

import statistics
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import func, select

from src.core.time import utc_now
from src.models import LearnerPattern, LearnerPatternSuppression, PatternEvidence

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from src.intelligence.extraction_rules.base import ExtractionRule
    from src.models import LearningEvent

# ── 常量 ────────────────────────────────────────────────────────────────────

EVIDENCE_WINDOW = 50  # pattern_value 重算使用的最近 N 条 evidence
CANDIDATE_TO_ACTIVE_EVIDENCE = 5
CANDIDATE_TO_ACTIVE_CONFIDENCE = 0.6
DECAYED_TO_ACTIVE_CONFIDENCE = 0.5
ARCHIVED_CONFIDENCE_THRESHOLD = 0.2
DECAY_GRACE_DAYS = 14  # 宽限期（天），宽限期内不衰减
CONFIDENCE_INIT = 0.3  # 首条真实 evidence 的初始 confidence
PRIOR_CONFIDENCE_INIT = 0.1  # Cold Start system_prior 的初始 confidence


# ── 主入口 ───────────────────────────────────────────────────────────────────


class PatternUpdateEngine:
    @classmethod
    async def process(
        cls,
        db: "AsyncSession",
        event: "LearningEvent",
        rule: "ExtractionRule",
        features: dict[str, Any],
    ) -> None:
        """处理单条 Rule 对应的 Pattern 更新。

        调用方负责 db.commit()，此方法只做 db.add()。
        """
        # 1. Upsert Pattern（找到或创建 candidate）
        pattern = await cls._upsert_pattern(db, event, rule)
        if pattern is None:
            return

        # 2. 幂等检查：同一 (pattern_id, event_id) 不重复处理
        if await cls._evidence_exists(db, pattern.id, event.id):
            return

        # 3. 延期模式是有方向的观测：按时完成是反向证据，逾期完成是支持证据，
        # 归因事件只触发重算而不新增一条任务事实。
        contribution = cls._resolve_contribution(pattern.pattern_type, rule, features)

        now = utc_now()

        # 4. 先读历史 metas（在 db.add 之前）
        # 注意：SQLAlchemy 默认 autoflush=True，SELECT 前会自动 flush 待写对象。
        # 若先 db.add(PatternEvidence) 再查询，当前 evidence 会被 autoflush 写入 DB，
        # 导致它同时出现在查询结果和 recent_metas.append(features) 中（双重计入）。
        # 因此必须在 db.add 之前完成查询。
        recent_metas = await cls._get_recent_evidence_metas(
            db, pattern.id, limit=EVIDENCE_WINDOW - 1
        )
        features = {
            **features,
            "observation_event_id": event.id,
            "_recorded_at": now.isoformat(),
        }
        recent_metas.append(features)  # 追加当前（尚未持久化）

        # 5. 更新 pattern_value
        pattern.pattern_value = cls._aggregate_pattern_value(
            pattern_type=pattern.pattern_type,
            metas=recent_metas,
        )

        # 6. Append PatternEvidence（查询完成后才 add，避免 autoflush 重复计入）
        db.add(
            PatternEvidence(
                pattern_id=pattern.id,
                learning_event_id=event.id,
                contribution=contribution,
                recorded_at=now,
                meta=features,
            )
        )

        # 7. 更新 confidence 和 evidence_count
        if pattern.pattern_type == "delay_pattern":
            pattern.confidence = cls._delay_confidence(pattern.pattern_value)
        else:
            pattern.confidence = cls._update_confidence(
                confidence_old=pattern.confidence,
                contribution=contribution,
                evidence_count=pattern.evidence_count,
            )
        pattern.evidence_count += 1
        if features.get("evidence_kind") != "delay_attribution":
            pattern.last_confirmed_at = now

        # 8. Lifecycle 状态机
        pattern.status = cls._run_lifecycle(pattern)
        pattern.updated_at = now

    # ── _upsert_pattern ──────────────────────────────────────────────────────

    @classmethod
    async def _upsert_pattern(
        cls,
        db: "AsyncSession",
        event: "LearningEvent",
        rule: "ExtractionRule",
    ) -> LearnerPattern | None:
        """查找已存在的 Pattern，或创建一个新的 candidate。

        查询 key = (user_id, goal_id, pattern_type, scope)
        scope='user' 时 goal_id=None。
        """
        goal_id = event.goal_id if rule.target_scope == "goal" else None

        suppressed = await db.scalar(
            select(LearnerPatternSuppression.id).where(
                LearnerPatternSuppression.user_id == event.user_id,
                LearnerPatternSuppression.pattern_type == rule.target_pattern_type,
                LearnerPatternSuppression.scope == rule.target_scope,
                (
                    LearnerPatternSuppression.goal_id == goal_id
                    if goal_id is not None
                    else LearnerPatternSuppression.goal_id.is_(None)
                ),
            )
        )
        if suppressed is not None:
            return None

        stmt = select(LearnerPattern).where(
            LearnerPattern.user_id == event.user_id,
            LearnerPattern.pattern_type == rule.target_pattern_type,
            LearnerPattern.scope == rule.target_scope,
            (
                LearnerPattern.goal_id == goal_id
                if goal_id is not None
                else LearnerPattern.goal_id.is_(None)
            ),
        )
        result = await db.execute(stmt)
        pattern = result.scalar_one_or_none()

        if pattern is None:
            now = utc_now()
            pattern = LearnerPattern(
                user_id=event.user_id,
                goal_id=goal_id,
                pattern_type=rule.target_pattern_type,
                pattern_value={},
                confidence=CONFIDENCE_INIT,
                evidence_count=0,
                scope=rule.target_scope,
                decay_rate=_DECAY_RATES.get(rule.target_pattern_type, 0.05),
                status="candidate",
                first_observed_at=now,
                last_confirmed_at=None,
            )
            db.add(pattern)
            await db.flush()  # 获取 pattern.id，供后续 PatternEvidence FK

        return pattern

    # ── _evidence_exists ────────────────────────────────────────────────────

    @staticmethod
    def _resolve_contribution(
        pattern_type: str,
        rule: "ExtractionRule",
        features: dict[str, Any],
    ) -> float:
        if pattern_type != "delay_pattern":
            return rule.contribution
        if features.get("evidence_kind") == "delay_attribution":
            return 0.0
        return rule.contribution if features.get("days_overdue", 0) > 0 else -rule.contribution

    @staticmethod
    def _delay_confidence(pattern_value: dict[str, Any]) -> float:
        """延期模式的 confidence 表示证据强度，不表示用户动机概率。"""
        return max(0.0, min(1.0, float(pattern_value.get("evidence_strength", 0.0))))

    @classmethod
    async def _evidence_exists(
        cls,
        db: "AsyncSession",
        pattern_id: str,
        event_id: str,
    ) -> bool:
        """检查 (pattern_id, event_id) 是否已被处理（幂等保障）。"""
        count = await db.scalar(
            select(func.count(PatternEvidence.id)).where(
                PatternEvidence.pattern_id == pattern_id,
                PatternEvidence.learning_event_id == event_id,
            )
        )
        return (count or 0) > 0

    # ── _update_confidence ───────────────────────────────────────────────────

    @staticmethod
    def _update_confidence(
        confidence_old: float,
        contribution: float,
        evidence_count: int,
    ) -> float:
        """渐近式 confidence 更新，学习率随证据增多递减。

        公式（来自 Phase_2C-1 §7.3）：
          learning_rate = min(0.1, 5.0 / max(evidence_count, 1))
          Δ = contribution × learning_rate × (1.0 - confidence_old)
          confidence_new = confidence_old + Δ
          clamp [0, 1]
        """
        learning_rate = min(0.1, 5.0 / max(evidence_count, 1))
        delta = contribution * learning_rate * (1.0 - confidence_old)
        return max(0.0, min(1.0, confidence_old + delta))

    # ── _get_recent_evidence_metas ───────────────────────────────────────────

    @classmethod
    async def _get_recent_evidence_metas(
        cls,
        db: "AsyncSession",
        pattern_id: str,
        limit: int,
    ) -> list[dict[str, Any]]:
        """读取最近 N 条 PatternEvidence 的 meta 字段（用于 pattern_value 重算）。"""
        rows = await db.execute(
            select(PatternEvidence.meta, PatternEvidence.learning_event_id, PatternEvidence.recorded_at)
            .where(PatternEvidence.pattern_id == pattern_id)
            .order_by(PatternEvidence.recorded_at.desc())
            .limit(limit)
        )
        return [
            {
                **(meta or {}),
                "observation_event_id": event_id,
                "_recorded_at": recorded_at.isoformat() if recorded_at else None,
            }
            for meta, event_id, recorded_at in rows
        ]

    # ── _aggregate_pattern_value ─────────────────────────────────────────────

    @classmethod
    def _aggregate_pattern_value(
        cls,
        pattern_type: str,
        metas: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """按 pattern_type 分发到对应的聚合函数。"""
        if not metas:
            return {}
        agg = _AGGREGATORS.get(pattern_type)
        if agg is None:
            return {}
        try:
            return agg(metas)
        except Exception:
            return {}

    # ── _run_lifecycle ───────────────────────────────────────────────────────

    @staticmethod
    def _run_lifecycle(pattern: LearnerPattern) -> str:
        """根据当前指标决定新 status（仅正向转换；decayed/archived 由 DecayTask 处理）。"""
        status = pattern.status
        c = pattern.confidence
        ec = pattern.evidence_count

        if pattern.pattern_type == "delay_pattern":
            value = pattern.pattern_value or {}
            effective_n = int(value.get("effective_sample_count", 0) or 0)
            delay_rate = float(value.get("adjusted_delay_rate", 0.0) or 0.0)
            qualifies = effective_n >= 5 and delay_rate > 0.5 and c >= 0.5
            if status == "candidate":
                return "active" if qualifies else "candidate"
            if status == "active":
                return "active" if qualifies else "decayed"
            if status == "decayed":
                return "active" if qualifies else "decayed"
            return status

        if status == "candidate":
            if ec >= CANDIDATE_TO_ACTIVE_EVIDENCE and c >= CANDIDATE_TO_ACTIVE_CONFIDENCE:
                return "active"
            return "candidate"

        elif status == "decayed":
            if c >= DECAYED_TO_ACTIVE_CONFIDENCE:
                return "active"
            return "decayed"

        # active / archived：收到新 evidence 时保持不变
        return status

    # ── apply_decay（供 DecayTask 调用）─────────────────────────────────────

    @staticmethod
    def apply_decay(pattern: LearnerPattern, now: datetime) -> float:
        """计算衰减后的 confidence（宽限期14天，之后按 decay_rate 衰减）。

        供 Phase 2C-4 DecayTask 调用，不在 EventProcessor 中调用。

        公式（来自 Phase_2C-1 §7.3）：
          若 weeks_since_confirmed > 2：
            decay_weeks = weeks_since_confirmed - 2
            confidence_new = confidence_old × (1 - decay_rate)^decay_weeks
        """
        if pattern.last_confirmed_at is None:
            return pattern.confidence

        days_since = (now - pattern.last_confirmed_at).days
        weeks_since = days_since / 7.0

        if weeks_since <= (DECAY_GRACE_DAYS / 7.0):
            return pattern.confidence

        decay_weeks = weeks_since - (DECAY_GRACE_DAYS / 7.0)
        confidence_new = pattern.confidence * ((1.0 - pattern.decay_rate) ** decay_weeks)
        return max(0.0, min(1.0, confidence_new))


# ── Pattern 类型默认 decay_rate ──────────────────────────────────────────────

_DECAY_RATES: dict[str, float] = {
    "preferred_learning_time": 0.02,
    "estimation_accuracy": 0.03,
    "preferred_session_length": 0.03,
    "mastery_velocity": 0.04,
    "focus_peak_time": 0.04,
    "weekly_learning_frequency": 0.05,
    "delay_pattern": 0.05,
    "plan_adherence": 0.05,
    "distraction_pattern": 0.07,
    "completion_rate_trend": 0.10,
}


# ── pattern_value 聚合函数 ────────────────────────────────────────────────────
# 每个函数接收 list[dict]（evidence.meta 列表），返回 pattern_value dict。
# 使用最近50条 evidence 的 meta 重算，不直接累积 JSON（Phase 2C-3 设计决策 D-6）。


def _agg_preferred_learning_time(metas: list[dict]) -> dict:
    """peak_hours：取出现次数最多的小时（top-3 主峰，top-2 次峰）。"""
    from collections import Counter

    timezone_name = metas[0].get("timezone")
    if timezone_name:
        metas = [row for row in metas if row.get("timezone") == timezone_name]
    hours = [m["extracted_hour"] for m in metas if "extracted_hour" in m]
    if not hours:
        return {}
    counter = Counter(hours)
    ranked = sorted(counter.keys(), key=lambda h: counter[h], reverse=True)
    weekdays_all = [m["weekday"] for m in metas if "weekday" in m]
    wd_counter = Counter(weekdays_all)
    result = {
        "peak_hours": ranked[:3],
        "secondary_hours": ranked[3:5],
        "sample_count": len(hours),
        "weekday_dist": dict(wd_counter.most_common(7)),
    }
    if timezone_name:
        result["timezone"] = timezone_name
    return result


def _agg_preferred_session_length(metas: list[dict]) -> dict:
    """p25 / median / p75 分位数。"""
    mins_list = sorted(
        m["session_mins"] for m in metas if "session_mins" in m and m["session_mins"] > 0
    )
    n = len(mins_list)
    if n == 0:
        return {}

    def percentile(lst: list, p: float) -> float:
        idx = (len(lst) - 1) * p
        lo, hi = int(idx), min(int(idx) + 1, len(lst) - 1)
        return lst[lo] + (lst[hi] - lst[lo]) * (idx - lo)

    return {
        "p25_mins": round(percentile(mins_list, 0.25), 1),
        "median_mins": round(percentile(mins_list, 0.50), 1),
        "p75_mins": round(percentile(mins_list, 0.75), 1),
        "sample_count": n,
    }


def _agg_weekly_learning_frequency(metas: list[dict]) -> dict:
    """avg_days_per_week（28天窗口中不重复日期数 ÷ 4）。"""
    from collections import Counter

    timezone_name = metas[0].get("timezone")
    if timezone_name:
        metas = [row for row in metas if row.get("timezone") == timezone_name]
    dates = list({m["date"] for m in metas if "date" in m})
    weekdays = [m["weekday"] for m in metas if "weekday" in m]
    wd_counter = Counter(weekdays)
    all_days = sorted(wd_counter.keys(), key=lambda d: wd_counter[d], reverse=True)
    # avg_days_per_week：用唯一日期数 / 周数（近似28天）
    avg = round(len(dates) / max(len(dates) / 7, 1), 2)
    result = {
        "avg_days_per_week": avg,
        "preferred_days": all_days[:5],
        "low_days": all_days[5:],
        "sample_days": len(dates),
    }
    if timezone_name:
        result["timezone"] = timezone_name
    return result


def _agg_completion_rate_trend(metas: list[dict]) -> dict:
    """线性回归斜率（手动计算，无需 numpy）。"""
    pairs = sorted(
        [
            (m["date"], m["completion_rate"])
            for m in metas
            if "completion_rate" in m and "date" in m
        ],
        key=lambda x: x[0],
    )
    if len(pairs) < 2:
        return {
            "current_30d_avg": pairs[0][1] if pairs else None,
            "trend": "insufficient_data",
        }

    rates = [r for _, r in pairs]
    n = len(rates)
    xs = list(range(n))
    x_mean = sum(xs) / n
    y_mean = sum(rates) / n
    num = sum((x - x_mean) * (y - y_mean) for x, y in zip(xs, rates))
    den = sum((x - x_mean) ** 2 for x in xs)
    slope = (num / den) if den != 0 else 0.0

    mid = n // 2
    prev_avg = statistics.mean(rates[:mid]) if mid > 0 else y_mean
    curr_avg = statistics.mean(rates[mid:])

    trend = "stable"
    if slope > 0.005:
        trend = "improving"
    elif slope < -0.005:
        trend = "declining"

    return {
        "current_30d_avg": round(curr_avg, 4),
        "previous_30d_avg": round(prev_avg, 4),
        "trend": trend,
        "slope_per_week": round(slope * 7, 4),
        "volatility": round(statistics.stdev(rates), 4) if n >= 2 else 0.0,
        "sample_count": n,
    }


def _agg_mastery_velocity(metas: list[dict]) -> dict:
    """levels/week 滑动均值（按时间间隔计算）。"""
    from datetime import datetime as dt

    entries = sorted(
        [
            (m["occurred_at"], m["level_delta"])
            for m in metas
            if "occurred_at" in m and "level_delta" in m and m["level_delta"] > 0
        ],
        key=lambda x: x[0],
    )
    if not entries:
        return {"levels_per_week": 0.0, "sample_count": 0}

    total_delta = sum(d for _, d in entries)
    if len(entries) >= 2:
        first = dt.fromisoformat(entries[0][0])
        last = dt.fromisoformat(entries[-1][0])
        weeks = max((last - first).days / 7.0, 1.0 / 7)
        lpw = round(total_delta / weeks, 2)
    else:
        lpw = float(total_delta)

    return {
        "levels_per_week": lpw,
        "sample_count": len(entries),
    }


def _agg_delay_pattern(metas: list[dict]) -> dict:
    """延期事实与有效行为证据的可解释投影。"""
    corrections: dict[str, dict] = {}
    observations: list[dict] = []
    for meta in metas:
        if meta.get("evidence_kind") == "delay_attribution":
            target = meta.get("target_event_id")
            if target:
                previous = corrections.get(target)
                if previous is None or str(meta.get("_recorded_at") or "") >= str(previous.get("_recorded_at") or ""):
                    corrections[target] = meta
        elif "days_overdue" in meta:
            observations.append(meta)

    overdue_vals = [m["days_overdue"] for m in observations]
    if not overdue_vals:
        return {}
    avg = round(statistics.mean(overdue_vals), 2)
    effective: list[dict] = []
    excluded = 0
    by_category: dict[str, dict[str, int]] = {}
    for meta in observations:
        correction = corrections.get(meta.get("observation_event_id"))
        if meta.get("days_overdue", 0) > 0 and correction and correction.get("attribution") == "external_interruption":
            excluded += 1
            continue
        effective.append(meta)
        category = str(meta.get("task_category") or "未分类任务")
        bucket = by_category.setdefault(category, {"sample_count": 0, "delayed_count": 0})
        bucket["sample_count"] += 1
        bucket["delayed_count"] += int(meta.get("days_overdue", 0) > 0)

    support = sum(1 for m in effective if m.get("days_overdue", 0) > 0)
    opposing = sum(1 for m in effective if m.get("days_overdue", 0) <= 0)
    effective_n = support + opposing
    adjusted_rate = (1.0 + support) / (2.0 + effective_n) if effective_n else 0.0
    observed_rate = round(sum(1 for v in overdue_vals if v > 0) / len(overdue_vals), 4)
    chronic = round(sum(1 for v in overdue_vals if v > 3) / len(overdue_vals), 4)
    on_time_rate = round(sum(1 for v in overdue_vals if v <= 0) / len(overdue_vals), 4)
    return {
        "avg_days_overdue": avg,
        "chronic_delay_rate": chronic,
        "on_time_rate": on_time_rate,
        "observed_delay_rate": observed_rate,
        "adjusted_delay_rate": round(adjusted_rate, 4),
        "sample_count": len(overdue_vals),
        "effective_sample_count": effective_n,
        "supporting_count": support,
        "opposing_count": opposing,
        "excluded_count": excluded,
        "evidence_strength": round(effective_n / (effective_n + 3.0), 4) if effective_n else 0.0,
        "by_category": {
            key: {
                **value,
                "delay_rate": round(value["delayed_count"] / value["sample_count"], 4)
                if value["sample_count"] else 0.0,
            }
            for key, value in by_category.items()
        },
    }


def _agg_plan_adherence(metas: list[dict]) -> dict:
    """reschedule_rate + trigger 分布。"""
    from collections import Counter

    triggers = [m["trigger"] for m in metas if "trigger" in m]
    if not triggers:
        return {}
    counter = Counter(triggers)
    total = len(triggers)
    dist = {k: round(v / total, 4) for k, v in counter.items()}
    debt_rate = dist.get("debt_rollover", 0.0)
    stability = round(1.0 - debt_rate * dist.get("user_manual", 0.0), 4)
    return {
        "total_reschedules": total,
        "trigger_distribution": dist,
        "debt_rollover_rate": debt_rate,
        "plan_stability_score": stability,
    }


# ── 聚合函数注册表 ─────────────────────────────────────────────────────────────

_AGGREGATORS: dict[str, Any] = {
    "preferred_learning_time": _agg_preferred_learning_time,
    "preferred_session_length": _agg_preferred_session_length,
    "weekly_learning_frequency": _agg_weekly_learning_frequency,
    "completion_rate_trend": _agg_completion_rate_trend,
    "mastery_velocity": _agg_mastery_velocity,
    "delay_pattern": _agg_delay_pattern,
    "plan_adherence": _agg_plan_adherence,
}
