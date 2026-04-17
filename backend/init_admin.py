import asyncio
from sqlalchemy import select
from database import SecuritySession
from models import User
from routers.auth import pwd_context

async def init_admin():
    async with SecuritySession() as session:
        # Check if admin exists
        stmt = select(User).where(User.username == "admin")
        result = await session.execute(stmt)
        admin = result.scalar_one_or_none()
        
        if admin:
            print("Admin user already exists. Updating password...")
            admin.hashed_password = pwd_context.hash("pass")
        else:
            print("Creating admin user...")
            admin = User(
                username="admin",
                hashed_password=pwd_context.hash("pass"),
                role="admin",
                first_name="System",
                last_name="Administrator"
            )
            session.add(admin)
        
        await session.commit()
        print("Admin user initialized with username 'admin' and password 'pass'.")

if __name__ == "__main__":
    asyncio.run(init_admin())
