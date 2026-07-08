# jawk-ai/qmd — maintained fork of tobi/qmd

This repository is the **canonical search engine** for [qmd-hub](https://github.com/jawk-ai/qmd-hub)
and the JAWK operator stack on srv1490285. It is **not** vanilla upstream `tobi/qmd`.

The reference instance [qmd.jawk.ai](https://qmd.jawk.ai) builds this fork into the
qmd-hub worker image (`deploy/Dockerfile.worker`). System-wide `/usr/bin/qmd` on
srv1490285 also tracks this repo.

## Relationship to upstream

| Repo | Role |
|------|------|
| [tobi/qmd](https://github.com/tobi/qmd) | Upstream — local-first hybrid search CLI |
| **jawk-ai/qmd** (this repo) | Maintained fork — prod features not yet in upstream |
| [heintonny/qmd](https://github.com/heintonny/qmd) | **Retired** — GitHub redirects here after org transfer (2026-07-09) |

**Upstream remote:** `upstream` → `tobi/qmd`. Sync policy: merge upstream releases
into `main`, keep JAWK-specific fixes in fork-only commits when upstream rejects or
lags. Contribute back via focused PRs (remote embed → [tobi/qmd#517](https://github.com/tobi/qmd/pull/517);
unified multi-collection search → planned separate upstream PR).

## Fork deltas (vs upstream `main`)

Features **required** by qmd-hub prod that upstream does not ship today:

- **Remote OpenAI-compatible embed / rerank / expand** — `QMD_EMBED_API_URL`,
  `QMD_RERANK_API_*`, `QMD_EXPAND_API_*` via `HybridLLM` + `remote-llm.ts`
- **Unified multi-collection search** — one SQL pass with `collection IN (...)`,
  global RRF (not per-collection serial loop). Design:
  `docs/plans/2026-07-08-unified-multi-collection-search.md`
- **Embed session timeout override** — `--session-max-ms` / `QMD_EMBED_SESSION_MAX_MS`
- **Parallel embed dispatch** with configurable batch size and 429/5xx backoff
- **Gemini embed index fallback** — positional mapping when API omits `data[].index`

## Version tags

Release tags use the form `v<upstream-version>-jawk.<n>` (e.g. `v2.6.3-jawk.1`).
qmd-hub pins the worker build to a tag by default — see `QMD_GIT_REF` in
`qmd-hub/deploy/Dockerfile.worker`.

## License

Same as upstream (MIT). Fork modifications are MIT-compatible.
