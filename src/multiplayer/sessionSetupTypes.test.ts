// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import { guestPlayerId, HOST_PLAYER_ID, SessionSetupError } from "./sessionSetupTypes";

describe("roster id constants", () => {
  it("HOST_PLAYER_ID is the documented literal value", () => {
    expect(HOST_PLAYER_ID).toBe("host");
  });
});

describe("guestPlayerId", () => {
  it("produces a distinct id per join-order slot", () => {
    expect(guestPlayerId(1)).toBe("guest-1");
    expect(guestPlayerId(2)).toBe("guest-2");
    expect(guestPlayerId(3)).toBe("guest-3");
  });

  it("never collides with HOST_PLAYER_ID for any slot", () => {
    expect(guestPlayerId(1)).not.toBe(HOST_PLAYER_ID);
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

  it("supports the netcode-constants-mismatch code too", () => {
    const err = new SessionSetupError("netcode-constants-mismatch", "peers compiled different netcode constants");
    expect(err.code).toBe("netcode-constants-mismatch");
  });

  it("supports the handshake-timeout code too", () => {
    const err = new SessionSetupError("handshake-timeout", "handshake did not complete in time");
    expect(err.code).toBe("handshake-timeout");
  });
});
