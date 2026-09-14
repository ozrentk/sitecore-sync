param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('History', 'Package')]
  [string] $Mode
)

$ErrorActionPreference = 'Stop'
$scannerDirectory = Join-Path ([System.IO.Path]::GetTempPath()) 'xm-cloud-sync-gitleaks-8.30.1'
$scanner = Join-Path $scannerDirectory 'gitleaks.exe'
if (-not (Test-Path -LiteralPath $scanner)) {
  New-Item -ItemType Directory -Force -Path $scannerDirectory | Out-Null
  $archive = Join-Path $scannerDirectory 'gitleaks.zip'
  Invoke-WebRequest -Uri 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_windows_x64.zip' -OutFile $archive
  $expectedHash = 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e'
  if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) {
    throw 'Gitleaks download checksum mismatch.'
  }
  Expand-Archive -LiteralPath $archive -DestinationPath $scannerDirectory -Force
}

if ($Mode -eq 'History') {
  & $scanner git . --log-opts=--all --redact --no-banner
} else {
  $packageDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('xm-cloud-sync-package-scan-' + [guid]::NewGuid())
  [System.IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $PWD 'dist/sitecore-xm-cloud-sync.vsix'), $packageDirectory)
  & $scanner dir $packageDirectory --redact --no-banner
}
if ($LASTEXITCODE -ne 0) { throw "Secret scan failed ($Mode). Inspect the redacted findings before publishing." }
