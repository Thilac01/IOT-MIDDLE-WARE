import asyncio
from database import ReplicaSession
from sqlalchemy import text

async def check():
    async with ReplicaSession() as session:
        try:
            result = await session.execute(text("DESCRIBE action_logs"))
            cols = result.fetchall()
            for col in cols:
                print(col)
        except Exception as e:
            print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(check())
