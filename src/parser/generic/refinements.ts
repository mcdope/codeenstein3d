// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * Per-language customization for `GenericParserAdapter` — one export per
 * bundled language, wired into its `LanguageConfig` in `languages.ts`. This
 * is where each language gets the "custom handling" it needs to score as
 * precisely as the bespoke PHP/C adapters: method-vs-function distinctions,
 * access-modifier extraction, and name assembly for grammars whose
 * declarations don't expose a plain `name` field.
 *
 * Every hook here is optional and additive — a language with no entry in a
 * given hook just gets the shared default from `vocabulary.ts`.
 */
import type { Node } from "web-tree-sitter";
import type { Visibility } from "../types";
import type { LanguageConfig } from "./genericParser";

type Refinement = Pick<LanguageConfig, "extraEntityTypes" | "filter" | "refine">;

/** Position-based node equality — safe across separate accessor calls, where
 * `===` on wrapper objects isn't guaranteed to hold. */
function samePos(a: Node, b: Node): boolean {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex;
}

// ---------------------------------------------------------------------------
// JavaScript / TypeScript / TSX — capture `const foo = () => {}` and class
// field arrow functions, which the shared table intentionally excludes (see
// vocabulary.ts's note on not treating every anonymous closure as an enemy).
// ---------------------------------------------------------------------------
function isFunctionValued(node: Node): boolean {
  const value = node.childForFieldName("value");
  return value?.type === "arrow_function" || value?.type === "function_expression";
}

export const javascriptLike: Refinement = {
  extraEntityTypes: {
    variable_declarator: "function",
    field_definition: "method",
    public_field_definition: "method",
  },
  filter: (node) => {
    if (node.type === "variable_declarator" || node.type === "field_definition" || node.type === "public_field_definition") {
      return isFunctionValued(node);
    }
    return true;
  },
  refine: (node, entity) => {
    if (node.type === "variable_declarator" || node.type === "field_definition" || node.type === "public_field_definition") {
      const name = node.childForFieldName("name")?.text ?? entity.name;
      return { ...entity, name };
    }
    return entity;
  },
};

// ---------------------------------------------------------------------------
// Python — the grammar doesn't distinguish a method from a top-level
// function (both are `function_definition`); refine using class-body
// ancestry. Visibility comes from the underscore naming convention
// (`__private`, `_protected`) rather than a keyword.
// ---------------------------------------------------------------------------
export const python: Refinement = {
  refine: (node, entity) => {
    if (node.type !== "function_definition") return entity;
    const isMethod = node.parent?.type === "block" && node.parent.parent?.type === "class_definition";
    if (!isMethod) return entity;
    const isDunder = entity.name.startsWith("__") && entity.name.endsWith("__");
    let visibility: Visibility = "public";
    if (!isDunder) {
      if (entity.name.startsWith("__")) visibility = "private";
      else if (entity.name.startsWith("_")) visibility = "protected";
    }
    return { ...entity, kind: "method", visibility };
  },
};

// ---------------------------------------------------------------------------
// Java — `method_declaration`/`constructor_declaration` carry a `modifiers`
// node whose text is the space-separated modifier list.
// ---------------------------------------------------------------------------
export const java: Refinement = {
  refine: (node, entity) => {
    if (entity.kind !== "method") return entity;
    const modifiers = node.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
    let visibility: Visibility = "public"; // no modifier = package-private; closest fit is public (unlocked)
    if (/\bprivate\b/.test(modifiers)) visibility = "private";
    else if (/\bprotected\b/.test(modifiers)) visibility = "protected";
    return { ...entity, visibility };
  },
};

