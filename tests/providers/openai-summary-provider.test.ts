import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiSummaryProvider } from "../../src/providers/openai-summary-provider";

const { requestUrlMock } = vi.hoisted(() => ({ requestUrlMock: vi.fn() }));

vi.mock("obsidian", () => ({
	requestUrl: requestUrlMock,
}));

// openai-summary-provider.ts only needs SUMMARY_PROVIDER_SCHEMA's shape from settings.ts, which
// otherwise pulls in Obsidian UI classes (PluginSettingTab, createFragment, ...) not worth
// stubbing just to satisfy a module-level import.
vi.mock("../../src/settings", () => ({
	SUMMARY_PROVIDER_SCHEMA: {
		openai: { label: "OpenAI" },
		openrouter: { label: "OpenRouter" },
		gemini: { label: "Gemini" },
	},
}));

function makeProvider() {
	return new OpenAiSummaryProvider("openrouter", {
		apiKey: "key",
		baseUrl: "https://openrouter.ai/api/v1",
		model: "some-model",
		temperature: 0.2,
	});
}

beforeEach(() => {
	requestUrlMock.mockReset();
	vi.useRealTimers();
});

describe("OpenAiSummaryProvider retry", () => {
	it("retries on HTTP 429 and succeeds once the provider recovers", async () => {
		vi.useFakeTimers();
		requestUrlMock
			.mockResolvedValueOnce({ status: 429, json: { error: { message: "rate limited" } }, text: "" })
			.mockResolvedValueOnce({ status: 200, json: { choices: [{ message: { content: "Summary text" } }] }, text: "" });

		const provider = makeProvider();
		const resultPromise = provider.summarize({ transcript: "hello world", prompt: "Summarize" });

		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result.summary).toBe("Summary text");
		expect(requestUrlMock).toHaveBeenCalledTimes(2);
	});

	it("gives up after MAX_RETRIES and throws using the last response", async () => {
		vi.useFakeTimers();
		requestUrlMock.mockResolvedValue({ status: 429, json: { error: { message: "rate limited" } }, text: "" });

		const provider = makeProvider();
		const resultPromise = provider.summarize({ transcript: "hello world", prompt: "Summarize" });
		const assertion = expect(resultPromise).rejects.toThrow(/HTTP 429/);

		await vi.runAllTimersAsync();
		await assertion;

		expect(requestUrlMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry on non-retryable errors (e.g. HTTP 400)", async () => {
		requestUrlMock.mockResolvedValueOnce({ status: 400, json: { error: { message: "bad request" } }, text: "" });

		const provider = makeProvider();
		await expect(provider.summarize({ transcript: "hello world", prompt: "Summarize" })).rejects.toThrow(/HTTP 400/);

		expect(requestUrlMock).toHaveBeenCalledTimes(1);
	});
});
