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
import { RemoteLLM } from "./remote-llm.js";

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

  get rerankModelName(): string | undefined {
    return this.remote.rerankModelName;
  }

  // Route to remote
  embed(text: string, options?: EmbedOptions): Promise<EmbeddingResult | null> {
    return this.remote.embed(text, options);
  }

  embedBatch(texts: string[], options?: EmbedOptions): Promise<(EmbeddingResult | null)[]> {
    return this.remote.embedBatch(texts, options);
  }

  rerank(query: string, documents: RerankDocument[], options?: RerankOptions): Promise<RerankResult> {
    return this.remote.rerank(query, documents, options);
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
