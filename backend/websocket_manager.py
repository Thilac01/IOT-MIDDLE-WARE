"""
websocket_manager.py — Manages all active WebSocket connections and broadcasts.
"""
import asyncio
import json
import logging
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    """
    Tracks all live WebSocket clients and provides broadcast helpers.
    Thread-safe via asyncio lock.
    """

    def __init__(self):
        self._connections: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.append(websocket)
        logger.info("WS client connected. Total=%d", len(self._connections))

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections = [c for c in self._connections if c is not websocket]
        logger.info("WS client disconnected. Total=%d", len(self._connections))

    async def broadcast(self, event_type: str, data: Any) -> None:
        """Send a JSON message to ALL connected clients."""
        payload = json.dumps({"type": event_type, "data": data}, default=str)
        dead: list[WebSocket] = []
        async with self._lock:
            clients = list(self._connections)
        for ws in clients:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        # Clean up dead connections
        if dead:
            async with self._lock:
                for d in dead:
                    self._connections = [c for c in self._connections if c is not d]

    async def send_to(self, websocket: WebSocket, event_type: str, data: Any) -> None:
        """Send a JSON message to a single client."""
        payload = json.dumps({"type": event_type, "data": data}, default=str)
        await websocket.send_text(payload)


# Global singleton used across the application
ws_manager = ConnectionManager()
