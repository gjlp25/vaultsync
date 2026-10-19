# Windows 11 setup for vaultsync: installs prerequisites, clones your vaults,
# writes .env and registers a hidden login task.
# Run in a normal (non-admin) PowerShell window as the user who will use Obsidian.
#
# Example:
#   .\setup-obsidian-vaultsync-windows.ps1 `
#     -VaultRepos 'https://github.com/you/vault-work.git','https://github.com/you/vault-personal.git' `
#     -GitName 'Your Name' -GitEmail 'you@example.com'

[CmdletBinding()]
param(
    # GitHub URLs of the vault repos. Each is cloned to <VaultRoot>\<repo name>.
    [Parameter(Mandatory = $true)]
    [string[]]$VaultRepos,

    # Author for commits made in the vaults. Defaults to your global git config.
    [string]$GitName,
    [string]$GitEmail,

    # Where vaultsync itself comes from. Defaults to the origin of the clone this script is in.
    [string]$ToolRepo,

    [string]$VaultRoot = (Join-Path $env:USERPROFILE 'Vaults'),
    [string]$ToolDir = (Join-Path $env:LOCALAPPDATA 'vaultsync'),
    [string]$TaskName = 'vaultsync'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Vaults = @($VaultRepos | ForEach-Object {
    $name = ($_.TrimEnd('/') -split '/')[-1] -replace '\.git$', ''
    if (-not $name) { throw "Cannot derive a vault name from '$_'." }
    @{ Name = $name; Repo = $_ }
})

function Step([string]$Message) {
    Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Refresh-Path {
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machinePath;$userPath"
}

function Require-Success([string]$Description) {
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed (exit code $LASTEXITCODE)."
    }
}

function Write-Utf8NoBom([string]$Path, [string]$Content) {
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

Step 'Checking Windows Package Manager'
$winget = Get-Command winget.exe -ErrorAction SilentlyContinue
if (-not $winget) {
    throw 'winget is missing. Install or update Microsoft App Installer, then run this script again.'
}

Step 'Installing/updating prerequisites'
$packages = @(
    @{ Id = 'Git.Git'; Label = 'Git for Windows' },
    @{ Id = 'OpenJS.NodeJS.LTS'; Label = 'Node.js LTS' },
    @{ Id = 'Obsidian.Obsidian'; Label = 'Obsidian' }
)
foreach ($package in $packages) {
    Write-Host "Checking $($package.Label)..."
    & $winget.Source install --id $package.Id -e --accept-source-agreements --accept-package-agreements --silent
    if ($LASTEXITCODE -notin @(0, -1978335189)) {
        throw "Installation of $($package.Label) failed (exit code $LASTEXITCODE)."
    }
}
Refresh-Path

$git = (Get-Command git.exe -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source

$nodeVersionText = (& $node --version).Trim().TrimStart('v')
Require-Success 'Reading the Node.js version'
$nodeVersion = [version]$nodeVersionText
if ($nodeVersion -lt [version]'20.12.0') {
    throw "Node.js 20.12 or newer is required; found $nodeVersionText."
}
Write-Host "Git:  $(& $git --version)"
Write-Host "Node: v$nodeVersionText"

if (-not $ToolRepo) {
    if (Test-Path (Join-Path $PSScriptRoot '.git')) {
        $ToolRepo = (& $git -C $PSScriptRoot remote get-url origin).Trim()
        Require-Success 'Reading the vaultsync origin'
    }
    else {
        throw 'Pass -ToolRepo <vaultsync git URL>, or run this script from inside a vaultsync clone.'
    }
}
if (-not $GitName)  { $GitName  = (& $git config --global user.name)  | Out-String }
if (-not $GitEmail) { $GitEmail = (& $git config --global user.email) | Out-String }
$GitName = $GitName.Trim()
$GitEmail = $GitEmail.Trim()
if (-not $GitName -or -not $GitEmail) {
    throw 'Pass -GitName and -GitEmail, or set git config --global user.name / user.email first.'
}

Step 'Installing vaultsync'
$toolParent = Split-Path -Parent $ToolDir
New-Item -ItemType Directory -Path $toolParent -Force | Out-Null
if (Test-Path (Join-Path $ToolDir '.git')) {
    & $git -C $ToolDir pull --ff-only
    Require-Success 'Updating vaultsync'
}
elseif (Test-Path $ToolDir) {
    if ((Get-ChildItem -LiteralPath $ToolDir -Force | Select-Object -First 1)) {
        throw "$ToolDir already exists and is not a vaultsync Git clone. Move or remove it, then rerun."
    }
    Remove-Item -LiteralPath $ToolDir -Force
    & $git clone $ToolRepo $ToolDir
    Require-Success 'Cloning vaultsync'
}
else {
    & $git clone $ToolRepo $ToolDir
    Require-Success 'Cloning vaultsync'
}

Push-Location $ToolDir
try {
    & $npm ci --omit=dev
    Require-Success 'Installing vaultsync dependencies'
}
finally {
    Pop-Location
}

Step 'Cloning the Obsidian vaults'
New-Item -ItemType Directory -Path $VaultRoot -Force | Out-Null
$vaultPaths = @()
foreach ($vault in $Vaults) {
    $destination = Join-Path $VaultRoot $vault.Name
    $vaultPaths += $destination

    if (Test-Path (Join-Path $destination '.git')) {
        $actualRemote = (& $git -C $destination remote get-url origin).Trim()
        Require-Success "Reading origin for $($vault.Name)"
        if ($actualRemote -ne $vault.Repo) {
            throw "$destination points to '$actualRemote', expected '$($vault.Repo)'."
        }
        Write-Host "$($vault.Name): existing clone retained."
    }
    elseif (Test-Path $destination) {
        if ((Get-ChildItem -LiteralPath $destination -Force | Select-Object -First 1)) {
            throw "$destination already exists and is not an empty Git clone. Move it aside, then rerun."
        }
        Remove-Item -LiteralPath $destination -Force
        & $git clone -c core.autocrlf=false $vault.Repo $destination
        Require-Success "Cloning $($vault.Name)"
    }
    else {
        # Git Credential Manager will open GitHub sign-in if no login is saved yet.
        & $git clone -c core.autocrlf=false $vault.Repo $destination
        Require-Success "Cloning $($vault.Name)"
    }

    & $git -C $destination config core.autocrlf false
    Require-Success "Configuring line endings for $($vault.Name)"
    & $git -C $destination config user.name $GitName
    Require-Success "Configuring Git author name for $($vault.Name)"
    & $git -C $destination config user.email $GitEmail
    Require-Success "Configuring Git author email for $($vault.Name)"
}

Step 'Writing vaultsync configuration'
$envPaths = ($vaultPaths | ForEach-Object { $_ -replace '\\', '/' }) -join ';'
$envFile = Join-Path $ToolDir '.env'
$envContent = @"
# Generated by setup-obsidian-vaultsync-windows.ps1
# Authentication uses Git Credential Manager; no token is stored here.
VAULT_PATH=$envPaths
GITHUB_TOKEN=
DEBOUNCE_SECONDS=30
PULL_INTERVAL_SECONDS=300
"@
Write-Utf8NoBom -Path $envFile -Content $envContent

$vaultsyncScript = Join-Path $ToolDir 'bin\vaultsync.js'

Step 'Running initial configuration and sync'
& $node $vaultsyncScript init
Require-Success 'vaultsync init'
& $node $vaultsyncScript sync
Require-Success 'vaultsync sync'
& $node $vaultsyncScript status
Require-Success 'vaultsync status'

Step 'Registering the hidden login task'
$taskWrapper = Join-Path $ToolDir 'run-vaultsync.ps1'
$taskLog = Join-Path $ToolDir 'vaultsync-task.log'
$wrapperContent = @"
`$ErrorActionPreference = 'Stop'
& '$($node.Replace("'", "''"))' '$($vaultsyncScript.Replace("'", "''"))' watch *>> '$($taskLog.Replace("'", "''"))'
exit `$LASTEXITCODE
"@
Write-Utf8NoBom -Path $taskWrapper -Content $wrapperContent

$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and $existingTask.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
}

$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$taskWrapper`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keeps Obsidian vaults synchronized through GitHub.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 5

$registeredTask = Get-ScheduledTask -TaskName $TaskName
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName
if ($registeredTask.State -ne 'Running') {
    Write-Warning "The task is $($registeredTask.State), last result $($taskInfo.LastTaskResult). Check: $taskLog"
    throw 'vaultsync login task did not remain running.'
}

Step 'Completed'
Write-Host 'vaultsync is running and starts automatically when you sign in.' -ForegroundColor Green
Write-Host 'Open these folders once in Obsidian via: Open folder as vault'
$vaultPaths | ForEach-Object { Write-Host "  $_" }
Write-Host "Task: $TaskName"
Write-Host "Task log: $taskLog"
Write-Host "Status command: & '$node' '$vaultsyncScript' status"
