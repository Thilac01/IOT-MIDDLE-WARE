import asyncio
import sys
import io
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# Force UTF-8 for everything
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

DB_URL = "mysql+aiomysql://root:JPL%40%23lib260219a@127.0.0.1:3307/koha_library?charset=utf8mb4"

async def test_koha():
    engine = create_async_engine(DB_URL)
    try:
        async with engine.connect() as conn:
            for table in ["issues", "old_issues", "items", "biblio", "borrowers"]:
                print(f"Scanning table: {table}")
                try:
                    result = await conn.execute(text(f"DESCRIBE {table}"))
                    cols = [r[0] for r in result.fetchall()]
                    print(f"Columns in {table}: {cols}")
                except Exception as e:
                    print(f"Failed to scan {table}: {str(e)}")
    except Exception as globe:
        print(f"GLOBAL ERROR: {str(globe)}")
    finally:
        await engine.dispose()

if __name__ == "__main__":
    asyncio.run(test_koha())
