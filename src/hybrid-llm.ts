/**
 * hybrid-llm.ts - Compositor that routes LLM operations between remote and local backends
 *
 * Embed/rerank → remote (GPU-heavy, benefits from offloading)
 * Generate → local LlamaCpp
 * ExpandQuery → remote when expandApiModel is configured, otherwise local LlamaCpp
 * tokenize/countTokens → local LlamaCpp (CPU-cheap, needed for chunking)
 */

import type {
  LLM,
  EmbedOptions,
  EmbeddingResult,
  GenerateOptions,
  GenerateResult,
  LlamaToken,
  ModelInfo,
  Queryable,
  RerankDocument,
  RerankOptions,
  RerankResult,
} from "./llm.js";
import { RerankUnavailableError } from "./llm.js";
import { RemoteLLM } from "./remote-llm.js";
import { getRequestSignal } from "./request-context.js";

export class HybridLLM implements LLM {
  constructor(
    private readonly remote: LLM,
    private readonly local: LLM,
  ) {}

  get embedModelName(): string {
    return this.remote.embedModelName;
  }

  /**
   * The local backend leg (LlamaCpp in normal wiring). Exposed so callers that
   * need a local-only capability — e.g. `qmd doctor`'s llama.cpp device probe —
   * can reach the underlying local LLM instead of crashing on the composite,
   * which has no getDeviceInfo(). Generation/tokenize still route here too.
   */
  get localLlm(): LLM {
    return this.local;
  }

  // Generation routes to local; rerank routes to remote. Expose the matching
  // backend's model name so query-time model resolution keeps using the
  // configured local/remote models rather than falling back to defaults.
  get generateModelName(): string | undefined {
    return this.local.generateModelName;
  }

  // Report the EFFECTIVE rerank model, matching the backend rerank() will use:
  // the remote model when a remote rerank endpoint is configured, otherwise the
  // local llama.cpp reranker's model. This keeps `qmd status`/`qmd doctor`
  // truthful (a remote-embed-only deployment reranks locally, not remotely).
  get rerankModelName(): string | undefined {
    return this.rerankBackend === "remote"
      ? this.remote.rerankModelName
      : this.local.rerankModelName;
  }

  /**
   * The rerank backend queries will actually use:
   *   "remote" — the remote backend exposes a configured rerank endpoint.
   *   "local"  — no remote rerank endpoint; fall back to the local llama.cpp
   *              reranker.
   * Exposed so diagnostics (`qmd status`/`qmd doctor`) can report the effective
   * backend truthfully rather than assuming rerank always goes remote.
   */
  get rerankBackend(): "remote" | "local" {
    return this.remoteSupportsRerank ? "remote" : "local";
  }

  private get remoteSupportsRerank(): boolean {
    const remote = this.remote as { supportsRerank?: boolean; rerankModelName?: string };
    if (typeof remote.supportsRerank === "boolean") return remote.supportsRerank;
    return !!remote.rerankModelName;
  }

