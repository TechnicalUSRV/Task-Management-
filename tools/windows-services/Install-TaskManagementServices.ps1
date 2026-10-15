#Requires -Version 5.1
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
    [string]$Repository = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$ServiceRoot = 'D:\TaskManagement\Services',
    [string]$OfficeIp = '192.168.2.182',
    [string]$PublicUrl = 'https://unpack-expensive-outfield.ngrok-free.dev',
    [string]$NgrokConfigSource = (Join-Path $env:LOCALAPPDATA 'ngrok\ngrok.yml')
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Executable failed (exit $LASTEXITCODE)." }
}
function Escape-Xml([string]$Value) {
    [System.Security.SecurityElement]::Escape($Value)
}
function Protect-Directory([string]$Path) {
    # Applied only to the new, dedicated services directory, before copying secrets.
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($entry in @(@('S-1-5-18', 'FullControl'), @('S-1-5-32-544', 'FullControl'), @('S-1-5-19', 'ReadAndExecute'))) {
        $sid = New-Object System.Security.Principal.SecurityIdentifier($entry[0])
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
            $sid, $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

if ($env:OS -ne 'Windows_NT' -or $env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
    throw 'Use 64-bit Windows PowerShell on the Windows server.'
}
$Repository = (Resolve-Path -LiteralPath $Repository).Path
$ServiceRoot = [System.IO.Path]::GetFullPath($ServiceRoot).TrimEnd('\')
foreach ($value in @($Repository, $ServiceRoot, $NgrokConfigSource)) {
    if ($value -match '[%"\r\n]') { throw 'Paths must not contain percent signs, double quotes or newlines.' }
}
if ($ServiceRoot -notmatch '^[A-Za-z]:\\.+') { throw 'ServiceRoot must be a dedicated folder on a local drive.' }
if (Test-Path -LiteralPath $ServiceRoot) {
    throw "$ServiceRoot already exists. Do not overwrite an installation; see README.md for recovery."
}
$ip = $null
if (-not [System.Net.IPAddress]::TryParse($OfficeIp, [ref]$ip) -or
    $ip.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or
    $OfficeIp -eq '0.0.0.0') { throw 'OfficeIp must be a specific IPv4 address.' }
if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $OfficeIp)) {
    throw "$OfficeIp is not assigned to this server."
}
if ($PublicUrl -notmatch '^https://[a-zA-Z0-9.-]+$') {
    throw 'PublicUrl must be the HTTPS ngrok origin, without a trailing slash or path.'
}
$volume = Get-Volume -DriveLetter $ServiceRoot.Substring(0, 1)
if ($volume.FileSystem -ne 'NTFS') { throw 'The service drive must use NTFS for file permissions.' }
$sql = Get-Service -Name MSSQLSERVER
if ($sql.Status -ne 'Running' -or $sql.StartType -ne 'Automatic') {
    throw 'MSSQLSERVER must already be Running and Automatic.'
}
$serviceIds = @('TMOfficeWeb', 'TMMiniApp', 'TMWorkers', 'TMNgrok')
foreach ($id in $serviceIds) {
    if (Get-Service -Name $id -ErrorAction SilentlyContinue) { throw "$id already exists." }
}
$backend = Join-Path $Repository 'backend'
$python = Join-Path $backend '.venv\Scripts\python.exe'
$waitress = Join-Path $backend '.venv\Scripts\waitress-serve.exe'
$frontend = Join-Path $Repository 'source\local-test\public'
foreach ($path in @($python, $waitress, $NgrokConfigSource, (Join-Path $backend '.env'),
    (Join-Path $backend 'config\mini_wsgi.py'), (Join-Path $frontend 'index.html'), (Join-Path $frontend 'tg.html'))) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Required file missing: $path" }
}
Push-Location $backend
try {
    $basePython = & $python -c 'import sys; print(sys.base_prefix)'
    if ($LASTEXITCODE -ne 0) { throw 'The Python virtual environment did not start.' }
    $basePython = ($basePython | Out-String).Trim()
    # Read only deployment values; never print the environment file or passwords.
    $checkCode = @'
import json
from config import settings as s
print(json.dumps({'debug': s.DEBUG, 'hosts': s.ALLOWED_HOSTS, 'public_url': s.PUBLIC_URL,
    'company': s.COMPANY_ID, 'frontend': str(s.FRONTEND_DIR.resolve()),
    'engine': s.DB_ENGINE, 'database': s.DATABASES['default']['NAME'],
    'db_user': s.DATABASES['default'].get('USER')}))
'@
    $settingsJson = & $python -c $checkCode
    if ($LASTEXITCODE -ne 0) { throw 'Cannot load backend settings.' }
    $settings = ($settingsJson | Out-String) | ConvertFrom-Json
    if ($settings.debug -or $settings.engine -ne 'mssql' -or
        $settings.database -ne 'TaskManagement_Production' -or $settings.db_user -ne 'taskmanagement_app') {
        throw 'Use DJANGO_DEBUG=no and the taskmanagement_app login for TaskManagement_Production.'
    }
    if ($settings.public_url -ne $PublicUrl -or
        $settings.hosts -notcontains ([uri]$PublicUrl).Host -or
        $settings.hosts -notcontains $OfficeIp -or $settings.hosts -notcontains '127.0.0.1') {
        throw 'Check PUBLIC_URL and DJANGO_ALLOWED_HOSTS in backend\.env; they must include the chosen addresses.'
    }
    if ($settings.company -notmatch '^[A-Za-z0-9_-]{1,80}$' -or $settings.frontend -ne $frontend) {
        throw 'Check COMPANY_ID and FRONTEND_DIR; this installer uses source\local-test\public.'
    }
    Invoke-Checked $python @('manage.py', 'check_database')
} finally { Pop-Location }

