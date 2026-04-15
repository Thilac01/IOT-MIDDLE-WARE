"""
models.py — ORM models for the jpl_security_monitor database.
             Koha tables are accessed via raw SQL / reflection, not mapped here.
"""
import datetime
from typing import Optional
from sqlalchemy import (
    Integer, String, Text, DateTime, JSON,
    SmallInteger, Enum as SAEnum, func
)
from sqlalchemy.orm import Mapped, mapped_column

from database import SecurityBase


class BookWhitelist(SecurityBase):
    __tablename__ = "book_whitelist"

    id:          Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    barcode:     Mapped[str]            = mapped_column(String(50), unique=True, nullable=False, index=True)
    isbn:        Mapped[Optional[str]]  = mapped_column(String(20), nullable=True)
    title:       Mapped[str]            = mapped_column(String(512), nullable=False)
    author:      Mapped[Optional[str]]  = mapped_column(String(256), nullable=True)
    added_by:    Mapped[str]            = mapped_column(String(100), default="admin")
    reason:      Mapped[Optional[str]]  = mapped_column(Text, nullable=True)
    is_active:   Mapped[int]            = mapped_column(SmallInteger, default=1)
    created_at:  Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at:  Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())


class SecurityAlert(SecurityBase):
    __tablename__ = "security_alerts"

    id:               Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    alert_type:       Mapped[str]            = mapped_column(
        SAEnum("UNAUTHORIZED_ISSUE", "UNAUTHORIZED_RETURN", "ITEM_NOT_FOUND"), nullable=False
    )
    issue_id:         Mapped[Optional[int]]  = mapped_column(Integer, nullable=True)
    barcode:          Mapped[str]            = mapped_column(String(50), nullable=False, index=True)
    borrower_number:  Mapped[Optional[int]]  = mapped_column(Integer, nullable=True)
    borrower_name:    Mapped[Optional[str]]  = mapped_column(String(256), nullable=True)
    branch_code:      Mapped[Optional[str]]  = mapped_column(String(10), nullable=True)
    detected_at:      Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now(), index=True)
    acknowledged:     Mapped[int]            = mapped_column(SmallInteger, default=0)
    acknowledged_by:  Mapped[Optional[str]]  = mapped_column(String(100), nullable=True)
    acknowledged_at:  Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, nullable=True)
    raw_event:        Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