  // Route to remote
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.remote.embed(text, options);
  }

  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.remote.embedBatch(texts, options);
  }

  /**
   * Rerank candidates for `query`.
   *
   * Routing:
   *   - Remote rerank endpoint configured → route to the remote backend
   *     (GPU-heavy, benefits from offloading).
   *   - Otherwise → fall back to the LOCAL llama.cpp reranker. Previously the
   *     composite routed rerank unconditionally to the remote backend, so a
   *     deployment with remote embed but NO remote rerank endpoint (the common
   *     remote-Gemini-embed case) silently skipped reranking entirely and
   *     returned RRF-only results.
   *
   * Failure handling: any backend error is wrapped in a RerankUnavailableError
   * so the search pipeline degrades to RRF-only ordering (see rerankOrFallback)
   * instead of crashing the query. Reranking is a quality refinement, not a
   * hard dependency — a missing GGUF or a failed native init must never fail a
   * search.
   */
  async rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    const backend = this.rerankBackend;
    const candidateCount = documents.length;

    // Nothing to score — avoid loading a model (and emitting logs) for 0 docs.
    if (candidateCount === 0) {
      return { results: [], model: this.rerankModelName ?? "" };
    }

    // The caller's client may already be gone (timeout + retry is the
    // pathological case from #105) — don't spend CPU/API calls scoring
    // candidates nobody will read.
    const signal = getRequestSignal();
    if (signal?.aborted) {
      logRerankEvent({ event: "skipped", backend, candidates: candidateCount, reason: "client disconnected" });
      throw new RerankUnavailableError(`${backend} rerank skipped: client disconnected`, backend);
    }

    const target = backend === "remote" ? this.remote : this.local;

    // Local rerank is CPU-bound (qwen3-reranker-0.6b via llama.cpp, no GPU)
    // and a single job already parallelizes across every available context —
    // it can saturate all cores on its own. Running more than one job at once
    // adds no throughput, only contention: this is exactly how a client that
    // times out and retries turned into an unbounded pile of zombie jobs
    // fighting for the same 4 cores (#105). Bound it so retries queue instead
    // of thrashing. Remote rerank offloads to a GPU-heavy endpoint elsewhere
    // and doesn't compete for this process's CPU, so it bypasses the gate.
    const release = backend === "local" ? await localRerankSemaphore.acquire() : undefined;
    try {
      // Re-check after any queueing wait — the client may have given up
      // while this job was queued behind an earlier one.
      if (signal?.aborted) {
        logRerankEvent({ event: "skipped", backend, candidates: candidateCount, reason: "client disconnected while queued" });
        throw new RerankUnavailableError(`${backend} rerank skipped: client disconnected while queued`, backend);
      }

      const startedAt = Date.now();
      logRerankEvent({ event: "start", backend, candidates: candidateCount });

      try {
        const result = await target.rerank(query, documents, options);
        logRerankEvent({
          event: "done",
          backend,
          candidates: candidateCount,
          durationMs: Date.now() - startedAt,
          model: result.model,
        });
        return result;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logRerankEvent({
          event: "fallback",
          backend,
          candidates: candidateCount,
          durationMs: Date.now() - startedAt,
          reason,
        });
        // Tag the failure so the pipeline reliably degrades to RRF-only ordering
        // rather than surfacing a raw (possibly non-"rerank") error to the query.
        throw new RerankUnavailableError(`${backend} rerank failed: ${reason}`, backend, err);
      }
    } finally {
      release?.();
    }
  }

  // Route to local
  generate(prompt: string, options?: GenerateOptions): Promise<GenerateResult | null> {
    return this.local.generate(prompt, options);
  }

  /**
   * Route expandQuery to remote when the remote backend supports it
   * (i.e., RemoteLLM with expandApiModel configured), otherwise fall back to local.
   */
  expandQuery(query: string, options?: { context?: string; includeLexical?: boolean; intent?: string }): Promise<Queryable[]> {
    if (this.remote instanceof RemoteLLM && this.remote.supportsExpand) {
      return this.remote.expandQuery(query, options);
    }
    return this.local.expandQuery(query, options);
  }

  modelExists(model: string): Promise<ModelInfo> {
    return this.local.modelExists(model);
  }

  // Tokenization always routes to local — chunking is CPU-cheap and remote
  // backends typically don't expose a compatible tokenizer endpoint.
  tokenize(text: string): Promise<readonly LlamaToken[]> {
    return this.local.tokenize(text);
  }

  detokenize(tokens: readonly LlamaToken[]): Promise<string> {
    return this.local.detokenize(tokens);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.remote.dispose(), this.local.dispose()]);
  }
}

// =============================================================================
// Rerank observability
// =============================================================================

type RerankLogEvent = {
  /** Lifecycle phase: rerank started, completed, fell back to RRF, or was skipped for a disconnected client. */
  event: "start" | "done" | "fallback" | "skipped";
  /** Which backend was used. */
  backend: "remote" | "local";
  /** Number of candidate documents passed to the reranker. */
  candidates: number;
  /** Wall-clock duration in ms (done/fallback only). */
  durationMs?: number;
  /** Effective rerank model (done only). */
  model?: string;
  /** Failure reason (fallback only) or skip reason (skipped only). */
  reason?: string;
};

/**
 * Emit one structured, machine-parseable observability line per rerank phase to
 * stderr. stdout is reserved for JSON payloads (see llm.ts), so diagnostics go
 * to stderr — matching the existing `QMD Warning:` convention. The stable
 * `qmd.rerank` prefix keeps these greppable in worker/daemon logs.
 */
function logRerankEvent(fields: RerankLogEvent): void {
  process.stderr.write(`qmd.rerank ${JSON.stringify(fields)}\n`);
}

// =============================================================================
// Local-backend rerank concurrency bound (#105)
// =============================================================================

/**
 * Simple counting semaphore. `acquire()` resolves with a release function;
 * queued waiters are handed the freed permit directly by `release()` so the
 * total permit count is always conserved.
 */
class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.available = permits;
  }

  acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve(() => this.release());
    }
    return new Promise<() => void>((resolve) => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // hand the freed permit straight to the next waiter
    } else {
      this.available++;
    }
  }
}

/**
 * Max simultaneous LOCAL rerank jobs. Defaults to 1 — see the comment on
 * `rerank()` for why more than one is pure contention, not throughput.
 * Override via `QMD_RERANK_MAX_CONCURRENCY` for hardware with real headroom
 * (many cores, or a build that offloads the local reranker to GPU).
 */
function resolveRerankConcurrency(envValue = process.env.QMD_RERANK_MAX_CONCURRENCY): number {
  const normalized = envValue?.trim() ?? "";
  if (!normalized) return 1;

  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed < 1) {
    process.stderr.write(`QMD Warning: invalid QMD_RERANK_MAX_CONCURRENCY="${envValue}", using 1.\n`);
    return 1;
  }
  return parsed;
}

const localRerankSemaphore = new Semaphore(resolveRerankConcurrency());
