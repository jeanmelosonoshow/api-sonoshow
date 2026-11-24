from __future__ import annotations

import base64
import ctypes
import json
import os
from ctypes import wintypes
from pathlib import Path


ENTROPY = b"SonoShowGateway-Homologacao-v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x01


class DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _blob(data: bytes):
    buffer = ctypes.create_string_buffer(data)
    return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte))), buffer


def _apis():
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [
        ctypes.POINTER(DATA_BLOB), wintypes.LPCWSTR, ctypes.POINTER(DATA_BLOB),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [
        ctypes.POINTER(DATA_BLOB), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(DATA_BLOB),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB),
    ]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    return crypt32, kernel32


def _protect(data: bytes) -> bytes:
    if os.name != "nt":
        # Somente para testes locais. A distribuicao Windows sempre usa DPAPI.
        return b"plain-test:" + base64.b64encode(data)
    crypt32, kernel32 = _apis()
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(ENTROPY)
    output = DATA_BLOB()
    ok = crypt32.CryptProtectData(
        ctypes.byref(source), "SonoShow Gateway Homologacao", ctypes.byref(entropy),
        None, None, CRYPTPROTECT_UI_FORBIDDEN,
        ctypes.byref(output),
    )
    _ = (source_buffer, entropy_buffer)
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


def _unprotect(data: bytes) -> bytes:
    if data.startswith(b"plain-test:") and os.name != "nt":
        return base64.b64decode(data[len(b"plain-test:"):])
    if os.name != "nt":
        raise RuntimeError("Este arquivo de segredos exige Windows DPAPI")
    crypt32, kernel32 = _apis()
    source, source_buffer = _blob(data)
    entropy, entropy_buffer = _blob(ENTROPY)
    output = DATA_BLOB()
    description = wintypes.LPWSTR()
    ok = crypt32.CryptUnprotectData(
        ctypes.byref(source), ctypes.byref(description), ctypes.byref(entropy),
        None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output),
    )
    _ = (source_buffer, entropy_buffer)
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.pbData, output.cbData)
    finally:
        if description:
            kernel32.LocalFree(ctypes.cast(description, ctypes.c_void_p))
        kernel32.LocalFree(ctypes.cast(output.pbData, ctypes.c_void_p))


class SecretsStore:
    def __init__(self, path: Path):
        self.path = path

    def save(self, values: dict[str, str]) -> None:
        clean = {key: value for key, value in values.items() if value}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(self.path.suffix + ".tmp")
        temporary.write_bytes(_protect(json.dumps(clean, separators=(",", ":")).encode("utf-8")))
        os.replace(temporary, self.path)

    def load(self) -> dict[str, str]:
        if not self.path.is_file():
            return {}
        return json.loads(_unprotect(self.path.read_bytes()).decode("utf-8"))

