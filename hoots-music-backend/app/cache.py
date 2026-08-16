import time
from typing import Any, Optional

# Simple in-process cache. Good enough for a single Render instance.
# If you scale to multiple instances later, swap this for Redis —
# same get/set interface, just backed by a shared store.

_cache: dict[str, tuple[float, Any]] = {}


def get(key: str) -> Optional[Any]:
    entry = _cache.get(key)
    if not entry:
        return None
    expires_at, value = entry
    if time.time() > expires_at:
        _cache.pop(key, None)
        return None
    return value


def set(key: str, value: Any, ttl_seconds: int) -> None:
    _cache[key] = (time.time() + ttl_seconds, value)


def delete(key: str) -> None:
    _cache.pop(key, None)
