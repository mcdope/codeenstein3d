// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { detectRemoteHost, REMOTE_HOSTS, remoteHostById } from "./remoteHosts";
import { formatRepoRef, parseRemoteRepoPath } from "./remoteHost";

describe("detectRemoteHost", () => {
  it("reads the host off a full URL", () => {
    expect(detectRemoteHost("https://github.com/owner/repo")?.host.id).toBe("github");
    expect(detectRemoteHost("https://gitlab.com/group/project")?.host.id).toBe("gitlab");
    expect(detectRemoteHost("https://codeberg.org/owner/repo")?.host.id).toBe("codeberg");
  });

  it("works without a scheme, since that is how people paste", () => {
    expect(detectRemoteHost("gitlab.com/group/project")?.host.id).toBe("gitlab");
    expect(detectRemoteHost("codeberg.org/owner/repo")?.host.id).toBe("codeberg");
  });

  it("resolves a bare owner/repo shorthand to GitHub", () => {
    // Load-bearing for compatibility, not a preference: the shorthand has
    // always meant GitHub here, and saved runs recorded before the other
    // hosts existed store exactly this and must keep resuming correctly.
    const found = detectRemoteHost("owner/repo");
    expect(found?.host.id).toBe("github");
    expect(found?.ref).toEqual({ owner: "owner", repo: "repo" });
  });

  it("does not let one host claim another host's URL", () => {
    // The bug this pins, caught by a UI test rather than by review: GitLab's
    // parser accepts arbitrarily deep namespaces to support nested groups,
    // which made it read `codeberg.org/owner/repo` as the project `repo` in
    // a group called `codeberg.org/owner`, and it is registered before
    // Codeberg so it won.
    expect(detectRemoteHost("https://codeberg.org/owner/repo")?.host.id).toBe("codeberg");
    expect(detectRemoteHost("codeberg.org/owner/repo")?.host.id).toBe("codeberg");
    expect(detectRemoteHost("https://github.com/owner/repo")?.host.id).toBe("github");
  });

  it("returns null for an unknown host and for junk", () => {
    expect(detectRemoteHost("https://example.com/owner/repo")).toBeNull();
    expect(detectRemoteHost("not a repo ref!!")).toBeNull();
    expect(detectRemoteHost("")).toBeNull();
    expect(detectRemoteHost("owner")).toBeNull();
  });

  it("honours an explicit fallback for shorthand input", () => {
    expect(detectRemoteHost("group/project", "gitlab")?.host.id).toBe("gitlab");
    // …but never lets the fallback override a URL that names its own host.
    expect(detectRemoteHost("https://github.com/o/r", "gitlab")?.host.id).toBe("github");
  });
});

describe("remoteHostById", () => {
  it("round-trips every registered host", () => {
    for (const host of REMOTE_HOSTS) expect(remoteHostById(host.id)).toBe(host);
  });

  it("gives every host a distinct id and a label", () => {
    expect(new Set(REMOTE_HOSTS.map((h) => h.id)).size).toBe(REMOTE_HOSTS.length);
    for (const host of REMOTE_HOSTS) expect(host.label.length).toBeGreaterThan(0);
  });
});

describe("parseRemoteRepoPath", () => {
  it("splits at the LAST separator, so nested groups survive a round trip", () => {
    // `a/b/c` is project `c` in group `a/b`. Splitting at the first separator
    // would resume a nested GitLab project against a repo that does not exist.
    expect(parseRemoteRepoPath("a/b/c")).toEqual({ owner: "a/b", repo: "c" });
    expect(parseRemoteRepoPath("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });

  it("round-trips whatever formatRepoRef produced", () => {
    for (const ref of [{ owner: "o", repo: "r" }, { owner: "a/b", repo: "c" }]) {
      expect(parseRemoteRepoPath(formatRepoRef(ref))).toEqual(ref);
    }
  });

  it("rejects anything that is not a path", () => {
    for (const bad of ["", "owner", "/repo", "owner/", "own er/repo"]) {
      expect(parseRemoteRepoPath(bad), bad).toBeNull();
    }
  });
});
