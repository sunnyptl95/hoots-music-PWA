from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Request, BackgroundTasks
from fastapi.responses import RedirectResponse
from bson import ObjectId
from authlib.integrations.starlette_client import OAuth

from app.config import settings
from app.database import users_collection, login_sessions_collection
from app.rate_limit import limiter
from app.models import (
    UserSignup, UserLogin, UserOut, TokenResponse, SignupResponse, ResendVerificationRequest,
    PreferencesUpdate, ForgotPasswordRequest, ResetPasswordRequest, ChangePasswordRequest,
    NameUpdate,
)
from app.auth import (
    hash_password, verify_password, create_access_token, create_token,
    decode_access_token, get_current_user,
)
from app.services import email_service

router = APIRouter(prefix="/auth", tags=["auth"])

# --- Google OAuth client setup ---
oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.GOOGLE_CLIENT_ID,
    client_secret=settings.GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


def user_to_out(user: dict) -> UserOut:
    return UserOut(
        id=str(user["_id"]),
        name=user.get("name") or user["email"].split("@")[0],
        email=user["email"],
        role=user.get("role", "user"),
        auth_provider=user.get("auth_provider", "local"),
        is_ad_free=user.get("is_ad_free", False),
        is_verified=user.get("is_verified", False),
        has_onboarded=user.get("has_onboarded", False),
        created_at=user["created_at"],
    )


def build_verify_url(user_id: str) -> str:
    token = create_token({"sub": user_id, "purpose": "verify_email"}, expire_minutes=60 * 24)
    return f"{settings.FRONTEND_URL}/#verify={token}"


def queue_verification_email(background_tasks: BackgroundTasks, user_id: str, email: str) -> Optional[str]:
    """Schedules the send in the background (so it never slows down the
    HTTP response) and returns a dev_verify_url only if SMTP isn't
    configured yet, so the flow is still testable without real email."""
    url = build_verify_url(user_id)
    if email_service.is_configured():
        html, text = email_service.verification_email(url)
        background_tasks.add_task(email_service.send_email, email, "Verify your OWLEST Music account", html, text)
        return None
    return url


def queue_welcome_email(background_tasks: BackgroundTasks, name: str, email: str):
    if not email_service.is_configured():
        return
    html, text = email_service.welcome_email(name)
    background_tasks.add_task(email_service.send_email, email, "Welcome to OWLEST Music 🦉", html, text)


def queue_login_notification(background_tasks: BackgroundTasks, name: str, email: str):
    if not email_service.is_configured():
        return
    when_str = datetime.now(timezone.utc).strftime("%b %d, %Y at %H:%M UTC")
    html, text = email_service.login_notification_email(name, when_str)
    background_tasks.add_task(email_service.send_email, email, "New login to your OWLEST Music account", html, text)


async def start_session(user_id: ObjectId, device: str = "web"):
    await login_sessions_collection.insert_one({
        "user_id": user_id,
        "login_at": datetime.now(timezone.utc),
        "logout_at": None,
        "device": device,
    })


# --- Email/password signup ---
@router.post("/signup", response_model=SignupResponse)
@limiter.limit("5/hour")
async def signup(request: Request, payload: UserSignup, background_tasks: BackgroundTasks):
    existing = await users_collection.find_one({"email": payload.email})
    if existing:
        raise HTTPException(status_code=400, detail="Email already registered")

    role = "admin" if payload.email == settings.FIRST_ADMIN_EMAIL else "user"

    # Note on security: we hash the password immediately below and never
    # retain the plaintext anywhere past this point — so there genuinely
    # is no password left to include in a confirmation email even if we
    # wanted to. Emailing a plaintext password is a serious anti-pattern
    # (exposes the account if the inbox is ever compromised) and isn't
    # something this app does, by design.
    user_doc = {
        "name": payload.name,
        "email": payload.email,
        "password_hash": hash_password(payload.password),
        "auth_provider": "local",
        "role": role,
        "is_ad_free": False,
        "is_verified": False,
        "has_onboarded": False,
        "preferred_genres": [],
        "preferred_artists": [],
        "ads_shown_today": 0,
        "last_ad_date": None,
        "total_playtime_seconds": 0,
        "created_at": datetime.now(timezone.utc),
    }
    result = await users_collection.insert_one(user_doc)

    dev_verify_url = queue_verification_email(background_tasks, str(result.inserted_id), payload.email)

    # No token, no session — the account exists but can't log in until the
    # email is verified. This is what actually stops throwaway/fake emails
    # from getting a working account (a banner alone doesn't).
    return SignupResponse(
        detail="Account created. Check your email to verify it before logging in.",
        email=payload.email,
        dev_verify_url=dev_verify_url,
    )


