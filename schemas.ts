/**
 * TypeBox schemas for subagent tool parameters
 */

import { Type } from "@sinclair/typebox";

export const TaskItem = Type.Object({ 
	agent: Type.String(), 
	task: Type.String(), 
	cwd: Type.Optional(Type.String()) 
});

// Sequential chain step (single agent)
export const SequentialStepSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template. Use {task}, {previous}, {chain_dir}. Required for first step." })),
	cwd: Type.Optional(Type.String()),
	// Chain behavior overrides
	output: Type.Optional(Type.Union([
		Type.String(),
		Type.Boolean(),
	], { description: "Override output filename (string), or false for text-only" })),
	reads: Type.Optional(Type.Union([
		Type.Array(Type.String()),
		Type.Boolean(),
	], { description: "Override files to read from {chain_dir} (array), or false to disable" })),
	progress: Type.Optional(Type.Boolean({ description: "Override progress tracking" })),
});

// Parallel task item (within a parallel step)
export const ParallelTaskSchema = Type.Object({
	agent: Type.String(),
	task: Type.Optional(Type.String({ description: "Task template. Defaults to {previous}." })),
	cwd: Type.Optional(Type.String()),
	output: Type.Optional(Type.Union([
		Type.String(),
		Type.Boolean(),
	], { description: "Override output filename (string), or false for text-only" })),
	reads: Type.Optional(Type.Union([
		Type.Array(Type.String()),
		Type.Boolean(),
	], { description: "Override files to read from {chain_dir} (array), or false to disable" })),
	progress: Type.Optional(Type.Boolean({ description: "Override progress tracking" })),
});

// Parallel chain step (multiple agents running concurrently)
export const ParallelStepSchema = Type.Object({
	parallel: Type.Array(ParallelTaskSchema, { minItems: 1, description: "Tasks to run in parallel" }),
	concurrency: Type.Optional(Type.Number({ description: "Max concurrent tasks (default: 4)" })),
	failFast: Type.Optional(Type.Boolean({ description: "Stop on first failure (default: false)" })),
});

// Chain item can be either sequential or parallel
export const ChainItem = Type.Union([SequentialStepSchema, ParallelStepSchema]);

export const MaxOutputSchema = Type.Optional(
	Type.Object({
		bytes: Type.Optional(Type.Number({ description: "Max bytes (default: 204800)" })),
		lines: Type.Optional(Type.Number({ description: "Max lines (default: 5000)" })),
	}),
);

export const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (SINGLE mode)" })),
	task: Type.Optional(Type.String({ description: "Task (SINGLE mode)" })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "PARALLEL mode: [{agent, task}, ...]" })),
	chain: Type.Optional(Type.Array(ChainItem, { description: "CHAIN mode: [{agent}, {agent, task:'{previous}'}] - sequential pipeline" })),
	async: Type.Optional(Type.Boolean({ description: "Run in background (default: false, or per config)" })),
	agentScope: Type.Optional(Type.String({ description: "Agent discovery scope: 'user', 'project', or 'both' (default: 'user')" })),
	cwd: Type.Optional(Type.String()),
	maxOutput: MaxOutputSchema,
	artifacts: Type.Optional(Type.Boolean({ description: "Write debug artifacts (default: true)" })),
	includeProgress: Type.Optional(Type.Boolean({ description: "Include full progress in result (default: false)" })),
	share: Type.Optional(Type.Boolean({ description: "Create shareable session log (default: true)", default: true })),
	sessionDir: Type.Optional(
		Type.String({ description: "Directory to store session logs (default: temp; enables sessions even if share=false)" }),
	),
	// Chain clarification TUI
	clarify: Type.Optional(Type.Boolean({ description: "Show TUI to clarify chain templates (default: true for chains). Implies sync mode." })),
	// Solo agent output override
	output: Type.Optional(Type.Union([
		Type.String(),
		Type.Boolean(),
	], { description: "Override output file for single agent (string), or false to disable (uses agent default if omitted)" })),
});

export const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Async run id or prefix" })),
	dir: Type.Optional(Type.String({ description: "Async run directory (overrides id search)" })),
});
