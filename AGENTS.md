<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues on abcd5251/flygate, using the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default triage labels (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Worktrees

Several agent sessions share this repo at once, each with its own git worktrees (under `.claude/worktrees/`, a session scratchpad, or elsewhere). Only remove, prune, or clean up worktrees and their branches that your own session created. Never run `git worktree remove`, `git worktree prune`, or delete a worktree directory you did not create, even if it looks stale, finished, or unlocked — another session may still be working in it. If a foreign worktree is in your way, leave it and ask the user.
