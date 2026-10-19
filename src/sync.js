// All git work for one vault: commit local changes, download (pull) changes from GitHub, upload
// (push) ours, and turn clashes between devices into ".conflict-<date>" files instead of losing data.
//
// Every exported function takes a "vault" object `v` = { dir, git } created by openVault().
// The CLI in bin/vaultsync.js decides *when* these run; this file decides *what* happens.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

// Matches conflict file names, e.g.:
//   note.conflict-2026-10-13.md     (first clash on that day)
//   note.conflict-2026-10-13-2.md   (second clash on the same day)
export const CONFLICT_RE = /\.conflict-\d{4}-\d{2}-\d{2}(-\d+)?(\.[^./]*)?$/;

// Commit author/committer can be set through the environment (the Docker container does this,
// because it has no ~/.gitconfig). simple-git removes every GIT_* variable it isn't told to keep,
// so these must be listed explicitly.
const IDENTITY_ENV = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];

// Create the vault object used by every other function.
// `token` is optional: without it, git uses its own saved login (credential helper).
export function openVault(vaultPath, token) {
  const dir = path.resolve(vaultPath);
  const allowEnvironment = [...IDENTITY_ENV];

  if (token) {
    // Give the token to git as an HTTP header, via temporary config in environment variables.
    // That way it is never written to .git/config, the remote URL or a command line (where
    // other users could see it in the process list).
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    const tokenEnv = {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
    };
    // Same token for every vault, so setting it process-wide is fine.
    Object.assign(process.env, tokenEnv);
    allowEnvironment.push(...Object.keys(tokenEnv));
  }

  const git = simpleGit({
    baseDir: dir,
    allowEnvironment,
    // simple-git refuses GIT_CONFIG_COUNT unless this is set; only needed for the token.
    unsafe: { allowUnsafeConfigEnvCount: Boolean(token) },
  });
  return { dir, git };
}

// ---------------------------------------------------------------------------------------------
// Device-local state. Stored inside the vault's .git/ folder, which git never commits, so each
// device keeps its own copy.
//   .git/vaultsync.json  last pull, last push, last error (shown by `vaultsync status`)
//   .git/vaultsync.log   one line per commit, pull, push and conflict
// ---------------------------------------------------------------------------------------------

const gitFile = (v, name) => path.join(v.dir, '.git', name);
const now = () => new Date().toISOString();

export function readState(v) {
  try {
    return JSON.parse(fs.readFileSync(gitFile(v, 'vaultsync.json'), 'utf8'));
  } catch {
    return {}; // no state yet (first run)
  }
}

// Merge `patch` into the saved state, e.g. saveState(v, { lastPush: now() }).
function saveState(v, patch) {
  fs.writeFileSync(gitFile(v, 'vaultsync.json'), JSON.stringify({ ...readState(v), ...patch }, null, 2));
}

// Write a line to the console and to .git/vaultsync.log.
export function log(v, msg) {
  const line = `${now()} ${msg}`;
  // The console line includes the vault name, so you can tell vaults apart when one process
  // syncs several. The log file is per vault already, so it doesn't need the name.
  console.log(`${now()} [${path.basename(v.dir)}] ${msg}`);
  fs.appendFileSync(gitFile(v, 'vaultsync.log'), line + '\n');
}

// ---------------------------------------------------------------------------------------------
// Small git helpers
// ---------------------------------------------------------------------------------------------

// Number of commits in a range, e.g. "HEAD..origin/main" = commits on GitHub we don't have yet.
const count = async (v, range) => Number((await v.git.raw(['rev-list', '--count', range])).trim());

// A rebase (see pull()) that stopped halfway leaves one of these folders in .git/.
const rebaseInProgress = (v) =>
  fs.existsSync(gitFile(v, 'rebase-merge')) || fs.existsSync(gitFile(v, 'rebase-apply'));

