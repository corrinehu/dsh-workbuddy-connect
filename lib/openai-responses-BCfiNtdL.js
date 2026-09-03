import { _ as parseStreamingJson, a as buildCopilotDynamicHeaders, c as createGrammarToolInputProperties, d as resolveJsonSchemaStrictSampling, f as sanitizeSurrogates, h as getProviderEnvValue, l as getGrammarToolInput, m as headersToRecord, o as hasCopilotVisionInput, p as retryProviderRequest, r as buildBaseOptions, s as appendGrammarToolInputJsonDelta, t as transformMessages, u as resolveGrammarConstrainedSampling } from "./transform-messages-CRDJB818.js";
import { n as clampThinkingLevel, s as AssistantMessageEventStream, t as calculateCost } from "./models-uQEzsUBb.js";
import { t as splitDeferredTools } from "./deferred-tools-lXkm2FYi.js";
import { a as OpenAI, i as normalizeProviderError, n as clampOpenAIPromptCacheKey, r as formatProviderError, t as shortHash } from "./hash-CxnGh7Jo.js";
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js
function encodeTextSignatureV1(id, phase) {
	const payload = {
		v: 1,
		id
	};
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}
function parseTextSignature(signature) {
	if (!signature) return void 0;
	if (signature.startsWith("{")) try {
		const parsed = JSON.parse(signature);
		if (parsed.v === 1 && typeof parsed.id === "string") {
			if (parsed.phase === "commentary" || parsed.phase === "final_answer") return {
				id: parsed.id,
				phase: parsed.phase
			};
			return { id: parsed.id };
		}
	} catch {}
	return { id: signature };
}
function convertToolResultOutput(model, content) {
	const textResult = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
	const images = content.filter((c) => c.type === "image");
	const hasText = textResult.length > 0;
	if (images.length === 0 || !model.input.includes("image")) return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	const output = [];
	if (hasText) output.push({
		type: "input_text",
		text: sanitizeSurrogates(textResult)
	});
	for (const image of images) output.push({
		type: "input_image",
		detail: "auto",
		image_url: `data:${image.mimeType};base64,${image.data}`
	});
	return output;
}
function convertResponsesMessages(model, context, allowedToolCallProviders, options) {
	const messages = [];
	const loadedToolNames = /* @__PURE__ */ new Set();
	const normalizeIdPart = (part) => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		return (sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized).replace(/_+$/, "");
	};
	const buildForeignResponsesItemId = (itemId) => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};
	const normalizeToolCallId = (id, _targetModel, source) => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = source.provider !== model.provider || source.api !== model.api ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		if (!normalizedItemId.startsWith("fc_")) normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		return `${normalizedCallId}|${normalizedItemId}`;
	};
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	if ((options?.includeSystemPrompt ?? true) && context.systemPrompt) {
		const compat = model.compat;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt)
		});
	}
	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") messages.push({
				role: "user",
				content: [{
					type: "input_text",
					text: sanitizeSurrogates(msg.content)
				}]
			});
			else {
				const content = msg.content.map((item) => {
					if (item.type === "text") return {
						type: "input_text",
						text: sanitizeSurrogates(item.text)
					};
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`
					};
				});
				if (content.length === 0) continue;
				messages.push({
					role: "user",
					content
				});
			}
		} else if (msg.role === "assistant") {
			const output = [];
			const assistantMsg = msg;
			const isDifferentModel = assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			let textBlockIndex = 0;
			for (const block of msg.content) if (block.type === "thinking") {
				if (block.thinkingSignature) {
					const reasoningItem = JSON.parse(block.thinkingSignature);
					output.push(reasoningItem);
				}
			} else if (block.type === "text") {
				const textBlock = block;
				const parsedSignature = parseTextSignature(textBlock.textSignature);
				const fallbackMessageId = textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
				textBlockIndex++;
				let msgId = parsedSignature?.id;
				if (!msgId) msgId = fallbackMessageId;
				else if (msgId.length > 64) msgId = `msg_${shortHash(msgId)}`;
				output.push({
					type: "message",
					role: "assistant",
					content: [{
						type: "output_text",
						text: sanitizeSurrogates(textBlock.text),
						annotations: []
					}],
					status: "completed",
					id: msgId,
					phase: parsedSignature?.phase
				});
			} else if (block.type === "toolCall") {
				const toolCall = block;
				const [callId, itemIdRaw] = toolCall.id.split("|");
				const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
				let itemId = itemIdRaw;
				if (isDifferentModel && itemId?.startsWith("fc_") || customInputProperty === void 0 && !itemId?.startsWith("fc_")) itemId = void 0;
				if (customInputProperty !== void 0) output.push({
					type: "custom_tool_call",
					id: itemId,
					call_id: callId,
					name: toolCall.name,
					input: sanitizeSurrogates(getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty))
				});
				else output.push({
					type: "function_call",
					id: itemId,
					call_id: callId,
					name: toolCall.name,
					arguments: JSON.stringify(toolCall.arguments)
				});
			}
			if (output.length === 0) continue;
			messages.push(...output);
		} else if (msg.role === "toolResult") {
			const [callId] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);
			if (options?.grammarToolInputProperties?.has(msg.toolName)) messages.push({
				type: "custom_tool_call_output",
				call_id: callId,
				output
			});
			else messages.push({
				type: "function_call_output",
				call_id: callId,
				output
			});
			const deferredTools = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0) {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push({
					type: "tool_search_call",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					arguments: {
						query: names.join(" "),
						limit: names.length
					}
				});
				messages.push({
					type: "tool_search_output",
					call_id: searchCallId,
					execution: "client",
					status: "completed",
					tools: convertResponsesTools(deferredTools, {
						...options?.toolOptions,
						deferLoading: true
					})
				});
			}
		}
		msgIndex++;
	}
	return messages;
}
function convertResponsesTools(tools, options) {
	const defaultStrict = options?.strict === void 0 ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) return {
			type: "custom",
			name: tool.name,
			description: tool.description,
			format: {
				type: "grammar",
				syntax: grammar.format,
				definition: grammar.definition
			},
			...options?.deferLoading ? { defer_loading: true } : {}
		};
		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const functionTool = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			...options?.deferLoading ? { defer_loading: true } : {}
		};
		if (supportsStrictMode) functionTool.strict = constrainedStrict ?? defaultStrict;
		return functionTool;
	});
}
function getCustomToolCallInput(block) {
	const property = block.customInput?.property;
	if (property === void 0) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}
function appendCustomToolCallInput(block, nextInput, close) {
	const customInput = block.customInput;
	if (!customInput) return void 0;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}
async function processResponsesStream(openaiStream, output, stream, model, options) {
	let sawTerminalResponseEvent = false;
	const outputSlots = /* @__PURE__ */ new Map();
	const reasoningBlocksById = /* @__PURE__ */ new Map();
	const getSlot = (outputIndex, type) => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? slot : void 0;
	};
	const pushToolCallDelta = (slot, delta) => {
		if (delta === void 0) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output
		});
	};
	const createSlot = (outputIndex, item) => {
		if (item.type === "reasoning") {
			const block = {
				type: "thinking",
				thinking: ""
			};
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1
			};
			outputSlots.set(outputIndex, slot);
			stream.push({
				type: "thinking_start",
				contentIndex: slot.contentIndex,
				partial: output
			});
			return slot;
		}
		if (item.type === "message") {
			const block = {
				type: "text",
				text: ""
			};
			output.content.push(block);
			const slot = {
				type: "text",
				block,
				contentIndex: output.content.length - 1
			};
			outputSlots.set(outputIndex, slot);
			stream.push({
				type: "text_start",
				contentIndex: slot.contentIndex,
				partial: output
			});
			return slot;
		}
		if (item.type === "function_call") {
			const block = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || ""
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1
			};
			outputSlots.set(outputIndex, slot);
			stream.push({
				type: "toolcall_start",
				contentIndex: slot.contentIndex,
				partial: output
			});
			return slot;
		}
		if (item.type === "custom_tool_call") {
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const input = item.input || "";
			const block = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				customInput: {
					property: inputProperty,
					jsonBuffer: {
						input: "",
						started: false,
						closed: false
					}
				}
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1
			};
			outputSlots.set(outputIndex, slot);
			stream.push({
				type: "toolcall_start",
				contentIndex: slot.contentIndex,
				partial: output
			});
			return slot;
		}
	};
	const getOrCreateSlot = (outputIndex, item) => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	const backfillReasoningSignatures = (responseOutput) => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;
			const storedItem = JSON.parse(block.thinkingSignature);
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content
			});
		}
	};
	const finalizeResponse = (response) => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) output.responseId = response.id;
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0
				}
			};
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier ? options.resolveServiceTier(response?.service_tier, options.serviceTier) : response?.service_tier ?? options.serviceTier;
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		output.stopReason = mapStopReason(response?.status);
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") output.stopReason = "toolUse";
	};
	for await (const event of openaiStream) if (event.type === "response.created") output.responseId = event.response.id;
	else if (event.type === "response.output_item.added") createSlot(event.output_index, event.item);
	else if (event.type === "response.reasoning_summary_text.delta") {
		const slot = getSlot(event.output_index, "thinking");
		if (!slot) continue;
		slot.block.thinking += event.delta;
		stream.push({
			type: "thinking_delta",
			contentIndex: slot.contentIndex,
			delta: event.delta,
			partial: output
		});
	} else if (event.type === "response.reasoning_summary_part.done") {
		const slot = getSlot(event.output_index, "thinking");
		if (!slot) continue;
		slot.block.thinking += "\n\n";
		stream.push({
			type: "thinking_delta",
			contentIndex: slot.contentIndex,
			delta: "\n\n",
			partial: output
		});
	} else if (event.type === "response.reasoning_text.delta") {
		const slot = getSlot(event.output_index, "thinking");
		if (!slot) continue;
		slot.block.thinking += event.delta;
		stream.push({
			type: "thinking_delta",
			contentIndex: slot.contentIndex,
			delta: event.delta,
			partial: output
		});
	} else if (event.type === "response.output_text.delta") {
		const slot = getSlot(event.output_index, "text");
		if (!slot) continue;
		slot.block.text += event.delta;
		stream.push({
			type: "text_delta",
			contentIndex: slot.contentIndex,
			delta: event.delta,
			partial: output
		});
	} else if (event.type === "response.refusal.delta") {
		const slot = getSlot(event.output_index, "text");
		if (!slot) continue;
		slot.block.text += event.delta;
		stream.push({
			type: "text_delta",
			contentIndex: slot.contentIndex,
			delta: event.delta,
			partial: output
		});
	} else if (event.type === "response.function_call_arguments.delta") {
		const slot = getSlot(event.output_index, "toolCall");
		if (!slot || slot.block.partialJson === void 0) continue;
		slot.block.partialJson += event.delta;
		slot.block.arguments = parseStreamingJson(slot.block.partialJson);
		pushToolCallDelta(slot, event.delta);
	} else if (event.type === "response.function_call_arguments.done") {
		const slot = getSlot(event.output_index, "toolCall");
		if (!slot || slot.block.partialJson === void 0) continue;
		const previousPartialJson = slot.block.partialJson;
		slot.block.partialJson = event.arguments;
		slot.block.arguments = parseStreamingJson(slot.block.partialJson);
		if (event.arguments.startsWith(previousPartialJson)) {
			const delta = event.arguments.slice(previousPartialJson.length);
			if (delta.length > 0) pushToolCallDelta(slot, delta);
		}
	} else if (event.type === "response.custom_tool_call_input.delta") {
		const slot = getSlot(event.output_index, "toolCall");
		if (!slot || !slot.block.customInput) continue;
		pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false));
	} else if (event.type === "response.custom_tool_call_input.done") {
		const slot = getSlot(event.output_index, "toolCall");
		if (!slot || !slot.block.customInput) continue;
		pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
	} else if (event.type === "response.output_item.done") {
		const item = event.item;
		const slot = getOrCreateSlot(event.output_index, item);
		if (item.type === "reasoning" && slot?.type === "thinking") {
			const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
			const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
			slot.block.thinking = summaryText || contentText || slot.block.thinking;
			slot.block.thinkingSignature = JSON.stringify(item);
			reasoningBlocksById.set(item.id, slot.block);
			stream.push({
				type: "thinking_end",
				contentIndex: slot.contentIndex,
				content: slot.block.thinking,
				partial: output
			});
			outputSlots.delete(event.output_index);
		} else if (item.type === "message" && slot?.type === "text") {
			slot.block.text = item.content?.map((c) => c.type === "output_text" ? c.text : c.refusal).join("") || "";
			slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? void 0);
			stream.push({
				type: "text_end",
				contentIndex: slot.contentIndex,
				content: slot.block.text,
				partial: output
			});
			outputSlots.delete(event.output_index);
		} else if (item.type === "function_call" && slot?.type === "toolCall" && slot.block.partialJson !== void 0) {
			slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
			delete slot.block.partialJson;
			stream.push({
				type: "toolcall_end",
				contentIndex: slot.contentIndex,
				toolCall: slot.block,
				partial: output
			});
			outputSlots.delete(event.output_index);
		} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true));
			delete slot.block.customInput;
			stream.push({
				type: "toolcall_end",
				contentIndex: slot.contentIndex,
				toolCall: slot.block,
				partial: output
			});
			outputSlots.delete(event.output_index);
		}
	} else if (event.type === "response.completed" || event.type === "response.incomplete") finalizeResponse(event.response);
	else if (event.type === "error") throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
	else if (event.type === "response.failed") {
		sawTerminalResponseEvent = true;
		const error = event.response?.error;
		const details = event.response?.incomplete_details;
		const msg = error ? `${error.code || "unknown"}: ${error.message || "no message"}` : details?.reason ? `incomplete: ${details.reason}` : "Unknown error (no error details in response)";
		throw new Error(msg);
	}
	if (!sawTerminalResponseEvent) throw new Error("OpenAI Responses stream ended before a terminal response event");
}
function mapStopReason(status) {
	if (!status) return "stop";
	switch (status) {
		case "completed": return "stop";
		case "incomplete": return "length";
		case "failed":
		case "cancelled": return "error";
		case "in_progress":
		case "queued": return "stop";
		default: throw new Error(`Unhandled stop reason: ${status}`);
	}
}
//#endregion
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js
const OPENAI_TOOL_CALL_PROVIDERS = /* @__PURE__ */ new Set([
	"openai",
	"openai-codex",
	"opencode"
]);
const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;
function hasHeader(headers, name) {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	return false;
}
function getClientApiKey(provider, apiKey, headers) {
	if (apiKey) return apiKey;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "cf-aig-authorization")) return "unused";
	throw new Error(`No API key for provider: ${provider}`);
}
function detectSessionAffinityFormat(model) {
	return model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai") ? "openrouter" : "openai";
}
/**
* Resolve cache retention preference.
* Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
*/
function resolveCacheRetention(cacheRetention, env) {
	if (cacheRetention) return cacheRetention;
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
	return "short";
}
function getCompat(model) {
	return {
		supportsDeveloperRole: model.compat?.supportsDeveloperRole ?? true,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? detectSessionAffinityFormat(model),
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		supportsStrictMode: model.compat?.supportsStrictMode ?? false,
		supportsOpenAIGrammarTools: model.compat?.supportsOpenAIGrammarTools ?? false,
		supportsToolSearch: model.compat?.supportsToolSearch ?? false,
		supportsExplicitPromptCacheMode: model.compat?.supportsExplicitPromptCacheMode ?? false
	};
}
function getPromptCacheRetention(compat, cacheRetention) {
	return cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : void 0;
}
function formatOpenAIResponsesError(error) {
	return formatProviderError(normalizeProviderError(error), "OpenAI API error");
}
/**
* Generate function for OpenAI Responses API
*/
const stream = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
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
			},
			stopReason: "stop",
			timestamp: Date.now()
		};
		try {
			const apiKey = getClientApiKey(model.provider, options?.apiKey, options?.headers);
			const cacheSessionId = resolveCacheRetention(options?.cacheRetention, options?.env) === "none" ? void 0 : options?.sessionId;
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId);
			let params = buildParams(model, context, options, compat, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== void 0) params = nextParams;
			const requestOptions = {
				...options?.signal ? { signal: options.signal } : {},
				...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
				maxRetries: 0
			};
			const { data: openaiStream, response } = await retryProviderRequest(() => client.responses.create(params, requestOptions).withResponse(), {
				maxRetries: options?.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs,
				signal: options?.signal
			});
			await options?.onResponse?.({
				status: response.status,
				headers: headersToRecord(response.headers)
			}, model);
			stream.push({
				type: "start",
				partial: output
			});
			await processResponsesStream(openaiStream, output, stream, model, {
				serviceTier: options?.serviceTier,
				grammarToolInputProperties,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model)
			});
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error("An unknown error occurred");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete block.index;
				delete block.partialJson;
				delete block.customInput;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatOpenAIResponsesError(error);
			stream.push({
				type: "error",
				reason: output.stopReason,
				error: output
			});
			stream.end();
		}
	})();
	return stream;
};
const streamSimple = (model, context, options) => {
	getClientApiKey(model.provider, options?.apiKey, options?.headers);
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : void 0;
	const reasoningEffort = clampedReasoning === "off" ? void 0 : clampedReasoning;
	return stream(model, context, {
		...base,
		reasoningEffort
	});
};
function createClient(model, context, apiKey, optionsHeaders, sessionId) {
	const compat = getCompat(model);
	const headers = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages
		});
		Object.assign(headers, copilotHeaders);
	}
	if (sessionId) {
		if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = sessionId;
		else {
			if (compat.sessionAffinityFormat === "openai") headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
		}
	}
	if (optionsHeaders) Object.assign(headers, optionsHeaders);
	return new OpenAI({
		apiKey,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders: headers
	});
}
function buildParams(model, context, options, compat = getCompat(model), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
	const toolPlacement = splitDeferredTools(context, compat.supportsToolSearch);
	const messages = convertResponsesMessages(model, context, OPENAI_TOOL_CALL_PROVIDERS, {
		grammarToolInputProperties,
		deferredTools: toolPlacement.deferred,
		toolOptions: {
			supportsStrictMode: compat.supportsStrictMode,
			supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
		}
	});
	const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
	const disableImplicitPromptCache = cacheRetention === "none" && compat.supportsExplicitPromptCacheMode;
	const params = {
		model: model.id,
		input: messages,
		stream: true,
		prompt_cache_key: cacheRetention === "none" ? void 0 : clampOpenAIPromptCacheKey(options?.sessionId),
		prompt_cache_retention: getPromptCacheRetention(compat, cacheRetention),
		prompt_cache_options: disableImplicitPromptCache ? { mode: "explicit" } : void 0,
		store: false
	};
	if (options?.maxTokens) params.max_output_tokens = Math.max(options.maxTokens, OPENAI_RESPONSES_MIN_OUTPUT_TOKENS);
	if (options?.temperature !== void 0) params.temperature = options?.temperature;
	if (options?.serviceTier !== void 0) params.service_tier = options.serviceTier;
	if (toolPlacement.immediate.length > 0) params.tools = convertResponsesTools(toolPlacement.immediate, {
		supportsStrictMode: compat.supportsStrictMode,
		supportsOpenAIGrammarTools: compat.supportsOpenAIGrammarTools
	});
	if (options?.toolChoice !== void 0) params.tool_choice = options.toolChoice;
	if (model.reasoning) {
		if (options?.reasoningEffort || options?.reasoningSummary) {
			params.reasoning = {
				effort: options?.reasoningEffort ? model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort : "medium",
				summary: options?.reasoningSummary || "auto"
			};
			params.include = ["reasoning.encrypted_content"];
		} else if (model.provider !== "github-copilot" && model.thinkingLevelMap?.off !== null) params.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
		if (model.provider === "xai") params.include = ["reasoning.encrypted_content"];
	}
	return params;
}
function getServiceTierCostMultiplier(model, serviceTier) {
	switch (serviceTier) {
		case "flex": return .5;
		case "priority": return model.id === "gpt-5.5" ? 2.5 : 2;
		default: return 1;
	}
}
function applyServiceTierPricing(usage, serviceTier, model) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}
//#endregion
export { stream, streamSimple };
