import random

from fastapi import APIRouter, Depends

from app import cache
from app.auth import get_current_user
from app.database import listening_history_collection
from app.services import ytdlp_service

router = APIRouter(tags=["recommendations"])

RECO_CACHE_TTL = 60 * 20  # 20 min

# Used only when a user has no preferences and no listening history yet
# (brand-new account) — so Home never shows a blank state.
FALLBACK_QUERIES = [
    "trending hindi songs 2026",
    "top bollywood hits",
    "popular lofi mix",
    "top english pop hits",
]


@router.get("/recommendations")
async def get_recommendations(user: dict = Depends(get_current_user)):
    cache_key = f"reco:{user['_id']}"
    cached = cache.get(cache_key)
    if cached is not None:
        return {"results": cached}

    seed_terms = []

    # Actual recent listening behavior comes first — this is what makes
    # recommendations shift as the person's taste shifts, rather than
    # staying frozen on whatever genres they picked once during onboarding.
    # Sorting by most-recent plays (not all-time) before grouping means a
    # week of new listening habits outweighs old history.
    pipeline = [
        {"$match": {"user_id": user["_id"], "artist": {"$ne": None}}},
        {"$sort": {"played_at": -1}},
        {"$limit": 40},
        {"$group": {"_id": "$artist", "plays": {"$sum": 1}}},
        {"$sort": {"plays": -1}},
        {"$limit": 4},
    ]
    top = await listening_history_collection.aggregate(pipeline).to_list(length=4)
    seed_terms += [
        t["_id"] for t in top
        if t.get("_id") and not ytdlp_service.is_generic_uploader(t["_id"])
    ]

    # Onboarding preferences fill in the rest — most useful early on,
    # before much listening history has built up.
    if len(seed_terms) < 3:
        seed_terms += (user.get("preferred_artists") or [])[:2]
        seed_terms += [f"{g} songs" for g in (user.get("preferred_genres") or [])[:2]]

    if not seed_terms:
        # Brand new user, nothing to go on yet — generic trending picks.
        seed_terms = random.sample(FALLBACK_QUERIES, 2)

    # De-dupe while preserving priority order, cap seed count so this
    # doesn't fan out into too many parallel searches.
    seen_terms = set()
    deduped_terms = []
    for t in seed_terms:
        key = t.lower().strip()
        if key and key not in seen_terms:
            seen_terms.add(key)
            deduped_terms.append(t)
    seed_terms = deduped_terms[:4]

    results = []
    seen_ids = set()
    for term in seed_terms:
        try:
            songs = await ytdlp_service.search_songs(
                term, limit=8, max_duration_seconds=ytdlp_service.MAX_SONG_DURATION_SECONDS
            )
        except Exception:
            continue
        for s in songs:
            if s.get("yt_id") and s["yt_id"] not in seen_ids:
                seen_ids.add(s["yt_id"])
                results.append(s)

    random.shuffle(results)
    results = results[:20]

    cache.set(cache_key, results, RECO_CACHE_TTL)
    return {"results": results}
