# -*- mode: python ; coding: utf-8 -*-
import os
from pathlib import Path

project_dir = Path(SPECPATH)
repo_dir = project_dir.parent
client_dir = Path(os.environ.get("FIREBIRD_CLIENT_DIR", r"C:\Program Files\Firebird\Firebird_3_0"))
if not (client_dir / "fbclient.dll").is_file():
    raise RuntimeError("Cliente Firebird 3 x64 nao encontrado; defina FIREBIRD_CLIENT_DIR")

binary_names = (
    "fbclient.dll", "ib_util.dll", "icudt52.dll", "icuin52.dll", "icuuc52.dll",
    "msvcp100.dll", "msvcr100.dll", "zlib1.dll",
)
data_names = ("firebird.msg", "icudt52l.dat")
client_binaries = [(str(client_dir / name), "firebird_client") for name in binary_names if (client_dir / name).is_file()]
client_data = [(str(client_dir / name), "firebird_client") for name in data_names if (client_dir / name).is_file()]

a = Analysis(
    [str(project_dir / "homologacao_main.py")],
    pathex=[str(project_dir)],
    binaries=client_binaries,
    datas=client_data,
    hiddenimports=["firebird.driver", "firebird.driver.fbapi", "certifi"],
    excludes=[], noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas, [],
    name="SonoShowGateway-Homologacao", debug=False, strip=False, upx=True,
    console=True, disable_windowed_traceback=False,
)

