# vaultsync

Keeps your Obsidian vaults in sync between computers, phones and a NAS, using a private GitHub repo
instead of Obsidian Sync. Your notes stay plain Markdown files in a normal folder.

> [!WARNING]
> **Use at your own risk.** This is a personal project, shared as is, without any warranty. Read
> the code and scripts yourself and make sure you understand what they do before you run them:
> they install software, change git settings, register background tasks and commit and push your
> notes. Make a backup of your vaults first. I accept no responsibility for any data loss, damage
> or other results on your systems. See [LICENSE](LICENSE) (MIT).

## How it fits together

Every vault is one private GitHub repo. Every device keeps its own copy of that repo (a git
"clone"), and GitHub sits in the middle:

```
                         ┌──────────────────────┐
                         │  GitHub (private)    │
                         │  one repo per vault  │
                         └──────────▲───────────┘
                                    │  push / pull
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
┌───────┴────────┐         ┌────────┴─────────┐        ┌────────┴────────┐
│ Desktop / Mac  │         │ Docker server    │        │ Phone           │
│ vaultsync      │         │ vaultsync        │        │ Obsidian Git    │
│ (background)   │         │ container        │        │ plugin          │
│ local clone    │         │ → NAS folders    │        │ local clone     │
└────────────────┘         │   (NFS), maybe   │        └─────────────────┘
                           │   used by apps   │
                           └──────────────────┘
```

On a computer or server, vaultsync runs in the background and does this for each vault:

1. **You change a file.** vaultsync waits until nothing has changed for 30 seconds (so it doesn't
   commit half a sentence), then saves a snapshot (a git commit) and uploads it to GitHub.
2. **Every 5 minutes** it also downloads changes from the other devices, and uploads anything it
   missed.
3. **Two devices changed the same note** before syncing? Nothing is lost. The version on this
   device stays as `note.md`. The other version is saved next to it as
   `note.conflict-2026-10-13.md`. You merge them by hand and delete the conflict file.

Phones can't run vaultsync. They use the Obsidian Git plugin, which does roughly the same thing.

The full history of every note is in git: `git log -p -- "path/to/note.md"`.

## Important rules

- **One sync tool per folder.** Never point two sync mechanisms at the same folder: not two
  vaultsync instances, not vaultsync plus iCloud/Obsidian Sync, and not desktop Obsidian opening
  the NAS share directly. They overwrite each other's work.
- **Each device has its own copy.** Desktops and phones work on a local clone. Only the NAS copy
  lives on the NAS, and only the Docker container (and apps on that server) touch it.
- **Don't let other tools run git in a vault.** Other apps (for example an AI agent) may read and
  write notes, but only vaultsync runs git there.

## Setup overview

Do these in order. Step 2 publishes each vault to GitHub. Every other device clones it from there.

