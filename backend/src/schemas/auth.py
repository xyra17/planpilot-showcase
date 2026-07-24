from datetime import datetime

from pydantic import BaseModel, EmailStr, field_serializer, field_validator


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
        if len(v) < 6:
            raise ValueError("密码不能少于 6 位")
        return v


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    username: str
    created_at: datetime | None = None

    model_config = {"from_attributes": True}

    @field_serializer("created_at")
    def serialize_created_at(self, v: datetime | None) -> str | None:
        return v.isoformat() if v else None


class UpdateProfileRequest(BaseModel):
    username: str | None = None
    email: EmailStr | None = None

    @field_validator("username")
    @classmethod
    def username_valid(cls, v: str | None) -> str | None:
        if v is not None and (len(v) < 2 or len(v) > 32):
            raise ValueError("用户名长度需在 2~32 个字符之间")
        return v


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("新密码不能少于 6 位")
        return v


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str

    @field_validator("new_password")
    @classmethod
    def new_password_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("新密码不能少于 6 位")
        return v


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut
