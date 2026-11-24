$ErrorActionPreference = "Stop"
Unregister-ScheduledTask -TaskName "SonoShowGateway-Homologacao" -Confirm:$false -ErrorAction SilentlyContinue

