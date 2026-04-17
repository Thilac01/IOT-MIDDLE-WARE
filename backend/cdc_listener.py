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
import time
from datetime import datetime

from pymysqlreplication import BinLogStreamReader
from pymysqlreplication.row_event import WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent
from sqlalchemy import select, text

from config import settings
from database import SecuritySession, ReplicaSession
from models import BookWhitelist, SecurityAlert
from websocket_manager import ws_manager

logger = logging.getLogger(__name__)

# Tables to monitor from the Koha schema
WATCHED_TABLES = {
    settings.replica_db: ["issues", "old_issues", "items", "borrowers"],
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
    borrower_name: str | None,
    branch_code: str | None,
    raw_event: dict,
) -> SecurityAlert:
    """Persists an alert to the DB and returns the new record."""
    alert = SecurityAlert(
        alert_type=alert_type,
        barcode=barcode,
        issue_id=issue_id,
        borrower_number=borrower_number,
        borrower_name=borrower_name,
        branch_code=branch_code,
        raw_event=raw_event,
        detected_at=datetime.utcnow(),
    )
    async with SecuritySession() as session:
        session.add(alert)
        await session.commit()
        await session.refresh(alert)
    return alert


async def _fetch_metadata(itemnumber: int | None, borrowernumber: int | None) -> dict:
    """Fetch book title, barcode, and borrower names for a transaction from Koha DB."""
    metadata = {
        "title": "Unknown Book",
        "borrower_name": "Unknown User",
        "barcode": None
    }
    try:
        async with ReplicaSession() as session:
            if itemnumber:
                # Get barcode and title from items -> biblio
                item_q = text("""
                    SELECT i.barcode, b.title 
                    FROM items i 
                    JOIN biblio b ON i.biblionumber = b.biblionumber 
                    WHERE i.itemnumber = :inum
                """)
                it_res = await session.execute(item_q, {"inum": itemnumber})
                row = it_res.fetchone()
                if row:
                    metadata["barcode"] = row[0]
                    metadata["title"]   = row[1]
            
            if borrowernumber:
                bor_q = text("SELECT firstname, surname FROM borrowers WHERE borrowernumber = :bnum")
                bor_res = await session.execute(bor_q, {"bnum": borrowernumber})
                row = bor_res.fetchone()
                if row:
                    metadata["borrower_name"] = f"{row[0]} {row[1]}".strip()
    except Exception as e:
        logger.error("Error fetching metadata for item %s, borrower %s: %s", itemnumber, borrowernumber, e)
    return metadata


async def _process_issue_event(event_type: str, row: dict) -> None:
    """
    Core security logic for a single issues-table row event.
    """
    try:
        borrower_number = row.get("borrowernumber")
        item_number = row.get("itemnumber")
        branch_code = row.get("branchcode") or row.get("issuingbranch")

        # Enrich with metadata (crucially gets the barcode if it's missing in the row)
        meta = await _fetch_metadata(item_number, borrower_number)
        
        # Use barcode from row if present, otherwise from metadata
        barcode = row.get("barcode") or meta.get("barcode") or ""
        
        serialised = _serialise_row(row)
        serialised["barcode"] = barcode
        serialised["title"] = meta["title"]
        serialised["borrower"] = meta["borrower_name"]

        # Broadcast live row update to dashboard
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
            return

        whitelisted = await _is_whitelisted(barcode) if barcode else False

        # Broadcast "Book Checkout" event for the UI popup
        await ws_manager.broadcast(
            "book_event",
            {
                "action": "CHECKOUT",
                "barcode": barcode,
                "borrower": meta["borrower_name"],
                "title": meta["title"],
                "branch": branch_code,
                "whitelisted": whitelisted,
                "ts": datetime.utcnow().isoformat(),
            },
        )

        if not whitelisted:
            logger.warning("🚨 SECURITY ALERT: Unauthorized checkout — barcode=%s", barcode)
            alert = await _record_alert(
                alert_type="UNAUTHORIZED_ISSUE",
                barcode=barcode,
                issue_id=row.get("issue_id"),
                borrower_number=borrower_number,
                borrower_name=meta["borrower_name"],
                branch_code=branch_code,
                raw_event=serialised,
            )
            # Push real-time alert
            await ws_manager.broadcast(
                "security_alert",
                {
                    "id": alert.id,
                    "alert_type": alert.alert_type,
                    "barcode": barcode,
                    "issue_id": row.get("issue_id"),
                    "borrower_number": borrower_number,
                    "branch_code": branch_code,
                    "detected_at": alert.detected_at.isoformat(),
                    "message": f"⚠️ Non-whitelisted book checked out! Barcode: {barcode}",
                },
            )
        else:
            logger.info("CDC: Whitelisted checkout — barcode=%s ✓", barcode)
    except Exception as e:
        logger.exception("Error in _process_issue_event: %s", e)


