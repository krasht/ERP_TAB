<#
    Релиз userscript'а: поднять версию, обновить .meta.js, выложить файлы.

    Зачем скрипт, а не правка руками: версия живёт в трёх местах —
      * @version в шапке (.user.js)  — по нему Tampermonkey решает, обновляться ли;
      * @version в .meta.js          — то же самое, но в файле для быстрой проверки;
      * const SELF_VERSION в коде   — по нему скрипт сравнивает себя с сервером.
    Если поднять только одно, автообновление молча перестаёт работать:
    Tampermonkey видит «та же версия» и ничего не скачивает.

    Использование:
        .\release.ps1                 # 0.71.1 -> 0.71.2
        .\release.ps1 -Version 0.72.0 # явная версия
        .\release.ps1 -DeployTo \\fileserver\web\userscript

    -DeployTo копирует оба файла в сетевую папку веб-сервера, если сайт
    раздаётся оттуда. Без него файлы просто обновляются локально.
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$DeployTo
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptPath = Join-Path $root 'erp-contract-tp-tab.user.js'
$metaPath = Join-Path $root 'erp-contract-tp-tab.meta.js'

if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Не найден $scriptPath"
}

# UTF8 без BOM: с BOM Tampermonkey считает первую строку шапки не «// ==UserScript==»
# и может отказаться ставить скрипт.
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

# 4) Выкладка на веб-сервер
if ($DeployTo) {
    if (-not (Test-Path -LiteralPath $DeployTo)) {
        throw "Папка выкладки не найдена: $DeployTo"
    }
    Copy-Item -LiteralPath $scriptPath -Destination $DeployTo -Force
    Copy-Item -LiteralPath $metaPath -Destination $DeployTo -Force
    Write-Host "Скопировано в $DeployTo"
}

Write-Host ''
Write-Host 'Дальше: у сотрудников Tampermonkey подхватит новую версию сам'
Write-Host '(опрос раз в сутки), а открытая вкладка ERP покажет баннер'
Write-Host '"Доступна новая версия" в течение 3 секунд после загрузки страницы.'
