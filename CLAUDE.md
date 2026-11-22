# Working in this repository

Public election-results pages (static files at the repo root, served by GitHub Pages) and the cloud admin upload flow (`functions/`, `tools/`). This file is publicly readable with the site, so keep account names, emails, project ids and hostnames out of it.

## Who does what (model routing)
- Cheap digging goes to Haiku subagents, in parallel when possible: the `search` agent for finding files, definitions and every call site; the `tests` agent for running tests, build checks and linters.
- The Builder plans and writes the code. The Reviewer (Opus, read-only) judges. A builder never reviews its own work; a reviewer never writes, commits or pushes code.
- The `reviewer` agent in `.claude/agents` is only an extra pre-check. The Reviewer thread's verdict is still required for plans, repeated errors, "done", and every live-run preview.

## When the Reviewer is called
1. Before a plan locks: no file changes until the plan is approved.
2. When the same error happens twice: stop, send the error history. No blind third try.
3. Before anything is called done: send the diff and the test output.

Verdict format: `VERDICT: approve | reject`, `WHY` (3 lines max), `FIX FIRST` (on reject). A "done" without test output is rejected.

## "Done" means
Tests ran in this session and passed; build and lint pass; the real user flow was walked through, including phone widths, with evidence; the Reviewer approved the diff and the test output. Follow the `verify` skill (`.claude/skills/verify`). No proof, no done.
- Never delete or skip a failing test to make it green. Flaky tests get fixed, not rerun until green.
- Unsure about scope: ask before touching more files than the task names.
- A one-line fix may skip the planning and review steps; the checks above still run.

## Repository rules
- Every change to a public page needs phone-width tests (the mobile-layout spec and the phone Playwright projects).
- A new page is added to the page list in `404.html` (case-insensitive redirects).
- After any page code change, Cloudflare needs Caching > Purge Everything (a person does this).
- No hand edits to production data or config. Use the admin page features; any manual step is reviewed first.
- Commands: see `TESTING.md` and `.claude/skills/verify/SKILL.md`.
