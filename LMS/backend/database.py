"""
database.py — Async SQLAlchemy engine + session factories for both databases.
"""
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from config import settings

# ── Koha Read Replica (READ-ONLY queries) ─────────────────────────────────────
replica_engine = create_async_engine(
    settings.replica_dsn,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
    echo=False,
)
ReplicaSession: async_sessionmaker[AsyncSession] = async_sessionmaker(
    replica_engine, expire_on_commit=False
)

# ── Security Monitor DB (whitelist + alerts — READ/WRITE) ─────────────────────
security_engine = create_async_engine(
    settings.security_dsn,
    pool_size=5,
    max_overflow=10,
    pool_pre_ping=True,
    echo=False,
)
SecuritySession: async_sessionmaker[AsyncSession] = async_sessionmaker(
    security_engine, expire_on_commit=False
)


class ReplicaBase(DeclarativeBase):
    """Base for models mapped to the Koha read replica (reflected, not created)."""
    pass


class SecurityBase(DeclarativeBase):
    """Base for models in the jpl_security_monitor DB."""
    pass


# ── Dependency helpers for FastAPI ────────────────────────────────────────────
async def get_replica_session() -> AsyncSession:
    async with ReplicaSession() as session:
        yield session


async def get_security_session() -> AsyncSession:
    async with SecuritySession() as session:
        yield session
