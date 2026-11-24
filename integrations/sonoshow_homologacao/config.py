from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit


class ConfigError(ValueError):
    pass


def expand_path(value: str, base: Path) -> Path:
    expanded = os.path.expandvars(value)
    path = Path(expanded).expanduser()
    return path.resolve() if path.is_absolute() else (base / path).resolve()


@dataclass(frozen=True)
class RuntimeConfig:
    path: Path
    raw: dict
    state_dir: Path
    mapping_path: Path

    @property
    def enabled(self) -> bool:
        return self.raw["enabled"] is True

    @property
    def dry_run(self) -> bool:
        return self.raw["dryRun"] is True

    @property
    def production_guard(self) -> dict:
        return self.raw.get("productionGuard", {})

    @property
    def allowed_employee_cpfs(self) -> set[str]:
        return set(self.production_guard.get("employeeCpfAllowlist", []))


def load_config(path: Path) -> RuntimeConfig:
    path = path.resolve()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ConfigError(f"Configuracao invalida: {path}") from exc
    if raw.get("profile") != "homologacao":
        raise ConfigError("O perfil deve ser homologacao")
    if not isinstance(raw.get("enabled"), bool) or not isinstance(raw.get("dryRun"), bool):
        raise ConfigError("enabled e dryRun devem ser booleanos")
    connector = raw.get("connector", {})
    if connector.get("type") != "flit":
        raise ConfigError("Conector ainda nao suportado")
    parsed = urlsplit(connector.get("baseUrl", ""))
    if parsed.scheme != "https" or parsed.netloc != "api.flitapp.com.br" or parsed.query or parsed.fragment:
        raise ConfigError("A URL Flit deve ser https://api.flitapp.com.br")
    companies = connector.get("companies")
    if not isinstance(companies, list) or any(not isinstance(item, str) or not item.strip() for item in companies):
        raise ConfigError("connector.companies deve ser uma lista de CNPJs")
    journeys = connector.get("datasets", {}).get("jornadas", {})
    if journeys.get("enabled"):
        try:
            date.fromisoformat(journeys["initialDate"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ConfigError("jornadas.initialDate deve usar YYYY-MM-DD") from exc
    schedule = raw.get("schedule", {})
    if not isinstance(schedule.get("intervalSeconds"), int) or schedule["intervalSeconds"] < 60:
        raise ConfigError("O intervalo minimo e 60 segundos")
    target = raw.get("target", {})
    if target.get("type") != "firebird":
        raise ConfigError("Destino ainda nao suportado")
    environment = target.get("environment", "homologacao")
    if environment not in {"homologacao", "production"}:
        raise ConfigError("target.environment deve ser homologacao ou production")
    guard = raw.get("productionGuard", {})
    if environment == "production":
        cpfs = guard.get("employeeCpfAllowlist")
        if guard.get("enabled") is not True:
            raise ConfigError("productionGuard.enabled e obrigatorio para o banco de producao")
        if not isinstance(cpfs, list) or len(cpfs) != 1 or not isinstance(cpfs[0], str) or not cpfs[0].isdigit() or len(cpfs[0]) != 11:
            raise ConfigError("O teste em producao exige exatamente um CPF de 11 digitos")
        if cpfs != ["11447430794"]:
            raise ConfigError("Este pacote esta travado para o CPF 11447430794")
        if not isinstance(guard.get("acknowledgeSource"), bool):
            raise ConfigError("productionGuard.acknowledgeSource deve ser booleano")
        if connector.get("datasets", {}).get("empresas", {}).get("enabled"):
            raise ConfigError("Empresas nao podem ser sincronizadas no teste de um unico funcionario")
    base = path.parent
    state_dir = expand_path(raw.get("stateDir", "%PROGRAMDATA%/SonoShowGateway-Homologacao"), base)
    mapping_path = expand_path(raw.get("mappingFile", "flit-firebird.mapping.json"), base)
    if raw["enabled"] and not raw["dryRun"]:
        if not target.get("database"):
            raise ConfigError("Banco Firebird obrigatorio para execucao real")
        if not mapping_path.is_file():
            raise ConfigError("Mapeamento Firebird nao encontrado")
    return RuntimeConfig(path, raw, state_dir, mapping_path)

