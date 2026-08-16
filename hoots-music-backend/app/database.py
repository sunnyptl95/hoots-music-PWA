from motor.motor_asyncio import AsyncIOMotorClient
from app.config import settings

client = AsyncIOMotorClient(settings.MONGO_URI)
db = client[settings.DB_NAME]

users_collection = db["users"]
login_sessions_collection = db["login_sessions"]
listening_history_collection = db["listening_history"]
playlists_collection = db["playlists"]
ad_config_collection = db["ad_config"]
ads_collection = db["ads"]


async def ensure_indexes():
    """Call once on app startup."""
    await users_collection.create_index("email", unique=True)
    await listening_history_collection.create_index("user_id")
    await login_sessions_collection.create_index("user_id")
    await playlists_collection.create_index("user_id")
