from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import Goal, LearningDebt, User

router = APIRouter(prefix="/api/v1/debts", tags=["debts"])


class DebtOut(BaseModel):
    id: str
    goal_id: str
    task_id: str | None
    content: str
    estimated_hours: float
    skip_reason: str | None
    impact: str
    status: str
    created_at: str

    model_config = {"from_attributes": True}


def _to_out(d: LearningDebt) -> DebtOut:
    return DebtOut(
        id=d.id,
        goal_id=d.goal_id,
        task_id=d.task_id,
        content=d.content,
        estimated_hours=d.estimated_hours,
        skip_reason=d.skip_reason,
        impact=d.impact,
        status=d.status,
        created_at=d.created_at.isoformat()
        if isinstance(d.created_at, datetime)
        else str(d.created_at),
    )


@router.get("/{goal_id}", response_model=list[DebtOut])
async def list_debts(
    goal_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[DebtOut]:
    goal = (
        await db.execute(select(Goal).where(Goal.id == goal_id, Goal.user_id == current_user.id))
    ).scalar_one_or_none()
    if not goal:
        raise HTTPException(404, "目标不存在")

    debts = (
        (
            await db.execute(
                select(LearningDebt)
                .where(LearningDebt.goal_id == goal_id, LearningDebt.status == "open")
                .order_by(LearningDebt.created_at.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_to_out(d) for d in debts]


@router.patch("/{debt_id}/resolve", response_model=DebtOut)
async def resolve_debt(
    debt_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DebtOut:
    debt = (
        await db.execute(
            select(LearningDebt)
            .join(Goal, Goal.id == LearningDebt.goal_id)
            .where(LearningDebt.id == debt_id, Goal.user_id == current_user.id)
        )
    ).scalar_one_or_none()
    if not debt:
        raise HTTPException(404, "债务记录不存在")
    debt.status = "resolved"
    await db.commit()
    await db.refresh(debt)
    return _to_out(debt)
