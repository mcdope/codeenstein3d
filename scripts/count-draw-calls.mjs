// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Tobias Bäumer — part of Codeenstein 3D (see LICENSE)

/**
 * One-shot draw-call census for the frame-budget audit (Phase 2): wraps every
 * CanvasRenderingContext2D method and state setter with counters BEFORE any
 * page script runs, loads a corpus level the same way the perf bench does,
 * and prints per-frame averages over a measured window.
 *
 * Injected instrumentation only — zero src edits. NOT for timing runs (the
 * wrappers themselves cost time); pacing/busy numbers come from perf:bench.
 *
 *   node scripts/count-draw-calls.mjs [--file balancing_corpus/...] [--seconds 5]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installOpfsWorkspace } from "./lib/opfsWorkspace.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FILE = "laravel/src/Illuminate/Database/Query/Builder.php";

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE, seconds: 5, url: process.env.CODEENSTEIN_PERF_URL ?? "http://localhost:5199" };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--file") args.file = argv[++i];
    else if (argv[i] === "--seconds") args.seconds = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const abs = path.join(ROOT, "balancing_corpus", args.file);
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await page.addInitScript(() => {
    const counts = {};
    const bump = (k, n = 1) => {
      counts[k] = (counts[k] ?? 0) + n;
    };
    const proto = CanvasRenderingContext2D.prototype;
    for (const name of ["drawImage", "fillRect", "putImageData", "getImageData", "createImageData", "createLinearGradient", "fillText", "strokeText", "fill", "stroke", "strokeRect", "clearRect", "beginPath", "save", "restore", "arc", "rect", "moveTo", "lineTo", "setTransform", "translate", "scale", "rotate", "clip"]) {
      const orig = proto[name];
      if (typeof orig !== "function") continue;
      proto[name] = function (...a) {
        bump(name);
        return orig.apply(this, a);
      };
    }
    for (const prop of ["fillStyle", "strokeStyle", "globalAlpha", "globalCompositeOperation", "font", "textAlign", "lineWidth", "imageSmoothingEnabled"]) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc?.set) continue;
      Object.defineProperty(proto, prop, {
        ...desc,
        set(v) {
          bump(`set:${prop}`);
          return desc.set.call(this, v);
        },
      });
    }
    let frames = 0;
    const tick = () => {
      frames += 1;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    window.__drawCounts = {
      reset() {
        for (const k of Object.keys(counts)) delete counts[k];
        frames = 0;
      },
      snapshot() {
        return { frames, counts: { ...counts } };
      },
    };
  });

  const name = path.basename(abs);
  await installOpfsWorkspace(page, { dirName: `count-${name}`, files: { [name]: fs.readFileSync(abs, "utf8") } });
  await page.goto(`${args.url}/?perfDebug=1&seed=0xc0de`);
  await page.click("#select-workspace");
  await page.waitForTimeout(15000); // generous: map gen for a 160x160 monster
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
  await page.waitForTimeout(2000);

  await page.evaluate(() => window.__drawCounts.reset());
  await page.waitForTimeout(args.seconds * 1000);
  const { frames, counts } = await page.evaluate(() => window.__drawCounts.snapshot());

  console.log(`frames observed: ${frames}`);
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of rows) console.log(`${(v / frames).toFixed(1).padStart(10)}  /frame  ${k}  (total ${v})`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
