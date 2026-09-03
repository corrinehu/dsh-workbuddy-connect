import { _ as parseStreamingJson, a as buildCopilotDynamicHeaders, d as resolveJsonSchemaStrictSampling, f as sanitizeSurrogates, g as parseJsonWithRepair, h as getProviderEnvValue, i as clampMaxTokensToContext, m as headersToRecord, n as adjustMaxTokensForThinking, o as hasCopilotVisionInput, p as retryProviderRequest, r as buildBaseOptions, t as transformMessages } from "./transform-messages-CRDJB818.js";
import { s as AssistantMessageEventStream, t as calculateCost } from "./models-uQEzsUBb.js";
import { t as splitDeferredTools } from "./deferred-tools-lXkm2FYi.js";
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/tslib.mjs
function __classPrivateFieldSet(receiver, state, value, kind, f) {
	if (kind === "m") throw new TypeError("Private method is not writable");
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
	return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
}
function __classPrivateFieldGet(receiver, state, kind, f) {
	if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
	if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
	return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/uuid.mjs
/**
* https://stackoverflow.com/a/2117523
*/
let uuid4 = function() {
	const { crypto } = globalThis;
	if (crypto?.randomUUID) {
		uuid4 = crypto.randomUUID.bind(crypto);
		return crypto.randomUUID();
	}
	const u8 = /* @__PURE__ */ new Uint8Array(1);
	const randomByte = crypto ? () => crypto.getRandomValues(u8)[0] : () => Math.random() * 255 & 255;
	return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (+c ^ randomByte() & 15 >> +c / 4).toString(16));
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/errors.mjs
function isAbortError(err) {
	return typeof err === "object" && err !== null && ("name" in err && err.name === "AbortError" || "message" in err && String(err.message).includes("FetchRequestCanceledException"));
}
const castToError = (err) => {
	if (err instanceof Error) return err;
	if (typeof err === "object" && err !== null) {
		try {
			if (Object.prototype.toString.call(err) === "[object Error]") {
				const error = new Error(err.message, err.cause ? { cause: err.cause } : {});
				if (err.stack) error.stack = err.stack;
				if (err.cause && !error.cause) error.cause = err.cause;
				if (err.name) error.name = err.name;
				return error;
			}
		} catch {}
		try {
			return new Error(JSON.stringify(err));
		} catch {}
	}
	return new Error(err);
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/core/error.mjs
var AnthropicError = class extends Error {};
var APIError = class APIError extends AnthropicError {
	constructor(status, error, message, headers, type) {
		super(`${APIError.makeMessage(status, error, message)}`);
		this.status = status;
		this.headers = headers;
		this.requestID = headers?.get("request-id");
		this.error = error;
		this.type = type ?? null;
	}
	static makeMessage(status, error, message) {
		const msg = error?.message ? typeof error.message === "string" ? error.message : JSON.stringify(error.message) : error ? JSON.stringify(error) : message;
		if (status && msg) return `${status} ${msg}`;
		if (status) return `${status} status code (no body)`;
		if (msg) return msg;
		return "(no status code or body)";
	}
	static generate(status, errorResponse, message, headers) {
		if (!status || !headers) return new APIConnectionError({
			message,
			cause: castToError(errorResponse)
		});
		const error = errorResponse;
		const type = error?.["error"]?.["type"];
		if (status === 400) return new BadRequestError(status, error, message, headers, type);
		if (status === 401) return new AuthenticationError(status, error, message, headers, type);
		if (status === 403) return new PermissionDeniedError(status, error, message, headers, type);
		if (status === 404) return new NotFoundError(status, error, message, headers, type);
		if (status === 409) return new ConflictError(status, error, message, headers, type);
		if (status === 422) return new UnprocessableEntityError(status, error, message, headers, type);
		if (status === 429) return new RateLimitError(status, error, message, headers, type);
		if (status >= 500) return new InternalServerError(status, error, message, headers, type);
		return new APIError(status, error, message, headers, type);
	}
};
var APIUserAbortError = class extends APIError {
	constructor({ message } = {}) {
		super(void 0, void 0, message || "Request was aborted.", void 0);
	}
};
var APIConnectionError = class extends APIError {
	constructor({ message, cause }) {
		super(void 0, void 0, message || "Connection error.", void 0);
		if (cause) this.cause = cause;
	}
};
var APIConnectionTimeoutError = class extends APIConnectionError {
	constructor({ message } = {}) {
		super({ message: message ?? "Request timed out." });
	}
};
var BadRequestError = class extends APIError {};
var AuthenticationError = class extends APIError {};
var PermissionDeniedError = class extends APIError {};
var NotFoundError = class extends APIError {};
var ConflictError = class extends APIError {};
var UnprocessableEntityError = class extends APIError {};
var RateLimitError = class extends APIError {};
var InternalServerError = class extends APIError {};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/values.mjs
const startsWithSchemeRegexp = /^[a-z][a-z0-9+.-]*:/i;
const isAbsoluteURL = (url) => {
	return startsWithSchemeRegexp.test(url);
};
let isArray = (val) => (isArray = Array.isArray, isArray(val));
let isReadonlyArray = isArray;
/** Returns an object if the given value isn't an object, otherwise returns as-is */
function maybeObj(x) {
	if (typeof x !== "object") return {};
	return x ?? {};
}
function isEmptyObj(obj) {
	if (!obj) return true;
	for (const _k in obj) return false;
	return true;
}
function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj, key);
}
const validatePositiveInteger = (name, n) => {
	if (typeof n !== "number" || !Number.isInteger(n)) throw new AnthropicError(`${name} must be an integer`);
	if (n < 0) throw new AnthropicError(`${name} must be a positive integer`);
	return n;
};
const safeJSON = (text) => {
	try {
		return JSON.parse(text);
	} catch (err) {
		return;
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/sleep.mjs
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/version.mjs
const VERSION = "0.91.1";
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/detect-platform.mjs
const isRunningInBrowser = () => {
	return typeof window !== "undefined" && typeof window.document !== "undefined" && typeof navigator !== "undefined";
};
/**
* Note this does not detect 'browser'; for that, use getBrowserInfo().
*/
function getDetectedPlatform() {
	if (typeof Deno !== "undefined" && Deno.build != null) return "deno";
	if (typeof EdgeRuntime !== "undefined") return "edge";
	if (Object.prototype.toString.call(typeof globalThis.process !== "undefined" ? globalThis.process : 0) === "[object process]") return "node";
	return "unknown";
}
const getPlatformProperties = () => {
	const detectedPlatform = getDetectedPlatform();
	if (detectedPlatform === "deno") return {
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": VERSION,
		"X-Stainless-OS": normalizePlatform(Deno.build.os),
		"X-Stainless-Arch": normalizeArch(Deno.build.arch),
		"X-Stainless-Runtime": "deno",
		"X-Stainless-Runtime-Version": typeof Deno.version === "string" ? Deno.version : Deno.version?.deno ?? "unknown"
	};
	if (typeof EdgeRuntime !== "undefined") return {
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": VERSION,
		"X-Stainless-OS": "Unknown",
		"X-Stainless-Arch": `other:${EdgeRuntime}`,
		"X-Stainless-Runtime": "edge",
		"X-Stainless-Runtime-Version": globalThis.process.version
	};
	if (detectedPlatform === "node") return {
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": VERSION,
		"X-Stainless-OS": normalizePlatform(globalThis.process.platform ?? "unknown"),
		"X-Stainless-Arch": normalizeArch(globalThis.process.arch ?? "unknown"),
		"X-Stainless-Runtime": "node",
		"X-Stainless-Runtime-Version": globalThis.process.version ?? "unknown"
	};
	const browserInfo = getBrowserInfo();
	if (browserInfo) return {
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": VERSION,
		"X-Stainless-OS": "Unknown",
		"X-Stainless-Arch": "unknown",
		"X-Stainless-Runtime": `browser:${browserInfo.browser}`,
		"X-Stainless-Runtime-Version": browserInfo.version
	};
	return {
		"X-Stainless-Lang": "js",
		"X-Stainless-Package-Version": VERSION,
		"X-Stainless-OS": "Unknown",
		"X-Stainless-Arch": "unknown",
		"X-Stainless-Runtime": "unknown",
		"X-Stainless-Runtime-Version": "unknown"
	};
};
function getBrowserInfo() {
	if (typeof navigator === "undefined" || !navigator) return null;
	for (const { key, pattern } of [
		{
			key: "edge",
			pattern: /Edge(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/
		},
		{
			key: "ie",
			pattern: /MSIE(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/
		},
		{
			key: "ie",
			pattern: /Trident(?:.*rv\:(\d+)\.(\d+)(?:\.(\d+))?)?/
		},
		{
			key: "chrome",
			pattern: /Chrome(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/
		},
		{
			key: "firefox",
			pattern: /Firefox(?:\W+(\d+)\.(\d+)(?:\.(\d+))?)?/
		},
		{
			key: "safari",
			pattern: /(?:Version\W+(\d+)\.(\d+)(?:\.(\d+))?)?(?:\W+Mobile\S*)?\W+Safari/
		}
	]) {
		const match = pattern.exec(navigator.userAgent);
		if (match) return {
			browser: key,
			version: `${match[1] || 0}.${match[2] || 0}.${match[3] || 0}`
		};
	}
	return null;
}
const normalizeArch = (arch) => {
	if (arch === "x32") return "x32";
	if (arch === "x86_64" || arch === "x64") return "x64";
	if (arch === "arm") return "arm";
	if (arch === "aarch64" || arch === "arm64") return "arm64";
	if (arch) return `other:${arch}`;
	return "unknown";
};
const normalizePlatform = (platform) => {
	platform = platform.toLowerCase();
	if (platform.includes("ios")) return "iOS";
	if (platform === "android") return "Android";
	if (platform === "darwin") return "MacOS";
	if (platform === "win32") return "Windows";
	if (platform === "freebsd") return "FreeBSD";
	if (platform === "openbsd") return "OpenBSD";
	if (platform === "linux") return "Linux";
	if (platform) return `Other:${platform}`;
	return "Unknown";
};
let _platformHeaders;
const getPlatformHeaders = () => {
	return _platformHeaders ?? (_platformHeaders = getPlatformProperties());
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/shims.mjs
function getDefaultFetch() {
	if (typeof fetch !== "undefined") return fetch;
	throw new Error("`fetch` is not defined as a global; Either pass `fetch` to the client, `new Anthropic({ fetch })` or polyfill the global, `globalThis.fetch = fetch`");
}
function makeReadableStream(...args) {
	const ReadableStream = globalThis.ReadableStream;
	if (typeof ReadableStream === "undefined") throw new Error("`ReadableStream` is not defined as a global; You will need to polyfill it, `globalThis.ReadableStream = ReadableStream`");
	return new ReadableStream(...args);
}
function ReadableStreamFrom(iterable) {
	let iter = Symbol.asyncIterator in iterable ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
	return makeReadableStream({
		start() {},
		async pull(controller) {
			const { done, value } = await iter.next();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		async cancel() {
			await iter.return?.();
		}
	});
}
/**
* Most browsers don't yet have async iterable support for ReadableStream,
* and Node has a very different way of reading bytes from its "ReadableStream".
*
* This polyfill was pulled from https://github.com/MattiasBuelens/web-streams-polyfill/pull/122#issuecomment-1627354490
*/
function ReadableStreamToAsyncIterable(stream) {
	if (stream[Symbol.asyncIterator]) return stream;
	const reader = stream.getReader();
	return {
		async next() {
			try {
				const result = await reader.read();
				if (result?.done) reader.releaseLock();
				return result;
			} catch (e) {
				reader.releaseLock();
				throw e;
			}
		},
		async return() {
			const cancelPromise = reader.cancel();
			reader.releaseLock();
			await cancelPromise;
			return {
				done: true,
				value: void 0
			};
		},
		[Symbol.asyncIterator]() {
			return this;
		}
	};
}
/**
* Cancels a ReadableStream we don't need to consume.
* See https://undici.nodejs.org/#/?id=garbage-collection
*/
async function CancelReadableStream(stream) {
	if (stream === null || typeof stream !== "object") return;
	if (stream[Symbol.asyncIterator]) {
		await stream[Symbol.asyncIterator]().return?.();
		return;
	}
	const reader = stream.getReader();
	const cancelPromise = reader.cancel();
	reader.releaseLock();
	await cancelPromise;
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/request-options.mjs
const FallbackEncoder = ({ headers, body }) => {
	return {
		bodyHeaders: { "content-type": "application/json" },
		body: JSON.stringify(body)
	};
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/query.mjs
/**
* Basic re-implementation of `qs.stringify` for primitive types.
*/
function stringifyQuery(query) {
	return Object.entries(query).filter(([_, value]) => typeof value !== "undefined").map(([key, value]) => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
		if (value === null) return `${encodeURIComponent(key)}=`;
		throw new AnthropicError(`Cannot stringify type ${typeof value}; Expected string, number, boolean, or null. If you need to pass nested query parameters, you can manually encode them, e.g. { query: { 'foo[key1]': value1, 'foo[key2]': value2 } }, and please open a GitHub issue requesting better support for your use case.`);
	}).join("&");
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/bytes.mjs
function concatBytes(buffers) {
	let length = 0;
	for (const buffer of buffers) length += buffer.length;
	const output = new Uint8Array(length);
	let index = 0;
	for (const buffer of buffers) {
		output.set(buffer, index);
		index += buffer.length;
	}
	return output;
}
let encodeUTF8_;
function encodeUTF8(str) {
	let encoder;
	return (encodeUTF8_ ?? (encoder = new globalThis.TextEncoder(), encodeUTF8_ = encoder.encode.bind(encoder)))(str);
}
let decodeUTF8_;
function decodeUTF8(bytes) {
	let decoder;
	return (decodeUTF8_ ?? (decoder = new globalThis.TextDecoder(), decodeUTF8_ = decoder.decode.bind(decoder)))(bytes);
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/decoders/line.mjs
var _LineDecoder_buffer;
var _LineDecoder_carriageReturnIndex;
/**
* A re-implementation of httpx's `LineDecoder` in Python that handles incrementally
* reading lines from text.
*
* https://github.com/encode/httpx/blob/920333ea98118e9cf617f246905d7b202510941c/httpx/_decoders.py#L258
*/
var LineDecoder = class {
	constructor() {
		_LineDecoder_buffer.set(this, void 0);
		_LineDecoder_carriageReturnIndex.set(this, void 0);
		__classPrivateFieldSet(this, _LineDecoder_buffer, /* @__PURE__ */ new Uint8Array(), "f");
		__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
	}
	decode(chunk) {
		if (chunk == null) return [];
		const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
		__classPrivateFieldSet(this, _LineDecoder_buffer, concatBytes([__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), binaryChunk]), "f");
		const lines = [];
		let patternIndex;
		while ((patternIndex = findNewlineIndex(__classPrivateFieldGet(this, _LineDecoder_buffer, "f"), __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f"))) != null) {
			if (patternIndex.carriage && __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") == null) {
				__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, patternIndex.index, "f");
				continue;
			}
			if (__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") != null && (patternIndex.index !== __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") + 1 || patternIndex.carriage)) {
				lines.push(decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") - 1)));
				__classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(__classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f")), "f");
				__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
				continue;
			}
			const endIndex = __classPrivateFieldGet(this, _LineDecoder_carriageReturnIndex, "f") !== null ? patternIndex.preceding - 1 : patternIndex.preceding;
			const line = decodeUTF8(__classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(0, endIndex));
			lines.push(line);
			__classPrivateFieldSet(this, _LineDecoder_buffer, __classPrivateFieldGet(this, _LineDecoder_buffer, "f").subarray(patternIndex.index), "f");
			__classPrivateFieldSet(this, _LineDecoder_carriageReturnIndex, null, "f");
		}
		return lines;
	}
	flush() {
		if (!__classPrivateFieldGet(this, _LineDecoder_buffer, "f").length) return [];
		return this.decode("\n");
	}
};
_LineDecoder_buffer = /* @__PURE__ */ new WeakMap(), _LineDecoder_carriageReturnIndex = /* @__PURE__ */ new WeakMap();
LineDecoder.NEWLINE_CHARS = /* @__PURE__ */ new Set(["\n", "\r"]);
LineDecoder.NEWLINE_REGEXP = /\r\n|[\n\r]/g;
/**
* This function searches the buffer for the end patterns, (\r or \n)
* and returns an object with the index preceding the matched newline and the
* index after the newline char. `null` is returned if no new line is found.
*
* ```ts
* findNewLineIndex('abc\ndef') -> { preceding: 2, index: 3 }
* ```
*/
function findNewlineIndex(buffer, startIndex) {
	const newline = 10;
	const carriage = 13;
	for (let i = startIndex ?? 0; i < buffer.length; i++) {
		if (buffer[i] === newline) return {
			preceding: i,
			index: i + 1,
			carriage: false
		};
		if (buffer[i] === carriage) return {
			preceding: i,
			index: i + 1,
			carriage: true
		};
	}
	return null;
}
function findDoubleNewlineIndex(buffer) {
	const newline = 10;
	const carriage = 13;
	for (let i = 0; i < buffer.length - 1; i++) {
		if (buffer[i] === newline && buffer[i + 1] === newline) return i + 2;
		if (buffer[i] === carriage && buffer[i + 1] === carriage) return i + 2;
		if (buffer[i] === carriage && buffer[i + 1] === newline && i + 3 < buffer.length && buffer[i + 2] === carriage && buffer[i + 3] === newline) return i + 4;
	}
	return -1;
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/log.mjs
const levelNumbers = {
	off: 0,
	error: 200,
	warn: 300,
	info: 400,
	debug: 500
};
const parseLogLevel = (maybeLevel, sourceName, client) => {
	if (!maybeLevel) return;
	if (hasOwn(levelNumbers, maybeLevel)) return maybeLevel;
	loggerFor(client).warn(`${sourceName} was set to ${JSON.stringify(maybeLevel)}, expected one of ${JSON.stringify(Object.keys(levelNumbers))}`);
};
function noop() {}
function makeLogFn(fnLevel, logger, logLevel) {
	if (!logger || levelNumbers[fnLevel] > levelNumbers[logLevel]) return noop;
	else return logger[fnLevel].bind(logger);
}
const noopLogger = {
	error: noop,
	warn: noop,
	info: noop,
	debug: noop
};
let cachedLoggers = /* @__PURE__ */ new WeakMap();
function loggerFor(client) {
	const logger = client.logger;
	const logLevel = client.logLevel ?? "off";
	if (!logger) return noopLogger;
	const cachedLogger = cachedLoggers.get(logger);
	if (cachedLogger && cachedLogger[0] === logLevel) return cachedLogger[1];
	const levelLogger = {
		error: makeLogFn("error", logger, logLevel),
		warn: makeLogFn("warn", logger, logLevel),
		info: makeLogFn("info", logger, logLevel),
		debug: makeLogFn("debug", logger, logLevel)
	};
	cachedLoggers.set(logger, [logLevel, levelLogger]);
	return levelLogger;
}
const formatRequestDetails = (details) => {
	if (details.options) {
		details.options = { ...details.options };
		delete details.options["headers"];
	}
	if (details.headers) details.headers = Object.fromEntries((details.headers instanceof Headers ? [...details.headers] : Object.entries(details.headers)).map(([name, value]) => [name, name.toLowerCase() === "x-api-key" || name.toLowerCase() === "authorization" || name.toLowerCase() === "cookie" || name.toLowerCase() === "set-cookie" ? "***" : value]));
	if ("retryOfRequestLogID" in details) {
		if (details.retryOfRequestLogID) details.retryOf = details.retryOfRequestLogID;
		delete details.retryOfRequestLogID;
	}
	return details;
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/core/streaming.mjs
var _Stream_client;
var Stream = class Stream {
	constructor(iterator, controller, client) {
		this.iterator = iterator;
		_Stream_client.set(this, void 0);
		this.controller = controller;
		__classPrivateFieldSet(this, _Stream_client, client, "f");
	}
	static fromSSEResponse(response, controller, client) {
		let consumed = false;
		const logger = client ? loggerFor(client) : console;
		async function* iterator() {
			if (consumed) throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
			consumed = true;
			let done = false;
			try {
				for await (const sse of _iterSSEMessages(response, controller)) {
					if (sse.event === "completion") try {
						yield JSON.parse(sse.data);
					} catch (e) {
						logger.error(`Could not parse message into JSON:`, sse.data);
						logger.error(`From chunk:`, sse.raw);
						throw e;
					}
					if (sse.event === "message_start" || sse.event === "message_delta" || sse.event === "message_stop" || sse.event === "content_block_start" || sse.event === "content_block_delta" || sse.event === "content_block_stop" || sse.event === "message" || sse.event === "user.message" || sse.event === "user.interrupt" || sse.event === "user.tool_confirmation" || sse.event === "user.custom_tool_result" || sse.event === "agent.message" || sse.event === "agent.thinking" || sse.event === "agent.tool_use" || sse.event === "agent.tool_result" || sse.event === "agent.mcp_tool_use" || sse.event === "agent.mcp_tool_result" || sse.event === "agent.custom_tool_use" || sse.event === "agent.thread_context_compacted" || sse.event === "session.status_running" || sse.event === "session.status_idle" || sse.event === "session.status_rescheduled" || sse.event === "session.status_terminated" || sse.event === "session.error" || sse.event === "session.deleted" || sse.event === "span.model_request_start" || sse.event === "span.model_request_end") try {
						yield JSON.parse(sse.data);
					} catch (e) {
						logger.error(`Could not parse message into JSON:`, sse.data);
						logger.error(`From chunk:`, sse.raw);
						throw e;
					}
					if (sse.event === "ping") continue;
					if (sse.event === "error") {
						const body = safeJSON(sse.data) ?? sse.data;
						const type = body?.error?.type;
						throw new APIError(void 0, body, void 0, response.headers, type);
					}
				}
				done = true;
			} catch (e) {
				if (isAbortError(e)) return;
				throw e;
			} finally {
				if (!done) controller.abort();
			}
		}
		return new Stream(iterator, controller, client);
	}
	/**
	* Generates a Stream from a newline-separated ReadableStream
	* where each item is a JSON value.
	*/
	static fromReadableStream(readableStream, controller, client) {
		let consumed = false;
		async function* iterLines() {
			const lineDecoder = new LineDecoder();
			const iter = ReadableStreamToAsyncIterable(readableStream);
			for await (const chunk of iter) for (const line of lineDecoder.decode(chunk)) yield line;
			for (const line of lineDecoder.flush()) yield line;
		}
		async function* iterator() {
			if (consumed) throw new AnthropicError("Cannot iterate over a consumed stream, use `.tee()` to split the stream.");
			consumed = true;
			let done = false;
			try {
				for await (const line of iterLines()) {
					if (done) continue;
					if (line) yield JSON.parse(line);
				}
				done = true;
			} catch (e) {
				if (isAbortError(e)) return;
				throw e;
			} finally {
				if (!done) controller.abort();
			}
		}
		return new Stream(iterator, controller, client);
	}
	[(_Stream_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
		return this.iterator();
	}
	/**
	* Splits the stream into two streams which can be
	* independently read from at different speeds.
	*/
	tee() {
		const left = [];
		const right = [];
		const iterator = this.iterator();
		const teeIterator = (queue) => {
			return { next: () => {
				if (queue.length === 0) {
					const result = iterator.next();
					left.push(result);
					right.push(result);
				}
				return queue.shift();
			} };
		};
		return [new Stream(() => teeIterator(left), this.controller, __classPrivateFieldGet(this, _Stream_client, "f")), new Stream(() => teeIterator(right), this.controller, __classPrivateFieldGet(this, _Stream_client, "f"))];
	}
	/**
	* Converts this stream to a newline-separated ReadableStream of
	* JSON stringified values in the stream
	* which can be turned back into a Stream with `Stream.fromReadableStream()`.
	*/
	toReadableStream() {
		const self = this;
		let iter;
		return makeReadableStream({
			async start() {
				iter = self[Symbol.asyncIterator]();
			},
			async pull(ctrl) {
				try {
					const { value, done } = await iter.next();
					if (done) return ctrl.close();
					const bytes = encodeUTF8(JSON.stringify(value) + "\n");
					ctrl.enqueue(bytes);
				} catch (err) {
					ctrl.error(err);
				}
			},
			async cancel() {
				await iter.return?.();
			}
		});
	}
};
async function* _iterSSEMessages(response, controller) {
	if (!response.body) {
		controller.abort();
		if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
		throw new AnthropicError(`Attempted to iterate over a response with no body`);
	}
	const sseDecoder = new SSEDecoder();
	const lineDecoder = new LineDecoder();
	const iter = ReadableStreamToAsyncIterable(response.body);
	for await (const sseChunk of iterSSEChunks(iter)) for (const line of lineDecoder.decode(sseChunk)) {
		const sse = sseDecoder.decode(line);
		if (sse) yield sse;
	}
	for (const line of lineDecoder.flush()) {
		const sse = sseDecoder.decode(line);
		if (sse) yield sse;
	}
}
/**
* Given an async iterable iterator, iterates over it and yields full
* SSE chunks, i.e. yields when a double new-line is encountered.
*/
async function* iterSSEChunks(iterator) {
	let data = /* @__PURE__ */ new Uint8Array();
	for await (const chunk of iterator) {
		if (chunk == null) continue;
		const binaryChunk = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : typeof chunk === "string" ? encodeUTF8(chunk) : chunk;
		let newData = new Uint8Array(data.length + binaryChunk.length);
		newData.set(data);
		newData.set(binaryChunk, data.length);
		data = newData;
		let patternIndex;
		while ((patternIndex = findDoubleNewlineIndex(data)) !== -1) {
			yield data.slice(0, patternIndex);
			data = data.slice(patternIndex);
		}
	}
	if (data.length > 0) yield data;
}
var SSEDecoder = class {
	constructor() {
		this.event = null;
		this.data = [];
		this.chunks = [];
	}
	decode(line) {
		if (line.endsWith("\r")) line = line.substring(0, line.length - 1);
		if (!line) {
			if (!this.event && !this.data.length) return null;
			const sse = {
				event: this.event,
				data: this.data.join("\n"),
				raw: this.chunks
			};
			this.event = null;
			this.data = [];
			this.chunks = [];
			return sse;
		}
		this.chunks.push(line);
		if (line.startsWith(":")) return null;
		let [fieldname, _, value] = partition(line, ":");
		if (value.startsWith(" ")) value = value.substring(1);
		if (fieldname === "event") this.event = value;
		else if (fieldname === "data") this.data.push(value);
		return null;
	}
};
function partition(str, delimiter) {
	const index = str.indexOf(delimiter);
	if (index !== -1) return [
		str.substring(0, index),
		delimiter,
		str.substring(index + delimiter.length)
	];
	return [
		str,
		"",
		""
	];
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/parse.mjs
async function defaultParseResponse(client, props) {
	const { response, requestLogID, retryOfRequestLogID, startTime } = props;
	const body = await (async () => {
		if (props.options.stream) {
			loggerFor(client).debug("response", response.status, response.url, response.headers, response.body);
			if (props.options.__streamClass) return props.options.__streamClass.fromSSEResponse(response, props.controller);
			return Stream.fromSSEResponse(response, props.controller);
		}
		if (response.status === 204) return null;
		if (props.options.__binaryResponse) return response;
		const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim();
		if (mediaType?.includes("application/json") || mediaType?.endsWith("+json")) {
			if (response.headers.get("content-length") === "0") return;
			return addRequestID(await response.json(), response);
		}
		return await response.text();
	})();
	loggerFor(client).debug(`[${requestLogID}] response parsed`, formatRequestDetails({
		retryOfRequestLogID,
		url: response.url,
		status: response.status,
		body,
		durationMs: Date.now() - startTime
	}));
	return body;
}
function addRequestID(value, response) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return value;
	return Object.defineProperty(value, "_request_id", {
		value: response.headers.get("request-id"),
		enumerable: false
	});
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/core/api-promise.mjs
var _APIPromise_client;
/**
* A subclass of `Promise` providing additional helper methods
* for interacting with the SDK.
*/
var APIPromise = class APIPromise extends Promise {
	constructor(client, responsePromise, parseResponse = defaultParseResponse) {
		super((resolve) => {
			resolve(null);
		});
		this.responsePromise = responsePromise;
		this.parseResponse = parseResponse;
		_APIPromise_client.set(this, void 0);
		__classPrivateFieldSet(this, _APIPromise_client, client, "f");
	}
	_thenUnwrap(transform) {
		return new APIPromise(__classPrivateFieldGet(this, _APIPromise_client, "f"), this.responsePromise, async (client, props) => addRequestID(transform(await this.parseResponse(client, props), props), props.response));
	}
	/**
	* Gets the raw `Response` instance instead of parsing the response
	* data.
	*
	* If you want to parse the response body but still get the `Response`
	* instance, you can use {@link withResponse()}.
	*
	* 👋 Getting the wrong TypeScript type for `Response`?
	* Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
	* to your `tsconfig.json`.
	*/
	asResponse() {
		return this.responsePromise.then((p) => p.response);
	}
	/**
	* Gets the parsed response data, the raw `Response` instance and the ID of the request,
	* returned via the `request-id` header which is useful for debugging requests and resporting
	* issues to Anthropic.
	*
	* If you just want to get the raw `Response` instance without parsing it,
	* you can use {@link asResponse()}.
	*
	* 👋 Getting the wrong TypeScript type for `Response`?
	* Try setting `"moduleResolution": "NodeNext"` or add `"lib": ["DOM"]`
	* to your `tsconfig.json`.
	*/
	async withResponse() {
		const [data, response] = await Promise.all([this.parse(), this.asResponse()]);
		return {
			data,
			response,
			request_id: response.headers.get("request-id")
		};
	}
	parse() {
		if (!this.parsedPromise) this.parsedPromise = this.responsePromise.then((data) => this.parseResponse(__classPrivateFieldGet(this, _APIPromise_client, "f"), data));
		return this.parsedPromise;
	}
	then(onfulfilled, onrejected) {
		return this.parse().then(onfulfilled, onrejected);
	}
	catch(onrejected) {
		return this.parse().catch(onrejected);
	}
	finally(onfinally) {
		return this.parse().finally(onfinally);
	}
};
_APIPromise_client = /* @__PURE__ */ new WeakMap();
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/core/pagination.mjs
var _AbstractPage_client;
var AbstractPage = class {
	constructor(client, response, body, options) {
		_AbstractPage_client.set(this, void 0);
		__classPrivateFieldSet(this, _AbstractPage_client, client, "f");
		this.options = options;
		this.response = response;
		this.body = body;
	}
	hasNextPage() {
		if (!this.getPaginatedItems().length) return false;
		return this.nextPageRequestOptions() != null;
	}
	async getNextPage() {
		const nextOptions = this.nextPageRequestOptions();
		if (!nextOptions) throw new AnthropicError("No next page expected; please check `.hasNextPage()` before calling `.getNextPage()`.");
		return await __classPrivateFieldGet(this, _AbstractPage_client, "f").requestAPIList(this.constructor, nextOptions);
	}
	async *iterPages() {
		let page = this;
		yield page;
		while (page.hasNextPage()) {
			page = await page.getNextPage();
			yield page;
		}
	}
	async *[(_AbstractPage_client = /* @__PURE__ */ new WeakMap(), Symbol.asyncIterator)]() {
		for await (const page of this.iterPages()) for (const item of page.getPaginatedItems()) yield item;
	}
};
/**
* This subclass of Promise will resolve to an instantiated Page once the request completes.
*
* It also implements AsyncIterable to allow auto-paginating iteration on an unawaited list call, eg:
*
*    for await (const item of client.items.list()) {
*      console.log(item)
*    }
*/
var PagePromise = class extends APIPromise {
	constructor(client, request, Page) {
		super(client, request, async (client, props) => new Page(client, props.response, await defaultParseResponse(client, props), props.options));
	}
	/**
	* Allow auto-paginating iteration on an unawaited list call, eg:
	*
	*    for await (const item of client.items.list()) {
	*      console.log(item)
	*    }
	*/
	async *[Symbol.asyncIterator]() {
		const page = await this;
		for await (const item of page) yield item;
	}
};
var Page = class extends AbstractPage {
	constructor(client, response, body, options) {
		super(client, response, body, options);
		this.data = body.data || [];
		this.has_more = body.has_more || false;
		this.first_id = body.first_id || null;
		this.last_id = body.last_id || null;
	}
	getPaginatedItems() {
		return this.data ?? [];
	}
	hasNextPage() {
		if (this.has_more === false) return false;
		return super.hasNextPage();
	}
	nextPageRequestOptions() {
		if (this.options.query?.["before_id"]) {
			const first_id = this.first_id;
			if (!first_id) return null;
			return {
				...this.options,
				query: {
					...maybeObj(this.options.query),
					before_id: first_id
				}
			};
		}
		const cursor = this.last_id;
		if (!cursor) return null;
		return {
			...this.options,
			query: {
				...maybeObj(this.options.query),
				after_id: cursor
			}
		};
	}
};
var PageCursor = class extends AbstractPage {
	constructor(client, response, body, options) {
		super(client, response, body, options);
		this.data = body.data || [];
		this.next_page = body.next_page || null;
	}
	getPaginatedItems() {
		return this.data ?? [];
	}
	nextPageRequestOptions() {
		const cursor = this.next_page;
		if (!cursor) return null;
		return {
			...this.options,
			query: {
				...maybeObj(this.options.query),
				page: cursor
			}
		};
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/uploads.mjs
const checkFileSupport = () => {
	if (typeof File === "undefined") {
		const { process } = globalThis;
		const isOldNode = typeof process?.versions?.node === "string" && parseInt(process.versions.node.split(".")) < 20;
		throw new Error("`File` is not defined as a global, which is required for file uploads." + (isOldNode ? " Update to Node 20 LTS or newer, or set `globalThis.File` to `import('node:buffer').File`." : ""));
	}
};
/**
* Construct a `File` instance. This is used to ensure a helpful error is thrown
* for environments that don't define a global `File` yet.
*/
function makeFile(fileBits, fileName, options) {
	checkFileSupport();
	return new File(fileBits, fileName ?? "unknown_file", options);
}
function getName(value, stripPath) {
	const val = typeof value === "object" && value !== null && ("name" in value && value.name && String(value.name) || "url" in value && value.url && String(value.url) || "filename" in value && value.filename && String(value.filename) || "path" in value && value.path && String(value.path)) || "";
	return stripPath ? val.split(/[\\/]/).pop() || void 0 : val;
}
const isAsyncIterable = (value) => value != null && typeof value === "object" && typeof value[Symbol.asyncIterator] === "function";
const multipartFormRequestOptions = async (opts, fetch, stripFilenames = true) => {
	return {
		...opts,
		body: await createForm(opts.body, fetch, stripFilenames)
	};
};
const supportsFormDataMap = /* @__PURE__ */ new WeakMap();
/**
* node-fetch doesn't support the global FormData object in recent node versions. Instead of sending
* properly-encoded form data, it just stringifies the object, resulting in a request body of "[object FormData]".
* This function detects if the fetch function provided supports the global FormData object to avoid
* confusing error messages later on.
*/
function supportsFormData(fetchObject) {
	const fetch = typeof fetchObject === "function" ? fetchObject : fetchObject.fetch;
	const cached = supportsFormDataMap.get(fetch);
	if (cached) return cached;
	const promise = (async () => {
		try {
			const FetchResponse = "Response" in fetch ? fetch.Response : (await fetch("data:,")).constructor;
			const data = new FormData();
			if (data.toString() === await new FetchResponse(data).text()) return false;
			return true;
		} catch {
			return true;
		}
	})();
	supportsFormDataMap.set(fetch, promise);
	return promise;
}
const createForm = async (body, fetch, stripFilenames = true) => {
	if (!await supportsFormData(fetch)) throw new TypeError("The provided fetch function does not support file uploads with the current global FormData class.");
	const form = new FormData();
	await Promise.all(Object.entries(body || {}).map(([key, value]) => addFormValue(form, key, value, stripFilenames)));
	return form;
};
const isNamedBlob = (value) => value instanceof Blob && "name" in value;
const addFormValue = async (form, key, value, stripFilenames) => {
	if (value === void 0) return;
	if (value == null) throw new TypeError(`Received null for "${key}"; to pass null in FormData, you must use the string 'null'`);
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") form.append(key, String(value));
	else if (value instanceof Response) {
		let options = {};
		const contentType = value.headers.get("Content-Type");
		if (contentType) options = { type: contentType };
		form.append(key, makeFile([await value.blob()], getName(value, stripFilenames), options));
	} else if (isAsyncIterable(value)) form.append(key, makeFile([await new Response(ReadableStreamFrom(value)).blob()], getName(value, stripFilenames)));
	else if (isNamedBlob(value)) form.append(key, makeFile([value], getName(value, stripFilenames), { type: value.type }));
	else if (Array.isArray(value)) await Promise.all(value.map((entry) => addFormValue(form, key + "[]", entry, stripFilenames)));
	else if (typeof value === "object") await Promise.all(Object.entries(value).map(([name, prop]) => addFormValue(form, `${key}[${name}]`, prop, stripFilenames)));
	else throw new TypeError(`Invalid value given to form, expected a string, number, boolean, object, Array, File or Blob but got ${value} instead`);
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/to-file.mjs
/**
* This check adds the arrayBuffer() method type because it is available and used at runtime
*/
const isBlobLike = (value) => value != null && typeof value === "object" && typeof value.size === "number" && typeof value.type === "string" && typeof value.text === "function" && typeof value.slice === "function" && typeof value.arrayBuffer === "function";
/**
* This check adds the arrayBuffer() method type because it is available and used at runtime
*/
const isFileLike = (value) => value != null && typeof value === "object" && typeof value.name === "string" && typeof value.lastModified === "number" && isBlobLike(value);
const isResponseLike = (value) => value != null && typeof value === "object" && typeof value.url === "string" && typeof value.blob === "function";
/**
* Helper for creating a {@link File} to pass to an SDK upload method from a variety of different data formats
* @param value the raw content of the file. Can be an {@link Uploadable}, BlobLikePart, or AsyncIterable of BlobLikeParts
* @param {string=} name the name of the file. If omitted, toFile will try to determine a file name from bits if possible
* @param {Object=} options additional properties
* @param {string=} options.type the MIME type of the content
* @param {number=} options.lastModified the last modified timestamp
* @returns a {@link File} with the given properties
*/
async function toFile(value, name, options) {
	checkFileSupport();
	value = await value;
	name || (name = getName(value, true));
	if (isFileLike(value)) {
		if (value instanceof File && name == null && options == null) return value;
		return makeFile([await value.arrayBuffer()], name ?? value.name, {
			type: value.type,
			lastModified: value.lastModified,
			...options
		});
	}
	if (isResponseLike(value)) {
		const blob = await value.blob();
		name || (name = new URL(value.url).pathname.split(/[\\/]/).pop());
		return makeFile(await getBytes(blob), name, options);
	}
	const parts = await getBytes(value);
	if (!options?.type) {
		const type = parts.find((part) => typeof part === "object" && "type" in part && part.type);
		if (typeof type === "string") options = {
			...options,
			type
		};
	}
	return makeFile(parts, name, options);
}
async function getBytes(value) {
	let parts = [];
	if (typeof value === "string" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) parts.push(value);
	else if (isBlobLike(value)) parts.push(value instanceof Blob ? value : await value.arrayBuffer());
	else if (isAsyncIterable(value)) for await (const chunk of value) parts.push(...await getBytes(chunk));
	else {
		const constructor = value?.constructor?.name;
		throw new Error(`Unexpected data type: ${typeof value}${constructor ? `; constructor: ${constructor}` : ""}${propsForError(value)}`);
	}
	return parts;
}
function propsForError(value) {
	if (typeof value !== "object" || value === null) return "";
	return `; props: [${Object.getOwnPropertyNames(value).map((p) => `"${p}"`).join(", ")}]`;
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/core/resource.mjs
var APIResource = class {
	constructor(client) {
		this._client = client;
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/headers.mjs
const brand_privateNullableHeaders = Symbol.for("brand.privateNullableHeaders");
function* iterateHeaders(headers) {
	if (!headers) return;
	if (brand_privateNullableHeaders in headers) {
		const { values, nulls } = headers;
		yield* values.entries();
		for (const name of nulls) yield [name, null];
		return;
	}
	let shouldClear = false;
	let iter;
	if (headers instanceof Headers) iter = headers.entries();
	else if (isReadonlyArray(headers)) iter = headers;
	else {
		shouldClear = true;
		iter = Object.entries(headers ?? {});
	}
	for (let row of iter) {
		const name = row[0];
		if (typeof name !== "string") throw new TypeError("expected header name to be a string");
		const values = isReadonlyArray(row[1]) ? row[1] : [row[1]];
		let didClear = false;
		for (const value of values) {
			if (value === void 0) continue;
			if (shouldClear && !didClear) {
				didClear = true;
				yield [name, null];
			}
			yield [name, value];
		}
	}
}
const buildHeaders = (newHeaders) => {
	const targetHeaders = new Headers();
	const nullHeaders = /* @__PURE__ */ new Set();
	for (const headers of newHeaders) {
		const seenHeaders = /* @__PURE__ */ new Set();
		for (const [name, value] of iterateHeaders(headers)) {
			const lowerName = name.toLowerCase();
			if (!seenHeaders.has(lowerName)) {
				targetHeaders.delete(name);
				seenHeaders.add(lowerName);
			}
			if (value === null) {
				targetHeaders.delete(name);
				nullHeaders.add(lowerName);
			} else {
				targetHeaders.append(name, value);
				nullHeaders.delete(lowerName);
			}
		}
	}
	return {
		[brand_privateNullableHeaders]: true,
		values: targetHeaders,
		nulls: nullHeaders
	};
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/path.mjs
/**
* Percent-encode everything that isn't safe to have in a path without encoding safe chars.
*
* Taken from https://datatracker.ietf.org/doc/html/rfc3986#section-3.3:
* > unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
* > sub-delims  = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
* > pchar       = unreserved / pct-encoded / sub-delims / ":" / "@"
*/
function encodeURIPath(str) {
	return str.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@]+/g, encodeURIComponent);
}
const EMPTY = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
const createPathTagFunction = (pathEncoder = encodeURIPath) => function path(statics, ...params) {
	if (statics.length === 1) return statics[0];
	let postPath = false;
	const invalidSegments = [];
	const path = statics.reduce((previousValue, currentValue, index) => {
		if (/[?#]/.test(currentValue)) postPath = true;
		const value = params[index];
		let encoded = (postPath ? encodeURIComponent : pathEncoder)("" + value);
		if (index !== params.length && (value == null || typeof value === "object" && value.toString === Object.getPrototypeOf(Object.getPrototypeOf(value.hasOwnProperty ?? EMPTY) ?? EMPTY)?.toString)) {
			encoded = value + "";
			invalidSegments.push({
				start: previousValue.length + currentValue.length,
				length: encoded.length,
				error: `Value of type ${Object.prototype.toString.call(value).slice(8, -1)} is not a valid path parameter`
			});
		}
		return previousValue + currentValue + (index === params.length ? "" : encoded);
	}, "");
	const pathOnly = path.split(/[?#]/, 1)[0];
	const invalidSegmentPattern = /(?<=^|\/)(?:\.|%2e){1,2}(?=\/|$)/gi;
	let match;
	while ((match = invalidSegmentPattern.exec(pathOnly)) !== null) invalidSegments.push({
		start: match.index,
		length: match[0].length,
		error: `Value "${match[0]}" can\'t be safely passed as a path parameter`
	});
	invalidSegments.sort((a, b) => a.start - b.start);
	if (invalidSegments.length > 0) {
		let lastEnd = 0;
		const underline = invalidSegments.reduce((acc, segment) => {
			const spaces = " ".repeat(segment.start - lastEnd);
			const arrows = "^".repeat(segment.length);
			lastEnd = segment.start + segment.length;
			return acc + spaces + arrows;
		}, "");
		throw new AnthropicError(`Path parameters result in path with invalid segments:\n${invalidSegments.map((e) => e.error).join("\n")}\n${path}\n${underline}`);
	}
	return path;
};
/**
* URI-encodes path params and ensures no unsafe /./ or /../ path segments are introduced.
*/
const path = /* @__PURE__ */ createPathTagFunction(encodeURIPath);
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/environments.mjs
var Environments = class extends APIResource {
	/**
	* Create a new environment with the specified configuration.
	*
	* @example
	* ```ts
	* const betaEnvironment =
	*   await client.beta.environments.create({
	*     name: 'python-data-analysis',
	*   });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/environments?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Retrieve a specific environment by ID.
	*
	* @example
	* ```ts
	* const betaEnvironment =
	*   await client.beta.environments.retrieve(
	*     'env_011CZkZ9X2dpNyB7HsEFoRfW',
	*   );
	* ```
	*/
	retrieve(environmentID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/environments/${environmentID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update an existing environment's configuration.
	*
	* @example
	* ```ts
	* const betaEnvironment =
	*   await client.beta.environments.update(
	*     'env_011CZkZ9X2dpNyB7HsEFoRfW',
	*   );
	* ```
	*/
	update(environmentID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/environments/${environmentID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List environments with pagination support.
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaEnvironment of client.beta.environments.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/environments?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Delete an environment by ID. Returns a confirmation of the deletion.
	*
	* @example
	* ```ts
	* const betaEnvironmentDeleteResponse =
	*   await client.beta.environments.delete(
	*     'env_011CZkZ9X2dpNyB7HsEFoRfW',
	*   );
	* ```
	*/
	delete(environmentID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/environments/${environmentID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Archive an environment by ID. Archived environments cannot be used to create new
	* sessions.
	*
	* @example
	* ```ts
	* const betaEnvironment =
	*   await client.beta.environments.archive(
	*     'env_011CZkZ9X2dpNyB7HsEFoRfW',
	*   );
	* ```
	*/
	archive(environmentID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/environments/${environmentID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/stainless-helper-header.mjs
/**
* Shared utilities for tracking SDK helper usage.
*/
/**
* Symbol used to mark objects created by SDK helpers for tracking.
* The value is the helper name (e.g., 'mcpTool', 'betaZodTool').
*/
const SDK_HELPER_SYMBOL = Symbol("anthropic.sdk.stainlessHelper");
function wasCreatedByStainlessHelper(value) {
	return typeof value === "object" && value !== null && SDK_HELPER_SYMBOL in value;
}
/**
* Collects helper names from tools and messages arrays.
* Returns a deduplicated array of helper names found.
*/
function collectStainlessHelpers(tools, messages) {
	const helpers = /* @__PURE__ */ new Set();
	if (tools) {
		for (const tool of tools) if (wasCreatedByStainlessHelper(tool)) helpers.add(tool[SDK_HELPER_SYMBOL]);
	}
	if (messages) for (const message of messages) {
		if (wasCreatedByStainlessHelper(message)) helpers.add(message[SDK_HELPER_SYMBOL]);
		if (Array.isArray(message.content)) {
			for (const block of message.content) if (wasCreatedByStainlessHelper(block)) helpers.add(block[SDK_HELPER_SYMBOL]);
		}
	}
	return Array.from(helpers);
}
/**
* Builds x-stainless-helper header value from tools and messages.
* Returns an empty object if no helpers are found.
*/
function stainlessHelperHeader(tools, messages) {
	const helpers = collectStainlessHelpers(tools, messages);
	if (helpers.length === 0) return {};
	return { "x-stainless-helper": helpers.join(", ") };
}
/**
* Builds x-stainless-helper header value from a file object.
* Returns an empty object if the file is not marked with a helper.
*/
function stainlessHelperHeaderFromFile(file) {
	if (wasCreatedByStainlessHelper(file)) return { "x-stainless-helper": file[SDK_HELPER_SYMBOL] };
	return {};
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/files.mjs
var Files = class extends APIResource {
	/**
	* List Files
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const fileMetadata of client.beta.files.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/files?beta=true", Page, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() }, options?.headers])
		});
	}
	/**
	* Delete File
	*
	* @example
	* ```ts
	* const deletedFile = await client.beta.files.delete(
	*   'file_id',
	* );
	* ```
	*/
	delete(fileID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/files/${fileID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() }, options?.headers])
		});
	}
	/**
	* Download File
	*
	* @example
	* ```ts
	* const response = await client.beta.files.download(
	*   'file_id',
	* );
	*
	* const content = await response.blob();
	* console.log(content);
	* ```
	*/
	download(fileID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/files/${fileID}/content?beta=true`, {
			...options,
			headers: buildHeaders([{
				"anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString(),
				Accept: "application/binary"
			}, options?.headers]),
			__binaryResponse: true
		});
	}
	/**
	* Get File Metadata
	*
	* @example
	* ```ts
	* const fileMetadata =
	*   await client.beta.files.retrieveMetadata('file_id');
	* ```
	*/
	retrieveMetadata(fileID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/files/${fileID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() }, options?.headers])
		});
	}
	/**
	* Upload File
	*
	* @example
	* ```ts
	* const fileMetadata = await client.beta.files.upload({
	*   file: fs.createReadStream('path/to/file'),
	* });
	* ```
	*/
	upload(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/files?beta=true", multipartFormRequestOptions({
			body,
			...options,
			headers: buildHeaders([
				{ "anthropic-beta": [...betas ?? [], "files-api-2025-04-14"].toString() },
				stainlessHelperHeaderFromFile(body.file),
				options?.headers
			])
		}, this._client));
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/models.mjs
var Models$1 = class extends APIResource {
	/**
	* Get a specific model.
	*
	* The Models API response can be used to determine information about a specific
	* model or resolve a model alias to a model ID.
	*
	* @example
	* ```ts
	* const betaModelInfo = await client.beta.models.retrieve(
	*   'model_id',
	* );
	* ```
	*/
	retrieve(modelID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/models/${modelID}?beta=true`, {
			...options,
			headers: buildHeaders([{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 }, options?.headers])
		});
	}
	/**
	* List available models.
	*
	* The Models API response can be used to determine which models are available for
	* use in the API. More recently released models are listed first.
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaModelInfo of client.beta.models.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/models?beta=true", Page, {
			query,
			...options,
			headers: buildHeaders([{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/user-profiles.mjs
var UserProfiles = class extends APIResource {
	/**
	* Create User Profile
	*
	* @example
	* ```ts
	* const betaUserProfile =
	*   await client.beta.userProfiles.create();
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/user_profiles?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() }, options?.headers])
		});
	}
	/**
	* Get User Profile
	*
	* @example
	* ```ts
	* const betaUserProfile =
	*   await client.beta.userProfiles.retrieve(
	*     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
	*   );
	* ```
	*/
	retrieve(userProfileID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/user_profiles/${userProfileID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() }, options?.headers])
		});
	}
	/**
	* Update User Profile
	*
	* @example
	* ```ts
	* const betaUserProfile =
	*   await client.beta.userProfiles.update(
	*     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
	*   );
	* ```
	*/
	update(userProfileID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/user_profiles/${userProfileID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() }, options?.headers])
		});
	}
	/**
	* List User Profiles
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaUserProfile of client.beta.userProfiles.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/user_profiles?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() }, options?.headers])
		});
	}
	/**
	* Create Enrollment URL
	*
	* @example
	* ```ts
	* const betaUserProfileEnrollmentURL =
	*   await client.beta.userProfiles.createEnrollmentURL(
	*     'uprof_011CZkZCu8hGbp5mYRQgUmz9',
	*   );
	* ```
	*/
	createEnrollmentURL(userProfileID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/user_profiles/${userProfileID}/enrollment_url?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "user-profiles-2026-03-24"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/agents/versions.mjs
var Versions$1 = class extends APIResource {
	/**
	* List Agent Versions
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsAgent of client.beta.agents.versions.list(
	*   'agent_011CZkYpogX7uDKUyvBTophP',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(agentID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/agents/${agentID}/versions?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/agents/agents.mjs
var Agents = class extends APIResource {
	constructor() {
		super(...arguments);
		this.versions = new Versions$1(this._client);
	}
	/**
	* Create Agent
	*
	* @example
	* ```ts
	* const betaManagedAgentsAgent =
	*   await client.beta.agents.create({
	*     model: 'claude-sonnet-4-6',
	*     name: 'My First Agent',
	*   });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/agents?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Get Agent
	*
	* @example
	* ```ts
	* const betaManagedAgentsAgent =
	*   await client.beta.agents.retrieve(
	*     'agent_011CZkYpogX7uDKUyvBTophP',
	*   );
	* ```
	*/
	retrieve(agentID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.get(path`/v1/agents/${agentID}?beta=true`, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update Agent
	*
	* @example
	* ```ts
	* const betaManagedAgentsAgent =
	*   await client.beta.agents.update(
	*     'agent_011CZkYpogX7uDKUyvBTophP',
	*     { version: 1 },
	*   );
	* ```
	*/
	update(agentID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/agents/${agentID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List Agents
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsAgent of client.beta.agents.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/agents?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Archive Agent
	*
	* @example
	* ```ts
	* const betaManagedAgentsAgent =
	*   await client.beta.agents.archive(
	*     'agent_011CZkYpogX7uDKUyvBTophP',
	*   );
	* ```
	*/
	archive(agentID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/agents/${agentID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
Agents.Versions = Versions$1;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memories.mjs
var Memories = class extends APIResource {
	/**
	* CreateMemory
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemory =
	*   await client.beta.memoryStores.memories.create(
	*     'memory_store_id',
	*     { content: 'content', path: 'xx' },
	*   );
	* ```
	*/
	create(memoryStoreID, params, options) {
		const { view, betas, ...body } = params;
		return this._client.post(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, {
			query: { view },
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* GetMemory
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemory =
	*   await client.beta.memoryStores.memories.retrieve(
	*     'memory_id',
	*     { memory_store_id: 'memory_store_id' },
	*   );
	* ```
	*/
	retrieve(memoryID, params, options) {
		const { memory_store_id, betas, ...query } = params;
		return this._client.get(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* UpdateMemory
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemory =
	*   await client.beta.memoryStores.memories.update(
	*     'memory_id',
	*     { memory_store_id: 'memory_store_id' },
	*   );
	* ```
	*/
	update(memoryID, params, options) {
		const { memory_store_id, view, betas, ...body } = params;
		return this._client.post(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
			query: { view },
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* ListMemories
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsMemoryListItem of client.beta.memoryStores.memories.list(
	*   'memory_store_id',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(memoryStoreID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memories?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* DeleteMemory
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeletedMemory =
	*   await client.beta.memoryStores.memories.delete(
	*     'memory_id',
	*     { memory_store_id: 'memory_store_id' },
	*   );
	* ```
	*/
	delete(memoryID, params, options) {
		const { memory_store_id, expected_content_sha256, betas } = params;
		return this._client.delete(path`/v1/memory_stores/${memory_store_id}/memories/${memoryID}?beta=true`, {
			query: { expected_content_sha256 },
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-versions.mjs
var MemoryVersions = class extends APIResource {
	/**
	* GetMemoryVersion
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryVersion =
	*   await client.beta.memoryStores.memoryVersions.retrieve(
	*     'memory_version_id',
	*     { memory_store_id: 'memory_store_id' },
	*   );
	* ```
	*/
	retrieve(memoryVersionID, params, options) {
		const { memory_store_id, betas, ...query } = params;
		return this._client.get(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}?beta=true`, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* ListMemoryVersions
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsMemoryVersion of client.beta.memoryStores.memoryVersions.list(
	*   'memory_store_id',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(memoryStoreID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/memory_stores/${memoryStoreID}/memory_versions?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* RedactMemoryVersion
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryVersion =
	*   await client.beta.memoryStores.memoryVersions.redact(
	*     'memory_version_id',
	*     { memory_store_id: 'memory_store_id' },
	*   );
	* ```
	*/
	redact(memoryVersionID, params, options) {
		const { memory_store_id, betas } = params;
		return this._client.post(path`/v1/memory_stores/${memory_store_id}/memory_versions/${memoryVersionID}/redact?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/memory-stores/memory-stores.mjs
var MemoryStores = class extends APIResource {
	constructor() {
		super(...arguments);
		this.memories = new Memories(this._client);
		this.memoryVersions = new MemoryVersions(this._client);
	}
	/**
	* CreateMemoryStore
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryStore =
	*   await client.beta.memoryStores.create({ name: 'x' });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/memory_stores?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* GetMemoryStore
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryStore =
	*   await client.beta.memoryStores.retrieve(
	*     'memory_store_id',
	*   );
	* ```
	*/
	retrieve(memoryStoreID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* UpdateMemoryStore
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryStore =
	*   await client.beta.memoryStores.update('memory_store_id');
	* ```
	*/
	update(memoryStoreID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* ListMemoryStores
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsMemoryStore of client.beta.memoryStores.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/memory_stores?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* DeleteMemoryStore
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeletedMemoryStore =
	*   await client.beta.memoryStores.delete('memory_store_id');
	* ```
	*/
	delete(memoryStoreID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/memory_stores/${memoryStoreID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* ArchiveMemoryStore
	*
	* @example
	* ```ts
	* const betaManagedAgentsMemoryStore =
	*   await client.beta.memoryStores.archive('memory_store_id');
	* ```
	*/
	archive(memoryStoreID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/memory_stores/${memoryStoreID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
MemoryStores.Memories = Memories;
MemoryStores.MemoryVersions = MemoryVersions;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/constants.mjs
/**
* Model-specific timeout constraints for non-streaming requests
*/
const MODEL_NONSTREAMING_TOKENS = {
	"claude-opus-4-20250514": 8192,
	"claude-opus-4-0": 8192,
	"claude-4-opus-20250514": 8192,
	"anthropic.claude-opus-4-20250514-v1:0": 8192,
	"claude-opus-4@20250514": 8192,
	"claude-opus-4-1-20250805": 8192,
	"anthropic.claude-opus-4-1-20250805-v1:0": 8192,
	"claude-opus-4-1@20250805": 8192
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/beta-parser.mjs
function getOutputFormat$1(params) {
	return params?.output_format ?? params?.output_config?.format;
}
function maybeParseBetaMessage(message, params, opts) {
	const outputFormat = getOutputFormat$1(params);
	if (!params || !("parse" in (outputFormat ?? {}))) return {
		...message,
		content: message.content.map((block) => {
			if (block.type === "text") {
				const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
					value: null,
					enumerable: false
				});
				return Object.defineProperty(parsedBlock, "parsed", {
					get() {
						opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
						return null;
					},
					enumerable: false
				});
			}
			return block;
		}),
		parsed_output: null
	};
	return parseBetaMessage(message, params, opts);
}
function parseBetaMessage(message, params, opts) {
	let firstParsedOutput = null;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const parsedOutput = parseBetaOutputFormat(params, block.text);
			if (firstParsedOutput === null) firstParsedOutput = parsedOutput;
			const parsedBlock = Object.defineProperty({ ...block }, "parsed_output", {
				value: parsedOutput,
				enumerable: false
			});
			return Object.defineProperty(parsedBlock, "parsed", {
				get() {
					opts.logger.warn("The `parsed` property on `text` blocks is deprecated, please use `parsed_output` instead.");
					return parsedOutput;
				},
				enumerable: false
			});
		}
		return block;
	});
	return {
		...message,
		content,
		parsed_output: firstParsedOutput
	};
}
function parseBetaOutputFormat(params, content) {
	const outputFormat = getOutputFormat$1(params);
	if (outputFormat?.type !== "json_schema") return null;
	try {
		if ("parse" in outputFormat) return outputFormat.parse(content);
		return JSON.parse(content);
	} catch (error) {
		throw new AnthropicError(`Failed to parse structured output: ${error}`);
	}
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs
const tokenize = (input) => {
	let current = 0;
	let tokens = [];
	while (current < input.length) {
		let char = input[current];
		if (char === "\\") {
			current++;
			continue;
		}
		if (char === "{") {
			tokens.push({
				type: "brace",
				value: "{"
			});
			current++;
			continue;
		}
		if (char === "}") {
			tokens.push({
				type: "brace",
				value: "}"
			});
			current++;
			continue;
		}
		if (char === "[") {
			tokens.push({
				type: "paren",
				value: "["
			});
			current++;
			continue;
		}
		if (char === "]") {
			tokens.push({
				type: "paren",
				value: "]"
			});
			current++;
			continue;
		}
		if (char === ":") {
			tokens.push({
				type: "separator",
				value: ":"
			});
			current++;
			continue;
		}
		if (char === ",") {
			tokens.push({
				type: "delimiter",
				value: ","
			});
			current++;
			continue;
		}
		if (char === "\"") {
			let value = "";
			let danglingQuote = false;
			char = input[++current];
			while (char !== "\"") {
				if (current === input.length) {
					danglingQuote = true;
					break;
				}
				if (char === "\\") {
					current++;
					if (current === input.length) {
						danglingQuote = true;
						break;
					}
					value += char + input[current];
					char = input[++current];
				} else {
					value += char;
					char = input[++current];
				}
			}
			char = input[++current];
			if (!danglingQuote) tokens.push({
				type: "string",
				value
			});
			continue;
		}
		if (char && /\s/.test(char)) {
			current++;
			continue;
		}
		let NUMBERS = /[0-9]/;
		if (char && NUMBERS.test(char) || char === "-" || char === ".") {
			let value = "";
			if (char === "-") {
				value += char;
				char = input[++current];
			}
			while (char && NUMBERS.test(char) || char === ".") {
				value += char;
				char = input[++current];
			}
			tokens.push({
				type: "number",
				value
			});
			continue;
		}
		let LETTERS = /[a-z]/i;
		if (char && LETTERS.test(char)) {
			let value = "";
			while (char && LETTERS.test(char)) {
				if (current === input.length) break;
				value += char;
				char = input[++current];
			}
			if (value == "true" || value == "false" || value === "null") tokens.push({
				type: "name",
				value
			});
			else {
				current++;
				continue;
			}
			continue;
		}
		current++;
	}
	return tokens;
};
const strip = (tokens) => {
	if (tokens.length === 0) return tokens;
	let lastToken = tokens[tokens.length - 1];
	switch (lastToken.type) {
		case "separator":
			tokens = tokens.slice(0, tokens.length - 1);
			return strip(tokens);
		case "number":
			let lastCharacterOfLastToken = lastToken.value[lastToken.value.length - 1];
			if (lastCharacterOfLastToken === "." || lastCharacterOfLastToken === "-") {
				tokens = tokens.slice(0, tokens.length - 1);
				return strip(tokens);
			}
		case "string":
			let tokenBeforeTheLastToken = tokens[tokens.length - 2];
			if (tokenBeforeTheLastToken?.type === "delimiter") {
				tokens = tokens.slice(0, tokens.length - 1);
				return strip(tokens);
			} else if (tokenBeforeTheLastToken?.type === "brace" && tokenBeforeTheLastToken.value === "{") {
				tokens = tokens.slice(0, tokens.length - 1);
				return strip(tokens);
			}
			break;
		case "delimiter":
			tokens = tokens.slice(0, tokens.length - 1);
			return strip(tokens);
	}
	return tokens;
};
const unstrip = (tokens) => {
	let tail = [];
	tokens.map((token) => {
		if (token.type === "brace") {
			if (token.value === "{") tail.push("}");
			else tail.splice(tail.lastIndexOf("}"), 1);
		}
		if (token.type === "paren") {
			if (token.value === "[") tail.push("]");
			else tail.splice(tail.lastIndexOf("]"), 1);
		}
	});
	if (tail.length > 0) tail.reverse().map((item) => {
		if (item === "}") tokens.push({
			type: "brace",
			value: "}"
		});
		else if (item === "]") tokens.push({
			type: "paren",
			value: "]"
		});
	});
	return tokens;
};
const generate = (tokens) => {
	let output = "";
	tokens.map((token) => {
		switch (token.type) {
			case "string":
				output += "\"" + token.value + "\"";
				break;
			default: output += token.value;
		}
	});
	return output;
};
const partialParse = (input) => JSON.parse(generate(unstrip(strip(tokenize(input)))));
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/BetaMessageStream.mjs
var _BetaMessageStream_instances;
var _BetaMessageStream_currentMessageSnapshot;
var _BetaMessageStream_params;
var _BetaMessageStream_connectedPromise;
var _BetaMessageStream_resolveConnectedPromise;
var _BetaMessageStream_rejectConnectedPromise;
var _BetaMessageStream_endPromise;
var _BetaMessageStream_resolveEndPromise;
var _BetaMessageStream_rejectEndPromise;
var _BetaMessageStream_listeners;
var _BetaMessageStream_ended;
var _BetaMessageStream_errored;
var _BetaMessageStream_aborted;
var _BetaMessageStream_catchingPromiseCreated;
var _BetaMessageStream_response;
var _BetaMessageStream_request_id;
var _BetaMessageStream_logger;
var _BetaMessageStream_getFinalMessage;
var _BetaMessageStream_getFinalText;
var _BetaMessageStream_handleError;
var _BetaMessageStream_beginRequest;
var _BetaMessageStream_addStreamEvent;
var _BetaMessageStream_endRequest;
var _BetaMessageStream_accumulateMessage;
const JSON_BUF_PROPERTY$1 = "__json_buf";
function tracksToolInput$1(content) {
	return content.type === "tool_use" || content.type === "server_tool_use" || content.type === "mcp_tool_use";
}
var BetaMessageStream = class BetaMessageStream {
	constructor(params, opts) {
		_BetaMessageStream_instances.add(this);
		this.messages = [];
		this.receivedMessages = [];
		_BetaMessageStream_currentMessageSnapshot.set(this, void 0);
		_BetaMessageStream_params.set(this, null);
		this.controller = new AbortController();
		_BetaMessageStream_connectedPromise.set(this, void 0);
		_BetaMessageStream_resolveConnectedPromise.set(this, () => {});
		_BetaMessageStream_rejectConnectedPromise.set(this, () => {});
		_BetaMessageStream_endPromise.set(this, void 0);
		_BetaMessageStream_resolveEndPromise.set(this, () => {});
		_BetaMessageStream_rejectEndPromise.set(this, () => {});
		_BetaMessageStream_listeners.set(this, {});
		_BetaMessageStream_ended.set(this, false);
		_BetaMessageStream_errored.set(this, false);
		_BetaMessageStream_aborted.set(this, false);
		_BetaMessageStream_catchingPromiseCreated.set(this, false);
		_BetaMessageStream_response.set(this, void 0);
		_BetaMessageStream_request_id.set(this, void 0);
		_BetaMessageStream_logger.set(this, void 0);
		_BetaMessageStream_handleError.set(this, (error) => {
			__classPrivateFieldSet(this, _BetaMessageStream_errored, true, "f");
			if (isAbortError(error)) error = new APIUserAbortError();
			if (error instanceof APIUserAbortError) {
				__classPrivateFieldSet(this, _BetaMessageStream_aborted, true, "f");
				return this._emit("abort", error);
			}
			if (error instanceof AnthropicError) return this._emit("error", error);
			if (error instanceof Error) {
				const anthropicError = new AnthropicError(error.message);
				anthropicError.cause = error;
				return this._emit("error", anthropicError);
			}
			return this._emit("error", new AnthropicError(String(error)));
		});
		__classPrivateFieldSet(this, _BetaMessageStream_connectedPromise, new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _BetaMessageStream_resolveConnectedPromise, resolve, "f");
			__classPrivateFieldSet(this, _BetaMessageStream_rejectConnectedPromise, reject, "f");
		}), "f");
		__classPrivateFieldSet(this, _BetaMessageStream_endPromise, new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _BetaMessageStream_resolveEndPromise, resolve, "f");
			__classPrivateFieldSet(this, _BetaMessageStream_rejectEndPromise, reject, "f");
		}), "f");
		__classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f").catch(() => {});
		__classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f").catch(() => {});
		__classPrivateFieldSet(this, _BetaMessageStream_params, params, "f");
		__classPrivateFieldSet(this, _BetaMessageStream_logger, opts?.logger ?? console, "f");
	}
	get response() {
		return __classPrivateFieldGet(this, _BetaMessageStream_response, "f");
	}
	get request_id() {
		return __classPrivateFieldGet(this, _BetaMessageStream_request_id, "f");
	}
	/**
	* Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
	* returned vie the `request-id` header which is useful for debugging requests and resporting
	* issues to Anthropic.
	*
	* This is the same as the `APIPromise.withResponse()` method.
	*
	* This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
	* as no `Response` is available.
	*/
	async withResponse() {
		__classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
		const response = await __classPrivateFieldGet(this, _BetaMessageStream_connectedPromise, "f");
		if (!response) throw new Error("Could not resolve a `Response` object");
		return {
			data: this,
			response,
			request_id: response.headers.get("request-id")
		};
	}
	/**
	* Intended for use on the frontend, consuming a stream produced with
	* `.toReadableStream()` on the backend.
	*
	* Note that messages sent to the model do not appear in `.on('message')`
	* in this context.
	*/
	static fromReadableStream(stream) {
		const runner = new BetaMessageStream(null);
		runner._run(() => runner._fromReadableStream(stream));
		return runner;
	}
	static createMessage(messages, params, options, { logger } = {}) {
		const runner = new BetaMessageStream(params, { logger });
		for (const message of params.messages) runner._addMessageParam(message);
		__classPrivateFieldSet(runner, _BetaMessageStream_params, {
			...params,
			stream: true
		}, "f");
		runner._run(() => runner._createMessage(messages, {
			...params,
			stream: true
		}, {
			...options,
			headers: {
				...options?.headers,
				"X-Stainless-Helper-Method": "stream"
			}
		}));
		return runner;
	}
	_run(executor) {
		executor().then(() => {
			this._emitFinal();
			this._emit("end");
		}, __classPrivateFieldGet(this, _BetaMessageStream_handleError, "f"));
	}
	_addMessageParam(message) {
		this.messages.push(message);
	}
	_addMessage(message, emit = true) {
		this.receivedMessages.push(message);
		if (emit) this._emit("message", message);
	}
	async _createMessage(messages, params, options) {
		const signal = options?.signal;
		let abortHandler;
		if (signal) {
			if (signal.aborted) this.controller.abort();
			abortHandler = this.controller.abort.bind(this.controller);
			signal.addEventListener("abort", abortHandler);
		}
		try {
			__classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
			const { response, data: stream } = await messages.create({
				...params,
				stream: true
			}, {
				...options,
				signal: this.controller.signal
			}).withResponse();
			this._connected(response);
			for await (const event of stream) __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
			if (stream.controller.signal?.aborted) throw new APIUserAbortError();
			__classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		}
	}
	_connected(response) {
		if (this.ended) return;
		__classPrivateFieldSet(this, _BetaMessageStream_response, response, "f");
		__classPrivateFieldSet(this, _BetaMessageStream_request_id, response?.headers.get("request-id"), "f");
		__classPrivateFieldGet(this, _BetaMessageStream_resolveConnectedPromise, "f").call(this, response);
		this._emit("connect");
	}
	get ended() {
		return __classPrivateFieldGet(this, _BetaMessageStream_ended, "f");
	}
	get errored() {
		return __classPrivateFieldGet(this, _BetaMessageStream_errored, "f");
	}
	get aborted() {
		return __classPrivateFieldGet(this, _BetaMessageStream_aborted, "f");
	}
	abort() {
		this.controller.abort();
	}
	/**
	* Adds the listener function to the end of the listeners array for the event.
	* No checks are made to see if the listener has already been added. Multiple calls passing
	* the same combination of event and listener will result in the listener being added, and
	* called, multiple times.
	* @returns this MessageStream, so that calls can be chained
	*/
	on(event, listener) {
		(__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = [])).push({ listener });
		return this;
	}
	/**
	* Removes the specified listener from the listener array for the event.
	* off() will remove, at most, one instance of a listener from the listener array. If any single
	* listener has been added multiple times to the listener array for the specified event, then
	* off() must be called multiple times to remove each instance.
	* @returns this MessageStream, so that calls can be chained
	*/
	off(event, listener) {
		const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
		if (!listeners) return this;
		const index = listeners.findIndex((l) => l.listener === listener);
		if (index >= 0) listeners.splice(index, 1);
		return this;
	}
	/**
	* Adds a one-time listener function for the event. The next time the event is triggered,
	* this listener is removed and then invoked.
	* @returns this MessageStream, so that calls can be chained
	*/
	once(event, listener) {
		(__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = [])).push({
			listener,
			once: true
		});
		return this;
	}
	/**
	* This is similar to `.once()`, but returns a Promise that resolves the next time
	* the event is triggered, instead of calling a listener callback.
	* @returns a Promise that resolves the next time given event is triggered,
	* or rejects if an error is emitted.  (If you request the 'error' event,
	* returns a promise that resolves with the error).
	*
	* Example:
	*
	*   const message = await stream.emitted('message') // rejects if the stream errors
	*/
	emitted(event) {
		return new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
			if (event !== "error") this.once("error", reject);
			this.once(event, resolve);
		});
	}
	async done() {
		__classPrivateFieldSet(this, _BetaMessageStream_catchingPromiseCreated, true, "f");
		await __classPrivateFieldGet(this, _BetaMessageStream_endPromise, "f");
	}
	get currentMessage() {
		return __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
	}
	/**
	* @returns a promise that resolves with the the final assistant Message response,
	* or rejects if an error occurred or the stream ended prematurely without producing a Message.
	* If structured outputs were used, this will be a ParsedMessage with a `parsed` field.
	*/
	async finalMessage() {
		await this.done();
		return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this);
	}
	/**
	* @returns a promise that resolves with the the final assistant Message's text response, concatenated
	* together if there are more than one text blocks.
	* Rejects if an error occurred or the stream ended prematurely without producing a Message.
	*/
	async finalText() {
		await this.done();
		return __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalText).call(this);
	}
	_emit(event, ...args) {
		if (__classPrivateFieldGet(this, _BetaMessageStream_ended, "f")) return;
		if (event === "end") {
			__classPrivateFieldSet(this, _BetaMessageStream_ended, true, "f");
			__classPrivateFieldGet(this, _BetaMessageStream_resolveEndPromise, "f").call(this);
		}
		const listeners = __classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event];
		if (listeners) {
			__classPrivateFieldGet(this, _BetaMessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
			listeners.forEach(({ listener }) => listener(...args));
		}
		if (event === "abort") {
			const error = args[0];
			if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) Promise.reject(error);
			__classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
			__classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
			this._emit("end");
			return;
		}
		if (event === "error") {
			const error = args[0];
			if (!__classPrivateFieldGet(this, _BetaMessageStream_catchingPromiseCreated, "f") && !listeners?.length) Promise.reject(error);
			__classPrivateFieldGet(this, _BetaMessageStream_rejectConnectedPromise, "f").call(this, error);
			__classPrivateFieldGet(this, _BetaMessageStream_rejectEndPromise, "f").call(this, error);
			this._emit("end");
		}
	}
	_emitFinal() {
		if (this.receivedMessages.at(-1)) this._emit("finalMessage", __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_getFinalMessage).call(this));
	}
	async _fromReadableStream(readableStream, options) {
		const signal = options?.signal;
		let abortHandler;
		if (signal) {
			if (signal.aborted) this.controller.abort();
			abortHandler = this.controller.abort.bind(this.controller);
			signal.addEventListener("abort", abortHandler);
		}
		try {
			__classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_beginRequest).call(this);
			this._connected(null);
			const stream = Stream.fromReadableStream(readableStream, this.controller);
			for await (const event of stream) __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_addStreamEvent).call(this, event);
			if (stream.controller.signal?.aborted) throw new APIUserAbortError();
			__classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_endRequest).call(this);
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		}
	}
	[(_BetaMessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_params = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_listeners = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_ended = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_errored = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_aborted = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_response = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_request_id = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_logger = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_handleError = /* @__PURE__ */ new WeakMap(), _BetaMessageStream_instances = /* @__PURE__ */ new WeakSet(), _BetaMessageStream_getFinalMessage = function _BetaMessageStream_getFinalMessage() {
		if (this.receivedMessages.length === 0) throw new AnthropicError("stream ended without producing a Message with role=assistant");
		return this.receivedMessages.at(-1);
	}, _BetaMessageStream_getFinalText = function _BetaMessageStream_getFinalText() {
		if (this.receivedMessages.length === 0) throw new AnthropicError("stream ended without producing a Message with role=assistant");
		const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
		if (textBlocks.length === 0) throw new AnthropicError("stream ended without producing a content block with type=text");
		return textBlocks.join(" ");
	}, _BetaMessageStream_beginRequest = function _BetaMessageStream_beginRequest() {
		if (this.ended) return;
		__classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
	}, _BetaMessageStream_addStreamEvent = function _BetaMessageStream_addStreamEvent(event) {
		if (this.ended) return;
		const messageSnapshot = __classPrivateFieldGet(this, _BetaMessageStream_instances, "m", _BetaMessageStream_accumulateMessage).call(this, event);
		this._emit("streamEvent", event, messageSnapshot);
		switch (event.type) {
			case "content_block_delta": {
				const content = messageSnapshot.content.at(-1);
				switch (event.delta.type) {
					case "text_delta":
						if (content.type === "text") this._emit("text", event.delta.text, content.text || "");
						break;
					case "citations_delta":
						if (content.type === "text") this._emit("citation", event.delta.citation, content.citations ?? []);
						break;
					case "input_json_delta":
						if (tracksToolInput$1(content) && content.input) this._emit("inputJson", event.delta.partial_json, content.input);
						break;
					case "thinking_delta":
						if (content.type === "thinking") this._emit("thinking", event.delta.thinking, content.thinking);
						break;
					case "signature_delta":
						if (content.type === "thinking") this._emit("signature", content.signature);
						break;
					case "compaction_delta":
						if (content.type === "compaction" && content.content) this._emit("compaction", content.content);
						break;
					default: event.delta;
				}
				break;
			}
			case "message_stop":
				this._addMessageParam(messageSnapshot);
				this._addMessage(maybeParseBetaMessage(messageSnapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") }), true);
				break;
			case "content_block_stop":
				this._emit("contentBlock", messageSnapshot.content.at(-1));
				break;
			case "message_start": __classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, messageSnapshot, "f");
		}
	}, _BetaMessageStream_endRequest = function _BetaMessageStream_endRequest() {
		if (this.ended) throw new AnthropicError(`stream has ended, this shouldn't happen`);
		const snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
		if (!snapshot) throw new AnthropicError(`request ended without sending any chunks`);
		__classPrivateFieldSet(this, _BetaMessageStream_currentMessageSnapshot, void 0, "f");
		return maybeParseBetaMessage(snapshot, __classPrivateFieldGet(this, _BetaMessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _BetaMessageStream_logger, "f") });
	}, _BetaMessageStream_accumulateMessage = function _BetaMessageStream_accumulateMessage(event) {
		let snapshot = __classPrivateFieldGet(this, _BetaMessageStream_currentMessageSnapshot, "f");
		if (event.type === "message_start") {
			if (snapshot) throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
			return event.message;
		}
		if (!snapshot) throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
		switch (event.type) {
			case "message_stop": return snapshot;
			case "message_delta":
				snapshot.container = event.delta.container;
				snapshot.stop_reason = event.delta.stop_reason;
				snapshot.stop_sequence = event.delta.stop_sequence;
				snapshot.usage.output_tokens = event.usage.output_tokens;
				snapshot.context_management = event.context_management;
				if (event.usage.input_tokens != null) snapshot.usage.input_tokens = event.usage.input_tokens;
				if (event.usage.cache_creation_input_tokens != null) snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
				if (event.usage.cache_read_input_tokens != null) snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
				if (event.usage.server_tool_use != null) snapshot.usage.server_tool_use = event.usage.server_tool_use;
				if (event.usage.iterations != null) snapshot.usage.iterations = event.usage.iterations;
				return snapshot;
			case "content_block_start":
				snapshot.content.push(event.content_block);
				return snapshot;
			case "content_block_delta": {
				const snapshotContent = snapshot.content.at(event.index);
				switch (event.delta.type) {
					case "text_delta":
						if (snapshotContent?.type === "text") snapshot.content[event.index] = {
							...snapshotContent,
							text: (snapshotContent.text || "") + event.delta.text
						};
						break;
					case "citations_delta":
						if (snapshotContent?.type === "text") snapshot.content[event.index] = {
							...snapshotContent,
							citations: [...snapshotContent.citations ?? [], event.delta.citation]
						};
						break;
					case "input_json_delta":
						if (snapshotContent && tracksToolInput$1(snapshotContent)) {
							let jsonBuf = snapshotContent[JSON_BUF_PROPERTY$1] || "";
							jsonBuf += event.delta.partial_json;
							const newContent = { ...snapshotContent };
							Object.defineProperty(newContent, JSON_BUF_PROPERTY$1, {
								value: jsonBuf,
								enumerable: false,
								writable: true
							});
							if (jsonBuf) try {
								newContent.input = partialParse(jsonBuf);
							} catch (err) {
								const error = new AnthropicError(`Unable to parse tool parameter JSON from model. Please retry your request or adjust your prompt. Error: ${err}. JSON: ${jsonBuf}`);
								__classPrivateFieldGet(this, _BetaMessageStream_handleError, "f").call(this, error);
							}
							snapshot.content[event.index] = newContent;
						}
						break;
					case "thinking_delta":
						if (snapshotContent?.type === "thinking") snapshot.content[event.index] = {
							...snapshotContent,
							thinking: snapshotContent.thinking + event.delta.thinking
						};
						break;
					case "signature_delta":
						if (snapshotContent?.type === "thinking") snapshot.content[event.index] = {
							...snapshotContent,
							signature: event.delta.signature
						};
						break;
					case "compaction_delta":
						if (snapshotContent?.type === "compaction") snapshot.content[event.index] = {
							...snapshotContent,
							content: (snapshotContent.content || "") + event.delta.content
						};
						break;
					default: event.delta;
				}
				return snapshot;
			}
			case "content_block_stop": return snapshot;
		}
	}, Symbol.asyncIterator)]() {
		const pushQueue = [];
		const readQueue = [];
		let done = false;
		this.on("streamEvent", (event) => {
			const reader = readQueue.shift();
			if (reader) reader.resolve(event);
			else pushQueue.push(event);
		});
		this.on("end", () => {
			done = true;
			for (const reader of readQueue) reader.resolve(void 0);
			readQueue.length = 0;
		});
		this.on("abort", (err) => {
			done = true;
			for (const reader of readQueue) reader.reject(err);
			readQueue.length = 0;
		});
		this.on("error", (err) => {
			done = true;
			for (const reader of readQueue) reader.reject(err);
			readQueue.length = 0;
		});
		return {
			next: async () => {
				if (!pushQueue.length) {
					if (done) return {
						value: void 0,
						done: true
					};
					return new Promise((resolve, reject) => readQueue.push({
						resolve,
						reject
					})).then((chunk) => chunk ? {
						value: chunk,
						done: false
					} : {
						value: void 0,
						done: true
					});
				}
				return {
					value: pushQueue.shift(),
					done: false
				};
			},
			return: async () => {
				this.abort();
				return {
					value: void 0,
					done: true
				};
			}
		};
	}
	toReadableStream() {
		return new Stream(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/tools/ToolError.mjs
/**
* An error that can be thrown from a tool's `run` method to return structured
* content blocks as the error result, rather than just a string message.
*
* When the ToolRunner catches this error, it will use the `content` property
* as the tool result with `is_error: true`.
*
* @example
* ```ts
* const tool = {
*   name: 'my_tool',
*   run: async (input) => {
*     if (somethingWentWrong) {
*       throw new ToolError([
*         { type: 'text', text: 'Error details here' },
*         { type: 'image', source: { type: 'base64', data: '...', media_type: 'image/png' } },
*       ]);
*     }
*     return 'success';
*   },
* };
* ```
*/
var ToolError = class extends Error {
	constructor(content) {
		const message = typeof content === "string" ? content : content.map((block) => {
			if (block.type === "text") return block.text;
			return `[${block.type}]`;
		}).join(" ");
		super(message);
		this.name = "ToolError";
		this.content = content;
	}
};
const DEFAULT_SUMMARY_PROMPT = `You have been working on the task described above but have not yet completed it. Write a continuation summary that will allow you (or another instance of yourself) to resume work efficiently in a future context window where the conversation history will be replaced with this summary. Your summary should be structured, concise, and actionable. Include:
1. Task Overview
The user's core request and success criteria
Any clarifications or constraints they specified
2. Current State
What has been completed so far
Files created, modified, or analyzed (with paths if relevant)
Key outputs or artifacts produced
3. Important Discoveries
Technical constraints or requirements uncovered
Decisions made and their rationale
Errors encountered and how they were resolved
What approaches were tried that didn't work (and why)
4. Next Steps
Specific actions needed to complete the task
Any blockers or open questions to resolve
Priority order if multiple steps remain
5. Context to Preserve
User preferences or style requirements
Domain-specific details that aren't obvious
Any promises made to the user
Be concise but complete—err on the side of including information that would prevent duplicate work or repeated mistakes. Write in a way that enables immediate resumption of the task.
Wrap your summary in <summary></summary> tags.`;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/tools/BetaToolRunner.mjs
var _BetaToolRunner_instances;
var _BetaToolRunner_consumed;
var _BetaToolRunner_mutated;
var _BetaToolRunner_state;
var _BetaToolRunner_options;
var _BetaToolRunner_message;
var _BetaToolRunner_toolResponse;
var _BetaToolRunner_completion;
var _BetaToolRunner_iterationCount;
var _BetaToolRunner_checkAndCompact;
var _BetaToolRunner_generateToolResponse;
/**
* Just Promise.withResolvers(), which is not available in all environments.
*/
function promiseWithResolvers() {
	let resolve;
	let reject;
	return {
		promise: new Promise((res, rej) => {
			resolve = res;
			reject = rej;
		}),
		resolve,
		reject
	};
}
/**
* A ToolRunner handles the automatic conversation loop between the assistant and tools.
*
* A ToolRunner is an async iterable that yields either BetaMessage or BetaMessageStream objects
* depending on the streaming configuration.
*/
var BetaToolRunner = class {
	constructor(client, params, options) {
		_BetaToolRunner_instances.add(this);
		this.client = client;
		/** Whether the async iterator has been consumed */
		_BetaToolRunner_consumed.set(this, false);
		/** Whether parameters have been mutated since the last API call */
		_BetaToolRunner_mutated.set(this, false);
		/** Current state containing the request parameters */
		_BetaToolRunner_state.set(this, void 0);
		_BetaToolRunner_options.set(this, void 0);
		/** Promise for the last message received from the assistant */
		_BetaToolRunner_message.set(this, void 0);
		/** Cached tool response to avoid redundant executions */
		_BetaToolRunner_toolResponse.set(this, void 0);
		/** Promise resolvers for waiting on completion */
		_BetaToolRunner_completion.set(this, void 0);
		/** Number of iterations (API requests) made so far */
		_BetaToolRunner_iterationCount.set(this, 0);
		__classPrivateFieldSet(this, _BetaToolRunner_state, { params: {
			...params,
			messages: structuredClone(params.messages)
		} }, "f");
		const helperValue = ["BetaToolRunner", ...collectStainlessHelpers(params.tools, params.messages)].join(", ");
		__classPrivateFieldSet(this, _BetaToolRunner_options, {
			...options,
			headers: buildHeaders([{ "x-stainless-helper": helperValue }, options?.headers])
		}, "f");
		__classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
		if (params.compactionControl?.enabled) console.warn("Anthropic: The `compactionControl` parameter is deprecated and will be removed in a future version. Use server-side compaction instead by passing `edits: [{ type: \"compact_20260112\" }]` in the params passed to `toolRunner()`. See https://platform.claude.com/docs/en/build-with-claude/compaction");
	}
	async *[(_BetaToolRunner_consumed = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_mutated = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_state = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_options = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_message = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_toolResponse = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_completion = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_iterationCount = /* @__PURE__ */ new WeakMap(), _BetaToolRunner_instances = /* @__PURE__ */ new WeakSet(), _BetaToolRunner_checkAndCompact = async function _BetaToolRunner_checkAndCompact() {
		const compactionControl = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.compactionControl;
		if (!compactionControl || !compactionControl.enabled) return false;
		let tokensUsed = 0;
		if (__classPrivateFieldGet(this, _BetaToolRunner_message, "f") !== void 0) try {
			const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
			tokensUsed = message.usage.input_tokens + (message.usage.cache_creation_input_tokens ?? 0) + (message.usage.cache_read_input_tokens ?? 0) + message.usage.output_tokens;
		} catch {
			return false;
		}
		const threshold = compactionControl.contextTokenThreshold ?? 1e5;
		if (tokensUsed < threshold) return false;
		const model = compactionControl.model ?? __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.model;
		const summaryPrompt = compactionControl.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT;
		const messages = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages;
		if (messages[messages.length - 1].role === "assistant") {
			const lastMessage = messages[messages.length - 1];
			if (Array.isArray(lastMessage.content)) {
				const nonToolBlocks = lastMessage.content.filter((block) => block.type !== "tool_use");
				if (nonToolBlocks.length === 0) messages.pop();
				else lastMessage.content = nonToolBlocks;
			}
		}
		const response = await this.client.beta.messages.create({
			model,
			messages: [...messages, {
				role: "user",
				content: [{
					type: "text",
					text: summaryPrompt
				}]
			}],
			max_tokens: __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_tokens
		}, {
			signal: __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal,
			headers: buildHeaders([__classPrivateFieldGet(this, _BetaToolRunner_options, "f").headers, { "x-stainless-helper": "compaction" }])
		});
		if (response.content[0]?.type !== "text") throw new AnthropicError("Expected text response for compaction");
		__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages = [{
			role: "user",
			content: response.content
		}];
		return true;
	}, Symbol.asyncIterator)]() {
		var _a;
		if (__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) throw new AnthropicError("Cannot iterate over a consumed stream");
		__classPrivateFieldSet(this, _BetaToolRunner_consumed, true, "f");
		__classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
		__classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
		try {
			while (true) {
				let stream;
				try {
					if (__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations && __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f") >= __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.max_iterations) break;
					__classPrivateFieldSet(this, _BetaToolRunner_mutated, false, "f");
					__classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
					__classPrivateFieldSet(this, _BetaToolRunner_iterationCount, (_a = __classPrivateFieldGet(this, _BetaToolRunner_iterationCount, "f"), _a++, _a), "f");
					__classPrivateFieldSet(this, _BetaToolRunner_message, void 0, "f");
					const { max_iterations, compactionControl, ...params } = __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
					if (params.stream) {
						stream = this.client.beta.messages.stream({ ...params }, __classPrivateFieldGet(this, _BetaToolRunner_options, "f"));
						__classPrivateFieldSet(this, _BetaToolRunner_message, stream.finalMessage(), "f");
						__classPrivateFieldGet(this, _BetaToolRunner_message, "f").catch(() => {});
						yield stream;
					} else {
						__classPrivateFieldSet(this, _BetaToolRunner_message, this.client.beta.messages.create({
							...params,
							stream: false
						}, __classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
						yield __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
					}
					if (!await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_checkAndCompact).call(this)) {
						if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) {
							const { role, content } = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f");
							__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push({
								role,
								content
							});
						}
						const toolMessage = await __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.at(-1));
						if (toolMessage) __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params.messages.push(toolMessage);
						else if (!__classPrivateFieldGet(this, _BetaToolRunner_mutated, "f")) break;
					}
				} finally {
					if (stream) stream.abort();
				}
			}
			if (!__classPrivateFieldGet(this, _BetaToolRunner_message, "f")) throw new AnthropicError("ToolRunner concluded without a message from the server");
			__classPrivateFieldGet(this, _BetaToolRunner_completion, "f").resolve(await __classPrivateFieldGet(this, _BetaToolRunner_message, "f"));
		} catch (error) {
			__classPrivateFieldSet(this, _BetaToolRunner_consumed, false, "f");
			__classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise.catch(() => {});
			__classPrivateFieldGet(this, _BetaToolRunner_completion, "f").reject(error);
			__classPrivateFieldSet(this, _BetaToolRunner_completion, promiseWithResolvers(), "f");
			throw error;
		}
	}
	setMessagesParams(paramsOrMutator) {
		if (typeof paramsOrMutator === "function") __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params);
		else __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params = paramsOrMutator;
		__classPrivateFieldSet(this, _BetaToolRunner_mutated, true, "f");
		__classPrivateFieldSet(this, _BetaToolRunner_toolResponse, void 0, "f");
	}
	setRequestOptions(optionsOrMutator) {
		if (typeof optionsOrMutator === "function") __classPrivateFieldSet(this, _BetaToolRunner_options, optionsOrMutator(__classPrivateFieldGet(this, _BetaToolRunner_options, "f")), "f");
		else __classPrivateFieldSet(this, _BetaToolRunner_options, {
			...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"),
			...optionsOrMutator
		}, "f");
	}
	/**
	* Get the tool response for the last message from the assistant.
	* Avoids redundant tool executions by caching results.
	*
	* @returns A promise that resolves to a BetaMessageParam containing tool results, or null if no tools need to be executed
	*
	* @example
	* const toolResponse = await runner.generateToolResponse();
	* if (toolResponse) {
	*   console.log('Tool results:', toolResponse.content);
	* }
	*/
	async generateToolResponse(signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
		const message = await __classPrivateFieldGet(this, _BetaToolRunner_message, "f") ?? this.params.messages.at(-1);
		if (!message) return null;
		return __classPrivateFieldGet(this, _BetaToolRunner_instances, "m", _BetaToolRunner_generateToolResponse).call(this, message, signal);
	}
	/**
	* Wait for the async iterator to complete. This works even if the async iterator hasn't yet started, and
	* will wait for an instance to start and go to completion.
	*
	* @returns A promise that resolves to the final BetaMessage when the iterator completes
	*
	* @example
	* // Start consuming the iterator
	* for await (const message of runner) {
	*   console.log('Message:', message.content);
	* }
	*
	* // Meanwhile, wait for completion from another part of the code
	* const finalMessage = await runner.done();
	* console.log('Final response:', finalMessage.content);
	*/
	done() {
		return __classPrivateFieldGet(this, _BetaToolRunner_completion, "f").promise;
	}
	/**
	* Returns a promise indicating that the stream is done. Unlike .done(), this will eagerly read the stream:
	* * If the iterator has not been consumed, consume the entire iterator and return the final message from the
	* assistant.
	* * If the iterator has been consumed, waits for it to complete and returns the final message.
	*
	* @returns A promise that resolves to the final BetaMessage from the conversation
	* @throws {AnthropicError} If no messages were processed during the conversation
	*
	* @example
	* const finalMessage = await runner.runUntilDone();
	* console.log('Final response:', finalMessage.content);
	*/
	async runUntilDone() {
		if (!__classPrivateFieldGet(this, _BetaToolRunner_consumed, "f")) for await (const _ of this);
		return this.done();
	}
	/**
	* Get the current parameters being used by the ToolRunner.
	*
	* @returns A readonly view of the current ToolRunnerParams
	*
	* @example
	* const currentParams = runner.params;
	* console.log('Current model:', currentParams.model);
	* console.log('Message count:', currentParams.messages.length);
	*/
	get params() {
		return __classPrivateFieldGet(this, _BetaToolRunner_state, "f").params;
	}
	/**
	* Add one or more messages to the conversation history.
	*
	* @param messages - One or more BetaMessageParam objects to add to the conversation
	*
	* @example
	* runner.pushMessages(
	*   { role: 'user', content: 'Also, what about the weather in NYC?' }
	* );
	*
	* @example
	* // Adding multiple messages
	* runner.pushMessages(
	*   { role: 'user', content: 'What about NYC?' },
	*   { role: 'user', content: 'And Boston?' }
	* );
	*/
	pushMessages(...messages) {
		this.setMessagesParams((params) => ({
			...params,
			messages: [...params.messages, ...messages]
		}));
	}
	/**
	* Makes the ToolRunner directly awaitable, equivalent to calling .runUntilDone()
	* This allows using `await runner` instead of `await runner.runUntilDone()`
	*/
	then(onfulfilled, onrejected) {
		return this.runUntilDone().then(onfulfilled, onrejected);
	}
};
_BetaToolRunner_generateToolResponse = async function _BetaToolRunner_generateToolResponse(lastMessage, signal = __classPrivateFieldGet(this, _BetaToolRunner_options, "f").signal) {
	if (__classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f") !== void 0) return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
	__classPrivateFieldSet(this, _BetaToolRunner_toolResponse, generateToolResponse(__classPrivateFieldGet(this, _BetaToolRunner_state, "f").params, lastMessage, {
		...__classPrivateFieldGet(this, _BetaToolRunner_options, "f"),
		signal
	}), "f");
	return __classPrivateFieldGet(this, _BetaToolRunner_toolResponse, "f");
};
async function generateToolResponse(params, lastMessage = params.messages.at(-1), requestOptions) {
	if (!lastMessage || lastMessage.role !== "assistant" || !lastMessage.content || typeof lastMessage.content === "string") return null;
	const toolUseBlocks = lastMessage.content.filter((content) => content.type === "tool_use");
	if (toolUseBlocks.length === 0) return null;
	return {
		role: "user",
		content: await Promise.all(toolUseBlocks.map(async (toolUse) => {
			const tool = params.tools.find((t) => ("name" in t ? t.name : t.mcp_server_name) === toolUse.name);
			if (!tool || !("run" in tool)) return {
				type: "tool_result",
				tool_use_id: toolUse.id,
				content: `Error: Tool '${toolUse.name}' not found`,
				is_error: true
			};
			try {
				let input = toolUse.input;
				if ("parse" in tool && tool.parse) input = tool.parse(input);
				const result = await tool.run(input, {
					toolUseBlock: toolUse,
					signal: requestOptions?.signal
				});
				return {
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: result
				};
			} catch (error) {
				return {
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: error instanceof ToolError ? error.content : `Error: ${error instanceof Error ? error.message : String(error)}`,
					is_error: true
				};
			}
		}))
	};
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/decoders/jsonl.mjs
var JSONLDecoder = class JSONLDecoder {
	constructor(iterator, controller) {
		this.iterator = iterator;
		this.controller = controller;
	}
	async *decoder() {
		const lineDecoder = new LineDecoder();
		for await (const chunk of this.iterator) for (const line of lineDecoder.decode(chunk)) yield JSON.parse(line);
		for (const line of lineDecoder.flush()) yield JSON.parse(line);
	}
	[Symbol.asyncIterator]() {
		return this.decoder();
	}
	static fromResponse(response, controller) {
		if (!response.body) {
			controller.abort();
			if (typeof globalThis.navigator !== "undefined" && globalThis.navigator.product === "ReactNative") throw new AnthropicError(`The default react-native fetch implementation does not support streaming. Please use expo/fetch: https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api`);
			throw new AnthropicError(`Attempted to iterate over a response with no body`);
		}
		return new JSONLDecoder(ReadableStreamToAsyncIterable(response.body), controller);
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/messages/batches.mjs
var Batches$1 = class extends APIResource {
	/**
	* Send a batch of Message creation requests.
	*
	* The Message Batches API can be used to process multiple Messages API requests at
	* once. Once a Message Batch is created, it begins processing immediately. Batches
	* can take up to 24 hours to complete.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const betaMessageBatch =
	*   await client.beta.messages.batches.create({
	*     requests: [
	*       {
	*         custom_id: 'my-custom-id-1',
	*         params: {
	*           max_tokens: 1024,
	*           messages: [
	*             { content: 'Hello, world', role: 'user' },
	*           ],
	*           model: 'claude-opus-4-6',
	*         },
	*       },
	*     ],
	*   });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/messages/batches?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() }, options?.headers])
		});
	}
	/**
	* This endpoint is idempotent and can be used to poll for Message Batch
	* completion. To access the results of a Message Batch, make a request to the
	* `results_url` field in the response.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const betaMessageBatch =
	*   await client.beta.messages.batches.retrieve(
	*     'message_batch_id',
	*   );
	* ```
	*/
	retrieve(messageBatchID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() }, options?.headers])
		});
	}
	/**
	* List all Message Batches within a Workspace. Most recently created batches are
	* returned first.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaMessageBatch of client.beta.messages.batches.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/messages/batches?beta=true", Page, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() }, options?.headers])
		});
	}
	/**
	* Delete a Message Batch.
	*
	* Message Batches can only be deleted once they've finished processing. If you'd
	* like to delete an in-progress batch, you must first cancel it.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const betaDeletedMessageBatch =
	*   await client.beta.messages.batches.delete(
	*     'message_batch_id',
	*   );
	* ```
	*/
	delete(messageBatchID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/messages/batches/${messageBatchID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() }, options?.headers])
		});
	}
	/**
	* Batches may be canceled any time before processing ends. Once cancellation is
	* initiated, the batch enters a `canceling` state, at which time the system may
	* complete any in-progress, non-interruptible requests before finalizing
	* cancellation.
	*
	* The number of canceled requests is specified in `request_counts`. To determine
	* which requests were canceled, check the individual results within the batch.
	* Note that cancellation may not result in any canceled requests if they were
	* non-interruptible.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const betaMessageBatch =
	*   await client.beta.messages.batches.cancel(
	*     'message_batch_id',
	*   );
	* ```
	*/
	cancel(messageBatchID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString() }, options?.headers])
		});
	}
	/**
	* Streams the results of a Message Batch as a `.jsonl` file.
	*
	* Each line in the file is a JSON object containing the result of a single request
	* in the Message Batch. Results are not guaranteed to be in the same order as
	* requests. Use the `custom_id` field to match results to requests.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const betaMessageBatchIndividualResponse =
	*   await client.beta.messages.batches.results(
	*     'message_batch_id',
	*   );
	* ```
	*/
	async results(messageBatchID, params = {}, options) {
		const batch = await this.retrieve(messageBatchID);
		if (!batch.results_url) throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
		const { betas } = params ?? {};
		return this._client.get(batch.results_url, {
			...options,
			headers: buildHeaders([{
				"anthropic-beta": [...betas ?? [], "message-batches-2024-09-24"].toString(),
				Accept: "application/binary"
			}, options?.headers]),
			stream: true,
			__binaryResponse: true
		})._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.mjs
const DEPRECATED_MODELS$1 = {
	"claude-1.3": "November 6th, 2024",
	"claude-1.3-100k": "November 6th, 2024",
	"claude-instant-1.1": "November 6th, 2024",
	"claude-instant-1.1-100k": "November 6th, 2024",
	"claude-instant-1.2": "November 6th, 2024",
	"claude-3-sonnet-20240229": "July 21st, 2025",
	"claude-3-opus-20240229": "January 5th, 2026",
	"claude-2.1": "July 21st, 2025",
	"claude-2.0": "July 21st, 2025",
	"claude-3-7-sonnet-latest": "February 19th, 2026",
	"claude-3-7-sonnet-20250219": "February 19th, 2026"
};
const MODELS_TO_WARN_WITH_THINKING_ENABLED$1 = ["claude-mythos-preview", "claude-opus-4-6"];
var Messages$1 = class extends APIResource {
	constructor() {
		super(...arguments);
		this.batches = new Batches$1(this._client);
	}
	create(params, options) {
		const modifiedParams = transformOutputFormat(params);
		const { betas, ...body } = modifiedParams;
		if (body.model in DEPRECATED_MODELS$1) console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS$1[body.model]}\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
		if (MODELS_TO_WARN_WITH_THINKING_ENABLED$1.includes(body.model) && body.thinking && body.thinking.type === "enabled") console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
		let timeout = this._client._options.timeout;
		if (!body.stream && timeout == null) {
			const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
			timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
		}
		const helperHeader = stainlessHelperHeader(body.tools, body.messages);
		return this._client.post("/v1/messages?beta=true", {
			body,
			timeout: timeout ?? 6e5,
			...options,
			headers: buildHeaders([
				{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 },
				helperHeader,
				options?.headers
			]),
			stream: modifiedParams.stream ?? false
		});
	}
	/**
	* Send a structured list of input messages with text and/or image content, along with an expected `output_format` and
	* the response will be automatically parsed and available in the `parsed_output` property of the message.
	*
	* @example
	* ```ts
	* const message = await client.beta.messages.parse({
	*   model: 'claude-3-5-sonnet-20241022',
	*   max_tokens: 1024,
	*   messages: [{ role: 'user', content: 'What is 2+2?' }],
	*   output_format: zodOutputFormat(z.object({ answer: z.number() }), 'math'),
	* });
	*
	* console.log(message.parsed_output?.answer); // 4
	* ```
	*/
	parse(params, options) {
		options = {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...params.betas ?? [], "structured-outputs-2025-12-15"].toString() }, options?.headers])
		};
		return this.create(params, options).then((message) => parseBetaMessage(message, params, { logger: this._client.logger ?? console }));
	}
	/**
	* Create a Message stream
	*/
	stream(body, options) {
		return BetaMessageStream.createMessage(this, body, options);
	}
	/**
	* Count the number of tokens in a Message.
	*
	* The Token Count API can be used to count the number of tokens in a Message,
	* including tools, images, and documents, without creating it.
	*
	* Learn more about token counting in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
	*
	* @example
	* ```ts
	* const betaMessageTokensCount =
	*   await client.beta.messages.countTokens({
	*     messages: [{ content: 'Hello, world', role: 'user' }],
	*     model: 'claude-opus-4-6',
	*   });
	* ```
	*/
	countTokens(params, options) {
		const { betas, ...body } = transformOutputFormat(params);
		return this._client.post("/v1/messages/count_tokens?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "token-counting-2024-11-01"].toString() }, options?.headers])
		});
	}
	toolRunner(body, options) {
		return new BetaToolRunner(this._client, body, options);
	}
};
/**
* Transform deprecated output_format to output_config.format
* Returns a modified copy of the params without mutating the original
*/
function transformOutputFormat(params) {
	if (!params.output_format) return params;
	if (params.output_config?.format) throw new AnthropicError("Both output_format and output_config.format were provided. Please use only output_config.format (output_format is deprecated).");
	const { output_format, ...rest } = params;
	return {
		...rest,
		output_config: {
			...params.output_config,
			format: output_format
		}
	};
}
Messages$1.Batches = Batches$1;
Messages$1.BetaToolRunner = BetaToolRunner;
Messages$1.ToolError = ToolError;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/sessions/events.mjs
var Events = class extends APIResource {
	/**
	* List Events
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsSessionEvent of client.beta.sessions.events.list(
	*   'sesn_011CZkZAtmR3yMPDzynEDxu7',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(sessionID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/sessions/${sessionID}/events?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Send Events
	*
	* @example
	* ```ts
	* const betaManagedAgentsSendSessionEvents =
	*   await client.beta.sessions.events.send(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*     {
	*       events: [
	*         {
	*           content: [
	*             {
	*               text: 'Where is my order #1234?',
	*               type: 'text',
	*             },
	*           ],
	*           type: 'user.message',
	*         },
	*       ],
	*     },
	*   );
	* ```
	*/
	send(sessionID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/sessions/${sessionID}/events?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Stream Events
	*
	* @example
	* ```ts
	* const betaManagedAgentsStreamSessionEvents =
	*   await client.beta.sessions.events.stream(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*   );
	* ```
	*/
	stream(sessionID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/sessions/${sessionID}/events/stream?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers]),
			stream: true
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/sessions/resources.mjs
var Resources = class extends APIResource {
	/**
	* Get Session Resource
	*
	* @example
	* ```ts
	* const resource =
	*   await client.beta.sessions.resources.retrieve(
	*     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
	*     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
	*   );
	* ```
	*/
	retrieve(resourceID, params, options) {
		const { session_id, betas } = params;
		return this._client.get(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update Session Resource
	*
	* @example
	* ```ts
	* const resource =
	*   await client.beta.sessions.resources.update(
	*     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
	*     {
	*       session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*       authorization_token: 'ghp_exampletoken',
	*     },
	*   );
	* ```
	*/
	update(resourceID, params, options) {
		const { session_id, betas, ...body } = params;
		return this._client.post(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List Session Resources
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsSessionResource of client.beta.sessions.resources.list(
	*   'sesn_011CZkZAtmR3yMPDzynEDxu7',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(sessionID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/sessions/${sessionID}/resources?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Session Resource
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeleteSessionResource =
	*   await client.beta.sessions.resources.delete(
	*     'sesrsc_011CZkZBJq5dWxk9fVLNcPht',
	*     { session_id: 'sesn_011CZkZAtmR3yMPDzynEDxu7' },
	*   );
	* ```
	*/
	delete(resourceID, params, options) {
		const { session_id, betas } = params;
		return this._client.delete(path`/v1/sessions/${session_id}/resources/${resourceID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Add Session Resource
	*
	* @example
	* ```ts
	* const betaManagedAgentsFileResource =
	*   await client.beta.sessions.resources.add(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*     {
	*       file_id: 'file_011CNha8iCJcU1wXNR6q4V8w',
	*       type: 'file',
	*     },
	*   );
	* ```
	*/
	add(sessionID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/sessions/${sessionID}/resources?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/sessions/sessions.mjs
var Sessions = class extends APIResource {
	constructor() {
		super(...arguments);
		this.events = new Events(this._client);
		this.resources = new Resources(this._client);
	}
	/**
	* Create Session
	*
	* @example
	* ```ts
	* const betaManagedAgentsSession =
	*   await client.beta.sessions.create({
	*     agent: 'agent_011CZkYpogX7uDKUyvBTophP',
	*     environment_id: 'env_011CZkZ9X2dpNyB7HsEFoRfW',
	*   });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/sessions?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Get Session
	*
	* @example
	* ```ts
	* const betaManagedAgentsSession =
	*   await client.beta.sessions.retrieve(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*   );
	* ```
	*/
	retrieve(sessionID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/sessions/${sessionID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update Session
	*
	* @example
	* ```ts
	* const betaManagedAgentsSession =
	*   await client.beta.sessions.update(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*   );
	* ```
	*/
	update(sessionID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/sessions/${sessionID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List Sessions
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsSession of client.beta.sessions.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/sessions?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Session
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeletedSession =
	*   await client.beta.sessions.delete(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*   );
	* ```
	*/
	delete(sessionID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/sessions/${sessionID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Archive Session
	*
	* @example
	* ```ts
	* const betaManagedAgentsSession =
	*   await client.beta.sessions.archive(
	*     'sesn_011CZkZAtmR3yMPDzynEDxu7',
	*   );
	* ```
	*/
	archive(sessionID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/sessions/${sessionID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
Sessions.Events = Events;
Sessions.Resources = Resources;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/skills/versions.mjs
var Versions = class extends APIResource {
	/**
	* Create Skill Version
	*
	* @example
	* ```ts
	* const version = await client.beta.skills.versions.create(
	*   'skill_id',
	* );
	* ```
	*/
	create(skillID, params = {}, options) {
		const { betas, ...body } = params ?? {};
		return this._client.post(path`/v1/skills/${skillID}/versions?beta=true`, multipartFormRequestOptions({
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		}, this._client));
	}
	/**
	* Get Skill Version
	*
	* @example
	* ```ts
	* const version = await client.beta.skills.versions.retrieve(
	*   'version',
	*   { skill_id: 'skill_id' },
	* );
	* ```
	*/
	retrieve(version, params, options) {
		const { skill_id, betas } = params;
		return this._client.get(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
	/**
	* List Skill Versions
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const versionListResponse of client.beta.skills.versions.list(
	*   'skill_id',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(skillID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/skills/${skillID}/versions?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Skill Version
	*
	* @example
	* ```ts
	* const version = await client.beta.skills.versions.delete(
	*   'version',
	*   { skill_id: 'skill_id' },
	* );
	* ```
	*/
	delete(version, params, options) {
		const { skill_id, betas } = params;
		return this._client.delete(path`/v1/skills/${skill_id}/versions/${version}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/skills/skills.mjs
var Skills = class extends APIResource {
	constructor() {
		super(...arguments);
		this.versions = new Versions(this._client);
	}
	/**
	* Create Skill
	*
	* @example
	* ```ts
	* const skill = await client.beta.skills.create();
	* ```
	*/
	create(params = {}, options) {
		const { betas, ...body } = params ?? {};
		return this._client.post("/v1/skills?beta=true", multipartFormRequestOptions({
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		}, this._client, false));
	}
	/**
	* Get Skill
	*
	* @example
	* ```ts
	* const skill = await client.beta.skills.retrieve('skill_id');
	* ```
	*/
	retrieve(skillID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/skills/${skillID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
	/**
	* List Skills
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const skillListResponse of client.beta.skills.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/skills?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Skill
	*
	* @example
	* ```ts
	* const skill = await client.beta.skills.delete('skill_id');
	* ```
	*/
	delete(skillID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/skills/${skillID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "skills-2025-10-02"].toString() }, options?.headers])
		});
	}
};
Skills.Versions = Versions;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/vaults/credentials.mjs
var Credentials = class extends APIResource {
	/**
	* Create Credential
	*
	* @example
	* ```ts
	* const betaManagedAgentsCredential =
	*   await client.beta.vaults.credentials.create(
	*     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	*     {
	*       auth: {
	*         token: 'bearer_exampletoken',
	*         mcp_server_url:
	*           'https://example-server.modelcontextprotocol.io/sse',
	*         type: 'static_bearer',
	*       },
	*     },
	*   );
	* ```
	*/
	create(vaultID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/vaults/${vaultID}/credentials?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Get Credential
	*
	* @example
	* ```ts
	* const betaManagedAgentsCredential =
	*   await client.beta.vaults.credentials.retrieve(
	*     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
	*     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
	*   );
	* ```
	*/
	retrieve(credentialID, params, options) {
		const { vault_id, betas } = params;
		return this._client.get(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update Credential
	*
	* @example
	* ```ts
	* const betaManagedAgentsCredential =
	*   await client.beta.vaults.credentials.update(
	*     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
	*     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
	*   );
	* ```
	*/
	update(credentialID, params, options) {
		const { vault_id, betas, ...body } = params;
		return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List Credentials
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsCredential of client.beta.vaults.credentials.list(
	*   'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	* )) {
	*   // ...
	* }
	* ```
	*/
	list(vaultID, params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList(path`/v1/vaults/${vaultID}/credentials?beta=true`, PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Credential
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeletedCredential =
	*   await client.beta.vaults.credentials.delete(
	*     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
	*     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
	*   );
	* ```
	*/
	delete(credentialID, params, options) {
		const { vault_id, betas } = params;
		return this._client.delete(path`/v1/vaults/${vault_id}/credentials/${credentialID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Archive Credential
	*
	* @example
	* ```ts
	* const betaManagedAgentsCredential =
	*   await client.beta.vaults.credentials.archive(
	*     'vcrd_011CZkZEMt8gZan2iYOQfSkw',
	*     { vault_id: 'vlt_011CZkZDLs7fYzm1hXNPeRjv' },
	*   );
	* ```
	*/
	archive(credentialID, params, options) {
		const { vault_id, betas } = params;
		return this._client.post(path`/v1/vaults/${vault_id}/credentials/${credentialID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/vaults/vaults.mjs
var Vaults = class extends APIResource {
	constructor() {
		super(...arguments);
		this.credentials = new Credentials(this._client);
	}
	/**
	* Create Vault
	*
	* @example
	* ```ts
	* const betaManagedAgentsVault =
	*   await client.beta.vaults.create({
	*     display_name: 'Example vault',
	*   });
	* ```
	*/
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/vaults?beta=true", {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Get Vault
	*
	* @example
	* ```ts
	* const betaManagedAgentsVault =
	*   await client.beta.vaults.retrieve(
	*     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	*   );
	* ```
	*/
	retrieve(vaultID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/vaults/${vaultID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Update Vault
	*
	* @example
	* ```ts
	* const betaManagedAgentsVault =
	*   await client.beta.vaults.update(
	*     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	*   );
	* ```
	*/
	update(vaultID, params, options) {
		const { betas, ...body } = params;
		return this._client.post(path`/v1/vaults/${vaultID}?beta=true`, {
			body,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* List Vaults
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const betaManagedAgentsVault of client.beta.vaults.list()) {
	*   // ...
	* }
	* ```
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/vaults?beta=true", PageCursor, {
			query,
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Delete Vault
	*
	* @example
	* ```ts
	* const betaManagedAgentsDeletedVault =
	*   await client.beta.vaults.delete(
	*     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	*   );
	* ```
	*/
	delete(vaultID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.delete(path`/v1/vaults/${vaultID}?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
	/**
	* Archive Vault
	*
	* @example
	* ```ts
	* const betaManagedAgentsVault =
	*   await client.beta.vaults.archive(
	*     'vlt_011CZkZDLs7fYzm1hXNPeRjv',
	*   );
	* ```
	*/
	archive(vaultID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.post(path`/v1/vaults/${vaultID}/archive?beta=true`, {
			...options,
			headers: buildHeaders([{ "anthropic-beta": [...betas ?? [], "managed-agents-2026-04-01"].toString() }, options?.headers])
		});
	}
};
Vaults.Credentials = Credentials;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/beta/beta.mjs
var Beta = class extends APIResource {
	constructor() {
		super(...arguments);
		this.models = new Models$1(this._client);
		this.messages = new Messages$1(this._client);
		this.agents = new Agents(this._client);
		this.environments = new Environments(this._client);
		this.sessions = new Sessions(this._client);
		this.vaults = new Vaults(this._client);
		this.memoryStores = new MemoryStores(this._client);
		this.files = new Files(this._client);
		this.skills = new Skills(this._client);
		this.userProfiles = new UserProfiles(this._client);
	}
};
Beta.Models = Models$1;
Beta.Messages = Messages$1;
Beta.Agents = Agents;
Beta.Environments = Environments;
Beta.Sessions = Sessions;
Beta.Vaults = Vaults;
Beta.MemoryStores = MemoryStores;
Beta.Files = Files;
Beta.Skills = Skills;
Beta.UserProfiles = UserProfiles;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/completions.mjs
var Completions = class extends APIResource {
	create(params, options) {
		const { betas, ...body } = params;
		return this._client.post("/v1/complete", {
			body,
			timeout: this._client._options.timeout ?? 6e5,
			...options,
			headers: buildHeaders([{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 }, options?.headers]),
			stream: params.stream ?? false
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/parser.mjs
function getOutputFormat(params) {
	return params?.output_config?.format;
}
function maybeParseMessage(message, params, opts) {
	const outputFormat = getOutputFormat(params);
	if (!params || !("parse" in (outputFormat ?? {}))) return {
		...message,
		content: message.content.map((block) => {
			if (block.type === "text") return Object.defineProperty({ ...block }, "parsed_output", {
				value: null,
				enumerable: false
			});
			return block;
		}),
		parsed_output: null
	};
	return parseMessage(message, params, opts);
}
function parseMessage(message, params, opts) {
	let firstParsedOutput = null;
	const content = message.content.map((block) => {
		if (block.type === "text") {
			const parsedOutput = parseOutputFormat(params, block.text);
			if (firstParsedOutput === null) firstParsedOutput = parsedOutput;
			return Object.defineProperty({ ...block }, "parsed_output", {
				value: parsedOutput,
				enumerable: false
			});
		}
		return block;
	});
	return {
		...message,
		content,
		parsed_output: firstParsedOutput
	};
}
function parseOutputFormat(params, content) {
	const outputFormat = getOutputFormat(params);
	if (outputFormat?.type !== "json_schema") return null;
	try {
		if ("parse" in outputFormat) return outputFormat.parse(content);
		return JSON.parse(content);
	} catch (error) {
		throw new AnthropicError(`Failed to parse structured output: ${error}`);
	}
}
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/lib/MessageStream.mjs
var _MessageStream_instances;
var _MessageStream_currentMessageSnapshot;
var _MessageStream_params;
var _MessageStream_connectedPromise;
var _MessageStream_resolveConnectedPromise;
var _MessageStream_rejectConnectedPromise;
var _MessageStream_endPromise;
var _MessageStream_resolveEndPromise;
var _MessageStream_rejectEndPromise;
var _MessageStream_listeners;
var _MessageStream_ended;
var _MessageStream_errored;
var _MessageStream_aborted;
var _MessageStream_catchingPromiseCreated;
var _MessageStream_response;
var _MessageStream_request_id;
var _MessageStream_logger;
var _MessageStream_getFinalMessage;
var _MessageStream_getFinalText;
var _MessageStream_handleError;
var _MessageStream_beginRequest;
var _MessageStream_addStreamEvent;
var _MessageStream_endRequest;
var _MessageStream_accumulateMessage;
const JSON_BUF_PROPERTY = "__json_buf";
function tracksToolInput(content) {
	return content.type === "tool_use" || content.type === "server_tool_use";
}
var MessageStream = class MessageStream {
	constructor(params, opts) {
		_MessageStream_instances.add(this);
		this.messages = [];
		this.receivedMessages = [];
		_MessageStream_currentMessageSnapshot.set(this, void 0);
		_MessageStream_params.set(this, null);
		this.controller = new AbortController();
		_MessageStream_connectedPromise.set(this, void 0);
		_MessageStream_resolveConnectedPromise.set(this, () => {});
		_MessageStream_rejectConnectedPromise.set(this, () => {});
		_MessageStream_endPromise.set(this, void 0);
		_MessageStream_resolveEndPromise.set(this, () => {});
		_MessageStream_rejectEndPromise.set(this, () => {});
		_MessageStream_listeners.set(this, {});
		_MessageStream_ended.set(this, false);
		_MessageStream_errored.set(this, false);
		_MessageStream_aborted.set(this, false);
		_MessageStream_catchingPromiseCreated.set(this, false);
		_MessageStream_response.set(this, void 0);
		_MessageStream_request_id.set(this, void 0);
		_MessageStream_logger.set(this, void 0);
		_MessageStream_handleError.set(this, (error) => {
			__classPrivateFieldSet(this, _MessageStream_errored, true, "f");
			if (isAbortError(error)) error = new APIUserAbortError();
			if (error instanceof APIUserAbortError) {
				__classPrivateFieldSet(this, _MessageStream_aborted, true, "f");
				return this._emit("abort", error);
			}
			if (error instanceof AnthropicError) return this._emit("error", error);
			if (error instanceof Error) {
				const anthropicError = new AnthropicError(error.message);
				anthropicError.cause = error;
				return this._emit("error", anthropicError);
			}
			return this._emit("error", new AnthropicError(String(error)));
		});
		__classPrivateFieldSet(this, _MessageStream_connectedPromise, new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _MessageStream_resolveConnectedPromise, resolve, "f");
			__classPrivateFieldSet(this, _MessageStream_rejectConnectedPromise, reject, "f");
		}), "f");
		__classPrivateFieldSet(this, _MessageStream_endPromise, new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _MessageStream_resolveEndPromise, resolve, "f");
			__classPrivateFieldSet(this, _MessageStream_rejectEndPromise, reject, "f");
		}), "f");
		__classPrivateFieldGet(this, _MessageStream_connectedPromise, "f").catch(() => {});
		__classPrivateFieldGet(this, _MessageStream_endPromise, "f").catch(() => {});
		__classPrivateFieldSet(this, _MessageStream_params, params, "f");
		__classPrivateFieldSet(this, _MessageStream_logger, opts?.logger ?? console, "f");
	}
	get response() {
		return __classPrivateFieldGet(this, _MessageStream_response, "f");
	}
	get request_id() {
		return __classPrivateFieldGet(this, _MessageStream_request_id, "f");
	}
	/**
	* Returns the `MessageStream` data, the raw `Response` instance and the ID of the request,
	* returned vie the `request-id` header which is useful for debugging requests and resporting
	* issues to Anthropic.
	*
	* This is the same as the `APIPromise.withResponse()` method.
	*
	* This method will raise an error if you created the stream using `MessageStream.fromReadableStream`
	* as no `Response` is available.
	*/
	async withResponse() {
		__classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
		const response = await __classPrivateFieldGet(this, _MessageStream_connectedPromise, "f");
		if (!response) throw new Error("Could not resolve a `Response` object");
		return {
			data: this,
			response,
			request_id: response.headers.get("request-id")
		};
	}
	/**
	* Intended for use on the frontend, consuming a stream produced with
	* `.toReadableStream()` on the backend.
	*
	* Note that messages sent to the model do not appear in `.on('message')`
	* in this context.
	*/
	static fromReadableStream(stream) {
		const runner = new MessageStream(null);
		runner._run(() => runner._fromReadableStream(stream));
		return runner;
	}
	static createMessage(messages, params, options, { logger } = {}) {
		const runner = new MessageStream(params, { logger });
		for (const message of params.messages) runner._addMessageParam(message);
		__classPrivateFieldSet(runner, _MessageStream_params, {
			...params,
			stream: true
		}, "f");
		runner._run(() => runner._createMessage(messages, {
			...params,
			stream: true
		}, {
			...options,
			headers: {
				...options?.headers,
				"X-Stainless-Helper-Method": "stream"
			}
		}));
		return runner;
	}
	_run(executor) {
		executor().then(() => {
			this._emitFinal();
			this._emit("end");
		}, __classPrivateFieldGet(this, _MessageStream_handleError, "f"));
	}
	_addMessageParam(message) {
		this.messages.push(message);
	}
	_addMessage(message, emit = true) {
		this.receivedMessages.push(message);
		if (emit) this._emit("message", message);
	}
	async _createMessage(messages, params, options) {
		const signal = options?.signal;
		let abortHandler;
		if (signal) {
			if (signal.aborted) this.controller.abort();
			abortHandler = this.controller.abort.bind(this.controller);
			signal.addEventListener("abort", abortHandler);
		}
		try {
			__classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
			const { response, data: stream } = await messages.create({
				...params,
				stream: true
			}, {
				...options,
				signal: this.controller.signal
			}).withResponse();
			this._connected(response);
			for await (const event of stream) __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
			if (stream.controller.signal?.aborted) throw new APIUserAbortError();
			__classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		}
	}
	_connected(response) {
		if (this.ended) return;
		__classPrivateFieldSet(this, _MessageStream_response, response, "f");
		__classPrivateFieldSet(this, _MessageStream_request_id, response?.headers.get("request-id"), "f");
		__classPrivateFieldGet(this, _MessageStream_resolveConnectedPromise, "f").call(this, response);
		this._emit("connect");
	}
	get ended() {
		return __classPrivateFieldGet(this, _MessageStream_ended, "f");
	}
	get errored() {
		return __classPrivateFieldGet(this, _MessageStream_errored, "f");
	}
	get aborted() {
		return __classPrivateFieldGet(this, _MessageStream_aborted, "f");
	}
	abort() {
		this.controller.abort();
	}
	/**
	* Adds the listener function to the end of the listeners array for the event.
	* No checks are made to see if the listener has already been added. Multiple calls passing
	* the same combination of event and listener will result in the listener being added, and
	* called, multiple times.
	* @returns this MessageStream, so that calls can be chained
	*/
	on(event, listener) {
		(__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = [])).push({ listener });
		return this;
	}
	/**
	* Removes the specified listener from the listener array for the event.
	* off() will remove, at most, one instance of a listener from the listener array. If any single
	* listener has been added multiple times to the listener array for the specified event, then
	* off() must be called multiple times to remove each instance.
	* @returns this MessageStream, so that calls can be chained
	*/
	off(event, listener) {
		const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
		if (!listeners) return this;
		const index = listeners.findIndex((l) => l.listener === listener);
		if (index >= 0) listeners.splice(index, 1);
		return this;
	}
	/**
	* Adds a one-time listener function for the event. The next time the event is triggered,
	* this listener is removed and then invoked.
	* @returns this MessageStream, so that calls can be chained
	*/
	once(event, listener) {
		(__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] || (__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = [])).push({
			listener,
			once: true
		});
		return this;
	}
	/**
	* This is similar to `.once()`, but returns a Promise that resolves the next time
	* the event is triggered, instead of calling a listener callback.
	* @returns a Promise that resolves the next time given event is triggered,
	* or rejects if an error is emitted.  (If you request the 'error' event,
	* returns a promise that resolves with the error).
	*
	* Example:
	*
	*   const message = await stream.emitted('message') // rejects if the stream errors
	*/
	emitted(event) {
		return new Promise((resolve, reject) => {
			__classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
			if (event !== "error") this.once("error", reject);
			this.once(event, resolve);
		});
	}
	async done() {
		__classPrivateFieldSet(this, _MessageStream_catchingPromiseCreated, true, "f");
		await __classPrivateFieldGet(this, _MessageStream_endPromise, "f");
	}
	get currentMessage() {
		return __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
	}
	/**
	* @returns a promise that resolves with the the final assistant Message response,
	* or rejects if an error occurred or the stream ended prematurely without producing a Message.
	* If structured outputs were used, this will be a ParsedMessage with a `parsed_output` field.
	*/
	async finalMessage() {
		await this.done();
		return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this);
	}
	/**
	* @returns a promise that resolves with the the final assistant Message's text response, concatenated
	* together if there are more than one text blocks.
	* Rejects if an error occurred or the stream ended prematurely without producing a Message.
	*/
	async finalText() {
		await this.done();
		return __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalText).call(this);
	}
	_emit(event, ...args) {
		if (__classPrivateFieldGet(this, _MessageStream_ended, "f")) return;
		if (event === "end") {
			__classPrivateFieldSet(this, _MessageStream_ended, true, "f");
			__classPrivateFieldGet(this, _MessageStream_resolveEndPromise, "f").call(this);
		}
		const listeners = __classPrivateFieldGet(this, _MessageStream_listeners, "f")[event];
		if (listeners) {
			__classPrivateFieldGet(this, _MessageStream_listeners, "f")[event] = listeners.filter((l) => !l.once);
			listeners.forEach(({ listener }) => listener(...args));
		}
		if (event === "abort") {
			const error = args[0];
			if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) Promise.reject(error);
			__classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
			__classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
			this._emit("end");
			return;
		}
		if (event === "error") {
			const error = args[0];
			if (!__classPrivateFieldGet(this, _MessageStream_catchingPromiseCreated, "f") && !listeners?.length) Promise.reject(error);
			__classPrivateFieldGet(this, _MessageStream_rejectConnectedPromise, "f").call(this, error);
			__classPrivateFieldGet(this, _MessageStream_rejectEndPromise, "f").call(this, error);
			this._emit("end");
		}
	}
	_emitFinal() {
		if (this.receivedMessages.at(-1)) this._emit("finalMessage", __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_getFinalMessage).call(this));
	}
	async _fromReadableStream(readableStream, options) {
		const signal = options?.signal;
		let abortHandler;
		if (signal) {
			if (signal.aborted) this.controller.abort();
			abortHandler = this.controller.abort.bind(this.controller);
			signal.addEventListener("abort", abortHandler);
		}
		try {
			__classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_beginRequest).call(this);
			this._connected(null);
			const stream = Stream.fromReadableStream(readableStream, this.controller);
			for await (const event of stream) __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_addStreamEvent).call(this, event);
			if (stream.controller.signal?.aborted) throw new APIUserAbortError();
			__classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_endRequest).call(this);
		} finally {
			if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
		}
	}
	[(_MessageStream_currentMessageSnapshot = /* @__PURE__ */ new WeakMap(), _MessageStream_params = /* @__PURE__ */ new WeakMap(), _MessageStream_connectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectConnectedPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_endPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_resolveEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_rejectEndPromise = /* @__PURE__ */ new WeakMap(), _MessageStream_listeners = /* @__PURE__ */ new WeakMap(), _MessageStream_ended = /* @__PURE__ */ new WeakMap(), _MessageStream_errored = /* @__PURE__ */ new WeakMap(), _MessageStream_aborted = /* @__PURE__ */ new WeakMap(), _MessageStream_catchingPromiseCreated = /* @__PURE__ */ new WeakMap(), _MessageStream_response = /* @__PURE__ */ new WeakMap(), _MessageStream_request_id = /* @__PURE__ */ new WeakMap(), _MessageStream_logger = /* @__PURE__ */ new WeakMap(), _MessageStream_handleError = /* @__PURE__ */ new WeakMap(), _MessageStream_instances = /* @__PURE__ */ new WeakSet(), _MessageStream_getFinalMessage = function _MessageStream_getFinalMessage() {
		if (this.receivedMessages.length === 0) throw new AnthropicError("stream ended without producing a Message with role=assistant");
		return this.receivedMessages.at(-1);
	}, _MessageStream_getFinalText = function _MessageStream_getFinalText() {
		if (this.receivedMessages.length === 0) throw new AnthropicError("stream ended without producing a Message with role=assistant");
		const textBlocks = this.receivedMessages.at(-1).content.filter((block) => block.type === "text").map((block) => block.text);
		if (textBlocks.length === 0) throw new AnthropicError("stream ended without producing a content block with type=text");
		return textBlocks.join(" ");
	}, _MessageStream_beginRequest = function _MessageStream_beginRequest() {
		if (this.ended) return;
		__classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
	}, _MessageStream_addStreamEvent = function _MessageStream_addStreamEvent(event) {
		if (this.ended) return;
		const messageSnapshot = __classPrivateFieldGet(this, _MessageStream_instances, "m", _MessageStream_accumulateMessage).call(this, event);
		this._emit("streamEvent", event, messageSnapshot);
		switch (event.type) {
			case "content_block_delta": {
				const content = messageSnapshot.content.at(-1);
				switch (event.delta.type) {
					case "text_delta":
						if (content.type === "text") this._emit("text", event.delta.text, content.text || "");
						break;
					case "citations_delta":
						if (content.type === "text") this._emit("citation", event.delta.citation, content.citations ?? []);
						break;
					case "input_json_delta":
						if (tracksToolInput(content) && content.input) this._emit("inputJson", event.delta.partial_json, content.input);
						break;
					case "thinking_delta":
						if (content.type === "thinking") this._emit("thinking", event.delta.thinking, content.thinking);
						break;
					case "signature_delta":
						if (content.type === "thinking") this._emit("signature", content.signature);
						break;
					default: event.delta;
				}
				break;
			}
			case "message_stop":
				this._addMessageParam(messageSnapshot);
				this._addMessage(maybeParseMessage(messageSnapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") }), true);
				break;
			case "content_block_stop":
				this._emit("contentBlock", messageSnapshot.content.at(-1));
				break;
			case "message_start": __classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, messageSnapshot, "f");
		}
	}, _MessageStream_endRequest = function _MessageStream_endRequest() {
		if (this.ended) throw new AnthropicError(`stream has ended, this shouldn't happen`);
		const snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
		if (!snapshot) throw new AnthropicError(`request ended without sending any chunks`);
		__classPrivateFieldSet(this, _MessageStream_currentMessageSnapshot, void 0, "f");
		return maybeParseMessage(snapshot, __classPrivateFieldGet(this, _MessageStream_params, "f"), { logger: __classPrivateFieldGet(this, _MessageStream_logger, "f") });
	}, _MessageStream_accumulateMessage = function _MessageStream_accumulateMessage(event) {
		let snapshot = __classPrivateFieldGet(this, _MessageStream_currentMessageSnapshot, "f");
		if (event.type === "message_start") {
			if (snapshot) throw new AnthropicError(`Unexpected event order, got ${event.type} before receiving "message_stop"`);
			return event.message;
		}
		if (!snapshot) throw new AnthropicError(`Unexpected event order, got ${event.type} before "message_start"`);
		switch (event.type) {
			case "message_stop": return snapshot;
			case "message_delta":
				snapshot.stop_reason = event.delta.stop_reason;
				snapshot.stop_sequence = event.delta.stop_sequence;
				snapshot.usage.output_tokens = event.usage.output_tokens;
				if (event.usage.input_tokens != null) snapshot.usage.input_tokens = event.usage.input_tokens;
				if (event.usage.cache_creation_input_tokens != null) snapshot.usage.cache_creation_input_tokens = event.usage.cache_creation_input_tokens;
				if (event.usage.cache_read_input_tokens != null) snapshot.usage.cache_read_input_tokens = event.usage.cache_read_input_tokens;
				if (event.usage.server_tool_use != null) snapshot.usage.server_tool_use = event.usage.server_tool_use;
				return snapshot;
			case "content_block_start":
				snapshot.content.push({ ...event.content_block });
				return snapshot;
			case "content_block_delta": {
				const snapshotContent = snapshot.content.at(event.index);
				switch (event.delta.type) {
					case "text_delta":
						if (snapshotContent?.type === "text") snapshot.content[event.index] = {
							...snapshotContent,
							text: (snapshotContent.text || "") + event.delta.text
						};
						break;
					case "citations_delta":
						if (snapshotContent?.type === "text") snapshot.content[event.index] = {
							...snapshotContent,
							citations: [...snapshotContent.citations ?? [], event.delta.citation]
						};
						break;
					case "input_json_delta":
						if (snapshotContent && tracksToolInput(snapshotContent)) {
							let jsonBuf = snapshotContent[JSON_BUF_PROPERTY] || "";
							jsonBuf += event.delta.partial_json;
							const newContent = { ...snapshotContent };
							Object.defineProperty(newContent, JSON_BUF_PROPERTY, {
								value: jsonBuf,
								enumerable: false,
								writable: true
							});
							if (jsonBuf) newContent.input = partialParse(jsonBuf);
							snapshot.content[event.index] = newContent;
						}
						break;
					case "thinking_delta":
						if (snapshotContent?.type === "thinking") snapshot.content[event.index] = {
							...snapshotContent,
							thinking: snapshotContent.thinking + event.delta.thinking
						};
						break;
					case "signature_delta":
						if (snapshotContent?.type === "thinking") snapshot.content[event.index] = {
							...snapshotContent,
							signature: event.delta.signature
						};
						break;
					default: event.delta;
				}
				return snapshot;
			}
			case "content_block_stop": return snapshot;
		}
	}, Symbol.asyncIterator)]() {
		const pushQueue = [];
		const readQueue = [];
		let done = false;
		this.on("streamEvent", (event) => {
			const reader = readQueue.shift();
			if (reader) reader.resolve(event);
			else pushQueue.push(event);
		});
		this.on("end", () => {
			done = true;
			for (const reader of readQueue) reader.resolve(void 0);
			readQueue.length = 0;
		});
		this.on("abort", (err) => {
			done = true;
			for (const reader of readQueue) reader.reject(err);
			readQueue.length = 0;
		});
		this.on("error", (err) => {
			done = true;
			for (const reader of readQueue) reader.reject(err);
			readQueue.length = 0;
		});
		return {
			next: async () => {
				if (!pushQueue.length) {
					if (done) return {
						value: void 0,
						done: true
					};
					return new Promise((resolve, reject) => readQueue.push({
						resolve,
						reject
					})).then((chunk) => chunk ? {
						value: chunk,
						done: false
					} : {
						value: void 0,
						done: true
					});
				}
				return {
					value: pushQueue.shift(),
					done: false
				};
			},
			return: async () => {
				this.abort();
				return {
					value: void 0,
					done: true
				};
			}
		};
	}
	toReadableStream() {
		return new Stream(this[Symbol.asyncIterator].bind(this), this.controller).toReadableStream();
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/messages/batches.mjs
var Batches = class extends APIResource {
	/**
	* Send a batch of Message creation requests.
	*
	* The Message Batches API can be used to process multiple Messages API requests at
	* once. Once a Message Batch is created, it begins processing immediately. Batches
	* can take up to 24 hours to complete.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const messageBatch = await client.messages.batches.create({
	*   requests: [
	*     {
	*       custom_id: 'my-custom-id-1',
	*       params: {
	*         max_tokens: 1024,
	*         messages: [
	*           { content: 'Hello, world', role: 'user' },
	*         ],
	*         model: 'claude-opus-4-6',
	*       },
	*     },
	*   ],
	* });
	* ```
	*/
	create(body, options) {
		return this._client.post("/v1/messages/batches", {
			body,
			...options
		});
	}
	/**
	* This endpoint is idempotent and can be used to poll for Message Batch
	* completion. To access the results of a Message Batch, make a request to the
	* `results_url` field in the response.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const messageBatch = await client.messages.batches.retrieve(
	*   'message_batch_id',
	* );
	* ```
	*/
	retrieve(messageBatchID, options) {
		return this._client.get(path`/v1/messages/batches/${messageBatchID}`, options);
	}
	/**
	* List all Message Batches within a Workspace. Most recently created batches are
	* returned first.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* // Automatically fetches more pages as needed.
	* for await (const messageBatch of client.messages.batches.list()) {
	*   // ...
	* }
	* ```
	*/
	list(query = {}, options) {
		return this._client.getAPIList("/v1/messages/batches", Page, {
			query,
			...options
		});
	}
	/**
	* Delete a Message Batch.
	*
	* Message Batches can only be deleted once they've finished processing. If you'd
	* like to delete an in-progress batch, you must first cancel it.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const deletedMessageBatch =
	*   await client.messages.batches.delete('message_batch_id');
	* ```
	*/
	delete(messageBatchID, options) {
		return this._client.delete(path`/v1/messages/batches/${messageBatchID}`, options);
	}
	/**
	* Batches may be canceled any time before processing ends. Once cancellation is
	* initiated, the batch enters a `canceling` state, at which time the system may
	* complete any in-progress, non-interruptible requests before finalizing
	* cancellation.
	*
	* The number of canceled requests is specified in `request_counts`. To determine
	* which requests were canceled, check the individual results within the batch.
	* Note that cancellation may not result in any canceled requests if they were
	* non-interruptible.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const messageBatch = await client.messages.batches.cancel(
	*   'message_batch_id',
	* );
	* ```
	*/
	cancel(messageBatchID, options) {
		return this._client.post(path`/v1/messages/batches/${messageBatchID}/cancel`, options);
	}
	/**
	* Streams the results of a Message Batch as a `.jsonl` file.
	*
	* Each line in the file is a JSON object containing the result of a single request
	* in the Message Batch. Results are not guaranteed to be in the same order as
	* requests. Use the `custom_id` field to match results to requests.
	*
	* Learn more about the Message Batches API in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/batch-processing)
	*
	* @example
	* ```ts
	* const messageBatchIndividualResponse =
	*   await client.messages.batches.results('message_batch_id');
	* ```
	*/
	async results(messageBatchID, options) {
		const batch = await this.retrieve(messageBatchID);
		if (!batch.results_url) throw new AnthropicError(`No batch \`results_url\`; Has it finished processing? ${batch.processing_status} - ${batch.id}`);
		return this._client.get(batch.results_url, {
			...options,
			headers: buildHeaders([{ Accept: "application/binary" }, options?.headers]),
			stream: true,
			__binaryResponse: true
		})._thenUnwrap((_, props) => JSONLDecoder.fromResponse(props.response, props.controller));
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/messages/messages.mjs
var Messages = class extends APIResource {
	constructor() {
		super(...arguments);
		this.batches = new Batches(this._client);
	}
	create(body, options) {
		if (body.model in DEPRECATED_MODELS) console.warn(`The model '${body.model}' is deprecated and will reach end-of-life on ${DEPRECATED_MODELS[body.model]}\nPlease migrate to a newer model. Visit https://docs.anthropic.com/en/docs/resources/model-deprecations for more information.`);
		if (MODELS_TO_WARN_WITH_THINKING_ENABLED.includes(body.model) && body.thinking && body.thinking.type === "enabled") console.warn(`Using Claude with ${body.model} and 'thinking.type=enabled' is deprecated. Use 'thinking.type=adaptive' instead which results in better model performance in our testing: https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking`);
		let timeout = this._client._options.timeout;
		if (!body.stream && timeout == null) {
			const maxNonstreamingTokens = MODEL_NONSTREAMING_TOKENS[body.model] ?? void 0;
			timeout = this._client.calculateNonstreamingTimeout(body.max_tokens, maxNonstreamingTokens);
		}
		const helperHeader = stainlessHelperHeader(body.tools, body.messages);
		return this._client.post("/v1/messages", {
			body,
			timeout: timeout ?? 6e5,
			...options,
			headers: buildHeaders([helperHeader, options?.headers]),
			stream: body.stream ?? false
		});
	}
	/**
	* Send a structured list of input messages with text and/or image content, along with an expected `output_config.format` and
	* the response will be automatically parsed and available in the `parsed_output` property of the message.
	*
	* @example
	* ```ts
	* const message = await client.messages.parse({
	*   model: 'claude-sonnet-4-5-20250929',
	*   max_tokens: 1024,
	*   messages: [{ role: 'user', content: 'What is 2+2?' }],
	*   output_config: {
	*     format: zodOutputFormat(z.object({ answer: z.number() })),
	*   },
	* });
	*
	* console.log(message.parsed_output?.answer); // 4
	* ```
	*/
	parse(params, options) {
		return this.create(params, options).then((message) => parseMessage(message, params, { logger: this._client.logger ?? console }));
	}
	/**
	* Create a Message stream.
	*
	* If `output_config.format` is provided with a parseable format (like `zodOutputFormat()`),
	* the final message will include a `parsed_output` property with the parsed content.
	*
	* @example
	* ```ts
	* const stream = client.messages.stream({
	*   model: 'claude-sonnet-4-5-20250929',
	*   max_tokens: 1024,
	*   messages: [{ role: 'user', content: 'What is 2+2?' }],
	*   output_config: {
	*     format: zodOutputFormat(z.object({ answer: z.number() })),
	*   },
	* });
	*
	* const message = await stream.finalMessage();
	* console.log(message.parsed_output?.answer); // 4
	* ```
	*/
	stream(body, options) {
		return MessageStream.createMessage(this, body, options, { logger: this._client.logger ?? console });
	}
	/**
	* Count the number of tokens in a Message.
	*
	* The Token Count API can be used to count the number of tokens in a Message,
	* including tools, images, and documents, without creating it.
	*
	* Learn more about token counting in our
	* [user guide](https://docs.claude.com/en/docs/build-with-claude/token-counting)
	*
	* @example
	* ```ts
	* const messageTokensCount =
	*   await client.messages.countTokens({
	*     messages: [{ content: 'Hello, world', role: 'user' }],
	*     model: 'claude-opus-4-6',
	*   });
	* ```
	*/
	countTokens(body, options) {
		return this._client.post("/v1/messages/count_tokens", {
			body,
			...options
		});
	}
};
const DEPRECATED_MODELS = {
	"claude-1.3": "November 6th, 2024",
	"claude-1.3-100k": "November 6th, 2024",
	"claude-instant-1.1": "November 6th, 2024",
	"claude-instant-1.1-100k": "November 6th, 2024",
	"claude-instant-1.2": "November 6th, 2024",
	"claude-3-sonnet-20240229": "July 21st, 2025",
	"claude-3-opus-20240229": "January 5th, 2026",
	"claude-2.1": "July 21st, 2025",
	"claude-2.0": "July 21st, 2025",
	"claude-3-7-sonnet-latest": "February 19th, 2026",
	"claude-3-7-sonnet-20250219": "February 19th, 2026",
	"claude-3-5-haiku-latest": "February 19th, 2026",
	"claude-3-5-haiku-20241022": "February 19th, 2026",
	"claude-opus-4-0": "June 15th, 2026",
	"claude-opus-4-20250514": "June 15th, 2026",
	"claude-sonnet-4-0": "June 15th, 2026",
	"claude-sonnet-4-20250514": "June 15th, 2026"
};
const MODELS_TO_WARN_WITH_THINKING_ENABLED = ["claude-mythos-preview", "claude-opus-4-6"];
Messages.Batches = Batches;
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/resources/models.mjs
var Models = class extends APIResource {
	/**
	* Get a specific model.
	*
	* The Models API response can be used to determine information about a specific
	* model or resolve a model alias to a model ID.
	*/
	retrieve(modelID, params = {}, options) {
		const { betas } = params ?? {};
		return this._client.get(path`/v1/models/${modelID}`, {
			...options,
			headers: buildHeaders([{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 }, options?.headers])
		});
	}
	/**
	* List available models.
	*
	* The Models API response can be used to determine which models are available for
	* use in the API. More recently released models are listed first.
	*/
	list(params = {}, options) {
		const { betas, ...query } = params ?? {};
		return this._client.getAPIList("/v1/models", Page, {
			query,
			...options,
			headers: buildHeaders([{ ...betas?.toString() != null ? { "anthropic-beta": betas?.toString() } : void 0 }, options?.headers])
		});
	}
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/internal/utils/env.mjs
/**
* Read an environment variable.
*
* Trims beginning and trailing whitespace.
*
* Will return undefined if the environment variable doesn't exist or cannot be accessed.
*/
const readEnv = (env) => {
	if (typeof globalThis.process !== "undefined") return globalThis.process.env?.[env]?.trim() || void 0;
	if (typeof globalThis.Deno !== "undefined") return globalThis.Deno.env?.get?.(env)?.trim() || void 0;
};
//#endregion
//#region node_modules/.pnpm/@anthropic-ai+sdk@0.91.1_zod@4.4.3/node_modules/@anthropic-ai/sdk/client.mjs
var _BaseAnthropic_instances;
var _a;
var _BaseAnthropic_encoder;
var _BaseAnthropic_baseURLOverridden;
const HUMAN_PROMPT = "\\n\\nHuman:";
const AI_PROMPT = "\\n\\nAssistant:";
/**
* Base class for Anthropic API clients.
*/
var BaseAnthropic = class {
	/**
	* API Client for interfacing with the Anthropic API.
	*
	* @param {string | null | undefined} [opts.apiKey=process.env['ANTHROPIC_API_KEY'] ?? null]
	* @param {string | null | undefined} [opts.authToken=process.env['ANTHROPIC_AUTH_TOKEN'] ?? null]
	* @param {string} [opts.baseURL=process.env['ANTHROPIC_BASE_URL'] ?? https://api.anthropic.com] - Override the default base URL for the API.
	* @param {number} [opts.timeout=10 minutes] - The maximum amount of time (in milliseconds) the client will wait for a response before timing out.
	* @param {MergedRequestInit} [opts.fetchOptions] - Additional `RequestInit` options to be passed to `fetch` calls.
	* @param {Fetch} [opts.fetch] - Specify a custom `fetch` function implementation.
	* @param {number} [opts.maxRetries=2] - The maximum number of times the client will retry a request.
	* @param {HeadersLike} opts.defaultHeaders - Default headers to include with every request to the API.
	* @param {Record<string, string | undefined>} opts.defaultQuery - Default query parameters to include with every request to the API.
	* @param {boolean} [opts.dangerouslyAllowBrowser=false] - By default, client-side use of this library is not allowed, as it risks exposing your secret API credentials to attackers.
	*/
	constructor({ baseURL = readEnv("ANTHROPIC_BASE_URL"), apiKey = readEnv("ANTHROPIC_API_KEY") ?? null, authToken = readEnv("ANTHROPIC_AUTH_TOKEN") ?? null, ...opts } = {}) {
		_BaseAnthropic_instances.add(this);
		_BaseAnthropic_encoder.set(this, void 0);
		const options = {
			apiKey,
			authToken,
			...opts,
			baseURL: baseURL || `https://api.anthropic.com`
		};
		if (!options.dangerouslyAllowBrowser && isRunningInBrowser()) throw new AnthropicError("It looks like you're running in a browser-like environment.\n\nThis is disabled by default, as it risks exposing your secret API credentials to attackers.\nIf you understand the risks and have appropriate mitigations in place,\nyou can set the `dangerouslyAllowBrowser` option to `true`, e.g.,\n\nnew Anthropic({ apiKey, dangerouslyAllowBrowser: true });\n");
		this.baseURL = options.baseURL;
		this.timeout = options.timeout ?? _a.DEFAULT_TIMEOUT;
		this.logger = options.logger ?? console;
		const defaultLogLevel = "warn";
		this.logLevel = defaultLogLevel;
		this.logLevel = parseLogLevel(options.logLevel, "ClientOptions.logLevel", this) ?? parseLogLevel(readEnv("ANTHROPIC_LOG"), "process.env['ANTHROPIC_LOG']", this) ?? defaultLogLevel;
		this.fetchOptions = options.fetchOptions;
		this.maxRetries = options.maxRetries ?? 2;
		this.fetch = options.fetch ?? getDefaultFetch();
		__classPrivateFieldSet(this, _BaseAnthropic_encoder, FallbackEncoder, "f");
		this._options = options;
		this.apiKey = typeof apiKey === "string" ? apiKey : null;
		this.authToken = authToken;
	}
	/**
	* Create a new client instance re-using the same options given to the current client with optional overriding.
	*/
	withOptions(options) {
		return new this.constructor({
			...this._options,
			baseURL: this.baseURL,
			maxRetries: this.maxRetries,
			timeout: this.timeout,
			logger: this.logger,
			logLevel: this.logLevel,
			fetch: this.fetch,
			fetchOptions: this.fetchOptions,
			apiKey: this.apiKey,
			authToken: this.authToken,
			...options
		});
	}
	defaultQuery() {
		return this._options.defaultQuery;
	}
	validateHeaders({ values, nulls }) {
		if (values.get("x-api-key") || values.get("authorization")) return;
		if (this.apiKey && values.get("x-api-key")) return;
		if (nulls.has("x-api-key")) return;
		if (this.authToken && values.get("authorization")) return;
		if (nulls.has("authorization")) return;
		throw new Error("Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the \"X-Api-Key\" or \"Authorization\" headers to be explicitly omitted");
	}
	async authHeaders(opts) {
		return buildHeaders([await this.apiKeyAuth(opts), await this.bearerAuth(opts)]);
	}
	async apiKeyAuth(opts) {
		if (this.apiKey == null) return;
		return buildHeaders([{ "X-Api-Key": this.apiKey }]);
	}
	async bearerAuth(opts) {
		if (this.authToken == null) return;
		return buildHeaders([{ Authorization: `Bearer ${this.authToken}` }]);
	}
	/**
	* Basic re-implementation of `qs.stringify` for primitive types.
	*/
	stringifyQuery(query) {
		return stringifyQuery(query);
	}
	getUserAgent() {
		return `${this.constructor.name}/JS ${VERSION}`;
	}
	defaultIdempotencyKey() {
		return `stainless-node-retry-${uuid4()}`;
	}
	makeStatusError(status, error, message, headers) {
		return APIError.generate(status, error, message, headers);
	}
	buildURL(path, query, defaultBaseURL) {
		const baseURL = !__classPrivateFieldGet(this, _BaseAnthropic_instances, "m", _BaseAnthropic_baseURLOverridden).call(this) && defaultBaseURL || this.baseURL;
		const url = isAbsoluteURL(path) ? new URL(path) : new URL(baseURL + (baseURL.endsWith("/") && path.startsWith("/") ? path.slice(1) : path));
		const defaultQuery = this.defaultQuery();
		const pathQuery = Object.fromEntries(url.searchParams);
		if (!isEmptyObj(defaultQuery) || !isEmptyObj(pathQuery)) query = {
			...pathQuery,
			...defaultQuery,
			...query
		};
		if (typeof query === "object" && query && !Array.isArray(query)) url.search = this.stringifyQuery(query);
		return url.toString();
	}
	_calculateNonstreamingTimeout(maxTokens) {
		const defaultTimeout = 600;
		if (3600 * maxTokens / 128e3 > defaultTimeout) throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#streaming-responses for more details");
		return defaultTimeout * 1e3;
	}
	/**
	* Used as a callback for mutating the given `FinalRequestOptions` object.
	*/
	async prepareOptions(options) {}
	/**
	* Used as a callback for mutating the given `RequestInit` object.
	*
	* This is useful for cases where you want to add certain headers based off of
	* the request properties, e.g. `method` or `url`.
	*/
	async prepareRequest(request, { url, options }) {}
	get(path, opts) {
		return this.methodRequest("get", path, opts);
	}
	post(path, opts) {
		return this.methodRequest("post", path, opts);
	}
	patch(path, opts) {
		return this.methodRequest("patch", path, opts);
	}
	put(path, opts) {
		return this.methodRequest("put", path, opts);
	}
	delete(path, opts) {
		return this.methodRequest("delete", path, opts);
	}
	methodRequest(method, path, opts) {
		return this.request(Promise.resolve(opts).then((opts) => {
			return {
				method,
				path,
				...opts
			};
		}));
	}
	request(options, remainingRetries = null) {
		return new APIPromise(this, this.makeRequest(options, remainingRetries, void 0));
	}
	async makeRequest(optionsInput, retriesRemaining, retryOfRequestLogID) {
		const options = await optionsInput;
		const maxRetries = options.maxRetries ?? this.maxRetries;
		if (retriesRemaining == null) retriesRemaining = maxRetries;
		await this.prepareOptions(options);
		const { req, url, timeout } = await this.buildRequest(options, { retryCount: maxRetries - retriesRemaining });
		await this.prepareRequest(req, {
			url,
			options
		});
		/** Not an API request ID, just for correlating local log entries. */
		const requestLogID = "log_" + (Math.random() * (1 << 24) | 0).toString(16).padStart(6, "0");
		const retryLogStr = retryOfRequestLogID === void 0 ? "" : `, retryOf: ${retryOfRequestLogID}`;
		const startTime = Date.now();
		loggerFor(this).debug(`[${requestLogID}] sending request`, formatRequestDetails({
			retryOfRequestLogID,
			method: options.method,
			url,
			options,
			headers: req.headers
		}));
		if (options.signal?.aborted) throw new APIUserAbortError();
		const controller = new AbortController();
		const response = await this.fetchWithTimeout(url, req, timeout, controller).catch(castToError);
		const headersTime = Date.now();
		if (response instanceof globalThis.Error) {
			const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
			if (options.signal?.aborted) throw new APIUserAbortError();
			const isTimeout = isAbortError(response) || /timed? ?out/i.test(String(response) + ("cause" in response ? String(response.cause) : ""));
			if (retriesRemaining) {
				loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - ${retryMessage}`);
				loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (${retryMessage})`, formatRequestDetails({
					retryOfRequestLogID,
					url,
					durationMs: headersTime - startTime,
					message: response.message
				}));
				return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID);
			}
			loggerFor(this).info(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} - error; no more retries left`);
			loggerFor(this).debug(`[${requestLogID}] connection ${isTimeout ? "timed out" : "failed"} (error; no more retries left)`, formatRequestDetails({
				retryOfRequestLogID,
				url,
				durationMs: headersTime - startTime,
				message: response.message
			}));
			if (isTimeout) throw new APIConnectionTimeoutError();
			throw new APIConnectionError({ cause: response });
		}
		const responseInfo = `[${requestLogID}${retryLogStr}${[...response.headers.entries()].filter(([name]) => name === "request-id").map(([name, value]) => ", " + name + ": " + JSON.stringify(value)).join("")}] ${req.method} ${url} ${response.ok ? "succeeded" : "failed"} with status ${response.status} in ${headersTime - startTime}ms`;
		if (!response.ok) {
			const shouldRetry = await this.shouldRetry(response);
			if (retriesRemaining && shouldRetry) {
				const retryMessage = `retrying, ${retriesRemaining} attempts remaining`;
				await CancelReadableStream(response.body);
				loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
				loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
					retryOfRequestLogID,
					url: response.url,
					status: response.status,
					headers: response.headers,
					durationMs: headersTime - startTime
				}));
				return this.retryRequest(options, retriesRemaining, retryOfRequestLogID ?? requestLogID, response.headers);
			}
			const retryMessage = shouldRetry ? `error; no more retries left` : `error; not retryable`;
			loggerFor(this).info(`${responseInfo} - ${retryMessage}`);
			const errText = await response.text().catch((err) => castToError(err).message);
			const errJSON = safeJSON(errText);
			const errMessage = errJSON ? void 0 : errText;
			loggerFor(this).debug(`[${requestLogID}] response error (${retryMessage})`, formatRequestDetails({
				retryOfRequestLogID,
				url: response.url,
				status: response.status,
				headers: response.headers,
				message: errMessage,
				durationMs: Date.now() - startTime
			}));
			throw this.makeStatusError(response.status, errJSON, errMessage, response.headers);
		}
		loggerFor(this).info(responseInfo);
		loggerFor(this).debug(`[${requestLogID}] response start`, formatRequestDetails({
			retryOfRequestLogID,
			url: response.url,
			status: response.status,
			headers: response.headers,
			durationMs: headersTime - startTime
		}));
		return {
			response,
			options,
			controller,
			requestLogID,
			retryOfRequestLogID,
			startTime
		};
	}
	getAPIList(path, Page, opts) {
		return this.requestAPIList(Page, opts && "then" in opts ? opts.then((opts) => ({
			method: "get",
			path,
			...opts
		})) : {
			method: "get",
			path,
			...opts
		});
	}
	requestAPIList(Page, options) {
		const request = this.makeRequest(options, null, void 0);
		return new PagePromise(this, request, Page);
	}
	async fetchWithTimeout(url, init, ms, controller) {
		const { signal, method, ...options } = init || {};
		const abort = this._makeAbort(controller);
		if (signal) signal.addEventListener("abort", abort, { once: true });
		const timeout = setTimeout(abort, ms);
		const isReadableBody = globalThis.ReadableStream && options.body instanceof globalThis.ReadableStream || typeof options.body === "object" && options.body !== null && Symbol.asyncIterator in options.body;
		const fetchOptions = {
			signal: controller.signal,
			...isReadableBody ? { duplex: "half" } : {},
			method: "GET",
			...options
		};
		if (method) fetchOptions.method = method.toUpperCase();
		try {
			return await this.fetch.call(void 0, url, fetchOptions);
		} finally {
			clearTimeout(timeout);
		}
	}
	async shouldRetry(response) {
		const shouldRetryHeader = response.headers.get("x-should-retry");
		if (shouldRetryHeader === "true") return true;
		if (shouldRetryHeader === "false") return false;
		if (response.status === 408) return true;
		if (response.status === 409) return true;
		if (response.status === 429) return true;
		if (response.status >= 500) return true;
		return false;
	}
	async retryRequest(options, retriesRemaining, requestLogID, responseHeaders) {
		let timeoutMillis;
		const retryAfterMillisHeader = responseHeaders?.get("retry-after-ms");
		if (retryAfterMillisHeader) {
			const timeoutMs = parseFloat(retryAfterMillisHeader);
			if (!Number.isNaN(timeoutMs)) timeoutMillis = timeoutMs;
		}
		const retryAfterHeader = responseHeaders?.get("retry-after");
		if (retryAfterHeader && !timeoutMillis) {
			const timeoutSeconds = parseFloat(retryAfterHeader);
			if (!Number.isNaN(timeoutSeconds)) timeoutMillis = timeoutSeconds * 1e3;
			else timeoutMillis = Date.parse(retryAfterHeader) - Date.now();
		}
		if (timeoutMillis === void 0) {
			const maxRetries = options.maxRetries ?? this.maxRetries;
			timeoutMillis = this.calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries);
		}
		await sleep(timeoutMillis);
		return this.makeRequest(options, retriesRemaining - 1, requestLogID);
	}
	calculateDefaultRetryTimeoutMillis(retriesRemaining, maxRetries) {
		const initialRetryDelay = .5;
		const maxRetryDelay = 8;
		const numRetries = maxRetries - retriesRemaining;
		return Math.min(initialRetryDelay * Math.pow(2, numRetries), maxRetryDelay) * (1 - Math.random() * .25) * 1e3;
	}
	calculateNonstreamingTimeout(maxTokens, maxNonstreamingTokens) {
		const maxTime = 36e5;
		const defaultTime = 6e5;
		if (maxTime * maxTokens / 128e3 > defaultTime || maxNonstreamingTokens != null && maxTokens > maxNonstreamingTokens) throw new AnthropicError("Streaming is required for operations that may take longer than 10 minutes. See https://github.com/anthropics/anthropic-sdk-typescript#long-requests for more details");
		return defaultTime;
	}
	async buildRequest(inputOptions, { retryCount = 0 } = {}) {
		const options = { ...inputOptions };
		const { method, path, query, defaultBaseURL } = options;
		const url = this.buildURL(path, query, defaultBaseURL);
		if ("timeout" in options) validatePositiveInteger("timeout", options.timeout);
		options.timeout = options.timeout ?? this.timeout;
		const { bodyHeaders, body } = this.buildBody({ options });
		return {
			req: {
				method,
				headers: await this.buildHeaders({
					options: inputOptions,
					method,
					bodyHeaders,
					retryCount
				}),
				...options.signal && { signal: options.signal },
				...globalThis.ReadableStream && body instanceof globalThis.ReadableStream && { duplex: "half" },
				...body && { body },
				...this.fetchOptions ?? {},
				...options.fetchOptions ?? {}
			},
			url,
			timeout: options.timeout
		};
	}
	async buildHeaders({ options, method, bodyHeaders, retryCount }) {
		let idempotencyHeaders = {};
		if (this.idempotencyHeader && method !== "get") {
			if (!options.idempotencyKey) options.idempotencyKey = this.defaultIdempotencyKey();
			idempotencyHeaders[this.idempotencyHeader] = options.idempotencyKey;
		}
		const headers = buildHeaders([
			idempotencyHeaders,
			{
				Accept: "application/json",
				"User-Agent": this.getUserAgent(),
				"X-Stainless-Retry-Count": String(retryCount),
				...options.timeout ? { "X-Stainless-Timeout": String(Math.trunc(options.timeout / 1e3)) } : {},
				...getPlatformHeaders(),
				...this._options.dangerouslyAllowBrowser ? { "anthropic-dangerous-direct-browser-access": "true" } : void 0,
				"anthropic-version": "2023-06-01"
			},
			await this.authHeaders(options),
			this._options.defaultHeaders,
			bodyHeaders,
			options.headers
		]);
		this.validateHeaders(headers);
		return headers.values;
	}
	_makeAbort(controller) {
		return () => controller.abort();
	}
	buildBody({ options: { body, headers: rawHeaders } }) {
		if (!body) return {
			bodyHeaders: void 0,
			body: void 0
		};
		const headers = buildHeaders([rawHeaders]);
		if (ArrayBuffer.isView(body) || body instanceof ArrayBuffer || body instanceof DataView || typeof body === "string" && headers.values.has("content-type") || globalThis.Blob && body instanceof globalThis.Blob || body instanceof FormData || body instanceof URLSearchParams || globalThis.ReadableStream && body instanceof globalThis.ReadableStream) return {
			bodyHeaders: void 0,
			body
		};
		else if (typeof body === "object" && (Symbol.asyncIterator in body || Symbol.iterator in body && "next" in body && typeof body.next === "function")) return {
			bodyHeaders: void 0,
			body: ReadableStreamFrom(body)
		};
		else if (typeof body === "object" && headers.values.get("content-type") === "application/x-www-form-urlencoded") return {
			bodyHeaders: { "content-type": "application/x-www-form-urlencoded" },
			body: this.stringifyQuery(body)
		};
		else return __classPrivateFieldGet(this, _BaseAnthropic_encoder, "f").call(this, {
			body,
			headers
		});
	}
};
_a = BaseAnthropic, _BaseAnthropic_encoder = /* @__PURE__ */ new WeakMap(), _BaseAnthropic_instances = /* @__PURE__ */ new WeakSet(), _BaseAnthropic_baseURLOverridden = function _BaseAnthropic_baseURLOverridden() {
	return this.baseURL !== "https://api.anthropic.com";
};
BaseAnthropic.Anthropic = _a;
BaseAnthropic.HUMAN_PROMPT = HUMAN_PROMPT;
BaseAnthropic.AI_PROMPT = AI_PROMPT;
BaseAnthropic.DEFAULT_TIMEOUT = 6e5;
BaseAnthropic.AnthropicError = AnthropicError;
BaseAnthropic.APIError = APIError;
BaseAnthropic.APIConnectionError = APIConnectionError;
BaseAnthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
BaseAnthropic.APIUserAbortError = APIUserAbortError;
BaseAnthropic.NotFoundError = NotFoundError;
BaseAnthropic.ConflictError = ConflictError;
BaseAnthropic.RateLimitError = RateLimitError;
BaseAnthropic.BadRequestError = BadRequestError;
BaseAnthropic.AuthenticationError = AuthenticationError;
BaseAnthropic.InternalServerError = InternalServerError;
BaseAnthropic.PermissionDeniedError = PermissionDeniedError;
BaseAnthropic.UnprocessableEntityError = UnprocessableEntityError;
BaseAnthropic.toFile = toFile;
/**
* API Client for interfacing with the Anthropic API.
*/
var Anthropic = class extends BaseAnthropic {
	constructor() {
		super(...arguments);
		this.completions = new Completions(this);
		this.messages = new Messages(this);
		this.models = new Models(this);
		this.beta = new Beta(this);
	}
};
Anthropic.Completions = Completions;
Anthropic.Messages = Messages;
Anthropic.Models = Models;
Anthropic.Beta = Beta;
//#endregion
//#region node_modules/.pnpm/@earendil-works+pi-ai@0.82.1_ws@8.21.3_zod@4.4.3/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js
/**
* Resolve cache retention preference.
* Defaults to "short" and uses PI_CACHE_RETENTION for backward compatibility.
*/
function resolveCacheRetention(cacheRetention, env) {
	if (cacheRetention) return cacheRetention;
	if (getProviderEnvValue("PI_CACHE_RETENTION", env) === "long") return "long";
	return "short";
}
function getCacheControl(model, cacheRetention, env) {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") return { retention };
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : void 0;
	return {
		retention,
		cacheControl: {
			type: "ephemeral",
			...ttl && { ttl }
		}
	};
}
const claudeCodeVersion = "2.1.75";
const ccToolLookup = new Map([
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch"
].map((t) => [t.toLowerCase(), t]));
const toClaudeCodeName = (name) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name, tools) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};
/**
* Convert content blocks to Anthropic API format
*/
function convertContentBlocks(content) {
	if (!content.some((c) => c.type === "image")) return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
	const blocks = content.map((block) => {
		if (block.type === "text") return {
			type: "text",
			text: sanitizeSurrogates(block.text)
		};
		return {
			type: "image",
			source: {
				type: "base64",
				media_type: block.mimeType,
				data: block.data
			}
		};
	});
	if (!blocks.some((b) => b.type === "text")) blocks.unshift({
		type: "text",
		text: "(see attached image)"
	});
	return blocks;
}
const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
function getAnthropicCompat(model) {
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? false,
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model)
	};
}
/**
* Default for `supportsToolReferences`: first-party Anthropic models except
* Haiku (rejects client-side tool_reference blocks) and models that predate
* tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1).
*/
function defaultSupportsToolReferences(model) {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || major === 4 && minor >= 5;
}
function mergeHeaders(...headerSources) {
	const merged = {};
	for (const headers of headerSources) if (headers) Object.assign(merged, headers);
	return merged;
}
function hasHeader(headers, name) {
	if (!headers) return false;
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === expected && value !== null && value.trim().length > 0) return true;
	return false;
}
function assertRequestAuth(provider, apiKey, headers) {
	if (apiKey) return;
	if (hasHeader(headers, "authorization") || hasHeader(headers, "x-api-key") || hasHeader(headers, "cf-aig-authorization")) return;
	throw new Error(`No API key for provider: ${provider}`);
}
const ANTHROPIC_MESSAGE_EVENTS = /* @__PURE__ */ new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop"
]);
function flushSseEvent(state) {
	if (!state.event && state.data.length === 0) return null;
	const event = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw]
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}
function decodeSseLine(line, state) {
	if (line === "") return flushSseEvent(state);
	state.raw.push(line);
	if (line.startsWith(":")) return null;
	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) value = value.slice(1);
	if (fieldName === "event") state.event = value;
	else if (fieldName === "data") state.data.push(value);
	return null;
}
function nextLineBreakIndex(text) {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) return newlineIndex;
	if (newlineIndex === -1) return carriageReturnIndex;
	return Math.min(carriageReturnIndex, newlineIndex);
}
function consumeLine(text) {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) return null;
	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") nextIndex += 1;
	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex)
	};
}
async function* iterateSseMessages(body, signal) {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state = {
		event: null,
		data: [],
		raw: []
	};
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) yield event;
				consumed = consumeLine(buffer);
			}
		}
		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) yield event;
			consumed = consumeLine(buffer);
		}
		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) yield event;
		}
		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) yield trailingEvent;
	} finally {
		reader.releaseLock();
	}
}
async function* iterateAnthropicEvents(response, signal) {
	if (!response.body) throw new Error("Attempted to iterate over an Anthropic response with no body");
	let sawMessageStart = false;
	let sawMessageEnd = false;
	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") throw new Error(sse.data);
		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) continue;
		try {
			const event = parseJsonWithRepair(sse.data);
			if (event.type === "message_start") sawMessageStart = true;
			else if (event.type === "message_stop") sawMessageEnd = true;
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`);
		}
	}
	if (sawMessageStart && !sawMessageEnd) throw new Error("Anthropic stream ended before message_stop");
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
			let client;
			let isOAuth;
			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				assertRequestAuth(model.provider, apiKey, options?.headers);
				let copilotDynamicHeaders;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages
					});
				}
				const cacheSessionId = resolveCacheRetention(options?.cacheRetention, options?.env) === "none" ? void 0 : options?.sessionId;
				const created = createClient(model, apiKey, options?.interleavedThinking ?? true, shouldUseFineGrainedToolStreamingBeta(model, context), options?.headers, copilotDynamicHeaders, cacheSessionId);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			let params = buildParams(model, context, isOAuth, options);
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== void 0) params = nextParams;
			const requestOptions = {
				...options?.signal ? { signal: options.signal } : {},
				...options?.timeoutMs !== void 0 ? { timeout: options.timeoutMs } : {},
				maxRetries: 0
			};
			const response = await retryProviderRequest(() => client.messages.create({
				...params,
				stream: true
			}, requestOptions).asResponse(), {
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
			const blocks = output.content;
			for await (const event of iterateAnthropicEvents(response, options?.signal)) if (event.type === "message_start") {
				output.responseId = event.message.id;
				output.usage.input = event.message.usage.input_tokens || 0;
				output.usage.output = event.message.usage.output_tokens || 0;
				output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
				output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
				output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
				output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
			} else if (event.type === "content_block_start") {
				if (event.content_block.type === "text") {
					const block = {
						type: "text",
						text: "",
						index: event.index
					};
					output.content.push(block);
					stream.push({
						type: "text_start",
						contentIndex: output.content.length - 1,
						partial: output
					});
				} else if (event.content_block.type === "thinking") {
					const block = {
						type: "thinking",
						thinking: "",
						thinkingSignature: "",
						index: event.index
					};
					output.content.push(block);
					stream.push({
						type: "thinking_start",
						contentIndex: output.content.length - 1,
						partial: output
					});
				} else if (event.content_block.type === "redacted_thinking") {
					const block = {
						type: "thinking",
						thinking: "[Reasoning redacted]",
						thinkingSignature: event.content_block.data,
						redacted: true,
						index: event.index
					};
					output.content.push(block);
					stream.push({
						type: "thinking_start",
						contentIndex: output.content.length - 1,
						partial: output
					});
				} else if (event.content_block.type === "tool_use") {
					const block = {
						type: "toolCall",
						id: event.content_block.id,
						name: isOAuth ? fromClaudeCodeName(event.content_block.name, context.tools) : event.content_block.name,
						arguments: event.content_block.input ?? {},
						partialJson: "",
						index: event.index
					};
					output.content.push(block);
					stream.push({
						type: "toolcall_start",
						contentIndex: output.content.length - 1,
						partial: output
					});
				}
			} else if (event.type === "content_block_delta") {
				if (event.delta.type === "text_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block && block.type === "text") {
						block.text += event.delta.text;
						stream.push({
							type: "text_delta",
							contentIndex: index,
							delta: event.delta.text,
							partial: output
						});
					}
				} else if (event.delta.type === "thinking_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output
						});
					}
				} else if (event.delta.type === "input_json_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block && block.type === "toolCall") {
						block.partialJson += event.delta.partial_json;
						block.arguments = parseStreamingJson(block.partialJson);
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output
						});
					}
				} else if (event.delta.type === "signature_delta") {
					const block = blocks[blocks.findIndex((b) => b.index === event.index)];
					if (block && block.type === "thinking") {
						block.thinkingSignature = block.thinkingSignature || "";
						block.thinkingSignature += event.delta.signature;
					}
				}
			} else if (event.type === "content_block_stop") {
				const index = blocks.findIndex((b) => b.index === event.index);
				const block = blocks[index];
				if (block) {
					delete block.index;
					if (block.type === "text") stream.push({
						type: "text_end",
						contentIndex: index,
						content: block.text,
						partial: output
					});
					else if (block.type === "thinking") stream.push({
						type: "thinking_end",
						contentIndex: index,
						content: block.thinking,
						partial: output
					});
					else if (block.type === "toolCall") {
						block.arguments = parseStreamingJson(block.partialJson);
						delete block.partialJson;
						stream.push({
							type: "toolcall_end",
							contentIndex: index,
							toolCall: block,
							partial: output
						});
					}
				}
			} else if (event.type === "message_delta") {
				if (event.delta.stop_reason) {
					const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
					output.stopReason = stopReasonResult.stopReason;
					if (stopReasonResult.errorMessage) output.errorMessage = stopReasonResult.errorMessage;
				}
				if (event.usage) {
					if (event.usage.input_tokens != null) output.usage.input = event.usage.input_tokens;
					if (event.usage.output_tokens != null) output.usage.output = event.usage.output_tokens;
					if (event.usage.cache_read_input_tokens != null) output.usage.cacheRead = event.usage.cache_read_input_tokens;
					if (event.usage.cache_creation_input_tokens != null) output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
					const thinkingTokens = event.usage.output_tokens_details?.thinking_tokens;
					if (thinkingTokens != null) output.usage.reasoning = thinkingTokens;
				}
				output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
				calculateCost(model, output.usage);
			}
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "aborted" || output.stopReason === "error") throw new Error(output.errorMessage || "An unknown error occurred");
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
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
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
/**
* Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
* Note: effort "max" is available on all adaptive-thinking Claude models, while native
* "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
*/
function mapThinkingLevelToEffort(model, level) {
	const mapped = level ? model.thinkingLevelMap?.[level] : void 0;
	if (typeof mapped === "string") return mapped;
	switch (level) {
		case "minimal":
		case "low": return "low";
		case "medium": return "medium";
		case "high": return "high";
		default: return "high";
	}
}
const streamSimple = (model, context, options) => {
	assertRequestAuth(model.provider, options?.apiKey, options?.headers);
	const base = buildBaseOptions(model, context, options, options?.apiKey);
	if (!options?.reasoning) return stream(model, context, {
		...base,
		thinkingEnabled: false
	});
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort
		});
	}
	const adjusted = adjustMaxTokensForThinking(base.maxTokens, model.maxTokens, options.reasoning, options.thinkingBudgets);
	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);
	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024))
	});
};
function isOAuthToken(apiKey) {
	return apiKey.includes("sk-ant-oat");
}
function createClient(model, apiKey, interleavedThinking, useFineGrainedToolStreamingBeta, optionsHeaders, dynamicHeaders, sessionId) {
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures = [];
	if (useFineGrainedToolStreamingBeta) betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	if (needsInterleavedBeta) betaFeatures.push(INTERLEAVED_THINKING_BETA);
	if (model.provider === "github-copilot") return {
		client: new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders({
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				...betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}
			}, model.headers, dynamicHeaders, optionsHeaders)
		}),
		isOAuthToken: false
	};
	if (apiKey && isOAuthToken(apiKey)) return {
		client: new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders({
				accept: "application/json",
				"anthropic-dangerous-direct-browser-access": "true",
				"anthropic-beta": [
					"claude-code-20250219",
					"oauth-2025-04-20",
					...betaFeatures
				].join(","),
				"user-agent": `claude-cli/${claudeCodeVersion}`,
				"x-app": "cli"
			}, model.headers, optionsHeaders)
		}),
		isOAuthToken: true
	};
	const sessionAffinityHeaders = sessionId && getAnthropicCompat(model).sendSessionAffinityHeaders ? { "x-session-affinity": sessionId } : {};
	const defaultHeaders = mergeHeaders({
		accept: "application/json",
		"anthropic-dangerous-direct-browser-access": "true",
		...betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}
	}, sessionAffinityHeaders, model.headers, optionsHeaders);
	return {
		client: new Anthropic({
			apiKey: apiKey ?? null,
			authToken: null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders
		}),
		isOAuthToken: false
	};
}
function buildParams(model, context, isOAuthToken, options) {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const normalizeToolName = isOAuthToken ? toClaudeCodeName : (name) => name;
	const toolPlacement = splitDeferredTools({
		...context,
		messages: transformedMessages
	}, compat.supportsToolReferences, normalizeToolName);
	let immediateTools = toolPlacement.immediate;
	let deferredTools = [...toolPlacement.deferred.values()];
	if (immediateTools.length === 0 && deferredTools.length > 0) {
		immediateTools = deferredTools;
		deferredTools = [];
	}
	const deferredToolNames = new Set(deferredTools.map((tool) => normalizeToolName(tool.name)));
	const params = {
		model: model.id,
		messages: convertMessages(transformedMessages, isOAuthToken, cacheControl, compat.allowEmptySignature, deferredToolNames, normalizeToolName),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true
	};
	if (isOAuthToken) {
		params.system = [{
			type: "text",
			text: "You are Claude Code, Anthropic's official CLI for Claude.",
			...cacheControl ? { cache_control: cacheControl } : {}
		}];
		if (context.systemPrompt) params.system.push({
			type: "text",
			text: sanitizeSurrogates(context.systemPrompt),
			...cacheControl ? { cache_control: cacheControl } : {}
		});
	} else if (context.systemPrompt) params.system = [{
		type: "text",
		text: sanitizeSurrogates(context.systemPrompt),
		...cacheControl ? { cache_control: cacheControl } : {}
	}];
	if (options?.temperature !== void 0 && !options?.thinkingEnabled && compat.supportsTemperature) params.temperature = options.temperature;
	if (immediateTools.length > 0 || deferredTools.length > 0) params.tools = [...convertTools(immediateTools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, compat.supportsCacheControlOnTools ? cacheControl : void 0), ...convertTools(deferredTools, isOAuthToken, compat.supportsEagerToolInputStreaming, compat.supportsStrictTools, void 0, true)];
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			const display = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				params.thinking = {
					type: "adaptive",
					display
				};
				if (options.effort) params.output_config = options.effort === "xhigh" ? { effort: options.effort } : { effort: options.effort };
			} else params.thinking = {
				type: "enabled",
				budget_tokens: options.thinkingBudgetTokens || 1024,
				display
			};
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) params.thinking = { type: "disabled" };
	}
	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") params.metadata = { user_id: userId };
	}
	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") params.tool_choice = { type: options.toolChoice };
		else params.tool_choice = options.toolChoice;
	}
	return params;
}
function normalizeToolCallId(id) {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}
function convertToolResult(msg, isOAuthToken, deferredToolNames, loadedToolNames, normalizeToolName) {
	const references = [];
	for (const name of msg.addedToolNames ?? []) {
		const normalizedName = normalizeToolName(name);
		if (!deferredToolNames.has(normalizedName) || loadedToolNames.has(normalizedName)) continue;
		loadedToolNames.add(normalizedName);
		references.push({
			type: "tool_reference",
			tool_name: isOAuthToken ? toClaudeCodeName(name) : name
		});
	}
	const convertedContent = convertContentBlocks(msg.content);
	return {
		toolResult: {
			type: "tool_result",
			tool_use_id: msg.toolCallId,
			content: references.length > 0 ? references : convertedContent,
			is_error: msg.isError
		},
		siblingContent: references.length === 0 ? [] : typeof convertedContent === "string" ? [{
			type: "text",
			text: convertedContent
		}] : convertedContent
	};
}
function convertMessages(transformedMessages, isOAuthToken, cacheControl, allowEmptySignature = false, deferredToolNames = /* @__PURE__ */ new Set(), normalizeToolName = (name) => name) {
	const params = [];
	const loadedToolNames = /* @__PURE__ */ new Set();
	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) params.push({
					role: "user",
					content: sanitizeSurrogates(msg.content)
				});
			} else {
				const filteredBlocks = msg.content.map((item) => {
					if (item.type === "text") return {
						type: "text",
						text: sanitizeSurrogates(item.text)
					};
					else return {
						type: "image",
						source: {
							type: "base64",
							media_type: item.mimeType,
							data: item.data
						}
					};
				}).filter((b) => {
					if (b.type === "text") return b.text.trim().length > 0;
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				params.push({
					role: "user",
					content: filteredBlocks
				});
			}
		} else if (msg.role === "assistant") {
			const blocks = [];
			for (const block of msg.content) if (block.type === "text") {
				if (block.text.trim().length === 0) continue;
				blocks.push({
					type: "text",
					text: sanitizeSurrogates(block.text)
				});
			} else if (block.type === "thinking") {
				if (block.redacted) {
					blocks.push({
						type: "redacted_thinking",
						data: block.thinkingSignature
					});
					continue;
				}
				const thinkingSignature = block.thinkingSignature;
				const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
				if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
				if (!hasThinkingSignature) blocks.push(allowEmptySignature ? {
					type: "thinking",
					thinking: sanitizeSurrogates(block.thinking),
					signature: ""
				} : {
					type: "text",
					text: sanitizeSurrogates(block.thinking)
				});
				else blocks.push({
					type: "thinking",
					thinking: sanitizeSurrogates(block.thinking),
					signature: thinkingSignature
				});
			} else if (block.type === "toolCall") blocks.push({
				type: "tool_use",
				id: block.id,
				name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
				input: block.arguments ?? {}
			});
			if (blocks.length === 0) continue;
			params.push({
				role: "assistant",
				content: blocks
			});
		} else if (msg.role === "toolResult") {
			const toolResults = [];
			const siblingContent = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const converted = convertToolResult(transformedMessages[j], isOAuthToken, deferredToolNames, loadedToolNames, normalizeToolName);
				toolResults.push(converted.toolResult);
				siblingContent.push(...converted.siblingContent);
				j++;
			}
			i = j - 1;
			params.push({
				role: "user",
				content: [...toolResults, ...siblingContent]
			});
		}
	}
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (lastBlock && (lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")) lastBlock.cache_control = cacheControl;
			} else if (typeof lastMessage.content === "string") lastMessage.content = [{
				type: "text",
				text: lastMessage.content,
				cache_control: cacheControl
			}];
		}
	}
	return params;
}
function shouldUseFineGrainedToolStreamingBeta(model, context) {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}
function convertTools(tools, isOAuthToken, supportsEagerToolInputStreaming, supportsStrictTools, cacheControl, deferLoading = false) {
	if (!tools) return [];
	return tools.map((tool, index) => {
		const strict = resolveJsonSchemaStrictSampling(tool, supportsStrictTools);
		const schema = tool.parameters;
		const legacyInputSchema = {
			type: "object",
			properties: schema.properties ?? {},
			required: schema.required ?? []
		};
		const inputSchema = strict === true ? {
			...tool.parameters,
			...legacyInputSchema
		} : legacyInputSchema;
		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {},
			...strict === true ? { strict: true } : {},
			input_schema: inputSchema,
			...deferLoading ? { defer_loading: true } : {},
			...cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}
		};
	});
}
function mapStopReason(reason, stopDetails) {
	switch (reason) {
		case "end_turn": return { stopReason: "stop" };
		case "max_tokens": return { stopReason: "length" };
		case "tool_use": return { stopReason: "toolUse" };
		case "refusal": return {
			stopReason: "error",
			errorMessage: stopDetails?.explanation || `The model refused to complete the request`
		};
		case "pause_turn": return { stopReason: "stop" };
		case "stop_sequence": return { stopReason: "stop" };
		case "sensitive": return { stopReason: "error" };
		default: throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
//#endregion
export { stream, streamSimple };
