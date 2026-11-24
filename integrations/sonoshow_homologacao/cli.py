from __future__ import annotations

import argparse
import getpass
import json
import os
import sys
import time
from pathlib import Path

from . import __version__
from .audit import create_logger
from .config import ConfigError, load_config
from .connectors.flit import FlitConnector
from .core import SyncEngine
from .secrets_store import SecretsStore
from .state import StateStore
from .targets.firebird import FirebirdTarget


def default_config() -> Path:
    root = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path.cwd()
    return root / "config" / "homologacao.json"


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description="SonoShow Gateway - Homologacao de integracoes")
    result.add_argument("--config", type=Path, default=default_config())
    result.add_argument("--version", action="version", version=__version__)
    sub = result.add_subparsers(dest="command", required=True)
    sub.add_parser("validate", help="Validar configuracao sem acessar APIs ou banco")
    sub.add_parser("configure-secrets", help="Gravar credenciais separadas com Windows DPAPI")
    sub.add_parser("auth-init", help="Obter TerminalKey uma unica vez no endpoint oficial Flit")
    sub.add_parser("run-once", help="Executar um ciclo")
    sub.add_parser("serve", help="Executar ciclos no intervalo configurado")
    return result


def secret_path(config) -> Path:
    return config.state_dir / "credentials.dpapi"


def build_engine(config):
    secrets = SecretsStore(secret_path(config)).load()
    source = FlitConnector(config.raw["connector"], secrets, allowed_cpfs=config.allowed_employee_cpfs)
    target = FirebirdTarget(config.raw["target"], secrets, config.mapping_path, allowed_cpfs=config.allowed_employee_cpfs)
    state = StateStore(config.state_dir / "state.sqlite3")
    logger = create_logger(config.state_dir / "logs")
    acknowledge = config.production_guard.get("acknowledgeSource", True)
    return SyncEngine(source, target, state, logger, config.dry_run, acknowledge_source=acknowledge), state


def prompt_secret(label: str, current: str | None) -> str:
    value = getpass.getpass(f"{label}{' [manter atual]' if current else ''}: ")
    return value or current or ""


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        config = load_config(args.config)
        store = SecretsStore(secret_path(config))
        if args.command == "validate":
            source = FlitConnector(config.raw["connector"], {}, allowed_cpfs=config.allowed_employee_cpfs)
            datasets = source.datasets()
            FirebirdTarget(config.raw["target"], {}, config.mapping_path, allowed_cpfs=config.allowed_employee_cpfs).validate()
            print(json.dumps({
                "status": "ok", "profile": "homologacao", "enabled": config.enabled,
                "dryRun": config.dry_run, "datasets": datasets,
                "targetEnvironment": config.raw["target"].get("environment", "homologacao"),
                "employeeCpfAllowlistCount": len(config.allowed_employee_cpfs),
                "acknowledgeSource": config.production_guard.get("acknowledgeSource", True),
                "stateDir": str(config.state_dir), "credentialsConfigured": store.path.is_file(),
            }, indent=2, ensure_ascii=False))
            return 0
        if args.command == "configure-secrets":
            current = store.load()
            values = {
                "flitAccountKey": prompt_secret("Flit AccountKey", current.get("flitAccountKey")),
                "flitGlobalKey": prompt_secret("Flit GlobalKey", current.get("flitGlobalKey")),
                "flitTerminalKey": prompt_secret("Flit TerminalKey (vazio para auth-init)", current.get("flitTerminalKey")),
                "firebirdUser": prompt_secret("Firebird usuario de integracao", current.get("firebirdUser")),
                "firebirdPassword": prompt_secret("Firebird senha de integracao", current.get("firebirdPassword")),
            }
            store.save(values)
            print(f"Credenciais protegidas em {store.path}")
            return 0
        if args.command == "auth-init":
            secrets = store.load()
            terminal = FlitConnector(config.raw["connector"], secrets).authenticate_once()
            secrets["flitTerminalKey"] = terminal
            store.save(secrets)
            print("TerminalKey recebida e protegida com DPAPI; o valor nao sera exibido.")
            return 0
        if not config.enabled:
            raise ConfigError("Homologacao desativada: altere enabled somente quando estiver pronto para testar")
        engine, state = build_engine(config)
        try:
            if args.command == "run-once":
                print(json.dumps(engine.run_once(), indent=2, ensure_ascii=False))
                return 0
            interval = config.raw["schedule"]["intervalSeconds"]
            while True:
                try:
                    print(json.dumps(engine.run_once(), ensure_ascii=False))
                except Exception as exc:
                    engine.logger.exception("cycle_failed", extra={"status": "error"})
                    print(f"Ciclo falhou: {type(exc).__name__}", file=sys.stderr)
                time.sleep(interval)
        finally:
            state.close()
    except (ConfigError, ValueError, RuntimeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

