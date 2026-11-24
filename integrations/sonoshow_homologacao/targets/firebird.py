from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from ..connectors.base import Event
from ..connectors.flit import event_employee_cpf


class FirebirdTargetError(RuntimeError):
    pass


def json_path(payload: dict[str, Any], path: str):
    if not path.startswith("$."):
        raise FirebirdTargetError(f"Caminho de mapeamento invalido: {path}")
    value: Any = payload
    for part in path[2:].split("."):
        if not isinstance(value, dict):
            return None
        value = value.get(part)
    return value


class FirebirdTarget:
    name = "firebird"

    def __init__(self, config: dict, secrets: dict[str, str], mapping_path: Path, connector_factory=None, allowed_cpfs=None):
        self.config = config
        self.secrets = secrets
        self.mapping_path = mapping_path
        self.mapping = self._load_mapping(mapping_path)
        self.connector_factory = connector_factory or self._connect
        self.allowed_cpfs = set(allowed_cpfs or [])

    @staticmethod
    def _load_mapping(path: Path) -> dict:
        if not path.is_file():
            return {"datasets": {}}
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise FirebirdTargetError("Mapeamento Firebird invalido") from exc
        if value.get("schemaVersion") != 1 or not isinstance(value.get("datasets"), dict):
            raise FirebirdTargetError("Mapeamento Firebird deve usar schemaVersion 1")
        return value

    def _connect(self):
        try:
            from firebird.driver import connect, driver_config
            from firebird.driver.fbapi import get_api
        except ImportError as exc:
            raise FirebirdTargetError("Driver Firebird nao instalado") from exc
        configured = self.config.get("clientLibrary", "").strip()
        candidates = []
        if configured:
            candidates.append(Path(configured).expanduser())
        runtime_root = getattr(sys, "_MEIPASS", None)
        if runtime_root:
            candidates.append(Path(runtime_root) / "firebird_client" / "fbclient.dll")
        library = next((path.resolve() for path in candidates if path.is_file()), None)
        if library:
            driver_config.fb_client_library.value = str(library)
            get_api()
        elif configured:
            raise FirebirdTargetError("Cliente Firebird configurado nao foi encontrado")
        database = f"{self.config.get('host', '127.0.0.1')}/{int(self.config.get('port', 3050))}:{self.config['database']}"
        user = self.secrets.get("firebirdUser")
        password = self.secrets.get("firebirdPassword")
        if not user or not password:
            raise FirebirdTargetError("Credenciais Firebird de homologacao ausentes")
        return connect(database=database, user=user, password=password, charset=self.config.get("charset", "UTF8"))

    def validate(self) -> None:
        missing = []
        for dataset, definition in self.mapping.get("datasets", {}).items():
            if definition.get("enabled") and (not definition.get("sql") or not isinstance(definition.get("params"), list)):
                missing.append(dataset)
        if missing:
            raise FirebirdTargetError("SQL/params ausentes no mapeamento: " + ", ".join(missing))

    def apply(self, connector: str, dataset: str, events: list[Event], dry_run: bool) -> list[str]:
        if self.config.get("environment") == "production":
            if not self.allowed_cpfs:
                raise FirebirdTargetError("Trava de CPF ausente para o banco de producao")
            outside_scope = [event for event in events if event_employee_cpf(event.payload) not in self.allowed_cpfs]
            if outside_scope:
                raise FirebirdTargetError("Lote bloqueado: contem funcionario fora do CPF autorizado")
        definition = self.mapping.get("datasets", {}).get(dataset, {})
        if not definition.get("enabled"):
            if dry_run:
                return [event.event_id for event in events]
            raise FirebirdTargetError(f"Dataset sem mapeamento habilitado: {dataset}")
        sql = definition.get("sql")
        params = definition.get("params")
        if not sql or not isinstance(params, list):
            if dry_run:
                return [event.event_id for event in events]
            raise FirebirdTargetError(f"SQL nao configurado para {dataset}")
        if dry_run:
            # Resolve os caminhos para validar o mapeamento, mas nao abre o banco.
            for event in events:
                [json_path(event.payload, path) for path in params]
            return [event.event_id for event in events]
        connection = self.connector_factory()
        applied: list[str] = []
        try:
            cursor = connection.cursor()
            for event in events:
                cursor.execute(
                    "SELECT EVENT_ID FROM SSG_IDEMPOTENCIA WHERE CONNECTOR=? AND DATASET=? AND EVENT_ID=?",
                    (connector, dataset, event.event_id),
                )
                if cursor.fetchone():
                    applied.append(event.event_id)
                    continue
                cursor.execute(sql, tuple(json_path(event.payload, path) for path in params))
                cursor.execute(
                    "INSERT INTO SSG_IDEMPOTENCIA(CONNECTOR,DATASET,EVENT_ID) VALUES(?,?,?)",
                    (connector, dataset, event.event_id),
                )
                applied.append(event.event_id)
            connection.commit()
            return applied
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

