from __future__ import annotations

import hashlib
import json
import ssl
from datetime import date, timedelta
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlsplit
from urllib.request import Request, urlopen

import certifi

from .base import Batch, Event


DOCUMENTED_DATASETS = {
    "jornadas": "/jornadas",
    "excecoes": "/excecoes_pendentes",
    "marcacoes": "/marcacoes_pendentes",
    "empresas": "/empresas",
}
ACK_ENDPOINTS = {
    "excecoes": "/confirmar_recebimento_excecoes",
    "marcacoes": "/confirmar_recebimento_marcacoes",
}
PENDING_PRIVATE_CONTRACT = {
    "situacao", "admissoes", "desligamentos", "colaboradores", "cargos", "departamentos"
}


def digits(value: Any) -> str:
    return "".join(character for character in str(value or "") if character.isdigit())


def event_employee_cpf(payload: dict[str, Any]) -> str:
    collaborator = payload.get("colaborador")
    return digits(collaborator.get("documento")) if isinstance(collaborator, dict) else ""


class FlitError(RuntimeError):
    pass


class FlitConnector:
    name = "flit"

    def __init__(self, config: dict, secrets: dict[str, str], transport=None, today=None, allowed_cpfs=None):
        self.config = config
        self.base_url = config["baseUrl"].rstrip("/") + "/"
        self.companies = config.get("companies", [])
        self.secrets = secrets
        self.transport = transport or self._request
        self.today = today or date.today
        self.allowed_cpfs = set(allowed_cpfs or [])

    def datasets(self) -> list[str]:
        configured = self.config.get("datasets", {})
        unknown = set(configured) - set(DOCUMENTED_DATASETS) - PENDING_PRIVATE_CONTRACT
        if unknown:
            raise FlitError(f"Datasets Flit desconhecidos: {', '.join(sorted(unknown))}")
        blocked = [name for name in PENDING_PRIVATE_CONTRACT if configured.get(name, {}).get("enabled")]
        if blocked:
            raise FlitError(
                "Endpoints nao publicados pela Flit; desative ate receber contrato oficial: "
                + ", ".join(sorted(blocked))
            )
        return [name for name in DOCUMENTED_DATASETS if configured.get(name, {}).get("enabled") is True]

    def _headers(self) -> dict[str, str]:
        required = ("flitAccountKey", "flitGlobalKey", "flitTerminalKey")
        missing = [name for name in required if not self.secrets.get(name)]
        if missing:
            raise FlitError("Credenciais Flit ausentes: " + ", ".join(missing))
        return {
            "AccountKey": self.secrets["flitAccountKey"],
            "GlobalKey": self.secrets["flitGlobalKey"],
            "TerminalKey": self.secrets["flitTerminalKey"],
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "SonoShowGateway-Homologacao/0.1",
        }

    def _request(self, method: str, url: str, body: dict | None) -> dict:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(url, data=data, method=method, headers=self._headers())
        try:
            with urlopen(request, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            raise FlitError(f"Flit recusou a requisicao ({exc.code})") from exc
        except (URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise FlitError("Resposta invalida ou indisponivel da Flit") from exc

    def authenticate_once(self) -> str:
        headers = {
            "AccountKey": self.secrets.get("flitAccountKey", ""),
            "GlobalKey": self.secrets.get("flitGlobalKey", ""),
            "Accept": "application/json",
        }
        if not all(headers.values()):
            raise FlitError("AccountKey e GlobalKey sao obrigatorias")
        request = Request(urljoin(self.base_url, "autenticacao"), method="GET", headers=headers)
        try:
            with urlopen(request, timeout=30, context=ssl.create_default_context(cafile=certifi.where())) as response:
                terminal = json.loads(response.read().decode("utf-8")).get("terminal_key")
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise FlitError("Nao foi possivel autenticar na Flit") from exc
        if not terminal:
            raise FlitError("Flit nao retornou terminal_key")
        return terminal

    @staticmethod
    def _event_id(dataset: str, company: str, item: dict[str, Any]) -> str:
        source_id = item.get("id")
        if source_id is not None:
            material = f"{dataset}\0{company}\0{source_id}".encode()
        else:
            material = json.dumps([dataset, company, item], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        return hashlib.sha256(material).hexdigest()

    def _body(self, dataset: str, cursor: str | None) -> dict | None:
        if dataset == "empresas":
            return None
        body: dict[str, Any] = {"empresas": self.companies}
        if dataset == "jornadas":
            settings = self.config["datasets"][dataset]
            end = self.today()
            overlap = int(settings.get("overlapDays", 2))
            start = date.fromisoformat(cursor) - timedelta(days=overlap) if cursor else date.fromisoformat(settings["initialDate"])
            body.update(data_inicial=start.isoformat(), data_final=end.isoformat())
            if len(self.allowed_cpfs) == 1:
                body["cpf_colaborador"] = next(iter(self.allowed_cpfs))
        return body

    def fetch(self, dataset: str, cursor: str | None) -> Batch:
        if dataset not in DOCUMENTED_DATASETS:
            raise FlitError(f"Dataset sem endpoint oficial: {dataset}")
        if dataset != "empresas" and not self.companies:
            raise FlitError("Configure ao menos um CNPJ em connector.companies")
        method = "GET" if dataset == "empresas" else "POST"
        body = self._body(dataset, cursor)
        url = urljoin(self.base_url, DOCUMENTED_DATASETS[dataset].lstrip("/"))
        items: list[tuple[str, dict]] = []
        while url:
            payload = self.transport(method, url, body)
            root = payload.get(dataset, payload.get("empresas" if dataset == "empresas" else dataset, {}))
            if dataset == "empresas" and isinstance(root, list):
                items.extend((str(item.get("documento", "")), item) for item in root)
            elif isinstance(root, dict):
                for company, records in root.items():
                    if isinstance(records, list):
                        items.extend((company, item) for item in records if isinstance(item, dict))
            else:
                raise FlitError(f"Formato inesperado no dataset {dataset}")
            next_value = payload.get("next")
            if not next_value:
                break
            candidate = urljoin(self.base_url, next_value)
            if urlsplit(candidate).netloc != urlsplit(self.base_url).netloc:
                raise FlitError("Paginacao Flit apontou para outro host")
            url = candidate
        events = [
            Event(dataset, self._event_id(dataset, company, item), {"empresa_documento": company, **item}, str(item.get("id")) if item.get("id") is not None else None)
            for company, item in items
        ]
        before_filter = len(events)
        if self.allowed_cpfs and dataset != "empresas":
            events = [event for event in events if event_employee_cpf(event.payload) in self.allowed_cpfs]
        return Batch(events, self.today().isoformat() if dataset == "jornadas" else cursor, before_filter - len(events))

    def acknowledge(self, dataset: str, events: list[Event]) -> None:
        endpoint = ACK_ENDPOINTS.get(dataset)
        if not endpoint:
            return
        ids = [event.source_id for event in events if event.source_id]
        noun = "excecoes" if dataset == "excecoes" else "marcacoes"
        for start in range(0, len(ids), 500):
            self.transport("POST", urljoin(self.base_url, endpoint.lstrip("/")), {noun: ids[start:start + 500]})

