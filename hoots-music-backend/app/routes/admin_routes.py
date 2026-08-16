from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from bson import ObjectId
from bson.errors import InvalidId

from app.database import users_collection, listening_history_collection, playlists_collection
from app.auth import get_current_admin
from app.models import PlaylistCreate, SongItem

router = APIRouter(prefix="/admin", tags=["admin"])


def _oid(user_id: str) -> ObjectId:
    try:
        return ObjectId(user_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid user id")


def user_summary(doc: dict) -> dict:
    return {
        "id": str(doc["_id"]),
        "email": doc["email"],
        "role": doc.get("role", "user"),
        "is_ad_free": doc.get("is_ad_free", False),
        "is_banned": doc.get("is_banned", False),
        "created_at": doc["created_at"],
    }


@router.get("/users")
async def list_users(search: Optional[str] = Query(None), admin: dict = Depends(get_current_admin)):
    query = {}
    if search:
        query["email"] = {"$regex": search.strip(), "$options": "i"}
    cursor = users_collection.find(query).limit(200)
    return [user_summary(doc) async for doc in cursor]


@router.put("/users/{user_id}/ban")
async def ban_user(user_id: str, admin: dict = Depends(get_current_admin)):
    result = await users_collection.update_one({"_id": _oid(user_id)}, {"$set": {"is_banned": True}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": "User banned"}


@router.put("/users/{user_id}/unban")
async def unban_user(user_id: str, admin: dict = Depends(get_current_admin)):
    result = await users_collection.update_one({"_id": _oid(user_id)}, {"$set": {"is_banned": False}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": "User unbanned"}


@router.put("/users/{user_id}/ad-free/{enabled}")
async def toggle_ad_free(user_id: str, enabled: bool, admin: dict = Depends(get_current_admin)):
    result = await users_collection.update_one({"_id": _oid(user_id)}, {"$set": {"is_ad_free": enabled}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": "Updated"}


@router.put("/users/{user_id}/role/{role}")
async def set_user_role(user_id: str, role: str, admin: dict = Depends(get_current_admin)):
    if role not in ("user", "admin"):
        raise HTTPException(status_code=400, detail="Role must be 'user' or 'admin'")
    if str(admin["_id"]) == user_id and role == "user":
        raise HTTPException(status_code=400, detail="You can't remove your own admin access")
    result = await users_collection.update_one({"_id": _oid(user_id)}, {"$set": {"role": role}})
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="User not found")
    return {"detail": f"Role set to {role}"}


@router.get("/analytics")
async def get_analytics(admin: dict = Depends(get_current_admin)):
    total_users = await users_collection.count_documents({})
    total_plays = await listening_history_collection.count_documents({})
    total_playlists = await playlists_collection.count_documents({})

    since_today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    new_today = await users_collection.count_documents({"created_at": {"$gte": since_today}})

    since_week = datetime.now(timezone.utc) - timedelta(days=7)
    active_ids = await listening_history_collection.distinct("user_id", {"played_at": {"$gte": since_week}})
    active_this_week = len(active_ids)

    top_songs_pipeline = [
        {"$group": {"_id": "$yt_id", "title": {"$first": "$title"}, "artist": {"$first": "$artist"}, "plays": {"$sum": 1}}},
        {"$sort": {"plays": -1}},
        {"$limit": 10},
    ]
    top_songs = await listening_history_collection.aggregate(top_songs_pipeline).to_list(length=10)

    top_artists_pipeline = [
        {"$match": {"artist": {"$ne": None}}},
        {"$group": {"_id": "$artist", "plays": {"$sum": 1}}},
        {"$sort": {"plays": -1}},
        {"$limit": 5},
    ]
    top_artists = await listening_history_collection.aggregate(top_artists_pipeline).to_list(length=5)

    return {
        "total_users": total_users,
        "total_plays": total_plays,
        "total_playlists": total_playlists,
        "new_users_today": new_today,
        "active_users_7d": active_this_week,
        "top_songs": [{"title": s.get("title"), "artist": s.get("artist"), "plays": s["plays"]} for s in top_songs],
        "top_artists": [{"artist": a["_id"], "plays": a["plays"]} for a in top_artists],
    }


# --- Featured playlists: admin-curated, shown to every user on Home ---
def _playlist_oid(playlist_id: str) -> ObjectId:
    try:
        return ObjectId(playlist_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid playlist id")


def featured_to_out(doc: dict) -> dict:
    return {"id": str(doc["_id"]), "name": doc["name"], "songs": doc.get("songs", [])}


@router.get("/featured-playlists")
async def list_featured_playlists(admin: dict = Depends(get_current_admin)):
    cursor = playlists_collection.find({"is_featured": True})
    return [featured_to_out(doc) async for doc in cursor]


@router.post("/featured-playlists")
async def create_featured_playlist(payload: PlaylistCreate, admin: dict = Depends(get_current_admin)):
    doc = {
        "name": payload.name,
        "songs": [],
        "is_featured": True,
        "user_id": None,
        "created_at": datetime.now(timezone.utc),
    }
    result = await playlists_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return featured_to_out(doc)


@router.post("/featured-playlists/{playlist_id}/songs")
async def add_song_to_featured(playlist_id: str, payload: SongItem, admin: dict = Depends(get_current_admin)):
    result = await playlists_collection.update_one(
        {"_id": _playlist_oid(playlist_id), "is_featured": True},
        {"$addToSet": {"songs": payload.model_dump()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Featured playlist not found")
    doc = await playlists_collection.find_one({"_id": _playlist_oid(playlist_id)})
    return featured_to_out(doc)


@router.delete("/featured-playlists/{playlist_id}/songs/{yt_id}")
async def remove_song_from_featured(playlist_id: str, yt_id: str, admin: dict = Depends(get_current_admin)):
    result = await playlists_collection.update_one(
        {"_id": _playlist_oid(playlist_id), "is_featured": True},
        {"$pull": {"songs": {"yt_id": yt_id}}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Featured playlist not found")
    doc = await playlists_collection.find_one({"_id": _playlist_oid(playlist_id)})
    return featured_to_out(doc)


@router.delete("/featured-playlists/{playlist_id}")
async def delete_featured_playlist(playlist_id: str, admin: dict = Depends(get_current_admin)):
    result = await playlists_collection.delete_one({"_id": _playlist_oid(playlist_id), "is_featured": True})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Featured playlist not found")
    return {"detail": "Deleted"}
