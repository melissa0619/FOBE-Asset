"""A small, cross-process lock for the scheduled synchronizer."""

import os
from pathlib import Path


class SyncAlreadyRunning(RuntimeError):
    """Raised when another synchronizer owns the lock."""


class SyncRunLock:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.acquired = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            # O_EXCL makes creating the lock an atomic operation on Windows.
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError as error:
            raise SyncAlreadyRunning(
                f"Another synchronization is already running ({self.path})."
            ) from error
        with os.fdopen(fd, "w", encoding="utf-8") as lock_file:
            lock_file.write(str(os.getpid()))
        self.acquired = True
        return self

    def __exit__(self, exc_type, exc, traceback):
        if self.acquired:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
