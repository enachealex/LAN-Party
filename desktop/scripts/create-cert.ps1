# Creates a self-signed CODE-SIGNING certificate for Jump Vault LLC and exports a
# password-protected PFX used to digitally sign the desktop app.
#
# Run from the desktop/ folder in PowerShell:
#   ./scripts/create-cert.ps1
#
# Then build a signed installer:
#   $env:CSC_LINK = "certs/jumpvaultllc.pfx"
#   $env:CSC_KEY_PASSWORD = "<the password you chose>"
#   npm run build
#
# NOTE: A self-signed certificate makes the app show "Publisher: Jump Vault LLC" ONLY on machines
# where its public .cer has been imported into Trusted Root + Trusted Publishers. On every other
# machine the signature does not chain to a trusted root, so SmartScreen still says "Unknown
# publisher." To show "Jump Vault LLC" (and drop the warning) for EVERYONE, you need a code-signing
# certificate issued to Jump Vault LLC by a trusted CA (DigiCert, Sectigo, SSL.com, etc.).

$ErrorActionPreference = 'Stop'

$certsDir = Join-Path $PSScriptRoot '..\certs'
New-Item -ItemType Directory -Force -Path $certsDir | Out-Null

$subject = 'CN=Jump Vault LLC, O=Jump Vault LLC'
Write-Host "Creating self-signed code-signing certificate for: $subject"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -FriendlyName 'Jump Vault LLC Code Signing' `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyUsage DigitalSignature `
  -KeyExportPolicy Exportable `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(5)

Write-Host "Created certificate. Thumbprint: $($cert.Thumbprint)"

$securePwd = Read-Host -AsSecureString 'Enter a password to protect the PFX'

$pfxPath = Join-Path $certsDir 'jumpvaultllc.pfx'
Export-PfxCertificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $pfxPath -Password $securePwd | Out-Null

$cerPath = Join-Path $certsDir 'jumpvaultllc.cer'
Export-Certificate -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" -FilePath $cerPath | Out-Null

Write-Host ''
Write-Host "  PFX (sign with this) -> $pfxPath"
Write-Host "  CER (public cert)    -> $cerPath"
Write-Host ''
Write-Host 'To build a signed installer:'
Write-Host '  $env:CSC_LINK = "certs/jumpvaultllc.pfx"'
Write-Host '  $env:CSC_KEY_PASSWORD = "<your password>"'
Write-Host '  npm run build'
Write-Host ''
Write-Host 'To trust the signature on a test machine (as Administrator):'
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\TrustedPublisher"
Write-Host "  Import-Certificate -FilePath '$cerPath' -CertStoreLocation Cert:\LocalMachine\Root"
