/**
 * request-context.ts - Ambient per-request AbortSignal for MCP HTTP requests
 *
 * The MCP SDK only aborts a request's `RequestHandlerExtra.signal` on an
 * explicit `notifications/cancelled` JSON-RPC message — never on a bare
 * TCP/HTTP disconnect. Our HTTP transport in mcp/server.ts talks to clients
 * (the qmd-hub worker's reverse proxy, or a raw fetch with a timeout) that
 * never send that notification; they just stop reading the response.
 *
 * mcp/server.ts detects that disconnect at the Node http layer and runs the
 * request inside `runWithRequestSignal`. Deep call sites (rerank, in
 * particular — see hybrid-llm.ts) read `getRequestSignal()` to notice a
 * client that has already given up, without threading a `signal` parameter
 * through every function in the search/rerank call chain.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage<AbortSignal>();

/** Run `fn` with `signal` available to `getRequestSignal()` for its entire async extent. */
export function runWithRequestSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return storage.run(signal, fn);
}

/** The current request's abort signal, if called within `runWithRequestSignal`. */
export function getRequestSignal(): AbortSignal | undefined {
  return storage.getStore();
}
