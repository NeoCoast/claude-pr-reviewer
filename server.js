'use strict';

const express = require('express');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = __dirname;

function loadEnv() {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return;
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) process.env[key.trim()] ??= rest.join('=').trim();
  }
}

function loadConfig() {
  const configFile = path.join(ROOT, 'config.json');
  if (!fs.existsSync(configFile)) {
    console.error('config.json not found — copy config.example.json to config.json and edit it');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(configFile, 'utf8'));
}

loadEnv();
const config = loadConfig();

const PORT          = config.port          ?? 7842;
const CLAUDE_AGENT  = config.claudeAgent   ?? 'code-reviewer';
const CLAUDE_MODEL  = config.claudeModel   ?? 'claude-sonnet-4-6';
const MAX_DIFF      = config.maxDiffBytes  ?? 200_000;

const SMEE_URL       = process.env.SMEE_URL;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!SMEE_URL || !WEBHOOK_SECRET) {
  console.error('SMEE_URL and WEBHOOK_SECRET must be set in .env — run: bash setup.sh');
  process.exit(1);
}

// ─── smee.io forwarding ───────────────────────────────────────────────────────

const SmeeClient = require('smee-client');
const smee = new SmeeClient({
  source: SMEE_URL,
  target: `http://localhost:${PORT}/webhook`,
  logger: { info: () => {}, error: console.error },
});
const smeeHandle = smee.start();

console.log(`[bot] smee.io  ${SMEE_URL} → localhost:${PORT}/webhook`);

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

app.post('/webhook', (req, res) => {
  if (!verifySignature(req)) {
    console.warn('[bot] bad signature — ignored');
    return res.sendStatus(401);
  }

  const event   = req.headers['x-github-event'];
  const payload = req.body;

  if (event !== 'pull_request') return res.sendStatus(200);
  if (!['opened', 'synchronize', 'reopened'].includes(payload.action)) return res.sendStatus(200);

  res.sendStatus(202);

  const repo     = payload.repository.full_name;
  const prNumber = payload.pull_request.number;
  const prTitle  = payload.pull_request.title;

  console.log(`[bot] PR #${prNumber} "${prTitle}" — ${repo}`);
  setImmediate(() => reviewPR(repo, prNumber, prTitle));
});

// ─── Review ───────────────────────────────────────────────────────────────────

function reviewPR(repo, prNumber, prTitle) {
  const tmpBase = path.join(os.tmpdir(), `pr-${repo.replace('/', '-')}-${prNumber}`);

  try {
    const diffResult = spawnSync(
      'gh', ['pr', 'diff', String(prNumber), '--repo', repo],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
    );

    if (diffResult.error) throw new Error(`gh pr diff: ${diffResult.error.message}`);
    if (diffResult.status !== 0) throw new Error(`gh pr diff exited ${diffResult.status}: ${diffResult.stderr}`);

    const diff = diffResult.stdout;
    if (!diff.trim()) {
      console.log(`[bot] PR #${prNumber} — empty diff, skipped`);
      return;
    }

    const truncated = diff.length > MAX_DIFF
      ? diff.slice(0, MAX_DIFF) + `\n\n[diff truncated at ${MAX_DIFF} bytes]`
      : diff;

    const prompt =
      `Review PR #${prNumber}: "${prTitle}"\nRepository: ${repo}\n\nDiff:\n${truncated}`;

    console.log(`[bot] running claude --agent ${CLAUDE_AGENT} on PR #${prNumber}...`);

    const claudeResult = spawnSync(
      'claude',
      ['--print', '--agent', CLAUDE_AGENT, '--model', CLAUDE_MODEL, prompt],
      {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: 5 * 60 * 1000,
        cwd: os.tmpdir(),
      }
    );

    if (claudeResult.error) throw new Error(`claude: ${claudeResult.error.message}`);
    if (claudeResult.status !== 0) throw new Error(`claude exited ${claudeResult.status}: ${claudeResult.stderr}`);

    const reviewText = claudeResult.stdout.trim();
    if (!reviewText) throw new Error('claude returned empty output');

    const bodyFile = tmpBase + '.review.txt';
    fs.writeFileSync(bodyFile, `## 🤖 Claude Code Review\n\n${reviewText}`);

    const commentResult = spawnSync(
      'gh', ['pr', 'comment', String(prNumber), '--repo', repo, '--body-file', bodyFile],
      { encoding: 'utf8' }
    );
    fs.unlinkSync(bodyFile);

    if (commentResult.status !== 0) throw new Error(`gh pr comment: ${commentResult.stderr}`);

    console.log(`[bot] ✅ review posted — PR #${prNumber} ${repo}`);
  } catch (err) {
    console.error(`[bot] ❌ PR #${prNumber} ${repo}: ${err.message}`);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[bot] listening on localhost:${PORT}`);
});

process.on('SIGTERM', () => { smeeHandle.close(); process.exit(0); });
