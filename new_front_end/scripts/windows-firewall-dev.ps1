# Allow inbound TCP to the PMS dev servers on private networks (run as Administrator).
# Usage (PowerShell as Admin):  npm run dev:firewall
# Or:  powershell -ExecutionPolicy Bypass -File scripts/windows-firewall-dev.ps1

$ErrorActionPreference = "Stop"

# 3002 is the redesigned desk (new_front_end); 3001 the old one; 4000 the API.
$ports = @(3001, 3002, 4000)
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
Write-Host "Done. Restart dev:lan on this PC, then boss opens http://<your-LAN-IP>:3002"
Write-Host "If still blocked: the network may be marked Public (Settings > Network > Wi-Fi > Private), or the router uses client isolation (guest Wi-Fi)."
