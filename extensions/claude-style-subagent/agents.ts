import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  thinking?: string;
  systemPrompt: string;
  source: "package" | "user" | "project";
  filePath: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  packageAgentsDir: string;
  projectAgentsDir: string | null;
  userAgentsDir: string;
}

function parseCsv(value: unknown): string[] | undefined {
  if (typeof value !== "string") return undefined;
  const values = value.split(",").map((item) => item.trim()).filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function loadAgentsFromDir(dir: string, source: "package" | "user" | "project"): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
    } catch {
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseCsv(frontmatter.tools),
      model: frontmatter.model,
      thinking: frontmatter.thinking,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

function isDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (isDirectory(candidate)) return candidate;

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function discoverAgents(
  cwd: string,
  scope: AgentScope = "user",
  projectTrusted = true,
): AgentDiscoveryResult {
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageAgentsDir = path.join(packageRoot, "agents");
  const userAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);

  const packageAgents = loadAgentsFromDir(packageAgentsDir, "package");
  const userAgents = scope === "project" ? [] : loadAgentsFromDir(userAgentsDir, "user");
  const projectAgents = !projectTrusted || scope === "user" || !projectAgentsDir
    ? []
    : loadAgentsFromDir(projectAgentsDir, "project");

  const merged = new Map<string, AgentConfig>();
  for (const agent of packageAgents) merged.set(agent.name, agent);
  for (const agent of userAgents) merged.set(agent.name, agent);
  for (const agent of projectAgents) merged.set(agent.name, agent);

  if (scope === "project") {
    merged.clear();
    for (const agent of packageAgents) merged.set(agent.name, agent);
    for (const agent of projectAgents) merged.set(agent.name, agent);
  }

  return { agents: Array.from(merged.values()), packageAgentsDir, projectAgentsDir, userAgentsDir };
}

export function describeAgents(agents: AgentConfig[]): string {
  if (agents.length === 0) return "none";
  return agents.map((agent) => `${agent.name} (${agent.source}): ${agent.description}`).join("\n");
}
