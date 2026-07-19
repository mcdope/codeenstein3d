// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { GUEST_PLAYER_ID, HOST_PLAYER_ID, SessionSetupError } from "./sessionSetupTypes";

describe("roster id constants", () => {
  it("are the documented literal values", () => {
    expect(HOST_PLAYER_ID).toBe("host");
    expect(GUEST_PLAYER_ID).toBe("guest");
  });

  it("are mutually distinct", () => {
    expect(HOST_PLAYER_ID).not.toBe(GUEST_PLAYER_ID);
  });
});

describe("SessionSetupError", () => {
  it("carries the given code and message, with a distinct name", () => {
    const err = new SessionSetupError("build-version-mismatch", "peers are on different builds");
    expect(err.code).toBe("build-version-mismatch");
    expect(err.message).toBe("peers are on different builds");
    expect(err.name).toBe("SessionSetupError");
    expect(err).toBeInstanceOf(Error);
  });

  it("supports the protocol-error code too", () => {
    const err = new SessionSetupError("protocol-error", "map-end arrived incomplete");
    expect(err.code).toBe("protocol-error");
  });
});