// ---------------------------------------------------------------------------
// C# — each modifier keyword is its own `modifier` node (plural nodes, not
// one combined-text node like Java). Default member accessibility is `private`
// inside a class or struct (unlike Java's package-private default) and *public*
// inside an interface, where members are implicitly public and, before C# 8,
// could not carry an access modifier at all. When the enclosing body cannot be
// identified at all — a failed parse — the default is public; see
// `inCSharpPrivateByDefaultBody`.
//
// Getting that second case wrong was expensive. Defaulting interface members to
// `private` made every one of them a lockable room — `isLockableRoom`
// (`map/generation/geometry.ts`) locks private/protected *method* rooms and
// `placeDoors` turns every corridor mouth of a locked room into a door. On
// Serilog's `ILogger.cs`, 136 interface methods therefore produced **640 doors
// and 321 keys**, about 4.6 doors per room against 0.19 on the class-bearing
// file beside it. `planRoute` opens one door per iteration and gives up at 200,
// so the level could not be routed at all and the bot wedged there with zero
// decisions — 1 of 105 staged levels across the whole capture corpus.
// ---------------------------------------------------------------------------
/**
 * Does an unmodified C# method sit in a body whose default is `private`?
 *
 * Only a class, struct or record makes `private` the default. An interface
 * makes it *public*, and so — deliberately — does "we could not tell": this
 * returns false unless it can positively see an enclosing type declaration.
 *
 * That last case is not hypothetical padding. `tree-sitter-c-sharp` fails
 * outright on Serilog's `ILogger.cs` — its `#if FEATURE_DEFAULT_INTERFACE`
 * directives produce an ERROR tree, and **134 of its 136 methods have `ERROR`
 * as their immediate parent**, with no `interface_declaration` anywhere above
 * them. Defaulting those to `private` is what produced 640 doors and 321 keys
 * on one level and made it unroutable. Requiring evidence for `private` makes
 * an unparseable file degrade to "public, unlocked" rather than to a locked
 * maze.
 */
function inCSharpPrivateByDefaultBody(node: Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (p.type === "class_declaration" || p.type === "struct_declaration" || p.type === "record_declaration") return true;
    // A nested type re-establishes its own default, so stop at the first one.
    if (p.type === "interface_declaration") return false;
  }
  return false;
}

export const csharp: Refinement = {
  refine: (node, entity) => {
    if (entity.kind !== "method") return entity;
    const mods = node.namedChildren.filter((c) => c.type === "modifier").map((c) => c.text);
    // Explicit modifiers always win — C# 8+ does allow them on interface
    // members — so this only changes what "no modifier" means.
    let visibility: Visibility = inCSharpPrivateByDefaultBody(node) ? "private" : "public";
    if (mods.includes("public")) visibility = "public";
    else if (mods.includes("protected")) visibility = "protected";
    else if (mods.includes("private")) visibility = "private";
    return { ...entity, visibility };
  },
};

// ---------------------------------------------------------------------------
// Scala — `modifiers` wraps an `access_modifier` child; `function_definition`
// covers both top-level defs and methods, refined via `template_body`
// ancestry (the body of a class/trait/object).
// ---------------------------------------------------------------------------
export const scala: Refinement = {
  refine: (node, entity) => {
    if (node.type !== "function_definition" && node.type !== "function_declaration") return entity;
    const isMethod = node.parent?.type === "template_body";
    if (!isMethod) return entity;
    const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
    const access = modifiers?.namedChildren.find((c) => c.type === "access_modifier")?.text ?? "";
    let visibility: Visibility = "public";
    if (access.startsWith("private")) visibility = "private";
    else if (access.startsWith("protected")) visibility = "protected";
    return { ...entity, kind: "method", visibility };
  },
};

// ---------------------------------------------------------------------------
// Rust — `function_item`/`function_signature_item` become "method" when
// nested in an `impl`/`trait` block's `declaration_list`; a `visibility_modifier`
// child (the `pub` keyword) means public, its absence means module-private.
// ---------------------------------------------------------------------------
function rustIsMember(node: Node): boolean {
  const container = node.parent?.parent;
  return container?.type === "impl_item" || container?.type === "trait_item";
}

export const rust: Refinement = {
  refine: (node, entity) => {
    if (node.type !== "function_item" && node.type !== "function_signature_item") return entity;
    if (!rustIsMember(node)) return entity;
    const isPublic = node.namedChildren.some((c) => c.type === "visibility_modifier");
    return { ...entity, kind: "method", visibility: isPublic ? "public" : "private" };
  },
};

// ---------------------------------------------------------------------------
// Go — no access modifiers; visibility follows the capitalization convention
// (exported/public iff the identifier starts uppercase). Structs/interfaces
// are declared as `type Foo struct{}` / `type Foo interface{}`, wrapped in a
// `type_spec` inside a `type_declaration` — the shared vocabulary can't
// express "only when the wrapped type is a struct/interface", so Go adds
// `type_spec` as an extra entity type and filters/reclassifies it here.
// Plain type aliases (`type MyInt int`) are filtered out entirely.
// ---------------------------------------------------------------------------
function goVisibility(name: string): Visibility {
  return /^[A-Z]/.test(name) ? "public" : "private";
}