async def _process_return_event(event_type: str, row: dict) -> None:
    """
    Handles check-in events (inserts into old_issues).
    """
    try:
        borrower_number = row.get("borrowernumber")
        item_number = row.get("itemnumber")
        branch_code = row.get("branchcode") or row.get("issuingbranch")

        # Enrich with metadata
        meta = await _fetch_metadata(item_number, borrower_number)
        
        # Use barcode from row if present, otherwise from metadata
        barcode = row.get("barcode") or meta.get("barcode") or ""

        serialised = _serialise_row(row)
        serialised["barcode"] = barcode
        serialised["title"] = meta["title"]
        serialised["borrower"] = meta["borrower_name"]

        # Broadcast live row update
        await ws_manager.broadcast(
            "live_row",
            {
                "table": "old_issues",
                "event": event_type,
                "row": serialised,
                "ts": datetime.utcnow().isoformat(),
            },
        )

        if event_type != "INSERT":
            return

        # Broadcast a "Book Check-in" event for the UI popup
        await ws_manager.broadcast(
            "book_event",
            {
                "action": "CHECKIN",
                "barcode": barcode,
                "borrower": meta["borrower_name"],
                "title": meta["title"],
                "branch": branch_code,
                "ts": datetime.utcnow().isoformat(),
            },
        )

        logger.info("CDC: Book Check-in detected — barcode=%s", barcode)
    except Exception as e:
        logger.exception("Error in _process_return_event: %s", e)


def _run_stream_sync(loop: asyncio.AbstractEventLoop) -> None:
    """
    Synchronous function that reads from the binlog.
    Runs in a separate thread so it doesn't block the asyncio event loop.
    Includes retry logic for connection stability.
    """
    retry_delay = 5
    
    while True:
        logger.info("CDC listener starting…")
        try:
            stream = BinLogStreamReader(
                connection_settings=MYSQL_SETTINGS,
                server_id=settings.cdc_server_id,
                only_events=[WriteRowsEvent, UpdateRowsEvent, DeleteRowsEvent],
                only_tables=["issues", "old_issues", "items", "borrowers"],
                only_schemas=[settings.replica_db],
                resume_stream=True,
                blocking=True
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
                    elif table == "old_issues":
                        # Returns go into old_issues
                        asyncio.run_coroutine_threadsafe(
                            _process_return_event(event_type, row_data), loop
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
            logger.warning("CDC stream loop ended unexpectedly.")
        
        except Exception as exc:
            logger.error("CDC reader encountered an error: %s. Retrying in %ds...", exc, retry_delay)
            time.sleep(retry_delay)
            # Exponential backoff up to 60s
            retry_delay = min(retry_delay * 2, 60)
            continue
        
        # If loop ended without error, maybe just wait a bit before restart
        time.sleep(1)


async def start_cdc_listener() -> None:
    """
    Entry point called from FastAPI lifespan.
    Runs the blocking BinLogStreamReader in a thread pool executor.
    """
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _run_stream_sync, loop)

