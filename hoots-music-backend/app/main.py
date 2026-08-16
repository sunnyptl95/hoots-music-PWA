import asyncio
import os

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded

from app.config import settings
from app.database import ensure_indexes
from app.rate_limit import limiter
from app.routes.auth_routes import router as auth_router
from app.routes.music_routes import router as music_router
from app.routes.playlist_routes import router as playlist_router
from app.routes.ad_routes import router as ad_router
from app.routes.admin_routes import router as admin_router
from app.routes.recommend_routes import router as recommend_router
from app.routes.playback_routes import router as playback_router
from app.routes.home_routes import router as home_router

app = FastAPI(title="Hoots API")

app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# Needed by authlib for the OAuth state during the Google login redirect flow
app.add_middleware(SessionMiddleware, secret_key=settings.JWT_SECRET)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.FRONTEND_URL],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router)
app.include_router(music_router)
app.include_router(playlist_router)
app.include_router(ad_router)
app.include_router(admin_router)
app.include_router(recommend_router)
app.include_router(playback_router)
app.include_router(home_router)

SELF_PING_INTERVAL_SECONDS = 600  # 10 min — safely under Render's 15-min sleep threshold


async def self_ping_loop():
    """
    Keeps this instance from being spun down on Render's free tier by
    hitting its own public URL periodically. Render provides
    RENDER_EXTERNAL_URL automatically — this is a no-op anywhere else
    (local dev, other hosts), so nothing needs to be configured manually.

    Note: this only works once the app is already running — it can't wake
    itself back up from a full stop (nothing would be executing this loop).
    An external monitor (cron-job.org, UptimeRobot) is the more bulletproof
    option since it pings from outside regardless of this app's state; this
    is the "no third-party account needed" alternative.
    """
    url = os.environ.get("RENDER_EXTERNAL_URL")
    if not url:
        return
    async with httpx.AsyncClient(timeout=10.0) as client:
        while True:
            await asyncio.sleep(SELF_PING_INTERVAL_SECONDS)
            try:
                await client.get(url)
            except Exception:
                pass  # a single failed ping shouldn't kill the loop


@app.on_event("startup")
async def on_startup():
    await ensure_indexes()
    asyncio.create_task(self_ping_loop())


@app.get("/")
async def root():
    return {"status": "Hoots API running"}
