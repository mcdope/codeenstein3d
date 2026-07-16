// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/** Triggers a browser download of `blob` as `filename` via a throwaway
 * object URL and a synthetic `<a download>` click — the standard
 * client-side download pattern, with no server involved. Shared by every
 * export feature (replay video, and any future export) rather than each
 * one reimplementing the same three calls. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