export const go: Refinement = {
  extraEntityTypes: {
    type_spec: "class",
  },
  filter: (node) => {
    if (node.type !== "type_spec") return true;
    const inner = node.childForFieldName("type") ?? node.namedChildren[1];
    return inner?.type === "struct_type" || inner?.type === "interface_type";
  },
  refine: (node, entity) => {
    if (node.type === "type_spec") {
      const inner = node.childForFieldName("type") ?? node.namedChildren[1];
      const kind = inner?.type === "interface_type" ? "interface" : "class";
      return { ...entity, kind };
    }
    if (node.type === "function_declaration" || node.type === "method_declaration") {
      return { ...entity, visibility: goVisibility(entity.name) };
    }
    return entity;
  },
};

// ---------------------------------------------------------------------------
// C++ — `function_definition` becomes "method" when it lives directly inside
// a class/struct's `field_declaration_list`. Visibility follows the nearest
// preceding `access_specifier` sibling in that list, defaulting to `private`
// for `class` and `public` for `struct` (real C++ default-access rules).
// ---------------------------------------------------------------------------
function cppVisibility(node: Node): Visibility {
  const list = node.parent;
  // Unreachable: `cpp.refine`'s own `isMethod` check above already requires
  // `node.parent?.type === "field_declaration_list"` before this is ever
  // called, so `list` (== `node.parent`) can never be falsy here.
  /* v8 ignore next -- @preserve */
  if (!list) return "private";
  const classSpecifier = list.parent;
  let current: Visibility = classSpecifier?.type === "struct_specifier" ? "public" : "private";
  for (const sibling of list.namedChildren) {
    if (samePos(sibling, node)) break;
    if (sibling.type === "access_specifier") {
      const text = sibling.text;
      if (text.startsWith("public")) current = "public";
      else if (text.startsWith("private")) current = "private";
      else if (text.startsWith("protected")) current = "protected";
    }
  }
  return current;
}

export const cpp: Refinement = {
  refine: (node, entity) => {
    if (node.type !== "function_definition") return entity;
    const isMethod = node.parent?.type === "field_declaration_list";
    if (!isMethod) return entity;
    return { ...entity, kind: "method", visibility: cppVisibility(node) };
  },
};

// ---------------------------------------------------------------------------
// Objective-C — a method's real name is its full colon-joined selector
// (`add:with:`), assembled from the alternating `identifier`/`method_parameter`
// children — not just the first piece a generic name lookup would find.
// `method_declaration` (an `@interface`/`@protocol` prototype with no body) is
// dropped: its `method_definition` counterpart in the same file already
// captures the real, scorable implementation, so keeping both would count
// every method twice.
// ---------------------------------------------------------------------------
function objcSelector(node: Node): string {
  const hasParams = node.namedChildren.some((c) => c.type === "method_parameter");
  const parts = node.namedChildren
    .filter((c) => c.type === "identifier")
    .map((c) => (hasParams ? `${c.text}:` : c.text));
  return parts.join("") || "<anonymous>";
}

export const objc: Refinement = {
  filter: (node) => node.type !== "method_declaration",
  refine: (node, entity) => {
    if (node.type !== "method_definition") return entity;
    return { ...entity, name: objcSelector(node) };
  },
};

// ---------------------------------------------------------------------------
// Ruby — `private`/`protected`/`public` with no arguments are plain method
// calls that toggle the *current* visibility for every `def` after them in
// the same class/module body, rather than a per-method keyword. Walk back
// through preceding siblings to find the toggle in effect at this method.
// ---------------------------------------------------------------------------
function rubyVisibility(node: Node): Visibility {
  const body = node.parent;
  if (!body) return "public";
  let current: Visibility = "public";
  for (const sibling of body.namedChildren) {
    if (samePos(sibling, node)) break;
    if (sibling.type === "identifier" && (sibling.text === "private" || sibling.text === "protected" || sibling.text === "public")) {
      current = sibling.text;
    }
  }
  return current;
}

export const ruby: Refinement = {
  refine: (node, entity) => {
    if (node.type !== "method" && node.type !== "singleton_method") return entity;
    return { ...entity, visibility: rubyVisibility(node) };
  },
};
