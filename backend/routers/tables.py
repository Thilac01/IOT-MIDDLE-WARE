"""
routers/tables.py — Dynamic Live Table Viewer API.

Exposes endpoints to:
  1. List all tables in the Koha read replica.
  2. Fetch paginated rows from any table.
  3. Search any table.
"""
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text, inspect
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_replica_session

router = APIRouter(prefix="/tables", tags=["Live Tables"])


@router.get("/")
async def list_tables(session: AsyncSession = Depends(get_replica_session)) -> list[str]:
    """Return all table names in the Koha read replica database."""
    result = await session.execute(text("SHOW TABLES"))
    return [row[0] for row in result.fetchall()]


@router.get("/{table_name}")
async def get_table_rows(
    table_name: str,
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    search: str | None = Query(None),
    session: AsyncSession = Depends(get_replica_session),
) -> dict[str, Any]:
    """
    Fetch paginated rows from a Koha table.
    Validates the table name against SHOW TABLES to prevent SQL injection.
    """
    # Whitelist the table name against actual DB tables
    if table_name == "circulation_active":
        return {"table": "circulation_active", "rows": await _get_active_loans_internal(session)}
    if table_name == "circulation_returns":
        return {"table": "circulation_returns", "rows": await _get_recent_returns_internal(session)}

    tables_result = await session.execute(text("SHOW TABLES"))
    valid_tables = {row[0] for row in tables_result.fetchall()}
    if table_name not in valid_tables:
        raise HTTPException(status_code=404, detail=f"Table '{table_name}' not found.")

    offset = (page - 1) * page_size

    # Get column info
    col_result = await session.execute(text(f"SHOW COLUMNS FROM `{table_name}`"))
    columns = [row[0] for row in col_result.fetchall()]

    # Count
    count_result = await session.execute(text(f"SELECT COUNT(*) FROM `{table_name}`"))
    total = count_result.scalar()

    # Fetch rows
    if search and columns:
        like_clauses = " OR ".join(
            [f"CAST(`{col}` AS CHAR) LIKE :search" for col in columns[:5]]
        )
        rows_result = await session.execute(
            text(f"SELECT * FROM `{table_name}` WHERE {like_clauses} LIMIT :limit OFFSET :offset"),
            {"search": f"%{search}%", "limit": page_size, "offset": offset},
        )
    else:
        rows_result = await session.execute(
            text(f"SELECT * FROM `{table_name}` LIMIT :limit OFFSET :offset"),
            {"limit": page_size, "offset": offset},
        )

    raw_rows = rows_result.fetchall()
    rows = [dict(zip(columns, row)) for row in raw_rows]

    return {
        "table": table_name,
        "columns": columns,
        "total": total,
        "page": page,
        "page_size": page_size,
        "rows": rows,
    }


async def _get_active_loans_internal(session: AsyncSession) -> list[dict[str, Any]]:
    """Internal helper to fetch recent active loans with joins."""
    query = text("""
        SELECT 
            i.issue_id, i.issuedate, i.date_due, i.branchcode,
            it.barcode, b.title, p.firstname, p.surname
        FROM issues i
        LEFT JOIN items it ON i.itemnumber = it.itemnumber
        LEFT JOIN biblio b ON it.biblionumber = b.biblionumber
        LEFT JOIN borrowers p ON i.borrowernumber = p.borrowernumber
        ORDER BY i.issuedate DESC
        LIMIT 10
    """)
    result = await session.execute(query)
    rows = result.mappings().all()
    return [
        {
            "issue_id": r["issue_id"],
            "issuedate": r["issuedate"],
            "date_due": r["date_due"],
            "branch": r["branchcode"],
            "barcode": r["barcode"],
            "title": r["title"],
            "borrower": f"{r['firstname']} {r['surname']}".strip() if r['firstname'] or r['surname'] else "Unknown"
        }
        for r in rows
    ]


async def _get_recent_returns_internal(session: AsyncSession) -> list[dict[str, Any]]:
    """Internal helper to fetch recent returns with joins."""
    query = text("""
        SELECT 
            i.issue_id, i.issuedate, i.returndate, i.branchcode,
            it.barcode, b.title, p.firstname, p.surname
        FROM old_issues i
        LEFT JOIN items it ON i.itemnumber = it.itemnumber
        LEFT JOIN biblio b ON it.biblionumber = b.biblionumber
        LEFT JOIN borrowers p ON i.borrowernumber = p.borrowernumber
        ORDER BY i.returndate DESC
        LIMIT 10
    """)
    result = await session.execute(query)
    rows = result.mappings().all()
    return [
        {
            "issue_id": r["issue_id"],
            "issuedate": r["issuedate"],
            "returndate": r["returndate"],
            "branch": r["branchcode"],
            "barcode": r["barcode"],
            "title": r["title"],
            "borrower": f"{r['firstname']} {r['surname']}".strip() if r['firstname'] or r['surname'] else "Unknown"
        }
        for r in rows
    ]