# --- Email/password login ---
@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(request: Request, payload: UserLogin, background_tasks: BackgroundTasks):
    user = await users_collection.find_one({"email": payload.email})
    if not user or user.get("auth_provider") != "local":
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not verify_password(payload.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if user.get("is_banned"):
        raise HTTPException(status_code=403, detail="Account suspended")
    if not user.get("is_verified"):
        raise HTTPException(status_code=403, detail="Please verify your email before logging in")

    await start_session(user["_id"])
    token = create_access_token({"sub": str(user["_id"])})
    queue_login_notification(background_tasks, user.get("name", "there"), user["email"])
    return TokenResponse(access_token=token, user=user_to_out(user))


# --- Logout: closes the most recent open session ---
@router.post("/logout")
async def logout(user: dict = Depends(get_current_user)):
    await login_sessions_collection.update_one(
        {"user_id": user["_id"], "logout_at": None},
        {"$set": {"logout_at": datetime.now(timezone.utc)}},
        sort=[("login_at", -1)],
    )
    return {"detail": "Logged out"}


# --- Current user ---
@router.get("/me", response_model=UserOut)
async def me(user: dict = Depends(get_current_user)):
    return user_to_out(user)


# --- Google OAuth: redirect to Google's consent screen ---
@router.get("/google")
async def google_login(request: Request):
    redirect_uri = settings.GOOGLE_REDIRECT_URI
    return await oauth.google.authorize_redirect(request, redirect_uri)


# --- Google OAuth: callback, creates/links account, redirects to frontend with token ---
@router.get("/google/callback")
async def google_callback(request: Request, background_tasks: BackgroundTasks):
    token = await oauth.google.authorize_access_token(request)
    userinfo = token.get("userinfo")
    if not userinfo or not userinfo.get("email"):
        raise HTTPException(status_code=400, detail="Google login failed")

    email = userinfo["email"]
    user = await users_collection.find_one({"email": email})
    is_new_user = False

    if not user:
        is_new_user = True
        role = "admin" if email == settings.FIRST_ADMIN_EMAIL else "user"
        user_doc = {
            "name": userinfo.get("name") or email.split("@")[0],
            "email": email,
            "password_hash": None,
            "auth_provider": "google",
            "role": role,
            "is_ad_free": False,
            "is_verified": True,  # Google already verified this email for us
            "has_onboarded": False,
            "preferred_genres": [],
            "preferred_artists": [],
            "ads_shown_today": 0,
            "last_ad_date": None,
            "total_playtime_seconds": 0,
            "created_at": datetime.now(timezone.utc),
        }
        result = await users_collection.insert_one(user_doc)
        user_doc["_id"] = result.inserted_id
        user = user_doc
    # if the email already exists as a local account, we just log them in —
    # linking both auth methods to the same account

    await start_session(user["_id"], device="google-oauth")
    jwt_token = create_access_token({"sub": str(user["_id"])})

    if is_new_user:
        queue_welcome_email(background_tasks, user.get("name", "there"), user["email"])
    else:
        queue_login_notification(background_tasks, user.get("name", "there"), user["email"])

    # Hand off to frontend with token in the URL fragment (not query string,
    # so it isn't logged server-side). Goes to the SPA root — there's no
    # separate /auth/callback route since this is a single static page.
    return RedirectResponse(f"{settings.FRONTEND_URL}/#token={jwt_token}")


# --- Email verification ---
@router.get("/verify-email")
async def verify_email(token: str, background_tasks: BackgroundTasks):
    payload = decode_access_token(token)
    if payload.get("purpose") != "verify_email":
        raise HTTPException(status_code=400, detail="Invalid verification link")

    user = await users_collection.find_one({"_id": ObjectId(payload["sub"])})
    if not user:
        raise HTTPException(status_code=404, detail="User not found")

    if not user.get("is_verified"):
        await users_collection.update_one({"_id": user["_id"]}, {"$set": {"is_verified": True}})
        queue_welcome_email(background_tasks, user.get("name", "there"), user["email"])

    return {"detail": "Email verified"}


@router.post("/resend-verification")
async def resend_verification(background_tasks: BackgroundTasks, user: dict = Depends(get_current_user)):
    if user.get("is_verified"):
        return {"detail": "Already verified"}
    dev_verify_url = queue_verification_email(background_tasks, str(user["_id"]), user["email"])
    resp = {"detail": "Verification email sent"}
    if dev_verify_url:
        resp["dev_verify_url"] = dev_verify_url
    return resp


@router.post("/resend-verification-by-email")
@limiter.limit("5/hour")
async def resend_verification_by_email(request: Request, payload: ResendVerificationRequest, background_tasks: BackgroundTasks):
    """For the login screen — person isn't authenticated yet, so we look up by email.
    Same response either way, to avoid leaking which emails have accounts."""
    user = await users_collection.find_one({"email": payload.email, "auth_provider": "local"})
    dev_verify_url = None
    if user and not user.get("is_verified"):
        dev_verify_url = queue_verification_email(background_tasks, str(user["_id"]), user["email"])
    resp = {"detail": "If that email is registered and unverified, a new link has been sent."}
    if dev_verify_url:
        resp["dev_verify_url"] = dev_verify_url
    return resp


# --- Forgot / reset password ---
@router.post("/forgot-password")
@limiter.limit("5/hour")
async def forgot_password(request: Request, payload: ForgotPasswordRequest, background_tasks: BackgroundTasks):
    user = await users_collection.find_one({"email": payload.email, "auth_provider": "local"})
    dev_reset_url = None

    if user:
        token = create_token({"sub": str(user["_id"]), "purpose": "reset_password"}, expire_minutes=30)
        url = f"{settings.FRONTEND_URL}/#reset={token}"
        if email_service.is_configured():
            html, text = email_service.reset_password_email(url)
            background_tasks.add_task(
                email_service.send_email, user["email"], "Reset your OWLEST Music password", html, text
            )
        else:
            dev_reset_url = url

    # Same response whether or not the email is registered — avoids
    # leaking which emails have accounts.
    resp = {"detail": "If that email is registered, a reset link has been sent."}
    if dev_reset_url:
        resp["dev_reset_url"] = dev_reset_url
    return resp


@router.post("/reset-password")
async def reset_password(payload: ResetPasswordRequest):
    token_data = decode_access_token(payload.token)
    if token_data.get("purpose") != "reset_password":
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")

    result = await users_collection.update_one(
        {"_id": ObjectId(token_data["sub"])},
        {"$set": {"password_hash": hash_password(payload.new_password)}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": "Password updated — you can log in now"}


# --- Taste preferences (onboarding survey) ---
@router.put("/preferences")
async def update_preferences(payload: PreferencesUpdate, user: dict = Depends(get_current_user)):
    await users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "preferred_genres": payload.genres,
            "preferred_artists": payload.artists,
            "has_onboarded": True,
        }},
    )
    return {"detail": "Preferences saved"}


@router.post("/onboarding/skip")
async def skip_onboarding(user: dict = Depends(get_current_user)):
    await users_collection.update_one({"_id": user["_id"]}, {"$set": {"has_onboarded": True}})
    return {"detail": "Skipped"}


@router.post("/change-password")
async def change_password(payload: ChangePasswordRequest, user: dict = Depends(get_current_user)):
    if user.get("auth_provider") != "local":
        raise HTTPException(status_code=400, detail="This account signs in with Google — no password to change")
    if not verify_password(payload.current_password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Current password is incorrect")
    await users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": hash_password(payload.new_password)}},
    )
    return {"detail": "Password updated"}


@router.put("/name")
async def update_name(payload: NameUpdate, user: dict = Depends(get_current_user)):
    await users_collection.update_one({"_id": user["_id"]}, {"$set": {"name": payload.name}})
    return {"detail": "Name updated", "name": payload.name}
