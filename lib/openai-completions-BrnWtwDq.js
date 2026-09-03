import { _ as parseStreamingJson, a as buildCopilotDynamicHeaders, c as createGrammarToolInputProperties, d as resolveJsonSchemaStrictSampling, f as sanitizeSurrogates, h as getProviderEnvValue, l as getGrammarToolInput, m as headersToRecord, o as hasCopilotVisionInput, p as retryProviderRequest, r as buildBaseOptions, s as appendGrammarToolInputJsonDelta, t as transformMessages, u as resolveGrammarConstrainedSampling } from "./transform-messages-CRDJB818.js";
import { n as clampThinkingLevel, s as AssistantMessageEventStream, t as calculateCost } from "./models-uQEzsUBb.js";
import { a as OpenAI, i as normalizeProviderError, n as clampOpenAIPromptCacheKey, r as formatProviderError, t as shortHash } from "./hash-CxnGh7Jo.js";
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js
/**
* Check if conversation messages contain tool calls or tool results.
* This is needed because Anthropic (via proxy) requires the tools param
* to be present when messages include tool_calls or tool role messages.
*/
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
function hasToolHistory(messages) {
	for (const msg of messages) {
		if (msg.role === "toolResult") return true;
		if (msg.role === "assistant") {
			if (msg.content.some((block) => block.type === "toolCall")) return true;
		}
	}
	return false;
}
function getDeferredToolNames(messages) {
	const names = /* @__PURE__ */ new Set();
	for (const message of messages) if (message.role === "toolResult") for (const name of message.addedToolNames ?? []) names.add(name);
	return names;
}
function getToolsByName(tools, names) {
	if (!tools) return [];
	const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
	return Array.from(names).map((name) => toolsByName.get(name)).filter((tool) => tool !== void 0);
}
function isTextContentBlock(block) {
	return block.type === "text";
}
function isThinkingContentBlock(block) {
	return block.type === "thinking";
}
function isToolCallBlock(block) {
	return block.type === "toolCall";
}
function isImageContentBlock(block) {
	return block.type === "image";
}
function isEncryptedReasoningDetail(detail) {
	if (typeof detail !== "object" || detail === null) return false;
	const candidate = detail;
	return candidate.type === "reasoning.encrypted" && typeof candidate.id === "string" && candidate.id.length > 0 && typeof candidate.data === "string" && candidate.data.length > 0;
}
function resolveCacheRetention(cacheRetention, env) {
	if (cacheRetention) return cacheRetention;
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
	return "short";
}
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
			const compat = getCompat(model);
			const grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools);
			const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
			const cacheSessionId = cacheRetention === "none" ? void 0 : options?.sessionId;
			const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
			let params = buildParams(model, context, options, compat, cacheRetention, grammarToolInputProperties);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== void 0) params = nextParams;
			const requestOptions = {
				...options?.signal ? { signal: options.signal } : {},
				...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
				maxRetries: 0
			};
			const { data: openaiStream, response } = await retryProviderRequest(() => client.chat.completions.create(params, requestOptions).withResponse(), {
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
			let textBlock = null;
			let thinkingBlock = null;
			let hasFinishReason = false;
			const toolCallBlocksByIndex = /* @__PURE__ */ new Map();
			const toolCallBlocksById = /* @__PURE__ */ new Map();
			const pendingReasoningDetailsByToolCallId = /* @__PURE__ */ new Map();
			const blocks = output.content;
			const getContentIndex = (block) => blocks.indexOf(block);
			const getCustomToolCallInput = (block) => {
				const property = block.customInput?.property;
				if (property === void 0) return "";
				const value = block.arguments[property];
				return typeof value === "string" ? value : "";
			};
			const appendCustomToolCallInput = (block, nextInput, close) => {
				const customInput = block.customInput;
				if (!customInput) return void 0;
				const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
				block.arguments = { [customInput.property]: nextInput };
				return delta;
			};
			const finishBlock = (block) => {
				const contentIndex = getContentIndex(block);
				if (contentIndex === -1) return;
				if (block.type === "text") stream.push({
					type: "text_end",
					contentIndex,
					content: block.text,
					partial: output
				});
				else if (block.type === "thinking") stream.push({
					type: "thinking_end",
					contentIndex,
					content: block.thinking,
					partial: output
				});
				else if (block.type === "toolCall") {
					if (block.customInput) {
						const delta = appendCustomToolCallInput(block, getCustomToolCallInput(block), true);
						if (delta !== void 0) stream.push({
							type: "toolcall_delta",
							contentIndex,
							delta,
							partial: output
						});
					} else block.arguments = parseStreamingJson(block.partialArgs);
					delete block.partialArgs;
					delete block.customInput;
					delete block.streamIndex;
					stream.push({
						type: "toolcall_end",
						contentIndex,
						toolCall: block,
						partial: output
					});
				}
			};
			const ensureTextBlock = () => {
				if (!textBlock) {
					textBlock = {
						type: "text",
						text: ""
					};
					blocks.push(textBlock);
					stream.push({
						type: "text_start",
						contentIndex: getContentIndex(textBlock),
						partial: output
					});
				}
				return textBlock;
			};
			const ensureThinkingBlock = (thinkingSignature) => {
				if (!thinkingBlock) {
					thinkingBlock = {
						type: "thinking",
						thinking: "",
						thinkingSignature
					};
					blocks.push(thinkingBlock);
					stream.push({
						type: "thinking_start",
						contentIndex: getContentIndex(thinkingBlock),
						partial: output
					});
				}
				return thinkingBlock;
			};
			const applyPendingReasoningDetail = (block) => {
				if (!block.id) return;
				const pendingReasoningDetail = pendingReasoningDetailsByToolCallId.get(block.id);
				if (pendingReasoningDetail) {
					block.thoughtSignature = pendingReasoningDetail;
					pendingReasoningDetailsByToolCallId.delete(block.id);
				}
			};
			const ensureToolCallBlock = (toolCall) => {
				const streamIndex = typeof toolCall.index === "number" ? toolCall.index : void 0;
				const name = toolCall.function?.name ?? toolCall.custom?.name ?? "";
				let block = streamIndex !== void 0 ? toolCallBlocksByIndex.get(streamIndex) : void 0;
				if (!block && toolCall.id) block = toolCallBlocksById.get(toolCall.id);
				if (!block) {
					const customInputProperty = toolCall.custom ? grammarToolInputProperties.get(name) ?? "input" : void 0;
					const hasCustomInput = customInputProperty !== void 0;
					block = {
						type: "toolCall",
						id: toolCall.id || "",
						name,
						arguments: hasCustomInput ? { [customInputProperty]: "" } : {},
						partialArgs: hasCustomInput ? void 0 : "",
						customInput: hasCustomInput ? {
							property: customInputProperty,
							jsonBuffer: {
								input: "",
								started: false,
								closed: false
							}
						} : void 0,
						streamIndex
					};
					if (streamIndex !== void 0) toolCallBlocksByIndex.set(streamIndex, block);
					if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
					blocks.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: getContentIndex(block),
						partial: output
					});
				}
				if (streamIndex !== void 0 && block.streamIndex === void 0) {
					block.streamIndex = streamIndex;
					toolCallBlocksByIndex.set(streamIndex, block);
				}
				if (toolCall.id) toolCallBlocksById.set(toolCall.id, block);
				if (!block.name && name) block.name = name;
				if (toolCall.custom && !block.customInput) {
					const customInputProperty = grammarToolInputProperties.get(block.name) ?? "input";
					block.arguments = { [customInputProperty]: "" };
					block.customInput = {
						property: customInputProperty,
						jsonBuffer: {
							input: "",
							started: false,
							closed: false
						}
					};
					delete block.partialArgs;
				}
				applyPendingReasoningDetail(block);
				return block;
			};
			for await (const chunk of openaiStream) {
				if (!chunk || typeof chunk !== "object") continue;
				output.responseId ||= chunk.id;
				if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) output.responseModel ||= chunk.model;
				if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);
				const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : void 0;
				if (!choice) continue;
				if (!chunk.usage && choice.usage) output.usage = parseChunkUsage(choice.usage, model);
				if (choice.finish_reason) {
					const finishReasonResult = mapStopReason(choice.finish_reason);
					output.stopReason = finishReasonResult.stopReason;
					if (finishReasonResult.errorMessage) output.errorMessage = finishReasonResult.errorMessage;
					hasFinishReason = true;
				}
				if (choice.delta) {
					if (choice.delta.content !== null && choice.delta.content !== void 0 && choice.delta.content.length > 0) {
						const block = ensureTextBlock();
						block.text += choice.delta.content;
						stream.push({
							type: "text_delta",
							contentIndex: getContentIndex(block),
							delta: choice.delta.content,
							partial: output
						});
					}
					const reasoningFields = [
						"reasoning_content",
						"reasoning",
						"reasoning_text"
					];
					const deltaFields = choice.delta;
					let foundReasoningField = null;
					for (const field of reasoningFields) {
						const value = deltaFields[field];
						if (typeof value === "string" && value.length > 0) {
							foundReasoningField = field;
							break;
						}
					}
					if (foundReasoningField) {
						const delta = deltaFields[foundReasoningField];
						if (typeof delta === "string" && delta.length > 0) {
							const block = ensureThinkingBlock(model.provider === "opencode-go" && foundReasoningField === "reasoning" ? "reasoning_content" : foundReasoningField);
							block.thinking += delta;
							stream.push({
								type: "thinking_delta",
								contentIndex: getContentIndex(block),
								delta,
								partial: output
							});
						}
					}
					if (choice?.delta?.tool_calls) for (const toolCall of choice.delta.tool_calls) {
						const block = ensureToolCallBlock(toolCall);
						if (!block.id && toolCall.id) {
							block.id = toolCall.id;
							toolCallBlocksById.set(toolCall.id, block);
						}
						const name = toolCall.function?.name ?? toolCall.custom?.name;
						if (!block.name && name) block.name = name;
						let delta = "";
						if (toolCall.function?.arguments) {
							delta = toolCall.function.arguments;
							block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
							block.arguments = parseStreamingJson(block.partialArgs);
						} else if (toolCall.custom?.input) delta = appendCustomToolCallInput(block, getCustomToolCallInput(block) + toolCall.custom.input, false) ?? "";
						stream.push({
							type: "toolcall_delta",
							contentIndex: getContentIndex(block),
							delta,
							partial: output
						});
					}
					const reasoningDetails = choice.delta.reasoning_details;
					if (Array.isArray(reasoningDetails)) {
						for (const detail of reasoningDetails) if (isEncryptedReasoningDetail(detail)) {
							const serializedDetail = JSON.stringify(detail);
							const matchingToolCall = toolCallBlocksById.get(detail.id);
							if (matchingToolCall) matchingToolCall.thoughtSignature = serializedDetail;
							else pendingReasoningDetailsByToolCallId.set(detail.id, serializedDetail);
						}
					}
				}
			}
			for (const block of blocks) finishBlock(block);
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted") throw new Error("Request was aborted");
			if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");
			if (!hasFinishReason) throw new Error("Stream ended without finish_reason");
			stream.push({
				type: "done",
				reason: output.stopReason,
				message: output
			});
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete block.index;
				delete block.partialArgs;
				delete block.customInput;
				delete block.streamIndex;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			const rawMetadata = error?.error?.metadata?.raw;
			if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) output.errorMessage += `\n${rawMetadata}`;
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
	const toolChoice = options?.toolChoice;
	return stream(model, context, {
		...base,
		reasoningEffort,
		toolChoice
	});
};
function createClient(model, context, apiKey, optionsHeaders, sessionId, compat = getCompat(model)) {
	const headers = { ...model.headers };
	if (model.provider === "github-copilot") {
		const hasImages = hasCopilotVisionInput(context.messages);
		const copilotHeaders = buildCopilotDynamicHeaders({
			messages: context.messages,
			hasImages
		});
		Object.assign(headers, copilotHeaders);
	}
	if (sessionId && compat.sendSessionAffinityHeaders) {
		if (compat.sessionAffinityFormat === "openrouter") headers["x-session-id"] = sessionId;
		else {
			if (compat.sessionAffinityFormat === "openai") headers.session_id = sessionId;
			headers["x-client-request-id"] = sessionId;
			headers["x-session-affinity"] = sessionId;
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
function buildParams(model, context, options, compat = getCompat(model), cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env), grammarToolInputProperties = createGrammarToolInputProperties(context.tools, compat.supportsOpenAIGrammarTools)) {
	const messages = convertMessages(model, context, compat, { grammarToolInputProperties });
	const cacheControl = getCompatCacheControl(compat, cacheRetention);
	const params = {
		model: model.id,
		messages,
		stream: true,
		prompt_cache_key: model.baseUrl.includes("api.openai.com") && cacheRetention !== "none" || cacheRetention === "long" && compat.supportsLongCacheRetention ? clampOpenAIPromptCacheKey(options?.sessionId) : void 0,
		prompt_cache_retention: cacheRetention === "long" && compat.supportsLongCacheRetention ? "24h" : void 0
	};
	if (compat.supportsUsageInStreaming !== false) params.stream_options = { include_usage: true };
	if (compat.supportsStore) params.store = false;
	if (options?.maxTokens) {
		if (compat.maxTokensField === "max_tokens") params.max_tokens = options.maxTokens;
		else params.max_completion_tokens = options.maxTokens;
	}
	if (options?.temperature !== void 0) params.temperature = options.temperature;
	const deferredToolNames = compat.deferredToolsMode === "kimi" ? getDeferredToolNames(context.messages) : /* @__PURE__ */ new Set();
	const activeTools = context.tools?.filter((tool) => !deferredToolNames.has(tool.name));
	if (activeTools && activeTools.length > 0) {
		params.tools = convertTools(activeTools, compat);
		if (compat.zaiToolStream) params.tool_stream = true;
	} else if (hasToolHistory(context.messages)) params.tools = [];
	if (cacheControl) applyAnthropicCacheControl(messages, params.tools, cacheControl);
	if (options?.toolChoice) params.tool_choice = options.toolChoice;
	if (compat.thinkingFormat === "zai" && model.reasoning) {
		const zaiParams = params;
		zaiParams.thinking = options?.reasoningEffort ? {
			type: "enabled",
			clear_thinking: false
		} : { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) {
			const mappedEffort = model.thinkingLevelMap?.[options.reasoningEffort];
			const effort = mappedEffort === void 0 ? options.reasoningEffort : mappedEffort;
			if (typeof effort === "string") zaiParams.reasoning_effort = effort;
		}
	} else if (compat.thinkingFormat === "qwen" && model.reasoning) params.enable_thinking = !!options?.reasoningEffort;
	else if (compat.thinkingFormat === "qwen-chat-template" && model.reasoning) params.chat_template_kwargs = {
		enable_thinking: !!options?.reasoningEffort,
		preserve_thinking: true
	};
	else if (compat.thinkingFormat === "chat-template" && model.reasoning) {
		const chatTemplateKwargs = buildChatTemplateKwargs(model, options, compat);
		if (chatTemplateKwargs) params.chat_template_kwargs = chatTemplateKwargs;
	} else if (compat.thinkingFormat === "deepseek" && model.reasoning) {
		if (options?.reasoningEffort) params.thinking = { type: "enabled" };
		else if (model.thinkingLevelMap?.off !== null) params.thinking = { type: "disabled" };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (compat.thinkingFormat === "openrouter" && model.reasoning) {
		const openRouterParams = params;
		if (options?.reasoningEffort) openRouterParams.reasoning = { effort: model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort };
		else if (model.thinkingLevelMap?.off !== null) openRouterParams.reasoning = { effort: model.thinkingLevelMap?.off ?? "none" };
	} else if (compat.thinkingFormat === "ant-ling" && model.reasoning && options?.reasoningEffort) {
		const effort = model.thinkingLevelMap?.[options.reasoningEffort];
		if (typeof effort === "string") params.reasoning = { effort };
	} else if (compat.thinkingFormat === "together" && model.reasoning) {
		const togetherParams = params;
		togetherParams.reasoning = { enabled: !!options?.reasoningEffort };
		if (options?.reasoningEffort && compat.supportsReasoningEffort) togetherParams.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	} else if (compat.thinkingFormat === "string-thinking" && model.reasoning) {
		const stringThinkingParams = params;
		if (options?.reasoningEffort) stringThinkingParams.thinking = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
		else if (model.thinkingLevelMap?.off !== null) stringThinkingParams.thinking = model.thinkingLevelMap?.off ?? "none";
	} else if (options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) params.reasoning_effort = model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
	else if (!options?.reasoningEffort && model.reasoning && compat.supportsReasoningEffort) {
		const offValue = model.thinkingLevelMap?.off;
		if (typeof offValue === "string") params.reasoning_effort = offValue;
	}
	if (model.compat?.openRouterRouting) params.provider = model.compat.openRouterRouting;
	if (model.compat?.vercelGatewayRouting) {
		const routing = model.compat.vercelGatewayRouting;
		if (routing.only || routing.order) {
			const gatewayOptions = {};
			if (routing.only) gatewayOptions.only = routing.only;
			if (routing.order) gatewayOptions.order = routing.order;
			params.providerOptions = { gateway: gatewayOptions };
		}
	}
	return params;
}
function buildChatTemplateKwargs(model, options, compat) {
	const kwargs = {};
	for (const [key, value] of Object.entries(compat.chatTemplateKwargs)) {
		const resolved = resolveChatTemplateKwargValue(model, options, value);
		if (resolved !== void 0) kwargs[key] = resolved;
	}
	return Object.keys(kwargs).length > 0 ? kwargs : void 0;
}
function resolveChatTemplateKwargValue(model, options, value) {
	if (typeof value !== "object" || value === null) return value;
	const reasoningEffort = options?.reasoningEffort;
	if (!reasoningEffort && value.omitWhenOff) return;
	if (value.$var === "thinking.enabled") return !!reasoningEffort;
	const mappedValue = reasoningEffort ? model.thinkingLevelMap?.[reasoningEffort] : model.thinkingLevelMap?.off;
	return mappedValue === void 0 ? reasoningEffort : typeof mappedValue === "string" ? mappedValue : void 0;
}
function getCompatCacheControl(compat, cacheRetention) {
	if (compat.cacheControlFormat !== "anthropic" || cacheRetention === "none") return;
	const ttl = cacheRetention === "long" && compat.supportsLongCacheRetention ? "1h" : void 0;
	return {
		type: "ephemeral",
		...ttl ? { ttl } : {}
	};
}
function applyAnthropicCacheControl(messages, tools, cacheControl) {
	addCacheControlToSystemPrompt(messages, cacheControl);
	addCacheControlToLastTool(tools, cacheControl);
	addCacheControlToLastConversationMessage(messages, cacheControl);
}
function addCacheControlToSystemPrompt(messages, cacheControl) {
	for (const message of messages) if (message.role === "system" || message.role === "developer") {
		addCacheControlToInstructionMessage(message, cacheControl);
		return;
	}
}
function addCacheControlToLastConversationMessage(messages, cacheControl) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "user" || message.role === "assistant" || message.role === "tool") {
			if (addCacheControlToMessage(message, cacheControl)) return;
		}
	}
}
function addCacheControlToLastTool(tools, cacheControl) {
	if (!tools || tools.length === 0) return;
	const lastTool = tools[tools.length - 1];
	lastTool.cache_control = cacheControl;
}
function addCacheControlToInstructionMessage(message, cacheControl) {
	return addCacheControlToTextContent(message, cacheControl);
}
function addCacheControlToMessage(message, cacheControl) {
	if (message.role === "user" || message.role === "assistant" || message.role === "tool") return addCacheControlToTextContent(message, cacheControl);
	return false;
}
function addCacheControlToTextContent(message, cacheControl) {
	const content = message.content;
	if (typeof content === "string") {
		if (content.length === 0) return false;
		message.content = [{
			type: "text",
			text: content,
			cache_control: cacheControl
		}];
		return true;
	}
	if (!Array.isArray(content)) return false;
	for (let i = content.length - 1; i >= 0; i--) {
		const part = content[i];
		if (part?.type === "text") {
			const textPart = part;
			textPart.cache_control = cacheControl;
			return true;
		}
	}
	return false;
}
function convertMessages(model, context, compat, options) {
	const params = [];
	const normalizeToolCallId = (id) => {
		if (id.includes("|")) {
			const separatorIndex = id.indexOf("|");
			const callId = id.slice(0, separatorIndex).replace(/[^a-zA-Z0-9_-]/g, "_");
			const itemId = id.slice(separatorIndex + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
			const combinedId = itemId.length > 0 ? `${callId}_${itemId}` : callId;
			if (combinedId.length <= 40) return combinedId;
			const hash = shortHash(id).slice(0, 8);
			return `${callId.slice(0, Math.max(1, 40 - hash.length - 1))}_${hash}`;
		}
		if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
		return id;
	};
	const transformedMessages = transformMessages(context.messages, model, (id) => normalizeToolCallId(id));
	if (context.systemPrompt) {
		const role = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
		params.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt)
		});
	}
	let lastRole = null;
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (compat.requiresAssistantAfterToolResult && lastRole === "toolResult" && msg.role === "user") params.push({
			role: "assistant",
			content: "I have processed the tool results."
		});
		if (msg.role === "user") {
			if (typeof msg.content === "string") params.push({
				role: "user",
				content: sanitizeSurrogates(msg.content)
			});
			else {
				const content = msg.content.map((item) => {
					if (item.type === "text") return {
						type: "text",
						text: sanitizeSurrogates(item.text)
					};
					else return {
						type: "image_url",
						image_url: { url: `data:${item.mimeType};base64,${item.data}` }
					};
				});
				if (content.length === 0) continue;
				params.push({
					role: "user",
					content
				});
			}
		} else if (msg.role === "assistant") {
			const assistantMsg = {
				role: "assistant",
				content: compat.requiresAssistantAfterToolResult ? "" : null
			};
			const assistantTextParts = msg.content.filter(isTextContentBlock).filter((block) => block.text.trim().length > 0).map((block) => ({
				type: "text",
				text: sanitizeSurrogates(block.text)
			}));
			const assistantText = assistantTextParts.map((part) => part.text).join("");
			const nonEmptyThinkingBlocks = msg.content.filter(isThinkingContentBlock).filter((block) => block.thinking.trim().length > 0);
			if (nonEmptyThinkingBlocks.length > 0) {
				if (compat.requiresThinkingAsText) assistantMsg.content = [{
					type: "text",
					text: nonEmptyThinkingBlocks.map((block) => sanitizeSurrogates(block.thinking)).join("\n\n")
				}, ...assistantTextParts];
				else {
					if (assistantText.length > 0) assistantMsg.content = assistantText;
					let signature = nonEmptyThinkingBlocks[0].thinkingSignature;
					if (model.provider === "opencode-go" && signature === "reasoning") signature = "reasoning_content";
					if (signature && signature.length > 0) assistantMsg[signature] = nonEmptyThinkingBlocks.map((block) => block.thinking).join("\n");
				}
			} else if (assistantText.length > 0) assistantMsg.content = assistantText;
			const toolCalls = msg.content.filter(isToolCallBlock);
			if (toolCalls.length > 0) {
				assistantMsg.tool_calls = toolCalls.map((tc) => {
					const customInputProperty = options?.grammarToolInputProperties?.get(tc.name);
					if (customInputProperty !== void 0) return {
						id: tc.id,
						type: "custom",
						custom: {
							name: tc.name,
							input: sanitizeSurrogates(getGrammarToolInput(tc.name, tc.arguments, customInputProperty))
						}
					};
					return {
						id: tc.id,
						type: "function",
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments)
						}
					};
				});
				const reasoningDetails = toolCalls.filter((tc) => tc.thoughtSignature).map((tc) => {
					try {
						return JSON.parse(tc.thoughtSignature);
					} catch {
						return null;
					}
				}).filter(Boolean);
				if (reasoningDetails.length > 0) assistantMsg.reasoning_details = reasoningDetails;
			}
			if (compat.requiresReasoningContentOnAssistantMessages && model.reasoning && assistantMsg.reasoning_content === void 0) assistantMsg.reasoning_content = "";
			const content = assistantMsg.content;
			if (!(content !== null && content !== void 0 && (typeof content === "string" ? content.length > 0 : content.length > 0)) && !assistantMsg.tool_calls) continue;
			params.push(assistantMsg);
		} else if (msg.role === "toolResult") {
			const imageBlocks = [];
			const deferredToolNames = /* @__PURE__ */ new Set();
			let j = i;
			for (; j < transformedMessages.length && transformedMessages[j].role === "toolResult"; j++) {
				const toolMsg = transformedMessages[j];
				const textResult = toolMsg.content.filter(isTextContentBlock).map((block) => block.text).join("\n");
				const hasImages = toolMsg.content.some((c) => c.type === "image");
				const toolResultText = textResult.length > 0 ? textResult : hasImages ? "(see attached image)" : "(no tool output)";
				const toolResultMsg = {
					role: "tool",
					content: sanitizeSurrogates(toolResultText),
					tool_call_id: toolMsg.toolCallId
				};
				if (compat.requiresToolResultName && toolMsg.toolName) toolResultMsg.name = toolMsg.toolName;
				params.push(toolResultMsg);
				if (compat.deferredToolsMode === "kimi") for (const name of toolMsg.addedToolNames ?? []) deferredToolNames.add(name);
				if (hasImages && model.input.includes("image")) {
					for (const block of toolMsg.content) if (isImageContentBlock(block)) imageBlocks.push({
						type: "image_url",
						image_url: { url: `data:${block.mimeType};base64,${block.data}` }
					});
				}
			}
			i = j - 1;
			if (imageBlocks.length > 0) {
				if (compat.requiresAssistantAfterToolResult) params.push({
					role: "assistant",
					content: "I have processed the tool results."
				});
				params.push({
					role: "user",
					content: [{
						type: "text",
						text: "Attached image(s) from tool result:"
					}, ...imageBlocks]
				});
				lastRole = "user";
			} else lastRole = "toolResult";
			if (deferredToolNames.size > 0) {
				const deferredTools = getToolsByName(context.tools, deferredToolNames);
				if (deferredTools.length > 0) {
					const kimiToolMessage = {
						role: "system",
						tools: convertTools(deferredTools, compat)
					};
					params.push(kimiToolMessage);
				}
			}
			continue;
		}
		lastRole = msg.role;
	}
	return params;
}
function convertTools(tools, compat) {
	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, compat.supportsOpenAIGrammarTools);
		if (grammar) return {
			type: "custom",
			custom: {
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					grammar: {
						syntax: grammar.format,
						definition: grammar.definition
					}
				}
			}
		};
		const strict = resolveJsonSchemaStrictSampling(tool, compat.supportsStrictMode !== false);
		return {
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				...compat.supportsStrictMode !== false && { strict: strict ?? false }
			}
		};
	});
}
function parseChunkUsage(rawUsage, model) {
	const promptTokens = rawUsage.prompt_tokens || 0;
	const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? rawUsage.prompt_cache_hit_tokens ?? 0;
	const cacheWriteTokens = rawUsage.prompt_tokens_details?.cache_write_tokens || 0;
	const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
	const outputTokens = rawUsage.completion_tokens || 0;
	const usage = {
		input,
		output: outputTokens,
		cacheRead: cacheReadTokens,
		cacheWrite: cacheWriteTokens,
		reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
		totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0
		}
	};
	calculateCost(model, usage);
	return usage;
}
function mapStopReason(reason) {
	if (reason === null) return { stopReason: "stop" };
	switch (reason) {
		case "stop":
		case "end": return { stopReason: "stop" };
		case "length": return { stopReason: "length" };
		case "function_call":
		case "tool_calls": return { stopReason: "toolUse" };
		case "content_filter": return {
			stopReason: "error",
			errorMessage: "Provider finish_reason: content_filter"
		};
		case "network_error": return {
			stopReason: "error",
			errorMessage: "Provider finish_reason: network_error"
		};
		default: return {
			stopReason: "error",
			errorMessage: `Provider finish_reason: ${reason}`
		};
	}
}
/**
* Auto-detect compatibility settings from provider name and baseUrl.
* Used as the base when model.compat is not set; explicit model.compat
* entries override these detected values.
*/
function detectCompat(model) {
	const provider = model.provider;
	const baseUrl = model.baseUrl;
	const isZai = provider === "zai" || provider === "zai-coding-cn" || baseUrl.includes("api.z.ai") || baseUrl.includes("open.bigmodel.cn");
	const isTogether = provider === "together" || baseUrl.includes("api.together.ai") || baseUrl.includes("api.together.xyz");
	const isMoonshot = provider === "moonshotai" || provider === "moonshotai-cn" || baseUrl.includes("api.moonshot.");
	const isOpenRouter = provider === "openrouter" || baseUrl.includes("openrouter.ai");
	const isCloudflareWorkersAI = provider === "cloudflare-workers-ai" || baseUrl.includes("api.cloudflare.com");
	const isCloudflareAiGateway = provider === "cloudflare-ai-gateway" || baseUrl.includes("gateway.ai.cloudflare.com");
	const isNvidia = provider === "nvidia" || baseUrl.includes("integrate.api.nvidia.com");
	const isAntLing = provider === "ant-ling" || baseUrl.includes("api.ant-ling.com");
	const isNonStandard = isNvidia || provider === "cerebras" || baseUrl.includes("cerebras.ai") || provider === "xai" || baseUrl.includes("api.x.ai") || isTogether || baseUrl.includes("chutes.ai") || baseUrl.includes("deepseek.com") || isZai || isMoonshot || provider === "opencode" || baseUrl.includes("opencode.ai") || isCloudflareWorkersAI || isCloudflareAiGateway || isAntLing;
	const useMaxTokens = baseUrl.includes("chutes.ai") || isMoonshot || isCloudflareAiGateway || isTogether || isNvidia || isAntLing;
	const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
	const isDeepSeek = provider === "deepseek" || baseUrl.includes("deepseek.com");
	const isOpenRouterDeveloperRoleModel = isOpenRouter && (model.id.startsWith("anthropic/") || model.id.startsWith("openai/"));
	const cacheControlFormat = provider === "openrouter" && model.id.startsWith("anthropic/") ? "anthropic" : void 0;
	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenRouterDeveloperRoleModel || !isNonStandard && !isOpenRouter,
		supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		supportsUsageInStreaming: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresThinkingAsText: false,
		requiresReasoningContentOnAssistantMessages: isDeepSeek,
		thinkingFormat: isDeepSeek ? "deepseek" : isZai ? "zai" : isTogether ? "together" : isAntLing ? "ant-ling" : isOpenRouter ? "openrouter" : "openai",
		openRouterRouting: {},
		vercelGatewayRouting: {},
		chatTemplateKwargs: {},
		zaiToolStream: false,
		supportsStrictMode: !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia,
		supportsOpenAIGrammarTools: false,
		cacheControlFormat,
		sendSessionAffinityHeaders: false,
		deferredToolsMode: void 0,
		sessionAffinityFormat: isOpenRouter ? "openrouter" : "openai",
		supportsLongCacheRetention: !(isTogether || isCloudflareWorkersAI || isCloudflareAiGateway || isNvidia || isAntLing)
	};
}
/**
* Get resolved compatibility settings for a model.
* Auto-detects from provider/URL then overrides with explicit model.compat.
*/
function getCompat(model) {
	const detected = detectCompat(model);
	if (!model.compat) return detected;
	return {
		supportsStore: model.compat.supportsStore ?? detected.supportsStore,
		supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
		supportsReasoningEffort: model.compat.supportsReasoningEffort ?? detected.supportsReasoningEffort,
		supportsUsageInStreaming: model.compat.supportsUsageInStreaming ?? detected.supportsUsageInStreaming,
		maxTokensField: model.compat.maxTokensField ?? detected.maxTokensField,
		requiresToolResultName: model.compat.requiresToolResultName ?? detected.requiresToolResultName,
		requiresAssistantAfterToolResult: model.compat.requiresAssistantAfterToolResult ?? detected.requiresAssistantAfterToolResult,
		requiresThinkingAsText: model.compat.requiresThinkingAsText ?? detected.requiresThinkingAsText,
		requiresReasoningContentOnAssistantMessages: model.compat.requiresReasoningContentOnAssistantMessages ?? detected.requiresReasoningContentOnAssistantMessages,
		thinkingFormat: model.compat.thinkingFormat ?? detected.thinkingFormat,
		openRouterRouting: model.compat.openRouterRouting ?? {},
		vercelGatewayRouting: model.compat.vercelGatewayRouting ?? detected.vercelGatewayRouting,
		chatTemplateKwargs: model.compat.chatTemplateKwargs ?? detected.chatTemplateKwargs,
		zaiToolStream: model.compat.zaiToolStream ?? detected.zaiToolStream,
		supportsStrictMode: model.compat.supportsStrictMode ?? detected.supportsStrictMode,
		supportsOpenAIGrammarTools: model.compat.supportsOpenAIGrammarTools ?? detected.supportsOpenAIGrammarTools,
		cacheControlFormat: model.compat.cacheControlFormat ?? detected.cacheControlFormat,
		sendSessionAffinityHeaders: model.compat.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders,
		deferredToolsMode: model.compat.deferredToolsMode ?? detected.deferredToolsMode,
		sessionAffinityFormat: model.compat.sessionAffinityFormat ?? detected.sessionAffinityFormat,
		supportsLongCacheRetention: model.compat.supportsLongCacheRetention ?? detected.supportsLongCacheRetention
	};
}
//#endregion
export { convertMessages, stream, streamSimple };
