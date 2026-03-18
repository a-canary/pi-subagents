/**
 * Compact tree rendering for subagent results.
 *
 * Displays subagent execution as a dense, scannable tree inspired by
 * htop / docker ps — one line per agent with aligned columns:
 *
 *   ⛓ chain  3 agents  22.4k tok  31.2s  $0.09
 *   ├ ✓ scout     sonnet-4   3.2k tok   2.1s  $0.01  Found 12 files
 *   ├ ✓ planner   sonnet-4   8.0k tok  12.4s  $0.04  Plan: 6 steps
 *   ╰ ✓ builder   sonnet-4  11.2k tok  16.7s  $0.04  3 files changed
 */

import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Container, Text, Spacer, visibleWidth } from "@mariozechner/pi-tui";
import {
	type AsyncJobState,
	type Details,
	type SingleResult,
	type AgentProgress,
	type ProgressSummary,
	MAX_WIDGET_JOBS,
	WIDGET_KEY,
} from "./types.js";
import { formatDuration, shortenPath } from "./formatters.js";
import { getFinalOutput, getOutputTail, getLastActivity } from "./utils.js";

type Theme = ExtensionContext["ui"]["theme"];

// ============================================================================
// Helpers
// ============================================================================

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

// Grapheme segmenter for proper Unicode handling (shared instance)
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Truncate a line to maxWidth, preserving ANSI styling through the ellipsis.
 */
