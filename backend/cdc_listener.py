"""
cdc_listener.py — Change Data Capture (CDC) using python-mysql-replication.

Connects to the PRIMARY MySQL server's binary log as a replication slave.
Watches the Koha `issues` table for INSERT events (= book checkout).
On each INSERT:
  1. Checks the barcode against the book_whitelist table.
  2. If NOT whitelisted → logs a security alert + broadcasts via WebSocket.
  3. Always broadcasts the raw row event so the Live Table Viewer updates.

Run as an asyncio background task via FastAPI lifespan.
"""
import asyncio
import json
import logging
from datetime import datetime

from pymysqlreplication import BinLogStreamReader
from pymysqlreplication.row_event import WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent
from sqlalchemy import select, text

from config import settings
from database import SecuritySession
from models import BookWhitelist, SecurityAlert
from websocket_manager import ws_manager

logger = logging.getLogger(__name__)

# Tables to monitor from the Koha schema
WATCHED_TABLES = {
    settings.replica_db: ["issues", "items", "borrowers"],
}

MYSQL_SETTINGS = {
    "host": settings.replica_host,
    "port": settings.replica_port,
    "user": settings.cdc_user,
    "passwd": settings.cdc_password,
}


def _serialise_row(row: dict) -> dict:
    """Convert MySQL types (bytes, datetime) to JSON-serialisable primitives."""
    out = {}
    for k, v in row.items():
        if isinstance(v, bytes):
            out[k] = v.decode("utf-8", errors="replace")
        elif isinstance(v, datetime):
            out[k] = v.isoformat()
        else:
            out[k] = v
    return out


async def _is_whitelisted(barcode: str) -> bool:
    """Returns True if the barcode exists in the active whitelist."""
    async with SecuritySession() as session:
        result = await session.execute(
            select(BookWhitelist.id).where(
                BookWhitelist.barcode == barcode,
                BookWhitelist.is_active == 1,
            )
        )
        return result.scalar_one_or_none() is not None


async def _record_alert(
    alert_type: str,
    barcode: str,
    issue_id: int | None,
    borrower_number: int | None,
    branch_code: str | None,
    raw_event: dict,
) -> SecurityAlert:
    """Persists an alert to the DB and returns the new record."""
    alert = SecurityAlert(
        alert_type=alert_type,
        barcode=barcode,
        issue_id=issue_id,
        borrower_number=borrower_number,
        branch_code=branch_code,
        raw_event=raw_event,
        detected_at=datetime.utcnow(),
    )
    async with SecuritySession() as session:
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
    return alert


async def _process_issue_event(event_type: str, row: dict) -> None:
    """
    Core security logic for a single issues-table row event.
    event_type: 'INSERT' | 'UPDATE' | 'DELETE'
    row: the 'values' or 'after_values' dict from the binlog event.
    """
    barcode = row.get("barcode") or ""
    issue_id = row.get("issue_id")
    borrower_number = row.get("borrowernumber")
    branch_code = row.get("branchcode") or row.get("issuingbranch")

    serialised = _serialise_row(row)

    # Broadcast live row update to dashboard regardless of whitelist status
    await ws_manager.broadcast(
        "live_row",
        {
            "table": "issues",
            "event": event_type,
            "row": serialised,
            "ts": datetime.utcnow().isoformat(),
        },
    )

    if event_type != "INSERT":
        return  # Only alert on new checkouts (INSERTs)

    if not barcode:
        logger.warning("CDC: issues INSERT has no barcode, skipping security check.")
        return

    whitelisted = await _is_whitelisted(barcode)

    if not whitelisted:
        logger.warning("🚨 SECURITY ALERT: Unauthorized checkout — barcode=%s", barcode)
        alert = await _record_alert(
            alert_type="UNAUTHORIZED_ISSUE",
            barcode=barcode,
            issue_id=issue_id,
            borrower_number=borrower_number,
            branch_code=branch_code,
            raw_event=serialised,
        )
        # Push real-time alert to all dashboard clients
        await ws_manager.broadcast(
            "security_alert",
            {
                "id": alert.id,
                "alert_type": alert.alert_type,
                "barcode": barcode,
                "issue_id": issue_id,
                "borrower_number": borrower_number,
                "branch_code": branch_code,
                "detected_at": alert.detected_at.isoformat(),
                "message": f"⚠️ Non-whitelisted book checked out! Barcode: {barcode}",
            },
        )
    else:
        logger.info("CDC: Whitelisted checkout — barcode=%s ✓", barcode)


def _run_stream_sync(loop: asyncio.AbstractEventLoop) -> None:
    """
    Synchronous function that reads from the binlog.
    Runs in a separate thread so it doesn't block the asyncio event loop.
    """
    logger.info("CDC listener starting…")
    stream = BinLogStreamReader(
        connection_settings=MYSQL_SETTINGS,
        server_id=settings.cdc_server_id,
        only_events=[WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent],
        only_tables=["issues", "items"],
        only_schemas=[settings.replica_db],
        resume_stream=True,
        blocking=True,
    )

    for binlog_event in stream:
        schema = binlog_event.schema
        table = binlog_event.table

        for row in binlog_event.rows:
            if isinstance(binlog_event, WriteRowsEvent):
                event_type = "INSERT"
                row_data = row["values"]
            elif isinstance(binlog_event, UpdateRowsEvent):
                event_type = "UPDATE"
                row_data = row["after_values"]
            elif isinstance(binlog_event, DeleteRowsEvent):
                event_type = "DELETE"
                row_data = row["values"]
            else:
                continue

            if table == "issues":
                # Schedule the async handler in the main event loop
                asyncio.run_coroutine_threadsafe(
                    _process_issue_event(event_type, row_data), loop
                )
            else:
                # Generic live-row broadcast for other watched tables
                asyncio.run_coroutine_threadsafe(
                    ws_manager.broadcast(
                        "live_row",
                        {
                            "table": table,
                            "event": event_type,
                            "row": _serialise_row(row_data),
                            "ts": datetime.utcnow().isoformat(),
                        },
                    ),
                    loop,
                )

    stream.close()
    logger.info("CDC listener stopped.")


async def start_cdc_listener() -> None:
    """
    Entry point called from FastAPI lifespan.
    Runs the blocking BinLogStreamReader in a thread pool executor so the
    asyncio event loop stays free.
    """
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _run_stream_sync, loop)
