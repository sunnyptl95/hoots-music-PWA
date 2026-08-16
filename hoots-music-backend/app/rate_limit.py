from slowapi import Limiter
from slowapi.util import get_remote_address

# In-memory limiter — fine for a single backend instance. If you scale to
# multiple instances later, this needs a shared backend (Redis) or each
# instance enforces its own separate limit, effectively multiplying it.
limiter = Limiter(key_func=get_remote_address)
