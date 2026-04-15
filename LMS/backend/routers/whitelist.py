"""
routers/whitelist.py — CRUD API for the Book Whitelist.
"""
from typing import Optional
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_security_session
from models import BookWhitelist
from websocket_manager import ws_manager

router = APIRouter(prefix="/whitelist", tags=["Whitelist"])


# ── Schemas ──────────────────────────────────────────────────────────────────
class WhitelistCreate(BaseModel):
    barcode: str
    isbn: Optional[str] = None
    title: str
    author: Optional[str] = None
    added_by: str = "admin"
    reason: Optional[str] = None


class WhitelistUpdate(BaseModel):
    isbn: Optional[str] = None
    title: Optional[str] = None
    author: Optional[str] = None
    reason: Optional[str] = None
    is_active: Optional[int] = None


class WhitelistOut(BaseModel):
    id: int
    barcode: str
    isbn: Optional[str]
    title: str
    author: Optional[str]
    added_by: str
    reason: Optional[str]
    is_active: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


# ── Endpoints ─────────────────────────────────────────────────────────────────
@router.get("/", response_model=list[WhitelistOut])
async def list_whitelist(
    active_only: bool = True,
    session: AsyncSession = Depends(get_security_session),
):
    """Return all whitelisted books (optionally only active ones)."""
    q = select(BookWhitelist)
    if active_only:
        q = q.where(BookWhitelist.is_active == 1)
    result = await session.execute(q)
    return result.scalars().all()


@router.post("/", response_model=WhitelistOut, status_code=status.HTTP_201_CREATED)
async def add_to_whitelist(
    body: WhitelistCreate,
    session: AsyncSession = Depends(get_security_session),
):
    """Add a new book barcode to the whitelist."""
    existing = await session.execute(
        select(BookWhitelist).where(BookWhitelist.barcode == body.barcode)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Barcode already in whitelist.")

    entry = BookWhitelist(**body.model_dump())
    session.add(entry)
    await session.commit()
    await session.refresh(entry)

    # Notify dashboard
    await ws_manager.broadcast("whitelist_update", {"action": "add", "barcode": body.barcode, "title": body.title})
    return entry


@router.put("/{entry_id}", response_model=WhitelistOut)
async def update_whitelist_entry(
    entry_id: int,
    body: WhitelistUpdate,
    session: AsyncSession = Depends(get_security_session),
):
    """Update an existing whitelist entry."""
    result = await session.execute(
        select(BookWhitelist).where(BookWhitelist.id == entry_id)
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found.")

    for field, value in body.model_dump(exclude_none=True).items():
        setattr(entry, field, value)

    await session.commit()
    await session.refresh(entry)
    await ws_manager.broadcast("whitelist_update", {"action": "update", "id": entry_id})
    return entry


@router.delete("/{entry_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_from_whitelist(
    entry_id: int,
    session: AsyncSession = Depends(get_security_session),
):
    """Soft-delete: set is_active = 0."""
    result = await session.execute(
        select(BookWhitelist).where(BookWhitelist.id == entry_id)
    )
    entry = result.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Entry not found.")

    entry.is_active = 0
    await session.commit()
    await ws_manager.broadcast("whitelist_update", {"action": "remove", "id": entry_id})
