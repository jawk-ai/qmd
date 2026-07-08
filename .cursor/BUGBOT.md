# Bugbot — jawk-ai/qmd fork (lokal /review-bugbot)

GitHub Bugbot er av. Delte sikkerhetsregler:
`heintonny/agent-system-admin/.cursor/BUGBOT.md`.

## Required

- `npx vitest run` passes for affected suites (minst endrede test-filer)
- `npm run build` succeeds when `src/` or `package.json` endres
- No secrets (`QMD_EMBED_API_KEY`, tokens) i diff

## Search / embed (kritisk i denne fork)

- Multi-collection `query`/`search` skal bruke **én SQL-pass** med
  `collection IN (...)` — ikke per-collection loop med global slice
- `HybridLLM`: `qmd status` og `qmd doctor` må rapportere korrekt embed/rerank-modell
- Remote embed (`QMD_EMBED_API_*`): query-side Qwen3 instruct-prefix på API-modeller
- `QMD_EMBED_CONCURRENCY > 1`: parallel embed må ikke race på delt state
- Rerank-fallback når remote rerank feiler skal være graceful, ikke krasj

## Upstream

- Fork-endringer bør være mergebare mot `tobi/qmd` der det er mulig
- Dokumenter nye env-vars i `README.md`
