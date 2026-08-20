"""Learning-data governance and portability APIs."""

from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, model_validator
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import get_db
from src.deps import get_current_user
from src.models import User
from src.services import privacy_service

router = APIRouter(prefix="/api/v1/privacy", tags=["privacy"])


class ConsentPatch(BaseModel):
    personalization_enabled: bool | None = None
    experiments_enabled: bool | None = None
    product_analytics_enabled: bool | None = None
    sensitive_inference_enabled: bool | None = None
    erase_derived_data: bool = False
    request_id: str | None = Field(default=None, min_length=8, max_length=100)

    @model_validator(mode="after")
    def has_change(self) -> "ConsentPatch":
        if not any(
            value is not None
            for value in (
                self.personalization_enabled,
                self.experiments_enabled,
                self.product_analytics_enabled,
                self.sensitive_inference_enabled,
            )
        ):
            raise ValueError("至少提供一个数据处理用途")
        if self.erase_derived_data and self.personalization_enabled is not False:
            raise ValueError("仅在关闭个性化时可删除派生数据")
        return self


@router.get("/consent")
async def get_consent(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    row = await privacy_service.get_or_create_consent(db, current_user.id)
    await db.commit()
    return privacy_service.consent_dict(row)


@router.patch("/consent")
async def patch_consent(
    body: ConsentPatch,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    changes = body.model_dump(
        exclude={"erase_derived_data", "request_id"}, exclude_none=True
    )
    return await privacy_service.update_consent(
        db,
        user_id=current_user.id,
        changes=changes,
        request_id=body.request_id,
        erase_derived_data=body.erase_derived_data,
    )


@router.get("/export")
async def export_data(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    payload = await privacy_service.build_user_export(db, current_user)
    return JSONResponse(
        payload,
        headers={"Content-Disposition": 'attachment; filename="planpilot-data-export.json"'},
    )


@router.post("/quality-report")
async def quality_report(
    window_days: int = Query(default=90, ge=7, le=365),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    return await privacy_service.generate_quality_report(
        db, user_id=current_user.id, window_days=window_days
    )
