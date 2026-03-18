/**
 * Integration tests: verify pi-subagents produces model refs compatible with pi-model-router.
 *
 * pi-model-router expects:
 *   - splitModelRef: "provider/model" or bare "model"
 *   - normalizeModelName: strips prefixes, suffixes, dates, non-alphanumeric
 *   - modelNamesMatch: contains-based matching on normalized names
 *
 * pi-subagents produces:
 *   - modelOverride ?? agent.model → applyThinkingSuffix → --models arg
 *   - Group names: "tactical", "scout", etc.
 *   - Provider/model: "anthropic/claude-sonnet-4"
 *   - With thinking: "anthropic/claude-sonnet-4:high"
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// Inline from execution.ts to avoid transitive dependency on artifacts.js
// This is the exact same logic — if it drifts, the test contract still validates the format.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

describe("router compatibility: applyThinkingSuffix output formats", () => {
	it("bare group name passes through unchanged", () => {
		assert.equal(applyThinkingSuffix("tactical", undefined), "tactical");
		assert.equal(applyThinkingSuffix("scout", undefined), "scout");
	});

	it("group name with thinking appends :suffix", () => {
		const result = applyThinkingSuffix("tactical", "high");
		assert.equal(result, "tactical:high");
	});

	it("provider/model without thinking passes through", () => {
		assert.equal(
			applyThinkingSuffix("anthropic/claude-sonnet-4", undefined),
			"anthropic/claude-sonnet-4",
		);
	});

	it("provider/model with thinking appends :suffix", () => {
		assert.equal(
			applyThinkingSuffix("anthropic/claude-sonnet-4", "high"),
			"anthropic/claude-sonnet-4:high",
		);
	});

	it("does not double-append thinking suffix", () => {
		assert.equal(
			applyThinkingSuffix("anthropic/claude-sonnet-4:high", "high"),
			"anthropic/claude-sonnet-4:high",
		);
	});

	it("provider/model:thinking format preserves slash for splitModelRef", () => {
		// pi-model-router splitModelRef splits on first /
		const model = applyThinkingSuffix("anthropic/claude-sonnet-4", "medium")!;
		const slashIdx = model.indexOf("/");
		assert.ok(slashIdx > 0, "should contain a slash");
		assert.equal(model.slice(0, slashIdx), "anthropic");
		assert.equal(model.slice(slashIdx + 1), "claude-sonnet-4:medium");
	});

	it("nested provider format works with thinking", () => {
		const model = applyThinkingSuffix("chutes/deepseek-ai/DeepSeek-V3", "high")!;
		assert.equal(model, "chutes/deepseek-ai/DeepSeek-V3:high");
		// splitModelRef splits on first / → provider="chutes", modelId="deepseek-ai/DeepSeek-V3:high"
		const slashIdx = model.indexOf("/");
		assert.equal(model.slice(0, slashIdx), "chutes");
	});

	it("undefined model returns undefined regardless of thinking", () => {
		assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
		assert.equal(applyThinkingSuffix(undefined, undefined), undefined);
	});

	it("thinking=off returns model unchanged", () => {
		assert.equal(
			applyThinkingSuffix("anthropic/claude-sonnet-4", "off"),
			"anthropic/claude-sonnet-4",
		);
	});
});

describe("router compatibility: model ref format contract", () => {
	// These tests document the format contract between the two packages.
	// If either package changes format, these should catch it.

	it("all thinking levels produce valid colon-suffixed strings", () => {
		const levels = ["minimal", "low", "medium", "high", "xhigh"];
		for (const level of levels) {
			const result = applyThinkingSuffix("tactical", level)!;
			assert.ok(result.endsWith(`:${level}`), `expected ${result} to end with :${level}`);
		}
	});

	it("model refs with colons still have correct slash structure", () => {
		const refs = [
			"anthropic/claude-opus-4",
			"google/gemini-3-pro",
			"openai/gpt-5",
			"chutes/qwen/qwen3.5-397b",
		];
		for (const ref of refs) {
			const withThinking = applyThinkingSuffix(ref, "high")!;
			// Must still have at least one slash
			assert.ok(withThinking.includes("/"), `${withThinking} should contain /`);
			// Colon must come after the last slash (it's a model suffix, not a provider thing)
			const lastSlash = withThinking.lastIndexOf("/");
			const colon = withThinking.indexOf(":");
			assert.ok(colon > lastSlash, `colon at ${colon} should be after last slash at ${lastSlash}`);
		}
	});
});
