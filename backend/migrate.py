import asyncio
from sqlalchemy import text
from database import security_engine

async def alter_table():
    async with security_engine.begin() as conn:
        try:
            await conn.execute(text("ALTER TABLE raspberry_devices ADD COLUMN cpu_usage FLOAT DEFAULT 0;"))
            print("Added cpu_usage")
        except Exception as e:
            print("Could not add cpu_usage", e)
        try:
            await conn.execute(text("ALTER TABLE raspberry_devices ADD COLUMN ram_usage FLOAT DEFAULT 0;"))
            print("Added ram_usage")
        except Exception as e:
            print("Could not add ram_usage", e)

if __name__ == "__main__":
    asyncio.run(alter_table())
