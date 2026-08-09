// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BALANCE_EVENT_SCHEMA_VERSION as ENGINE_VERSION } from "../../src/engine/events";
import { BALANCE_EVENT_SCHEMA_VERSION, appendEvents, groupByRunAndLevel, readEventLog } from "./eventLog.mjs";

let dir;
let logPath;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeenstein-eventlog-"));
  logPath = path.join(dir, "nested", "run.ndjson");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const envelope = { sid: "s1", rid: "r1", lvl: 3 };

describe("schema version", () => {
  it("matches the engine's, so writer and emitter cannot drift", () => {
    expect(BALANCE_EVENT_SCHEMA_VERSION).toBe(ENGINE_VERSION);
  });
});

describe("appendEvents", () => {
  it("writes one JSON object per line with the envelope stamped on", () => {
    appendEvents(logPath, envelope, { events: [{ e: "kill", t: 1 }], dropped: 0 });
    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ v: BALANCE_EVENT_SCHEMA_VERSION, sid: "s1", rid: "r1", lvl: 3, e: "kill", t: 1 });
  });

  it("creates the parent directory on first write", () => {
    appendEvents(logPath, envelope, { events: [{ e: "shot", t: 0 }], dropped: 0 });
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it("appends rather than truncating, so a level boundary does not lose the level before it", () => {
    appendEvents(logPath, envelope, { events: [{ e: "shot", t: 0 }], dropped: 0 });
    appendEvents(logPath, { ...envelope, lvl: 4 }, { events: [{ e: "shot", t: 0 }], dropped: 0 });
    expect(readEventLog(logPath).events.map((e) => e.lvl)).toEqual([3, 4]);
  });

  it("ends every batch with a newline, so two appends cannot merge into one line", () => {
    appendEvents(logPath, envelope, { events: [{ e: "a", t: 0 }], dropped: 0 });
    appendEvents(logPath, envelope, { events: [{ e: "b", t: 0 }], dropped: 0 });
    expect(readEventLog(logPath).events.map((e) => e.e)).toEqual(["a", "b"]);
  });

  it("does nothing for an empty batch, which is the common per-level case", () => {
    expect(appendEvents(logPath, envelope, { events: [], dropped: 0 })).toBe(0);
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("tolerates a missing batch", () => {
    expect(appendEvents(logPath, envelope, null)).toBe(0);
  });

  it("records a bufferOverflow marker so a short total is never silently trusted", () => {
    appendEvents(logPath, envelope, { events: [{ e: "kill", t: 1 }], dropped: 17 });
    const events = readEventLog(logPath).events;
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ e: "bufferOverflow", dropped: 17 });
  });

  it("writes the overflow marker even when every event was dropped", () => {
    appendEvents(logPath, envelope, { events: [], dropped: 5 });
    expect(readEventLog(logPath).events).toMatchObject([{ e: "bufferOverflow", dropped: 5 }]);
  });

  it("lets an event field win over the envelope only for keys the schema reserves to it", () => {
    // `e` and `t` come from the event; `v`/`sid`/`rid`/`lvl` come from the
    // harness. Asserted so a future field named `lvl` cannot quietly shadow
    // the level number every grouping depends on.
    appendEvents(logPath, envelope, { events: [{ e: "kill", t: 9 }], dropped: 0 });
    expect(readEventLog(logPath).events[0]).toMatchObject({ lvl: 3, e: "kill", t: 9 });
  });
});

describe("readEventLog", () => {
  it("ignores blank lines", () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{"e":"a","t":0}\n\n{"e":"b","t":1}\n\n');
    expect(readEventLog(logPath).events.map((e) => e.e)).toEqual(["a", "b"]);
  });

  it("drops a truncated final line and flags it, keeping every complete record before it", () => {
    // The kill-mid-write case NDJSON was chosen for. Refusing the whole file
    // would throw away everything the run did manage to record.
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{"e":"a","t":0}\n{"e":"b","t":1}\n{"e":"c","t":2');
    const result = readEventLog(logPath);
    expect(result.events.map((e) => e.e)).toEqual(["a", "b"]);
    expect(result.truncatedTail).toBe(true);
    expect(result.malformed).toEqual([]);
  });

  it("reports a malformed line in the middle as real corruption, not a truncation", () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, '{"e":"a","t":0}\nnot json\n{"e":"c","t":2}\n');
    const result = readEventLog(logPath);
    expect(result.malformed).toEqual([2]);
    expect(result.truncatedTail).toBe(false);
    expect(result.events.map((e) => e.e)).toEqual(["a", "c"]);
  });

  it("reads an empty file as no events rather than throwing", () => {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "");
    expect(readEventLog(logPath)).toEqual({ events: [], malformed: [], truncatedTail: false });
  });
});

describe("groupByRunAndLevel", () => {
  it("groups by run then level, preserving order within a level", () => {
    const grouped = groupByRunAndLevel([
      { rid: "r1", lvl: 1, e: "a" },
      { rid: "r1", lvl: 2, e: "b" },
      { rid: "r2", lvl: 1, e: "c" },
      { rid: "r1", lvl: 1, e: "d" },
    ]);
    expect([...grouped.keys()]).toEqual(["r1", "r2"]);
    expect(grouped.get("r1").get(1).map((e) => e.e)).toEqual(["a", "d"]);
    expect(grouped.get("r1").get(2).map((e) => e.e)).toEqual(["b"]);
    expect(grouped.get("r2").get(1).map((e) => e.e)).toEqual(["c"]);
  });

  it("returns an empty map for no events", () => {
    expect(groupByRunAndLevel([]).size).toBe(0);
  });
});
