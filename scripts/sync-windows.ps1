param([switch]$Check)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = (Get-Command node -ErrorAction Stop).Source
Push-Location -LiteralPath $projectRoot
try {
    $syncArguments = @('--env-file=.env', 'scripts/sync-windows.js')
    if ($Check) { $syncArguments += '--check' }
    & $nodeCommand @syncArguments
    $syncExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
exit $syncExitCode
