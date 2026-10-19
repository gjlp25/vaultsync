#!/usr/bin/env node
// Command-line entry point: `vaultsync <init|watch|sync|status>`.
//
// This file reads the settings and decides *when* to sync (on file changes, on a timer).
// The actual git work lives in ../src/sync.js.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import { openVault, sync, status, init, log } from '../src/sync.js';

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

// The folder this tool is installed in (one level up from bin/).
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Read settings from <root>/.env if it exists (desktop). In Docker there is no .env; the settings
// come from `environment:` in compose.yml instead. Real environment variables always win over .env.
if (fs.existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));

const { VAULT_PATH, GITHUB_TOKEN, DEBOUNCE_SECONDS = '30', PULL_INTERVAL_SECONDS = '300' } = process.env;
const command = process.argv[2];

// VAULT_PATH can hold several vaults, separated by ":" (";" on Windows, where ":" is part of
// "C:\"). Example: VAULT_PATH=/vaults/Work:/vaults/Personal
const vaultPaths = (VAULT_PATH ?? '').split(path.delimiter).filter(Boolean);

const USAGE = `usage: vaultsync <command>

  init     make each vault a git repo (if needed) and add the standard .gitignore entries
  watch    keep running: sync ${DEBOUNCE_SECONDS}s after the last change and every ${PULL_INTERVAL_SECONDS}s
  sync     sync once (commit, pull, push) and exit
  status   last pull/push, unsynced files, last error, conflict files

Settings come from ${path.join(root, '.env')} (see .env.example) or the environment.`;

// ---------------------------------------------------------------------------------------------
// watch: the background mode
//
// Per vault:
//   - A file watcher restarts a timer (DEBOUNCE_SECONDS, default 30) on every change. When the
//     timer runs out (nothing changed for that long), it syncs. So a burst of edits is one commit.
//   - Every PULL_INTERVAL_SECONDS (default 300) it syncs anyway, to download other devices'
//     changes and to catch changes the file watcher can't see (e.g. edits made by another machine
//     on an NFS share).
// ---------------------------------------------------------------------------------------------

function watch(v) {
  let timer = null; // the pending "sync after quiet time" timer, if any

  // Syncs must never overlap (two git processes in one repo break each other), so each sync
  // waits for the previous one via this promise chain. Errors are logged; the watcher keeps going.
  let chain = Promise.resolve();
  const run = (why) => {
    chain = chain.then(() => sync(v)).catch((err) => log(v, `sync failed (${why}): ${err.message.trim()}`));
  };

  // Files whose changes should not trigger a sync. Mirrors the noisy entries in vault.gitignore:
  // git's own folder, Obsidian's trash, and Obsidian's workspace files (change on every click).
  const ignored = (p) => {
    const rel = path.relative(v.dir, p).split(path.sep).join('/');
    return /^(\.git|\.trash)(\/|$)/.test(rel) || rel.startsWith('.obsidian/workspace');
  };

  // ignoreInitial: don't report every existing file as "added" at startup.
  chokidar.watch(v.dir, { ignored, ignoreInitial: true }).on('all', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run('change');
    }, Number(DEBOUNCE_SECONDS) * 1000);
  });

  // The periodic sync. Skipped while a change timer is pending: that one syncs soon anyway, and
  // syncing now could commit a note halfway through editing.
  setInterval(() => timer || run('interval'), Number(PULL_INTERVAL_SECONDS) * 1000);

  log(v, `watching ${v.dir}`);
  run('start'); // catch up on anything that changed while vaultsync wasn't running
}

// ---------------------------------------------------------------------------------------------
// status: human-readable output
// ---------------------------------------------------------------------------------------------

// "13-10-2026, 14:04:26 (3m ago)"
function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const rel = s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 129600 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return `${new Date(iso).toLocaleString()} (${rel} ago)`;
}

async function printStatus(v) {
  const s = await status(v);
  const lines = [
    `vault        ${s.vault}`,
    // ahead = our commits not on GitHub yet; behind = GitHub commits we haven't downloaded yet
    `branch       ${s.branch}` + (s.ahead === null ? '  (no upstream yet)' : `  (ahead ${s.ahead}, behind ${s.behind} as of last fetch)`),
    `uncommitted  ${s.uncommitted} file(s)`,
    `last pull    ${ago(s.lastPull)}`,
    `last push    ${ago(s.lastPush)}`,
  ];
  if (s.lastError) lines.push(`last error   ${s.lastError}`);
  if (s.rebaseInProgress) lines.push(`WARNING      a rebase is in progress; the next sync will resolve it`);
  if (s.stashes) lines.push(`WARNING      ${s.stashes} stash entr${s.stashes === 1 ? 'y' : 'ies'} (git stash list); local edits may be parked there`);
  lines.push(s.conflicts.length ? `conflicts    ${s.conflicts.length} outstanding:` : 'conflicts    none');
  for (const f of s.conflicts) lines.push(`  ${f}`);
  console.log(lines.join('\n'));
}

// ---------------------------------------------------------------------------------------------
// main: pick the command and run it for every vault
// ---------------------------------------------------------------------------------------------

async function main() {
  if (!['init', 'watch', 'sync', 'status'].includes(command)) {
    console.log(USAGE);
    process.exit(command ? 1 : 0); // no command = asked for help, unknown command = error
  }
  if (!vaultPaths.length) throw new Error(`VAULT_PATH is not set; copy .env.example to ${path.join(root, '.env')}`);

  // init works on folders that aren't git repos yet, and needs no GitHub access.
  if (command === 'init') {
    for (const p of vaultPaths) {
      fs.mkdirSync(p, { recursive: true });
      const added = await init(openVault(p), path.join(root, 'vault.gitignore'));
      console.log(`${p}: ` + (added.length ? `added to .gitignore: ${added.join(', ')}` : '.gitignore already up to date'));
    }
    return;
  }

  // Every other command needs each vault to be a git repo already. Check all of them up front,
  // so a typo in VAULT_PATH fails immediately instead of after the other vaults have run.
  const vaults = vaultPaths.map((p) => openVault(p, GITHUB_TOKEN));
  for (const v of vaults) {
    if (!fs.existsSync(path.join(v.dir, '.git'))) throw new Error(`${v.dir} is not a git repo; run "vaultsync init" or clone it first`);
  }

  // watch: start a watcher per vault. They run side by side in this one process.
  if (command === 'watch') return vaults.forEach(watch);

  // sync / status: handle the vaults one after another.
  for (const [i, v] of vaults.entries()) {
    if (command === 'sync') await sync(v);
    else {
      if (i > 0) console.log(); // blank line between vaults
      await printStatus(v);
    }
  }
}

main().catch((err) => {
  console.error(`vaultsync: ${err.message.trim()}`);
  process.exit(1);
});
