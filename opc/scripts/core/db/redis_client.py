"""Redis client module for connection pooling and caching.

Provides async Redis client with singleton pattern.
Uses redis.asyncio for async operations.

TTL Configuration:
    The client supports configurable time-to-live (TTL) for cached values.
    Default TTLs are defined as constants for different cache categories.

Usage:
    from scripts.core.db.redis_client import get_redis, DEFAULT_TTL, SESSION_TTL
    client = await get_redis()
    await client.ping()

    # Set with default TTL
    await client.set("key", "value")

    # Set with custom TTL (in seconds)
    await client.setex("key", 300, "value")

    # Check TTL on a key
    ttl = await client.ttl("key")  # -1 means no expiry, -2 means key doesn't exist
"""

import os
from typing import AsyncGenerator

import redis.asyncio as redis

# TTL Configuration Constants
# Default expiration times (in seconds) for different cache categories

DEFAULT_TTL: int = 3600  # 1 hour - General cache entries
SESSION_TTL: int = 300   # 5 minutes - Session-specific data
HEARTBEAT_TTL: int = 90  # 90 seconds - Session heartbeat (3x poll interval)
MESSAGE_TTL: int = 60    # 1 minute - Blackboard messages
LOCK_TTL: int = 30       # 30 seconds - Distributed locks

# Global client instance
_client: redis.Redis | None = None
_client_lock: any = None


def _get_redis_url() -> str:
    """Get Redis connection URL from environment."""
    return (
        os.environ.get("REDIS_URL")
        or os.environ.get("OPC_REDIS_URL")
        or os.environ.get("AGENTICA_REDIS_URL")
        or os.environ.get("CONTINUOUS_CLAUDE_REDIS_URL")
        or "redis://localhost:6379/0"
    )


async def get_redis() -> redis.Redis:
    """Get or create the global Redis client.

    Thread-safe singleton pattern for connection pooling.

    Returns:
        Redis client instance
    """
    global _client, _client_lock

    if _client_lock is None:
        import asyncio
        _client_lock = asyncio.Lock()

    async with _client_lock:
        if _client is None:
            _client = redis.Redis.from_url(
                _get_redis_url(),
                decode_responses=True,
                socket_connect_timeout=5.0,
                max_connections=10,
            )
        return _client


async def close_redis() -> None:
    """Close the Redis client gracefully."""
    global _client

    if _client is not None:
        await _client.close()
        _client = None
