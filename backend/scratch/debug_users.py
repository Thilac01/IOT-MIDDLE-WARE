import asyncio
from database import SecuritySession
from sqlalchemy import text
from models import User

async def check():
    async with SecuritySession() as session:
        try:
            result = await session.execute(text("SELECT id, username, role, first_name, last_name, email FROM users"))
            users = result.fetchall()
            print(f"Found {len(users)} users:")
            for u in users:
                print(u)
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(check())
