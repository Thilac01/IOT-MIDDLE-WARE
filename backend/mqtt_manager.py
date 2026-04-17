import json
import logging
import threading
import asyncio
from typing import Optional
from websocket_manager import ws_manager

logger = logging.getLogger(__name__)

class MQTTManager:
    def __init__(self):
        self.client = None
        self.loop = None  # the main event loop
        
    def start(self, loop: asyncio.AbstractEventLoop, broker_ip="127.0.0.1", broker_port=1883):
        self.loop = loop
        try:
            import paho.mqtt.client as mqtt
            try:
                # paho-mqtt >= 2.0 requires callback_api_version
                self.client = mqtt.Client(
                    mqtt.CallbackAPIVersion.VERSION1,
                    client_id="fastapi_backend"
                )
            except AttributeError:
                # paho-mqtt < 2.0 fallback
                self.client = mqtt.Client(client_id="fastapi_backend")
            self.client.on_connect = self.on_connect
            self.client.on_message = self.on_message
            self.client.connect(broker_ip, broker_port, 60)
            
            # Start MQTT loop in a background thread to not block asyncio
            thread = threading.Thread(target=self.client.loop_forever, daemon=True)
            thread.start()
            logger.info(f"MQTT Manager connected to broker {broker_ip}:{broker_port}")
        except Exception as e:
            logger.error(f"MQTT Broker connection failed: {e}. Commands will not operate.")

    def on_connect(self, client, userdata, flags, rc):
        logger.info(f"Connected to MQTT broker with result code: {rc}")
        # Subscribing to all device responses and heartbeats
        client.subscribe("jpl/iot/devices/+/response")
        client.subscribe("jpl/iot/devices/+/heartbeat")

    def on_message(self, client, userdata, msg):
        topic = msg.topic
        payload_str = msg.payload.decode(errors="ignore")
        
        parts = topic.split("/")
        if len(parts) >= 4:
            device_id = parts[3]
            msg_type = parts[4]
            
            if msg_type == "response":
                # Forward remote terminal output to WebSocket
                asyncio.run_coroutine_threadsafe(
                    ws_manager.broadcast("terminal_output", {
                        "device_id": device_id,
                        "output": payload_str
                    }),
                    self.loop
                )
            elif msg_type == "heartbeat":
                # Example: parse JSON heartbeat and update WS clients
                try:
                    data = json.loads(payload_str)
                    asyncio.run_coroutine_threadsafe(
                        ws_manager.broadcast("device_heartbeat", data),
                        self.loop
                    )
                except Exception:
                    pass

    def send_command(self, device_id: str, command: str):
        if self.client:
            topic = f"jpl/iot/devices/{device_id}/cmd"
            self.client.publish(topic, command)
            logger.info(f"Sent MQTT command to {device_id}: {command}")
            # Echo command on WS
            asyncio.run_coroutine_threadsafe(
                ws_manager.broadcast("terminal_output", {
                    "device_id": device_id,
                    "output": f"\n$ {command}\n"
                }),
                self.loop
            )

mqtt_manager = MQTTManager()