1. [Create a GitHub token](#1-create-a-github-token)
2. [NAS: run the Docker container](#2-nas-run-the-docker-container) (your vaults already live here)
3. [Desktop: switch to a local clone](#3-desktop-switch-to-a-local-clone)
4. [Phone: Obsidian Git plugin](#4-phone-obsidian-git-plugin)

Before you start, turn off Obsidian Sync on all devices (**Settings → Core plugins → Sync**) once it
has finished syncing.

### 1. Create a GitHub token

1. On GitHub, create one **empty private** repo per vault, for example `you/vault-work`,
   `you/vault-personal`. Don't add a README or license; the repo must be empty. (Repo already has
   notes and history? See [Repo already has history](#repo-already-has-history).)
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens):
   - *Repository access:* only the vault repos.
   - *Permissions:* **Contents → Read and write**. Nothing else.
3. Keep the token somewhere safe (a password manager). You'll paste it on each device.

### 2. NAS: run the Docker container

One container syncs all vaults. It mounts the NAS folders, which other apps on the server may also
use. Those apps just read and write notes; the container commits and pushes them.

**a. Configure.** On the Docker server, in this folder:

```sh
cp compose.example.yml compose.yml
```

Edit `compose.yml`. The comments in it explain each line. You need to set:

- `volumes`: one line per vault, `<folder on the docker server>:/vaults/<Name>`.
- `VAULT_PATH`: the same `/vaults/<Name>` paths, separated by `:`.
- `user`: who owns the vault files on the NAS. Find it with `ls -ln /mnt/nas/obsidian` on the
  Docker server: the two numbers after the permissions are the uid and gid (for example `1000 1000`).

Put the token in a file called `.env` next to `compose.yml` (Docker Compose reads it automatically):

```sh
GITHUB_TOKEN=github_pat_...
```

Then `chmod 600 .env`. If Docker Compose runs as a different user than the file's owner, use
`640` with a group that user is in; with `600` Compose can't read it.

**b. First sync.** Stop any other apps that write to the vaults first, so nothing changes during the first upload. Make a backup of
each vault folder first, for example `tar -cf vault-work-backup.tar -C /mnt/nas/obsidian Work`.

```sh
docker compose build                       # build the image
docker compose run --rm vaultsync init     # turn every vault folder into a git repo

# connect each vault to its GitHub repo (repeat per vault):
docker compose run --rm --entrypoint git vaultsync -C /vaults/Work remote add origin https://github.com/you/vault-work.git

docker compose run --rm vaultsync sync     # first upload of all vaults
```

Check GitHub: each repo should now contain your notes.

**c. Start it.**

```sh
docker compose up -d                       # runs in the background, restarts automatically
```

Start those apps again. To check that everything works:

```sh
docker compose logs -f vaultsync           # live log, each line starts with [VaultName]
docker compose exec vaultsync node /app/bin/vaultsync.js status
```

Good to know:

- vaultsync notices changes from apps on the same Docker server within seconds.
  Changes made from elsewhere (for example directly on the NAS) are picked up by the 5-minute round.
- **Adding a vault later:** add it to `volumes` and `VAULT_PATH`. Run `init`, `remote add` and
  `sync` for only the new vault by overriding `VAULT_PATH`, so the running vaults aren't touched:

  ```sh
  docker compose run --rm -e VAULT_PATH=/vaults/New vaultsync init
  docker compose run --rm --entrypoint git vaultsync -C /vaults/New remote add origin https://github.com/you/vault-new.git
  docker compose run --rm -e VAULT_PATH=/vaults/New vaultsync sync
  docker compose up -d                       # recreate the container with both vaults
  ```

  The logs should then show a `watching` line for every vault.

#### Repo already has history

If the GitHub repo already contains (older) notes, don't clone over the NAS folder and don't
run `sync` straight away: the two histories have nothing in common. Instead, after `init` and
`remote add`, put the NAS folder on top of the GitHub history *without* touching the files:

```sh
docker compose run --rm --entrypoint git vaultsync -C /vaults/Work fetch origin
docker compose run --rm --entrypoint git vaultsync -C /vaults/Work reset origin/main   # files stay as they are
docker compose run --rm vaultsync sync
```

The first sync then commits the current NAS state as one new commit. The older GitHub content
is still in the history (`git log`), so nothing is lost. This only works before the vault has
any commits of its own, so right after `init`.

### 3. Desktop: switch to a local clone

Stop opening the NAS folder in Obsidian. Instead, each desktop gets its own copy.

On Windows 11 you can skip steps a–c and e: see [Windows: setup script](#windows-setup-script).

**a. Install vaultsync** (once per computer). Requires [Node.js](https://nodejs.org) 20.12 or newer
and git.

```sh
cd path/to/vaultsync      # this folder
npm install
cp .env.example .env
```

Tell git who you are (used in commit messages):

```sh
git config --global user.name  "Your Name"
git config --global user.email "you@example.com"
```

**b. Clone each vault.** Use a folder outside `~/Documents`, `~/Desktop` and iCloud (see
[macOS notes](#macos)).

```sh
git clone -c core.autocrlf=false https://github.com/you/vault-work.git ~/Vaults/Work
```

`-c core.autocrlf=false` stops Windows from changing line endings. Without it every note looks
"changed" on every machine. When git asks for a password, paste the token.

**c. Configure.** Edit `.env` in this folder:

```sh
VAULT_PATH=/Users/you/Vaults/Work:/Users/you/Vaults/Personal
GITHUB_TOKEN=github_pat_...
```

Use full paths: `$HOME` and `~` are not expanded in `.env`. Run `chmod 600 .env` so only you can
read the token. Changed `.env` later? Restart the background service (see [Run at login](#run-at-login)).

Then run once:

```sh
node bin/vaultsync.js init     # sets a few git options for every vault
node bin/vaultsync.js sync     # confirms that upload works
node bin/vaultsync.js status   # should show ahead 0, behind 0, conflicts none
```

`last push: never` right after cloning is normal: there was nothing new to upload yet.

**d. Open in Obsidian:** **Open folder as vault** → `~/Vaults/Work`, and so on.

**e. Run vaultsync in the background.** See [Run at login](#run-at-login).

Have notes that exist only on this desktop? Copy them into the clone. vaultsync uploads them.

#### Windows: setup script

`setup-obsidian-vaultsync-windows.ps1` does steps a–c and e in one go on Windows 11:

- installs or updates Git, Node.js LTS and Obsidian with `winget` (already installed some other
  way? winget then usually reports it as installed and skips it; if not, it may install a second
  copy, so check the script first);
- clones vaultsync to `%LOCALAPPDATA%\vaultsync` and runs `npm ci`;
- clones each vault to `%USERPROFILE%\Vaults\<repo name>` with `core.autocrlf=false`, and sets
  the commit author per vault;
- writes `.env` (no token: it uses Git Credential Manager, which opens a GitHub sign-in the first
  time), then runs `init`, `sync` and `status`;
- registers a hidden scheduled task `vaultsync` that runs `watch` at login and restarts it if it
  crashes.

**Read the script before you run it.** It installs software, changes git settings and registers
a scheduled task on your machine, and is used at your own risk (see the warning at the top).

Run it in a normal (not admin) PowerShell window, from a clone of this repo:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup-obsidian-vaultsync-windows.ps1 `
  -VaultRepos 'https://github.com/you/vault-work.git','https://github.com/you/vault-personal.git' `
  -GitName 'Your Name' -GitEmail 'you@example.com'
```

| Parameter     | Meaning                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------- |
| `-VaultRepos` | Required. GitHub URLs of the vault repos. The folder name is the repo name.             |
| `-GitName`, `-GitEmail` | Commit author in the vaults. Default: your global `git config user.name/email`. |
| `-ToolRepo`   | Where to clone vaultsync from. Default: the `origin` of the clone the script is in.     |
| `-VaultRoot`  | Default `%USERPROFILE%\Vaults`.                                                          |
| `-ToolDir`    | Default `%LOCALAPPDATA%\vaultsync`.                                                      |
| `-TaskName`   | Default `vaultsync`.                                                                     |

The script is safe to run again: it updates vaultsync, keeps existing vault clones (it stops if a
clone points to a different repo, or if a target folder exists and isn't a clone), and replaces
the task. The task logs to `%LOCALAPPDATA%\vaultsync\vaultsync-task.log`. Afterwards, open each
folder in Obsidian with **Open folder as vault** (step d).

### 4. Phone: Obsidian Git plugin

The phone gets its own copy too, and only talks to GitHub.

1. In Obsidian, create an empty vault. On iOS, store it **On My iPhone**, not in iCloud.
2. **Settings → Community plugins**: install and enable **Git**.
3. In the Git plugin settings, under authentication: your GitHub username, and the token as the
   password. Set the author name to something like `phone`.
4. Run the command **Clone an existing remote repo** with `https://github.com/you/vault-work.git`.
   Clone into the vault root, then restart Obsidian.
5. Plugin settings: **Pull on startup** on, **Auto commit-and-sync interval** 5,
   **Auto pull interval** 5.

**Then, on every desktop:** open **Settings → Git** and turn on **Disable on this device**. The
plugin's on/off switch is part of the vault, so step 2 also turns it on on your desktops, where it
would fight vaultsync. "Disable on this device" is stored only on that device.

If the plugin is slow (large vault, many images, mostly on iOS), use a separate git app instead:
[Working Copy](https://workingcopy.app) on iOS (*Link Repository to Folder*; pushing is a paid
feature) or [MGit](https://github.com/maks/MGit) on Android. With those, you pull by hand before
editing and commit + push when you're done.

On a phone, a conflict shows up as `<<<<<<<` markers inside the note, not as a `.conflict-` file.
Pulling before you edit makes this rare.

## Reference

### Commands

On a desktop: `node bin/vaultsync.js <command>` (or `vaultsync <command>` after `npm link`).
In Docker: `docker compose run --rm vaultsync <command>`.

| Command  | What it does                                                                       |
| -------- | ---------------------------------------------------------------------------------- |
| `watch`  | Keeps running: syncs at start, 30 s after the last change, and every 5 minutes.    |
| `sync`   | Syncs once: commit everything, download, upload. Then exits.                       |
| `status` | Shows per vault: last download/upload, unsynced files, last error, conflict files. |
| `init`   | Makes each folder a git repo (if needed) and adds the standard `.gitignore`.       |

Sample `status` output:

```
vault        /Users/you/Vaults/Work
branch       main  (ahead 0, behind 0 as of last fetch)
uncommitted  0 file(s)
last pull    13-10-2026, 14:04:26 (3m ago)
last push    13-10-2026, 14:04:27 (3m ago)
conflicts    1 outstanding:
  Projects/plan.conflict-2026-10-13.md
```

*ahead* = snapshots not yet uploaded, *behind* = snapshots on GitHub not yet downloaded. A healthy
vault shows `ahead 0, behind 0`, `uncommitted 0` and `conflicts none`.

### Settings

In `.env` (desktop) or `environment:` in `compose.yml` (Docker):

| Setting                 | Meaning                                                                          |
| ----------------------- | -------------------------------------------------------------------------------- |
| `VAULT_PATH`            | Vault folder(s). Several: separate with `:` (on Windows `;`).                     |
| `GITHUB_TOKEN`          | The token from step 1. Leave empty to use git's own saved login instead.          |
| `DEBOUNCE_SECONDS`      | Quiet time after a change before syncing. Default 30.                            |
| `PULL_INTERVAL_SECONDS` | How often to sync anyway. Default 300 (5 minutes).                               |

The token is handed to git only while vaultsync runs. It is never written into the vault, the git
config or the repo URL.

### Log and state files

vaultsync keeps two files inside each vault's hidden `.git/` folder. They are never uploaded.

- `.git/vaultsync.log`: every commit, download, upload and conflict.
- `.git/vaultsync.json`: time of the last download/upload and the last error (used by `status`).

### What is synced

Everything in the vault, except what the vault's `.gitignore` excludes:

- `.obsidian/workspace*`: which panes and files are open. Changes on every click and differs per
  device.
- `.trash/`: Obsidian's local trash.
- System junk: `.DS_Store`, `Thumbs.db`, `desktop.ini`.

The rest of `.obsidian/` (settings, themes, plugins) **is** synced. To keep a file per device, add
it to the vault's `.gitignore`.

### Conflicts

A conflict happens when two devices change the same file before either has synced.

| This device | Other device | Result                                                                  |
| ----------- | ------------ | ----------------------------------------------------------------------- |
| edited      | edited       | `note.md` = this device's version. Other version → `note.conflict-YYYY-MM-DD.md`. |
| deleted     | edited       | `note.md` stays deleted. Other version → `note.conflict-YYYY-MM-DD.md`. |
| edited      | deleted      | `note.md` = this device's version. No conflict file.                    |

- The date is the day the conflict was found. A second conflict on the same day gets `-2`, `-3`, …
- It works for any file type (images too); the extension is kept.
- Conflict files sync like normal notes, so every device sees them.
- `status` lists all conflict files still in the vault.

**To resolve:** open both files in Obsidian, copy what you want into `note.md`, delete the
`.conflict-…` file. vaultsync syncs the result.

If vaultsync crashes in the middle of this, the next sync finishes the job. If git gets stuck for
any other reason, vaultsync undoes the download attempt, leaves your own changes untouched, and
shows the error in `status`.

## Run at login

Desktops only. Docker restarts the container itself.

### macOS

Create `~/Library/LaunchAgents/com.you.vaultsync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.you.vaultsync</string>
  <key>ProgramArguments</key><array>
    <string>/opt/homebrew/bin/node</string><string>/Users/you/vaultsync/bin/vaultsync.js</string><string>watch</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/you/Library/Logs/vaultsync.log</string>
  <key>StandardErrorPath</key><string>/Users/you/Library/Logs/vaultsync.log</string>
</dict></plist>
```

Then load it (no `sudo`: this is a per-user LaunchAgent):

```sh
PLIST="$HOME/Library/LaunchAgents/com.you.vaultsync.plist"
DOMAIN="gui/$(id -u)"
LABEL=$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PLIST")

chown "$(id -un)":staff "$PLIST"
chmod 644 "$PLIST"

launchctl enable "$DOMAIN/$LABEL"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -kp "$DOMAIN/$LABEL"
```

Run the same commands again after editing the plist. Day to day:

```sh
launchctl print "gui/$(id -u)/com.you.vaultsync"        # should show: state = running
launchctl kickstart -k "gui/$(id -u)/com.you.vaultsync" # restart, e.g. after changing .env
tail -n 100 ~/Library/Logs/vaultsync.log                # one "watching" line per vault
```

`com.you.vaultsync` is just the example name. If you picked another `Label`, use that one
everywhere (the `LABEL=` line above reads it from the plist); otherwise launchctl says the
service doesn't exist.

- Use full paths. `which node` shows where node is: `/opt/homebrew/bin/node` on Apple Silicon,
  `/usr/local/bin/node` on Intel (Homebrew); other installs (nvm, fnm, `~/.local/bin`, …) differ.
  A symlink is fine, as long as it points to an existing node.
- The plist must be owned by you and not writable by group or others, or launchd refuses it.
- `launchctl load`/`unload` are deprecated; use `bootstrap`/`bootout`.

**`Bootstrap failed: 5: Input/output error`?** `plutil -lint` only checks syntax; error 5
usually means the service was already (partly) loaded, is disabled, has wrong file permissions,
or a path in `ProgramArguments` doesn't exist. The commands above handle the first three. For
the paths:

```sh
ls -l "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$PLIST")" \
      "$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$PLIST")"
```

Both files must exist. If it still fails, launchd's log shows the real reason:

```sh
/usr/bin/log show --last 10m --style compact \
  --predicate 'process == "launchd" AND eventMessage CONTAINS[c] "com.you.vaultsync"'
```

- macOS blocks background programs from `~/Documents`, `~/Desktop` and iCloud Drive. Keep the
  vaults and this tool elsewhere (for example `~/Vaults`), or give `node` Full Disk Access in
  **System Settings → Privacy & Security**.
- Don't put a vault in iCloud Drive: two sync tools on one folder fight.

### Windows

The [setup script](#windows-setup-script) registers this task for you. To do it by hand, in
PowerShell (runs hidden at login, restarts if it crashes):

```powershell
$node = (Get-Command node).Source
$script = "C:\path\to\vaultsync\bin\vaultsync.js"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-WindowStyle Hidden -NoProfile -Command `"& '$node' '$script' watch`""
Register-ScheduledTask -TaskName vaultsync -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Action $action -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
Start-ScheduledTask vaultsync
```

### Linux

Create `~/.config/systemd/user/vaultsync.service`, then run
`systemctl --user enable --now vaultsync`:

```ini
[Service]
ExecStart=/usr/bin/node /path/to/vaultsync/bin/vaultsync.js watch
Restart=on-failure

[Install]
WantedBy=default.target
```

## Troubleshooting

| Problem                                       | Cause and fix                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `VAULT_PATH is not set`                       | No `.env` (desktop) or no `VAULT_PATH` in `compose.yml` (Docker).       |
| `... is not a git repo`                       | Run `init` first, or clone the vault (desktop).                         |
| `Permission denied` in Docker                 | `user:` in `compose.yml` doesn't match the owner of the NAS folders.    |
| Push fails with 403 / authentication          | Token expired or lacks *Contents: Read and write* on that repo.        |
| `git ls-remote`/`git fetch` by hand asks for a username | Normal: the token is only given to git while vaultsync runs. Test with `vaultsync sync` and `status` instead. |
| macOS: `Bootstrap failed: 5: Input/output error` | See [macOS](#macos).                                                |
| Every note shows as changed on Windows        | Clone was made without `-c core.autocrlf=false`. Re-clone with it.      |
| Changes on the NAS appear only after minutes  | Normal for edits not made via the Docker server; the 5-minute round picks them up. |
| Vault was already a git repo with `.obsidian/workspace*.json` in it | Run once: `git rm --cached ".obsidian/workspace*.json"` in the vault. |