# No files in Database or Backups are changed. Do not copy/move the existing venv.
New-Item -ItemType Directory -Path $ServiceRoot | Out-Null
Protect-Directory $ServiceRoot
foreach ($name in @('Bin', 'Config', 'Logs', 'Temp')) {
    New-Item -ItemType Directory -Path (Join-Path $ServiceRoot $name) | Out-Null
}
foreach ($name in @('Logs', 'Temp')) {
    Invoke-Checked 'icacls.exe' @((Join-Path $ServiceRoot $name), '/grant:r', '*S-1-5-19:(OI)(CI)M')
}
# Read access for the low-privilege LocalService account, limited to this app and its Python installation.
foreach ($path in @($backend, $frontend, $basePython)) {
    Invoke-Checked 'icacls.exe' @($path, '/grant:r', '*S-1-5-19:(OI)(CI)RX')
}
Invoke-Checked 'icacls.exe' @((Join-Path $backend '.env'), '/grant:r', '*S-1-5-19:R')

$winsw = Join-Path $ServiceRoot 'Bin\WinSW.NET461.exe'
$ngrokZip = Join-Path $ServiceRoot 'Bin\ngrok.zip'
$ngrok = Join-Path $ServiceRoot 'Bin\ngrok.exe'
$ngrokConfig = Join-Path $ServiceRoot 'Config\ngrok.yml'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
Write-Host 'Downloading WinSW 2.12.0 and the standalone ngrok agent from their publishers...'
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe' -OutFile $winsw
Invoke-WebRequest -UseBasicParsing -Uri 'https://bin.ngrok.com/c/bNyj1mQVY4c/ngrok-v3-stable-windows-amd64.zip' -OutFile $ngrokZip
Expand-Archive -LiteralPath $ngrokZip -DestinationPath (Join-Path $ServiceRoot 'Bin')
if (-not (Test-Path -LiteralPath $ngrok)) { throw 'The ngrok download did not contain ngrok.exe.' }
Copy-Item -LiteralPath $NgrokConfigSource -Destination $ngrokConfig
Invoke-Checked $ngrok @('version')
# Suppress config-check details because a parser error could contain a token.
& $ngrok config check --config $ngrokConfig *> $null
if ($LASTEXITCODE -ne 0) { throw 'The copied ngrok configuration is invalid. Check it locally; do not post its contents.' }
Get-FileHash -Algorithm SHA256 -LiteralPath $winsw, $ngrok |
    Select-Object -Property @('Path', 'Hash') | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ServiceRoot 'download-hashes.json') -Encoding UTF8
