// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import type { RemoteFileHandle } from "./workspace";
import { DEMO_CAMPAIGN_NAME, loadDemoCampaignTree } from "./demoCampaign";

describe("loadDemoCampaignTree", () => {
  it("builds a root directory node named/pathed after the demo campaign", () => {
    const tree = loadDemoCampaignTree();
    expect(tree.name).toBe(DEMO_CAMPAIGN_NAME);
    expect(tree.path).toBe(DEMO_CAMPAIGN_NAME);
    expect(tree.kind).toBe("directory");
  });

  it("includes every bundled demo-campaign file as a flat child, sorted alphabetically", () => {
    const tree = loadDemoCampaignTree();
    const names = tree.children!.map((c) => c.name);
    expect(names).toContain("main.c");
    expect(names).toContain("stage02_bootstrap.sh");
    expect(names).toContain("stage17_the_monolith.php");
    expect(names.every((n) => n === "main.c" || /^stage\d+_/.test(n))).toBe(true);
    const sorted = [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    expect(names).toEqual(sorted); // every entry is a file, so directories-first is moot here
  });

  it("paths each child under the campaign name", () => {
    const tree = loadDemoCampaignTree();
    const main = tree.children!.find((c) => c.name === "main.c")!;
    expect(main.path).toBe(`${DEMO_CAMPAIGN_NAME}/main.c`);
    expect(main.kind).toBe("file");
  });

  it("resolves a file's handle to its real, non-empty source text", async () => {
    const tree = loadDemoCampaignTree();
    const main = tree.children!.find((c) => c.name === "main.c")!;
    const file = await (main.handle as RemoteFileHandle).getFile();
    const text = await file.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("main"); // main.c genuinely defines a main()
  });

  it("gives the synthetic root directory a handle that always rejects getFile()", async () => {
    const tree = loadDemoCampaignTree();
    await expect((tree.handle as RemoteFileHandle).getFile()).rejects.toThrow("Not a file");
  });

  it("is stateless — repeated calls return an equivalent, independently-usable tree", () => {
    const first = loadDemoCampaignTree();
    const second = loadDemoCampaignTree();
    expect(second.children!.map((c) => c.name)).toEqual(first.children!.map((c) => c.name));
  });
});
