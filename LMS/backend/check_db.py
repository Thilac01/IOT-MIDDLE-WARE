"""
Probe the Koha API to get useful info (branches, config)
and check the DB name via the config endpoint.
"""
import httpx
import json

BASE = "http://137.184.15.52:1025/api/v1"
CLIENT_ID = "d49612ef-17a5-462a-9870-222e7e109873"
SECRET    = "a089d59a-0ff3-4612-8ff4-8c43f34e940f"

def get_token():
    r = httpx.post(
        f"http://137.184.15.52:1025/api/v1/oauth/token",
        data={
            "grant_type":    "client_credentials",
            "client_id":     CLIENT_ID,
            "client_secret": SECRET,
        },
        timeout=10,
    )
    print("Token status:", r.status_code)
    if r.status_code == 200:
        return r.json().get("access_token")
    print("Token error:", r.text[:300])
    return None

def probe(token):
    headers = {"Authorization": f"Bearer {token}"}

    # Libraries/branches
    r = httpx.get(f"{BASE}/libraries", headers=headers, timeout=10)
    print("\n--- Libraries ---")
    print(r.status_code, r.text[:500])

    # Config
    r2 = httpx.get(f"{BASE}/config/smtp_server", headers=headers, timeout=10)
    print("\n--- Config smtp ---")
    print(r2.status_code, r2.text[:300])

    # Try to get a patron to confirm access
    r3 = httpx.get(f"{BASE}/patrons?_per_page=1", headers=headers, timeout=10)
    print("\n--- Patrons (1) ---")
    print(r3.status_code, r3.text[:500])

token = get_token()
if token:
    probe(token)