function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;

	const targetWidth = maxWidth - 1;
	let result = "";
	let currentWidth = 0;
	let activeStyles: string[] = [];
	let i = 0;

	while (i < text.length) {
		const ansiMatch = text.slice(i).match(/^\x1b\[[0-9;]*m/);
		if (ansiMatch) {
			const code = ansiMatch[0];
			result += code;
			if (code === "\x1b[0m" || code === "\x1b[m") {
				activeStyles = [];
			} else {
				activeStyles.push(code);
			}
			i += code.length;
			continue;
		}

		let end = i;
		while (end < text.length && !text.slice(end).match(/^\x1b\[[0-9;]*m/)) {
			end++;
		}

		const textPortion = text.slice(i, end);
		for (const seg of segmenter.segment(textPortion)) {
			const grapheme = seg.segment;
			const graphemeWidth = visibleWidth(grapheme);
			if (currentWidth + graphemeWidth > targetWidth) {
				return result + activeStyles.join("") + "…";
			}
			result += grapheme;
			currentWidth += graphemeWidth;
		}
		i = end;
	}

	return result + activeStyles.join("") + "…";
}

/**
 * Shorten model name: "anthropic/claude-sonnet-4-20250514" → "sonnet-4"
 * Strip provider prefix and date suffix.
 */
function shortModel(model: string | undefined): string {
	if (!model) return "·";
	// Strip provider prefix
	let m = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
	// Strip date suffix like -20250514
	m = m.replace(/-\d{8}$/, "");
	// Strip common vendor prefixes for brevity
	m = m.replace(/^claude-/, "");
	// Strip thinking suffixes
	m = m.replace(/:(off|minimal|low|medium|high|xhigh)$/, "");
	return m;
}

/** Compact token formatting: 482, 3.2k, 48k */
function fmtTok(n: number | undefined): string {
	if (!n) return "·";
	if (n < 1000) return `${n}`;
	if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
	return `${Math.round(n / 1000)}k`;
}

/** Compact duration: 8.2s, 1m24s, 1h12m */
function fmtDur(ms: number | undefined): string {
	if (!ms) return "·";
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	if (m < 60) return `${m}m${s.toString().padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h${(m % 60).toString().padStart(2, "0")}m`;
}

/** Cost: $0.01 or · */
function fmtCost(cost: number | undefined): string {
	if (!cost) return "";
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(2)}`;
}

/**
 * Get the effective progress info from a result.
 */
function getProgress(r: SingleResult): AgentProgress | ProgressSummary | undefined {
	return r.progress || r.progressSummary;
}

function isAgentProgress(p: AgentProgress | ProgressSummary | undefined): p is AgentProgress {
	return !!p && "status" in p;
}

/**
 * Determine the status of a result.
 */
type AgentStatus = "running" | "done" | "failed" | "pending";

function getStatus(r: SingleResult | undefined): AgentStatus {
	if (!r) return "pending";
	const prog = r.progress;
	if (prog?.status === "running") return "running";
	if (r.exitCode !== 0) return "failed";
	return "done";
}

function statusIcon(s: AgentStatus, theme: Theme): string {
	switch (s) {
		case "done":    return theme.fg("success", "✓");
		case "failed":  return theme.fg("error", "✗");
		case "running": return theme.fg("accent", "●");
		case "pending": return theme.fg("dim", "○");
	}
}

function agentNameStyled(name: string, status: AgentStatus, theme: Theme): string {
	switch (status) {
		case "done":    return theme.bold(theme.fg("success", name));
		case "failed":  return theme.bold(theme.fg("error", name));
		case "running": return theme.bold(theme.fg("accent", name));
		case "pending": return theme.fg("dim", name);
	}
}

/**
 * Get a short activity/summary string for the last column.
 */
function getActivity(r: SingleResult | undefined, status: AgentStatus, theme: Theme): string {
	if (!r) return theme.fg("dim", "waiting");

	if (status === "running") {
		const prog = r.progress;
		if (prog?.currentTool) {
			const toolName = prog.currentTool;
			const args = prog.currentToolArgs || "";
			const shortArgs = args.length > 35 ? args.slice(0, 35) + "…" : args;
			return `${theme.fg("toolTitle", "⚙ " + toolName)}${shortArgs ? theme.fg("muted", "(" + shortArgs + ")") : ""}`;
		}
		return theme.fg("muted", "⚙ thinking…");
	}

	if (status === "failed") {
		const lastOutput = getFinalOutput(r.messages).split("\n").filter(Boolean).pop() || "";
		const errText = lastOutput || r.error || "failed";
		return theme.fg("error", `exit ${r.exitCode}: ${errText}`);
	}

	// Done — show compact: {msg30} <<<⚙>>> {cmd30}  (fixed-width columns)
	const output = (r.truncation?.text || getFinalOutput(r.messages)).trim();
	const meaningfulLine = output.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 2 && !/^(`{1,3}|---|===|\|[-|]+\|)/.test(l))
		.pop() || "";
	const msgRaw = meaningfulLine.length > 30 ? meaningfulLine.slice(0, 30) + "…" : meaningfulLine;
	const msgCol = msgRaw.padEnd(31); // fixed 31-char left column

	const recentTools = r.progress?.recentTools;
	const lastTool = recentTools && recentTools.length > 0 ? recentTools[recentTools.length - 1] : undefined;
	if (lastTool) {
		const cmd = (lastTool.tool + " " + lastTool.args).trim();
		const cmd30 = cmd.length > 30 ? cmd.slice(0, 30) + "…" : cmd;
		const sep = `${theme.fg("dim", "<<<")}${theme.fg("accent", "⚙")}${theme.fg("dim", ">>>")}`;
		return `${theme.fg("muted", msgCol)}${sep} ${theme.fg("toolTitle", cmd30)}`;
	}
	return msgRaw || theme.fg("success", "✓ done");
}

// ============================================================================
// Tree drawing
// ============================================================================

/** Tree connector characters */
const TREE = {
	branch: "├",
	last:   "╰",
	pipe:   "│",
	space:  " ",
} as const;

function treeChar(index: number, total: number, theme: Theme): string {
	const ch = index === total - 1 ? TREE.last : TREE.branch;
	return theme.fg("border", ch) + " ";
}

function nestedTreeChar(index: number, total: number, theme: Theme): string {
	const ch = index === total - 1 ? TREE.last : TREE.branch;
	return theme.fg("border", TREE.pipe + " " + ch) + " ";
}

