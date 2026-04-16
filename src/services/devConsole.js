const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const logger = require('./logger');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'postgres-data', '.next', 'coverage']);
const ALLOWED_EXTENSIONS = new Set([
  '.js', '.ts', '.json', '.html', '.css', '.md', '.sql', '.env.example',
  '.yml', '.yaml', '.txt', ''
]);

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

function safePath(rel) {
  const absolute = path.resolve(REPO_ROOT, rel);
  if (!absolute.startsWith(REPO_ROOT + path.sep) && absolute !== REPO_ROOT) {
    throw new Error(`path escapes repo root: ${rel}`);
  }
  return absolute;
}

function relFromRoot(absolute) {
  return path.relative(REPO_ROOT, absolute).split(path.sep).join('/');
}

async function walkFiles(dir = REPO_ROOT, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walkFiles(path.join(dir, entry.name), out);
    } else if (entry.isFile()) {
      const abs = path.join(dir, entry.name);
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTENSIONS.size && !ALLOWED_EXTENSIONS.has(ext) && entry.name !== 'Procfile' && entry.name !== 'Dockerfile') continue;
      const stat = await fsp.stat(abs);
      out.push({
        path: relFromRoot(abs),
        size: stat.size,
        mtime: stat.mtimeMs,
        type: 'file'
      });
    }
  }
  return out;
}

async function readFile(relPath) {
  const abs = safePath(relPath);
  const stat = await fsp.stat(abs);
  if (!stat.isFile()) throw new Error(`not a file: ${relPath}`);
  if (stat.size > 2 * 1024 * 1024) throw new Error(`file too large: ${relPath} (${stat.size} bytes)`);
  const content = await fsp.readFile(abs, 'utf8');
  return { path: relPath, content, size: stat.size, mtime: stat.mtimeMs };
}

async function writeFile(relPath, content) {
  const abs = safePath(relPath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

async function applyChange(change) {
  if (!change || !change.file) throw new Error('change.file required');
  if (change.type === 'create') {
    if (typeof change.content !== 'string') throw new Error(`change.content required for create: ${change.file}`);
    await writeFile(change.file, change.content);
    return { file: change.file, type: 'create', ok: true };
  }
  if (change.type === 'modify' || !change.type) {
    if (typeof change.original !== 'string' || typeof change.modified !== 'string') {
      throw new Error(`change.original and change.modified required for modify: ${change.file}`);
    }
    const abs = safePath(change.file);
    const current = await fsp.readFile(abs, 'utf8');
    const occurrences = current.split(change.original).length - 1;
    if (occurrences === 0) throw new Error(`original block not found in ${change.file}`);
    if (occurrences > 1) throw new Error(`original block appears ${occurrences} times in ${change.file} — must be unique`);
    const next = current.replace(change.original, change.modified);
    await writeFile(change.file, next);
    return { file: change.file, type: 'modify', ok: true };
  }
  if (change.type === 'delete') {
    const abs = safePath(change.file);
    await fsp.unlink(abs);
    return { file: change.file, type: 'delete', ok: true };
  }
  throw new Error(`unknown change type: ${change.type}`);
}

function pushRemoteUrl() {
  const token = process.env.GITHUB_DEPLOY_TOKEN;
  if (!token) throw new Error('GITHUB_DEPLOY_TOKEN env var is not set');
  return `https://x-access-token:${token}@github.com/WJSchratt/ph-bot.git`;
}

async function gitStatus() {
  const { stdout } = await execFilePromise('git', ['status', '--porcelain']);
  return stdout.trim();
}

async function gitLog(limit = 20) {
  const { stdout } = await execFilePromise('git', ['log', `-${Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100)}`, '--pretty=format:%H%x1f%s%x1f%an%x1f%ae%x1f%aI']);
  if (!stdout.trim()) return [];
  return stdout.split('\n').map((line) => {
    const [hash, subject, author_name, author_email, date] = line.split('\x1f');
    return { hash, short: hash.slice(0, 7), subject, author_name, author_email, date };
  });
}

async function gitCurrentHead() {
  const { stdout } = await execFilePromise('git', ['rev-parse', 'HEAD']);
  return stdout.trim();
}

async function gitCommitAndPush({ commitMessage, username, filesToAdd }) {
  if (!commitMessage) throw new Error('commitMessage required');

  if (Array.isArray(filesToAdd) && filesToAdd.length) {
    await execFilePromise('git', ['add', '--', ...filesToAdd]);
  } else {
    await execFilePromise('git', ['add', '-A']);
  }

  try {
    await execFilePromise('git', ['-c', `user.name=${username || 'Dev Console'}`, '-c', `user.email=devconsole@ph-bot.local`, 'commit', '-m', commitMessage]);
  } catch (err) {
    const msg = (err.stderr || err.stdout || err.message || '').toString();
    if (/nothing to commit/i.test(msg)) {
      return { committed: false, reason: 'nothing to commit' };
    }
    throw err;
  }

  const head = await gitCurrentHead();

  const remoteUrl = pushRemoteUrl();
  await execFilePromise('git', ['push', remoteUrl, 'HEAD:main']);

  logger.log('dev_console', 'info', null, 'Deploy pushed', {
    commit: head.slice(0, 7),
    commit_message: commitMessage,
    username: username || null
  });

  return { committed: true, commit_hash: head, short: head.slice(0, 7) };
}

async function gitRevertAndPush(username) {
  const { stdout } = await execFilePromise('git', ['log', '-1', '--pretty=format:%s']);
  const lastSubject = stdout.trim();
  if (/^Revert "/.test(lastSubject)) {
    throw new Error('last commit is already a revert — cascading rollbacks not allowed');
  }

  await execFilePromise('git', [
    '-c', `user.name=${username || 'Dev Console'}`,
    '-c', `user.email=devconsole@ph-bot.local`,
    'revert', 'HEAD', '--no-edit'
  ]);
  const head = await gitCurrentHead();
  const remoteUrl = pushRemoteUrl();
  await execFilePromise('git', ['push', remoteUrl, 'HEAD:main']);

  logger.log('dev_console', 'warn', null, 'Deploy rolled back', {
    revert_commit: head.slice(0, 7),
    reverted_subject: lastSubject,
    username: username || null
  });

  return { reverted: true, revert_commit: head, short: head.slice(0, 7), reverted_subject: lastSubject };
}

// Simple per-hour rate limiter for Claude chat
const chatHits = [];
const CHAT_LIMIT_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;

function rateLimitChat() {
  const now = Date.now();
  while (chatHits.length && chatHits[0] < now - HOUR_MS) chatHits.shift();
  if (chatHits.length >= CHAT_LIMIT_PER_HOUR) {
    const oldest = chatHits[0];
    const retryAfter = Math.ceil((oldest + HOUR_MS - now) / 1000);
    return { allowed: false, retry_after_s: retryAfter, count: chatHits.length };
  }
  chatHits.push(now);
  return { allowed: true, count: chatHits.length };
}

module.exports = {
  REPO_ROOT,
  walkFiles,
  readFile,
  writeFile,
  applyChange,
  gitStatus,
  gitLog,
  gitCurrentHead,
  gitCommitAndPush,
  gitRevertAndPush,
  rateLimitChat,
  safePath,
  relFromRoot
};
