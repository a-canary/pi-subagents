/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { KNOWN_FIELDS } from "./agent-serializer.js";
import { parseChain } from "./chain-serializer.js";
import { mergeAgentsForScope } from "./agent-selection.js";
import { parseFrontmatter } from "./frontmatter.js";

export type AgentScope = "user" | "project" | "both";

export type AgentSource = "builtin" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	mcpDirectTools?: string[];
	model?: string;
	thinking?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
	skills?: string[];
	extensions?: string[];
	// Chain behavior fields
	output?: string;
	defaultReads?: string[];
	defaultProgress?: boolean;
	interactive?: boolean;
	extraFields?: Record<string, string>;
}

export interface ChainStepConfig {
	agent: string;
	task: string;
	output?: string | false;
	reads?: string[] | false;
	model?: string;
	skills?: string[] | false;
	progress?: boolean;
}

export interface ChainConfig {
	name: string;
	description: string;
	source: AgentSource;
	filePath: string;
	steps: ChainStepConfig[];
	extraFields?: Record<string, string>;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const rawTools = frontmatter.tools
			?.split(",")
			.map((t) => t.trim())
			.filter(Boolean);

		const mcpDirectTools: string[] = [];
		const tools: string[] = [];
		if (rawTools) {
			for (const tool of rawTools) {
				if (tool.startsWith("mcp:")) {
					mcpDirectTools.push(tool.slice(4));
				} else {
					tools.push(tool);
				}
			}
		}

		// Parse defaultReads as comma-separated list (like tools)
		const defaultReads = frontmatter.defaultReads
			?.split(",")
			.map((f) => f.trim())
			.filter(Boolean);

		const skillStr = frontmatter.skill || frontmatter.skills;
		const skills = skillStr
			?.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		let extensions: string[] | undefined;
		if (frontmatter.extensions !== undefined) {
			extensions = frontmatter.extensions
				.split(",")
				.map((e) => e.trim())
				.filter(Boolean);
		}

		const extraFields: Record<string, string> = {};
		for (const [key, value] of Object.entries(frontmatter)) {
			if (!KNOWN_FIELDS.has(key)) extraFields[key] = value;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools.length > 0 ? tools : undefined,
			mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			systemPrompt: body,
			source,
			filePath,
			skills: skills && skills.length > 0 ? skills : undefined,
			extensions,
			// Chain behavior fields
			output: frontmatter.output,
			defaultReads: defaultReads && defaultReads.length > 0 ? defaultReads : undefined,
			defaultProgress: frontmatter.defaultProgress === "true",
			interactive: frontmatter.interactive === "true",
			extraFields: Object.keys(extraFields).length > 0 ? extraFields : undefined,
		});
	}

	return agents;
}

function loadChainsFromDir(dir: string, source: AgentSource): ChainConfig[] {
	const chains: ChainConfig[] = [];

	if (!fs.existsSync(dir)) {
		return chains;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return chains;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".chain.md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		try {
			chains.push(parseChain(content, source, filePath));
		} catch {
			continue;
		}
	}

	return chains;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Discover agents from extension directories.
 * Scans ~/.pi/agent/extensions/{extension}/agents/ and .pi/extensions/{extension}/agents/
 */
function discoverExtensionAgents(cwd: string, scope: AgentScope): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const extensionDirs: string[] = [];

	// Global extensions
	const globalExtensionsDir = path.join(os.homedir(), ".pi", "agent", "extensions");
	if (isDirectory(globalExtensionsDir)) {
		try {
			const entries = fs.readdirSync(globalExtensionsDir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() || entry.isSymbolicLink()) {
					extensionDirs.push(path.join(globalExtensionsDir, entry.name, "agents"));
				}
			}
		} catch {}
	}

	// Project-local extensions (only if scope includes project)
	if (scope !== "user") {
		let currentDir = cwd;
		while (true) {
			const projectExtensionsDir = path.join(currentDir, ".pi", "extensions");
			if (isDirectory(projectExtensionsDir)) {
				try {
					const entries = fs.readdirSync(projectExtensionsDir, { withFileTypes: true });
					for (const entry of entries) {
						if (entry.isDirectory() || entry.isSymbolicLink()) {
							extensionDirs.push(path.join(projectExtensionsDir, entry.name, "agents"));
						}
					}
				} catch {}
			}

			const parentDir = path.dirname(currentDir);
			if (parentDir === currentDir) break;
			currentDir = parentDir;
		}
	}

	// Load agents from all discovered extension agent directories
	for (const agentsDir of extensionDirs) {
		const extensionAgents = loadAgentsFromDir(agentsDir, "user");
		agents.push(...extensionAgents);
	}

	return agents;
}

