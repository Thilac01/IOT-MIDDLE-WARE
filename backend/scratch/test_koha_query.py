import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

# URL ENCODED JPL@#lib260219a -> JPL%40%23lib260219a
DB_URL = "mysql+aiomysql://root:JPL%40%23lib260219a@127.0.0.1:3307/koha_library?charset=utf8mb4"

async def test_query():
    engine = create_async_engine(DB_URL)
    async with engine.connect() as conn:
        print("Testing Active Loans Query...")
        try:
            query = text("""
                SELECT 
                    i.issue_id, i.issuedate, i.date_due, i.branchcode,
                    it.barcode, b.title, p.firstname, p.surname
                FROM issues i
                LEFT JOIN items it ON i.itemnumber = it.itemnumber
                LEFT JOIN biblio b ON it.biblionumber = b.biblionumber
                LEFT JOIN borrowers p ON i.borrowernumber = p.borrowernumber
                ORDER BY i.issuedate DESC
                LIMIT 1
            """)
            result = await conn.execute(query)
            row = result.fetchone()
            print(f"Success: {row}")
        except Exception as e:
            print(f"Active Query Failed: {e}")

    await engine.dispose()

if __name__ == "__main__":
    asyncio.run(test_query())
