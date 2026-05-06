# claude-pr-reviewer

Automatic PR code reviews using [Claude Code](https://claude.ai/code). Runs locally on your machine — no API key or CI setup needed. Uses your existing `claude` CLI auth.

When a pull request is opened or updated in any of your configured repos, the bot fetches the diff, runs it through a Claude `code-reviewer` agent, and posts the result as a PR comment.

```
GitHub PR opened
  → smee.io webhook proxy
    → local Express server (port 7842)
      → claude --agent code-reviewer --print
        → gh pr comment
```

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) — installed and authenticated (`claude --version`)
- [GitHub CLI](https://cli.github.com) — authenticated (`gh auth status`)
- Node.js 18+
- Admin access to the GitHub repos you want to monitor

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/your-username/claude-pr-reviewer
cd claude-pr-reviewer
npm install
```

### 2. Configure repos

```bash
cp config.example.json config.json
```

Edit `config.json`:

```json
{
  "repos": [
    "myorg/backend",
    "myorg/frontend"
  ],
  "port": 7842,
  "claudeAgent": "code-reviewer",
  "claudeModel": "claude-sonnet-4-6",
  "maxDiffBytes": 200000
}
```

### 3. Add the code-reviewer agent

Copy the agent definition to your Claude agents folder:

```bash
cp code-reviewer.md ~/.claude/agents/code-reviewer.md
```

### 4. Run setup

```bash
bash setup.sh
```

This will:
- Create a [smee.io](https://smee.io) channel for webhook forwarding
- Generate a webhook secret
- Save both to `.env`
- Register the webhook in every repo listed in `config.json`

### 5. Start the bot

**Foreground (for testing):**
```bash
node server.js
```

**Background with PM2 (recommended):**
```bash
npm install -g pm2
pm2 start server.js --name claude-pr-reviewer
pm2 save
pm2 startup   # auto-start on system boot
```

---

## How it works

- **smee.io** proxies GitHub webhook events to your local machine — no port forwarding or public IP needed.
- The bot listens on `localhost:7842` (configurable in `config.json`).
- On every `pull_request` event (`opened`, `synchronize`, `reopened`), it fetches the diff via `gh pr diff` and passes it to `claude --agent code-reviewer --print`.
- The review is posted as a comment on the PR by your authenticated GitHub user.

---

## Review format

The `code-reviewer` agent produces structured output:

```
[CRITICAL] file:line — description
Risk: ...
Fix: ...

[HIGH] / [MEDIUM] / [LOW / SUGGESTION] ...

Review Summary: examined N files, found N CRITICAL, N HIGH, N MEDIUM, N LOW findings.
Merge recommendation: BLOCK / APPROVE WITH SUGGESTIONS / APPROVE
```

---

## Configuration reference

| Key | Default | Description |
|---|---|---|
| `repos` | `[]` | List of `org/repo` strings to monitor |
| `port` | `7842` | Local port for the webhook server |
| `claudeAgent` | `"code-reviewer"` | Name of the Claude agent to use |
| `claudeModel` | `"claude-sonnet-4-6"` | Claude model |
| `maxDiffBytes` | `200000` | Diff is truncated beyond this size |

---

## Customizing the reviewer

Edit `~/.claude/agents/code-reviewer.md` to change the review focus, output format, or language-specific rules. The agent has access to `Bash`, `Grep`, and `Read` tools, so it can run `npm audit`, grep for hardcoded secrets, and read full file context when needed.
