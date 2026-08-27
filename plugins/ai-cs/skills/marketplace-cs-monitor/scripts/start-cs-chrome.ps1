param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9222,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$localData = [Environment]::GetFolderPath('LocalApplicationData')
$runtimeDir = Join-Path $localData 'PinkRocketCS'
$browserDataDir = Join-Path $runtimeDir 'ChromeData'
$sessionFile = Join-Path $runtimeDir 'active-browser.json'
$cdpBase = "http://127.0.0.1:$Port"

function Get-CdpIdentity {
  param([string]$BaseUrl)
  try {
    $version = Invoke-RestMethod -Uri "$BaseUrl/json/version" -TimeoutSec 3
    $identity = "$($version.Browser) $($version.'User-Agent')"
    if ($identity -match 'Whale') { throw 'WHALE_CDP_NOT_ALLOWED' }
    if ($identity -notmatch 'Chrome') { throw 'GOOGLE_CHROME_CDP_REQUIRED' }
    $endpointId = "$($version.webSocketDebuggerUrl)" -replace '^.*/devtools/browser/', ''
    return [pscustomobject]@{ identity = $identity; endpoint_id = $endpointId }
  } catch {
    if ($_.Exception.Message -in @('WHALE_CDP_NOT_ALLOWED', 'GOOGLE_CHROME_CDP_REQUIRED')) { throw }
    return $null
  }
}

function Save-ActiveSession {
  param([int]$BrowserPid, [string]$BrowserEndpointId)
  New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
  $session = [ordered]@{
    schema_version = 1
    cdp_url = $cdpBase
    browser_family = 'chrome'
    session_label = 'local-cs-chrome'
    browser_pid = $BrowserPid
    browser_endpoint_id = $BrowserEndpointId
    registered_at = (Get-Date).ToUniversalTime().ToString('o')
  }
  $json = $session | ConvertTo-Json
  [System.IO.File]::WriteAllText($sessionFile, $json, [System.Text.UTF8Encoding]::new($false))
}

$existing = Get-CdpIdentity -BaseUrl $cdpBase
if ($existing) {
  Save-ActiveSession -BrowserPid 0 -BrowserEndpointId $existing.endpoint_id
  [pscustomobject]@{ ready = $true; reused = $true; port = $Port; action = 'Use the open CS Chrome window.' } | ConvertTo-Json -Compress
  exit 0
}

if ($CheckOnly) {
  [pscustomobject]@{ ready = $false; reused = $false; port = $Port; reason = 'ACTIVE_CS_CHROME_NOT_RUNNING' } | ConvertTo-Json -Compress
  exit 0
}

$candidates = @()
foreach ($root in @(${env:ProgramFiles}, ${env:ProgramFiles(x86)}, $localData)) {
  if (-not [string]::IsNullOrWhiteSpace($root)) {
    $candidate = Join-Path $root 'Google\Chrome\Application\chrome.exe'
    if (Test-Path -LiteralPath $candidate) { $candidates += $candidate }
  }
}

$chromePath = $candidates | Select-Object -First 1
if (-not $chromePath) { throw 'GOOGLE_CHROME_NOT_FOUND' }

New-Item -ItemType Directory -Path $browserDataDir -Force | Out-Null
$arguments = @(
  "--remote-debugging-port=$Port",
  "--user-data-dir=`"$browserDataDir`"",
  '--no-first-run',
  'https://sell.smartstore.naver.com/'
)
$process = Start-Process -FilePath $chromePath -ArgumentList $arguments -PassThru

$ready = $null
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  Start-Sleep -Milliseconds 500
  $ready = Get-CdpIdentity -BaseUrl $cdpBase
  if ($ready) { break }
}
if (-not $ready) { throw 'CS_CHROME_START_TIMEOUT' }

Save-ActiveSession -BrowserPid $process.Id -BrowserEndpointId $ready.endpoint_id
[pscustomobject]@{ ready = $true; reused = $false; port = $Port; action = 'Sign in to Smartstore in the opened CS Chrome window.' } | ConvertTo-Json -Compress
