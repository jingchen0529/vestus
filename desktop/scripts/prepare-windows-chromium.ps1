$ErrorActionPreference = "Stop"

$playwrightVersion = "1.62.1"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$browserCache = Join-Path $repositoryRoot ".cache\ms-playwright"
$destination = Join-Path $repositoryRoot "src-tauri\resources\chromium"

$env:PLAYWRIGHT_BROWSERS_PATH = $browserCache
& npx.cmd --yes "playwright@$playwrightVersion" install chromium
if ($LASTEXITCODE -ne 0) {
    throw "Playwright Chromium 下载失败"
}

$chrome = Get-ChildItem -Path $browserCache -Recurse -File -Filter "chrome.exe" |
    Where-Object { $_.FullName -match "[\\/]chromium-[^\\/]+[\\/](chrome-win|chrome-win64)[\\/]chrome\.exe$" } |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

if (-not $chrome) {
    throw "下载目录中未找到完整的 Windows Chromium"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -Path (Join-Path $chrome.Directory.FullName "*") -Destination $destination -Recurse -Force

if (-not (Test-Path (Join-Path $destination "chrome.exe") -PathType Leaf)) {
    throw "Windows Chromium 资源准备失败"
}
