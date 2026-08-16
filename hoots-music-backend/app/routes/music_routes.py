from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Depends, Query, Request

from app import cache
from app.auth import get_current_user
from app.database import listening_history_collection
from app.services import ytdlp_service
from app.rate_limit import limiter

router = APIRouter(tags=["music"])

SEARCH_CACHE_TTL = 60 * 10       # 10 min — search results barely change
STREAM_CACHE_TTL = 60 * 15       # 15 min — conservative, YouTube stream URLs expire


@router.get("/search")
@limiter.limit("30/minute")
async def search(
    request: Request,
    q: str = Query(..., min_length=1, description="Search text, e.g. song or artist name"),
    limit: int = Query(15, ge=1, le=30),
):
    cache_key = f"search:{q.lower().strip()}:{limit}"
    cached = cache.get(cache_key)
    if cached is not None:
        return {"results": cached, "cached": True}

    try:
        results = await ytdlp_service.search_songs(q, limit)
    except Exception as e:
        # yt-dlp breaks periodically when YouTube changes internals —
        # surfacing the real error here makes it easy to spot when
        # yt-dlp needs an upgrade (pip install -U yt-dlp).
        raise HTTPException(status_code=502, detail=f"Search failed: {e}")

    cache.set(cache_key, results, SEARCH_CACHE_TTL)
    return {"results": results, "cached": False}


@router.get("/stream/{yt_id}")
@limiter.limit("60/minute")
async def stream(request: Request, yt_id: str, user: dict = Depends(get_current_user)):
    cache_key = f"stream:{yt_id}"
    cached = cache.get(cache_key)
    if cached is not None:
        return {**cached, "cached": True}

    try:
        data = await ytdlp_service.extract_stream(yt_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Stream extraction failed: {e}")

    if not data.get("stream_url"):
        raise HTTPException(status_code=404, detail="No playable stream found for this video")

    cache.set(cache_key, data, STREAM_CACHE_TTL)

    await listening_history_collection.insert_one({
        "user_id": user["_id"],
        "yt_id": data["yt_id"],
        "title": data.get("title"),
        "artist": data.get("artist"),
        "thumbnail": data.get("thumbnail"),
        "played_at": datetime.now(timezone.utc),
        "duration_played_sec": 0,
        "completed": False,
    })

    # Recommendations are cached for a while for speed, but a fresh play
    # is a strong new signal — drop the cache so Home reflects it soon.
    cache.delete(f"reco:{user['_id']}")

    return {**data, "cached": False}
