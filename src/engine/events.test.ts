// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import { describe, expect, it } from "vitest";
import {
  BALANCE_EVENT_SCHEMA_VERSION,
  MAX_BUFFERED_EVENTS,
  createEventLog,
  drainEvents,
  recordEvent,
} from "./events";

describe("createEventLog", () => {
  it("starts empty with nothing dropped", () => {
    expect(createEventLog()).toEqual({ events: [], dropped: 0 });
  });
});

describe("recordEvent", () => {
  it("stamps the type and level time into the envelope", () => {
    const log = createEventLog();
    recordEvent(log, "kill", 12.5);
    expect(log.events).toEqual([{ e: "kill", t: 12.5 }]);
  });

  it("spreads per-type fields alongside the envelope", () => {
    const log = createEventLog();
    recordEvent(log, "damageDealt", 3, { eid: 7, amt: 22, hpBefore: 30, hpAfter: 8 });
    expect(log.events[0]).toEqual({ e: "damageDealt", t: 3, eid: 7, amt: 22, hpBefore: 30, hpAfter: 8 });
  });

  it("keeps events in emission order, which is what every timeline metric reads", () => {
    const log = createEventLog();
    recordEvent(log, "shot", 1);
    recordEvent(log, "hit", 2);
    recordEvent(log, "kill", 3);
    expect(log.events.map((e) => e.e)).toEqual(["shot", "hit", "kill"]);
  });

  it("records a zero level time rather than treating it as missing", () => {
    const log = createEventLog();
    recordEvent(log, "levelStart", 0);
    expect(log.events[0].t).toBe(0);
  });
});

describe("overflow", () => {
  it("stops recording at the cap and counts what it discarded", () => {
    const log = createEventLog();
    // Fill directly rather than through recordEvent 200k times -- the cap is
    // what is under test, not push throughput.
    log.events = new Array(MAX_BUFFERED_EVENTS).fill({ e: "shot", t: 0 });
    recordEvent(log, "kill", 99);
    recordEvent(log, "kill", 100);
    expect(log.events.length).toBe(MAX_BUFFERED_EVENTS);
    expect(log.dropped).toBe(2);
  });

  it("truncates the tail rather than evicting the head", () => {
    // A ring buffer would drop the earliest events, which is indistinguishable
    // from a level that started late -- and every economy metric here is
    // cumulative, so a missing prefix corrupts totals instead of truncating
    // them. Losing the tail with an explicit count is the honest failure.
    const log = createEventLog();
    recordEvent(log, "levelStart", 0, { marker: "first" });
    log.events.length = MAX_BUFFERED_EVENTS;
    log.events.fill({ e: "shot", t: 0 }, 1);
    recordEvent(log, "kill", 5);
    expect(log.events[0]).toEqual({ e: "levelStart", t: 0, marker: "first" });
    expect(log.dropped).toBe(1);
  });
});

describe("drainEvents", () => {
  it("returns what was buffered and leaves the log empty", () => {
    const log = createEventLog();
    recordEvent(log, "shot", 1);
    recordEvent(log, "hit", 2);
    const drained = drainEvents(log);
    expect(drained.events.map((e) => e.e)).toEqual(["shot", "hit"]);
    expect(log.events).toEqual([]);
    expect(log.dropped).toBe(0);
  });

  it("hands over the array itself rather than copying it", () => {
    // Copying a six-figure array across the Playwright boundary would be the
    // one genuinely expensive thing in this module.
    const log = createEventLog();
    recordEvent(log, "shot", 1);
    const before = log.events;
    expect(drainEvents(log).events).toBe(before);
    expect(log.events).not.toBe(before);
  });

  it("carries the dropped count across and resets it", () => {
    const log = createEventLog();
    log.dropped = 4;
    expect(drainEvents(log).dropped).toBe(4);
    expect(log.dropped).toBe(0);
  });

  it("keeps recording after a drain", () => {
    const log = createEventLog();
    recordEvent(log, "shot", 1);
    drainEvents(log);
    recordEvent(log, "kill", 2);
    expect(log.events).toEqual([{ e: "kill", t: 2 }]);
  });

  it("drains empty without complaint, which is the common per-level case", () => {
    expect(drainEvents(createEventLog())).toEqual({ events: [], dropped: 0 });
  });
});

describe("schema version", () => {
  it("is a positive integer a reader can compare against", () => {
    expect(Number.isInteger(BALANCE_EVENT_SCHEMA_VERSION)).toBe(true);
    expect(BALANCE_EVENT_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
