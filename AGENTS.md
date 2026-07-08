# AGENTS.md — jawk-ai/qmd (maintained fork)

Fork of [tobi/qmd](https://github.com/tobi/qmd) with remote OpenAI-compatible
embed (Gemini 3072d on qmd-hub prod) and unified multi-collection search.
See `README.md` for upstream CLI/docs; `docs/FORK.md` for fork policy and deltas.

## Fork deltas (vs upstream main)

- `QMD_EMBED_API_URL` / `MODEL` / `KEY` — remote embed via `HybridLLM` + `remote-llm.ts`
- Unified multi-collection search — one SQL pass, global RRF (not per-collection loop)
- Design: `docs/plans/2026-07-08-unified-multi-collection-search.md`

## Remotes

- `origin` — `jawk-ai/qmd` (canonical fork)
- `upstream` — `tobi/qmd`

## Deploy context

Prod qmd-hub worker on srv1490285 builds this fork via `qmd-hub`
`deploy/Dockerfile.worker` (`QMD_GIT_URL`, `QMD_GIT_REF`). System-wide
`/usr/bin/qmd` on srv also tracks this repo. Coordinate deploy with
`heintonny/agent-system-admin` incidents/runbooks — do not change `/opt/qmd-hub`
from this repo alone.

## Pre-ship review

Before PR or non-trivial push (any agent — Cursor, Claude, Codex, worker): run
`/review-bugbot` in a Cursor IDE session on Mac. GitHub Bugbot is off.
Policy: `heintonny/agent-system-admin/shared/runbooks/bugbot-local.md`.
Repo rules: `.cursor/BUGBOT.md`.
