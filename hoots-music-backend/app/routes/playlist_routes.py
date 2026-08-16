from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from bson.errors import InvalidId

from app.database import playlists_collection
from app.auth import get_current_user
from app.models import PlaylistCreate, PlaylistRename, SongItem

router = APIRouter(prefix="/playlists", tags=["playlists"])


def _oid(playlist_id: str) -> ObjectId:
    try:
        return ObjectId(playlist_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid playlist id")


def playlist_to_out(doc: dict) -> dict:
    return {
        "id": str(doc["_id"]),
        "name": doc["name"],
        "songs": doc.get("songs", []),
        "is_default": doc.get("is_default", False),
    }


async def ensure_default_playlist(user_id: ObjectId) -> dict:
    doc = await playlists_collection.find_one({"user_id": user_id, "is_default": True})
    if doc:
        return doc
    doc = {
        "user_id": user_id,
        "name": "Liked Songs",
        "songs": [],
        "is_default": True,
        "created_at": datetime.now(timezone.utc),
    }
    result = await playlists_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return doc


@router.post("")
async def create_playlist(payload: PlaylistCreate, user: dict = Depends(get_current_user)):
    doc = {
        "user_id": user["_id"],
        "name": payload.name,
        "songs": [],
        "created_at": datetime.now(timezone.utc),
    }
    result = await playlists_collection.insert_one(doc)
    doc["_id"] = result.inserted_id
    return playlist_to_out(doc)


@router.get("")
async def list_playlists(user: dict = Depends(get_current_user)):
    cursor = playlists_collection.find({"user_id": user["_id"]})
    docs = [doc async for doc in cursor]
    if not docs:
        docs = [await ensure_default_playlist(user["_id"])]
    return [playlist_to_out(doc) for doc in docs]


@router.get("/{playlist_id}")
async def get_playlist(playlist_id: str, user: dict = Depends(get_current_user)):
    doc = await playlists_collection.find_one({"_id": _oid(playlist_id), "user_id": user["_id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Playlist not found")
    return playlist_to_out(doc)


@router.post("/{playlist_id}/songs")
async def add_song(playlist_id: str, song: SongItem, user: dict = Depends(get_current_user)):
    result = await playlists_collection.update_one(
        {"_id": _oid(playlist_id), "user_id": user["_id"]},
        {"$addToSet": {"songs": song.model_dump()}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Playlist not found")
    doc = await playlists_collection.find_one({"_id": _oid(playlist_id)})
    return playlist_to_out(doc)


@router.delete("/{playlist_id}/songs/{yt_id}")
async def remove_song(playlist_id: str, yt_id: str, user: dict = Depends(get_current_user)):
    result = await playlists_collection.update_one(
        {"_id": _oid(playlist_id), "user_id": user["_id"]},
        {"$pull": {"songs": {"yt_id": yt_id}}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Playlist not found")
    doc = await playlists_collection.find_one({"_id": _oid(playlist_id)})
    return playlist_to_out(doc)


@router.put("/{playlist_id}")
async def rename_playlist(playlist_id: str, payload: PlaylistRename, user: dict = Depends(get_current_user)):
    result = await playlists_collection.update_one(
        {"_id": _oid(playlist_id), "user_id": user["_id"]},
        {"$set": {"name": payload.name}},
    )
    if result.matched_count == 0:
        raise HTTPException(status_code=404, detail="Playlist not found")
    doc = await playlists_collection.find_one({"_id": _oid(playlist_id)})
    return playlist_to_out(doc)


@router.delete("/{playlist_id}")
async def delete_playlist(playlist_id: str, user: dict = Depends(get_current_user)):
    doc = await playlists_collection.find_one({"_id": _oid(playlist_id), "user_id": user["_id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Playlist not found")
    if doc.get("is_default"):
        raise HTTPException(status_code=400, detail="Can't delete your default Liked Songs playlist")
    await playlists_collection.delete_one({"_id": _oid(playlist_id)})
    return {"detail": "Deleted"}
