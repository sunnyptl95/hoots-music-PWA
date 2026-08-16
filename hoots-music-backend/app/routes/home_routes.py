import asyncio
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app import cache
from app.auth import get_current_user
from app.database import listening_history_collection, playlists_collection
from app.services import ytdlp_service
from app.routes.recommend_routes import get_recommendations

router = APIRouter(tags=["home"])

# A small, curated set of category rows shown on Home — like Spotify's
# genre shelves. Kept short so the page stays fast; feel free to edit.
FEATURED_GENRES = ["Bollywood", "Lofi", "Punjabi", "Hip-Hop", "EDM", "Romantic", "Party"]

GENRE_CACHE_TTL = 60 * 60       # 1 hour — genre picks don't need to be fresh-fresh
TRENDING_CACHE_TTL = 60 * 30    # 30 min


async def _get_genre_songs(genre: str):
    cache_key = f"genre:{genre.lower()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return genre, cached
    try:
        songs = await ytdlp_service.search_songs(
            f"{genre} songs", limit=10, max_duration_seconds=ytdlp_service.MAX_SONG_DURATION_SECONDS
        )
    except Exception:
        songs = []
    cache.set(cache_key, songs, GENRE_CACHE_TTL)
    return genre, songs


async def _get_trending():
    cache_key = "trending"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    # Real trending: what people have actually been playing across the
    # whole app in the last 7 days.
    since = datetime.now(timezone.utc) - timedelta(days=7)
    pipeline = [
        {"$match": {"played_at": {"$gte": since}}},
        {"$group": {
            "_id": "$yt_id",
            "title": {"$first": "$title"},
            "artist": {"$first": "$artist"},
            "thumbnail": {"$first": "$thumbnail"},
            "plays": {"$sum": 1},
        }},
        {"$sort": {"plays": -1}},
        {"$limit": 15},
    ]
    results = await listening_history_collection.aggregate(pipeline).to_list(length=15)
    songs = [
        {
            "yt_id": r["_id"], "title": r.get("title"), "artist": r.get("artist"),
            "thumbnail": r.get("thumbnail"), "duration": None,
        }
        for r in results if r.get("_id")
    ]

    if len(songs) < 5:
        # Not enough real usage yet (new app / few users) — fall back to a
        # live search so the row is never sparse or empty.
        try:
            songs = await ytdlp_service.search_songs(
                "trending songs this week", limit=15, max_duration_seconds=ytdlp_service.MAX_SONG_DURATION_SECONDS
            )
        except Exception:
            songs = []

    cache.set(cache_key, songs, TRENDING_CACHE_TTL)
    return songs


@router.get("/home")
async def get_home(user: dict = Depends(get_current_user)):
    reco_task = get_recommendations(user)
    trending_task = _get_trending()
    genre_tasks = [_get_genre_songs(g) for g in FEATURED_GENRES]
    featured_task = playlists_collection.find({"is_featured": True}).to_list(length=10)

    # Run everything concurrently — sequential yt-dlp searches would make
    # this endpoint painfully slow on a cold cache.
    reco_result, trending_result, featured_docs, *genre_results = await asyncio.gather(
        reco_task, trending_task, featured_task, *genre_tasks
    )

    featured_playlists = [
        {"name": doc["name"], "songs": doc.get("songs", [])}
        for doc in featured_docs if doc.get("songs")
    ]

    return {
        "recommended": reco_result["results"],
        "trending": trending_result,
        "genres": {name: songs for name, songs in genre_results},
        "featured_playlists": featured_playlists,
    }