// ============================================================================
// Line builder with column alignment
// ============================================================================

interface ColumnWidths {
	name: number;
	model: number;
}

function computeColumnWidths(results: SingleResult[], chainAgents?: string[]): ColumnWidths {
	let maxName = 0;
	let maxModel = 0;
	for (const r of results) {
		maxName = Math.max(maxName, r.agent.length);
		maxModel = Math.max(maxModel, shortModel(r.model).length);
	}
	if (chainAgents) {
		for (const name of chainAgents) {
			// Handle parallel agent format "[a+b]"
			if (name.startsWith("[")) continue;
			maxName = Math.max(maxName, name.length);
		}
	}
	return {
		name: Math.max(maxName, 6),   // min 6 for readability
		model: Math.max(maxModel, 3), // min 3
	};
}

/**
 * Build a single agent status line with aligned columns.
 *
 *   {prefix}{icon} {name}  {model}  {tokens}  {dur}  {cost}  {activity}
 */
function buildAgentLine(
	prefix: string,
	r: SingleResult | undefined,
	agentName: string,
	cols: ColumnWidths,
	theme: Theme,
	w: number,
): string {
	const status = getStatus(r);
	const icon = statusIcon(status, theme);
	const name = agentNameStyled(agentName.padEnd(cols.name), status, theme);

	if (!r || status === "pending") {
		const model = theme.fg("dim", "·".padEnd(cols.model));
		const tok   = theme.fg("dim", "·".padStart(7));
		const dur   = theme.fg("dim", "·".padStart(6));
		const act   = theme.fg("dim", "waiting");
		return truncLine(`${prefix}${icon} ${name}  ${model}  ${tok}  ${dur}        ${act}`, w);
	}

	const prog = getProgress(r);
	const tokens = prog ? prog.tokens : (r.usage.input + r.usage.output);
	const duration = prog?.durationMs ?? 0;
	const cost = r.usage.cost;

	const modelStr   = theme.fg("muted", shortModel(r.model).padEnd(cols.model));
	const tokStr     = theme.fg("dim", (fmtTok(tokens) + " tok").padStart(9));
	const durStr     = theme.fg("dim", fmtDur(duration).padStart(6));
	const costStr    = cost ? theme.fg("dim", fmtCost(cost).padStart(7)) : "       ";
	const activity   = getActivity(r, status, theme);

	return truncLine(`${prefix}${icon} ${name}  ${modelStr}  ${tokStr}  ${durStr}  ${costStr}  ${activity}`, w);
}

/**
 * Build a header line for chain/parallel modes.
 *
 *   {icon} {mode}  {count} agents  {tokens}  {dur}  {cost}
 */
function buildHeaderLine(
	mode: string,
	icon: string,
	results: SingleResult[],
	progress: AgentProgress[] | undefined,
	isChain: boolean,
	theme: Theme,
	w: number,
): string {
	const count = results.length;
	const hasRunning = results.some(r => getStatus(r) === "running")
		|| progress?.some(p => p.status === "running");
	const allDone = results.length > 0 && results.every(r => getStatus(r) === "done");
	const hasFailed = results.some(r => getStatus(r) === "failed");

	// Aggregate stats
	let totalTokens = 0;
	let totalDuration = 0;
	let totalCost = 0;
	for (const r of results) {
		const prog = getProgress(r);
		totalTokens += prog ? prog.tokens : (r.usage.input + r.usage.output);
		const dur = prog?.durationMs ?? 0;
		totalDuration = isChain ? totalDuration + dur : Math.max(totalDuration, dur);
		totalCost += r.usage.cost ?? 0;
	}

	const headerColor = hasRunning ? "accent" : hasFailed ? "error" : allDone ? "success" : "dim";
	const modeLabel = theme.bold(theme.fg(headerColor as any, `${icon} ${mode}`));
	const countStr = theme.fg("dim", `${count} agent${count !== 1 ? "s" : ""}`);
	const tokStr = totalTokens ? theme.fg("dim", fmtTok(totalTokens) + " tok") : "";
	const durStr = totalDuration ? theme.fg("dim", fmtDur(totalDuration)) : "";
	const costStr = totalCost ? theme.fg("dim", fmtCost(totalCost)) : "";

	const parts = [modeLabel, countStr, tokStr, durStr, costStr].filter(Boolean);
	return truncLine(parts.join("  "), w);
}

