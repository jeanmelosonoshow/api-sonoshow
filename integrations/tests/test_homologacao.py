from __future__ import annotations

import json
import logging
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from sonoshow_homologacao.config import ConfigError, load_config
from sonoshow_homologacao.connectors.base import Batch, Event
from sonoshow_homologacao.connectors.flit import FlitConnector, FlitError
from sonoshow_homologacao.core import SyncEngine
from sonoshow_homologacao.state import StateStore
from sonoshow_homologacao.targets.firebird import FirebirdTarget


class ConfigTests(unittest.TestCase):
    def test_private_endpoint_cannot_be_enabled(self):
        connector = FlitConnector({
            "baseUrl": "https://api.flitapp.com.br", "companies": [],
            "datasets": {"admissoes": {"enabled": True}},
        }, {})
        with self.assertRaisesRegex(FlitError, "nao publicados"):
            connector.datasets()

    def test_production_is_locked_to_the_authorized_single_cpf(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            base = {
                "profile": "homologacao", "enabled": False, "dryRun": True,
                "stateDir": "state", "mappingFile": "mapping.json",
                "schedule": {"intervalSeconds": 60},
                "connector": {"type": "flit", "baseUrl": "https://api.flitapp.com.br", "companies": [], "datasets": {}},
                "target": {"type": "firebird", "environment": "production", "database": ""},
                "productionGuard": {"enabled": True, "employeeCpfAllowlist": ["00000000000"], "acknowledgeSource": False},
            }
            path.write_text(json.dumps(base), encoding="utf-8")
            with self.assertRaisesRegex(ConfigError, "travado"):
                load_config(path)
            base["productionGuard"]["employeeCpfAllowlist"] = ["11447430794"]
            path.write_text(json.dumps(base), encoding="utf-8")
            self.assertEqual(load_config(path).allowed_employee_cpfs, {"11447430794"})


class FlitTests(unittest.TestCase):
    def test_journeys_use_documented_endpoint_and_pagination(self):
        calls = []

        def transport(method, url, body):
            calls.append((method, url, body))
            if len(calls) == 1:
                return {"jornadas": {"12.345.678/0001-99": [{"data": "2026-11-22", "colaborador": {"documento": "1"}}]}, "next": "/jornadas?page=2"}
            return {"jornadas": {"12.345.678/0001-99": [{"data": "2026-11-23", "colaborador": {"documento": "1"}}]}}

        connector = FlitConnector({
            "baseUrl": "https://api.flitapp.com.br", "companies": ["12.345.678/0001-99"],
            "datasets": {"jornadas": {"enabled": True, "initialDate": "2026-11-01", "overlapDays": 2}},
        }, {}, transport=transport, today=lambda: date(2026, 11, 23))
        batch = connector.fetch("jornadas", "2026-11-22")
        self.assertEqual(len(batch.events), 2)
        self.assertEqual(batch.next_cursor, "2026-11-23")
        self.assertEqual(calls[0][0], "POST")
        self.assertEqual(calls[0][1], "https://api.flitapp.com.br/jornadas")
        self.assertEqual(calls[0][2]["data_inicial"], "2026-11-20")
        self.assertEqual(calls[1][1], "https://api.flitapp.com.br/jornadas?page=2")

    def test_single_cpf_is_sent_to_flit_and_other_employee_is_filtered(self):
        calls = []
        def transport(method, url, body):
            calls.append(body)
            return {"jornadas": {"12.345.678/0001-99": [
                {"data": "2026-11-23", "colaborador": {"documento": "114.474.307-94"}},
                {"data": "2026-11-23", "colaborador": {"documento": "000.000.000-00"}},
            ]}}
        connector = FlitConnector({
            "baseUrl": "https://api.flitapp.com.br", "companies": ["12.345.678/0001-99"],
            "datasets": {"jornadas": {"enabled": True, "initialDate": "2026-11-01"}},
        }, {}, transport=transport, today=lambda: date(2026, 11, 23), allowed_cpfs={"11447430794"})
        batch = connector.fetch("jornadas", None)
        self.assertEqual(calls[0]["cpf_colaborador"], "11447430794")
        self.assertEqual(len(batch.events), 1)
        self.assertEqual(batch.filtered_count, 1)

    def test_confirmation_is_split_at_official_limit(self):
        calls = []
        connector = FlitConnector({"baseUrl": "https://api.flitapp.com.br", "companies": [], "datasets": {}}, {}, transport=lambda *args: calls.append(args) or {})
        events = [Event("excecoes", str(i), {}, str(i)) for i in range(501)]
        connector.acknowledge("excecoes", events)
        self.assertEqual([len(call[2]["excecoes"]) for call in calls], [500, 1])


class FakeSource:
    name = "fake"

    def __init__(self):
        self.acknowledged = []

    def datasets(self):
        return ["items"]

    def fetch(self, dataset, cursor):
        return Batch([Event(dataset, "e1", {"value": 1}, "source-1")], "next")

    def acknowledge(self, dataset, events):
        self.acknowledged.extend(events)


class FailingAcknowledgeSource(FakeSource):
    def acknowledge(self, dataset, events):
        raise RuntimeError("confirmacao indisponivel")


class FakeTarget:
    name = "fake-target"

    def validate(self):
        pass

    def apply(self, connector, dataset, events, dry_run):
        return [event.event_id for event in events]


class CoreTests(unittest.TestCase):
    def test_dry_run_does_not_advance_or_acknowledge(self):
        with tempfile.TemporaryDirectory() as directory:
            state = StateStore(Path(directory) / "state.db")
            source = FakeSource()
            engine = SyncEngine(source, FakeTarget(), state, logging.getLogger("test-dry"), True)
            self.assertEqual(engine.run_once()["items"]["applied"], 1)
            self.assertIsNone(state.cursor("fake", "items"))
            self.assertFalse(state.was_applied("fake", "items", "e1"))
            self.assertEqual(source.acknowledged, [])
            state.close()

    def test_commit_advances_state_and_acknowledges(self):
        with tempfile.TemporaryDirectory() as directory:
            state = StateStore(Path(directory) / "state.db")
            source = FakeSource()
            engine = SyncEngine(source, FakeTarget(), state, logging.getLogger("test-live"), False)
            engine.run_once()
            self.assertEqual(state.cursor("fake", "items"), "next")
            self.assertTrue(state.was_applied("fake", "items", "e1"))
            self.assertEqual(len(source.acknowledged), 1)
            state.close()

    def test_failed_source_confirmation_does_not_advance_local_state(self):
        with tempfile.TemporaryDirectory() as directory:
            state = StateStore(Path(directory) / "state.db")
            engine = SyncEngine(FailingAcknowledgeSource(), FakeTarget(), state, logging.getLogger("test-ack"), False)
            with self.assertRaisesRegex(RuntimeError, "confirmacao"):
                engine.run_once()
            self.assertIsNone(state.cursor("fake", "items"))
            self.assertFalse(state.was_applied("fake", "items", "e1"))
            state.close()


class FakeCursor:
    def __init__(self):
        self.statements = []
        self._found = False

    def execute(self, sql, params):
        self.statements.append((sql, params))
        self._found = sql.startswith("SELECT") and params[-1] == "existing"

    def fetchone(self):
        return ("existing",) if self._found else None


class FakeConnection:
    def __init__(self):
        self.db_cursor = FakeCursor()
        self.committed = False
        self.rolled_back = False

    def cursor(self): return self.db_cursor
    def commit(self): self.committed = True
    def rollback(self): self.rolled_back = True
    def close(self): pass


class FirebirdTests(unittest.TestCase):
    def test_transaction_and_idempotency_are_applied(self):
        with tempfile.TemporaryDirectory() as directory:
            mapping = Path(directory) / "mapping.json"
            mapping.write_text(json.dumps({
                "schemaVersion": 1,
                "datasets": {"items": {"enabled": True, "sql": "UPDATE X SET VALUE=?", "params": ["$.value"]}},
            }), encoding="utf-8")
            connection = FakeConnection()
            target = FirebirdTarget({"database": "x"}, {}, mapping, connector_factory=lambda: connection)
            result = target.apply("source", "items", [
                Event("items", "existing", {"value": 1}), Event("items", "new", {"value": 2}),
            ], False)
            self.assertEqual(result, ["existing", "new"])
            self.assertTrue(connection.committed)
            updates = [item for item in connection.db_cursor.statements if item[0].startswith("UPDATE")]
            self.assertEqual(updates, [("UPDATE X SET VALUE=?", (2,))])

    def test_production_target_rejects_employee_outside_allowlist(self):
        with tempfile.TemporaryDirectory() as directory:
            mapping = Path(directory) / "mapping.json"
            mapping.write_text(json.dumps({"schemaVersion": 1, "datasets": {}}), encoding="utf-8")
            target = FirebirdTarget(
                {"environment": "production", "database": "x"}, {}, mapping,
                allowed_cpfs={"11447430794"},
            )
            with self.assertRaisesRegex(RuntimeError, "fora do CPF"):
                target.apply("flit", "jornadas", [
                    Event("jornadas", "x", {"colaborador": {"documento": "00000000000"}})
                ], True)


if __name__ == "__main__":
    unittest.main()

