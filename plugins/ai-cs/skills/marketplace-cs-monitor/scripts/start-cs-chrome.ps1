param(
  [ValidateRange(1024, 65535)]
  [int]$Port = 9222,
  [switch]$CheckOnly,
  [switch]$RegisterExisting,
  [string]$ReviewUrl = 'https://pinkrocket-cs-review-mockup.kimhyein0214.chatgpt.site/',
  [string]$MarketplaceUrl = 'https://sell.smartstore.naver.com/'
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

function Assert-SafeLaunchUrl {
  param([string]$Value, [string[]]$AllowedHosts)
  try { $uri = [Uri]$Value } catch { throw 'CS_CHROME_START_URL_INVALID' }
  if ($uri.Scheme -ne 'https' -or -not ($AllowedHosts -contains $uri.Host.ToLowerInvariant())) {
    throw 'CS_CHROME_START_URL_NOT_ALLOWED'
  }
  if (-not [string]::IsNullOrWhiteSpace($uri.UserInfo)) { throw 'CS_CHROME_START_URL_CREDENTIALS_NOT_ALLOWED' }
  return $uri.AbsoluteUri
}

function Get-RegisteredEndpointId {
  if (-not (Test-Path -LiteralPath $sessionFile)) { return '' }
  try {
    $registered = Get-Content -Raw -Encoding UTF8 -LiteralPath $sessionFile | ConvertFrom-Json
    if ("$($registered.cdp_url)" -ne $cdpBase) { return '' }
    return "$($registered.browser_endpoint_id)"
  } catch {
    throw 'ACTIVE_CS_CHROME_SESSION_INVALID'
  }
}

function Open-CdpTabIfMissing {
  param([string]$Url)
  try {
    $tabs = @(Invoke-RestMethod -Uri "$cdpBase/json/list" -TimeoutSec 3)
    if ($tabs | Where-Object { "$($_.url)" -eq $Url }) { return }
    $encoded = [Uri]::EscapeDataString($Url)
    Invoke-RestMethod -Method Put -Uri "$cdpBase/json/new?$encoded" -TimeoutSec 3 | Out-Null
  } catch {
    throw 'CS_CHROME_REVIEW_TAB_OPEN_FAILED'
  }
}

$safeReviewUrl = Assert-SafeLaunchUrl -Value $ReviewUrl -AllowedHosts @('pinkrocket-cs-review-mockup.kimhyein0214.chatgpt.site')
$safeMarketplaceUrl = Assert-SafeLaunchUrl -Value $MarketplaceUrl -AllowedHosts @(
  'sell.smartstore.naver.com',
  'partners.kakaostyle.com',
  'my.a-bly.com'
)

$existing = Get-CdpIdentity -BaseUrl $cdpBase
if ($existing) {
  $registeredEndpointId = Get-RegisteredEndpointId
  if (-not $registeredEndpointId -and -not $RegisterExisting) {
    if ($CheckOnly) {
      [pscustomobject]@{ ready = $false; reused = $false; port = $Port; reason = 'UNREGISTERED_CHROME_ON_CDP_PORT' } | ConvertTo-Json -Compress
      exit 0
    }
    throw 'UNREGISTERED_CHROME_ON_CDP_PORT_USE_REGISTEREXISTING'
  }
  if ($registeredEndpointId -and $registeredEndpointId -ne $existing.endpoint_id) {
    throw 'ACTIVE_CS_CHROME_SESSION_CHANGED'
  }
  Save-ActiveSession -BrowserPid 0 -BrowserEndpointId $existing.endpoint_id
  if (-not $CheckOnly) { Open-CdpTabIfMissing -Url $safeReviewUrl }
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
  $safeMarketplaceUrl,
  $safeReviewUrl
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
