function CallId(id) {
	return id;
}

import { C as workbuddyAccountDir, S as parseWorkBuddyAuth, _ as WORKBUDDY_AUTH_FILE_ENV, a as readHostHeartbeat, b as defaultDesktopAuthCandidates, d as normalizeCredits, f as prepareChatBody, g as WORKBUDDY_AUTH_FILENAME, h as WorkBuddyCatalog, i as processStartTimeMs, l as WorkBuddyUpstreamClient, m as FALLBACK_WORKBUDDY_MODELS, n as clearHostHeartbeat, o as workbuddyHostHeartbeatPath, p as regionOf, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME, u as classifyUpstreamError, v as WorkBuddyAccountManager, w as workbuddyOwnAuthPath, x as defaultDesktopAuthPath, y as WorkBuddyCredentialStore } from "./host-heartbeat-5EQ7odMB.js";
import { a as getSupportedThinkingLevels, i as createProvider, o as lazyApi, r as createModels } from "./models-uQEzsUBb.js";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import "node:os";
import {CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE, ReasoningEffortId, RetryPolicySchema, attributionHeaders, contentHasImage, isContextWindowExceededError, isQuotaExceededError, offloadRequestImagesWithPolicy, requestImageHandleText, resolveRetryPolicy} from "@deepseek-ai/dsh-llm";
import "@deepseek-ai/cordis";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js
/**
* Regex patterns to detect context overflow errors from different providers.
*
* These patterns match error messages returned when the input exceeds
* the model's context window.
*
* Provider-specific patterns (with example error messages):
*
* - Anthropic: "prompt is too long: 213462 tokens > 200000 maximum"
* - Anthropic: "413 {\"error\":{\"type\":\"request_too_large\",\"message\":\"Request exceeds the maximum size\"}}"
* - OpenAI: "Your input exceeds the context window of this model"
* - OpenAI/LiteLLM: "Requested token count exceeds the model's maximum context length of 131072 tokens"
* - OpenAI-compatible: "Input length (265330) exceeds model's maximum context length (262144)."
* - Google: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"
* - xAI: "This model's maximum prompt length is 131072 but the request contains 537812 tokens"
* - Groq: "Please reduce the length of the messages or completion"
* - OpenRouter: "This endpoint's maximum context length is X tokens. However, you requested about Y tokens"
* - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
* - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
* - llama.cpp: "the request exceeds the available context size, try increasing it"
* - LM Studio: "tokens to keep from the initial prompt is greater than the context length"
* - GitHub Copilot: "prompt token count of X exceeds the limit of Y"
* - MiniMax: "invalid params, context window exceeds limit"
* - Kimi For Coding: "Your request exceeded model token limit: X (requested: Y)"
* - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
* - Cerebras: "400/413 status code (no body)"
* - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
* - z.ai: Does NOT error, accepts overflow silently - handled via usage.input > contextWindow
* - Xiaomi MiMo: Truncates input to fill contextWindow exactly, then returns finish_reason "length"
*   with output=0 (no room left to generate). Detected via stopReason "length" + zero output +
*   input filling the context window.
* - DashScope/Qwen: "Range of input length should be [1, X]" (HTTP 400 invalid_parameter_error)
* - Ollama: Some deployments truncate silently, others return errors like "prompt too long; exceeded max context length by X tokens"
*/
const OVERFLOW_PATTERNS = [
	/prompt is too long/i,
	/request_too_large/i,
	/input is too long for requested model/i,
	/exceeds the context window/i,
	/exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
	/input token count.*exceeds the maximum/i,
	/maximum prompt length is \d+/i,
	/reduce the length of the messages/i,
	/maximum context length is \d+ tokens/i,
	/exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
	/input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
	/exceeds the limit of \d+/i,
	/exceeds the available context size/i,
	/greater than the context length/i,
	/context window exceeds limit/i,
	/exceeded model token limit/i,
	/too large for model with \d+ maximum context length/i,
	/prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
	/model_context_window_exceeded/i,
	/prompt too long; exceeded (?:max )?context length/i,
	/range of input length should be/i,
	/context[_ ]length[_ ]exceeded/i,
	/too many tokens/i,
	/token limit exceeded/i,
	/^4(?:00|13)\s*(?:status code)?\s*\(no body\)/i
];
/**
* Patterns that indicate non-overflow errors (e.g. rate limiting, server errors).
* Error messages matching any of these are excluded from overflow detection
* even if they also match an OVERFLOW_PATTERN.
*
* Example: Bedrock formats throttling errors as "ThrottlingException: Too many tokens,
* please wait before trying again." which would match the /too many tokens/i overflow
* pattern without this exclusion.
*/
const NON_OVERFLOW_PATTERNS = [
	/^(Throttling error|Service unavailable):/i,
	/rate limit/i,
	/too many requests/i
];
/**
* Check if an assistant message represents a context overflow error.
*
* This handles two cases:
* 1. Error-based overflow: Most providers return stopReason "error" with a
*    specific error message pattern.
* 2. Silent overflow: Some providers accept overflow requests and return
*    successfully. For these, we check if usage.input exceeds the context window.
*
* ## Reliability by Provider
*
* **Reliable detection (returns error with detectable message):**
* - Anthropic: "prompt is too long: X tokens > Y maximum" or "request_too_large"
* - OpenAI (Completions & Responses): "exceeds the context window", "exceeds the model's maximum context length of X tokens", or "exceeds model's maximum context length (X)"
* - Google Gemini: "input token count exceeds the maximum"
* - xAI (Grok): "maximum prompt length is X but request contains Y"
* - Groq: "reduce the length of the messages"
* - Cerebras: 400/413 status code (no body)
* - Mistral: "Prompt contains X tokens ... too large for model with Y maximum context length"
* - OpenRouter (most backends): "maximum context length is X tokens"
* - OpenRouter/Poolside: "Input length X exceeds the maximum allowed input length of Y tokens."
* - Together AI: "The input (X tokens) is longer than the model's context length (Y tokens)."
* - llama.cpp: "exceeds the available context size"
* - LM Studio: "greater than the context length"
* - Kimi For Coding: "exceeded model token limit: X (requested: Y)"
* - DS4: "Prompt has X tokens, but the configured context size is Y tokens"
* - DashScope/Qwen: "Range of input length should be [1, X]"
*
* **Unreliable detection:**
* - z.ai: Sometimes accepts overflow silently (detectable via usage.input > contextWindow),
*   sometimes returns rate limit errors. Pass contextWindow param to detect silent overflow.
* - Xiaomi MiMo: Truncates input to fit contextWindow then returns stopReason "length" with
*   output=0. Pass contextWindow param to detect via the "filled context + zero output" signal.
* - Ollama: May truncate input silently for some setups, but may also return explicit
*   overflow errors that match the patterns above. Silent truncation still cannot be
*   detected here because we do not know the expected token count.
*
* ## Custom Providers
*
* If you've added custom models via settings.json, this function may not detect
* overflow errors from those providers. To add support:
*
* 1. Send a request that exceeds the model's context window
* 2. Check the errorMessage in the response
* 3. Create a regex pattern that matches the error
* 4. The pattern should be added to OVERFLOW_PATTERNS in this file, or
*    check the errorMessage yourself before calling this function
*
* @param message - The assistant message to check
* @param contextWindow - Optional context window size for detecting silent overflow (z.ai)
* @returns true if the message indicates a context overflow
*/
function isContextOverflow(message, contextWindow) {
	if (message.stopReason === "error" && message.errorMessage) {
		if (!NON_OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage)) && OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage))) return true;
	}
	if (contextWindow && message.stopReason === "stop") {
		if (message.usage.input + message.usage.cacheRead > contextWindow) return true;
	}
	if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
		if (message.usage.input + message.usage.cacheRead >= contextWindow * .99) return true;
	}
	return false;
}
//#endregion
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.lazy.js
const openAICompletionsApi = () => lazyApi(() => import("./openai-completions-BrnWtwDq.js"));
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-timeout@0.1.0-rc.7_@deepseek-ai+cordis@4.0.1_@deepseek-ai+dsh-invarian_22adfdf3ba29bade6675fa7bb401c215/node_modules/@deepseek-ai/dsh-timeout/lib/index.js
/**
* Shared timeout arithmetic, signal fusion, and classification. The library
* only notifies through abort signals; each capability still owns the mechanism
* that stops its work and translates timeout reasons into public outcomes.
* @module @deepseek-ai/dsh-timeout
*/
/**
* Internal abort reason carrying a capability-owned code and elapsed deadline.
* Providers translate it through {@link timeoutOf} before returning to callers.
*/
var TimeoutReason = class extends Error {
	code;
	timeoutMs;
	name = "TimeoutReason";
	/**
	* @param code Capability-owned timeout code (e.g. `BASH_TIMEOUT`).
	* @param timeoutMs The deadline that elapsed, in milliseconds.
	*/
	constructor(code, timeoutMs) {
		super(`${code} after ${timeoutMs}ms`);
		this.code = code;
		this.timeoutMs = timeoutMs;
	}
};
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;
function assertTimerDelay(timeoutMs, name) {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
}
/**
* Create a rearmable idle watchdog for an async iterator. The timer exists only
* while {@link IdleWatchdog.next} is outstanding, so consumer think time does
* not count as provider idle time. The returned signal is stable for the whole
* call and only notifies; the iterator must observe it to terminate its work.
*
* @param upstream - caller cancellation fused into the stable signal.
* @param timeoutMs - positive finite idle interval in milliseconds.
* @param code - capability-owned code carried by the timeout reason.
* @returns a stable signal, guarded next operation, and timer disposer.
*/
function idleWatchdog(upstream, timeoutMs, code) {
	assertTimerDelay(timeoutMs, "idleWatchdog timeoutMs");
	const timeout = new AbortController();
	const signal = upstream === void 0 ? timeout.signal : AbortSignal.any([upstream, timeout.signal]);
	let timer;
	let outstanding = false;
	let disposed = false;
	const arm = () => {
		if (timer !== void 0) clearTimeout(timer);
		timer = setTimeout(() => {
			timeout.abort(new TimeoutReason(code, timeoutMs));
		}, timeoutMs);
	};
	return {
		signal,
		async next(iterator) {
			if (disposed) throw new Error("idleWatchdog is disposed");
			if (outstanding) throw new Error("idleWatchdog next is already outstanding");
			outstanding = true;
			arm();
			try {
				return await iterator.next();
			} finally {
				clearTimeout(timer);
				timer = void 0;
				outstanding = false;
			}
		},
		pulse() {
			if (disposed || !outstanding) return;
			arm();
		},
		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			if (timer !== void 0) clearTimeout(timer);
			timer = void 0;
		}
	};
}
/**
* Recover a timeout reason from a reason-bearing object. Supplying `code`
* distinguishes this deadline from a nested upstream deadline; a foreign code
* follows the ordinary cancellation path.
*
* @param x An {@link AbortSignal} or any `{ reason }` carrier (e.g. a caught abort error).
* @param code When provided, only a {@link TimeoutReason} with this exact `code` matches.
* @returns The matching {@link TimeoutReason}, else `undefined`.
*/
function timeoutOf(x, code) {
	const reason = x.reason;
	if (!(reason instanceof TimeoutReason)) return void 0;
	return code === void 0 || reason.code === code ? reason : void 0;
}
//#endregion
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.lazy.js
const anthropicMessagesApi = () => lazyApi(() => import("./anthropic-messages-B2gQN83S.js"));
//#endregion
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.lazy.js
const openAIResponsesApi = () => lazyApi(() => import("./openai-responses-BCfiNtdL.js"));
//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm-pi-ai@0.1.1-rc.2_3883566cb34b135bf7b3fa70b8dcab48/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js
/**
* Durable pi-ai replay metadata and assistant-history reconstruction.
*
* Harness content remains the durable source for text and tool calls. This
* module stores only the provider-native metadata needed to reconstruct a
* pi-ai assistant message on a later request.
*
* @module dsh-llm-pi-ai/replay
*/
/** Parse tool-call argument JSON; tolerate model malformations with {}. */
function parseArguments(raw) {
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed;
	} catch {}
	return {};
}
/** Construct the zero usage value required by historical pi-ai messages. */
function emptyPiUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
}
/**
* Project a successful pi-ai response into the minimal durable replay state.
* The per-block half is index-aligned with the streamed blocks (pi-ai content
* order), so `BlockAssembler` prunes an entry with its block whenever assembly
* removes one.
* @param message - completed native pi-ai assistant response.
* @returns the versioned lossless-JSON replay projection.
*/
function toPiReplayState(message) {
	return {
		response: {
			kind: "pi-ai",
			version: 2,
			api: message.api,
			provider: message.provider,
			model: message.model,
			...message.responseModel === void 0 ? {} : { responseModel: message.responseModel },
			...message.responseId === void 0 ? {} : { responseId: message.responseId },
			stopReason: message.stopReason
		},
		blocks: message.content.map((block) => {
			switch (block.type) {
				case "text": return {
					type: "text",
					...block.textSignature === void 0 ? {} : { textSignature: block.textSignature }
				};
				case "thinking": return {
					type: "reasoning",
					...block.thinkingSignature === void 0 ? {} : { thinkingSignature: block.thinkingSignature },
					...block.redacted === void 0 ? {} : { redacted: block.redacted }
				};
				case "toolCall": return {
					type: "tool-call",
					...block.thoughtSignature === void 0 ? {} : { thoughtSignature: block.thoughtSignature }
				};
			}
		})
	};
}
function invalidReplay(message) {
	throw new LlmError(`invalid pi-ai replay state: ${message}`, "INVALID_REPLAY_STATE");
}
/** Validate the durable adapter-private envelope before it reaches pi-ai. */
function readReplayState(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay("expected a replay envelope");
	const envelope = value;
	const rawResponse = envelope["response"];
	if (typeof rawResponse !== "object" || rawResponse === null || Array.isArray(rawResponse)) return invalidReplay("expected a response object");
	const response = rawResponse;
	if (response["kind"] !== "pi-ai") return invalidReplay("unknown state kind");
	if (response["version"] !== 2) return invalidReplay(`unsupported version ${String(response["version"])}`);
	for (const key of [
		"api",
		"provider",
		"model"
	]) if (typeof response[key] !== "string" || response[key].length === 0) return invalidReplay(`${key} must be a non-empty string`);
	if (![
		"stop",
		"length",
		"toolUse",
		"error",
		"aborted"
	].includes(String(response["stopReason"]))) return invalidReplay("unknown stopReason");
	if (response["responseModel"] !== void 0 && typeof response["responseModel"] !== "string") return invalidReplay("responseModel must be a string");
	if (response["responseId"] !== void 0 && typeof response["responseId"] !== "string") return invalidReplay("responseId must be a string");
	const blocks = envelope["blocks"];
	if (!Array.isArray(blocks)) return invalidReplay("blocks must be an array");
	for (const [index, value] of blocks.entries()) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidReplay(`block ${index} must be an object`);
		const block = value;
		if (![
			"text",
			"reasoning",
			"tool-call"
		].includes(String(block["type"]))) return invalidReplay(`block ${index} has an unknown type`);
		for (const signature of [
			"textSignature",
			"thinkingSignature",
			"thoughtSignature"
		]) if (block[signature] !== void 0 && typeof block[signature] !== "string") return invalidReplay(`block ${index} ${signature} must be a string`);
		if (block["redacted"] !== void 0 && typeof block["redacted"] !== "boolean") return invalidReplay(`block ${index} redacted must be boolean`);
	}
	return {
		response,
		blocks
	};
}
/** Convert provider-neutral blocks without trusting them as same-model replay. */
function foreignAssistant(message) {
	const source = message.source.kind === "model" ? message.source : void 0;
	const content = [];
	for (const block of message.content) switch (block.type) {
		case "text":
			content.push({
				type: "text",
				text: block.text
			});
			break;
		case "reasoning":
			content.push({
				type: "thinking",
				thinking: block.text
			});
			break;
		case "tool-call":
			content.push({
				type: "toolCall",
				id: block.id,
				name: block.name,
				arguments: parseArguments(block.arguments)
			});
			break;
		case "image": throw new LlmError("pi-ai chat history cannot represent structured assistant image output", "UNSUPPORTED_CONTENT");
		default: break;
	}
	return {
		role: "assistant",
		content,
		api: "dsh-foreign",
		provider: source?.provider ?? "dsh-foreign",
		model: source?.model ?? "dsh-foreign",
		usage: emptyPiUsage(),
		stopReason: content.some((piece) => piece.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0
	};
}
/** Recombine durable Harness content with validated pi-ai replay metadata. */
function replayedAssistant(message, source, rawState) {
	const state = readReplayState(rawState);
	if (state.response.provider !== source.provider) return invalidReplay("provider does not match assistant source");
	if (state.response.model !== source.model) return invalidReplay("model does not match assistant source");
	if (state.blocks.length !== message.content.length) return invalidReplay("block count does not match assistant content");
	return {
		role: "assistant",
		content: message.content.map((block, index) => {
			const replay = state.blocks[index];
			if (replay === void 0 || replay.type !== block.type) return invalidReplay(`block ${index} does not match assistant content`);
			switch (block.type) {
				case "text": return {
					type: "text",
					text: block.text,
					...replay.type === "text" && replay.textSignature !== void 0 ? { textSignature: replay.textSignature } : {}
				};
				case "reasoning": return {
					type: "thinking",
					thinking: block.text,
					...replay.type === "reasoning" && replay.thinkingSignature !== void 0 ? { thinkingSignature: replay.thinkingSignature } : {},
					...replay.type === "reasoning" && replay.redacted !== void 0 ? { redacted: replay.redacted } : {}
				};
				case "tool-call": return {
					type: "toolCall",
					id: block.id,
					name: block.name,
					arguments: parseArguments(block.arguments),
					...replay.type === "tool-call" && replay.thoughtSignature !== void 0 ? { thoughtSignature: replay.thoughtSignature } : {}
				};
				/* v8 ignore next -- readReplayState rejects unknown replay tags, so an equal plugin-added Harness tag cannot reach this switch */
				default: return invalidReplay(`block ${index} has an unsupported Harness type`);
			}
		}),
		api: state.response.api,
		provider: state.response.provider,
		model: state.response.model,
		...state.response.responseModel === void 0 ? {} : { responseModel: state.response.responseModel },
		...state.response.responseId === void 0 ? {} : { responseId: state.response.responseId },
		usage: emptyPiUsage(),
		stopReason: state.response.stopReason,
		timestamp: 0
	};
}
/**
* Convert one durable Harness assistant message into pi-ai history.
*
* Durable content is the authoritative record; replay metadata only restores
* native fidelity (ids, signatures). A replay state this build cannot use —
* another adapter's kind, another version, a malformed value, or metadata that
* no longer matches the content — therefore degrades the one message to
* provider-neutral history instead of failing the request.
* @param message - assistant content with required source and optional adapter-owned replay metadata.
* @param onDegrade - called with the diagnostic reason when an unusable replay
*   state falls back to provider-neutral conversion.
* @returns a native pi-ai assistant message reconstructed from durable content.
*/
function toPiAssistant(message, onDegrade) {
	const source = message.source;
	if (source.kind !== "model" || source.replayState === void 0) return foreignAssistant(message);
	try {
		return replayedAssistant(message, source, source.replayState);
	} catch (error) {
		/* v8 ignore next -- replayedAssistant throws only INVALID_REPLAY_STATE LlmErrors today; the
		guard keeps a future non-replay failure loud instead of silently degrading it */
		if (!(error instanceof LlmError) || error.code !== "INVALID_REPLAY_STATE") throw error;
		onDegrade?.(error.message);
		return foreignAssistant(message);
	}
}
/** Every request modality a profile may declare. */
const MODALITIES = Object.keys({
	text: true,
	image: true
});
/** Every pi-ai thinking level a profile may declare, in escalation order. */
const THINKING_LEVELS = Object.keys({
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
	max: true
});
/** Reasoning-dispatch wire formats a profile may name, most-reached first. */
const SUPPORTED_THINKING_FORMATS = Object.keys({
	"openai": true,
	"deepseek": true,
	"openrouter": true,
	"together": true,
	"zai": true,
	"qwen": true,
	"chat-template": true,
	"qwen-chat-template": true,
	"string-thinking": true,
	"ant-ling": true
});
/** The output-cap field spellings a profile may name. */
const MAX_TOKENS_FIELDS = Object.keys({
	max_completion_tokens: true,
	max_tokens: true
});
/** The prompt-cache marker conventions a profile may name. */
const CACHE_CONTROL_FORMATS = Object.keys({ anthropic: true });
/** The request-state placeholders a profile may name. */
const CHAT_TEMPLATE_VARS = Object.keys({
	"thinking.enabled": true,
	"thinking.effort": true
});
/**
* Construction of the pi-ai `Provider` that one configured route registers into
* the adapter's `Models` collection.
*
* Two constructions, one decision: a route the installed catalog ships, whose
* profile does not override the wire protocol, **reuses that catalog provider**
* with its models replaced — the catalog provider owns API implementations this
* package cannot reconstruct (Bedrock loads its Smithy module through a
* separate entry point), so rebuilding it from parts would silently narrow
* which providers work. Every other route — one pi-ai has never heard of, or a
* catalog route pointed at a different protocol — is built by `createProvider`
* over the protocol table below.
*
* Credentials never reach this module's storage: the harness resolves a route's
* key through `ctx.credentials` before the request enters pi-ai and hands it
* over as a stream option, which `Models` presents to `resolve()` as the
* credential key.
*
* @module dsh-llm-pi-ai/provider
*/
/**
* Wire protocols a configured route may name, mapped to pi-ai's lazily loaded
* implementations. Each entry is the factory that pi-ai's matching provider
* factory uses, so a hand-declared route reaches exactly the implementation a
* catalog route would.
*
* The table is deliberately narrow: the protocols a hand-declared route
* actually reaches for today, each completely describable with a key, an
* endpoint, and headers. Bedrock signs with SigV4 over AWS credentials and a
* region, Vertex needs a project, a location, and application-default
* credentials, Azure needs provider environment plus an api-version, and Codex
* authenticates through OAuth — none of which this configuration shape can
* express, so offering them would hand back a provider that cannot
* authenticate. The remainder are absent for want of a consumer rather than a
* blocker: each is one line here once a deployment needs it. Catalog routes
* still reach every protocol through their own provider; only an explicit
* override is refused.
*/
const PROTOCOLS = {
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"anthropic-messages": anthropicMessagesApi
};
/**
* Every wire protocol a configured route may name, most-reached first. The
* order is the table's and therefore stable; a configuration surface offering
* a choice presents the first as its default, which is why the protocol a
* hand-declared gateway most often speaks — and the one endpoint interrogation
* can read — leads.
* @returns the supported protocol identifiers.
*/
function supportedProtocols() {
	return Object.keys(PROTOCOLS);
}
/**
* Configuration schema and provider-profile validation for the pi-ai adapter.
* Profiles are a dict keyed by provider route, so the composition base and a
* user-settings layer merge per provider and the route set is structural.
*
* A route key is not required to name an installed pi-ai provider. When it does,
* that provider's endpoint, protocol, display name, and model catalog are the
* profile's defaults and the profile overrides them field by field; when it does
* not, the profile is the whole provider declaration. Resolution therefore ends
* in a built pi-ai `Provider` per route: everything a request needs is decided
* once, while the configuration key that made a route unserviceable can still be
* named in the failure.
*
* @module dsh-llm-pi-ai/config
*/
/** Default maximum idle interval while an adapter stream read is outstanding. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Default request-level bound on base64-encoded image payload. Every image in
* history is re-encoded into every request body, so an unbounded conversation
* eventually exceeds a provider or gateway request-size cap and the session
* can never complete another request. The 20MiB default admits fifteen 1MiB
* request versions after base64 expansion and reserves request capacity for
* system prompts, history, tools, and JSON.
* Deployments behind stricter gateways lower it per route.
*/
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20971520;
/** Default total-pixel budget preserves the complete 2048px normalized attachment. */
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4194304;
/** Default raw encoded-byte cap before inline base64 expansion. */
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1048576;
/** Context capacity assumed for a model neither configuration nor the catalog sizes. */
const DEFAULT_CONTEXT_WINDOW = 262144;
/** Output capability assumed for a model neither configuration nor the catalog sizes. */
const DEFAULT_MAX_TOKENS = 32768;
/**
* Modalities assumed for a model neither configuration nor the catalog
* declares. Text is the floor every supported protocol certainly carries, so
* this is the absence of a declaration rather than a guess at the endpoint:
* nothing can interrogate a gateway for its modalities, and the two wrong
* answers do not cost the same. Under-claiming refuses the image before it is
* attached, naming the model. Over-claiming admits one the provider then
* rejects mid-turn, after the message is durable, leaving the session
* repeating a request that cannot succeed.
*/
const DEFAULT_INPUT = ["text"];
const thinkingBudgets = z.object({
	minimal: z.number(),
	low: z.number(),
	medium: z.number(),
	high: z.number()
});
/**
* One `chat_template_kwargs` value. The `$var` member is pi-ai's placeholder
* for a value dispatch fills from the request's thinking state, which is what
* makes a chat-template gateway configurable without restating its template.
*/
const chatTemplateKwarg = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.const(null),
	z.object({
		$var: z.union(CHAT_TEMPLATE_VARS).required(),
		omitWhenOff: z.boolean()
	})
]);
const compatProfile = z.object({
	supportsStore: z.boolean(),
	supportsDeveloperRole: z.boolean(),
	supportsReasoningEffort: z.boolean(),
	supportsUsageInStreaming: z.boolean(),
	maxTokensField: z.union(MAX_TOKENS_FIELDS),
	requiresToolResultName: z.boolean(),
	requiresAssistantAfterToolResult: z.boolean(),
	requiresThinkingAsText: z.boolean(),
	requiresReasoningContentOnAssistantMessages: z.boolean(),
	thinkingFormat: z.union(SUPPORTED_THINKING_FORMATS),
	chatTemplateKwargs: z.dict(chatTemplateKwarg),
	supportsStrictMode: z.boolean(),
	cacheControlFormat: z.union(CACHE_CONTROL_FORMATS),
	supportsLongCacheRetention: z.boolean(),
	supportsEagerToolInputStreaming: z.boolean(),
	supportsCacheControlOnTools: z.boolean(),
	supportsTemperature: z.boolean(),
	forceAdaptiveThinking: z.boolean(),
	allowEmptySignature: z.boolean(),
	supportsStrictTools: z.boolean()
});
/**
* Keys are the offered levels, values their wire spellings. A valueless key
* (`off:`) survives validation because schemastery passes nullable data
* through before any member schema runs — `z.const(null)` only controls the
* error for non-null wrong values and what a configuration UI renders.
* Only resolution decides which levels may leave the value empty, so the
* diagnostic can name the route and model. The assertion narrows
* schemastery's `Dict`, which types every literal key as required; dict
* validation checks only present keys, so the runtime value is a partial record.
*/
const reasoningEfforts = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS));
/** The fields a `models` entry and a `modelOverrides` value share; only the id's home differs. */
const modelFields = {
	name: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	input: z.array(z.union(MODALITIES)),
	reasoningEfforts: z.union([z.const(false), reasoningEfforts]),
	compat: compatProfile
};
const modelProfile = z.object({
	id: z.string().required(),
	...modelFields
});
/** A {@link modelProfile} whose id lives in the `modelOverrides` dict key. */
const modelOverride = z.object(modelFields);
const profile = z.object({
	apiKeyEnv: z.string().role("credential-ref"),
	displayName: z.string(),
	api: z.union(supportedProtocols()),
	baseURL: z.string(),
	models: z.array(modelProfile),
	modelOverrides: z.dict(modelOverride),
	compat: compatProfile,
	defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
	defaultMaxTokens: z.number().step(1).min(1).default(DEFAULT_MAX_TOKENS),
	defaultInput: z.array(z.union(MODALITIES)).default([...DEFAULT_INPUT]),
	headers: z.dict(z.string()),
	reasoning: z.union(THINKING_LEVELS),
	thinkingBudgets,
	cacheRetention: z.union([
		"none",
		"short",
		"long"
	]),
	transport: z.union([
		"sse",
		"websocket",
		"websocket-cached",
		"auto"
	]),
	timeoutMs: z.natural(),
	websocketConnectTimeoutMs: z.natural(),
	streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
	maxRequestImageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_REQUEST_IMAGE_BYTES),
	requestImagePixelBudget: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET),
	requestImageMaxBytes: z.number().step(1).min(1).default(DEFAULT_REQUEST_IMAGE_MAX_BYTES),
	retryPolicy: RetryPolicySchema
});
z.object({ providers: z.dict(profile).default({}) });
/**
* Harness request-history conversion into pi-ai's Context vocabulary.
*
* @module dsh-llm-pi-ai/context
*/
/** Join the text blocks of a harness message. */
function flattenText(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Flatten text recursively inside one tool result. */
function toolResultText(blocks) {
	return blocks.map((block) => block.type === "text" ? block.text : block.type === "tool-result" ? toolResultText(block.content) : "").join("");
}
/** Reject image roles that pi-ai cannot replay before request-size offloading can replace them. */
function assertSupportedImageRoles(messages) {
	for (const message of messages) if (message.role !== "user" && contentHasImage(message.content)) throw new LlmError(`pi-ai cannot represent an image in an in-history ${message.role} message`, "UNSUPPORTED_CONTENT");
}
async function userContent(blocks, requestImages) {
	const content = [];
	for (const block of blocks) switch (block.type) {
		case "text":
			if (block.text.length > 0) content.push({
				type: "text",
				text: block.text
			});
			break;
		case "image": {
			const version = requestImages.get(block.attachment.attachmentId);
			content.push({
				type: "text",
				text: requestImageHandleText(version)
			});
			content.push({
				type: "image",
				data: Buffer.from(version.data).toString("base64"),
				mimeType: version.mediaType
			});
			break;
		}
		case "tool-result":
			{
				const nested = await userContent(block.content, requestImages);
				if (typeof nested === "string") {
					if (nested.length > 0) content.push({
						type: "text",
						text: nested
					});
				} else content.push(...nested);
			}
			break;
		default: break;
	}
	if (content.every((block) => block.type === "text")) return content.map((block) => block.text).join("");
	return content;
}
function collectImageRefs(blocks, refs) {
	for (const block of blocks) if (block.type === "image") refs.set(block.attachment.attachmentId, block.attachment);
	else if (block.type === "tool-result") collectImageRefs(block.content, refs);
}
async function prepareRequestImages(messages, attachments, policy, signal) {
	const refs = /* @__PURE__ */ new Map();
	for (const message of messages) collectImageRefs(message.content, refs);
	const orderedRefs = [...refs.values()];
	const prepared = await Promise.all(orderedRefs.map((ref) => attachments.readImageRequest(ref, policy, signal)));
	const versions = /* @__PURE__ */ new Map();
	for (const [index, ref] of orderedRefs.entries()) versions.set(ref.attachmentId, prepared[index]);
	return versions;
}
function toolsOf(options) {
	return options.tools?.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters
	}));
}
/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options, messages) {
	const tools = toolsOf(options);
	return {
		...options.system !== void 0 ? { systemPrompt: options.system } : {},
		messages,
		...tools !== void 0 && tools.length > 0 ? { tools } : {}
	};
}
function textOnlyContext(options, onReplayDegrade) {
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of options.messages) {
		if (contentHasImage(message.content)) throw new LlmError("pi-ai image conversion requires the durable attachment service", "UNSUPPORTED_CONTENT");
		if (message.role === "system") {
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message, onReplayDegrade);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const text = flattenText(message);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (text.length > 0 || results.length === 0) messages.push({
			role: "user",
			content: text,
			timestamp: 0
		});
		for (const result of results) messages.push({
			role: "toolResult",
			toolCallId: result.toolCallId,
			toolName: toolNames.get(result.toolCallId) ?? "unknown",
			content: [{
				type: "text",
				text: toolResultText(result.content) || "(no output)"
			}],
			isError: result.isError ?? false,
			timestamp: 0
		});
	}
	return piContext(options, messages);
}
function toPiContext(options, attachments, onReplayDegrade, maxRequestImageBytes, requestImagePolicy) {
	return attachments === void 0 ? textOnlyContext(options, onReplayDegrade) : toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes, requestImagePolicy);
}
async function toPiContextWithImages(options, attachments, onReplayDegrade, maxRequestImageBytes, requestImagePolicy = {
	maxPixels: DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
	maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES
}) {
	assertSupportedImageRoles(options.messages);
	const requestMessages = offloadRequestImagesWithPolicy(options.messages, {
		representation: "base64",
		...maxRequestImageBytes === void 0 ? {} : { maxBytes: maxRequestImageBytes },
		byteQuantum: 1,
		byteLength: (ref) => Math.min(ref.bytes, requestImagePolicy.maxBytes)
	});
	const requestImages = await prepareRequestImages(requestMessages, attachments, requestImagePolicy, options.signal);
	const exactMessages = offloadRequestImagesWithPolicy(requestMessages, {
		representation: "base64",
		...maxRequestImageBytes === void 0 ? {} : { maxBytes: maxRequestImageBytes },
		byteQuantum: 1,
		byteLength: (ref) => requestImages.get(ref.attachmentId).bytes
	});
	const toolNames = /* @__PURE__ */ new Map();
	const messages = [];
	for (const message of exactMessages) {
		if (message.role === "system") {
			messages.push({
				role: "user",
				content: flattenText(message),
				timestamp: 0
			});
			continue;
		}
		if (message.role === "assistant") {
			const assistant = toPiAssistant(message, onReplayDegrade);
			for (const block of assistant.content) if (block.type === "toolCall") toolNames.set(CallId(block.id), block.name);
			messages.push(assistant);
			continue;
		}
		const content = await userContent(message.content.filter((block) => block.type !== "tool-result"), requestImages);
		const results = message.content.filter((block) => block.type === "tool-result");
		if (content.length > 0 || results.length === 0) messages.push({
			role: "user",
			content,
			timestamp: 0
		});
		for (const result of results) {
			const resultContent = await userContent(result.content, requestImages);
			messages.push({
				role: "toolResult",
				toolCallId: result.toolCallId,
				toolName: toolNames.get(result.toolCallId) ?? "unknown",
				content: typeof resultContent === "string" ? [{
					type: "text",
					text: resultContent || "(no output)"
				}] : resultContent,
				isError: result.isError ?? false,
				timestamp: 0
			});
		}
	}
	return piContext(options, messages);
}
/**
* pi-ai assistant event translation into the Harness streaming protocol.
*
* pi-ai tool-call arguments are parsed objects while the Harness keeps their
* raw JSON representation. pi-ai also reports failures as terminal stream
* events, which this module maps into Harness finish chunks.
*
* @module dsh-llm-pi-ai/stream
*/
/**
* Map pi-ai usage (reasoning folded into output by pi-ai).
* @param usage - cumulative usage from the terminal pi-ai event.
* @returns harness counts; cache fields appear only when non-zero (pi-ai reports zeros, not absence).
*/
function mapUsage(usage) {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		...usage.cacheRead > 0 ? { cacheReadTokens: usage.cacheRead } : {},
		...usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}
	};
}
function classifyPiAiError(message) {
	if (/\b(?:401|403)\b/.test(message)) return "AUTH";
	if (isQuotaExceededError(message)) return QUOTA_EXCEEDED_CODE;
	if (/\b429\b|rate.?limit/i.test(message)) return "RATE_LIMIT";
	if (/\b413\b|failed to buffer the request body:\s*length limit exceeded|payload too large|request body too large/i.test(message)) return "INVALID_REQUEST";
	if (/\b400\b|invalid.?request/i.test(message)) return "INVALID_REQUEST";
	if (/\b5\d\d\b/.test(message)) return "SERVER";
	if (/\btime(?:d)?\s*out\b|timeout/i.test(message)) return "TIMEOUT";
	if (/stream ended (?:before|without)\b/i.test(message)) return "TRANSPORT";
	if (/\b(?:network|connection|socket|fetch)\b|\bECONN[A-Z]+\b/i.test(message) || /\b(?:other side closed|HTTP2 request did not get a response|WebSocket closed unexpectedly)\b/i.test(message) || /\bterminated\b|premature close/i.test(message)) return "TRANSPORT";
	return "PI_AI_ERROR";
}
/**
* Map a terminal pi-ai event to the harness finish reason.
* @param message - the assistant message carried by the `done` or `error` event.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the mapped harness reason. Recognized error text, `stop` usage above
*   `contextWindow`, and zero-output `length` usage that fills the window map
*   to `CONTEXT_WINDOW_EXCEEDED`; a `stop` with no content blocks maps to an
*   `EMPTY_RESPONSE` error.
*/
function mapStopReason(message, contextWindow) {
	const piAiOverflow = isContextOverflow(message, contextWindow);
	const harnessOverflow = message.stopReason === "error" && message.errorMessage !== void 0 && isContextWindowExceededError(message.errorMessage);
	if (piAiOverflow || harnessOverflow) return {
		kind: "error",
		failure: {
			message: message.errorMessage ?? `pi-ai detected context overflow for model "${message.model}"`,
			code: CONTEXT_WINDOW_EXCEEDED_CODE
		}
	};
	switch (message.stopReason) {
		case "stop":
			if (message.content.length === 0) return {
				kind: "error",
				failure: {
					message: `model "${message.model}" returned a completed response with no content`,
					code: EMPTY_RESPONSE_CODE
				}
			};
			return { kind: "stop" };
		case "length": return { kind: "max-tokens" };
		case "toolUse": return { kind: "tool-calls" };
		case "aborted": return {
			kind: "aborted",
			failure: {
				message: message.errorMessage ?? "pi-ai stream aborted",
				code: "ABORTED"
			}
		};
		case "error": {
			const text = message.errorMessage ?? "pi-ai stream error";
			return {
				kind: "error",
				failure: {
					message: text,
					code: classifyPiAiError(text)
				}
			};
		}
	}
}
/**
* Translate the pi-ai event stream into StreamChunks. pi-ai never throws
* mid-stream — failures arrive as `error` events, which become error/aborted
* `finish` chunks (the harness protocol's other error-delivery style).
* @param events - one assistant turn's pi-ai event stream.
* @param contextWindow - resolved catalog capacity for usage-based overflow detection.
* @returns the harness chunks, ending with `usage` then `finish`; throws
*   `LlmError` (`STREAM_CLOSED`) if the source ends without a terminal event.
*/
async function* toStreamChunks(events, contextWindow) {
	const toolIds = /* @__PURE__ */ new Map();
	for await (const event of events) switch (event.type) {
		case "start": break;
		case "text_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "text"
			};
			break;
		case "text_delta":
			yield {
				type: "text-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "text_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "text",
					text: event.content
				}
			};
			break;
		case "thinking_start":
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "reasoning"
			};
			break;
		case "thinking_delta":
			yield {
				type: "reasoning-delta",
				index: event.contentIndex,
				text: event.delta
			};
			break;
		case "thinking_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "reasoning",
					text: event.content
				}
			};
			break;
		case "toolcall_start": {
			const partial = event.partial.content[event.contentIndex];
			const id = partial?.type === "toolCall" ? partial.id : "";
			const name = partial?.type === "toolCall" ? partial.name : "";
			toolIds.set(event.contentIndex, {
				id,
				name
			});
			yield {
				type: "block-start",
				index: event.contentIndex,
				blockType: "tool-call"
			};
			break;
		}
		case "toolcall_delta": {
			const known = toolIds.get(event.contentIndex);
			yield {
				type: "tool-call-delta",
				index: event.contentIndex,
				id: CallId(known?.id ?? ""),
				...known?.name !== void 0 && known.name.length > 0 ? { name: known.name } : {},
				argumentsDelta: event.delta
			};
			break;
		}
		case "toolcall_end":
			yield {
				type: "block-end",
				index: event.contentIndex,
				block: {
					type: "tool-call",
					id: CallId(event.toolCall.id),
					name: event.toolCall.name,
					arguments: JSON.stringify(event.toolCall.arguments)
				}
			};
			break;
		case "done":
			yield {
				type: "usage",
				usage: mapUsage(event.message.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.message, contextWindow),
				replayState: toPiReplayState(event.message)
			};
			return;
		case "error":
			yield {
				type: "usage",
				usage: mapUsage(event.error.usage)
			};
			yield {
				type: "finish",
				reason: mapStopReason(event.error, contextWindow)
			};
			return;
	}
	throw new LlmError("pi-ai event stream ended without done/error", "STREAM_CLOSED");
}
/**
* Generic pi-ai-backed implementation of the Harness LLM seam.
*
* Each resolution produces one **immutable** snapshot — the profiles plus a
* `Models` collection holding the `Provider` each route built — and an
* operation captures a whole snapshot before its first `await`. A
* configuration change builds a *new* collection rather than mutating the one
* in use, because `Models.streamSimple()` is lazy: it resolves the provider
* when the stream is first consumed, which is after the credential await, so a
* mutated collection would let a request that started under one configuration
* finish under another — or fail with a provider that no longer exists. This is
* what makes the seam's per-step call freeze (`llm.prepareCall()`) hold all the
* way down: switching models mid-reply takes effect on the next step, never
* inside the one in flight.
*
* A route naming a credential reference still resolves it through the harness
* seam and passes it as the request's `apiKey` option, which pi-ai treats as
* the highest-priority auth override — that is what keeps the fail-loud
* reference semantics. Everything that override does not cover reaches pi-ai
* through the collection's own auth: the credential store holds the records a
* login wrote and a refresh rotates, and the auth context answers the ambient
* questions a provider asks while resolving. Both are stable across snapshots,
* so a configuration change rebuilds the collection without forgetting who is
* signed in.
*
* @module dsh-llm-pi-ai/adapter
*/
var __addDisposableResource = function(env, value, async) {
	if (value !== null && value !== void 0) {
		if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
		var dispose, inner;
		if (async) {
			if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
			dispose = value[Symbol.asyncDispose];
		}
		if (dispose === void 0) {
			if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
			dispose = value[Symbol.dispose];
			if (async) inner = dispose;
		}
		if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
		if (inner) dispose = function() {
			try {
				inner.call(this);
			} catch (e) {
				return Promise.reject(e);
			}
		};
		env.stack.push({
			value,
			dispose,
			async
		});
	} else if (async) env.stack.push({ async: true });
	return value;
};
var __disposeResources = (function(SuppressedError) {
	return function(env) {
		function fail(e) {
			env.error = env.hasError ? new SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
			env.hasError = true;
		}
		var r, s = 0;
		function next() {
			while (r = env.stack.pop()) try {
				if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
				if (r.dispose) {
					var result = r.dispose.call(r.value);
					if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
						fail(e);
						return next();
					});
				} else s |= 1;
			} catch (e) {
				fail(e);
			}
			if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
			if (env.hasError) throw env.error;
		}
		return next();
	};
})(typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
	var e = new Error(message);
	return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
});
/** Copy profile stream knobs into pi-ai's common option vocabulary. */
function profileOptions(profile, reasoning, apiKey) {
	const enabledReasoning = reasoning === "off" ? void 0 : reasoning;
	return {
		...apiKey === void 0 ? {} : { apiKey },
		...enabledReasoning === void 0 ? {} : { reasoning: enabledReasoning },
		...profile.thinkingBudgets === void 0 ? {} : { thinkingBudgets: profile.thinkingBudgets },
		...profile.cacheRetention === void 0 ? {} : { cacheRetention: profile.cacheRetention },
		...profile.transport === void 0 ? {} : { transport: profile.transport },
		...profile.timeoutMs === void 0 ? {} : { timeoutMs: profile.timeoutMs },
		...profile.websocketConnectTimeoutMs === void 0 ? {} : { websocketConnectTimeoutMs: profile.websocketConnectTimeoutMs },
		maxRetries: 0
	};
}
/**
* The profile default this exact model can actually take, for DESCRIBING it.
* A configured level the model does not support yields none rather than
* throwing: `resolveModel` builds the model catalog, and a catalog that fails
* takes its whole provider out of every picker — so one mis-set profile field
* would hide every model on the route, including the ones that support the
* level. The request path still refuses, which is where a bad configuration
* belongs: describing what a model can do must not fail because a deployment
* asked it for something it cannot.
* @param model - the resolved model descriptor.
* @param effort - the profile's configured level, if any.
* @returns the level when this model supports it, otherwise undefined.
*/
function describableReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	return getSupportedThinkingLevels(model).some((level) => level === effort) ? effort : void 0;
}
/** Validate an explicit Harness/profile effort without invoking pi-ai's clamp. */
function resolveReasoningLevel(model, effort) {
	if (effort === void 0) return void 0;
	if (getSupportedThinkingLevels(model).some((level) => level === effort)) return effort;
	throw new LlmError(`pi-ai provider "${model.provider}" model "${model.id}" does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* Selectable reasoning efforts for one model, or nothing at all.
*
* A model that carries no reasoning metadata — every hand-declared one, and
* every catalog model pi-ai marks as non-reasoning — is reported by pi-ai as
* supporting the single level `off`. Passing that through would offer a control
* that cannot do what it says: `off` is translated to *omitting* the reasoning
* option, which for such a model is byte-for-byte the same request as naming no
* effort — so a provider whose own default is to think would keep thinking with
* `off` selected. Omitting `reasoning` entirely is the seam's way of saying the
* capability is unavailable, which leaves the surface offering only the
* provider's default.
* @param model - the resolved model descriptor.
* @param defaultLevel - the profile's configured effort, already validated.
* @returns the `reasoning` field, or an empty object when none can be offered.
*/
function reasoningInfo(model, defaultLevel) {
	if (!model.reasoning) return {};
	return { reasoning: {
		efforts: getSupportedThinkingLevels(model).map((level) => ({
			id: ReasoningEffortId(level),
			name: `${level.charAt(0).toUpperCase()}${level.slice(1)}`
		})),
		...defaultLevel === void 0 ? {} : { defaultEffort: ReasoningEffortId(defaultLevel) }
	} };
}
/** Merge deployment headers while removing case-insensitive attribution collisions. */
function requestHeaders(headers) {
	const attribution = attributionHeaders();
	const reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
	return {
		...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
		...attribution
	};
}
/**
* pi-ai-backed multi-provider adapter. Each operation reads the current
* profiles, so a configuration change reaches the next request without a
* restart; model descriptors come from the collection those profiles built.
*/
var PiAiAdapter = class extends LlmAdapter {
	config;
	snapshot;
	constructor(config) {
		super();
		this.config = config;
	}
	/**
	* The snapshot for the current profiles. Resolution memoizes its result, so
	* an unchanged configuration is recognized by identity; a changed one gets a
	* brand-new collection, leaving any snapshot an operation already captured
	* untouched for as long as that operation holds it.
	*/
	current() {
		const profiles = this.config.profiles();
		if (this.snapshot?.profiles === profiles) return this.snapshot;
		const models = createModels(this.config.auth);
		for (const profile of profiles.values()) models.setProvider(profile.piProvider);
		this.snapshot = {
			profiles,
			models
		};
		return this.snapshot;
	}
	/** The profile for one route within one snapshot, or the not-owned failure. */
	profileOf(snapshot, provider) {
		const profile = snapshot.profiles.get(provider);
		if (profile === void 0) throw new LlmError(`pi-ai adapter does not own provider "${provider}"`, "NO_ADAPTER");
		return profile;
	}
	/** The configured descriptor for one exact route/model pair within one snapshot. */
	modelOf(snapshot, provider, model) {
		this.profileOf(snapshot, provider);
		const resolved = snapshot.models.getModel(provider, model);
		if (resolved === void 0) throw new LlmError(`pi-ai provider "${provider}" has no configured model "${model}"`, "UNKNOWN_MODEL");
		return resolved;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.current().profiles.get(provider)?.displayName ?? provider
		};
	}
	providerRetryPolicy(provider) {
		return this.current().profiles.get(provider)?.retryPolicy;
	}
	listModels(provider) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			this.profileOf(snapshot, provider);
			return snapshot.models.getModels(provider).map((model) => ({
				provider,
				id: model.id,
				name: model.name,
				inputModalities: [...model.input]
			}));
		});
	}
	resolveModel(provider, model, _signal) {
		return Promise.resolve().then(() => {
			const snapshot = this.current();
			return this.modelInfo(snapshot, provider, model);
		});
	}
	modelInfo(snapshot, provider, model) {
		const profile = this.profileOf(snapshot, provider);
		const resolvedModel = this.modelOf(snapshot, provider, model);
		const defaultLevel = describableReasoningLevel(resolvedModel, profile.reasoning);
		const configuredMaxTokens = profile.configuredMaxTokens.get(model);
		return {
			provider,
			id: model,
			name: resolvedModel.name,
			inputModalities: [...resolvedModel.input],
			context: { contextWindow: resolvedModel.contextWindow },
			...configuredMaxTokens === void 0 ? {} : { defaultMaxTokens: configuredMaxTokens },
			...reasoningInfo(resolvedModel, defaultLevel)
		};
	}
	prepareCall(provider, model, _signal) {
		const snapshot = this.current();
		return Promise.resolve({
			model: this.modelInfo(snapshot, provider, model),
			stream: (options) => this.streamWithSnapshot(options, snapshot)
		});
	}
	stream(options) {
		return this.streamWithSnapshot(options, this.current());
	}
	async *streamWithSnapshot(options, snapshot) {
		const env_1 = {
			stack: [],
			error: void 0,
			hasError: false
		};
		try {
			if (options.stop !== void 0) throw new LlmError("llm-pi-ai does not support GenerateOptions.stop", "UNSUPPORTED_OPTION");
			const profile = this.profileOf(snapshot, options.provider);
			const model = this.modelOf(snapshot, options.provider, options.model);
			const reasoning = resolveReasoningLevel(model, options.reasoningEffort ?? profile.reasoning);
			const apiKey = await this.config.resolveApiKey(options.provider, profile);
			const consumer = new AbortController();
			const upstream = options.signal === void 0 ? consumer.signal : AbortSignal.any([options.signal, consumer.signal]);
			const streamIdleTimeoutMs = profile.streamIdleTimeoutMs;
			const watchdog = __addDisposableResource(env_1, idleWatchdog(upstream, streamIdleTimeoutMs, "LLM_STREAM_IDLE_TIMEOUT"), false);
			try {
				const containsImage = options.messages.some((message) => contentHasImage(message.content));
				if (containsImage && !model.input.includes("image")) throw new LlmError(`pi-ai model "${model.id}" does not support image input`, "UNSUPPORTED_CONTENT");
				const attachments = containsImage ? this.config.resolveAttachments?.() : void 0;
				if (containsImage && attachments === void 0) throw new LlmError("pi-ai image input requires the durable attachment service", "UNSUPPORTED_CONTENT");
				const onReplayDegrade = (reason) => {
					this.config.onReplayDegrade?.({
						provider: options.provider,
						model: options.model,
						reason
					});
				};
				const context = attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext({
					...options,
					signal: watchdog.signal
				}, attachments, onReplayDegrade, profile.maxRequestImageBytes, {
					maxPixels: profile.requestImagePixelBudget,
					maxBytes: profile.requestImageMaxBytes
				});
				const iterator = toStreamChunks(snapshot.models.streamSimple(model, context, {
					...profileOptions(profile, reasoning, apiKey),
					...options.temperature === void 0 ? {} : { temperature: options.temperature },
					...options.maxTokens === void 0 ? {} : { maxTokens: options.maxTokens },
					...options.sessionId === void 0 ? {} : { sessionId: String(options.sessionId) },
					signal: watchdog.signal,
					headers: requestHeaders(profile.headers)
				}), model.contextWindow)[Symbol.asyncIterator]();
				let exhausted = false;
				try {
					while (true) {
						const result = await watchdog.next(iterator);
						const timeout = timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT");
						if (timeout !== void 0) throw timeout;
						if (result.done) {
							exhausted = true;
							return;
						}
						yield result.value;
					}
				} finally {
					if (!exhausted) {
						consumer.abort("pi-ai stream consumer stopped");
						try {
							await iterator.return(void 0);
						} catch (_abortedSdkTeardown) {}
					}
				}
			} catch (error) {
				if (timeoutOf(watchdog.signal, "LLM_STREAM_IDLE_TIMEOUT") !== void 0) throw new LlmError(`pi-ai stream idle timeout after ${streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
				if (options.signal?.aborted) throw new LlmError("pi-ai request aborted by caller", "ABORTED", { cause: error });
				throw error;
			} finally {
				consumer.abort("pi-ai stream consumer stopped");
			}
		} catch (e_1) {
			env_1.error = e_1;
			env_1.hasError = true;
		} finally {
			__disposeResources(env_1);
		}
	}
};
settingsNamespace("llm-pi-ai");
//#endregion
//#region src/adapter.ts
/**
* The `workbuddy` pi-ai provider: one loopback-backed adapter registered
* into the Harness LLM seam, assembled from public `dsh-llm-pi-ai`
* extension points the way `dsh-codex-connect` assembles its Codex route.
*
* @module dsh-workbuddy-connect/adapter
*/
/** Provider route this bundle owns. */
const WORKBUDDY_PROVIDER = "workbuddy";
/** Provider idle ceiling while one stream read is outstanding. */
const WORKBUDDY_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Image-request budgets at the dsh-llm-pi-ai defaults; the profile type made
* them required in 0.1.1-rc.2. They bound requests to models whose catalog
* entry declares `supportsImages`; text-only models never receive images.
*/
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/**
* Inert pi-ai auth plane. The workbuddy route authenticates only through the
* shim shared secret resolved per request by `resolveApiKey`, so pi-ai's own
* credential lifecycle and ambient discovery must never manufacture a
* credential for it. `PiAiAdapterOptions.auth` is required since 0.1.1-rc.2;
* every ambient question here answers "nothing stored, nothing set".
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-workbuddy-connect: the workbuddy route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* The suffix appended to a model's display name so its billing rate is visible
* wherever the name is shown.
*
* The separator is a middle dot rather than a hyphen or colon: model names
* already contain hyphens (`GLM-5.3-Flash`, `Deepseek-V4-Flash`), so a hyphen
* separator would be ambiguous about where the name ends and the rate begins.
*/
const RATE_SEPARATOR = " · ";
/**
* Append the catalog display suffix (rate and promo badges) to one model's
* display name.
*
* The rate AND the declared promo badges ride the *name* alone: since DSH
* 0.1.2 the composer's model seat (`ModelSelect`) renders `model.name` only —
* `description` is no longer read there at all (the 0.1.1-era client rendered
* it, which is why the badges used to be visible in the seat). The `/model`
* popup renders the name too, so a separate `description` copy would either
* duplicate (rate) or vanish (badges) depending on client generation.
*
* This is display-only and cannot affect routing: the wire request is built
* from `model.id` (pi-ai's completions API sets `model: model.id`), the
* selection a picker submits is `{provider, model: id, reasoningEffort}`, and
* `dsh-llm` validates `name` as a non-empty string without comparing its
* contents. Nothing in the host resolves a model *by* name. The badge labels
* are the upstream's own spellings and the host seam has no locale service,
* so non-Chinese UIs see them verbatim — accepted until the picker grows a
* localized badge slot.
*/
function displaySuffix(info) {
	const parts = [normalizeCredits(info.billing?.credits), ...info.billing?.badges ?? []].filter((part) => part !== void 0 && part !== "");
	return parts.length === 0 ? void 0 : parts.join(" · ");
}
/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
	const suffix = displaySuffix(info);
	return suffix === void 0 ? name : `${name}${RATE_SEPARATOR}${suffix}`;
}
/**
* Resolve a WorkBuddy model's reasoning capability into pi-ai's
* `thinkingLevelMap` (every level pinned to its wire spelling or `null` for
* unsupported), mirroring `dsh-llm-pi-ai`'s own `resolveModelReasoning`.
*
* Declared sets only: a thinking control is offered exactly when the upstream
* catalog declares a `supportedEfforts` list, and it offers exactly the
* declared values. Rows without a list (the older `{effort, summary}` shape)
* get no control at all — their selectable set is client-side knowledge the
* catalog does not carry (the desktop app differs per model there: GLM-5.2
* gets a thinking control while MiniMax-M3 and Kimi-K2.6 do not, though their
* catalog rows are identical), and another implementation against the same
* upstream (workbuddy2api) gates on the declared set and downgrades
* out-of-set values rather than passing them through, so sending an
* undeclared value risks a 400. Such models never carry `reasoning_effort`
* on the wire; the upstream applies its own default.
* `off` is offered only when the model explicitly reports thinking can be
* disabled (`canDisableThinking === true`).
*/
function reasoningFields(info) {
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: reasoning.canDisableThinking === true ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
		...reasoningFields(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*/
function createWorkBuddyAdapter(options) {
	const { shim, store, catalog, resolveAttachments } = options;
	const providerId = options.providerId ?? "workbuddy";
	const displayName = options.displayName ?? "WorkBuddy";
	const accountKey = options.accountKey;
	const buildModels = () => {
		const baseUrl = accountKey === void 0 ? `${shim.baseUrl()}/v1` : `${shim.baseUrl()}/v1/${encodeURIComponent(accountKey)}`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "WorkBuddy OAuth bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "WorkBuddy"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: WORKBUDDY_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-workbuddy-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new WorkBuddyPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token(),
			...resolveAttachments === void 0 ? {} : { resolveAttachments }
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/**
* The WorkBuddy route's adapter: `PiAiAdapter` with the billing rate folded
* into the catalog answers it returns to the DSH model pickers.
*
* `PiAiAdapter.listModels()` and `.resolveModel()` build their answers straight
* from the pi-ai descriptors, which carry no billing fact, so the rate is
* layered on here by looking the model up in the live catalog. Both overrides
* delegate to `super` and then rewrite only the display fields, so streaming,
* capability resolution, and effort mapping stay exactly as `dsh-llm-pi-ai`
* implements them.
*
* A model missing from the catalog (an id the shim would serve but the last
* upstream refresh did not list) falls through with its name untouched rather
* than being dropped: catalog membership is advisory, and the seam tolerates
* serving an unlisted id.
*/
var WorkBuddyPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	/** Catalog entry for one model id, or undefined when the catalog omits it. */
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			if (info === void 0) return model;
			return {
				...model,
				name: withCatalogDisplay(model.name, info)
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		if (info === void 0) return resolved;
		return {
			...resolved,
			name: withCatalogDisplay(resolved.name, info)
		};
	}
};
//#endregion
//#region src/shim.ts
/**
* Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
* shim applies the WorkBuddy wire quirks (forced streaming, string
* `tool_choice`, CLI-shaped headers) and forwards to the real upstream.
* It binds 127.0.0.1 only and never serves another interface.
*
* Inbound hardening: the loopback bind alone is not a trust boundary (any
* local process or a DNS-rebinding page can reach 127.0.0.1), so every
* request must carry a loopback Host header, browser-sent Origins must be
* loopback, chat POSTs must be application/json, and the Authorization
* header must carry the shim's per-process shared secret. The plugin's
* own client satisfies all four by construction; local attackers cannot
* read the secret out of the plugin process's memory.
*
* @module dsh-workbuddy-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** Loopback hostnames the shim's own in-process client uses. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	hard_credit: 402,
	soft_rate: 429,
	session_dead: 401,
	not_found: 502,
	server: 502,
	client: 400
};
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createWorkBuddyShim(options) {
	const { store, client, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const expected = SHARED_SECRET;
		const a = Buffer.from(presented);
		const b = Buffer.from(expected);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("workbuddy shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((model) => ({
						id: model.id,
						object: "model",
						created: 0,
						owned_by: "workbuddy"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res, void 0);
				return;
			}
			if (req.method === "POST") {
				const accountMatch = /^\/v1\/([^/]+)\/chat\/completions\/?$/u.exec(url);
				if (accountMatch !== null) {
					await chatCompletions(req, res, decodeURIComponent(accountMatch[1]));
					return;
				}
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res, accountKey) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			if (accountKey === void 0) {
				if (!(store instanceof WorkBuddyCredentialStore)) throw new Error("workbuddy: this endpoint serves one account only; use the account-scoped route");
				credential = await store.resolve();
			} else {
				if (!(store instanceof WorkBuddyAccountManager)) throw new Error("workbuddy: multi-account is not enabled on this build");
				credential = await store.resolve(accountKey);
			}
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const prepared = prepareChatBody(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await client.chatStream(credential, prepared, controller.signal);
		if (!result.ok) {
			writeOpenAIError(res, KIND_STATUS[result.kind], result.kind, `workbuddy upstream ${result.kind} (http ${result.status}): ${result.message.slice(0, 400)}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const body = Readable.fromWeb(result.response.body);
		body.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		body.on("error", (error) => {
			logger?.warn("dsh-workbuddy-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		body.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/status-paths.ts
/** Node-free constants and types shared by the Host and browser halves. */
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/status";
/** Plugin-owned removal endpoint: body `{ key }`, removes one imported account. */
const WORKBUDDY_REMOVE_PATH = "/plugins/dsh-workbuddy-connect/remove";
//#endregion
//#region src/web-status.ts
/** Redact token-like content before it crosses to the browser. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]").slice(0, 500);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Loopback browser origins only; other devices are refused until trusted origins exist. */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0) return true;
	try {
		const { hostname } = new URL(origin);
		return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	} catch {
		return false;
	}
}
/**
* Assemble the card's status document. Sign-in state is read-only; credit is
* a live billing answer whose failure degrades to `creditsError` rather than
* failing the whole document. In multi-account mode the document lists every
* managed account with its own sign-in and credit summary.
*/
async function workBuddyWebStatus(deps) {
	if (deps.store instanceof WorkBuddyAccountManager) {
		const statuses = await deps.store.statuses();
		if (statuses.length === 0) return { status: "signed-out" };
		const accounts = [];
		for (const entry of statuses) {
			const account = {
				key: entry.key,
				state: entry.state,
				...entry.nickname === void 0 ? {} : { nickname: entry.nickname },
				...entry.domain === void 0 || entry.domain === "" ? {} : { domain: entry.domain },
				...entry.expiresAtMs === void 0 ? {} : { expiresAt: entry.expiresAtMs }
			};
			if (entry.state === "signed-in") try {
				const credential = await deps.store.resolve(entry.key);
				account.credits = await deps.client.fetchCredits(credential);
			} catch (error) {
				account.creditsError = safeMessage(error);
			}
			accounts.push(account);
		}
		return {
			status: "signed-in",
			accounts
		};
	}
	const authStatus = await deps.store.status();
	if (authStatus.state !== "signed-in") return { status: "signed-out" };
	const status = {
		status: "signed-in",
		...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
		...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
		...authStatus.source === void 0 ? {} : { source: authStatus.source },
		...authStatus.expiresAtMs === void 0 ? {} : { expiresAt: authStatus.expiresAtMs }
	};
	const modelsField = deps.models().filter((model) => model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0).map((model) => {
		const rate = normalizeCredits(model.billing?.credits);
		return {
			id: model.id,
			name: model.name,
			...model.billing?.free === true ? { free: true } : {},
			...model.billing?.badges !== void 0 && model.billing.badges.length > 0 ? { badges: model.billing.badges } : {},
			...rate === void 0 ? {} : { credits: rate }
		};
	});
	const statusWithModels = modelsField.length > 0 ? {
		...status,
		models: modelsField
	} : status;
	try {
		const credential = await deps.store.current();
		if (credential !== void 0) {
			const credits = await deps.client.fetchCredits(credential);
			return {
				...statusWithModels,
				credits
			};
		}
	} catch (error) {
		return {
			...statusWithModels,
			creditsError: safeMessage(error)
		};
	}
	return statusWithModels;
}
/** Mount the GET status route and the POST removal route on an optional webServer context. */
function registerWorkBuddyStatusRoute(ctx, deps) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_STATUS_PATH,
			handler: async (req, res) => {
				if (req.method !== "GET") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				if (!loopbackOrigin(req)) {
					json(res, 403, { error: "origin-not-trusted" });
					return;
				}
				try {
					json(res, 200, await workBuddyWebStatus(deps));
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		const disposeRemove = ctx.webServer.register({
			kind: "exact",
			path: WORKBUDDY_REMOVE_PATH,
			handler: async (req, res) => {
				if (req.method !== "POST") {
					json(res, 405, { error: "method not allowed" });
					return;
				}
				if (!loopbackOrigin(req)) {
					json(res, 403, { error: "origin-not-trusted" });
					return;
				}
				if (deps.remove === void 0) {
					json(res, 404, { error: "removal requires multi-account mode" });
					return;
				}
				let key;
				try {
					const raw = await new Promise((resolve, reject) => {
						const chunks = [];
						req.on("data", (chunk) => chunks.push(chunk));
						req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
						req.on("error", reject);
					});
					key = JSON.parse(raw).key;
				} catch {
					json(res, 400, { error: "invalid JSON body" });
					return;
				}
				if (typeof key !== "string" || key.trim() === "") {
					json(res, 400, { error: "body must be {\"key\": string}" });
					return;
				}
				try {
					await deps.remove(key.trim());
					json(res, 200, { removed: key.trim() });
				} catch (error) {
					json(res, 500, { error: safeMessage(error) });
				}
			}
		});
		return () => {
			dispose();
			disposeRemove();
		};
	}, "dsh-workbuddy-connect: Web status route");
}
//#endregion
//#region src/index.ts
/** Stable Cordis plugin name. */
const name = "llm-workbuddy";
/** The model registry required before the provider can register. */
const inject = ["llm"];
/** Settings namespace reserved for the future configuration card. */
const WORKBUDDY_SETTINGS_NS = "workbuddy";
const Config = z.object({
	authFile: z.string().description("WorkBuddy desktop auth file (defaults to the app's own location)"),
	accounts: z.array(z.string()).description("Account keys to expose as separate providers (import each via the CLI first)"),
	defaultAccount: z.string().description("Account key used to refresh the shared model catalog")
});
/**
* Start the loopback endpoint, register the `workbuddy` provider, and
* refresh the model catalog from the upstream once credentials allow it.
* The static fallback catalog serves from the first moment, so an offline
* upstream never leaves the provider empty.
*/
function apply(ctx, config) {
	const client = new WorkBuddyUpstreamClient();
	const catalog = new WorkBuddyCatalog();
	let stopped = false;
	/** Effective config: the settings scope value once the section joins, else the plugin config. */
	let current = () => config;
	let store;
	let shim;
	let invalidate;
	ctx.effect(() => () => {
		stopped = true;
		shim?.close();
		clearHostHeartbeat();
	});
	const sectionHooks = {
		setSource(source) {
			current = source;
		},
		onChange() {
			const next = current().authFile;
			if (store instanceof WorkBuddyCredentialStore) store.setDesktopPath(next);
			settingsReadyResolve();
		}
	};
	let settingsReadyResolve;
	const settingsReady = new Promise((resolve) => {
		settingsReadyResolve = resolve;
	});
	ctx.inject(["settings"], (settingsCtx) => {
		const service = settingsCtx.settings;
		if (typeof service.installSection === "function") service.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, sectionHooks);
		else installSettingsSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, sectionHooks);
	});
	const start = (active) => {
		const accountEntries = (active.accounts ?? []).filter((key) => key.trim() !== "").map((key) => ({ key: key.trim() }));
		const multiAccount = accountEntries.length > 0;
		const activeStore = multiAccount ? new WorkBuddyAccountManager({
			...active.authFile === void 0 ? {} : { desktopPath: active.authFile },
			refresh: (credential) => client.refreshToken(credential)
		}) : new WorkBuddyCredentialStore({
			...active.authFile === void 0 ? {} : { desktopPath: active.authFile },
			refresh: (credential) => client.refreshToken(credential)
		});
		store = activeStore;
		shim = createWorkBuddyShim({
			store: activeStore,
			client,
			catalog,
			logger: ctx.logger
		});
		let settingsApi;
		ctx.inject(["settings"], (settingsCtx) => {
			settingsApi = settingsCtx.settings;
		});
		const routeOptions = {
			store: activeStore,
			client,
			models: () => catalog.current()
		};
		if (multiAccount) routeOptions.remove = async (key) => {
			if (!(activeStore instanceof WorkBuddyAccountManager)) return;
			await activeStore.remove(key);
			const remaining = (current().accounts ?? []).filter((entry) => entry !== key);
			try {
				await settingsApi?.update(WORKBUDDY_SETTINGS_NS, { accounts: remaining });
			} catch (error) {
				ctx.logger.warn("dsh-workbuddy-connect: could not sync the accounts list after removal", error);
			}
		};
		ctx.inject(["webServer"], (webCtx) => registerWorkBuddyStatusRoute(webCtx, routeOptions));
		shim.ready.then(async () => {
			if (stopped) return;
			const nicknameByKey = /* @__PURE__ */ new Map();
			if (activeStore instanceof WorkBuddyAccountManager) try {
				for (const status of await activeStore.statuses()) if (status.nickname !== void 0) nicknameByKey.set(status.key, status.nickname);
			} catch {}
			let registrations = [];
			const registerOne = (providerId, displayName, accountKey) => {
				const workbuddy = createWorkBuddyAdapter({
					shim,
					store: activeStore,
					catalog,
					providerId,
					displayName,
					...accountKey === void 0 ? {} : { accountKey },
					resolveAttachments: () => ctx.get("attachments")
				});
				invalidate = workbuddy.invalidate;
				const releaseAdapter = ctx.llm.registerAdapter([providerId], workbuddy.adapter);
				const releaseDirectory = ctx.llm.registerConfigurableProviders([{
					provider: providerId,
					displayName,
					settingsNs: WORKBUDDY_SETTINGS_NS,
					settingsPath: [],
					declared: false
				}]);
				registrations.push(releaseAdapter, releaseDirectory);
			};
			if (!multiAccount) registerOne(WORKBUDDY_PROVIDER, "WorkBuddy", void 0);
			else for (const entry of accountEntries) registerOne(`${WORKBUDDY_PROVIDER}:${entry.key}`, `WorkBuddy · ${nicknameByKey.get(entry.key) ?? entry.key}`, entry.key);
			try {
				ctx.effect(() => () => {
					for (const release of registrations) release();
				});
			} catch {
				for (const release of registrations) release();
			}
			writeHostHeartbeat();
			(async () => {
				try {
					let credential;
					if (activeStore instanceof WorkBuddyAccountManager) {
						const key = active.defaultAccount ?? accountEntries[0]?.key;
						if (key !== void 0) credential = await activeStore.resolve(key);
					} else credential = await activeStore.current();
					if (credential === void 0 || stopped) return;
					const models = await client.fetchModels(credential);
					if (stopped) return;
					catalog.set([...models]);
					invalidate?.();
				} catch (error) {
					ctx.logger.warn("dsh-workbuddy-connect: dynamic model catalog unavailable; serving the static fallback list", error);
				}
			})();
		}).catch((error) => {
			ctx.logger.error("dsh-workbuddy-connect: loopback endpoint failed to start; provider not registered", error);
		});
	};
	settingsReady.then(() => {
		if (!stopped) start(current());
	});
}
//#endregion
export { Config, FALLBACK_WORKBUDDY_MODELS, WORKBUDDY_AUTH_FILENAME, WORKBUDDY_AUTH_FILE_ENV, WORKBUDDY_HOST_HEARTBEAT_FILENAME, WORKBUDDY_PROVIDER, WORKBUDDY_SETTINGS_NS, WORKBUDDY_STREAM_IDLE_TIMEOUT_MS, WorkBuddyAccountManager, WorkBuddyCatalog, WorkBuddyCredentialStore, WorkBuddyUpstreamClient, apply, classifyUpstreamError, clearHostHeartbeat, createWorkBuddyAdapter, createWorkBuddyShim, defaultDesktopAuthCandidates, defaultDesktopAuthPath, inject, isHeartbeatProcessAlive, name, normalizeCredits, parseWorkBuddyAuth, prepareChatBody, processStartTimeMs, readHostHeartbeat, regionOf, workbuddyAccountDir, workbuddyHostHeartbeatPath, workbuddyOwnAuthPath };
