import { C as parseWorkBuddyAuth, S as keyHash, T as workbuddyOwnAuthPath, _ as WORKBUDDY_AUTH_FILE_ENV, a as readHostHeartbeat, b as defaultDesktopAuthCandidates, d as normalizeCredits, f as prepareChatBody, g as WORKBUDDY_AUTH_FILENAME, h as WorkBuddyCatalog, i as processStartTimeMs, l as WorkBuddyUpstreamClient, m as FALLBACK_WORKBUDDY_MODELS, n as clearHostHeartbeat, o as workbuddyHostHeartbeatPath, p as regionOf, r as isHeartbeatProcessAlive, s as writeHostHeartbeat, t as WORKBUDDY_HOST_HEARTBEAT_FILENAME, u as classifyUpstreamError, v as WorkBuddyAccountManager, w as workbuddyAccountDir, x as defaultDesktopAuthPath, y as WorkBuddyCredentialStore } from "./host-heartbeat-qowTH6eb.js";
import z from "@deepseek-ai/schemastery";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { Readable } from "node:stream";
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
			const who = entry.nickname ?? entry.key;
			const account = {
				key: entry.key,
				label: `${keyHash(entry.key)} · ${who}`,
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
		settingsCtx.settings.installSection(ctx, WORKBUDDY_SETTINGS_NS, Config, config, sectionHooks);
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
