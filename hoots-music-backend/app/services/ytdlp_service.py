import asyncio
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Optional

import yt_dlp

# yt-dlp calls are blocking and make real network requests to YouTube —
# each one occupies a thread for its full duration. A dedicated pool (vs.
# Python's default executor) means yt-dlp load never competes with other
# background work, and gives a single obvious place to scale as usage grows.
# If requests start queuing up under real traffic, raise max_workers first —
# it's the cheapest lever before reaching for caching/Redis/horizontal scaling.
_executor = ThreadPoolExecutor(max_workers=20)

# extract_flat = fast search: gets titles/ids without resolving each video's
# full formats. We only resolve full info (incl. stream url) on actual play.
SEARCH_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "extract_flat": "in_playlist",
    "skip_download": True,
    "default_search": "ytsearch",
    "noplaylist": True,
}

STREAM_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "format": "bestaudio/best",
    "skip_download": True,
    "noplaylist": True,
}


def _thumbnail_url(yt_id: Optional[str]) -> Optional[str]:
    if not yt_id:
        return None
    # hqdefault is reliably available for virtually every YouTube video
    # (unlike maxresdefault, which 404s for a lot of older/less-popular
    # videos) — this fixes the blurry/inconsistent thumbnails that came
    # from yt-dlp's flat search extraction.
    return f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg"


def _search_sync(query: str, limit: int) -> list[dict]:
    with yt_dlp.YoutubeDL(SEARCH_OPTS) as ydl:
        result = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        entries = result.get("entries", []) if result else []

        songs = []
        for e in entries:
            if not e:
                continue
            yt_id = e.get("id")
            songs.append({
                "yt_id": yt_id,
                "title": e.get("title"),
                "artist": e.get("uploader") or e.get("channel"),
                "thumbnail": _thumbnail_url(yt_id),
                "duration": e.get("duration"),
            })
        return songs


def _extract_stream_sync(yt_id: str) -> dict:
    url = f"https://www.youtube.com/watch?v={yt_id}"
    with yt_dlp.YoutubeDL(STREAM_OPTS) as ydl:
        info = ydl.extract_info(url, download=False)
        return {
            "yt_id": yt_id,
            "title": info.get("title"),
            "artist": info.get("uploader"),
            "duration": info.get("duration"),
            "thumbnail": _thumbnail_url(yt_id),
            "stream_url": info.get("url"),
        }


MAX_SONG_DURATION_SECONDS = 600  # 10 min — excludes mix/compilation videos from auto-picked results

# On YouTube, the "artist"/uploader field is very often a record label or
# channel, not the actual singer (e.g. a Bollywood song uploaded by
# "T-Series" has artist="T-Series"). Searching "T-Series songs" then
# returns ANY random T-Series upload — completely unrelated genre/mood.
# Treating these as "no usable artist" and falling back to a title-based
# search instead fixes a lot of the "similar/next played something totally
# unrelated" cases.
GENERIC_UPLOADER_NAMES = {
    "t-series", "sony music india", "zee music company", "speed records",
    "various artists", "vevo", "nocopyrightsounds", "ncs", "saregama",
    "tips official", "tips music", "eros now music", "yrf", "yash raj films",
    "sony music entertainment", "warner music", "universal music group",
    "believe music", "wave music", "desi music factory", "white hill music",
    "geet mp3", "series", "goldmines", "shemaroo", "ultra music",
}


def is_generic_uploader(name: Optional[str]) -> bool:
    if not name:
        return True
    return name.strip().lower() in GENERIC_UPLOADER_NAMES


async def search_songs(query: str, limit: int = 15, max_duration_seconds: Optional[int] = None) -> list[dict]:
    # yt-dlp is blocking/sync — run it in a thread so it doesn't block
    # other requests being handled by the same FastAPI process.
    loop = asyncio.get_event_loop()
    fetch_limit = limit * 3 if max_duration_seconds else limit  # over-fetch so filtering still leaves enough
    songs = await loop.run_in_executor(_executor, partial(_search_sync, query, fetch_limit))

    if max_duration_seconds:
        # Generic genre/artist searches on YouTube are dominated by 1-2hr
        # mix/compilation uploads — without this filter, "Bollywood songs"
        # returns almost entirely hour-long videos instead of individual
        # tracks. Anything with unknown duration is excluded too, since we
        # can't verify it's a normal-length song.
        songs = [s for s in songs if s.get("duration") and s["duration"] <= max_duration_seconds]

    return songs[:limit]


async def extract_stream(yt_id: str) -> dict:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(_executor, partial(_extract_stream_sync, yt_id))
