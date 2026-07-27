# Allow inbound TCP to the PMS dev servers on private networks (run as Administrator).
# Usage (PowerShell as Admin):  npm run dev:firewall
# Or:  powershell -ExecutionPolicy Bypass -File scripts/windows-firewall-dev.ps1

$ErrorActionPreference = "Stop"

$ports = @(3001, 4000)
$profiles = @("Private", "Domain")

foreach ($port in $ports) {
  $name = "LEGPHEL PMS Dev (TCP $port)"
  $existing = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $name
  }
  New-NetFirewallRule `
    -DisplayName $name `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort $port `
    -Action Allow `
    -Profile $profiles | Out-Null
  Write-Host "Added: $name (Inbound TCP $port, profiles: $($profiles -join ', '))"
}

Write-Host ""
Write-Host "Done. Restart dev:lan on this PC, then boss opens http://<your-LAN-IP>:3001"
Write-Host "If still blocked: router may use client isolation (guest Wi-Fi)."
