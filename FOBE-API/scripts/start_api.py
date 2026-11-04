"""Task Scheduler launcher for the local FOBE FastAPI service.

This module deliberately does not start a child process. Task Scheduler owns
the single Python process, so its restart policy can recover it if it fails.
"""

import logging
import os
import socket
import sys
from pathlib import Path
from dotenv import load_dotenv

# FOBE-API directory
PROJECT_DIR = Path(__file__).resolve().parent.parent

# FOBE-Asset/.env
ENV_FILE = PROJECT_DIR.parent / ".env"

# Load environment variables before starting FastAPI
load_dotenv(dotenv_path=ENV_FILE, override=False)

LOG_DIR = PROJECT_DIR / "logs"
DEFAULT_DB = PROJECT_DIR.parent / "data" / "asset_sync.db"

HOST = os.getenv("FOBE_API_HOST", "127.0.0.1")
PORT = int(os.getenv("FOBE_API_PORT", "8000"))


def configure_logging() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        handlers=[
            logging.FileHandler(LOG_DIR / "api-server.log", encoding="utf-8"),
            logging.StreamHandler(),
        ],
    )


def port_is_in_use(host: str, port: int) -> bool:
    """Return whether a process is already listening on the requested port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        return probe.connect_ex((host, port)) == 0


def main() -> int:
    configure_logging()
    os.chdir(PROJECT_DIR)
    # Executing ``scripts/start_api.py`` sets sys.path[0] to ``scripts``;
    # explicitly add the repository root so Uvicorn can import ``main:app``.
    if str(PROJECT_DIR) not in sys.path:
        sys.path.insert(0, str(PROJECT_DIR))
    database_path = Path(os.getenv("FOBE_ASSET_DB", DEFAULT_DB)).resolve()

    logging.info("FOBE API launcher starting")
    logging.info("Python interpreter: %s", sys.executable)
    logging.info("Working directory: %s", PROJECT_DIR)
    logging.info("Listening address: http://%s:%s", HOST, PORT)

    if not database_path.is_file():
        logging.error("Configured SQLite database is unavailable: %s", database_path)
        return 2
    # Preserve the API's configuration contract while making the resolved path
    # unambiguous for Task Scheduler, whose working directory may vary.
    os.environ["FOBE_ASSET_DB"] = str(database_path)

    if port_is_in_use(HOST, PORT):
        logging.error(
            "Port %s is already in use on %s; no second API instance was started.",
            PORT,
            HOST,
        )
        return 3

    try:
        import uvicorn

        logging.info("Starting Uvicorn with main:app (reload disabled)")
        class LoggingServer(uvicorn.Server):
            async def startup(self, sockets=None):
                await super().startup(sockets)
                if self.started:
                    logging.info("Uvicorn server initialization completed successfully")

        config = uvicorn.Config("main:app", host=HOST, port=PORT, log_level="info")
        LoggingServer(config).run()
        logging.warning("Uvicorn stopped unexpectedly or was asked to shut down.")
        return 0
    except Exception:
        logging.exception("FOBE API could not start or terminated with an error")
        return 1


if __name__ == "__main__":
    sys.exit(main())
