from __future__ import annotations

import time
import uuid

from .connectors.base import SourceConnector, TargetConnector
from .state import StateStore


class SyncEngine:
    def __init__(self, source: SourceConnector, target: TargetConnector, state: StateStore, logger, dry_run: bool, acknowledge_source: bool = True):
        self.source = source
        self.target = target
        self.state = state
        self.logger = logger
        self.dry_run = dry_run
        self.acknowledge_source = acknowledge_source

    def run_once(self) -> dict[str, dict[str, int]]:
        run_id = str(uuid.uuid4())
        summary: dict[str, dict[str, int]] = {}
        self.target.validate()
        for dataset in self.source.datasets():
            started = time.monotonic()
            cursor = self.state.cursor(self.source.name, dataset)
            batch = self.source.fetch(dataset, cursor)
            pending = [
                event for event in batch.events
                if not self.state.was_applied(self.source.name, dataset, event.event_id)
            ]
            applied_ids = self.target.apply(self.source.name, dataset, pending, self.dry_run)
            applied_set = set(applied_ids)
            applied_events = [event for event in pending if event.event_id in applied_set]
            if not self.dry_run:
                if self.acknowledge_source:
                    self.source.acknowledge(dataset, applied_events)
                # A confirmacao da origem vem depois do commit do destino, mas
                # antes do estado local. Se ela falhar, o proximo ciclo repete
                # com seguranca: a idempotencia do destino impede nova escrita.
                self.state.mark_applied(self.source.name, dataset, applied_ids)
                if batch.next_cursor is not None:
                    self.state.set_cursor(self.source.name, dataset, batch.next_cursor)
            summary[dataset] = {
                "received": len(batch.events),
                "skipped": len(batch.events) - len(pending),
                "filtered": batch.filtered_count,
                "applied": len(applied_ids),
            }
            self.logger.info(
                "dataset_completed",
                extra={
                    "run_id": run_id,
                    "connector": self.source.name,
                    "dataset": dataset,
                    "status": "dry-run" if self.dry_run else "committed",
                    "count": len(applied_ids),
                    "duration_ms": round((time.monotonic() - started) * 1000),
                },
            )
        return summary

