"""
routers/devices.py — IoT Raspberry Pi Fleet Management
"""
from datetime import datetime, timedelta
from typing import Optional
import subprocess
import re
import asyncio
import socket

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_security_session
from models import RaspberryDevice, BookWhitelist, User
from websocket_manager import ws_manager
from routers.auth import get_current_user, log_audit

router = APIRouter(prefix="/devices", tags=["IoT Devices"])

class DeviceCreate(BaseModel):
    device_id: str
    name: str = "Unknown Gate"
    floor_name: str = "Ground Floor"
    ip_address: Optional[str] = None
    x_pos: float = 50.0
    y_pos: float = 50.0

class DeviceOut(BaseModel):
    id: int
    device_id: str
    name: str
    ip_address: Optional[str]
    floor_name: str
    x_pos: float
    y_pos: float
    last_heartbeat: Optional[datetime]
    status: str
    cpu_usage: float
    ram_usage: float
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

@router.get("/", response_model=list[DeviceOut])
async def list_devices(current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_security_session)):
    """List all IoT devices and mark them offline if heartbeat > 60s."""
    result = await session.execute(select(RaspberryDevice))
    devices = result.scalars().all()
    
    # Auto-update status based on heartbeat
    now = datetime.utcnow()
    changed = False
    for d in devices:
        if d.last_heartbeat and (now - d.last_heartbeat) > timedelta(seconds=60):
            if d.status == "ONLINE":
                d.status = "OFFLINE"
                changed = True
    
    if changed:
        await session.commit()
        
    return devices

@router.post("/", response_model=DeviceOut)
async def register_device(body: DeviceCreate, current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_security_session)):
    """Register or update coordinates of an IoT Raspberry Pi."""
    result = await session.execute(select(RaspberryDevice).where(RaspberryDevice.device_id == body.device_id))
    device = result.scalar_one_or_none()
    
    if device:
        device.name = body.name
        device.floor_name = body.floor_name
        device.ip_address = body.ip_address
        device.x_pos = body.x_pos
        device.y_pos = body.y_pos
        is_new = False
    else:
        device = RaspberryDevice(**body.model_dump())
        session.add(device)
        is_new = True
        
    await session.commit()
    await session.refresh(device)
    await log_audit(session, current_user.username, "DEVICE_REGISTER", f"{'Added' if is_new else 'Updated'} device {body.name} ({body.device_id})")
    await ws_manager.broadcast("device_update", {"action": "register", "device_id": device.device_id})
    return device

class HeartbeatPayload(BaseModel):
    cpu_usage: float = 0.0
    ram_usage: float = 0.0

@router.post("/{device_id}/heartbeat")
async def device_heartbeat(device_id: str, body: Optional[HeartbeatPayload] = None, session: AsyncSession = Depends(get_security_session)):
    """IoT device calls this every 15s to stay ONLINE and report telemetry."""
    result = await session.execute(select(RaspberryDevice).where(RaspberryDevice.device_id == device_id))
    device = result.scalar_one_or_none()
    
    if not device:
        raise HTTPException(status_code=404, detail="Device not registered yet.")
        
    device.status = "ONLINE"
    device.last_heartbeat = datetime.utcnow()
    
    if body:
        device.cpu_usage = body.cpu_usage
        device.ram_usage = body.ram_usage
        
    await session.commit()
    await ws_manager.broadcast("device_update", {"action": "heartbeat", "device_id": device_id})
    return {"status": "ok"}

@router.delete("/{device_id}")
async def delete_device(device_id: str, current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_security_session)):
    """Delete a registered Rasberry Pi."""
    result = await session.execute(select(RaspberryDevice).where(RaspberryDevice.device_id == device_id))
    device = result.scalar_one_or_none()
    if not device:
        raise HTTPException(status_code=404, detail="Device not found.")
    
    await session.delete(device)
    await log_audit(session, current_user.username, "DEVICE_DELETE", f"Deleted device {device.name} ({device.device_id})")
    await session.commit()
    await ws_manager.broadcast("device_update", {"action": "delete", "device_id": device_id})
    return {"status": "ok"}

@router.get("/config/whitelist")
async def get_device_whitelist(session: AsyncSession = Depends(get_security_session)):
    """IoT devices call this to get the array of allowed barcodes."""
    result = await session.execute(select(BookWhitelist.barcode).where(BookWhitelist.is_active == 1))
    return {"whitelisted_barcodes": [row[0] for row in result.fetchall()]}

@router.get("/scan")
async def scan_network(current_user: User = Depends(get_current_user)):
    """Scans local network ARP cache to automatically find Raspberry Pi MACs asynchronously."""
    try:
        # Pre-populate ARP cache by forcing a quick subnet connection spray (takes ~0.5s total)
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            local_ip = s.getsockname()[0]
            subnet = ".".join(local_ip.split('.')[:-1])
            
            async def try_connect(ip):
                try:
                    # Trying to connect to any port forces OS to emit ARP request
                    fut = asyncio.open_connection(ip, 22)
                    await asyncio.wait_for(fut, timeout=0.03)
                except Exception:
                    pass
                    
            # Spray subnet
            tasks = [try_connect(f"{subnet}.{i}") for i in range(1, 255)]
            await asyncio.gather(*tasks)
        except Exception:
            pass
        finally:
            s.close()

        # Now read the fully populated ARP cache
        proc = await asyncio.create_subprocess_shell(
            "arp -a",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        
        # Add a 6-second timeout so it never hangs indefinitely
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=6.0)
        
        if proc.returncode != 0:
            return {"error": "ARP scan failed", "scanned_devices": []}
            
        output = stdout.decode(errors='ignore')
        
        devices = []
        mac_regex = re.compile(r"([0-9a-f]{2}[:-]){5}([0-9a-f]{2})", re.IGNORECASE)
        ip_regex = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
        
        # Deduplicate MACs in case of multiple interfaces logging the same device
        seen_macs = set()
        
        for line in output.splitlines():
            ip_match = ip_regex.search(line)
            mac_match = mac_regex.search(line)
            if ip_match and mac_match:
                mac = mac_match.group(0).replace('-', ':').lower()
                ip = ip_match.group(0)
                
                # Exclude broadcast/multicast
                if mac == "ff:ff:ff:ff:ff:ff" or mac.startswith("01:00:5e") or ip.endswith(".255"):
                    continue
                    
                if mac not in seen_macs:
                    seen_macs.add(mac)
                    is_pi = mac.startswith("b8:27:eb") or mac.startswith("dc:a6:32") or mac.startswith("e4:5f:01") or mac.startswith("d8:3a:dd")
                    devices.append({
                        "ip": ip,
                        "mac": mac,
                        "is_pi": is_pi
                    })
                    
        # Sort so Raspberry Pis appear at the top
        devices.sort(key=lambda d: not d['is_pi'])
        
        return {"scanned_devices": devices}
        
    except asyncio.TimeoutError:
        return {"error": "ARP scan timed out after 6 seconds.", "scanned_devices": []}
    except Exception as e:
        return {"error": str(e), "scanned_devices": []}

