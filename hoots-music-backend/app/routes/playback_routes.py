from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Query

from app import cache
from app.auth import get_current_user
from app.database import users_collection, listening_history_collection
from app.models import HeartbeatRequest
from app.services import ytdlp_service

router = APIRouter(tags=["playback"])

SIMILAR_CACHE_TTL = 60 * 15


@router.get("/similar")
async def get_similar_songs(
    artist: str = Query("", description="Artist of the currently playing song"),
    title: str = Query("", description="Title of the currently playing song"),
    exclude: str = Query("", description="yt_id to exclude (the current song itself)"),
    limit: int = Query(10, ge=1, le=20),
    user: dict = Depends(get_current_user),
):
    """
    Powers 'auto-next' during search-originated playback: rather than just
    advancing through the same short search-result list (which is often
    near-duplicates of one song), this pulls other tracks similar to
    whatever's currently playing.
    """
    artist_is_usable = bool(artist) and not ytdlp_service.is_generic_uploader(artist)
    query = f"{artist} songs" if artist_is_usable else title
    if not query:
        return {"results": []}

    cache_key = f"similar:{query.lower().strip()}:{exclude}"
    cached = cache.get(cache_key)
    if cached is not None:
        return {"results": cached}

    try:
        songs = await ytdlp_service.search_songs(
            query, limit=limit + 5, max_duration_seconds=ytdlp_service.MAX_SONG_DURATION_SECONDS
        )
    except Exception:
        return {"results": []}

    results = [s for s in songs if s.get("yt_id") and s["yt_id"] != exclude][:limit]
    cache.set(cache_key, results, SIMILAR_CACHE_TTL)
    return {"results": results}


@router.post("/playback/heartbeat")
async def playback_heartbeat(payload: HeartbeatRequest, user: dict = Depends(get_current_user)):
    """Frontend pings this every ~15s while a song is actively playing,
    so Profile can show real total listening time."""
    await users_collection.update_one(
        {"_id": user["_id"]},
        {"$inc": {"total_playtime_seconds": payload.seconds}},
    )
    return {"detail": "ok"}


@router.get("/profile/stats")
async def profile_stats(user: dict = Depends(get_current_user)):
    songs_played = await listening_history_collection.count_documents({"user_id": user["_id"]})
    return {
        "total_playtime_seconds": user.get("total_playtime_seconds", 0),
        "songs_played": songs_played,
    }


@router.get("/profile/recent")
async def profile_recent(limit: int = Query(10, ge=1, le=30), user: dict = Depends(get_current_user)):
    cursor = listening_history_collection.find({"user_id": user["_id"]}).sort("played_at", -1).limit(limit * 3)
    docs = await cursor.to_list(length=limit * 3)

    seen = set()
    results = []
    for d in docs:
        if d["yt_id"] in seen:
            continue
        seen.add(d["yt_id"])
        results.append({
            "yt_id": d["yt_id"], "title": d.get("title"), "artist": d.get("artist"),
            "thumbnail": d.get("thumbnail"), "duration": None,
        })
        if len(results) >= limit:
            break
    return {"results": results}
