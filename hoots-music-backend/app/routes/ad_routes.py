import random
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter, Depends, HTTPException
from bson import ObjectId
from bson.errors import InvalidId

from app.database import users_collection, ad_config_collection, ads_collection
from app.auth import get_current_user, get_current_admin
from app.models import AdConfigUpdate, AdItemCreate

router = APIRouter(tags=["ads"])

AD_CONFIG_ID = "singleton"
DEFAULT_AD_CONFIG = {"max_ads_per_day": 2}


def _oid(ad_id: str) -> ObjectId:
    try:
        return ObjectId(ad_id)
    except InvalidId:
        raise HTTPException(status_code=400, detail="Invalid ad id")


async def get_ad_config() -> dict:
    config = await ad_config_collection.find_one({"_id": AD_CONFIG_ID})
    if not config:
        config = {"_id": AD_CONFIG_ID, **DEFAULT_AD_CONFIG}
        await ad_config_collection.insert_one(config)
    return config


async def resolve_vast(tag_url: str) -> Optional[dict]:
    """Fetches a VAST ad tag (what real ad networks like Adsterra/
    PropellerAds/Google Ad Manager return) and pulls out a playable
    MediaFile URL. Done server-side — a browser can't fetch most ad
    servers' XML directly due to CORS."""
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(tag_url)
            resp.raise_for_status()
        root = ET.fromstring(resp.text)

        best = None
        for media_file in root.findall(".//MediaFile"):
            url = (media_file.text or "").strip()
            mtype = (media_file.get("type") or "").lower()
            if not url:
                continue
            if "mp4" in mtype:
                return {"ad_type": "video", "content_url": url}
            best = best or {"ad_type": "video", "content_url": url}
        return best
    except Exception:
        return None


@router.post("/song-ended")
async def song_ended(user: dict = Depends(get_current_user)):
    """
    Frontend calls this when a track finishes. Returns whether to show an ad
    before the next song, respecting the daily cap and per-user ad-free flag.
    One of the configured ads is picked at random each time.
    """
    if user.get("is_ad_free"):
        return {"show_ad": False}

    ads = await ads_collection.find({}).to_list(length=100)
    if not ads:
        return {"show_ad": False}  # nothing configured to show yet

    config = await get_ad_config()
    today = datetime.now(timezone.utc).date().isoformat()

    ads_shown_today = user.get("ads_shown_today", 0)
    if user.get("last_ad_date") != today:
        ads_shown_today = 0  # new day, reset count

    if ads_shown_today >= config["max_ads_per_day"]:
        return {"show_ad": False}

    chosen = random.choice(ads)

    if chosen["ad_type"] == "vast":
        resolved = await resolve_vast(chosen["content_url"])
        if not resolved:
            return {"show_ad": False}  # tag failed to resolve — skip rather than break playback
        ad_type, content_url = resolved["ad_type"], resolved["content_url"]
    else:
        ad_type, content_url = chosen["ad_type"], chosen["content_url"]

    await users_collection.update_one(
        {"_id": user["_id"]},
        {"$set": {"ads_shown_today": ads_shown_today + 1, "last_ad_date": today}},
    )

    return {"show_ad": True, "ad_type": ad_type, "content_url": content_url}


@router.get("/admin/ad-config")
async def read_ad_config(admin: dict = Depends(get_current_admin)):
    return await get_ad_config()


@router.put("/admin/ad-config")
async def update_ad_config(payload: AdConfigUpdate, admin: dict = Depends(get_current_admin)):
    updates = {k: v for k, v in payload.model_dump().items() if v is not None}
    if updates:
        await ad_config_collection.update_one(
            {"_id": AD_CONFIG_ID}, {"$set": updates}, upsert=True
        )
    return await get_ad_config()


@router.get("/admin/ads")
async def list_ads(admin: dict = Depends(get_current_admin)):
    cursor = ads_collection.find({})
    return [
        {"id": str(doc["_id"]), "ad_type": doc["ad_type"], "content_url": doc["content_url"]}
        async for doc in cursor
    ]


@router.post("/admin/ads")
async def add_ad(payload: AdItemCreate, admin: dict = Depends(get_current_admin)):
    doc = {
        "ad_type": payload.ad_type,
        "content_url": payload.content_url,
        "created_at": datetime.now(timezone.utc),
    }
    result = await ads_collection.insert_one(doc)
    return {"id": str(result.inserted_id), "ad_type": doc["ad_type"], "content_url": doc["content_url"]}


@router.delete("/admin/ads/{ad_id}")
async def delete_ad(ad_id: str, admin: dict = Depends(get_current_admin)):
    result = await ads_collection.delete_one({"_id": _oid(ad_id)})
    if result.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Ad not found")
    return {"detail": "Deleted"}
