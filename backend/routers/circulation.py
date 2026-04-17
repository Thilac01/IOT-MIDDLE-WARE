"""
routers/circulation.py — Specialized endpoints for library circulation activity.
Joins Koha issues/old_issues with items, biblio, and borrowers to show names and titles.
"""
from typing import Any
from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_replica_session

router = APIRouter(prefix="/circulation", tags=["Circulation"])


@router.get("/active")
async def get_active_loans(
    session: AsyncSession = Depends(get_replica_session)
) -> list[dict[str, Any]]:
    """
    Fetch the most recent active loans with book titles and borrower names.
    Sorted by issuedate DESC (2026/latest first).
    """
    query = text("""
        SELECT 
            i.issue_id, 
            i.issuedate, 
            i.date_due, 
            i.branchcode,
            it.barcode,
            b.title, 
            p.firstname, 
            p.surname
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


@router.get("/recent_returns")
async def get_recent_returns(
    session: AsyncSession = Depends(get_replica_session)
) -> list[dict[str, Any]]:
    """
    Fetch the most recent returns with book titles and borrower names.
    Sorted by returndate DESC.
    """
    query = text("""
        SELECT 
            i.issue_id, 
            i.issuedate, 
            i.returndate, 
            i.branchcode,
            it.barcode,
            b.title, 
            p.firstname, 
            p.surname
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
