# Automatic startup on the Windows office server

These scripts turn the already-tested office website, restricted Telegram Mini App,
background worker and ngrok tunnel into Windows services. They start without a
Windows sign-in or an open PowerShell window. This is the office HTTP / public
HTTPS pilot configuration; office HTTPS and the remaining deployment checks in
`backend/README.md` are separate work.

| Service | Purpose | Listener / upstream |
| --- | --- | --- |
| TMOfficeWeb | Office website, Waitress | 192.168.2.182:8000 |
| TMMiniApp | Restricted Mini App, Waitress | 127.0.0.1:8001 |
| TMWorkers | One `manage.py run_workers` process | No HTTP listener |
| TMNgrok | Public HTTPS tunnel | Only http://127.0.0.1:8001 |

The Python services depend on `MSSQLSERVER`. The tunnel depends on `TMMiniApp`.
WinSW restarts a failed process after 30 seconds. After the startup checks pass,
Windows uses **Automatic (Delayed Start)** for all four services.

## 1. Prepare while the manual processes still run

Open **Windows PowerShell as Administrator**, using the same Windows account that
owns this repository. The installer needs administrator access to register services
and give LocalService access to the app files.

```powershell
cd "C:\Users\user\TaskManagement-Django-Backend"
git pull --ff-only
```

Only continue if the pull succeeds. Install the pinned hosting dependency:

```powershell
& ".\backend\.venv\Scripts\python.exe" -m pip install -r .\backend\requirements-hosting.txt
```

Only continue if pip succeeds. Then prepare the services:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ".\tools\windows-services\Install-TaskManagementServices.ps1"
```

This script defaults to this deployment's IP address, ngrok domain and D: folder.
Use its `-Repository`, `-OfficeIp`, `-PublicUrl`, `-NgrokConfigSource` and
`-ServiceRoot` parameters if those locations change. It checks the existing `.env`
and SQL connection, but never changes them or runs migrations.

The installer downloads WinSW **2.12.0 NET461** from the official GitHub release
and standalone ngrok **v3 stable** from the publisher's HTTPS download service.
It copies the existing ngrok configuration locally into the protected services
folder. No token is pasted into the scripts or committed to Git.
The Microsoft Store ngrok installation remains available but is not used by these
services. Downloaded executable hashes are recorded for local inventory, not used
as an independent publisher verification.

Expected final message: **INSTALL COMPLETE**. All four services should say
**Stopped / Manual**. They are intentionally not started during installation.

## 2. Switch from the manual processes to services

During a quiet moment, press **Ctrl+C** in each of the four existing windows:
office Waitress, Mini App Waitress, `run_workers`, and ngrok. Wait for each command
to return to its PowerShell prompt. Leave SQL Server running.

In the Administrator PowerShell from step 1:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ".\tools\windows-services\Start-TaskManagementServices.ps1"
```

This refuses to start while ports 8000/8001, another `run_workers` process or ngrok
are still in use. It verifies HTTP 200 for the office and Mini App pages and HTTP
404 for the office root/API through the restricted listener and public tunnel.
It also looks for a **new** worker startup message. If a check fails, it stops the
four services and leaves them Manual; fix the logged problem and rerun this script.
It does not kill unrelated processes.

Expected final message: **STARTUP CHECK PASSED** and four **Running / Automatic**
services. You can now close PowerShell. Do not also run the four old manual commands.
The checks establish process startup and route separation, not a successful
authenticated Telegram login. Finish the bot and user login test separately.

## 3. Keep the desktop awake and test a reboot

Windows services cannot serve requests while the computer is asleep or switched
off. In Windows Settings, set sleep to **Never when plugged in**. The display may
still turn off. Equivalent Administrator commands for AC idle sleep/hibernate:

```powershell
powercfg.exe /change standby-timeout-ac 0
powercfg.exe /change hibernate-timeout-ac 0
```

Ask IT to reserve **192.168.2.182** for the server. The office service is deliberately
bound to that address. This installation does not change office routing or the
existing Windows firewall rule; Wi-Fi access still needs the outstanding IT check.

At an agreed quiet time, restart Windows normally. This desktop also hosts the
USRV database, so a reboot interrupts both systems. Wait about two minutes after
Windows boots; delayed startup may take longer if networking or SQL is still
initializing. Test the office website from another wired computer before signing
in on the server. Then inspect:

```powershell
Get-Service MSSQLSERVER,TMOfficeWeb,TMMiniApp,TMWorkers,TMNgrok |
    Select-Object Name,Status,StartType
```

All should be **Running / Automatic**. Verify the Mini App public boundary again:

