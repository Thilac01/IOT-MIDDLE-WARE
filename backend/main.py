"""
main.py — FastAPI application entry point.

Startup sequence:
  1. Create security DB tables if missing.
  2. Start CDC listener as a background asyncio task.
  3. Serve REST API + WebSocket endpoint.
"""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from config import settings
from database import security_engine, SecurityBase
from models import BookWhitelist, SecurityAlert          # ensure models are imported
from cdc_listener import start_cdc_listener
from websocket_manager import ws_manager
from sshtunnel import SSHTunnelForwarder
from mqtt_manager import mqtt_manager
from ssh_manager import ssh_manager
import json

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s [%(levelname)s] %(name)s — %(message)s",
)
logger = logging.getLogger(__name__)


# ── Lifespan: startup / shutdown ──────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    tunnel = None
    if settings.use_ssh_tunnel:
        try:
            logger.info("Establishing SSH Tunnel...")
            tunnel = SSHTunnelForwarder(
                (settings.ssh_host, settings.ssh_port),
                ssh_username=settings.ssh_user,
                ssh_password=settings.ssh_password,
                remote_bind_address=('127.0.0.1', 3306),
                local_bind_address=('127.0.0.1', 3307),
                set_keepalive=15.0
            )
            tunnel.start()
            logger.info("SSH Tunnel established successfully on 127.0.0.1:3307")
        except Exception as e:
            logger.error("Failed to establish SSH Tunnel: %s", e)

    # Try to create security DB tables — retry until tunnel/DB is available
    db_ready = False
    from sqlalchemy import text
    for attempt in range(1, 20):
        try:
            async with security_engine.begin() as conn:
                await conn.run_sync(SecurityBase.metadata.create_all)
                # Auto-migrate new columns safely if they don't exist
                try:
                    await conn.execute(text("ALTER TABLE users ADD COLUMN first_name VARCHAR(50);"))
                except Exception:
                    pass
                try:
                    await conn.execute(text("ALTER TABLE users ADD COLUMN last_name VARCHAR(50);"))
                except Exception:
                    pass
                try:
                    await conn.execute(text("ALTER TABLE users ADD COLUMN email VARCHAR(100);"))
                except Exception:
                    pass
                try:
                    await conn.execute(text("ALTER TABLE users ADD UNIQUE (email);"))
                except Exception:
                    pass
            logger.info("Security DB tables ready.")
            db_ready = True
            break
        except Exception as exc:
            logger.warning(
                "DB not reachable (attempt %d/20): %s — is the SSH tunnel open?",
                attempt, exc,
            )
            await asyncio.sleep(3)

    if not db_ready:
        logger.error(
            "Could not connect to DB after 20 attempts. "
            "REST endpoints will fail until the SSH tunnel is open. "
            "Server is starting anyway."
        )

    # Start CDC in background (non-blocking, will retry internally)
    cdc_task = asyncio.create_task(_cdc_wrapper())
    logger.info("CDC listener task scheduled.")

    # Start MQTT loop
    mqtt_manager.start(asyncio.get_running_loop())

    yield  # ← application runs

    cdc_task.cancel()
    if tunnel:
        logger.info("Closing SSH Tunnel...")
        tunnel.close()
    logger.info("Shutdown complete.")


async def _cdc_wrapper():
    try:
        await start_cdc_listener()
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        logger.exception("CDC listener crashed: %s", exc)


# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(
    title="JPL Library Security Monitor",
    description="Real-time security monitoring dashboard for Koha LMS",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # Tighten in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# REST routers
from routers.auth import router as auth_router
from routers.whitelist import router as whitelist_router
from routers.tables import router as tables_router
from routers.alerts import router as alerts_router
from routers.devices import router as devices_router

app.include_router(auth_router, prefix="/api/v1")
app.include_router(whitelist_router, prefix="/api/v1")
app.include_router(tables_router, prefix="/api/v1")
app.include_router(alerts_router, prefix="/api/v1")
app.include_router(devices_router, prefix="/api/v1")

# Serve frontend SPA
app.mount("/static", StaticFiles(directory="../frontend"), name="static")


@app.get("/", include_in_schema=False)
async def serve_spa():
    return FileResponse("../frontend/index.html")


# ── WebSocket endpoint ─────────────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Clients connect here to receive real-time events:
      - live_row        : a new/updated row in Koha tables
      - security_alert  : a non-whitelisted book was checked out
      - whitelist_update: whitelist was modified via REST API
    """
    await ws_manager.connect(websocket)
    try:
        while True:
            # Keep-alive: just read (clients can send pings)
            data_raw = await websocket.receive_text()
            if data_raw == "ping":
                await ws_manager.send_to(websocket, "pong", {})
            else:
                try:
                    payload = json.loads(data_raw)
                    action = payload.get("action")
                    if action == "terminal_command":
                        cmd = payload.get("command")
                        dev_id = payload.get("device_id")
                        if cmd and dev_id:
                            mqtt_manager.send_command(dev_id, cmd)
                    elif action == "ssh_connect":
                        asyncio.create_task(ssh_manager.connect(
                            payload.get("device_id"),
                            payload.get("ip"),
                            payload.get("username"),
                            payload.get("password"),
                            asyncio.get_running_loop()
                        ))
                    elif action == "ssh_input":
                        ssh_manager.send_input(payload.get("device_id"), payload.get("command"))
                    elif action == "ssh_disconnect":
                        asyncio.create_task(ssh_manager.disconnect(payload.get("device_id")))
                except Exception:
                    logger.exception("WS payload error")
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)


# ── Health check ──────────────────────────────────────────────────────────────
@app.get("/health", tags=["System"])
async def health():
    return {"status": "ok", "service": "JPL Security Monitor"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "main:app",
        host=settings.app_host,
        port=settings.app_port,
        reload=True,
        log_level=settings.log_level.lower(),
    )
