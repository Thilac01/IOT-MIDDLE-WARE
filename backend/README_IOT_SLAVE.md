# IoT Slave Setup for Raspberry Pi

This directory contains the `iot_slave.py` script which is designed to run on the slave devices (the Gate Monitors / Raspberry Pi nodes) to enable remote terminal execution and telemetry reporting using MQTT.

## Requirements

The script uses standard Python 3. It depends on `paho-mqtt` for communicating with the Master Node and `psutil` for collecting CPU & RAM usage.

### Installation

1. Make sure Python 3 and pip are installed.
2. Install the required packages:
   ```bash
   pip install paho-mqtt psutil
   ```
3. (Optional but recommended) Install `mosquitto` broker on the central server/backend host if you haven't already:
   ```bash
   sudo apt install mosquitto mosquitto-clients
   sudo systemctl enable mosquitto
   sudo systemctl start mosquitto
   ```

## Running the Agent

You simply run the `iot_slave.py` and provide the IP address of the Master Node (Broker):

```bash
python3 iot_slave.py --broker 192.168.1.100
```
(Replace `192.168.1.100` with the actual IP address of your central server)

## Creating a systemd service (Optional but Recommended)

To ensure the script starts on boot and restarts if it crashes, create a systemd service:

1. Create a service file:
   ```bash
   sudo nano /etc/systemd/system/iot-slave.service
   ```
2. Paste the following:
   ```ini
   [Unit]
   Description=IoT Slave Agent (MQTT Terminal)
   After=network.target

   [Service]
   Type=simple
   User=pi
   ExecStart=/usr/bin/python3 /home/pi/iot_slave.py --broker <YOUR_BROKER_IP>
   Restart=always
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```
3. Enable and start:
   ```bash
   sudo systemctl enable iot-slave.service
   sudo systemctl start iot-slave.service
   ```

Now the Pi node will appear in your centralized IoT Dashboard, show its real heartbeat (CPU/RAM), and you can use the interactive shell from the web dashboard.
