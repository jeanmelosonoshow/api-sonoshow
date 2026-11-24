from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class Event:
    dataset: str
    event_id: str
    payload: dict[str, Any]
    source_id: str | None = None


@dataclass(frozen=True)
class Batch:
    events: list[Event]
    next_cursor: str | None = None
    filtered_count: int = 0


class SourceConnector(Protocol):
    name: str

    def datasets(self) -> list[str]: ...
    def fetch(self, dataset: str, cursor: str | None) -> Batch: ...
    def acknowledge(self, dataset: str, events: list[Event]) -> None: ...


class TargetConnector(Protocol):
    name: str

    def validate(self) -> None: ...
    def apply(self, connector: str, dataset: str, events: list[Event], dry_run: bool) -> list[str]: ...