// ============================================================================
// Async widget (compact)
// ============================================================================

let lastWidgetHash = "";

function computeWidgetHash(jobs: AsyncJobState[]): string {
	return jobs.slice(0, MAX_WIDGET_JOBS).map(job =>
		`${job.asyncId}:${job.status}:${job.currentStep}:${job.updatedAt}:${job.totalTokens?.total ?? 0}`
	).join("|");
}

export function renderWidget(ctx: ExtensionContext, jobs: AsyncJobState[]): void {
	if (!ctx.hasUI) return;
	if (jobs.length === 0) {
		if (lastWidgetHash !== "") {
			lastWidgetHash = "";
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		}
		return;
	}

	const displayedJobs = jobs.slice(0, MAX_WIDGET_JOBS);
	const hasRunningJobs = displayedJobs.some(job => job.status === "running");
	const newHash = computeWidgetHash(jobs);
	if (!hasRunningJobs && newHash === lastWidgetHash) return;
	lastWidgetHash = newHash;

	const theme = ctx.ui.theme;
	const w = getTermWidth();
	const lines: string[] = [];
	lines.push(theme.fg("accent", "⚡ Async subagents"));

	for (const job of displayedJobs) {
		const id = job.asyncId.slice(0, 6);
		const status: AgentStatus =
			job.status === "complete" ? "done"
			: job.status === "failed" ? "failed"
			: "running";

		const icon = statusIcon(status, theme);
		const agentLabel = job.agents ? job.agents.join(" → ") : (job.mode ?? "single");
		const elapsed = job.startedAt ? fmtDur(
			((job.status === "complete" || job.status === "failed") ? (job.updatedAt ?? Date.now()) : Date.now()) - job.startedAt,
		) : "·";
		const tokStr = job.totalTokens ? fmtTok(job.totalTokens.total) + " tok" : "";
		const activityText = job.status === "running" ? getLastActivity(job.outputFile) : "";
		const activitySuffix = activityText ? theme.fg("dim", ` ⚙ ${activityText}`) : "";

		lines.push(truncLine(
			`  ${icon} ${theme.fg("dim", id)}  ${agentLabel}  ${theme.fg("dim", elapsed)}${tokStr ? "  " + theme.fg("dim", tokStr) : ""}${activitySuffix}`,
			w,
		));

		// Show output tail for running jobs
		if (job.status === "running" && job.outputFile) {
			const tail = getOutputTail(job.outputFile, 2);
			for (const line of tail) {
				lines.push(truncLine(theme.fg("dim", `    > ${line}`), w));
			}
		}
	}

	ctx.ui.setWidget(WIDGET_KEY, lines);
}

// ============================================================================
// Tool result rendering — compact tree
// ============================================================================

function getFullOutput(r: SingleResult): string {
	if (r.truncation?.text) return r.truncation.text;
	// Concatenate all assistant text blocks in order
	const parts: string[] = [];
	for (const msg of r.messages) {
		if (msg.role === "assistant") {
			for (const part of (msg as any).content ?? []) {
				if (part.type === "text" && part.text?.trim()) parts.push(part.text.trim());
			}
		}
	}
	// Fallback: recentOutput lines if messages gave nothing
	if (parts.length === 0 && r.progress?.recentOutput?.length) {
		return r.progress.recentOutput.join("\n");
	}
	return parts.join("\n\n");
}

