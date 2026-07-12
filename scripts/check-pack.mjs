import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || result.stdout);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout)[0];
const paths = new Set(report.files.map((file) => file.path));
const required = [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "assets/gallery/claude-style-subagent.png",
  "assets/screenshots/agent-dock.png",
  "assets/screenshots/subagent-manager.png",
  "assets/screenshots/foreground-subagent.png",
  "agents/reviewer.md",
  "extensions/claude-style-subagent/index.ts",
];
const forbiddenPrefixes = [".pi/", "coverage/", "node_modules/", "prompts/", "prototype/", "scripts/", "test/"];

const missing = required.filter((path) => !paths.has(path));
const forbidden = [...paths].filter((path) => forbiddenPrefixes.some((prefix) => path.startsWith(prefix)));
if (missing.length || forbidden.length) {
  if (missing.length) console.error(`Missing package files:\n- ${missing.join("\n- ")}`);
  if (forbidden.length) console.error(`Forbidden package files:\n- ${forbidden.join("\n- ")}`);
  process.exit(1);
}

console.log(`Package dry-run OK: ${report.entryCount} files, ${report.size} bytes`);
