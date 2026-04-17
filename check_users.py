import asyncio
import os
import sys

# Add backend to path
sys.path.append(os.path.join(os.getcwd(), 'backend'))

from database import SecuritySession
from sqlalchemy import text

async def check():
    async with SecuritySession() as session:
        try:
            result = await session.execute(text("SELECT username FROM users"))
            users = result.fetchall()
            print(f"Users in DB: {users}")
        except Exception as e:
            print(f"Error checking users: {e}")

if __name__ == "__main__":
    asyncio.run(check())