function appendExpandedOutput(c: Container, r: SingleResult, theme: Theme, w: number): void {
	const output = getFullOutput(r).trim();
	c.addChild(new Text(truncLine(theme.fg("border", `╔═ ${r.agent} ` + "═".repeat(Math.max(0, 40 - r.agent.length))), w), 0, 0));
	if (!output) {
		c.addChild(new Text(theme.fg("muted", "  (no output)"), 0, 0));
	} else {
		for (const line of output.split("\n")) {
			c.addChild(new Text(truncLine("  " + line, w), 0, 0));
		}
	}
	c.addChild(new Text(theme.fg("border", "╚" + "═".repeat(42)), 0, 0));
	c.addChild(new Spacer(1));
}

export function renderSubagentResult(
	result: AgentToolResult<Details>,
	options: { expanded: boolean },
	theme: Theme,
): Container {
	const d = result.details;
	const expanded = options.expanded;
	const w = getTermWidth() - 4;
	const c = new Container();

	if (!d || !d.results.length) {
		const t = result.content[0];
		const text = t?.type === "text" ? t.text : "(no output)";
		c.addChild(new Text(truncLine(text, w), 0, 0));
		return c;
	}

	// ── Single agent ──
	if (d.mode === "single" && d.results.length === 1) {
		const r = d.results[0];
		const cols = computeColumnWidths(d.results);
		c.addChild(new Text(buildAgentLine("", r, r.agent, cols, theme, w), 0, 0));

		// Show output below for completed/failed single agents
		const status = getStatus(r);
		if (status === "done" || status === "failed") {
			if (expanded) {
				c.addChild(new Spacer(1));
				appendExpandedOutput(c, r, theme, w);
			} else {
				const output = (r.truncation?.text || getFinalOutput(r.messages)).trim();
				if (output) {
					c.addChild(new Spacer(1));
					const lines = output.split("\n").filter(Boolean);
					const showLines = lines.slice(-8);
					for (const line of showLines) {
						c.addChild(new Text(truncLine(theme.fg("dim", "  " + line), w), 0, 0));
					}
					if (lines.length > 8) {
						c.addChild(new Text(theme.fg("dim", `  … ${lines.length - 8} more lines (Ctrl+O to expand)`), 0, 0));
					}
				}
			}
		}

		// Footer: usage + session
		c.addChild(new Spacer(1));
		const footerParts: string[] = [];
		if (r.usage.turns) footerParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
		if (r.usage.input)  footerParts.push(`in:${fmtTok(r.usage.input)}`);
		if (r.usage.output) footerParts.push(`out:${fmtTok(r.usage.output)}`);
		if (r.usage.cacheRead)  footerParts.push(`R${fmtTok(r.usage.cacheRead)}`);
		if (r.usage.cacheWrite) footerParts.push(`W${fmtTok(r.usage.cacheWrite)}`);
		if (r.skills?.length) footerParts.push(`skills: ${r.skills.join(", ")}`);
		if (r.sessionFile) footerParts.push(`session: ${shortenPath(r.sessionFile)}`);
		if (footerParts.length) {
			c.addChild(new Text(truncLine(theme.fg("dim", footerParts.join("  ")), w), 0, 0));
		}

		return c;
	}

	// ── Chain or Parallel ──
	const isChain = d.mode === "chain";
	const isParallel = d.mode === "parallel";
	const modeIcon = isChain ? "⛓" : "⫘";
	const modeLabel = isChain ? "chain" : "parallel";

	// Detect mixed chain with parallel steps
	const hasParallelInChain = d.chainAgents?.some(a => a.startsWith("["));
	const cols = computeColumnWidths(d.results, d.chainAgents);

	// Header line
	c.addChild(new Text(
		buildHeaderLine(modeLabel, modeIcon, d.results, d.progress, isChain, theme, w),
		0, 0,
	));

	if (hasParallelInChain && d.chainAgents?.length) {
		// Mixed chain: sequential steps + embedded parallel groups
		renderMixedChain(c, d, cols, theme, w);
	} else if (d.chainAgents?.length && isChain) {
		// Pure sequential chain
		const total = d.chainAgents.length;
		for (let i = 0; i < total; i++) {
			const agentName = d.chainAgents[i];
			const r = d.results[i];
			const prefix = treeChar(i, total, theme);
			c.addChild(new Text(buildAgentLine(prefix, r, agentName, cols, theme, w), 0, 0));
			if (expanded && r) appendExpandedOutput(c, r, theme, w);
		}
	} else {
		// Parallel or simple results list
		const total = d.results.length;
		for (let i = 0; i < total; i++) {
			const r = d.results[i];
			const prefix = treeChar(i, total, theme);
			c.addChild(new Text(buildAgentLine(prefix, r, r.agent, cols, theme, w), 0, 0));
			if (expanded) appendExpandedOutput(c, r, theme, w);
		}
	}
	if (!expanded && d.results.length > 1) {
		c.addChild(new Text(theme.fg("dim", "  Ctrl+O to expand full responses"), 0, 0));
	}

	// Aggregate footer
	c.addChild(new Spacer(1));
	const allSessions = d.results.filter(r => r.sessionFile).map(r => shortenPath(r.sessionFile!));
	if (d.artifacts) {
		c.addChild(new Text(truncLine(theme.fg("dim", `artifacts: ${shortenPath(d.artifacts.dir)}`), w), 0, 0));
	}
	if (allSessions.length === 1) {
		c.addChild(new Text(truncLine(theme.fg("dim", `session: ${allSessions[0]}`), w), 0, 0));
	}

	return c;
}

