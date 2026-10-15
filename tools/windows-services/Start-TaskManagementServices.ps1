#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param([string]$ServiceRoot = 'D:\TaskManagement\Services')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$config = Get-Content -Raw -LiteralPath (Join-Path $ServiceRoot 'installation.json') | ConvertFrom-Json
$serviceIds = @('TMOfficeWeb', 'TMMiniApp', 'TMWorkers', 'TMNgrok')
foreach ($id in $serviceIds) {
    if ((Get-Service $id).Status -ne 'Stopped') { throw "$id is not stopped. Use the README for routine restarts." }
}
if (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in @(8000, 8001)) {
    throw 'Port 8000 or 8001 is still in use. Stop the old web/Mini App PowerShell commands with Ctrl+C first.'
}
$oldWorkers = @(Get-CimInstance Win32_Process -Filter "Name = 'python.exe' OR Name = 'pythonw.exe'" |
    Where-Object { $_.CommandLine -match '\bmanage\.py["\s]+run_workers\b' })
if ($oldWorkers.Count -gt 0) { throw 'A run_workers process is still running. Stop it before starting the single worker service.' }
if (Get-Process -Name ngrok -ErrorAction SilentlyContinue) { throw 'An ngrok process is still running. Stop the old ngrok window with Ctrl+C.' }
if ((Get-Service MSSQLSERVER).Status -ne 'Running') { throw 'MSSQLSERVER is not running.' }

function Get-HttpStatus([string]$Url) {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 5000
    $request.AllowAutoRedirect = $false
    $request.Headers.Add('ngrok-skip-browser-warning', '1')
    $response = $null
    try { $response = $request.GetResponse(); return [int]$response.StatusCode }
    catch [System.Net.WebException] {
        $response = $_.Exception.Response
        if ($null -ne $response) { return [int]$response.StatusCode }
        return 0
    } finally { if ($null -ne $response) { $response.Close() } }
}
function Wait-HttpStatus([string]$Url, [int]$Expected) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    do {
        $actual = Get-HttpStatus $Url
        if ($actual -eq $Expected) { Write-Host "PASS HTTP $Expected $Url"; return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Expected HTTP $Expected but received $actual at $Url. See $ServiceRoot\Logs."
}
function Start-One([string]$Id) {
    Write-Host "Starting $Id..."
    Start-Service -Name $Id
    (Get-Service $Id).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

$companyPath = '/c/' + $config.Company
try {
    Start-One 'TMOfficeWeb'
    Wait-HttpStatus ("http://{0}:8000/TaskManagement" -f $config.OfficeIp) 200
    Wait-HttpStatus ("http://{0}:8000{1}/" -f $config.OfficeIp, $companyPath) 404
    Start-One 'TMMiniApp'
    Wait-HttpStatus 'http://127.0.0.1:8001/TaskManagement' 404
    Wait-HttpStatus ("http://127.0.0.1:8001{0}/tg/" -f $companyPath) 200
    Wait-HttpStatus ("http://127.0.0.1:8001{0}/" -f $companyPath) 404
    Wait-HttpStatus ("http://127.0.0.1:8001{0}/api/state" -f $companyPath) 404
    # A Running wrapper does not alone prove that Django started its worker.
    $workerLog = Join-Path $ServiceRoot 'Logs\TMWorkers\TMWorkers.out.log'
    $workerOffset = 0L
    if (Test-Path -LiteralPath $workerLog) { $workerOffset = (Get-Item -LiteralPath $workerLog).Length }
    Start-One 'TMWorkers'
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    $workerReady = $false
    do {
        if (Test-Path -LiteralPath $workerLog) {
            $stream = [System.IO.File]::Open($workerLog, 'Open', 'Read', 'ReadWrite')
            try {
                if ($stream.Length -lt $workerOffset) { $workerOffset = 0L }
                $null = $stream.Seek($workerOffset, 'Begin')
                $reader = New-Object System.IO.StreamReader($stream)
                try { $workerReady = $reader.ReadToEnd().Contains('Workers running:') }
                finally { $reader.Dispose() }
            } finally { $stream.Dispose() }
        }
        if ($workerReady) { break }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $workerReady) { throw "Worker startup was not confirmed. See $ServiceRoot\Logs\TMWorkers." }
    Start-One 'TMNgrok'
    Wait-HttpStatus ($config.PublicUrl + '/TaskManagement') 404
    Wait-HttpStatus ($config.PublicUrl + $companyPath + '/tg/') 200
    Wait-HttpStatus ($config.PublicUrl + $companyPath + '/') 404
    Wait-HttpStatus ($config.PublicUrl + $companyPath + '/api/state') 404
    foreach ($id in $serviceIds) {
        if ((Get-Service $id).Status -ne 'Running') { throw "$id stopped; check its log." }
        & sc.exe config $id start= delayed-auto | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Cannot enable automatic startup for $id." }
    }
} catch {
    # Fail closed: never leave the public tunnel or a duplicate worker behind.
    foreach ($id in @('TMNgrok', 'TMWorkers', 'TMMiniApp', 'TMOfficeWeb')) {
        & sc.exe config $id start= demand | Out-Null
        Stop-Service -Name $id -ErrorAction Continue
    }
    throw
}
Get-Service -Name $serviceIds | Select-Object -Property @('Name', 'Status', 'StartType') | Format-Table -AutoSize
Write-Host 'STARTUP CHECK PASSED. All four services now use Automatic (Delayed Start).'
Write-Host 'You may close PowerShell. Do not also run the old manual commands.'
Write-Host "Logs: $ServiceRoot\Logs"
Write-Host 'Next: test a planned reboot, then finish the Telegram bot/Mini App login test.'
