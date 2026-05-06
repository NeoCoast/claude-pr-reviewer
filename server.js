'use strict';

const express = require('express');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = {
  info:  (...a) => console.log( `[${new Date().toISOString()}] INFO `, ...a),
  warn:  (...a) => console.warn( `[${new Date().toISOString()}] WARN `, ...a),
  error: (...a) => console.error(`[${new Date().toISOString()}] ERROR`, ...a),
};

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = __dirname;

function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) process.env[key] ??= val;
  }
}

function loadConfig() {
  const configFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configFile)) {
    log.error('config.json not found — copy config.example.json to config.json and edit it');
    process.exit(1);
  }
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (err) {
    log.error(`config.json is invalid JSON: ${err.message}`);
    process.exit(1);
  }
}

loadEnv();
const config = loadConfig();

const PORT           = config.port          ?? 7842;
const CLAUDE_AGENT   = config.claudeAgent   ?? 'code-reviewer';
const CLAUDE_MODEL   = config.claudeModel   ?? 'claude-sonnet-4-6';
const MAX_DIFF       = config.maxDiffBytes  ?? 200_000;
const MAX_CONCURRENT = config.maxConcurrent ?? 2;

const SMEE_URL       = process.env.SMEE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SMEE_URL || !WEBHOOK_SECRET) {
  log.error('SMEE_URL and WEBHOOK_SECRET must be set in .env — run: bash setup.sh');
  process.exit(1);
}

// ─── smee.io forwarding ───────────────────────────────────────────────────────

const SmeeClient = require('smee-client');
const smee = new SmeeClient({
  source: SMEE_URL,
  target: `http://localhost:${PORT}/webhook`,
  logger: { info: () => {}, error: (...a) => log.error('[smee]', ...a) },
});
const smeeHandle = smee.start();

log.info(`smee.io ${SMEE_URL} → localhost:${PORT}/webhook`);

// ─── Async spawn helper ───────────────────────────────────────────────────────

function spawnAsync(cmd, args, opts = {}) {
  const { timeout: timeoutMs, maxBuffer = 50 * 1024 * 1024, ...spawnOpts } = opts;

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutSize = 0;
    let settled = false;

    const proc = spawn(cmd, args, { ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'] });

    let timer;
    if (timeoutMs) {
      timer = setTimeout(() => {
        if (!settled) {
          proc.kill('SIGTERM');
          reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
          settled = true;
        }
      }, timeoutMs);
    }

    proc.stdout.on('data', chunk => {
      stdoutSize += chunk.length;
      if (stdoutSize > maxBuffer) {
        proc.kill('SIGTERM');
        if (!settled) {
          reject(new Error(`${cmd} stdout exceeded ${maxBuffer} bytes`));
          settled = true;
        }
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr.on('data', chunk => stderrChunks.push(chunk));

    proc.on('error', err => {
      clearTimeout(timer);
      if (!settled) { reject(err); settled = true; }
    });

    proc.on('close', code => {
      clearTimeout(timer);
      if (!settled) {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          status: code,
        });
        settled = true;
      }
    });
  });
}

// ─── Review queue ─────────────────────────────────────────────────────────────

let activeReviews = 0;
const reviewQueue = [];

function enqueueReview(repo, prNumber, prTitle) {
  reviewQueue.push({ repo, prNumber, prTitle });
  log.info(`PR #${prNumber} queued (queue=${reviewQueue.length} active=${activeReviews}) — ${repo}`);
  drainQueue();
}

function drainQueue() {
  while (activeReviews < MAX_CONCURRENT && reviewQueue.length > 0) {
    const job = reviewQueue.shift();
    activeReviews++;
    reviewPR(job.repo, job.prNumber, job.prTitle).finally(() => {
      activeReviews--;
      drainQueue();
    });
  }
}

// ─── Webhook server ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

function verifySignature(req) {
  const sig = req.headers['x-hub-signature-256'];
  if (!sig) return false;
  const expected = 'sha256=' + crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', activeReviews, queued: reviewQueue.length });
});

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    log.warn('bad signature — ignored');
    return res.sendStatus(401);
  }

  const event   = req.headers['x-github-event'];
  const payload = req.body;

  if (event !== 'pull_request') return res.sendStatus(200);
  if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) return res.sendStatus(200);

  const repo     = payload.repository?.full_name;
  const prNumber = payload.pull_request?.number;
  const prTitle  = payload.pull_request?.title ?? '';

  const prAuthor = payload.pull_request?.user?.login;
  if (config.allowedAuthors?.length > 0 && !config.allowedAuthors.includes(prAuthor)) {
    log.info(`PR #${prNumber} by @${prAuthor} not in allowedAuthors — ignored`);
    return res.sendStatus(200);
  }

  if (!repo || typeof prNumber !== 'number') {
    log.warn('malformed payload — missing repo or PR number');
    return res.sendStatus(400);
  }

  res.sendStatus(202);
  enqueueReview(repo, prNumber, prTitle);
});