/**
 * Render a mixed chain that contains both sequential and parallel steps.
 * chainAgents format: ["scout", "[builder+writer]", "reviewer"]
 */
function renderMixedChain(
	c: Container,
	d: Details,
	cols: ColumnWidths,
	theme: Theme,
	w: number,
): void {
	const chainAgents = d.chainAgents!;
	const total = chainAgents.length;
	let resultIdx = 0;

	for (let stepIdx = 0; stepIdx < total; stepIdx++) {
		const agentEntry = chainAgents[stepIdx];
		const prefix = treeChar(stepIdx, total, theme);
		const isLast = stepIdx === total - 1;

		if (agentEntry.startsWith("[")) {
			// Parallel group: "[builder+writer]" → ["builder", "writer"]
			const inner = agentEntry.slice(1, -1).split("+");
			const parallelResults: SingleResult[] = [];
			for (let j = 0; j < inner.length; j++) {
				parallelResults.push(d.results[resultIdx + j]);
			}

			// Parallel group header
			const hasRunning = parallelResults.some(r => getStatus(r) === "running");
			const allDone = parallelResults.every(r => getStatus(r) === "done");
			const headerColor = hasRunning ? "accent" : allDone ? "success" : "dim";
			c.addChild(new Text(truncLine(
				`${prefix}${theme.fg(headerColor as any, "⫘ parallel")}  ${theme.fg("dim", `${inner.length} agents`)}`,
				w,
			), 0, 0));

			// Nested parallel children
			for (let j = 0; j < inner.length; j++) {
				const nestedPrefix = isLast
					? `  ${j === inner.length - 1 ? theme.fg("border", TREE.last) : theme.fg("border", TREE.branch)} `
					: `${theme.fg("border", TREE.pipe)} ${j === inner.length - 1 ? theme.fg("border", TREE.last) : theme.fg("border", TREE.branch)} `;
				const r = d.results[resultIdx + j];
				c.addChild(new Text(buildAgentLine(nestedPrefix, r, inner[j], cols, theme, w), 0, 0));
			}

			resultIdx += inner.length;
		} else {
			// Sequential step
			const r = d.results[resultIdx];
			c.addChild(new Text(buildAgentLine(prefix, r, agentEntry, cols, theme, w), 0, 0));
			resultIdx++;
		}
	}
}
