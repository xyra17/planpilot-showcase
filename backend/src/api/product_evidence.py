"""Explicit, consent-backed product-value feedback."""

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import User
from src.services import product_validation_service

router = APIRouter(prefix="/api/v1/product-evidence", tags=["product-evidence"])


class PmfSurveyCreate(BaseModel):
    disappointment: Literal["very_disappointed", "somewhat_disappointed", "not_disappointed"]
    primary_value: str = Field(min_length=2, max_length=1000)
    request_id: str = Field(min_length=8, max_length=100)


@router.post("/pmf-survey", status_code=201)
async def submit_pmf_survey(
    body: PmfSurveyCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        return await product_validation_service.record_pmf_survey(
            db, user_id=current_user.id, **body.model_dump()
        )
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
