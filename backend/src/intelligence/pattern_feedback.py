"""Shared feedback signal application for LearnerPattern confidence."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.time import utc_now
from src.models import LearnerPattern, LearningEvent, PatternEvidence


async def apply_pattern_signal(
    db: AsyncSession,
    *,
    user_id: str,
    pattern_ids: list[str],
    event: LearningEvent,
    contribution: float,
    source: str,
    meta: dict | None = None,
) -> list[LearnerPattern]:
    """Apply a bounded review/outcome signal and append traceable evidence."""
    if not pattern_ids:
        return []
    patterns = list(
        (
            await db.execute(
                select(LearnerPattern).where(
                    LearnerPattern.user_id == user_id,
                    LearnerPattern.id.in_(list(dict.fromkeys(pattern_ids))),
                )
            )
        )
        .scalars()
        .all()
    )
    now = utc_now()
    for pattern in patterns:
        old_confidence = pattern.confidence
        if contribution > 0:
            pattern.confidence = min(1.0, old_confidence + contribution * (1.0 - old_confidence))
        elif contribution < 0:
            pattern.confidence = max(0.0, old_confidence + contribution * old_confidence)
        pattern.evidence_count += 1
        pattern.updated_at = now
        if source == "proposal_accepted" or (
            source == "proposal_feedback" and (meta or {}).get("outcome") == "helpful"
        ):
            pattern.last_confirmed_at = now
        if pattern.status == "active" and pattern.confidence < 0.5:
            pattern.status = "decayed"
        elif pattern.status == "decayed" and pattern.confidence >= 0.5:
            pattern.status = "active"
        db.add(
            PatternEvidence(
                pattern_id=pattern.id,
                learning_event_id=event.id,
                contribution=contribution,
                recorded_at=now,
                meta={
                    "source": source,
                    "old_confidence": old_confidence,
                    "new_confidence": pattern.confidence,
                    **(meta or {}),
                },
            )
        )
    return patterns
