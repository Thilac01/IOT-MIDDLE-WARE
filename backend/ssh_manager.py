import asyncio
import paramiko
import logging
import threading
from typing import Dict
from websocket_manager import ws_manager

logger = logging.getLogger(__name__)

class SSHManager:
    def __init__(self):
        # device_id -> { "client": paramiko.SSHClient, "channel": shell_channel, "task": asyncio.Task }
        self.sessions: Dict[str, dict] = {}

    async def connect(self, device_id: str, ip: str, username: str, password: str, loop: asyncio.AbstractEventLoop):
        # Clean up any existing session
        await self.disconnect(device_id)

        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        
        try:
            # Connect in a separate thread so it doesn't block FastAPI
            await loop.run_in_executor(None, lambda: client.connect(
                hostname=ip, 
                port=22, 
                username=username, 
                password=password, 
                timeout=5,
                auth_timeout=5,
                look_for_keys=False,
                allow_agent=False
            ))
            
            # Start an interactive shell
            shell = client.invoke_shell()
            shell.setblocking(False)
            
            self.sessions[device_id] = {
                "client": client,
                "channel": shell,
                "loop": loop
            }
            
            # Start background reader task
            task = loop.create_task(self._read_loop(device_id, shell))
            self.sessions[device_id]["task"] = task
            
            # Notify frontend of success
            await ws_manager.broadcast("terminal_output", {
                "device_id": device_id,
                "output": f"\r\n--- Successfully connected to {username}@{ip} via SSH ---\r\n\r\n"
            })
            return True

        except Exception as e:
            logger.error(f"SSH connection failed for {ip}: {e}")
            await ws_manager.broadcast("terminal_output", {
                "device_id": device_id,
                "output": f"\r\n--- SSH Connection Failed: {str(e)} ---\r\n"
            })
            return False

    async def _read_loop(self, device_id: str, channel):
        """Continuously reads from the paramiko channel and broadcasts via WebSockets"""
        while True:
            if not channel.recv_ready():
                await asyncio.sleep(0.05)
                # Check if channel is closed
                if channel.exit_status_ready() or channel.closed:
                    break
                continue
            
            try:
                data = channel.recv(4096)
                if data:
                    text = data.decode(errors="replace")
                    await ws_manager.broadcast("terminal_output", {
                        "device_id": device_id,
                        "output": text
                    })
                else:
                    break
            except Exception as e:
                logger.error(f"SSH Read loop error: {e}")
                break

        await ws_manager.broadcast("terminal_output", {
            "device_id": device_id,
            "output": "\r\n--- SSH Session Closed ---\r\n"
        })
        await self.disconnect(device_id)

    def send_input(self, device_id: str, data_input: str):
        if device_id in self.sessions:
            channel = self.sessions[device_id]["channel"]
            if channel and not channel.closed:
                try:
                    # Append carriage return / newline if sending a full command
                    if not data_input.endswith("\n") and not data_input.endswith("\r"):
                        data_input += "\r"
                    channel.send(data_input)
                except Exception as e:
                    logger.error(f"Failed to send input: {e}")

    async def disconnect(self, device_id: str):
        if device_id in self.sessions:
            session = self.sessions.pop(device_id)
            if session.get("channel"):
                session["channel"].close()
            if session.get("client"):
                session["client"].close()
            if session.get("task"):
                session["task"].cancel()

ssh_manager = SSHManager()
