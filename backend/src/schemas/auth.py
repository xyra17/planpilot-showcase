from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from email_validator import EmailNotValidError, validate_email
from pydantic import (
    AliasChoices,
    BaseModel,
    EmailStr,
    Field,
    field_serializer,
    field_validator,
    model_validator,
)

WEEKDAY_KEYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}


def _time_to_minutes(value: str) -> int:
    parts = value.split(":")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        raise ValueError("时间必须使用 HH:MM 格式")
    hour, minute = map(int, parts)
    if hour > 23 or minute > 59:
        raise ValueError("时间必须是有效的当天时间")
    return hour * 60 + minute


class AvailabilityPeriod(BaseModel):
    start: str
    end: str

    @model_validator(mode="after")
    def valid_period(self) -> "AvailabilityPeriod":
        if _time_to_minutes(self.end) <= _time_to_minutes(self.start):
            raise ValueError("可用时间的结束时间必须晚于开始时间")
        return self


WeeklyAvailability = dict[str, list[AvailabilityPeriod]]


def validate_weekly_availability(value: WeeklyAvailability | None) -> WeeklyAvailability | None:
    if value is None:
        return None
    if any(day not in WEEKDAY_KEYS for day in value):
        raise ValueError("每周可用时间包含无效星期")
    if not any(value.values()):
        raise ValueError("每周至少需要保留一个可用时间段")
    for periods in value.values():
        ordered = sorted(periods, key=lambda period: _time_to_minutes(period.start))
        for previous, current in zip(ordered, ordered[1:], strict=False):
            if _time_to_minutes(current.start) < _time_to_minutes(previous.end):
                raise ValueError("同一天的可用时间段不能重叠")
    return value


def validate_password_strength(value: str) -> str:
    if len(value) < 8:
        raise ValueError("密码不能少于 8 位")
    if not any(char.isalpha() for char in value) or not any(char.isdigit() for char in value):
        raise ValueError("密码必须同时包含字母和数字")
    return value


class RegisterRequest(BaseModel):
    email: EmailStr
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def username_alphanumeric(cls, v: str) -> str:
        if len(v) < 2 or len(v) > 32:
            raise ValueError("用户名长度需在 2~32 个字符之间")
        return v

    @field_validator("password")
    @classmethod
    def password_length(cls, v: str) -> str:
        return validate_password_strength(v)


class LoginRequest(BaseModel):
    identifier: str = Field(
        min_length=1,
        max_length=254,
        validation_alias=AliasChoices("identifier", "email"),
        description="用户名或邮箱（email 字段保留为兼容别名）",
    )
    password: str
    remember_me: bool = True

    @field_validator("identifier")
    @classmethod
    def identifier_not_blank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("请输入用户名或邮箱")
        return normalized


class UserOut(BaseModel):
    id: str
    email: str
    username: str
    avatar_url: str | None = None
    email_verified: bool = False
    is_admin: bool = False
    timezone: str = "Asia/Shanghai"
    language: Literal["zh-CN", "en-US"] = "zh-CN"
    week_start: Literal["monday", "sunday"] = "monday"
    study_days: list[str] = Field(default_factory=lambda: ["mon", "tue", "wed", "thu", "fri"])
    availability_windows: list[str] = Field(default_factory=lambda: ["evening"])
    weekly_availability: WeeklyAvailability | None = None
    ui_experience: Literal["technology", "minimal"] = "technology"
    ui_theme: Literal["base", "notebook", "dark"] = "base"
    ui_accent: str = "violet"
    font_density: Literal["compact", "comfortable", "relaxed"] = "comfortable"
    preferred_start_method: Literal[
        "create_goal", "import_plan", "connect_calendar", "sample_space"
    ] = "create_goal"
    account_preferences: dict[str, object] = Field(default_factory=dict)
    onboarding_completed: bool = False
    created_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_serializer("created_at")
    def serialize_created_at(self, v: datetime | None) -> str | None:
        return v.isoformat() if v else None


