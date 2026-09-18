#!/usr/bin/env node
// Captures one window by its id, several times a second, until told to stop.
// It sees only that window, even when other windows cover it, so nothing else
// on the screen can end up in a clip. Usage: grab.mjs <window id> <frames dir>
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [id, dir] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
let running = true;
process.on("SIGTERM", () => { running = false; });
process.on("SIGINT", () => { running = false; });
for (let n = 0; running; n++) {
  const file = `f${String(n).padStart(6, "0")}.jpg`;
  const at = Date.now();
  spawnSync("screencapture", ["-x", "-o", "-l", id, "-t", "jpg", join(dir, file)]);
  appendFileSync(join(dir, "times.txt"), `${file} ${at}\n`);
}