// The current branch name, usually "main".
// While a rebase is paused git has no current branch, so read it from the rebase's own notes.
async function branchName(v) {
  const headName = gitFile(v, 'rebase-merge/head-name');
  if (fs.existsSync(headName)) return fs.readFileSync(headName, 'utf8').trim().replace(/^refs\/heads\//, '');
  return (await v.git.raw(['symbolic-ref', '--short', 'HEAD'])).trim();
}

// Does this commit/branch exist? False for e.g. "HEAD" in a repo without commits yet, or
// "origin/main" before the first push.
async function hasRef(v, ref) {
  try {
    await v.git.raw(['rev-parse', '--verify', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Conflict handling
//
// A conflict means: this device and another device both changed the same file since they last
// synced. Git can't decide which version wins, so we decide: this device's version stays in place,
// and the other device's version is saved next to it as a .conflict-<date> file. Nothing is lost;
// the user merges the two by hand.
// ---------------------------------------------------------------------------------------------

// Today's date as YYYY-MM-DD in local time (used in conflict file names).
function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// First free conflict name for `file`: note.conflict-<date>.md, then -2, -3, …
function conflictName(v, file) {
  const { dir, name, ext } = path.posix.parse(file);
  for (let n = 1; ; n++) {
    const candidate = path.posix.join(dir, `${name}.conflict-${localDate()}${n > 1 ? `-${n}` : ''}${ext}`);
    if (!fs.existsSync(path.join(v.dir, candidate))) return candidate;
  }
}

// List the files git could not merge, with the git object id of each side:
//   Map { "note.md" => { 1: <common ancestor>, 2: <one side>, 3: <other side> } }
// A side is missing when that side deleted the file.
async function unmergedPaths(v) {
  const map = new Map();
  // Each line looks like: "<mode> <object id> <side>\t<path>"
  for (const entry of (await v.git.raw(['ls-files', '-u', '-z'])).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [, sha, stage] = entry.slice(0, tab).split(' ');
    const file = entry.slice(tab + 1);
    map.set(file, { ...map.get(file), [stage]: sha });
  }
  return map;
}

// Resolve one conflicted file: keep this device's version, save the other one as a conflict file.
//
// Careful: during a rebase git's "ours"/"theirs" are swapped compared to what you'd expect.
// The rebase replays *our* commits on top of what we downloaded, so:
//   side 2 ("ours" to git)   = the downloaded version from the other device  -> `incoming`
//   side 3 ("theirs" to git) = this device's version                         -> `mine`
async function keepMine(v, file, { 2: incoming, 3: mine }) {
  // 1. Save the other device's version (if it still has the file) as note.conflict-<date>.md.
  let saved = '(deleted upstream)';
  if (incoming) {
    saved = conflictName(v, file);
    const abs = path.join(v.dir, saved);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, await v.git.showBuffer([incoming])); // byte-for-byte, so images work too
    await v.git.raw(['add', '-f', '--', saved]);
  }

  // 2. Put this device's version back at the original name (or keep it deleted).
  if (mine) {
    await v.git.raw(['checkout', '--theirs', '--', file]); // "--theirs" = mine, see above
    await v.git.raw(['add', '-f', '--', file]);
  } else {
    await v.git.raw(['rm', '--quiet', '--force', '--', file]);
  }
  log(v, `CONFLICT ${file}: kept local version${mine ? '' : ' (deleted locally)'}, incoming saved as ${saved}`);
}

// Finish a rebase that git paused because of conflicts. A rebase replays our commits one by one,
// so it can pause several times; handle every pause until it's done.
// If it paused for a reason other than a file conflict, give up and undo it ("abort"). That puts
// the vault back exactly as it was before the pull, so local work is never lost.
async function resolveRebase(v) {
  while (rebaseInProgress(v)) {
    const unmerged = await unmergedPaths(v);
    if (!unmerged.size) {
      await v.git.raw(['rebase', '--abort']);
      throw new Error('rebase stopped without a file conflict; aborted it, local commits are untouched');
    }
    for (const [file, stages] of unmerged) await keepMine(v, file, stages);
    // Commit ourselves: "rebase --continue" would otherwise open a text editor for the message.
    await v.git.raw(['commit', '--no-edit', '--no-verify']);
    // Continue with the next commit. It may pause again; the loop then handles the next pause.
    await v.git.raw(['rebase', '--continue']).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// The sync steps: commit -> pull -> push
// ---------------------------------------------------------------------------------------------

// Step 1: snapshot every changed, new or deleted file in one commit. Returns the number of files.
export async function commitAll(v) {
  await v.git.raw(['add', '-A']);
  const files = (await v.git.raw(['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean);
  if (!files.length) return 0; // nothing changed
  await v.git.commit(`vault backup: ${os.hostname()} ${now()} (${files.length} file${files.length === 1 ? '' : 's'})`);
  log(v, `committed ${files.length} file(s)`);
  return files.length;
}

// Step 2: download changes from GitHub and put our own commits on top of them ("rebase").
// This keeps the history a straight line instead of a merge commit after every sync.
export async function pull(v) {
  const remote = `origin/${await branchName(v)}`;
  await v.git.fetch('origin');

  // Only rebase when GitHub actually has commits we don't. Skipped before the first push (no
  // origin/main yet) and in an empty repo (no HEAD yet).
  if ((await hasRef(v, remote)) && (await hasRef(v, 'HEAD')) && (await count(v, `HEAD..${remote}`)) > 0) {
    // --autostash: if a file changed after step 1 (e.g. another app is still writing), park that change,
    // rebase, then put it back, instead of refusing to rebase.
    await v.git.raw(['rebase', '--autostash', remote]).catch((err) => {
      if (!rebaseInProgress(v)) throw err; // a real error, not a pause for conflicts
    });
    await resolveRebase(v); // no-op if the rebase finished without conflicts
    log(v, `pulled ${remote}`);
  }
  saveState(v, { lastPull: now() });
}

// Step 3: upload our commits to GitHub, if there are any.
export async function push(v) {
  const branch = await branchName(v);
  if (!(await hasRef(v, 'HEAD'))) return; // empty repo, nothing to push
  if ((await hasRef(v, `origin/${branch}`)) && (await count(v, `origin/${branch}..HEAD`)) === 0) return; // up to date
  await v.git.push(['-u', 'origin', branch]); // -u: remember origin/<branch> as the upstream
  saveState(v, { lastPush: now() });
  log(v, `pushed ${branch}`);
}

// One full sync round. Errors are saved (for `status`) and re-thrown to the caller.
export async function sync(v) {
  try {
    // A previous run may have crashed while resolving conflicts. Finish that first.
    if (rebaseInProgress(v)) await resolveRebase(v);
    await commitAll(v);
    await pull(v);
    try {
      await push(v);
    } catch {
      // Most likely another device pushed between our pull and push, so GitHub rejected ours.
      // Download that too and try once more.
      await pull(v);
      await push(v);
    }
    saveState(v, { lastError: null });
  } catch (err) {
    saveState(v, { lastError: `${now()} ${err.message.trim()}` });
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Status and setup
// ---------------------------------------------------------------------------------------------

// Everything `vaultsync status` prints. Doesn't contact GitHub: ahead/behind are as of the last pull.
export async function status(v) {
  const state = readState(v);
  const branch = await branchName(v);
  const remote = `origin/${branch}`;
  const tracked = (await hasRef(v, 'HEAD')) && (await hasRef(v, remote));
  // All files in the vault (committed or new), minus ignored ones; used to find conflict files.
  const listed = (await v.git.raw(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])).split('\0');
  return {
    ...state,
    vault: v.dir,
    branch,
    ahead: tracked ? await count(v, `${remote}..HEAD`) : null, // ours, not yet uploaded
    behind: tracked ? await count(v, `HEAD..${remote}`) : null, // theirs, not yet downloaded
    uncommitted: (await v.git.status()).files.length,
    // Leftovers from an --autostash that couldn't be put back; rare, but worth showing.
    stashes: (await v.git.raw(['stash', 'list'])).split('\n').filter(Boolean).length,
    rebaseInProgress: rebaseInProgress(v),
    conflicts: listed.filter((f) => CONFLICT_RE.test(f) && fs.existsSync(path.join(v.dir, f))),
  };
}

// Prepare a vault folder: make it a git repo if needed, set git options, and add the lines from
// vault.gitignore that the vault's .gitignore doesn't have yet. Safe to run more than once.
// Returns the .gitignore lines that were added.
export async function init(v, templatePath) {
  if (!fs.existsSync(path.join(v.dir, '.git'))) await v.git.raw(['init', '-b', 'main']);
  // Keep files byte-for-byte identical across Windows, macOS and phones: no line-ending
  // conversion. quotepath=false shows non-ASCII file names (é, ü, …) as-is in git output.
  await v.git.addConfig('core.autocrlf', 'false');
  await v.git.addConfig('core.quotepath', 'false');

  const ignorePath = path.join(v.dir, '.gitignore');
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = fs
    .readFileSync(templatePath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#') && !have.has(l.trim()));
  if (missing.length) {
    const sep = existing && !existing.endsWith('\n') ? '\n' : '';
    fs.writeFileSync(ignorePath, existing + sep + missing.join('\n') + '\n');
  }
  return missing;
}
