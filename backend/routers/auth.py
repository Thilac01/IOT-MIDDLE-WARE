from datetime import timedelta, datetime
import os
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Header
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession
from pydantic import BaseModel
import firebase_admin
from firebase_admin import credentials, auth as firebase_auth
from jose import JWTError, jwt
from passlib.context import CryptContext

from database import get_security_session, get_replica_session
from models import User, AuditLog
from config import settings

router = APIRouter(prefix="/auth", tags=["Authentication"])

# Password hashing
pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

# JWT settings
SECRET_KEY = settings.openai_api_key if hasattr(settings, 'openai_api_key') else "super-secret-key-for-lms-monitor"
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 # 24 hours

# Initialize Firebase Admin
if not firebase_admin._apps:
    try:
        service_account_path = settings.firebase_service_account_path
        if os.path.exists(service_account_path):
            cred = credentials.Certificate(service_account_path)
            firebase_admin.initialize_app(cred)
        else:
            firebase_admin.initialize_app()
    except Exception as e:
        print(f"Firebase initialization failed: {e}")

class UserRegister(BaseModel):
    username: str
    password: str
    email: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None

class UserLogin(BaseModel):
    username: str
    password: str

class Token(BaseModel):
    access_token: str
    token_type: str

class UserOut(BaseModel):
    id: Optional[int] = None
    username: str
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    email: Optional[str] = None
    role: str
    
    model_config = {"from_attributes": True}

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None):
    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=15)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt

async def get_current_user(
    authorization: Optional[str] = Header(None),
    session: AsyncSession = Depends(get_security_session)
):
    """
    Bypassed authentication: Always returns a mock admin user.
    """
    return User(
        id=1,
        username="admin",
        email="admin@example.com",
        first_name="Admin",
        last_name="User",
        hashed_password="bypassed-no-password-needed",
        role="admin"
    )

@router.post("/register", response_model=UserOut)
async def register(user_in: UserRegister, session: AsyncSession = Depends(get_security_session)):
    # Check if user exists
    stmt = select(User).where(User.username == user_in.username)
    result = await session.execute(stmt)
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already registered")
    
    hashed_pwd = pwd_context.hash(user_in.password)
    new_user = User(
        username=user_in.username,
        hashed_password=hashed_pwd,
        email=user_in.email,
        first_name=user_in.first_name,
        last_name=user_in.last_name,
        role="admin" # Default for this system as requested
    )
    session.add(new_user)
    await session.commit()
    await session.refresh(new_user)
    return new_user

@router.post("/login", response_model=Token)
async def login(user_in: UserLogin, session: AsyncSession = Depends(get_security_session)):
    stmt = select(User).where(User.username == user_in.username)
    result = await session.execute(stmt)
    user = result.scalar_one_or_none()
    
    if not user or not pwd_context.verify(user_in.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Incorrect username or password")
    
    access_token = create_access_token(
        data={"sub": user.username}, 
        expires_delta=timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    )
    return {"access_token": access_token, "token_type": "bearer"}

@router.get("/me", response_model=UserOut)
async def read_users_me(current_user: User = Depends(get_current_user)):
    return current_user

async def log_audit(session: AsyncSession, username: str, action: str, details: str = None):
    audit = AuditLog(username=username, action=action, details=details)
    session.add(audit)
    await session.commit()

@router.get("/audit_logs")
async def get_audit_logs(current_user: User = Depends(get_current_user), session: AsyncSession = Depends(get_security_session)):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    stmt = select(AuditLog).order_by(AuditLog.timestamp.desc()).limit(100)
    result = await session.execute(stmt)
    return result.scalars().all()

@router.get("/koha-action-logs")
async def get_koha_action_logs(
    current_user: User = Depends(get_current_user), 
    session: AsyncSession = Depends(get_replica_session)
):
    if current_user.role != "admin":
        raise HTTPException(status_code=403, detail="Not authorized")
    
    sql = text("""
        SELECT 
            al.timestamp, 
            IFNULL(CONCAT(b.firstname, ' ', b.surname), 'System/Unknown') as user_name, 
            al.module, 
            al.action, 
            al.info, 
            al.object
        FROM action_logs al
        LEFT JOIN borrowers b ON al.user = b.borrowernumber
        ORDER BY al.timestamp DESC
        LIMIT 100
    """)
    result = await session.execute(sql)
    return [dict(r._mapping) for r in result.fetchall()]