```powershell
curl.exe -s -o NUL -w "%{http_code}" -H "ngrok-skip-browser-warning: 1" https://unpack-expensive-outfield.ngrok-free.dev/c/default/tg/
curl.exe -s -o NUL -w "%{http_code}" -H "ngrok-skip-browser-warning: 1" https://unpack-expensive-outfield.ngrok-free.dev/c/default/
curl.exe -s -o NUL -w "%{http_code}" -H "ngrok-skip-browser-warning: 1" https://unpack-expensive-outfield.ngrok-free.dev/c/default/api/state
```

Expected: **200, 404, 404**. Also open the Mini App from the bot in Telegram and
confirm a linked user can load their tasks. The free ngrok plan's limits and browser
warning still apply; running as a service does not remove them.

## Files, permissions and logs

Services run as **NT AUTHORITY\LocalService**, not an administrator. That account
gets read/execute access to `backend`, the built frontend directory, and the base
Python installation used by the venv. It reads the existing backend `.env`.
It can write only the service `Logs` and `Temp` subfolders within the new service
directory; administrators and SYSTEM control the service executables/configuration.
LocalService is a shared Windows identity, so other services using that identity
also have these read rights. SQL connections still use `taskmanagement_app`.

App code and its existing venv remain in the repository on C:. The venv refers to
its base Python installation; do not move/remove either directory. Service files,
logs, temporary request buffers and the copied ngrok configuration are under
`D:\TaskManagement\Services`. SQL data and backups keep their existing D: paths.

Each service has `.out.log`, `.err.log` and wrapper diagnostics in its log directory.
Process output rotates at 10 MB, keeping eight old files per output stream.
Inspect these locally before sharing an excerpt; never share `.env` or `ngrok.yml`.

```powershell
Get-Content 'D:\TaskManagement\Services\Logs\TMWorkers\TMWorkers.out.log' -Tail 30
Get-Content 'D:\TaskManagement\Services\Logs\TMMiniApp\TMMiniApp.err.log' -Tail 30
Get-Content 'D:\TaskManagement\Services\Logs\TMNgrok\TMNgrok.out.log' -Tail 30
```

## Routine restarts and updates

Restart all four after changing `.env`, deploying backend code or rebuilding the
frontend. Stop the tunnel first; stop the single worker before any migrations.
Run these commands in Administrator PowerShell, checking for errors between steps:

```powershell
Stop-Service TMNgrok
Stop-Service TMWorkers
Stop-Service TMMiniApp
Stop-Service TMOfficeWeb
```

Then deploy/build or edit the intended configuration. The ngrok service uses its
copied config at `D:\TaskManagement\Services\Config\ngrok.yml`; changes to the
old profile config do not change this copy. To start and check again:

```powershell
cd 'C:\Users\user\TaskManagement-Django-Backend'
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File '.\tools\windows-services\Start-TaskManagementServices.ps1'
```

The installation XML starts with Manual so initial registration is safe. The
startup script sets Automatic (Delayed Start) in Windows Service Control Manager
after successful checks. Do not reinstall/refresh the wrappers as a routine restart.

## Recover a failed installation or remove the services

If installation stopped midway, keep its error output and inspect the service
list. Do not rerun over existing files. First remove any of these four services
that were installed, using the commands below, then rename the old **Services**
directory to a dated name before retrying. Keep its private config/log files private.
Do not rename/delete the Database or Backups directories.

To remove this setup, stop the four services in the order above, then:

```powershell
foreach ($id in @('TMNgrok','TMWorkers','TMMiniApp','TMOfficeWeb')) {
    if (Get-Service $id -ErrorAction SilentlyContinue) {
        & "D:\TaskManagement\Services\$id.exe" uninstall
        if ($LASTEXITCODE -ne 0) { throw "Uninstall failed: $id" }
    }
}
```

This does not uninstall SQL Server, delete company data, remove Python or delete
logs. The installer-added LocalService read ACL entries remain until an
administrator removes those entries from the three directories documented above
and `backend\.env`. Keep a record of any pre-existing ACLs before changing them.

## References

- [WinSW 2.12.0 configuration](https://github.com/winsw/winsw/blob/v2.12.0/doc/xmlConfigFile.md)
- [WinSW logging](https://github.com/winsw/winsw/blob/v2.12.0/doc/loggingAndErrorReporting.md)
- [ngrok Windows download](https://ngrok.com/download/windows)
- [ngrok command-line reference](https://ngrok.com/docs/gateway/agent/cli)
- [Waitress documentation](https://docs.pylonsproject.org/projects/waitress/en/stable/)
