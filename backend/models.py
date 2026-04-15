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

class RaspberryDevice(SecurityBase):
    __tablename__ = "raspberry_devices"

    id:             Mapped[int]            = mapped_column(Integer, primary_key=True, autoincrement=True)
    device_id:      Mapped[str]            = mapped_column(String(100), unique=True, nullable=False, index=True)
    name:           Mapped[str]            = mapped_column(String(100), nullable=False)
    ip_address:     Mapped[Optional[str]]  = mapped_column(String(50), nullable=True)
    floor_name:     Mapped[Optional[str]]  = mapped_column(String(50), default="Ground Floor")
    x_pos:          Mapped[Optional[float]]= mapped_column(Integer, default=50) # Percentage on map
    y_pos:          Mapped[Optional[float]]= mapped_column(Integer, default=50) # Percentage on map
    last_heartbeat: Mapped[Optional[datetime.datetime]] = mapped_column(DateTime, nullable=True)
    status:         Mapped[str]            = mapped_column(String(20), default="OFFLINE") # ONLINE, OFFLINE, WARNING
    cpu_usage:      Mapped[float]          = mapped_column(Integer, default=0)
    ram_usage:      Mapped[float]          = mapped_column(Integer, default=0)
    created_at:     Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at:     Mapped[datetime.datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())
