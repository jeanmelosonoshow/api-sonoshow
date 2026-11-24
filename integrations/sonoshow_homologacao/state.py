from __future__ import annotations

import sqlite3
from pathlib import Path


class StateStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript("""
            CREATE TABLE IF NOT EXISTS cursors (
              connector TEXT NOT NULL, dataset TEXT NOT NULL, value TEXT NOT NULL,
              PRIMARY KEY (connector, dataset)
            );
            CREATE TABLE IF NOT EXISTS applied_events (
              connector TEXT NOT NULL, dataset TEXT NOT NULL, event_id TEXT NOT NULL,
              applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
              PRIMARY KEY (connector, dataset, event_id)
            );
        """)

    def cursor(self, connector: str, dataset: str) -> str | None:
        row = self.connection.execute(
            "SELECT value FROM cursors WHERE connector=? AND dataset=?", (connector, dataset)
        ).fetchone()
        return row[0] if row else None

    def set_cursor(self, connector: str, dataset: str, value: str) -> None:
        self.connection.execute(
            "INSERT INTO cursors(connector,dataset,value) VALUES(?,?,?) "
            "ON CONFLICT(connector,dataset) DO UPDATE SET value=excluded.value",
            (connector, dataset, value),
        )
        self.connection.commit()

    def was_applied(self, connector: str, dataset: str, event_id: str) -> bool:
        return self.connection.execute(
            "SELECT 1 FROM applied_events WHERE connector=? AND dataset=? AND event_id=?",
            (connector, dataset, event_id),
        ).fetchone() is not None

    def mark_applied(self, connector: str, dataset: str, event_ids: list[str]) -> None:
        self.connection.executemany(
            "INSERT OR IGNORE INTO applied_events(connector,dataset,event_id) VALUES(?,?,?)",
            [(connector, dataset, event_id) for event_id in event_ids],
        )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

