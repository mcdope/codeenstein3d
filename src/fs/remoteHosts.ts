// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** The forge registry: one place that knows every supported host. */

import { CODEBERG_HOST } from "./codeberg";
import { GITHUB_HOST } from "./github";
import { GITLAB_HOST } from "./gitlab";
import type { RemoteHost, RemoteHostId, RemoteRepoRef } from "./remoteHost";

/** Order matters for `detectRemoteHost`: the first host whose parser accepts
 * an input wins, so hosts with a URL-anchored parser must precede any that
 * accept a bare `owner/repo` shorthand. */
export const REMOTE_HOSTS: readonly RemoteHost[] = [GITHUB_HOST, GITLAB_HOST, CODEBERG_HOST];

export function remoteHostById(id: RemoteHostId): RemoteHost {
  const host = REMOTE_HOSTS.find((h) => h.id === id);
  /* v8 ignore next -- @preserve: unreachable, RemoteHostId is exhaustive over the registry */
  if (!host) throw new Error(`Unknown remote host "${id}"`);
  return host;
}

/**
 * Works out which forge an input names, so the player can paste any repo URL
 * without first picking a host from a menu.
 *
 * A full URL identifies its host unambiguously. A bare `owner/repo` shorthand
 * does not, and is resolved to `fallback` — GitHub by default, because that is
 * the host the shorthand has always meant here and saved runs recorded before
 * the other hosts existed rely on it.
 */
export function detectRemoteHost(
  input: string,
  fallback: RemoteHostId = "github",
): { host: RemoteHost; ref: RemoteRepoRef } | null {
  const looksLikeUrl = /[a-z0-9-]+\.[a-z]{2,}\//i.test(input.trim());
  for (const host of REMOTE_HOSTS) {
    const ref = host.parseInput(input);
    // A shorthand parses against every host, so only a URL may pick one here;
    // otherwise the first registered host would silently claim every input.
    if (ref && looksLikeUrl) return { host, ref };
  }
  if (looksLikeUrl) return null;
  const host = remoteHostById(fallback);
  const ref = host.parseInput(input);
  return ref ? { host, ref } : null;
}
