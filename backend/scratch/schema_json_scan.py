import asyncio
import json
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

DB_URL = "mysql+aiomysql://root:JPL%40%23lib260219a@127.0.0.1:3307/koha_library?charset=utf8mb4"

async def scan():
    engine = create_async_engine(DB_URL)
    schema = {}
    async with engine.connect() as conn:
        for table in ["issues", "old_issues", "items", "biblio", "borrowers"]:
            try:
                result = await conn.execute(text(f"DESCRIBE {table}"))
                schema[table] = [r[0] for r in result.fetchall()]
            except Exception as e:
                schema[table] = f"error: {str(e)}"
    
    with open("scratch/schema.json", "w") as f:
        json.dump(schema, f, indent=2)
    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(scan())
