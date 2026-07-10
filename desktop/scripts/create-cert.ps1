# Creates a self-signed CODE-SIGNING certificate for The Jump Vault (thejumpvault.com)
# and exports a password-protected PFX used to digitally sign the desktop app.
#
# Run from the desktop/ folder in PowerShell:
#   ./scripts/create-cert.ps1
#
# Then build a signed installer:
#   $env:CSC_LINK = "certs/thejumpvault.pfx"
#   $env:CSC_KEY_PASSWORD = "<the password you chose>"
#   npm run build
#
# NOTE: A self-signed certificate proves integrity + publisher identity but is NOT trusted by
# Windows SmartScreen by default (users still see an "unknown publisher" prompt unless the public
# .cer is imported into Trusted Publishers/Root on the target machine). For public distribution
# without warnings you'd need a cert from a trusted CA (DigiCert, Sectigo, etc.).

$ErrorActionPreference = 'Stop'

$certsDir = Join-Path $PSScriptRoot '..\certs'
New-Item -ItemType Directory -Force -Path $certsDir | Out-Null

$subject = 'CN=The Jump Vault, O=The Jump Vault'
Write-Host "Creating self-signed code-signing certificate for: $subject"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -FriendlyName 'The Jump Vault Code Signing' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(5)

Write-Host "Created certificate. Thumbprint: $($cert.Thumbprint)"

$securePwd = Read-Host -AsSecureString 'Enter a password to protect the PFX'

$pfxPath = Join-Path $certsDir 'thejumpvault.pfx'
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfxPath -Password $securePwd | Out-Null

$cerPath = Join-Path $certsDir 'thejumpvault.cer'
Export-Certificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $cerPath | Out-Null

Write-Host ''
Write-Host "  PFX (sign with this) -> $pfxPath"
Write-Host "  CER (public cert)    -> $cerPath"
Write-Host ''
Write-Host 'To build a signed installer:'
Write-Host '  $env:CSC_LINK = "certs/thejumpvault.pfx"'
Write-Host '  $env:CSC_KEY_PASSWORD = "<your password>"'
Write-Host '  npm run build'
Write-Host ''
Write-Host 'To trust the signature on a test machine (as Administrator):'
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\Root"
