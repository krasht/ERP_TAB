<#
    Релиз userscript'а: поднять версию, обновить .meta.js, закоммитить и запушить.

    Зачем скрипт, а не правка руками: версия живёт в трёх местах —
      * @version в шапке (.user.js)  — по нему Tampermonkey решает, обновляться ли;
      * @version в .meta.js          — то же самое, но в файле для быстрой проверки;
      * const SELF_VERSION в коде   — по нему скрипт сравнивает себя с сервером.
    Если поднять только одно, автообновление молча перестаёт работать:
    Tampermonkey видит «та же версия» и ничего не скачивает.

    Использование:
        .\release.ps1                 # 0.71.1 -> 0.71.2, коммит и push
        .\release.ps1 -Version 0.72.0 # явная версия
        .\release.ps1 -NoPush         # только локально, без отправки на GitHub

    После push файлы доступны по адресам из шапки скрипта, и Tampermonkey
    подхватывает новую версию сам (опрос раз в сутки + баннер в открытой вкладке).
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$NoPush
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $root 'erp-contract-tp-tab.user.js'
$metaPath = Join-Path $root 'erp-contract-tp-tab.meta.js'

if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Не найден $scriptPath"
}

# UTF8 без BOM: с BOM Tampermonkey может не распознать первую строку шапки
# «// ==UserScript==» и отказаться ставить скрипт.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$text = [System.IO.File]::ReadAllText($scriptPath, $utf8)

$headerMatch = [regex]::Match($text, '(?m)^//\s*@version\s+(\S+)\s*$')
if (-not $headerMatch.Success) { throw 'В шапке нет @version' }
$current = $headerMatch.Groups[1].Value

if (-not $Version) {
    # 0.71.1 -> 0.71.2; хвост без числа (0.71.1-beta) отбрасываем
    $parts = $current -split '\.'
    while ($parts.Count -lt 3) { $parts += '0' }
    $parts[2] = [string]([int]($parts[2] -replace '\D', '') + 1)
    $Version = ($parts[0..2] -join '.')
}

if ($Version -eq $current) { throw "Версия уже $Version — нужна другая" }

Write-Host "Версия: $current -> $Version"

# 1) Шапка .user.js
$text = [regex]::Replace($text, '(?m)^(//\s*@version\s+)\S+\s*$', "`${1}$Version", 1)

# 2) const SELF_VERSION в коде — иначе проверка обновлений сравнивает не с тем
$selfPattern = "const SELF_VERSION = '[^']*';"
if ($text -notmatch $selfPattern) { throw 'В коде нет const SELF_VERSION' }
$text = [regex]::Replace($text, $selfPattern, "const SELF_VERSION = '$Version';")

[System.IO.File]::WriteAllText($scriptPath, $text, $utf8)

# 3) .meta.js — только шапка, её и скачивает Tampermonkey для проверки версии
$lines = $text -split "`r?`n"
$end = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '==/UserScript==') { $end = $i; break }
}
if ($end -lt 0) { throw 'Не найден конец шапки ==/UserScript==' }

$meta = (($lines[0..$end]) -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText($metaPath, $meta, $utf8)

Write-Host "Обновлено: $scriptPath"
Write-Host "Обновлено: $metaPath"

if ($NoPush) {
    Write-Host ''
    Write-Host 'Готово локально (-NoPush). Отправьте на GitHub вручную, иначе'
    Write-Host 'автообновление у сотрудников не увидит новую версию.'
    return
}

# 4) Коммит и push. Без push правки остаются только на этой машине:
#    raw-ссылка продолжает отдавать старую версию, и обновления не приходят.
$git = Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe'
if (-not (Test-Path -LiteralPath $git)) {
    $git = (Get-Command git -ErrorAction SilentlyContinue).Source
}
if (-not $git) { throw 'git не найден. Установите git или используйте -NoPush' }

Push-Location $root
try {
    & $git add -- erp-contract-tp-tab.user.js erp-contract-tp-tab.meta.js
    & $git -c user.name="Vladimir Chugunov" -c user.email="krasht@users.noreply.github.com" `
        commit -m "release v$Version" --quiet
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось создать коммит' }

    & $git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось отправить на GitHub' }
} finally {
    Pop-Location
}

Write-Host ''
Write-Host "Готово: версия $Version на GitHub."
Write-Host 'Tampermonkey подхватит её сам, а открытая вкладка ERP покажет'
Write-Host 'баннер «Доступна новая версия» в течение 3 секунд после загрузки.'
Write-Host ''
Write-Host 'Проверка raw-файлов (должно быть HTTP 200 и новая версия):'
Write-Host '  https://raw.githubusercontent.com/krasht/ERP_TAB/main/erp-contract-tp-tab.meta.js'