/**
 * Discover agents from installed pi packages.
 * Reads ~/.pi/agent/settings.json packages, resolves each package,
 * and loads agents from pi.agents directories declared in package.json.
 */
function discoverPackageAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const settingsPath = path.join(os.homedir(), ".pi", "agent", "settings.json");

	if (!fs.existsSync(settingsPath)) return agents;

	let settings: { packages?: string[] };
	try {
		settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
	} catch {
		return agents;
	}

	if (!settings.packages) return agents;

	for (const pkgRef of settings.packages) {
		// Resolve package path
		let pkgPath: string;
		if (pkgRef.startsWith("npm:")) {
			// npm package - resolve from node_modules
			const pkgName = pkgRef.slice(4);
			const globalExtensionsDir = path.join(os.homedir(), ".pi", "agent", "extensions");
			pkgPath = path.join(globalExtensionsDir, "node_modules", pkgName);
		} else if (pkgRef.startsWith("git:")) {
			// git package - resolve from git directory
			const repoName = pkgRef.slice(4).replace(/^github\.com\//, "");
			pkgPath = path.join(os.homedir(), ".pi", "agent", "git", repoName);
		} else if (pkgRef.startsWith("/") || pkgRef.startsWith("./") || pkgRef.startsWith("../")) {
			// Local path - resolve relative to settings file
			pkgPath = path.resolve(path.dirname(settingsPath), pkgRef);
		} else {
			continue;
		}

		// Read package.json to find pi.agents
		const pkgJsonPath = path.join(pkgPath, "package.json");
		if (!fs.existsSync(pkgJsonPath)) continue;

		let pkgJson: { pi?: { agents?: string[] } };
		try {
			pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
		} catch {
			continue;
		}

		const agentDirs = pkgJson.pi?.agents;
		if (!agentDirs) continue;

		for (const agentDir of agentDirs) {
			const fullPath = path.join(pkgPath, agentDir);
			const pkgAgents = loadAgentsFromDir(fullPath, "user");
			agents.push(...pkgAgents);
		}
	}

	return agents;
}

const BUILTIN_AGENTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const builtinAgents = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");
	const extensionAgents = discoverExtensionAgents(cwd, scope);
	const packageAgents = discoverPackageAgents();

	// Merge: extension and package agents are treated as user-level for precedence
	const allUserAgents = [...userAgents, ...extensionAgents, ...packageAgents];
	const agents = mergeAgentsForScope(scope, allUserAgents, projectAgents, builtinAgents);

	return { agents, projectAgentsDir };
}

export function discoverAgentsAll(cwd: string): {
	builtin: AgentConfig[];
	user: AgentConfig[];
	project: AgentConfig[];
	chains: ChainConfig[];
	userDir: string;
	projectDir: string | null;
} {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectDir = findNearestProjectAgentsDir(cwd);

	const builtin = loadAgentsFromDir(BUILTIN_AGENTS_DIR, "builtin");
	const user = loadAgentsFromDir(userDir, "user");
	const project = projectDir ? loadAgentsFromDir(projectDir, "project") : [];
	const extension = discoverExtensionAgents(cwd, "both");
	const pkg = discoverPackageAgents();
	// Extension and package agents are included in user array for precedence
	const allUser = [...user, ...extension, ...pkg];

	const chains = [
		...loadChainsFromDir(userDir, "user"),
		...(projectDir ? loadChainsFromDir(projectDir, "project") : []),
	];

	return { builtin, user: allUser, project, chains, userDir, projectDir };
}