class UpdateProfileRequest(BaseModel):
    username: str | None = None
    email: EmailStr | None = None
    timezone: str | None = None
    language: Literal["zh-CN", "en-US"] | None = None
    week_start: Literal["monday", "sunday"] | None = None
    study_days: list[str] | None = None
    availability_windows: list[str] | None = None
    weekly_availability: WeeklyAvailability | None = None
    ui_experience: Literal["technology", "minimal"] | None = None
    ui_theme: Literal["base", "notebook", "dark"] | None = None
    ui_accent: str | None = None
    font_density: Literal["compact", "comfortable", "relaxed"] | None = None
    preferred_start_method: (
        Literal["create_goal", "import_plan", "connect_calendar", "sample_space"] | None
    ) = None
    account_preferences: dict[str, object] | None = None
    onboarding_completed: bool | None = None

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str | None) -> str | None:
        if v is not None and (len(v) < 2 or len(v) > 32):
            raise ValueError("用户名长度需在 2~32 个字符之间")
        return v

    @field_validator("timezone")
    @classmethod
    def timezone_valid(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError("无效的 IANA 时区") from exc
        return value

    @field_validator("study_days")
    @classmethod
    def study_days_valid(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        allowed = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
        normalized = list(dict.fromkeys(value))
        if not normalized or any(day not in allowed for day in normalized):
            raise ValueError("常用学习日至少选择一天，且必须是有效星期值")
        return normalized

    @field_validator("availability_windows")
    @classmethod
    def availability_windows_valid(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return None
        allowed = {"early_morning", "morning", "afternoon", "evening", "late_night"}
        normalized = list(dict.fromkeys(value))
        if not normalized or any(item not in allowed for item in normalized):
            raise ValueError("大致可用时段至少选择一个有效时段")
        return normalized

    @field_validator("weekly_availability")
    @classmethod
    def weekly_availability_valid(
        cls, value: WeeklyAvailability | None
    ) -> WeeklyAvailability | None:
        return validate_weekly_availability(value)

    @field_validator("ui_accent")
    @classmethod
    def ui_accent_valid(cls, value: str | None) -> str | None:
        allowed = {
            "violet",
            "ocean",
            "coral",
            "forest",
            "amber",
            "wood",
            "slate",
            "newspaper",
            "wheat",
            "night",
        }
        if value is not None and value not in allowed:
            raise ValueError("无效的界面强调色")
        return value

    @field_validator("account_preferences")
    @classmethod
    def account_preferences_valid(cls, value: dict[str, object] | None) -> dict[str, object] | None:
        if value is None:
            return None
        allowed = {"knowledge_favorites", "pilo_learned_preferences", "study_preferences"}
        if any(key not in allowed for key in value):
            raise ValueError("包含不支持的账户偏好")
        if len(str(value)) > 50_000:
            raise ValueError("账户偏好内容过大")
        study_preferences = value.get("study_preferences")
        if study_preferences is not None:
            if not isinstance(study_preferences, dict):
                raise ValueError("学习偏好格式无效")
            reminder_email = study_preferences.get("reminder_email")
            if reminder_email not in (None, ""):
                try:
                    normalized_email = validate_email(
                        str(reminder_email).strip(), check_deliverability=False
                    ).normalized.lower()
                except EmailNotValidError as exc:
                    raise ValueError("提醒邮箱格式无效") from exc
                value = {
                    **value,
                    "study_preferences": {
                        **study_preferences,
                        "reminder_email": normalized_email,
                    },
                }
        return value


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_length(cls, v: str) -> str:
        return validate_password_strength(v)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_length(cls, v: str) -> str:
        return validate_password_strength(v)


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=20, max_length=128)


class SessionResponse(BaseModel):
    user: UserOut


class RegisterResponse(SessionResponse):
    email_verification_required: bool = True
    verification_email_sent: bool = False
