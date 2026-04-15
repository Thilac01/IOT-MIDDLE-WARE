# JPL Library Security Monitor

The **JPL Library Security Monitor** is a real-time, event-driven security dashboard engineered to monitor checkout activity within the Koha Library Management System (LMS). Driven by Change Data Capture (CDC) natively reading MySQL streaming logs, the system intelligently protects library assets by validating checkouts against an active whitelist without modifying the core Koha architecture.

It utilizes an embedded SSH Tunnel system to interact securely with remote replica databases, removing the need for manual port-forwarding scripts.

---

## 🏗️ Architecture & Technology Stack

**Backend (Python):**
- **FastAPI**: Core REST API and WebSocket event broadcasting server.
- **Python-MySQL-Replication**: Change Data Capture (CDC) polling over `binlog` to instantly detect checkouts without slow polling.
- **SQLAlchemy (AsyncIO) & aiomysql**: Asynchronous ORM for logging alerts and maintaining the local metadata database schemas.
- **SSHTunnel / Paramiko**: Native background lifecycle hook automating the SSH connectivity into the parent Server replica.

**Frontend (Vanilla Web):**
- **Vanilla HTML / JS**: No build steps or heavy frameworks. Native WebSocket integration maps events instantly to the DOM.
- **WSO2 Enterprise Theme**: Visually crafted following the WSO2 Carbon/IoT Server Enterprise aesthetic, featuring distinctive flat UI layouts, sharp dark headers, high-contrast readability, and WSO2 Orange (`#f47b20`).

---

## ✨ Features & Functionality

### 1. Change Data Capture (CDC) Engine
Unlike traditional polling methods, the python backend connects to the master database acting as a replication slave (`cdc_listener.py`). It specifically watches exactly when `INSERT` events surface on the `issues` table (a Koha book checkout). Changes are parsed and distributed under a second.

### 2. Live Event Streaming
Any tracked table configuration triggers a `live_row` global broadcast emitted out over the `ws://` WebSocket endpoint. The interactive frontend immediately displays the database shift in the "Live Event Stream" terminal without requiring any page refreshes.

### 3. Automated Security Alerts
When an `INSERT` triggers on the `issues` table, the CDC listener extracts the affected `barcode` and references it against the `jpl_security_monitor.book_whitelist` table. 
- If the barcode is **Active** on the list: The transaction passes securely.
- If the barcode is **Not found**: The system records an unauthorized checkout Alert to the Security Database and immediately flashes an angry Red Alert toast to all connected administration clients.

### 4. Whitelist Configuration
Built-in CRUD (Create, Read, Update, Delete) allows administrators to approve books (by passing in `Barcode`, `Title`, `Author`) into circulation. Features soft-delete and direct active toggling.

### 5. Live Table Viewer
Exposes an interactive, paginated lookup dashboard allowing administrators to browse directly through the root `koha_library` replica database to review metadata securely. 

### 6. Seamless SSH Automated Brokering
You no longer have to manually set up Windows PuTTy or PowerShell sockets to securely tunnel into `137.184.15.52`. The API utilizes a persistent lifecycle engine: upon boot, the server opens the SSH port magically on `127.0.0.1:3307` and hooks `SQLAlchemy` queries seamlessly through the connection.

---

## 🚀 How to Run

1. Open a terminal in the `backend/` directory.
2. Setup the python virtual environment (if not active):
   ```bash
   python -m venv venv
   source venv/Scripts/activate # (Or equivalent on Windows)
   pip install -r requirements.txt
   ```
3. Start the Application Server:
   ```bash
   python main.py
   ```
4. The system will automatically spin up the SSH connection, connect to MySQL, verify the CDC Listener stream, and open the REST endpoints on `0.0.0.0:8000`.
5. Head to [http://127.0.0.1:8000/](http://127.0.0.1:8000/) to access the Security Dashboard.
