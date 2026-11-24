from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from logging.handlers import RotatingFileHandler
from pathlib import Path


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "time": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "event": record.getMessage(),
        }
        for key in ("run_id", "connector", "dataset", "event_id", "status", "count", "duration_ms"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = record.exc_info[0].__name__
            payload["exception_message"] = " ".join(str(record.exc_info[1]).splitlines())[:1000]
        return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def create_logger(directory: Path) -> logging.Logger:
    directory.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(f"sonoshow_homologacao:{directory}")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    if not logger.handlers:
        handler = RotatingFileHandler(directory / "audit.jsonl", maxBytes=10_000_000, backupCount=10, encoding="utf-8")
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    return logger

