/**
 * Shared Tree-sitter WASM runtime bootstrap.
 *
 * `Parser.init()` loads the core `web-tree-sitter.wasm` engine and must run
 * exactly once before any grammar is loaded. Vite rewrites the `?url` import
 * below into a hashed asset URL and copies the binary into the build output,
 * which we hand to Emscripten via `locateFile`.
 *
 * This is the single place the core runtime is initialized; every language
 * adapter awaits `initTreeSitter()` before loading its grammar.
 */
import { Parser } from "web-tree-sitter";
import coreWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";

let initPromise: Promise<void> | null = null;

export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({ locateFile: () => coreWasmUrl });
  }
  return initPromise;
}
