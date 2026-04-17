import asyncio
from sqlalchemy import select
from database import SecuritySession
from models import User

async def check():
    async with SecuritySession() as session:
        result = await session.execute(select(User))
        users = result.scalars().all()
        print(f"Current users: {[u.username for u in users]}")

if __name__ == "__main__":
    asyncio.run(check())
