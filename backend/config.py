"""
config.py — Centralised settings loaded from .env
"""
from urllib.parse import quote_plus
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    # --- Replica DB ---
    replica_host: str = "137.184.15.52"
    replica_port: int = 3306
    replica_user: str = "root"
    replica_password: str = "JPL@#lib260219a"
    replica_db: str = "koha_library"

    # --- SSH Tunnel ---
    ssh_host: str = "137.184.15.52"
    ssh_port: int = 22
    ssh_user: str = "root"
    ssh_password: str = "JPL@#lib260219a"
    use_ssh_tunnel: bool = True

    # --- Security Monitor DB (same server, different schema) ---
    security_db: str = "jpl_security_monitor"

    # --- CDC ---
    cdc_user: str = "root"
    cdc_password: str = "JPL@#lib260219a"
    cdc_server_id: int = 100

    # --- Koha REST API ---
    koha_api_base: str = "http://137.184.15.52:1025/api/v1"
    koha_api_client_id: str = "d49612ef-17a5-462a-9870-222e7e109873"
    koha_api_client_secret: str = "a089d59a-0ff3-4612-8ff4-8c43f34e940f"

    # --- App ---
    app_host: str = "0.0.0.0"
    app_port: int = 8000
    secret_key: str = "b95f517f43f0b42c15000dcfb9165a9296f2b5bd1e5a58dfc0bc12d1e29cfbcc"
    log_level: str = "INFO"

    @property
    def replica_dsn(self) -> str:
        """Async SQLAlchemy DSN for the Koha read replica.
        Password is URL-encoded to handle special chars like @ and #.
        """
        pwd = quote_plus(self.replica_password)
        return (
            f"mysql+aiomysql://{self.replica_user}:{pwd}"
            f"@{self.replica_host}:{self.replica_port}/{self.replica_db}"
            f"?charset=utf8mb4"
        )

    @property
    def security_dsn(self) -> str:
        """Async SQLAlchemy DSN for the security monitor database."""
        pwd = quote_plus(self.replica_password)
        return (
            f"mysql+aiomysql://{self.replica_user}:{pwd}"
            f"@{self.replica_host}:{self.replica_port}/{self.security_db}"
            f"?charset=utf8mb4"
        )


settings = Settings()

