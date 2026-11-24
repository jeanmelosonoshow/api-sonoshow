param(
    [string]$InstallDir = "C:\SonoShowGateway-Homologacao",
    [int]$IntervalMinutes = 15
)
$ErrorActionPreference = "Stop"
if ($IntervalMinutes -lt 1) { throw "IntervalMinutes deve ser positivo" }
$Exe = Join-Path $InstallDir "SonoShowGateway-Homologacao.exe"
$Config = Join-Path $InstallDir "config\homologacao.json"
if (-not (Test-Path -LiteralPath $Exe)) { throw "Executavel de homologacao nao encontrado em $Exe" }
if (-not (Test-Path -LiteralPath $Config)) { throw "Configuracao de homologacao nao encontrada em $Config" }

$Action = New-ScheduledTaskAction -Execute $Exe -Argument "--config `"$Config`" run-once" -WorkingDirectory $InstallDir
$Trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$Settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
Register-ScheduledTask -TaskName "SonoShowGateway-Homologacao" -Action $Action -Trigger $Trigger -Settings $Settings -Description "Integracoes plugaveis SonoShow - somente homologacao" -Force

