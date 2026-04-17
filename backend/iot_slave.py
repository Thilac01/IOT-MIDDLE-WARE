import paho.mqtt.client as mqtt
import subprocess
import json
import time
import uuid
import socket
import argparse
import threading
import psutil

# Configuration
BROKER_ADDRESS = "192.168.1.100" # Change to the central server IP
BROKER_PORT = 1883
TOPIC_BASE = "jpl/iot/devices"

def get_mac():
    mac_num = hex(uuid.getnode()).replace('0x', '').upper()
    mac = ':'.join(mac_num[i: i + 2] for i in range(0, 11, 2))
    return mac

DEVICE_ID = get_mac()

def run_command(cmd):
    try:
        # Use subprocess to run the shell command
        process = subprocess.Popen(
            cmd, 
            shell=True, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            text=True
        )
        stdout, stderr = process.communicate(timeout=30)
        output = stdout if stdout else stderr
        return output
    except subprocess.TimeoutExpired:
        process.kill()
        return "[Error: Command timed out]"
    except Exception as e:
        return f"[Error: {str(e)}]"

def on_connect(client, userdata, flags, rc):
    print(f"Connected to MQTT Broker with result code: {rc}")
    # Subscribe to the command topic for this specific device
    topic = f"{TOPIC_BASE}/{DEVICE_ID}/cmd"
    client.subscribe(topic)
    print(f"Subscribed to {topic}")

def on_message(client, userdata, msg):
    payload = msg.payload.decode()
    print(f"Received command: {payload} on topic {msg.topic}")
    
    # Execute the command
    result = run_command(payload)
    
    # Publish the result back
    response_topic = f"{TOPIC_BASE}/{DEVICE_ID}/response"
    client.publish(response_topic, result)
    print("Response sent.")

def heartbeat_task(client):
    while True:
        try:
            topic = f"{TOPIC_BASE}/{DEVICE_ID}/heartbeat"
            
            payload = {
                "device_id": DEVICE_ID,
                "ip": socket.gethostbyname(socket.gethostname()),
                "cpu_usage": psutil.cpu_percent(),
                "ram_usage": psutil.virtual_memory().percent,
                "timestamp": time.time()
            }
            client.publish(topic, json.dumps(payload))
            time.sleep(15)
        except Exception as e:
            print(f"Heartbeat error: {e}")
            time.sleep(5)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="IoT Raspberry Pi Slave Agent")
    parser.add_argument('--broker', default='127.0.0.1', help='MQTT Broker IP (Master Node)')
    args = parser.parse_args()
    
    BROKER_ADDRESS = args.broker
    print(f"Starting IoT Slave Agent with ID: {DEVICE_ID}")
    print(f"Connecting to MQTT Broker at {BROKER_ADDRESS}:{BROKER_PORT}...")
    
    client = mqtt.Client(client_id=f"pi_slave_{DEVICE_ID}")
    client.on_connect = on_connect
    client.on_message = on_message
    
    # Try connecting, loop reconnect if fail
    while True:
        try:
            client.connect(BROKER_ADDRESS, BROKER_PORT, 60)
            break
        except Exception as e:
            print(f"Failed connecting to broker: {e}. Retrying in 5s...")
            time.sleep(5)

    # Start heartbeat thread
    hb_thread = threading.Thread(target=heartbeat_task, args=(client,), daemon=True)
    hb_thread.start()

    # Blocking MQTT loop
    client.loop_forever()
