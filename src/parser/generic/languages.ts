// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * `GenericParserAdapter` instances for every bundled language that doesn't
 * need a bespoke adapter (see `registry.ts` for why C and PHP stay separate).
 *
 * Each grammar wasm is ABI-verified against our pinned `web-tree-sitter`
 * runtime before being added here (see [[tree-sitter-wasm-setup]] memory) —
 * several otherwise-obvious choices (a bulk `tree-sitter-wasms` package,
 * `tree-sitter-kotlin`, `tree-sitter-lua`) were rejected because they either
 * ship an incompatible ABI or no prebuilt wasm at all.
 */
import jsWasmUrl from "tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import tsWasmUrl from "tree-sitter-typescript/tree-sitter-typescript.wasm?url";
import tsxWasmUrl from "tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import pyWasmUrl from "tree-sitter-python/tree-sitter-python.wasm?url";
import javaWasmUrl from "tree-sitter-java/tree-sitter-java.wasm?url";
import cppWasmUrl from "tree-sitter-cpp/tree-sitter-cpp.wasm?url";
import goWasmUrl from "tree-sitter-go/tree-sitter-go.wasm?url";
import rustWasmUrl from "tree-sitter-rust/tree-sitter-rust.wasm?url";
import rubyWasmUrl from "tree-sitter-ruby/tree-sitter-ruby.wasm?url";
import csharpWasmUrl from "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm?url";
import bashWasmUrl from "tree-sitter-bash/tree-sitter-bash.wasm?url";
import scalaWasmUrl from "tree-sitter-scala/tree-sitter-scala.wasm?url";
import objcWasmUrl from "tree-sitter-objc/tree-sitter-objc.wasm?url";
import { GenericParserAdapter } from "./genericParser";
import * as refine from "./refinements";

export const GENERIC_ADAPTERS: GenericParserAdapter[] = [
  new GenericParserAdapter({ id: "javascript", extensions: ["js", "mjs", "cjs", "jsx"], wasmUrl: jsWasmUrl, ...refine.javascriptLike }),
  new GenericParserAdapter({ id: "typescript", extensions: ["ts", "mts", "cts"], wasmUrl: tsWasmUrl, ...refine.javascriptLike }),
  new GenericParserAdapter({ id: "tsx", extensions: ["tsx"], wasmUrl: tsxWasmUrl, ...refine.javascriptLike }),
  new GenericParserAdapter({ id: "python", extensions: ["py", "pyw"], wasmUrl: pyWasmUrl, ...refine.python }),
  new GenericParserAdapter({ id: "java", extensions: ["java"], wasmUrl: javaWasmUrl, ...refine.java }),
  new GenericParserAdapter({ id: "cpp", extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"], wasmUrl: cppWasmUrl, ...refine.cpp }),
  new GenericParserAdapter({ id: "go", extensions: ["go"], wasmUrl: goWasmUrl, ...refine.go }),
  new GenericParserAdapter({ id: "rust", extensions: ["rs"], wasmUrl: rustWasmUrl, ...refine.rust }),
  new GenericParserAdapter({ id: "ruby", extensions: ["rb"], wasmUrl: rubyWasmUrl, ...refine.ruby }),
  new GenericParserAdapter({ id: "csharp", extensions: ["cs"], wasmUrl: csharpWasmUrl, ...refine.csharp }),
  new GenericParserAdapter({ id: "bash", extensions: ["sh", "bash"], wasmUrl: bashWasmUrl }),
  new GenericParserAdapter({ id: "scala", extensions: ["scala", "sc"], wasmUrl: scalaWasmUrl, ...refine.scala }),
  new GenericParserAdapter({ id: "objc", extensions: ["m", "mm"], wasmUrl: objcWasmUrl, ...refine.objc }),
];
