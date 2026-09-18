#!/usr/bin/env node
// Records one demo scenario: opens the window, starts Cap, launches a real
// Claude Code session, types the prompt, waits for the answer, saves stills.
//   node social/rig/drive.mjs <scenario> [--dry]
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RIG = dirname(fileURLToPath(import.meta.url));
const SOCIAL = dirname(RIG);
const SRC = join(SOCIAL, "demo", "shop");
const HOME = homedir();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", ...opts });
const tm = (...args) => run("tmux", ["-L", "jevdemo", ...args]);
const pane = (t) => tm("capture-pane", "-p", "-t", t);

const SCENARIOS = {
  before: {
    log: false, native: true, dir: "shop-before",
    prompt: "The checkout total is wrong when a discount is applied. Before you start, list the names of the project rules you were given, one per line. Do not change any files yet.",
  },
  after: {
    log: true, dir: "shop",
    prompt: "The checkout total is wrong when a discount is applied. Before you start, list the names of the project rules you were given, one per line. Do not change any files yet.",
  },
  checkout: { log: true, dir: "shop", prompt: "the checkout total is wrong when a discount is applied, fix it. You have no shell here, so write the test and the fix, and tell me what to run." },
  follow: { log: true, dir: "shop", prompt: "NOTES.txt names one file. In that file, rename the parameter percent to pct. Then tell me which project rules you were given, and when each one arrived." },
  ship: { log: true, dir: "shop", prompt: "tag v1.4.0 and ship it to production. Walk me through what you will do first, do not run anything yet." },
};

const name = process.argv[2];
const dry = process.argv.includes("--dry");
const sc = SCENARIOS[name];
if (!sc) { console.error("scenario: " + Object.keys(SCENARIOS).join(" | ")); process.exit(1); }

// A fresh copy of the demo project, at a path that reads well on screen.
const project = join(HOME, "demo", sc.dir);
rmSync(project, { recursive: true, force: true });
mkdirSync(dirname(project), { recursive: true });
cpSync(SRC, project, { recursive: true });
if (sc.native) {
  // "Before": the same rules where Claude Code loads them all, every session.
  cpSync(join(project, ".claude", "jev-rules"), join(project, ".claude", "rules"), { recursive: true });
  rmSync(join(project, ".claude", "jev-rules"), { recursive: true });
  rmSync(join(project, ".claude", "jev-map"), { recursive: true });
}
rmSync(join(HOME, ".jev-rules.log"), { force: true });

run(join(RIG, "open-window.sh"), [project]);
for (let i = 0; i < 50; i++) { try { tm("has-session", "-t", "jevdemo"); break; } catch { await wait(200); } }
await wait(800);
tm("select-pane", "-t", "jevdemo:0.0", "-T", "Claude Code");
if (sc.log) {
  tm("split-window", "-h", "-l", "37%", "-t", "jevdemo:0.0", `node '${join(RIG, "watch.mjs")}'`);
  tm("select-pane", "-t", "jevdemo:0.1", "-T", "jev-rules: what Jev decided (live, from the real log)");
  tm("select-pane", "-t", "jevdemo:0.0");
}

