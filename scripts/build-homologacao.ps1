$ErrorActionPreference = "Stop"
$RepoDir = Split-Path -Parent $PSScriptRoot
$IntegrationDir = Join-Path $RepoDir "integrations"
$VenvDir = Join-Path $RepoDir ".venv-homologacao-build"
Set-Location $RepoDir

if (-not (Test-Path "$VenvDir\Scripts\python.exe")) {
    py -3.12 -m venv $VenvDir
}
& "$VenvDir\Scripts\python.exe" -m pip install --upgrade pip
& "$VenvDir\Scripts\python.exe" -m pip install -r "$IntegrationDir\requirements-homologacao.txt" "pyinstaller==6.16.0"
& "$VenvDir\Scripts\pyinstaller.exe" --noconfirm --clean --distpath "$RepoDir\dist\homologacao" --workpath "$RepoDir\work\pyinstaller-homologacao" "$IntegrationDir\SonoShowGateway-Homologacao.spec"

$Package = Join-Path $RepoDir "dist\homologacao\SonoShowGateway-Homologacao"
New-Item -ItemType Directory -Force -Path "$Package\config" | Out-Null
Copy-Item "$RepoDir\dist\homologacao\SonoShowGateway-Homologacao.exe" "$Package\SonoShowGateway-Homologacao.exe" -Force
Copy-Item "$RepoDir\config\homologacao.example.json" "$Package\config\homologacao.json" -Force
Copy-Item "$RepoDir\config\flit-firebird.mapping.example.json" "$Package\config\flit-firebird.mapping.json" -Force
Copy-Item "$RepoDir\sql\homologacao-idempotencia.sql" $Package -Force
Copy-Item "$RepoDir\docs\HOMOLOGACAO-FLIT-FIREBIRD.md" $Package -Force
Copy-Item "$RepoDir\scripts\install-homologacao-task.ps1" $Package -Force
Copy-Item "$RepoDir\scripts\uninstall-homologacao-task.ps1" $Package -Force
Write-Host "Homologacao criada em $Package"

