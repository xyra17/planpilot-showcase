from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import CoachConversation, CoachPreference, Goal, User

router = APIRouter(prefix="/api/v1/coach", tags=["coach-archive"])


class CoachMessage(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    role: Literal["user", "assistant"]
    content: str = Field(max_length=100_000)
    created_at: datetime | None = None


class CoachConversationBody(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    session_id: str = Field(min_length=1, max_length=160)
    goal_id: str | None = None
    goal_title: str = Field(min_length=1, max_length=240)
    title: str = Field(min_length=1, max_length=500)
    summary: str = Field(default="", max_length=10_000)
    pilo_feedback: str = Field(default="", max_length=10_000)
    messages: list[CoachMessage] = Field(default_factory=list, max_length=2_000)
    association: str = Field(default="", max_length=1_000)
    is_favorite: bool = False
    created_at: datetime
    updated_at: datetime


class CoachPreferenceBody(BaseModel):
    tone: Literal["warm", "direct", "socratic"] = "warm"
    initiative: Literal["quiet", "balanced", "proactive"] = "balanced"
    detail: Literal["brief", "balanced", "deep"] = "balanced"
    celebrateProgress: bool = True
    motion: Literal["calm", "lively"] = "calm"


def conversation_out(record: CoachConversation) -> dict:
    return {
        "id": record.id,
        "session_id": record.session_id,
        "goal_id": record.goal_id,
        "goal_title": record.goal_title,
        "title": record.title,
        "summary": record.summary,
        "pilo_feedback": record.pilo_feedback,
        "messages": record.messages,
        "association": record.association,
        "is_favorite": record.is_favorite,
        "created_at": record.created_at.isoformat(),
        "updated_at": record.updated_at.isoformat(),
    }


@router.get("/archive")
async def get_archive(
    current_user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    conversations = (
        (
            await db.execute(
                select(CoachConversation)
                .where(CoachConversation.user_id == current_user.id)
                .order_by(CoachConversation.updated_at.desc())
            )
        )
        .scalars()
        .all()
    )
    preferences = await db.get(CoachPreference, current_user.id)
    return {
        "version": 2,
        "conversations": [conversation_out(item) for item in conversations],
        "preferences": preferences.preferences if preferences else None,
    }


@router.put("/conversations/{conversation_id}")
async def put_conversation(
    conversation_id: str,
    body: CoachConversationBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if conversation_id != body.id:
        raise HTTPException(400, "会话标识不一致")
    if body.goal_id:
        goal = (
            await db.execute(
                select(Goal.id).where(Goal.id == body.goal_id, Goal.user_id == current_user.id)
            )
        ).scalar_one_or_none()
        if not goal:
            raise HTTPException(400, "会话关联了无权访问的目标")
    record = await db.get(CoachConversation, conversation_id)
    if record and record.user_id != current_user.id:
        raise HTTPException(404, "会话不存在")
    if not record:
        record = CoachConversation(id=conversation_id, user_id=current_user.id)
        db.add(record)
    record.session_id = body.session_id
    record.goal_id = body.goal_id
    record.goal_title = body.goal_title
    record.title = body.title
    record.summary = body.summary
    record.pilo_feedback = body.pilo_feedback
    record.messages = [message.model_dump(mode="json") for message in body.messages]
    record.association = body.association
    record.is_favorite = body.is_favorite
    record.created_at = body.created_at.replace(tzinfo=None)
    record.updated_at = body.updated_at.replace(tzinfo=None)
    await db.commit()
    await db.refresh(record)
    return conversation_out(record)


@router.delete("/conversations/{conversation_id}", status_code=204)
async def delete_conversation(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    await db.execute(
        delete(CoachConversation).where(
            CoachConversation.id == conversation_id,
            CoachConversation.user_id == current_user.id,
        )
    )
    await db.commit()
    return Response(status_code=204)


@router.put("/preferences")
async def put_preferences(
    body: CoachPreferenceBody,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    record = await db.get(CoachPreference, current_user.id)
    if not record:
        record = CoachPreference(user_id=current_user.id)
        db.add(record)
    record.preferences = body.model_dump()
    await db.commit()
    return record.preferences


@router.put("/archive")
async def import_archive(
    conversations: list[CoachConversationBody],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, int]:
    imported = 0
    for body in conversations[:2_000]:
        record = await db.get(CoachConversation, body.id)
        if record and record.user_id != current_user.id:
            continue
        if not record:
            record = CoachConversation(id=body.id, user_id=current_user.id)
            db.add(record)
        record.session_id = body.session_id
        record.goal_id = None
        record.goal_title = body.goal_title
        record.title = body.title
        record.summary = body.summary
        record.pilo_feedback = body.pilo_feedback
        record.messages = [message.model_dump() for message in body.messages]
        record.association = body.association
        record.is_favorite = body.is_favorite
        record.created_at = body.created_at.replace(tzinfo=None)
        record.updated_at = body.updated_at.replace(tzinfo=None)
        imported += 1
    await db.commit()
    return {"imported": imported}