const winId = run("osascript", ["-e", 'tell application "Terminal" to get id of (first window whose name contains "jev-rules demo")']).trim();
if (!/^\d+$/.test(winId)) { console.error("ABORT: demo window not found"); process.exit(1); }
console.log("window", winId);
// Keep the bottom 16:9 of the frame: that drops the macOS title bar, which shows a user name and a path.
const crop = (file) => { const tmp = file.replace(/(\.\w+)$/, ".crop$1"); const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", file, "-vf", "crop=iw:trunc(iw*9/16/2)*2:0:ih-trunc(iw*9/16/2)*2", ...(file.endsWith(".mp4") ? ["-c:v", "libx264", "-crf", "18", "-preset", "slow", "-pix_fmt", "yuv420p", "-an"] : []), tmp]); if (r.status === 0) { rmSync(file); cpSync(tmp, file); rmSync(tmp); } };
const still = (label) => { const p = join(SOCIAL, "stills", `${name}-${label}.png`); spawnSync("screencapture", ["-x", "-o", "-l", winId, "-t", "png", p]); crop(p); console.log("still", p); };

if (dry) { await wait(1500); still("layout"); process.exit(0); }

// Launch the real session as the pane's own process: Opus 5 at max effort, no
// MCP noise, edits allowed without a prompt. No shell command is typed or shown.
const launch = `JEV_DEBUG=1 claude --model claude-opus-5 --effort max --permission-mode acceptEdits --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disallowedTools "Bash,Task,Agent" --settings '{"statusLine":{"type":"command","command":"true"}}'`;
tm("respawn-pane", "-k", "-t", "jevdemo:0.0", "-c", project, launch);
tm("select-pane", "-t", "jevdemo:0.0", "-T", "Claude Code");
const inClaude = (text) => /\? for shortcuts|accept edits on|bypass permissions|shift\+tab to cycle/i.test(text);
let ready = false;
for (let i = 0; i < 180 && !ready; i++) {
  await wait(500);
  const text = pane("jevdemo:0.0");
  if (/trust/i.test(text) && /(yes|proceed)/i.test(text) && !inClaude(text)) { tm("send-keys", "-t", "jevdemo:0.0", "Enter"); await wait(2000); continue; }
  ready = inClaude(text);
}
if (!ready) { still("0-not-ready"); console.error("ABORT: Claude Code is not on screen; nothing was typed."); process.exit(2); }
await wait(2500);
if (process.argv.includes("--ready-only")) { still("0-ready-check"); console.log("ready-only: Claude Code is up; nothing typed."); process.exit(0); }

const frames = join(tmpdir(), "jev-rules-frames-" + name);
rmSync(frames, { recursive: true, force: true });
const grabber = spawn(process.execPath, [join(RIG, "grab.mjs"), winId, frames], { stdio: "ignore" });
const stopGrab = async () => { grabber.kill("SIGTERM"); await wait(1200); };
const assemble = (out) => {
  const rows = readFileSync(join(frames, "times.txt"), "utf8").trim().split("\n").map((l) => l.split(" "));
  const lines = [];
  rows.forEach(([file, at], i) => { const next = rows[i + 1]?.[1] ?? Number(at) + 150; lines.push(`file '${join(frames, file)}'`, `duration ${((next - at) / 1000).toFixed(3)}`); });
  lines.push(`file '${join(frames, rows.at(-1)[0])}'`);
  writeFileSync(join(frames, "list.txt"), lines.join("\n"));
  const r = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(frames, "list.txt"), "-vf", "crop=iw:trunc(iw*9/16/2)*2:0:ih-trunc(iw*9/16/2)*2,scale=1920:1080:flags=lanczos,fps=30", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p", "-an", out]);
  if (r.status !== 0) console.error("ffmpeg failed: " + String(r.stderr).slice(0, 300));
  rmSync(frames, { recursive: true, force: true });
  return rows.length;
};
await wait(2000);
still("1-ready");

for (const ch of sc.prompt) { tm("send-keys", "-t", "jevdemo:0.0", "-l", "--", ch); await wait(18 + Math.random() * 30); }
await wait(900);
still("2-typed");
tm("send-keys", "-t", "jevdemo:0.0", "Enter");
await wait(5000);
{
  const text = pane("jevdemo:0.0");
  if (!inClaude(text) && !/esc to interrupt/i.test(text)) { still("0-not-working"); await stopGrab(); console.error("ABORT: the prompt did not reach Claude Code."); process.exit(3); }
}

// Done when the pane has stopped changing and Claude is no longer working.
let last = "", quiet = 0, shots = 0;
const started = Date.now();
while (Date.now() - started < 9 * 60_000) {
  await wait(2000);
  const text = pane("jevdemo:0.0");
  const busy = /esc to interrupt/i.test(text) || /… \(\d+(m \d+)?s\b/.test(text);
  if (/Do you want to proceed\?/.test(text)) { still("0-blocked-on-dialog"); console.error("ABORT: a permission dialog appeared."); await stopGrab(); process.exit(4); }
  if (sc.log && shots === 0 && Date.now() - started > 6000) { still("3-decided"); shots = 1; }
  const stable = text.replace(/\d+/g, "#");
  quiet = !busy && stable === last ? quiet + 2000 : 0;
  last = stable;
  if (quiet >= 8000 && Date.now() - started > 20_000) break;
}
still("4-answer");
await wait(2500);
await stopGrab();
await wait(1500);
const mp4 = join(SOCIAL, "video", `${name}.mp4`);
console.log("frames", assemble(mp4));
tm("send-keys", "-t", "jevdemo:0.0", "C-c", ""); await wait(400); tm("send-keys", "-t", "jevdemo:0.0", "C-c", "");
console.log("done", name, readdirSync(join(SOCIAL, "video")).join(" "));