// ─── GitHub comment helpers ───────────────────────────────────────────────────

async function createComment(repo, prNumber, body) {
  const result = await spawnAsync(
    'gh', ['api', `repos/${repo}/issues/${prNumber}/comments`,
      '--method', 'POST', '--field', `body=${body}`]
  );
  if (result.status !== 0) throw new Error(`create comment: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout).id;
}

async function updateComment(repo, commentId, body) {
  const result = await spawnAsync(
    'gh', ['api', `repos/${repo}/issues/comments/${commentId}`,
      '--method', 'PATCH', '--field', `body=${body}`]
  );
  if (result.status !== 0) throw new Error(`update comment: ${result.stderr.trim()}`);
}

// ─── Review ───────────────────────────────────────────────────────────────────

async function reviewPR(repo, prNumber, prTitle) {
  const runId = crypto.randomBytes(4).toString('hex');
  const tag   = `PR #${prNumber} [${runId}]`;

  log.info(`${tag} starting review — ${repo} "${prTitle}"`);

  let commentId;
  let bodyFile;
  try {
    commentId = await createComment(repo, prNumber,
      `## 🤖 Claude Code Review\n\n⏳ Iniciando review...`
    );
    log.info(`${tag} placeholder comment posted (id: ${commentId})`);

    const diffResult = await spawnAsync(
      'gh', ['pr', 'diff', String(prNumber), '--repo', repo],
      { timeout: 60_000 }
    );

    if (diffResult.status !== 0) {
      throw new Error(`gh pr diff exited ${diffResult.status}: ${diffResult.stderr.trim()}`);
    }

    const diff = diffResult.stdout;
    if (!diff.trim()) {
      log.info(`${tag} empty diff, skipped`);
      await updateComment(repo, commentId, `## 🤖 Claude Code Review\n\n_Sin cambios en el diff — review omitido._`);
      return;
    }

    const truncated = diff.length > MAX_DIFF
      ? diff.slice(0, MAX_DIFF) + `\n\n[diff truncated at ${MAX_DIFF} bytes]`
      : diff;

    const prompt = `Review PR #${prNumber}: "${prTitle}"\nRepository: ${repo}\n\nDiff:\n${truncated}`;

    log.info(`${tag} running claude --agent ${CLAUDE_AGENT}...`);

    const claudeResult = await spawnAsync(
      'claude',
      ['--print', '--agent', CLAUDE_AGENT, '--model', CLAUDE_MODEL, prompt],
      { timeout: 5 * 60_000, cwd: os.tmpdir() }
    );

    if (claudeResult.status !== 0) {
      throw new Error(`claude exited ${claudeResult.status}: ${claudeResult.stderr.trim()}`);
    }

    const reviewText = claudeResult.stdout.trim();
    if (!reviewText) throw new Error('claude returned empty output');

    await updateComment(repo, commentId, `## 🤖 Claude Code Review\n\n${reviewText}`);

    log.info(`${tag} ✅ review posted — ${repo}`);
  } catch (err) {
    log.error(`${tag} ❌ ${err.message}`);
    if (commentId) {
      await updateComment(repo, commentId,
        `## 🤖 Claude Code Review\n\n❌ Error al generar el review: ${err.message}`
      ).catch(() => {});
    }
  } finally {
    if (bodyFile) {
      try { fs.unlinkSync(bodyFile); } catch { /* ignore */ }
    }
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, '127.0.0.1', () => {
  log.info(`listening on localhost:${PORT}`);
});

function shutdown() {
  log.info('shutting down...');
  smeeHandle.close();
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
