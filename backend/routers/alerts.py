"""
routers/alerts.py — Security alert management endpoints.
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_security_session
from models import SecurityAlert

router = APIRouter(prefix="/alerts", tags=["Security Alerts"])


class AlertOut(BaseModel):
    id: int
    alert_type: str
    issue_id: Optional[int]
    barcode: str
    borrower_number: Optional[int]
    borrower_name: Optional[str]
    branch_code: Optional[str]
    detected_at: datetime
    acknowledged: int
    acknowledged_by: Optional[str]
    acknowledged_at: Optional[datetime]

    model_config = {"from_attributes": True}


class AcknowledgeBody(BaseModel):
    acknowledged_by: str = "admin"


@router.get("/", response_model=list[AlertOut])
async def list_alerts(
    unacknowledged_only: bool = False,
    limit: int = Query(100, le=500),
    session: AsyncSession = Depends(get_security_session),
):
    """Fetch recent security alerts, newest first."""
    q = select(SecurityAlert).order_by(desc(SecurityAlert.detected_at)).limit(limit)
    if unacknowledged_only:
        q = q.where(SecurityAlert.acknowledged == 0)
    result = await session.execute(q)
    return result.scalars().all()


@router.post("/{alert_id}/acknowledge", response_model=AlertOut)
async def acknowledge_alert(
    alert_id: int,
    body: AcknowledgeBody,
    session: AsyncSession = Depends(get_security_session),
):
    """Mark an alert as acknowledged."""
    result = await session.execute(
        select(SecurityAlert).where(SecurityAlert.id == alert_id)
    )
    alert = result.scalar_one_or_none()
    if not alert:
        raise HTTPException(status_code=404, detail="Alert not found.")
    alert.acknowledged = 1
    alert.acknowledged_by = body.acknowledged_by
    alert.acknowledged_at = datetime.utcnow()
    await session.commit()
    await session.refresh(alert)
    return alert