Remove-Item -LiteralPath $ngrokZip

$definitions = @(
    @{ Id = 'TMOfficeWeb'; Title = 'Task Management - Office Web'; Exe = $waitress;
       Args = "--listen=${OfficeIp}:8000 config.wsgi:application"; Dependency = 'MSSQLSERVER' },
    @{ Id = 'TMMiniApp'; Title = 'Task Management - Telegram Mini App'; Exe = $waitress;
       Args = '--listen=127.0.0.1:8001 config.mini_wsgi:application'; Dependency = 'MSSQLSERVER' },
    @{ Id = 'TMWorkers'; Title = 'Task Management - Background Worker'; Exe = $python;
       Args = '-u manage.py run_workers'; Dependency = 'MSSQLSERVER' },
    @{ Id = 'TMNgrok'; Title = 'Task Management - Mini App Tunnel'; Exe = $ngrok;
       Args = ('http http://127.0.0.1:8001 --url "{0}" --config "{1}" --inspect=false --log stdout --log-format json' -f $PublicUrl, $ngrokConfig);
       Dependency = 'TMMiniApp' }
)
$installed = @()
try {
    foreach ($definition in $definitions) {
        $id = $definition.Id
        $wrapper = Join-Path $ServiceRoot "$id.exe"
        $logPath = Join-Path $ServiceRoot "Logs\$id"
        New-Item -ItemType Directory -Path $logPath | Out-Null
        Copy-Item -LiteralPath $winsw -Destination $wrapper
        $xml = @"
<service>
  <id>$id</id>
  <name>$(Escape-Xml $definition.Title)</name>
  <description>Task Management service. Logs: $(Escape-Xml $logPath)</description>
  <executable>$(Escape-Xml $definition.Exe)</executable>
  <arguments>$(Escape-Xml $definition.Args)</arguments>
  <workingdirectory>$(Escape-Xml $backend)</workingdirectory>
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Manual</startmode>
  <depend>$($definition.Dependency)</depend>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>30 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <env name="PYTHONUNBUFFERED" value="1"/>
  <env name="PYTHONUTF8" value="1"/>
  <env name="PYTHONDONTWRITEBYTECODE" value="1"/>
  <env name="TEMP" value="$(Escape-Xml (Join-Path $ServiceRoot 'Temp'))"/>
  <env name="TMP" value="$(Escape-Xml (Join-Path $ServiceRoot 'Temp'))"/>
  <logpath>$(Escape-Xml $logPath)</logpath>
  <log mode="roll-by-size"><sizeThreshold>10240</sizeThreshold><keepFiles>8</keepFiles></log>
</service>
"@
        # Parse before writing to catch any malformed XML.
        $null = [xml]$xml
        [System.IO.File]::WriteAllText((Join-Path $ServiceRoot "$id.xml"), $xml, (New-Object System.Text.UTF8Encoding($false)))
        $installed += $id
        Invoke-Checked $wrapper @('install')
    }
} catch {
    foreach ($id in $installed) {
        if (Get-Service -Name $id -ErrorAction SilentlyContinue) {
            & (Join-Path $ServiceRoot "$id.exe") uninstall
        }
    }
    throw
}
@{ Repository = $Repository; OfficeIp = $OfficeIp; PublicUrl = $PublicUrl;
   Company = $settings.company; ServiceIds = $serviceIds; BasePython = $basePython } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ServiceRoot 'installation.json') -Encoding UTF8
Get-Service -Name $serviceIds | Select-Object -Property @('Name', 'Status', 'StartType') | Format-Table -AutoSize
Write-Host 'INSTALL COMPLETE. The four services are installed but STOPPED and Manual.'
Write-Host 'Next: stop the four old PowerShell processes with Ctrl+C, then run Start-TaskManagementServices.ps1.'
