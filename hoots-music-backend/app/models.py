from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Literal
from datetime import datetime


class UserSignup(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    email: EmailStr
    password: str = Field(min_length=6)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    name: str
    email: EmailStr
    role: Literal["user", "admin"]
    auth_provider: Literal["local", "google"]
    is_ad_free: bool = False
    is_verified: bool = False
    has_onboarded: bool = False
    created_at: datetime


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class SignupResponse(BaseModel):
    detail: str
    email: EmailStr
    # Only set when SMTP isn't configured yet — lets you test the verify
    # flow without setting up real email. Remove/ignore once SMTP is live.
    dev_verify_url: Optional[str] = None


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class PreferencesUpdate(BaseModel):
    genres: list[str] = []
    artists: list[str] = []


class NameUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=60)


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=6)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=6)


class HeartbeatRequest(BaseModel):
    seconds: int = Field(ge=1, le=60)


class SongItem(BaseModel):
    yt_id: str
    title: str
    artist: Optional[str] = None
    thumbnail: Optional[str] = None
    duration: Optional[int] = None


class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1)


class PlaylistRename(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class AdConfigUpdate(BaseModel):
    max_ads_per_day: Optional[int] = Field(default=None, ge=0, le=20)


class AdItemCreate(BaseModel):
    ad_type: Literal["video", "audio", "vast"]
    content_url: str = Field(min_length=1)
