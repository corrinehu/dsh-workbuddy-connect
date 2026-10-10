import { readFile, rm, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
//#region src/app-version.ts
/**
* The international desktop app's version, used as the `/v3/config` UA.
*
* The App-shaped catalog is served only to a User-Agent carrying the product
* name (see `docs/workbuddy-ai-international-research-2026-09-11.md` §2.7).
* That document's conclusion recommended the space form `WorkBuddy AI/<v>`;
* re-measured on 2026-09-11 the *space* form is rejected (HTTP 400, code
* 12403) while the terse `WorkBuddyAI/<v>` form — with or without the space
* removed — returns the 21-model App document. The UA is therefore built from
* the form verified in code, not from the earlier prose.
*
* The version feeds the international catalog UA and the chat identity's
* `X-IDE-Version`: a missing App, an unreadable plist, or a bad cached value
* degrades to the last saved value and finally to a compiled-in constant, and
* never blocks credential use or the provider.
*
* @module dsh-workbuddy-connect/app-version
*/
/**
* Last-resort UA version.
*
* The gateway ignores the version number when splitting the UA (research §2.7.2
* item 2: `CLI/1.0.0`, `CLI/99.0.0` and the real version all return the same
* document), so this constant is a shape requirement rather than a currency
* claim. It is *not* used to infer anything about model capabilities.
*/
const FALLBACK_APP_VERSION = "5.5.2";
/** Basename of the saved version under `$DSH_HOME`. */
const WORKBUDDY_APP_VERSION_FILENAME = ".workbuddy-ai-version.json";
/**
* Whether a string is safe to interpolate into an HTTP header.
*
* Strict on purpose: the value reaches a header, so anything that could split
* the request (CR, LF, spaces beyond the separator) or inject a second UA
* token must never pass. The App's own version is always `N.N.N` or `N.N.N.N`.
*/
function validAppVersion(value) {
	return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value);
}
/** macOS App-bundle roots: system-wide first, then the user's own install. */
function macAppRoots$1() {
	return ["/Applications", join(homedir(), "Applications")];
}
/**
* Read `CFBundleShortVersionString` out of an `Info.plist`.
*
* Parsed as XML rather than grepped, because the plist contains several
* `<string>` values and a regex would be one unrelated key away from
* returning the wrong one. A binary plist has no `<dict>` in its bytes and is
* reported as unreadable (the saved value then applies) rather than guessed at.
*/
async function readBundleVersion(plistPath) {
	let text;
	try {
		text = await readFile(plistPath, "utf8");
	} catch {
		return;
	}
	const version = /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>([^<]*)<\/string>/u.exec(text)?.[1]?.trim();
	return validAppVersion(version) ? version : void 0;
}
/**
* The installed international App's version, or `undefined` when it is not
* installed (or not readable).
*
* Windows and Linux have no verified bundle-metadata location yet, so this
* returns `undefined` there and the saved/fallback value is used instead of
* guessing a path — the same discipline the credential discovery follows.
*/
async function installedAppVersion() {
	if (process.platform !== "darwin") return void 0;
	for (const root of macAppRoots$1()) {
		const bundle = join(root, "WorkBuddy AI.app");
		const version = await readBundleVersion(join(bundle, "Contents", "Info.plist"));
		if (version !== void 0) return {
			version,
			bundle
		};
	}
}
/** Saved-version file path under the Harness home. */
function appVersionPath() {
	return join(resolveDshHome(), WORKBUDDY_APP_VERSION_FILENAME);
}
/**
* Resolve the UA version: installed App first, then the last saved value, then
* the compiled-in fallback.
*
* A value read from the App is written back immediately, so an uninstalled App
* or an unreadable plist later still has the last real version to fall back
* on. The write is best-effort: failing to cache a version must never fail the
* catalog request that asked for it.
*/
async function resolveAppVersion(options = {}) {
	const path = options.path ?? appVersionPath();
	const installed = await (options.installed ?? installedAppVersion)();
	if (installed !== void 0 && validAppVersion(installed.version)) {
		try {
			await writeFileAtomic(path, `${JSON.stringify({
				version: installed.version,
				bundle: installed.bundle,
				observedAt: Date.now()
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		} catch {}
		return {
			version: installed.version,
			source: "installed",
			bundle: installed.bundle
		};
	}
	try {
		const saved = JSON.parse(await readFile(path, "utf8"));
		if (typeof saved === "object" && saved !== null) {
			const version = saved["version"];
			if (validAppVersion(version)) return {
				version,
				source: "saved"
			};
		}
	} catch {}
	return {
		version: FALLBACK_APP_VERSION,
		source: "fallback"
	};
}
/**
* Build the App-shaped User-Agent for catalog requests.
*
* `WorkBuddyAI/<version>` with no space is the form measured to reach the App
* document; the space form is rejected with 400/12403. Throws on an invalid
* version rather than sending a malformed header.
*/
function appUserAgent(version) {
	if (!validAppVersion(version)) throw new Error(`invalid WorkBuddy AI version for User-Agent: ${JSON.stringify(version)}`);
	return `WorkBuddyAI/${version}`;
}
//#endregion
//#region src/client-identity.ts
/**
* The desktop-client identity chat requests present as (phase 1 of
* `docs/upstream-identity-alignment-plan.md`).
*
* Chat and its probe sibling carry the User-Agent shape the official desktop
* client composes — `WorkBuddy/<v> <product>/<v> CLI/<cli>` — where the
* product token names the app that owns the region's requests: `WorkBuddy`
* for CN, `WorkBuddy AI` for international. Versions come from the installed
* App when it can be read, degrade to a per-region saved value, and finally
* to a compiled-in constant. A CLI version that does not resolve drops the
* `CLI/…` token instead of inventing one (the official client's own rule for
* a missing extension).
*
* Scope: chat and probe requests ONLY. Refresh, catalog, and billing keep
* the headers they have always sent; the plan holds the blast radius to this
* one variable so the live verification matrix stays readable.
*
* @module dsh-workbuddy-connect/client-identity
*/
/**
* Compiled-in CN fallback for the `WorkBuddy/<v>` tokens.
*
* Observed on the CN desktop app installed here (research §3.1, verified
* 2026-09-11); like the international fallback it is a shape requirement,
* not a currency claim — the gateway has not been observed to branch on it.
*/
const FALLBACK_CN_APP_VERSION = "5.5.6";
/**
* Basename of the CN saved-version cache under `$DSH_HOME`.
*
* Deliberately not the international `.workbuddy-ai-version.json`: that file
* feeds the international catalog's User-Agent, and a CN App writing its
* version into it would relabel that request. The two caches stay isolated
* the way the per-variant catalog files are.
*/
const CN_APP_VERSION_FILENAME = ".workbuddy-app-version.json";
/**
* Whether a value is a CLI version that may reach a header.
*
* Tolerates a prerelease suffix (`2.137.1-rc.1`) because the bundled CLI's
* own metadata uses that spelling; anything with whitespace, CR or LF never
* passes — the value is interpolated into an HTTP header.
*/
function validCliVersion(value) {
	return typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}(?:-[0-9A-Za-z.]+)?$/u.test(value);
}
/** macOS App-bundle roots, searched in the order `app-version.ts` uses. */
function macAppRoots() {
	return ["/Applications", join(homedir(), "Applications")];
}
/** Path of the bundled agent CLI's package.json inside an App bundle. */
function cliPackagePath(bundle) {
	return join(bundle, "Contents", "Resources", "app.asar.unpacked", "cli", "package.json");
}
/**
* The bundled agent CLI's real version, or `undefined` when it does not resolve.
*
* `cli/package.json` ships a `0.0.0` placeholder in `version` with the real
* version in `publishConfig.customPackage.version`; a valid non-placeholder
* `version` wins, otherwise the custom-package value applies, and unreadable
* or invalid metadata yields `undefined` (the caller drops the `CLI/…` UA
* token rather than guessing).
*/
async function readCliVersion(bundle) {
	let document;
	try {
		document = JSON.parse(await readFile(cliPackagePath(bundle), "utf8"));
	} catch {
		return;
	}
	if (typeof document !== "object" || document === null || Array.isArray(document)) return void 0;
	const pkg = document;
	const declared = pkg["version"];
	if (validCliVersion(declared) && declared !== "0.0.0") return declared;
	const publishConfig = pkg["publishConfig"];
	const customPackage = typeof publishConfig === "object" && publishConfig !== null && !Array.isArray(publishConfig) ? publishConfig : void 0;
	const customVersion = (typeof customPackage?.["customPackage"] === "object" && customPackage["customPackage"] !== null && !Array.isArray(customPackage["customPackage"]) ? customPackage["customPackage"] : void 0)?.["version"];
	return validCliVersion(customVersion) ? customVersion : void 0;
}
/**
* Build the chat User-Agent for one region.
*
* Throws on an invalid version rather than interpolating one into a header;
* `resolveChatIdentity` never produces such an identity, so the throw is a
* last gate against future call-site mistakes, not an expected path.
*/
function chatUserAgent(identity, region) {
	if (!validAppVersion(identity.clientVersion)) throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`);
	if (identity.cliVersion !== void 0 && !validCliVersion(identity.cliVersion)) throw new Error(`invalid CLI version for chat User-Agent: ${JSON.stringify(identity.cliVersion)}`);
	const product = region === "global" ? "WorkBuddy AI" : "WorkBuddy";
	const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`];
	if (identity.cliVersion !== void 0) parts.push(`CLI/${identity.cliVersion}`);
	return parts.join(" ");
}
/** The installed CN desktop bundle, or `undefined` when it is not installed (or not readable). */
async function installedCnApp() {
	if (process.platform !== "darwin") return void 0;
	for (const root of macAppRoots()) {
		const bundle = join(root, "WorkBuddy.app");
		const version = await readBundleVersion(join(bundle, "Contents", "Info.plist"));
		if (version !== void 0) return {
			version,
			bundle
		};
	}
}
/** Default CN saved-cache path. */
function cnSavedVersionPath() {
	return join(resolveDshHome(), CN_APP_VERSION_FILENAME);
}
/**
* Resolve the chat identity for one region: installed App → region's saved
* value → compiled-in fallback. Never throws — a missing App, an unreadable
* plist, a failed cache write, or a reader that throws outright all degrade
* to {@link fallbackChatIdentity}; resolution never blocks a message.
*
* The production path caches per region (a message must not re-read the
* install tree); any injected option bypasses the cache entirely so tests
* with different readers cannot observe each other's resolutions.
*/
async function resolveChatIdentity(region, options = {}) {
	const injectable = options.installedCn !== void 0 || options.resolveIntl !== void 0 || options.cliVersion !== void 0 || options.cnSavedPath !== void 0;
	if (!injectable) {
		const cached = cache.get(region);
		if (cached !== void 0) return cached;
	}
	let identity;
	try {
		identity = region === "global" ? await resolveGlobalIdentity(options) : await resolveCnIdentity(options);
	} catch {
		return fallbackChatIdentity(region);
	}
	if (!injectable) cache.set(region, identity);
	return identity;
}
const cache = /* @__PURE__ */ new Map();
/**
* The region's compiled-in fallback identity: the desktop form with the
* built-in version and no `CLI/…` segment. This is the single degraded
* shape every failure path converges on — a thrown reader, an unreadable
* bundle, or a missing cache all present this, never the legacy CLI UA.
*/
function fallbackChatIdentity(region) {
	return { clientVersion: region === "global" ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION };
}
/** CN: installed `WorkBuddy.app` → CN saved cache → CN fallback. */
async function resolveCnIdentity(options) {
	const savedPath = options.cnSavedPath ?? cnSavedVersionPath();
	const installed = await (options.installedCn ?? installedCnApp)();
	if (installed !== void 0 && validAppVersion(installed.version)) {
		const cliVersion = await (options.cliVersion ?? readCliVersion)(installed.bundle);
		const identity = {
			clientVersion: installed.version,
			...cliVersion !== void 0 && validCliVersion(cliVersion) ? { cliVersion } : {}
		};
		try {
			await writeFileAtomic(savedPath, `${JSON.stringify({
				version: identity.clientVersion,
				observedAt: Date.now()
			}, null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		} catch {}
		return identity;
	}
	try {
		const saved = JSON.parse(await readFile(savedPath, "utf8"));
		if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
			const document = saved;
			if (validAppVersion(document["version"])) return { clientVersion: document["version"] };
		}
	} catch {}
	return fallbackChatIdentity("cn");
}
/**
* International: reuse `app-version.ts`'s installed → saved → fallback chain
* (its cache format and the catalog's version source stay untouched). The
* CLI version is read only when that chain reports the installed bundle; a
* saved or fallback resolution has no bundle path and drops the `CLI/…` token.
* The CN cache is never read or written on this path.
*/
async function resolveGlobalIdentity(options) {
	const info = await (options.resolveIntl ?? resolveAppVersion)();
	const clientVersion = validAppVersion(info.version) ? info.version : FALLBACK_APP_VERSION;
	let cliVersion;
	if (info.bundle !== void 0) {
		const read = await (options.cliVersion ?? readCliVersion)(info.bundle);
		if (read !== void 0 && validCliVersion(read)) cliVersion = read;
	}
	return {
		clientVersion,
		...cliVersion === void 0 ? {} : { cliVersion }
	};
}
//#endregion
//#region src/probe.ts
/**
* The reasoning-effort probe: decide whether a model's `reasoning_effort`
* parameter is actually validated, and if so which canonical values it accepts.
*
* Implements `docs/reasoning-effort-probe-plan.md` §4. The order matters and is
* not an optimization:
*
* 1. **Baseline** (no `reasoning_effort`) proves the model, credential, and
*    request shape work at all, so a later rejection can be attributed.
* 2. **Sentinel** (a fresh random, impossible-to-collide value) answers the one
*    question a per-level sweep cannot: does the upstream validate the field?
*    A model that accepts the sentinel answers 200 to *everything*, so its
*    per-level results would be uniformly false positives.
* 3. **Levels**, only after the sentinel was refused.
*
* The result is an observation, never a capability claim. Even a fully
* successful sweep means "the upstream accepted these spellings", not "these
* spellings change how the model thinks".
*
* @module dsh-workbuddy-connect/probe
*/
/**
* The canonical values a probe tests, in a fixed order.
*
* `minimal` is absent: it appears in no upstream vocabulary. `off` is absent
* by policy — disabling thinking is a separate capability the upstream must
* declare through `canDisableThinking`, never something probing may infer.
*/
const PROBE_EFFORT_CANDIDATES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Prompt body used by every probe request; carries nothing user-specific. */
const PROBE_PROMPT = "ping";
/** Default sentinel: unmistakably non-canonical, different on every call. */
function randomSentinel() {
	return `probe_sentinel_${randomBytes(12).toString("hex")}`;
}
/**
* The upstream's "this effort value is not supported" codes, per region, as
* measured on each live endpoint. The sets are kept separate so a code only
* ever widens detection for the endpoint it was measured on.
*
* - `invalid_reasoning_effort` — the China endpoint, measured 2026-09-11
*   (plan §4.2). Also kept for `global` as a fallback spelling.
* - `model_param_invalid` — the global endpoint, measured 2026-10-01. A
*   non-canonical value is answered `400` / `11133` with this code, which names
*   no field (`extError.param` is empty), instead of one that names the effort.
*   It is generic enough to be readable here only because the baseline step has
*   already proved the *same* request without `reasoning_effort` succeeds,
*   leaving the sentinel as the only difference between the two attempts. A
*   sibling code in the same `11133` envelope that names another parameter
*   (`integer_below_min_value`, the `max_tokens` floor) and a body carrying no
*   `extError` at all (`11102`, unknown model) are therefore not mistaken for
*   it, and neither is a level-sweep answer. It is *not* added to `cn`: that
*   endpoint was measured answering the specific code, and reading a generic
*   code there would widen attribution beyond what was observed.
*
* Neither is treated as a permanent protocol promise: anything unrecognized
* still degrades to `unknown` rather than to a capability conclusion.
*/
const INVALID_EFFORT_CODES = {
	cn: /* @__PURE__ */ new Set(["invalid_reasoning_effort"]),
	global: /* @__PURE__ */ new Set(["invalid_reasoning_effort", "model_param_invalid"])
};
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt, region) {
	const codes = INVALID_EFFORT_CODES[region];
	return attempt.status === 400 && attempt.errorCode !== void 0 && codes.has(attempt.errorCode);
}
/** Whether an attempt shows the upstream accepted the request and streamed. */
function isAcceptance(attempt) {
	return attempt.status === 200 && attempt.streamed;
}
/** Why an attempt ended in `unknown`, phrased for a log line. */
function unknownReason(stage, attempt) {
	const code = attempt.errorCode === void 0 ? "" : ` (${attempt.errorCode})`;
	const detail = attempt.detail === void 0 ? "" : `: ${attempt.detail}`;
	return `${stage} status ${attempt.status}${code}${detail}`;
}
/**
* Probe one model.
*
* `options.candidates` exists so tests can shorten the sweep; production always
* uses {@link PROBE_EFFORT_CANDIDATES}. `options.region` selects which
* endpoint's rejection vocabulary is read; it defaults to `cn`, which is also
* the production default for the China app.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
	const region = options.region ?? "cn";
	let requests = 0;
	const attempt = async (effort) => {
		requests += 1;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			return await options.send(effort, controller.signal);
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		} finally {
			clearTimeout(timer);
		}
	};
	const baseline = await attempt(void 0);
	if (!isAcceptance(baseline)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("baseline", baseline)
	};
	const sentinelAttempt = await attempt(sentinel());
	if (isAcceptance(sentinelAttempt)) return {
		validation: "non-validating",
		efforts: [],
		requests
	};
	if (!isEffortRejection(sentinelAttempt, region)) return {
		validation: "unknown",
		efforts: [],
		requests,
		reason: unknownReason("sentinel", sentinelAttempt)
	};
	const accepted = [];
	for (const effort of candidates) {
		const levelAttempt = await attempt(effort);
		if (isAcceptance(levelAttempt)) {
			accepted.push(effort);
			continue;
		}
		if (isEffortRejection(levelAttempt, region)) continue;
		return {
			validation: "unknown",
			efforts: [],
			requests,
			reason: unknownReason(`level ${effort}`, levelAttempt)
		};
	}
	return {
		validation: "validating",
		efforts: accepted,
		requests
	};
}
//#endregion
//#region src/upstream.ts
/**
* WorkBuddy (CodeBuddy / copilot.tencent.com) upstream client: chat streaming,
* token refresh, model catalog, and credit balance. The wire behavior is
* ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
* battle-tested against the real endpoint.
*
* @module dsh-workbuddy-connect/upstream
*/
const CN_CHAT_BASE = "https://copilot.tencent.com";
const CN_BILLING_BASE = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
/**
* Display name for the single synthetic row the enterprise endpoint produces.
*
* The endpoint reports one cycle quota, not the personal endpoint's list of
* named packages, so the card's "by package" table has exactly one row.
*/
const enterprisePackageName = "enterprise";
/**
* Field names and value types of a response document, for diagnostics.
*
* Names and `typeof` only. This string ends up in the status route and then in
* the browser, and the response describes the account's own usage; the values
* themselves must never travel. Only the document and its `data` member are
* described, so the output stays small.
*/
function describeShape(document) {
	if (typeof document !== "object" || document === null || Array.isArray(document)) return typeof document;
	const record = document;
	const at = (source) => {
		const keys = Object.keys(source).slice(0, 24);
		return keys.length === 0 ? "(empty)" : keys.map((key) => `${key}:${typeof source[key]}`).join(", ");
	};
	const top = `top-level { ${at(record)} }`;
	const data = record["data"];
	if (typeof data !== "object" || data === null || Array.isArray(data)) return top;
	return `${top}; data { ${at(data)} }`;
}
/** Shared CLI-form User-Agent for refresh and the CN catalog; chat and probe present the desktop identity (client-identity.ts). */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 3e4;
const ERROR_BODY_LIMIT = 4096;
/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
	"insufficient credit",
	"no credit",
	"credit exhausted",
	"credits exhausted",
	"out of credit",
	"quota exceeded",
	"quota exhaust",
	"payment required",
	"credit not enough",
	"not enough credit",
	"积分不足",
	"额度不足",
	"余额不足",
	"积分用完",
	"额度用尽",
	"没有积分"
];
/** The concrete effort spellings WorkBuddy exposes on the wire. */
const EFFORT_VALUES = [
	"low",
	"medium",
	"high",
	"xhigh",
	"max"
];
/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";
/** Parse the upstream `reasoning` object into {@link WorkBuddyModelReasoning}. */
function resolveUpstreamReasoning(wrapped) {
	const supports = wrapped["supportsReasoning"] === true;
	const onlyReasoning = wrapped["onlyReasoning"] === true;
	const rawReasoning = wrapped["reasoning"];
	let supportedEfforts;
	let defaultEffort;
	let canDisableThinking = true;
	if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
		const reasoning = rawReasoning;
		const rawEfforts = reasoning["supportedEfforts"];
		if (Array.isArray(rawEfforts)) {
			const efforts = rawEfforts.filter((value) => typeof value === "string" && EFFORT_VALUES.includes(value));
			if (efforts.length > 0) supportedEfforts = efforts;
		}
		if (typeof reasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(reasoning["defaultEffort"])) defaultEffort = reasoning["defaultEffort"];
		else if (typeof reasoning["effort"] === "string" && EFFORT_VALUES.includes(reasoning["effort"])) defaultEffort = reasoning["effort"];
		canDisableThinking = reasoning["canDisableThinking"] === true;
	}
	return { reasoning: {
		supports,
		onlyReasoning,
		...supportedEfforts === void 0 ? {} : { supportedEfforts },
		...defaultEffort === void 0 ? {} : { defaultEffort },
		canDisableThinking
	} };
}
/**
* Reduce an upstream credits string to its language-neutral display form.
*
* The host LLM seam carries this text to the browser, and the host has no
* locale service — whatever string is produced here is shown verbatim in every
* UI language. The upstream is inconsistent in a way that matters: some catalog
* rows report a bare multiplier (`x0.79`) and others append a unit word
* (`x0.79 credits`), and the unit word would pin the display to English.
* Dropping a trailing `credits` (case-insensitive, singular or plural) yields
* the one spelling that reads identically in every language.
*
* @param credits - raw upstream credits string, e.g. `"x0.79 credits"`.
* @returns the bare multiplier, or undefined when nothing displayable remains.
*/
function normalizeCredits(credits) {
	if (credits === void 0) return void 0;
	const trimmed = credits.trim();
	if (trimmed === "") return void 0;
	if (/^credits?$/iu.test(trimmed)) return void 0;
	const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
	return bare === "" ? void 0 : bare;
}
/**
* Parse the upstream `tags` / `credits` fields into billing metadata.
*
* @param wrapped - one catalog row.
* @param extraTags - badge tags recovered from another document, merged in
* after the row's own. The `/v3/config` product document carries the roster
* but no `badge:*` tags; those live only in the console catalog, so the CN
* refresh reads both and joins them here (see `fetchPromoBadges`).
*/
function resolveUpstreamBilling(wrapped, extraTags) {
	const rawCredits = wrapped["credits"];
	const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : void 0;
	const badges = [];
	const rawTags = [...Array.isArray(wrapped["tags"]) ? wrapped["tags"] : [], ...extraTags ?? []];
	for (const tag of rawTags) {
		if (typeof tag !== "string") continue;
		if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
		const label = tag.slice(6).split(":")[0] ?? tag.slice(6);
		if (label !== "" && !badges.includes(label)) badges.push(label);
	}
	const multiplier = normalizeCredits(credits);
	const free = multiplier !== void 0 && /^x?0\.0+$/u.test(multiplier);
	return { billing: {
		...credits === void 0 ? {} : { credits },
		...badges.length === 0 ? {} : { badges },
		free
	} };
}
/** Session-invalidation markers that mean "sign in again in the WorkBuddy app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];
/** Classify an upstream failure from its HTTP status and body excerpt. */
function classifyUpstreamError(status, body) {
	if (status === 402) return "hard_credit";
	if (status === 401) return "session_dead";
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
}
/**
* Extract a user-facing error message from an upstream JSON response body.
* Prefers WorkBuddy's localized `displayMsg.zh` / `displayMsg.en`, falling back to `msg`.
*/
function extractDisplayErrorMessage(body) {
	const trimmed = body.trim();
	if (!trimmed.startsWith("{")) return void 0;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
		const obj = parsed;
		const displayMsg = obj["displayMsg"];
		if (typeof displayMsg === "object" && displayMsg !== null && !Array.isArray(displayMsg)) {
			const localized = displayMsg;
			if (typeof localized["zh"] === "string" && localized["zh"].trim() !== "") return localized["zh"].trim();
			if (typeof localized["en"] === "string" && localized["en"].trim() !== "") return localized["en"].trim();
		}
		if (typeof obj["msg"] === "string" && obj["msg"].trim() !== "") return obj["msg"].trim();
	} catch {}
}
/** Region for a login domain; an empty domain means CN (matching upstream tooling). */
function regionOf(domain) {
	const lowered = domain.trim().toLowerCase();
	if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
	return "cn";
}
function chatBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
function billingBase(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
function originReferer(credential) {
	return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
/** Headers every upstream request shares. */
function commonHeaders(credential) {
	return {
		"Accept": "application/json, text/plain, */*",
		"X-Requested-With": "XMLHttpRequest",
		"Origin": originReferer(credential),
		"Referer": `${originReferer(credential)}/`,
		"User-Agent": CLIENT_UA
	};
}
/**
* Chat request headers, including the X-No-* conventions the official CLI uses.
*
* `userAgent` and `clientVersion` carry the same resolved desktop identity for
* chat and probe requests. Refresh shares `commonHeaders` but never this
* override, so the two paths cannot drift into each other.
*/
function chatHeaders(credential, userAgent, clientVersion) {
	return {
		...commonHeaders(credential),
		"User-Agent": userAgent,
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
		"X-IDE-Type": "WorkBuddy",
		"X-IDE-Name": "WorkBuddy",
		"X-IDE-Version": clientVersion,
		"X-Product": "SaaS"
	};
}
/** Refresh-endpoint headers; X-Refresh-Token appears here and nowhere else. */
function refreshHeaders(credential) {
	const headers = {
		...commonHeaders(credential),
		"X-Refresh-Token": credential.refreshToken,
		"X-Auth-Refresh-Source": "workbuddy"
	};
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") headers["X-Enterprise-Id"] = credential.enterpriseId;
	return headers;
}
/** Billing request headers. */
function billingHeaders(credential) {
	const headers = {
		"Authorization": `Bearer ${credential.accessToken}`,
		"Accept": "application/json",
		"Content-Type": "application/json"
	};
	if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
	if (credential.enterpriseId !== void 0 && credential.enterpriseId !== "") {
		headers["X-Enterprise-Id"] = credential.enterpriseId;
		headers["X-Tenant-Id"] = credential.enterpriseId;
	}
	if (credential.domain !== "") headers["X-Domain"] = credential.domain;
	return headers;
}
/**
* Normalize an OpenAI chat-completions body for the WorkBuddy upstream:
* force `stream: true` (the upstream rejects non-streaming), flatten
* `tool_choice` (the upstream's field is a string; object forms return 400),
* and rewrite `developer` messages as `system`.
*
* The `developer` rewrite is load-bearing: pi-ai emits the system prompt as
* `role: "developer"` (the OpenAI convention it adopted), but the WorkBuddy
* upstream rejects that role with HTTP 400 code 11128 ("Illegal API
* invocation from an unapproved channel"). Rewriting to `system` is the
* compatible spelling the upstream accepts.
*/
function prepareChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (typeof body !== "object" || body === null || Array.isArray(body)) return source;
	const obj = body;
	obj["stream"] = true;
	normalizeDeveloperRole(obj);
	normalizeToolChoice(obj);
	return JSON.stringify(obj);
}
/** Rewrite `role: "developer"` messages to `role: "system"` (upstream rejects developer). */
function normalizeDeveloperRole(obj) {
	const messages = obj["messages"];
	if (!Array.isArray(messages)) return;
	for (const message of messages) {
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const wrapped = message;
		if (wrapped["role"] === "developer") wrapped["role"] = "system";
	}
}
/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
	const suppress = () => {
		delete obj["tools"];
		delete obj["functions"];
	};
	if (!("tool_choice" in obj)) return;
	const choice = obj["tool_choice"];
	if (typeof choice === "string") {
		if (choice.trim().toLowerCase() === "none") {
			delete obj["tool_choice"];
			suppress();
		}
		return;
	}
	if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
		const wrapped = choice;
		const type = typeof wrapped["type"] === "string" ? wrapped["type"].trim().toLowerCase() : "";
		if (type === "none") {
			delete obj["tool_choice"];
			suppress();
		} else if (type === "auto" || type === "required") obj["tool_choice"] = type;
		else if (type === "function") {
			const fn = typeof wrapped["function"] === "object" && wrapped["function"] !== null ? wrapped["function"] : void 0;
			let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
			if (name === "" && typeof wrapped["name"] === "string") name = wrapped["name"];
			name = name.trim();
			obj["tool_choice"] = name !== "" ? name : "auto";
		} else delete obj["tool_choice"];
		return;
	}
	delete obj["tool_choice"];
}
async function readEnvelope(response) {
	const text = await response.text();
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`workbuddy upstream returned non-JSON (http ${response.status}): ${text.slice(0, 160)}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`workbuddy upstream returned an unexpected document (http ${response.status})`);
	const document = parsed;
	return {
		code: typeof document["code"] === "number" ? document["code"] : 0,
		msg: typeof document["msg"] === "string" ? document["msg"] : "",
		data: "data" in document ? document["data"] : void 0,
		document
	};
}
/** Fail an envelope whose business code is non-zero, classified like HTTP errors. */
function envelopeError(status, envelope) {
	const kind = classifyUpstreamError(status, envelope.msg);
	return /* @__PURE__ */ new Error(`workbuddy upstream ${kind} (http ${status}): ${envelope.msg.slice(0, 160)}`);
}
/**
* Parse the billing response's `CycleEndTime` into epoch milliseconds.
*
* The upstream sends a zone-less timestamp (`YYYY-MM-DD HH:mm:ss`). This reads it
* as the running machine's local time, which is what the official desktop client
* does — it feeds the same field straight to `new Date(value).getTime()`. That
* makes the plugin agree with the app on the same machine; it is **not** evidence
* of which zone the server or the account uses, which remains unestablished.
*
* A naive read does mean a machine in a different zone than the account's gets a
* shifted instant. That is accepted here rather than guessed at: inventing an
* offset would be asserting a zone nobody has verified.
*
* @returns Epoch milliseconds, or undefined when absent, malformed, or not a real
* calendar moment (see the round-trip check below).
*/
function parseCycleEndTime(value) {
	if (typeof value !== "string" || value.trim() === "") return void 0;
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/u.exec(value.trim());
	if (match === null) return void 0;
	const [, y, mo, d, h, mi, s] = match;
	const [year, month, day, hour, minute, second] = [
		y,
		mo,
		d,
		h,
		mi,
		s
	].map(Number);
	const date = new Date(year, month - 1, day, hour, minute, second);
	const parsed = date.getTime();
	if (!Number.isFinite(parsed)) return void 0;
	if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getHours() !== hour || date.getMinutes() !== minute || date.getSeconds() !== second) return;
	return parsed;
}
/** Empty bucket, used whenever no account qualifies. */
const NO_EXPIRING_CREDIT = {
	total: 0,
	packages: 0
};
/**
* Sum the credit lapsing within `horizonMs` of `nowMs`.
*
* Only positive balances count: a package with nothing left is not a loss, and
* including it would make every long-lived account look permanently at risk.
* Only *future* expiries count too — a package already past its end time would
* otherwise satisfy every forward horizon at once (`end - now` is negative,
* hence "within 24 hours"), making a long-dead package look permanently
* imminent. See {@link WorkBuddyCreditExpiry} for why the past is not reported.
*/
function expiringWithin(accounts, nowMs, horizonMs) {
	return sumExpiring(accounts, (end) => end > nowMs && end - nowMs <= horizonMs);
}
/** Shared accumulator over accounts whose end time passes `matches`. */
function sumExpiring(accounts, matches) {
	let total = 0;
	let packages = 0;
	let earliestEndTimeMs;
	for (const account of accounts) {
		const end = account.endTimeMs;
		if (end === void 0 || account.remain <= 0) continue;
		if (!matches(end)) continue;
		total += account.remain;
		packages += 1;
		if (earliestEndTimeMs === void 0 || end < earliestEndTimeMs) earliestEndTimeMs = end;
	}
	if (packages === 0) return NO_EXPIRING_CREDIT;
	return {
		total,
		packages,
		...earliestEndTimeMs === void 0 ? {} : { earliestEndTimeMs }
	};
}
/**
* Bucket an account's credit by how soon it lapses.
*
* Returns undefined when no account carried a usable end time, so a caller can
* tell "nothing is expiring" apart from "we never learned when anything
* expires" — the second must not render as reassurance.
*/
function summariseExpiry(accounts, nowMs) {
	if (!accounts.some((account) => account.endTimeMs !== void 0)) return {};
	const DAY = 864e5;
	return { expiry: {
		within24h: expiringWithin(accounts, nowMs, DAY),
		within3d: expiringWithin(accounts, nowMs, 3 * DAY),
		within7d: expiringWithin(accounts, nowMs, 7 * DAY)
	} };
}
/**
* Upstream HTTP client. One instance serves the whole plugin; requests take
* the credential explicitly so token refreshes apply on the next call.
*
* One instance is *per variant*: the international provider needs its own
* catalog source, UA version, and probe differences, and keeping them on the
* instance avoids passing a variant through every call signature.
*/
var WorkBuddyUpstreamClient = class {
	/**
	* Resolves the App-shaped UA version for international catalog requests.
	* Injectable so tests never read the real filesystem.
	*/
	resolveAppVersion;
	/** Chat-identity resolver; see {@link WorkBuddyUpstreamClientOptions.resolveChatIdentity}. */
	resolveChatIdentity;
	/** Provenance of the most recent successful catalog fetch, for the card. */
	lastCatalog;
	constructor(options = {}) {
		this.resolveAppVersion = options.resolveAppVersion ?? (() => resolveAppVersion());
		this.resolveChatIdentity = options.resolveChatIdentity ?? ((region) => resolveChatIdentity(region));
	}
	/** POST the chat endpoint; a successful answer is the raw SSE response. */
	async chatStream(credential, bodyJson, signal) {
		const region = regionOf(credential.domain);
		let identity;
		let userAgent;
		try {
			identity = await this.resolveChatIdentity(region);
			userAgent = chatUserAgent(identity, region);
		} catch {
			identity = fallbackChatIdentity(region);
			userAgent = chatUserAgent(identity, region);
		}
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent, identity.clientVersion),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: region === "global" ? prepareInternationalChatBody(bodyJson) : prepareCnChatBody(bodyJson),
				...signal === void 0 ? {} : { signal }
			});
		} catch (error) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: `transport error: ${String(error)}`
			};
		}
		if (response.ok) return {
			ok: true,
			response
		};
		const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
		return {
			ok: false,
			status: response.status,
			kind: classifyUpstreamError(response.status, text),
			message: text
		};
	}
	/** POST the token-refresh endpoint; the caller merges the outcome. */
	async refreshToken(credential) {
		const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
			method: "POST",
			headers: refreshHeaders(credential),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
		if (accessToken === "") throw new Error("workbuddy token refresh returned no accessToken; sign in again in the WorkBuddy app");
		const outcome = { accessToken };
		if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") outcome.refreshToken = data["refreshToken"];
		if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) outcome.expiresInSec = data["expiresIn"];
		if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
		return outcome;
	}
	/**
	* GET the personal model catalog.
	*
	* Both variants read `/v3/config`, the product document the desktop product
	* itself fetches. CN used to read `/console/enterprises/personal/models`
	* (the console catalog) instead, and that was why its model list drifted
	* from the desktop App's selector: the console document lags the product
	* one, and the product roster itself churns day to day (`auto`,
	* `kimi-k3-1`, `minimax-m3` have each appeared and disappeared within a
	* week).
	*
	* What distinguishes the two variants here is the User-Agent, not the path:
	* the gateway splits `/v3/config` by client identity, and the split is
	* load-bearing. A CLI-shaped UA yields the CLI's roster — the chat models
	* this plugin serves — while an App-shaped UA yields the App's internal
	* roster. CN keeps the CLI UA it sends for chat, so the catalog it
	* advertises is exactly the one its own requests can use. The international
	* variant has no CLI identity, so it keeps the App-shaped UA.
	*
	* Membership is the `cli` roster intersected with the usable rows (see
	* {@link parseModelCatalog}); the promo badges the product document does
	* not carry are merged in from a best-effort console read — see
	* {@link fetchPromoBadges}.
	*
	* Responses are unwrapped and classified the same way — `readEnvelope` plus
	* `envelopeError` — so an expired session or exhausted credit is reported as
	* such rather than as a generic catalog failure.
	*/
	async fetchModels(credential, signal) {
		const international = regionOf(credential.domain) === "global";
		const appVersion = international ? await this.resolveAppVersion() : void 0;
		const response = await fetch(`${chatBase(credential)}/v3/config`, {
			headers: {
				Authorization: `Bearer ${credential.accessToken}`,
				Accept: "application/json",
				Origin: originReferer(credential),
				Referer: `${originReferer(credential)}/`,
				...international ? {
					"X-Requested-With": "XMLHttpRequest",
					"X-Product": "SaaS"
				} : {},
				"User-Agent": appVersion === void 0 ? CLIENT_UA : appUserAgent(appVersion.version)
			},
			signal: signal === void 0 ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)])
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const models = parseModelCatalog(isObject(envelope.data) ? envelope.data : "models" in envelope.document || "agents" in envelope.document ? envelope.document : {}, international, international ? void 0 : await this.fetchPromoBadges(credential, signal));
		this.lastCatalog = {
			fetchedAtMs: Date.now(),
			source: international ? "workbuddy-ai:app" : "workbuddy:cli",
			...appVersion === void 0 ? {} : { appVersion }
		};
		return models;
	}
	/**
	* Read the console catalog's promotional tags, by model id.
	*
	* `/v3/config` carries no `badge:<label>:<color>` tags — the discount labels
	* the cards render (`限时免费`, `夜间折扣`, …) live only in
	* `/console/enterprises/personal/models`. Since the roster now comes from
	* the product document, those tags are read from the console one in a
	* second request and merged by id.
	*
	* Best-effort by construction: a badge is a label on a price, so failing to
	* read this document must not fail a catalog refresh. Every failure —
	* network, envelope, an unreadable body — returns undefined, and the models
	* simply ship without badges.
	*/
	async fetchPromoBadges(credential, signal) {
		try {
			const response = await fetch(`${chatBase(credential)}/console/enterprises/personal/models`, {
				headers: {
					Authorization: `Bearer ${credential.accessToken}`,
					Accept: "application/json",
					Origin: originReferer(credential),
					Referer: `${originReferer(credential)}/`,
					"User-Agent": CLIENT_UA
				},
				signal: signal === void 0 ? AbortSignal.timeout(JSON_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)])
			});
			if (!response.ok) return void 0;
			const envelope = await readEnvelope(response);
			const data = isObject(envelope.data) ? envelope.data : envelope.document;
			const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
			const badges = /* @__PURE__ */ new Map();
			for (const model of rawModels) {
				if (!isObject(model)) continue;
				const id = typeof model["id"] === "string" ? model["id"] : "";
				if (id === "") continue;
				const tags = Array.isArray(model["tags"]) ? model["tags"].filter((tag) => typeof tag === "string" && tag.toLowerCase().startsWith(BADGE_PREFIX)) : [];
				if (tags.length > 0) badges.set(id, tags);
			}
			return badges.size === 0 ? void 0 : badges;
		} catch {
			return;
		}
	}
	/**
	* POST the billing endpoint for the aggregated remaining credit.
	*
	* Two upstream shapes, chosen by account type:
	*
	* - **CN enterprise** (`regionOf === 'cn'` and `enterpriseId` non-empty) asks
	*   `/v2/billing/meter/get-enterprise-user-usage`, which answers with a single
	*   cycle quota. The personal endpoint serves these accounts an empty
	*   `Accounts` list, which the card then renders as "0 credit" — a wrong
	*   number rather than a visible failure (issue #31).
	* - **Everyone else** keeps the personal endpoint unchanged.
	*
	* The region gate is load-bearing: the enterprise endpoint is unverified for
	* the global region, so an international credential that happens to carry an
	* `enterpriseId` must stay on the measured personal path instead of being
	* moved onto an unmeasured one.
	*/
	async fetchCredits(credential) {
		if (regionOf(credential.domain) === "cn" && credential.enterpriseId !== void 0 && credential.enterpriseId !== "") return await this.fetchEnterpriseCredits(credential);
		const now = /* @__PURE__ */ new Date();
		const format = (date) => [
			date.getFullYear().toString().padStart(4, "0"),
			(date.getMonth() + 1).toString().padStart(2, "0"),
			date.getDate().toString().padStart(2, "0")
		].join("-") + " " + [
			date.getHours().toString().padStart(2, "0"),
			date.getMinutes().toString().padStart(2, "0"),
			date.getSeconds().toString().padStart(2, "0")
		].join(":");
		const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({
				PageNumber: 1,
				PageSize: 100,
				ProductCode: "p_tcaca",
				Status: [0, 3],
				PackageEndTimeRangeBegin: format(now),
				PackageEndTimeRangeEnd: format(new Date(now.getTime() + 3185136e6))
			}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const responseWrapper = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
		const data = typeof responseWrapper["Response"] === "object" && responseWrapper["Response"] !== null ? responseWrapper["Response"] : {};
		const inner = typeof data["Data"] === "object" && data["Data"] !== null ? data["Data"] : {};
		const rawAccounts = Array.isArray(inner["Accounts"]) ? inner["Accounts"] : [];
		const accounts = [];
		let total = 0;
		for (const raw of rawAccounts) {
			if (typeof raw !== "object" || raw === null) continue;
			const account = raw;
			const numberField = (key) => typeof account[key] === "number" ? account[key] : 0;
			const size = numberField("CycleCapacitySize");
			const cycleRemain = numberField("CycleCapacityRemain");
			const cycleUsed = numberField("CycleCapacityUsed");
			const capacityRemain = numberField("CapacityRemain");
			let remain;
			if (size > 0) remain = cycleRemain;
			else if (cycleRemain > 0 || cycleUsed > 0) remain = cycleRemain;
			else remain = capacityRemain;
			if (remain < 0) remain = 0;
			total += remain;
			const endTimeMs = parseCycleEndTime(account["CycleEndTime"]);
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize"),
				...endTimeMs === void 0 ? {} : { endTimeMs }
			});
		}
		return {
			total,
			accounts,
			...summariseExpiry(accounts, now.getTime())
		};
	}
	/**
	* CN enterprise credit read: a single cycle quota instead of a package list.
	*
	* Verified against the WorkBuddy desktop app (`app.asar`,
	* `BackendProvider.getEnterpriseUsage` and `CloudAccountRepo.billing`): the
	* body is an empty object and the account identity travels only in the
	* headers. The two official call sites disagree on the field spelling
	* (`limitNum`/`credit` vs `limit_num`/`used_num`), so both are accepted.
	*
	* A body carrying no recognisable quota field is a hard error rather than a
	* zero. Rendering `0` for "we did not understand the answer" is exactly how
	* issue #31 stayed invisible while users saw a plausible wrong number.
	*
	* The error names fields and types only: it reaches the browser, and the
	* response body may describe the account's usage.
	*/
	async fetchEnterpriseCredits(credential) {
		const response = await fetch(`${CN_BILLING_BASE}/v2/billing/meter/get-enterprise-user-usage`, {
			method: "POST",
			headers: billingHeaders(credential),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(JSON_TIMEOUT_MS)
		});
		const envelope = await readEnvelope(response);
		if (!response.ok || envelope.code !== 0) throw envelopeError(response.status, envelope);
		const sources = [];
		for (const candidate of [envelope.data, envelope.document]) {
			if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
			const record = candidate;
			if (typeof record["data"] === "object" && record["data"] !== null && !Array.isArray(record["data"])) sources.push(record["data"]);
			sources.push(record);
		}
		const numberAt = (source, key) => typeof source[key] === "number" ? source[key] : void 0;
		let limit;
		let used;
		let resetTime;
		for (const source of sources) {
			const candidate = numberAt(source, "limitNum") ?? numberAt(source, "limit_num");
			if (candidate === void 0) continue;
			limit = candidate;
			used = numberAt(source, "credit") ?? numberAt(source, "used_num");
			if (typeof source["cycleResetTime"] === "string" && source["cycleResetTime"] !== "") resetTime = source["cycleResetTime"];
			break;
		}
		if (limit === void 0) throw new Error(`workbuddy enterprise billing response carried no recognised quota field (expected limitNum/limit_num + credit/used_num; received ${describeShape(envelope.document)})`);
		if (limit === -1) return {
			total: 0,
			accounts: [{
				packageName: enterprisePackageName,
				remain: 0,
				size: 0,
				unlimited: true
			}],
			unlimited: true,
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
		if (used === void 0) throw new Error(`workbuddy enterprise billing response carried a quota limit but no recognised usage field (expected credit/used_num alongside limitNum/limit_num; received ${describeShape(envelope.document)})`);
		let remain = limit - used;
		if (remain < 0) remain = 0;
		return {
			total: remain,
			accounts: [{
				packageName: enterprisePackageName,
				remain,
				size: limit
			}],
			...resetTime === void 0 ? {} : { cycleResetTime: resetTime }
		};
	}
	/**
	* One probe request: a real streaming chat call carrying the effort under
	* test.
	*
	* Shares `chatHeaders` with the normal chat path on purpose — the plan
	* forbids probing through anything but the plugin's own credential handling,
	* so a result describes what a real message would experience.
	*
	* The caller aborts as soon as a parseable event arrives; the body is never
	* assembled into an answer. `reasoning_effort` is omitted entirely (rather
	* than sent empty) when `effort` is undefined, so the baseline case is a
	* genuinely bare request.
	*
	* Two international differences, both measured on 2026-09-11:
	*
	* - The gateway requires a leading `system` message (400/11128 otherwise), so
	*   one is prepended for the global region only.
	* - `max_tokens: 1` is below some models' floor (the GPT-5.6 family rejects it
	*   with 400/11133 `integer_below_min_value`), so the international probe asks
	*   for a slightly larger minimum. This is a floor the plugin must clear, not
	*   evidence about any model's effort support: a model still refusing that
	*   minimum is reported as an incompatible request, never as "effort
	*   unsupported", and the ceiling is never raised further to force an answer.
	*/
	async probeEffort(credential, model, effort, signal) {
		const international = regionOf(credential.domain) === "global";
		let identity;
		let userAgent;
		try {
			identity = await this.resolveChatIdentity(international ? "global" : "cn");
			userAgent = chatUserAgent(identity, international ? "global" : "cn");
		} catch {
			identity = fallbackChatIdentity(international ? "global" : "cn");
			userAgent = chatUserAgent(identity, international ? "global" : "cn");
		}
		const payload = {
			model,
			stream: true,
			messages: [...international ? [{
				role: "system",
				content: INTERNATIONAL_SYSTEM_PROMPT
			}] : [], {
				role: "user",
				content: PROBE_PROMPT
			}],
			max_tokens: international ? INTERNATIONAL_PROBE_MAX_TOKENS : 1
		};
		if (effort !== void 0) payload["reasoning_effort"] = effort;
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent, identity.clientVersion),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: JSON.stringify(payload),
				signal
			});
		} catch (error) {
			return {
				status: 0,
				streamed: false,
				detail: `transport error: ${String(error)}`
			};
		}
		if (!response.ok) {
			const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
			return {
				status: response.status,
				streamed: false,
				...errorCodeOf(text)
			};
		}
		const streamed = await readFirstEvent(response);
		return {
			status: response.status,
			streamed
		};
	}
};
/** Pull `extError.code` out of an upstream error body, if it is shaped that way. */
function errorCodeOf(text) {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
			const extError = parsed["extError"];
			if (typeof extError === "object" && extError !== null && !Array.isArray(extError)) {
				const code = extError["code"];
				if (typeof code === "string") return {
					errorCode: code,
					detail: code
				};
			}
		}
	} catch {}
	return { detail: text.slice(0, 200) };
}
/**
* Consume just enough of a streaming response to know it really streams.
*
* Returns true on the first chunk containing a data line. Cancels the body
* afterwards; a stream that ends or errors before that counts as not streamed,
* because an empty 200 is not evidence the effort was accepted.
*/
async function readFirstEvent(response) {
	const body = response.body;
	if (body === null) return false;
	const reader = body.getReader();
	const decoder = new TextDecoder();
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return false;
			if (decoder.decode(value, { stream: true }).includes("data:")) return true;
		}
	} catch {
		return false;
	} finally {
		await reader.cancel().catch(() => {});
	}
}
function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}
/**
* Parse either response shape after its envelope has been checked.
*
* Membership is the `cli` agent's roster, intersected with the rows that are
* usable: the roster is what the client identity this plugin presents is
* allowed to chat with, and joining rather than trusting it outright drops
* both ids the roster has retired and rows the document lists but cannot
* serve (no row, `disabled: true`, or non-positive caps all drop out here —
* a published-but-unservable id must never reach the picker).
*
* @param data - the unwrapped catalog/product document.
* @param international - whether it is the international product document, whose
* rows carry window objects and promotions.
* @param promoBadges - badge tags by model id, read from the console document,
* which is the only one that carries them.
*/
function parseModelCatalog(data, international = false, promoBadges) {
	const rawModels = Array.isArray(data["models"]) ? data["models"] : [];
	const agents = Array.isArray(data["agents"]) ? data["agents"] : [];
	let cliIds;
	for (const agent of agents) if (typeof agent === "object" && agent !== null) {
		const wrapped = agent;
		if (wrapped["name"] === "cli" && Array.isArray(wrapped["models"])) {
			cliIds = wrapped["models"].filter((id) => typeof id === "string");
			break;
		}
	}
	if (cliIds === void 0 || cliIds.length === 0) throw new Error("workbuddy model catalog lists no cli agent models");
	const byId = /* @__PURE__ */ new Map();
	for (const model of rawModels) {
		if (typeof model !== "object" || model === null) continue;
		const wrapped = model;
		const id = typeof wrapped["id"] === "string" ? wrapped["id"] : "";
		if (id === "" || wrapped["disabled"] === true) continue;
		const input = typeof wrapped["maxInputTokens"] === "number" ? wrapped["maxInputTokens"] : 0;
		const output = typeof wrapped["maxOutputTokens"] === "number" ? wrapped["maxOutputTokens"] : 0;
		if (input <= 0 || output <= 0) continue;
		byId.set(id, {
			id,
			name: typeof wrapped["name"] === "string" && wrapped["name"] !== "" ? wrapped["name"] : id,
			contextWindow: international && isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? wrapped["contextWindow"]["defaultLength"] : input,
			...international ? {
				...isObject(wrapped["contextWindow"]) && positive(wrapped["contextWindow"]["defaultLength"]) ? { defaultContextWindow: wrapped["contextWindow"]["defaultLength"] } : {},
				maxInputTokens: input,
				supportedContextWindows: isObject(wrapped["contextWindow"]) && Array.isArray(wrapped["contextWindow"]["supportedLengths"]) ? wrapped["contextWindow"]["supportedLengths"].filter(positive) : [],
				promotions: parsePromotions(data["modelPromotions"], id)
			} : {},
			maxTokens: output,
			supportsImages: wrapped["supportsImages"] === true && wrapped["disabledMultimodal"] !== true,
			...resolveUpstreamReasoning(wrapped),
			...resolveUpstreamBilling(wrapped, promoBadges?.get(id))
		});
	}
	const models = cliIds.map((id) => byId.get(id)).filter((model) => model !== void 0);
	if (models.length === 0) throw new Error("workbuddy model catalog resolved to an empty list");
	return models;
}
/** Extract the promotions covering `model` from the `modelPromotions` array. */
function parsePromotions(value, model) {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) => {
		if (!isObject(item) || item["enabled"] !== true) return [];
		const modelIds = item["modelIds"];
		if (!Array.isArray(modelIds) || !modelIds.includes(model)) return [];
		const schedule = item["schedule"];
		const discount = item["discount"];
		const badge = item["badge"];
		if (!isObject(schedule) || !isObject(discount) || !isObject(badge)) return [];
		if (discount["displayMode"] !== "replace") return [];
		const start = typeof schedule["validFrom"] === "string" ? Date.parse(schedule["validFrom"]) : NaN;
		const end = typeof schedule["validUntil"] === "string" ? Date.parse(schedule["validUntil"]) : NaN;
		const factor = discount["factor"];
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
		if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0) return [];
		return [{
			start,
			end,
			factor,
			label: typeof badge["label"] === "string" ? badge["label"] : "",
			priority: typeof item["priority"] === "number" && Number.isFinite(item["priority"]) ? item["priority"] : 0
		}];
	});
}
/**
* Re-evaluate a model's promotion against the current time.
*
* Promotions are time-boxed, and the catalog they arrive in is cached for the
* life of the process. Frozen at parse time, a cached "Free now" would keep
* claiming a discount after `validUntil` had passed, and would keep showing the
* pre-discount rate as the discounted one. Re-deriving on every read means the
* badge disappears on its own and the rate reverts, with no refresh needed.
*
* Non-destructive: the model's own `credits` and `badges` are the base, and the
* promotion is layered onto a copy. A model with no live promotion is returned
* as-is, so the common case allocates nothing.
*/
function modelWithCurrentPromotion(model, now = Date.now()) {
	if (model.promotions === void 0 || model.promotions.length === 0) return model;
	const promotion = [...model.promotions].sort((a, b) => b.priority - a.priority).find((candidate) => now >= candidate.start && now < candidate.end);
	if (promotion === void 0) {
		if (!(model.billing?.free === true || (model.billing?.badges?.length ?? 0) > 0 || model.promotions.some((candidate) => candidate.factor !== 1))) return model;
		return {
			...model,
			billing: {
				free: false,
				rateUnknown: true
			}
		};
	}
	const rate = normalizeCredits(model.billing?.credits);
	const original = rate !== void 0 && rate.startsWith("x") ? Number(rate.slice(1)) : NaN;
	if (promotion.factor !== 0 && !Number.isFinite(original)) return model;
	const value = promotion.factor === 0 ? 0 : original * promotion.factor;
	return {
		...model,
		billing: {
			...model.billing,
			credits: `x${value.toFixed(2)}`,
			free: value === 0,
			badges: [...model.billing?.badges ?? [], ...promotion.label === "" ? [] : [promotion.label]]
		}
	};
}
/**
* Apply the international endpoint's extra chat requirement: the first message
* must be a system prompt.
*
* The international gateway rejects a body whose first message is not `system`
* with HTTP 400 code 11128 ("first message is not system prompt"). Note that
* the *same* code means something else on the CN endpoint — there it reports a
* rejected `developer` role — so the two are never branched on by code alone.
*
* The added prompt is deliberately empty of user content and prepended, never
* merged: existing messages keep their order and wording. A body that is not a
* JSON object is returned unchanged, exactly as {@link prepareChatBody} does,
* so this is safe to run over an already-prepared-or-not body.
*/
/**
* Prepare a body for the **CN** endpoint.
*
* Until #87 the CN wire was the caller's body verbatim. The only difference
* now is the shared {@link dropUnsupportedEffort} strip, whose region scope was
* lifted once measurements showed this endpoint rejects `off` too.
*
* Deliberately **not** routed through {@link prepareChatBody}: the shim already
* applies it before handing the body to {@link WorkBuddyUpstreamClient.chatStream},
* and re-running it would be a second `stream`/`developer`/`tool_choice`
* normalisation of an already-normalised body. Only the strip belongs here.
*
* A body that is not a JSON object is returned unchanged, so this is safe to
* run over an already-prepared-or-not body.
*/
function prepareCnChatBody(source) {
	let body;
	try {
		body = JSON.parse(source);
	} catch {
		return source;
	}
	if (!isObject(body)) return source;
	dropUnsupportedEffort(body);
	return JSON.stringify(body);
}
function prepareInternationalChatBody(source) {
	const prepared = prepareChatBody(source);
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return prepared;
	}
	if (!isObject(body)) return prepared;
	dropUnsupportedEffort(body);
	const messages = body["messages"];
	if (!Array.isArray(messages)) return JSON.stringify(body);
	const first = messages[0];
	if (isObject(first) && first["role"] === "system") return JSON.stringify(body);
	messages.unshift({
		role: "system",
		content: INTERNATIONAL_SYSTEM_PROMPT
	});
	return JSON.stringify(body);
}
/**
* Remove the adapter's own `off` effort spelling from the wire, on every region.
*
* `thinkingLevelMap.off` is pinned to the literal `'off'` for models that
* declare `canDisableThinking`, so that the level stays selectable. pi-ai
* sends that value for any request carrying no explicit level — which is why
* this covers **Default and Off alike**: the two produce the same body, so a
* fix that only removed the menu entry would leave Default failing.
*
* Both endpoints reject it, which is why this is no longer region-scoped
* (#87): the international GPT family answers HTTP 400 `11133` /
* `extError.param === 'reasoning.effort'` (issue #49), and the CN endpoint
* rejects it on models that declare `onlyReasoning` — measured on
* `deepseek-v4.1-flash` with 400 / `11150`, while `low`/`high`/`max` pass
* (issue #87). Omission is the only form measured good on every such model; a
* literal `'none'` is *not* a safe substitute — accepted by the GPT-5.6 family
* and GLM, rejected by `gpt-6-astra`.
*
* Consequences, stated honestly: the picker still offers Off for models where
* the upstream declares `canDisableThinking`, but selecting it now means "the
* field is omitted" — the model's actual behaviour is decided upstream and is
* *not* guaranteed to disable thinking or to match the catalog's
* `defaultEffort`. Declared spellings (`low`/`medium`/`high`/`xhigh`/`max`)
* and an explicit `none` pass through untouched.
*
* The CN strip replaces a scope decision whose premise did not hold: the
* earlier note here said that endpoint "has accepted this spelling in every
* measurement so far". Measurements since (#87) show it rejects `off` on
* validating models — the earlier runs had simply not hit one.
*/
function dropUnsupportedEffort(obj) {
	if (obj["reasoning_effort"] === "off") delete obj["reasoning_effort"];
}
/**
* The system prompt injected when the international endpoint receives a body
* with none.
*
* Minimal on purpose: it exists to satisfy a gateway precondition, not to
* steer the model. The plugin is not the place to invent a persona, and the
* normal path never reaches this — pi-ai already sends the harness's system
* prompt, so this only covers a caller that omitted one.
*/
const INTERNATIONAL_SYSTEM_PROMPT = "You are a helpful assistant.";
/**
* Output ceiling for an international probe request.
*
* Above the smallest value that the strictest observed model accepts (the
* GPT-5.6 family rejects `1` with 11133), while still being far too small to
* produce a real answer. See {@link WorkBuddyUpstreamClient.probeEffort}.
*/
const INTERNATIONAL_PROBE_MAX_TOKENS = 16;
//#endregion
//#region src/status-paths.ts
/** Node-free constants and types shared by the Host and browser halves. */
/** Plugin-owned status endpoint consumed by its browser half. */
const WORKBUDDY_STATUS_PATH = "/plugins/dsh-workbuddy-connect/status";
/**
* Plugin-owned probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore
* also requires the in-process key the browser half receives with the status
* document.
*/
const WORKBUDDY_PROBE_PATH = "/plugins/dsh-workbuddy-connect/probe";
/**
* The international (WorkBuddy AI) variant's own pair of routes.
*
* Kept as separate constants rather than a computed suffix so both halves
* reference literal strings: the browser bundle and the host bundle are built
* independently, and a shared expression is one build-config drift away from
* the desk asking a route the host never mounted.
*/
const WORKBUDDY_AI_STATUS_PATH = "/plugins/dsh-workbuddy-connect/ai/status";
const WORKBUDDY_AI_PROBE_PATH = "/plugins/dsh-workbuddy-connect/ai/probe";
/**
* Same-origin route backing the browser's update reminder.
*
* Read-only like the status route, so the same loopback Host/Origin gate
* applies; it answers public npm/GitHub metadata only and never token
* material.
*/
const WORKBUDDY_UPDATE_PATH = "/plugins/dsh-workbuddy-connect/update";
//#endregion
//#region src/variants.ts
/**
* The two WorkBuddy desktop apps this one plugin serves.
*
* Both products are the same client framework in different regions, and both
* write their sign-in into the *same* shared `CodeBuddyExtension` auth
* directory — they differ by file basename, base URL, catalog endpoint, and
* display identity. Everything that varies between them is collected here as
* one descriptor, so no module has to carry its own `if (international)`
* branch and a third variant would be a data change rather than a refactor.
*
* This module is host-side (it names files and env vars). The browser half
* takes the same ids and routes from the Node-free `status-paths.ts`, which
* stays the single source shared by both halves.
*
* @module dsh-workbuddy-connect/variants
*/
/** CN WorkBuddy first: the existing provider keeps its id, paths, and copy. */
const WORKBUDDY_VARIANTS = [{
	id: "workbuddy",
	displayName: "WorkBuddy",
	appName: "WorkBuddy",
	region: "cn",
	env: "WORKBUDDY_AUTH_FILE",
	electron: {
		productName: "WorkBuddy",
		envVar: "WORKBUDDY_ELECTRON_BIN",
		macOS: {
			bundleId: "com.tencent.workbuddy.mac",
			defaultPath: "/Applications/WorkBuddy.app/Contents/MacOS/Electron"
		},
		windows: {
			displayNamePattern: /^WorkBuddy(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
			exeBasename: "workbuddy.exe",
			defaultPathSegments: [
				"Programs",
				"WorkBuddy",
				"WorkBuddy.exe"
			]
		}
	},
	desktopFilename: "workbuddy-desktop.info",
	ownFilename: ".workbuddy-auth.json",
	probeFilename: ".workbuddy-probe.json",
	catalogFilename: ".workbuddy-catalog.json",
	visibilityFilename: ".workbuddy-model-visibility.json",
	statusPath: WORKBUDDY_STATUS_PATH,
	probePath: WORKBUDDY_PROBE_PATH
}, {
	id: "workbuddy-ai",
	displayName: "WorkBuddy AI",
	appName: "WorkBuddy AI",
	region: "global",
	env: "WORKBUDDY_AI_AUTH_FILE",
	electron: {
		productName: "WorkBuddy AI",
		envVar: "WORKBUDDY_AI_ELECTRON_BIN",
		macOS: {
			bundleId: "com.workbuddy.workbuddy-ai",
			defaultPath: "/Applications/WorkBuddy AI.app/Contents/MacOS/Electron"
		},
		windows: {
			displayNamePattern: /^WorkBuddy AI(?:\s+\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)?$/u,
			exeBasename: "workbuddyai.exe"
		}
	},
	desktopFilename: "workbuddy-desktop-ai.info",
	ownFilename: ".workbuddy-ai-auth.json",
	probeFilename: ".workbuddy-ai-probe.json",
	catalogFilename: ".workbuddy-ai-catalog.json",
	visibilityFilename: ".workbuddy-ai-model-visibility.json",
	statusPath: WORKBUDDY_AI_STATUS_PATH,
	probePath: WORKBUDDY_AI_PROBE_PATH
}];
/** The CN variant; the plugin's long-standing default and compatibility anchor. */
const CN_VARIANT = WORKBUDDY_VARIANTS[0];
/** The international variant. */
const AI_VARIANT = WORKBUDDY_VARIANTS[1];
/** Look up a variant by provider id. */
function variantFor(id) {
	return WORKBUDDY_VARIANTS.find((variant) => variant.id === id);
}
/**
* The Electron profile a variant resolves with.
*
* Callers inside the plugin pass their known-complete variants; descriptors
* assembled outside (the type is public and predates the profile) fall back
* by variant id, so an id-less or unknown custom variant stays on the CN
* product — the same default the store's other legacy fields assume.
*/
function electronProfileFor(variant) {
	return variant?.electron ?? (variant?.id === AI_VARIANT.id ? AI_VARIANT : CN_VARIANT).electron;
}
//#endregion
//#region src/desktop-credential-protection.ts
/**
* WorkBuddy 5.6.x at-rest credential protection: classification, key
* resolution, and field decryption for the desktop apps' encrypted auth files.
*
* Since WorkBuddy 5.6 both desktop apps (CN and international, which followed
* in 5.6.2) encrypt `auth.accessToken` and `auth.refreshToken` at rest
* (`buildPolicy: "fields"`, on by default), so the plugin reads
* `{$wbEncrypted:1, envelope}` wrappers instead of token strings (issues
* #39/#40, #59/#60). Everything needed to open them lives on the same machine:
*
* - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
*   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
*   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
* - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
*   AES-256-GCM; the AAD builder below is transcribed from the app's own
*   `buildAuthenticatedContextAad` (verified live against 5.6.2, see
*   `docs/r3-final.js` in the working copy — not committed).
*
* The plugin process itself can never call `_linkedBinding` (it runs in DSH's
* Node, not the forked Electron), so the helper is spawned. The key is cached
* in memory only, single-flight, and re-resolved when an envelope names a
* different key id. Neither the payload, the key, nor any token is ever
* logged; error messages carry sizes, ids, and exit codes only.
*
* @module dsh-workbuddy-connect/desktop-credential-protection
*/
/**
* The platform-default Electron binary for one product, or `undefined` where
* none is verified. macOS defaults come from each product's measured layout;
* the Windows default needs `LOCALAPPDATA`, and the international app has no
* verified default location at all — registry discovery only, never a guess.
*/
function defaultWorkBuddyElectronPath(product, platform = process.platform) {
	if (platform === "darwin") return product.macOS.defaultPath;
	if (platform !== "win32" || product.windows.defaultPathSegments === void 0) return void 0;
	const localAppData = process.env.LOCALAPPDATA?.trim();
	return localAppData === void 0 || localAppData === "" ? void 0 : join(localAppData, ...product.windows.defaultPathSegments);
}
/** Distinct key ids across the wrapped fields, in field order. */
function keyIdsOf(fields) {
	return [...new Set(fields.map((wrapped) => wrapped.envelope.keyId))];
}
/**
* Whether a raw value is the 5.6 field wrapper, with its inner envelope
* decodable. The wrapper is `{$wbEncrypted:1, envelope:<base64 of a JSON
* {suite,keyId,nonce,authTag,ciphertext>}}`; anything claiming the flag whose
* envelope cannot be decoded makes the whole document unrecognized rather
* than encrypted, because no key could ever open it.
*/
function parseWrappedField(field, value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const wrapped = value;
	if (wrapped["$wbEncrypted"] !== 1 || typeof wrapped["envelope"] !== "string") return void 0;
	let inner;
	try {
		inner = JSON.parse(Buffer.from(wrapped["envelope"], "base64").toString("utf8"));
	} catch {
		return;
	}
	if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return void 0;
	const parts = inner;
	const nonce = parseBase64(parts["nonce"], 12);
	const authTag = parseBase64(parts["authTag"], 16);
	const ciphertext = parseBase64(parts["ciphertext"]);
	if (nonce === void 0 || authTag === void 0 || ciphertext === void 0) return void 0;
	if (typeof parts["suite"] !== "number" || !Number.isInteger(parts["suite"])) return void 0;
	if (parts["suite"] !== 1) return void 0;
	if (typeof parts["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(parts["keyId"])) return void 0;
	return {
		field,
		envelope: {
			suite: parts["suite"],
			keyId: parts["keyId"],
			nonce,
			authTag,
			ciphertext
		}
	};
}
/** Decode a base64 value and check its exact byte length when given. */
function parseBase64(value, length) {
	if (typeof value !== "string" || value === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(value, "base64");
	} catch {
		return;
	}
	if (decoded.length === 0 || decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return void 0;
	return length === void 0 || decoded.length === length ? decoded : void 0;
}
const AUTH_FIELDS = ["accessToken", "refreshToken"];
/**
* Read a desktop auth document's format. `absent` is an empty file; `plaintext`
* is any document the regular parser could read (even one without a token);
* `encrypted` has at least one field in a decodable wrapper; everything else —
* unparsable JSON, non-objects, wrappers whose envelope will not decode — is
* `unrecognized`.
*/
function classifyDesktopAuthDocument(text) {
	if (text.trim() === "") return { format: "absent" };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { format: "unrecognized" };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { format: "unrecognized" };
	const document = parsed;
	const auth = typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document;
	const fields = [];
	for (const field of AUTH_FIELDS) {
		const value = auth[field];
		if (typeof value === "string") continue;
		const wrapped = parseWrappedField(field, value);
		if (wrapped === void 0 && value !== void 0) return { format: "unrecognized" };
		if (wrapped !== void 0) fields.push(wrapped);
	}
	if (fields.length === 0) return { format: "plaintext" };
	return {
		format: "encrypted",
		wrapped: {
			document,
			fields
		}
	};
}
/**
* Decrypt a wrapped document into the plaintext text the regular parser reads.
* Throws a diagnosable error naming the field and key ids — never envelope or
* token content — when any wrapped field cannot be opened.
*/
function unwrapDesktopAuthDocument(classification, openField) {
	const wrapped = classification.wrapped;
	const rebuilt = structuredClone(wrapped.document);
	const auth = typeof rebuilt["auth"] === "object" && rebuilt["auth"] !== null ? rebuilt["auth"] : rebuilt;
	for (const field of wrapped.fields) auth[field.field] = openField(field);
	return JSON.stringify(rebuilt);
}
/**
* The authenticated-context AAD for one field envelope, transcribed from the
* app bundle's `buildAuthenticatedContextAad` and verified live against 5.6.2
* (`docs/r3-final.js` in the working copy holds the original reference).
* Credential fields are always suite 1 under the `field` framing (WBEV1);
* the framing family's other members (WBEF1/WBER1/WBES1) belong to other
* document kinds and are deliberately not implemented — opening a field is
* not a place to guess at future formats.
*/
function buildAuthenticatedContextAad(keyId, suite) {
	const prefix = Buffer.from("WB-AAD\0", "ascii");
	const lengthPrefixed = (value) => {
		const bytes = Buffer.from(value, "utf8");
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32BE(bytes.length);
		return Buffer.concat([header, bytes]);
	};
	const suiteBytes = Buffer.allocUnsafe(4);
	suiteBytes.writeUInt32BE(suite);
	return Buffer.concat([
		prefix,
		Buffer.from([1]),
		lengthPrefixed("WBEV1"),
		lengthPrefixed("sym-v1"),
		suiteBytes,
		lengthPrefixed(keyId),
		Buffer.from([2]),
		Buffer.from([0]),
		Buffer.from([0])
	]);
}
/**
* Open one envelope with a protector key; `undefined` when it will not open.
* The accepted format is exactly what WorkBuddy 5.6.2 writes — suite 1 under
* the `field` framing — so a failure means "not this format / wrong key",
* and is reported as such rather than retried against other framings.
*/
function openAuthField(key, envelope) {
	try {
		const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
		decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
		decipher.setAuthTag(envelope.authTag);
		return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
	} catch {
		return;
	}
}
/**
* Validate the helper's payload against the app's own rules: `version:1` and
* a canonical-base64 32-byte, non-all-zero secret. `undefined` otherwise.
*/
function parseAtRestPayload(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const payload = parsed;
	if (payload["version"] !== 1) return void 0;
	const secret = payload["atRestSecretKey"];
	if (typeof secret !== "string" || secret === "") return void 0;
	let decoded;
	try {
		decoded = Buffer.from(secret, "base64");
	} catch {
		return;
	}
	if (decoded.length !== 32) return void 0;
	if (decoded.toString("base64") !== secret) return void 0;
	if (decoded.every((byte) => byte === 0)) return void 0;
	return { atRestSecretKey: secret };
}
/** Derive the protector key from the payload's secret (sha256 over its UTF-8 string). */
function deriveProtectorKey(secret) {
	return createHash("sha256").update(secret, "utf8").digest();
}
/**
* Select discovery by platform. Both products have verified layouts on macOS
* and Windows (the international app is registry-only there), so discovery no
* longer gates on region; Linux and others stay `none`.
*/
function electronDiscoveryFor(platform = process.platform) {
	if (platform === "darwin") return "macos-workbuddy";
	if (platform === "win32") return "windows-workbuddy";
	return "none";
}
/**
* The at-rest key provider one variant's store should use. Shared by the
* plugin host and the CLI entry so the browser card and `doctor`/`status` can
* never disagree about which binary a variant resolves.
*/
function atRestKeyProviderFor(variant) {
	return new WorkBuddyAtRestKeyProvider({
		product: electronProfileFor(variant),
		discovery: electronDiscoveryFor()
	});
}
/** Absolute tool paths: never resolved through PATH, which a user can change. */
const MDFIND_BIN = "/usr/bin/mdfind";
const PLUTIL_BIN = "/usr/bin/plutil";
const WINDOWS_REGISTRY_ROOTS = [
	"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
	"HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
];
const WINDOWS_REGISTRY_OUTPUT_MAX_BYTES = 1048576;
const WINDOWS_ELECTRON_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;
/**
* The PowerShell command that re-reads one uninstall root as UTF-8.
*
* Used *only* as a fallback, and only to supply data: the caller feeds its
* output through the same {@link parseWindowsRegistryOutput} and
* {@link inspectWindowsElectronCandidate} as the `reg.exe` path, so candidate
* validation, uniqueness, and the "we could not check" rules are unchanged.
*
* Why a different tool rather than a smarter decode: `reg.exe` writes in a
* code page chosen by the console it inherits, and no inspection of the
* resulting bytes can recover which one. .NET's registry API returns strings,
* so the question never arises.
*
* Structure notes, each one a defect fixed after review:
*
* - **`param` is the first statement.** A `param` block must lead the script
*   block; putting the encoding assignment before it is a parse error in
*   Windows PowerShell 5.1.
* - **`[Console]::OutputEncoding` is set explicitly.** Windows PowerShell 5.1
*   encodes redirected stdout with it, so UTF-8 is *defined* for this child
*   rather than inferred from what comes back.
* - **Exit codes distinguish "root absent" from "root unreadable"** (`2` and
*   `3`). The caller branches on the code, never on message text, so the
*   localized diagnostics below cannot change an outcome.
* - **An unopenable subkey is `3`, not `continue`.** Skipping it silently
*   could drop a real candidate and make the product look absent, which is
*   precisely the confusion the caller's `incomplete` state exists to prevent.
* - **Output is JSON.** PowerShell does the escaping, so paths containing
*   spaces, commas, or quotes no longer depend on column positions, and only
*   the two values this plugin reads are collected.
*
* The root is passed as a `-Root` argument, never interpolated into the
* command text.
*/
const WINDOWS_REGISTRY_RELATIVE_POWERSHELL = "System32\\WindowsPowerShell\\v1.0\\powershell.exe";
/** Exit code meaning the root key does not exist (a normal, expected outcome). */
const WINDOWS_POWERSHELL_ROOT_ABSENT = 2;
/** Exit code meaning the root exists but a part of it could not be read. */
const WINDOWS_POWERSHELL_ROOT_UNREADABLE = 3;
const WINDOWS_POWERSHELL_QUERY_SCRIPT = [
	"param([string]$Root)",
	"[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
	"$ErrorActionPreference=\"Stop\";",
	"$path=\"Registry::\"+$Root;",
	"if (-not (Test-Path -LiteralPath $path)) { [Console]::Error.Write(\"root absent\"); exit 2 };",
	"try { $k=Get-Item -LiteralPath $path -ErrorAction Stop } catch { [Console]::Error.Write(\"root unreadable\"); exit 3 };",
	"$out=@();",
	"foreach ($n in $k.GetSubKeyNames()) {",
	"  try { $p=$k.OpenSubKey($n); if ($null -eq $p) { throw \"null\" } } catch { [Console]::Error.Write(\"subkey unreadable\"); exit 3 };",
	"  $d=$p.GetValue(\"DisplayName\");$i=$p.GetValue(\"DisplayIcon\");",
	"  if ($null -ne $d -or $null -ne $i) { $out += [pscustomobject]@{ displayName=[string]$d; displayIcon=[string]$i } }",
	"};",
	"ConvertTo-Json -InputObject @($out) -Compress -Depth 3"
].join(" ");
/** One discovery subprocess's own limits; see {@link WorkBuddyAtRestKeyProviderOptions}. */
const WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS = 3e3;
const MDFIND_MAX_OUTPUT_BYTES = 1048576;
const PLUTIL_MAX_OUTPUT_BYTES = 65536;
/**
* Why a discovery step could not produce an answer. Every one of these means
* "we do not know", explicitly *not* "the candidate does not exist" — the
* distinction is what keeps a half-finished check from being mistaken for a
* unique candidate.
*/
var DiscoveryIncompleteError = class extends Error {};
/**
* The default discovery tools: Spotlight for the bundle, `/usr/bin/plutil` for
* identity. Every failure that means "we could not tell" — a missing tool, a
* timeout, an oversized answer — is raised as {@link DiscoveryIncompleteError}
* so it can never be silently read as "no such app".
*
* `bundleId` is the product being searched for; the Spotlight query and the
* caller's identity comparison both use it, so the two can never disagree
* about which app they are looking for.
*/
function workBuddyDiscoveryTools(bundleId) {
	const runTool = (bin, args, maxBytes, signal) => new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DiscoveryIncompleteError(`${bin} was not started: the discovery budget was already spent`));
			return;
		}
		let settled = false;
		const child = execFile(bin, [...args], {
			maxBuffer: maxBytes,
			timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS
		}, (error, stdout) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== void 0) {
				reject(new DiscoveryIncompleteError(`${bin} could not complete (${error.killed === true ? "timed out" : String(error.code ?? "unavailable")})`));
				return;
			}
			resolve(stdout);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new DiscoveryIncompleteError(`${bin} was abandoned: the discovery budget was spent`));
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("close", () => {
			signal.removeEventListener("abort", abort);
		});
	});
	return {
		findApps: async (signal) => {
			return (await runTool(MDFIND_BIN, [`kMDItemCFBundleIdentifier == '${bundleId}'`], MDFIND_MAX_OUTPUT_BYTES, signal)).split("\n").map((line) => line.trim()).filter((line) => line.endsWith(".app"));
		},
		bundleIdentifier: async (bundlePath, signal) => {
			try {
				return (await runTool(PLUTIL_BIN, [
					"-extract",
					"CFBundleIdentifier",
					"raw",
					"-o",
					"-",
					join(bundlePath, "Contents", "Info.plist")
				], PLUTIL_MAX_OUTPUT_BYTES, signal)).trim();
			} catch {
				return;
			}
		},
		bundleVersion: async (bundlePath, signal) => {
			try {
				const version = (await runTool(PLUTIL_BIN, [
					"-extract",
					"CFBundleShortVersionString",
					"raw",
					"-o",
					"-",
					join(bundlePath, "Contents", "Info.plist")
				], PLUTIL_MAX_OUTPUT_BYTES, signal)).trim();
				return version === "" ? void 0 : version;
			} catch {
				return;
			}
		}
	};
}
/**
* The Windows registry discovery tool. It is deliberately separate from the
* macOS Spotlight/plutil seam: the two platforms have different identity and
* candidate rules, and neither tool should accidentally become cross-platform.
*/
function workBuddyWindowsDiscoveryTools() {
	const systemRoot = process.env.SystemRoot?.trim();
	const regPath = systemRoot === void 0 || systemRoot === "" ? void 0 : join(systemRoot, "System32", "reg.exe");
	/**
	* The fallback interpreter. Resolved by absolute path from SystemRoot, like
	* `reg.exe`: never through PATH, which a user can change.
	*
	* Windows PowerShell 5.1 ships with Windows, so unlike `pwsh` it can be
	* relied on; the script is written to its syntax (see
	* {@link WINDOWS_POWERSHELL_QUERY_SCRIPT}).
	*/
	const powershellPath = systemRoot === void 0 || systemRoot === "" ? void 0 : join(systemRoot, WINDOWS_REGISTRY_RELATIVE_POWERSHELL);
	const runTool = (root, signal) => new Promise((resolve, reject) => {
		if (regPath === void 0) {
			reject(new DiscoveryIncompleteError("SystemRoot is not configured"));
			return;
		}
		if (signal.aborted) {
			reject(new DiscoveryIncompleteError("reg.exe was not started: the discovery budget was already spent"));
			return;
		}
		let settled = false;
		const child = execFile(regPath, [
			"query",
			root,
			"/s"
		], {
			maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
			timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS,
			windowsHide: true,
			encoding: "buffer"
		}, (error, stdout, stderr) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== void 0) {
				if (error.killed !== true && (error.code === 1 || error.code === "1") && windowsRegistryKeyMissing(stderr.toString("utf8"))) {
					resolve(Buffer.alloc(0));
					return;
				}
				reject(new DiscoveryIncompleteError(`reg.exe could not complete (${error.killed === true ? "timed out" : String(error.code ?? "unavailable")})`));
				return;
			}
			resolve(stdout);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new DiscoveryIncompleteError("reg.exe was abandoned: the discovery budget was spent"));
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("close", () => {
			signal.removeEventListener("abort", abort);
		});
	});
	/**
	* Re-read one root through PowerShell's Unicode registry API (#88).
	*
	* Returns the same column-shaped document the `reg.exe` path produces, so
	* the caller's parser and candidate checks apply unchanged. Every failure
	* that means "we could not tell" is a {@link DiscoveryIncompleteError}, and
	* a root that simply does not exist yields an empty document — one of the
	* three roots being absent is normal and must not fail the search.
	*/
	const runFallback = (root, signal) => new Promise((resolve, reject) => {
		if (powershellPath === void 0) {
			reject(new DiscoveryIncompleteError("SystemRoot is not configured"));
			return;
		}
		if (signal.aborted) {
			reject(new DiscoveryIncompleteError("powershell.exe was not started: the discovery budget was already spent"));
			return;
		}
		let settled = false;
		const child = execFile(powershellPath, [
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			WINDOWS_POWERSHELL_QUERY_SCRIPT,
			"-Root",
			root
		], {
			maxBuffer: WINDOWS_REGISTRY_OUTPUT_MAX_BYTES,
			timeout: WORKBUDDY_DISCOVERY_STEP_TIMEOUT_MS,
			windowsHide: true,
			encoding: "utf8"
		}, (error, stdout) => {
			if (settled) return;
			settled = true;
			if (error !== null && error !== void 0) {
				const code = error.killed === true ? void 0 : Number(error.code);
				if (code === WINDOWS_POWERSHELL_ROOT_ABSENT) {
					resolve("");
					return;
				}
				if (code === WINDOWS_POWERSHELL_ROOT_UNREADABLE) {
					reject(new DiscoveryIncompleteError(`powershell.exe could not read the registry root ${root}`));
					return;
				}
				reject(new DiscoveryIncompleteError(`powershell.exe could not complete (${error.killed === true ? "timed out" : String(error.code ?? "unavailable")})`));
				return;
			}
			const records = parseWindowsUninstallJson(stdout);
			if (records === void 0) {
				reject(new DiscoveryIncompleteError("powershell.exe output was not the expected registry document"));
				return;
			}
			resolve(records);
		});
		const abort = () => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new DiscoveryIncompleteError("powershell.exe was abandoned: the discovery budget was spent"));
		};
		signal.addEventListener("abort", abort, { once: true });
		child.on("close", () => {
			signal.removeEventListener("abort", abort);
		});
	});
	return { queryUninstallRoot: async (root, signal) => {
		const raw = await runTool(root, signal);
		if (isAsciiOnly(raw)) return raw.toString("utf8");
		return await runFallback(root, signal);
	} };
}
/**
* Whether every byte is ASCII, the one case where a decode cannot be wrong.
*
* @param bytes - the child's raw stdout.
*/
function isAsciiOnly(bytes) {
	for (const byte of bytes) if (byte >= 128) return false;
	return true;
}
/**
* Turn the fallback's JSON into the same column-shaped document
* {@link parseWindowsRegistryOutput} already consumes.
*
* Re-encoding into the `reg query` text form on purpose: the parser and
* {@link parseWindowsDisplayIcon} carry the candidate-quoting rules that are
* shared with existing tests, and the seam between this tool and the provider
* is a string. Records carrying neither value are skipped, and the key name is
* synthetic because only the values are read.
*
* @param output - the child's UTF-8 stdout.
* @returns the document, or `undefined` when it was not the expected JSON.
*/
function parseWindowsUninstallJson(output) {
	let document;
	try {
		document = JSON.parse(output);
	} catch {
		return;
	}
	const rows = Array.isArray(document) ? document : [document];
	const lines = [];
	for (const [index, row] of rows.entries()) {
		if (typeof row !== "object" || row === null) continue;
		const record = row;
		const displayName = record["displayName"];
		const displayIcon = record["displayIcon"];
		if (typeof displayName !== "string" && typeof displayIcon !== "string") continue;
		lines.push(`HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{PS-${String(index)}}`);
		if (typeof displayName === "string") lines.push(`    DisplayName    REG_SZ    ${displayName}`);
		if (typeof displayIcon === "string") lines.push(`    DisplayIcon    REG_SZ    ${displayIcon}`);
	}
	return lines.join("\r\n");
}
/**
* In-memory protector-key resolver: one spawn per key id, single-flight, never
* persisted. The cache is keyed by the id envelopes ask for, so an envelope
* sealed under a rotated key triggers exactly one fresh resolution.
*/ var WorkBuddyAtRestKeyProvider = class {
	/**
	* The explicit binary, when one was configured. `undefined` here means "the
	* caller did not name one", which is what lets discovery run — an explicit
	* path that turns out to be unusable is an error, never a reason to look for
	* a different app.
	*/
	explicitPath;
	product;
	defaultPath;
	discovery;
	tools;
	windowsTools;
	platform;
	discoveryBudgetMs;
	timeoutMs;
	source;
	spawnHelper;
	/**
	* The path discovery settled on, cached only on success. A failure leaves
	* this unset so the next attempt tries again — the user may install or move
	* the app without restarting DSH.
	*/
	discoveredPath;
	cache;
	inflight;
	constructor(options) {
		this.product = options.product;
		const fromEnv = process.env[options.product.envVar]?.trim();
		const envPath = fromEnv === void 0 || fromEnv === "" ? void 0 : fromEnv;
		this.explicitPath = options.electronPath ?? envPath;
		this.discovery = options.discovery ?? "none";
		this.platform = options.platform ?? process.platform;
		this.defaultPath = this.discovery === "none" ? void 0 : options.defaultElectronPath === void 0 ? defaultWorkBuddyElectronPath(options.product, this.platform) : options.defaultElectronPath ?? void 0;
		this.tools = options.tools ?? workBuddyDiscoveryTools(options.product.macOS.bundleId);
		this.windowsTools = options.windowsTools ?? workBuddyWindowsDiscoveryTools();
		this.discoveryBudgetMs = options.discoveryBudgetMs ?? 1e4;
		this.timeoutMs = options.timeoutMs ?? 1e4;
		this.spawnHelper = options.spawnHelper ?? ((path) => this.spawnAt(path));
		this.source = options.source ?? (() => this.spawnPayload());
	}
	/**
	* The binary the default helper would use, for diagnostics.
	*
	* Reports a *discovery result* once one exists, so diagnostics describe what
	* would actually run rather than the default that was bypassed. Discovery
	* itself stays in {@link resolveElectronPath}: this accessor never triggers a
	* search (the constructor must remain I/O-free, and callers may ask before
	* any resolution has happened).
	*/
	helperPath() {
		if (this.explicitPath !== void 0) return this.explicitPath;
		if (this.discovery === "none") return void 0;
		return this.discoveredPath ?? this.defaultPath;
	}
	/**
	* A protector key matching one of the requested envelope key ids. The first
	* id the cache answers wins; otherwise one spawn resolves the current key,
	* which must match a request — a mismatch means the envelopes were sealed by
	* a different install than the one this machine now runs, and no key we can
	* reach will open them.
	*/
	async protectorKeyFor(requested) {
		if (requested.length === 0) throw new WorkBuddyElectronPathError("encrypted-credential-unreadable", "encrypted desktop credential carries no key ids");
		const cached = this.cache;
		if (cached !== void 0 && requested.includes(cached.keyId)) return cached.key;
		this.inflight ??= this.source().then((text) => this.ingest(text)).finally(() => {
			this.inflight = void 0;
		});
		const resolved = await this.inflight;
		if (!requested.includes(resolved.keyId)) throw new WorkBuddyElectronPathError("encrypted-credential-unreadable", `WorkBuddy's current at-rest key (id ${resolved.keyId}) does not match the credential's envelope (id ${requested.join(" or ")}); the desktop credential was sealed by a different WorkBuddy installation`);
		return resolved.key;
	}
	ingest(text) {
		const payload = parseAtRestPayload(text);
		if (payload === void 0) throw new WorkBuddyElectronPathError("encrypted-credential-unreadable", "WorkBuddy key helper returned an unusable at-rest payload (expected {version:1, atRestSecretKey})");
		const key = deriveProtectorKey(payload.atRestSecretKey);
		const resolved = {
			key,
			keyId: createHash("sha256").update(key).digest("hex").slice(0, 16)
		};
		this.cache = resolved;
		return resolved;
	}
	/**
	* The binary to spawn, or a diagnosable error saying why there is none.
	*
	* Order is the contract: an explicit path is used as-is and never falls back;
	* discovery runs only for a provider that was configured for it, and only
	* after the platform default has been tried and found unusable.
	*/
	async resolveElectronPath() {
		if (this.explicitPath !== void 0) {
			if (!isExecutable(this.explicitPath)) throw new WorkBuddyElectronPathError("electron-path-invalid", `the configured ${this.product.productName} Electron binary is not available at ${this.explicitPath}; check ${this.product.envVar} or unset it to let the plugin look for the app itself`);
			return this.explicitPath;
		}
		if (this.discovery === "none") throw new WorkBuddyElectronPathError("electron-binary-unavailable", `no ${this.product.productName} Electron binary is configured for this platform; set ${this.product.envVar} to the app's Electron binary`);
		if (this.defaultPath !== void 0 && isExecutable(this.defaultPath)) return this.defaultPath;
		if (this.discoveredPath !== void 0) {
			if (isExecutable(this.discoveredPath)) return this.discoveredPath;
			this.discoveredPath = void 0;
		}
		const found = this.discovery === "macos-workbuddy" ? await this.discoverMacosApp() : await this.discoverWindowsApp();
		this.discoveredPath = found;
		return found;
	}
	/**
	* Resolve this product's app through Spotlight, then prove each candidate's
	* identity before it can be executed.
	*
	* The whole flow shares one budget: a hang in one candidate must not extend
	* the wait for the others, and running out of budget is reported as an
	* unfinished check rather than an absent app.
	*/
	async discoverMacosApp() {
		if (this.platform !== "darwin") throw new WorkBuddyElectronPathError("electron-binary-unavailable", `no ${this.product.productName} Electron binary is configured for this platform; set ${this.product.envVar} to the app's Electron binary`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs);
		try {
			let candidates;
			try {
				candidates = await this.tools.findApps(controller.signal);
			} catch {
				throw discoveryIncomplete(this.product.productName, "the app search did not complete");
			}
			const seen = /* @__PURE__ */ new Map();
			let unresolved = false;
			for (const candidate of candidates) {
				try {
					statSync(candidate);
				} catch (error) {
					if (isENOENT$1(error)) continue;
					unresolved = true;
					continue;
				}
				let bundleIdentifier;
				try {
					bundleIdentifier = await this.tools.bundleIdentifier(candidate, controller.signal);
				} catch {
					unresolved = true;
					continue;
				}
				if (bundleIdentifier === void 0) {
					unresolved = true;
					continue;
				}
				if (bundleIdentifier !== this.product.macOS.bundleId) continue;
				const electronPath = join(candidate, "Contents", "MacOS", "Electron");
				if (!isExecutable(electronPath)) continue;
				let identity;
				try {
					identity = realpathSync(candidate);
				} catch {
					identity = candidate;
				}
				if (seen.has(identity)) continue;
				let version;
				try {
					version = await this.tools.bundleVersion(candidate, controller.signal);
				} catch {
					version = void 0;
				}
				seen.set(identity, {
					bundlePath: candidate,
					electronPath,
					...version === void 0 ? {} : { version }
				});
			}
			if (seen.size > 1) {
				const listed = [...seen.values()].map((app) => `  - ${app.bundlePath}${app.version === void 0 ? "" : ` (${app.version})`}`).join("\n");
				throw new WorkBuddyElectronPathError("electron-binary-ambiguous", `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n set ${this.product.envVar} to the one to use`);
			}
			if (unresolved) throw discoveryIncomplete(this.product.productName, "some candidates could not be checked");
			if (seen.size === 0) throw new WorkBuddyElectronPathError("electron-binary-not-found", `no ${this.product.productName} application was found in the default location or the system index; if it is installed elsewhere, it may not be indexed yet; set ${this.product.envVar} to the app's Electron binary`);
			return [...seen.values()][0].electronPath;
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
	/**
	* Resolve this product's app through Windows uninstall records. Registry
	* entries provide hints, not trust: every DisplayIcon candidate must still
	* be the product's Electron binary with the known Electron layout before
	* execution.
	*/
	async discoverWindowsApp() {
		if (this.platform !== "win32") throw new WorkBuddyElectronPathError("electron-binary-unavailable", `no ${this.product.productName} Electron binary is configured for this platform; set ${this.product.envVar} to the app's Electron binary`);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.discoveryBudgetMs);
		try {
			const candidates = [];
			let unresolved = false;
			for (const root of WINDOWS_REGISTRY_ROOTS) {
				let output;
				try {
					output = await this.windowsTools.queryUninstallRoot(root, controller.signal);
				} catch {
					unresolved = true;
					continue;
				}
				const parsed = parseWindowsRegistryOutput(output, this.product.windows.displayNamePattern);
				candidates.push(...parsed.candidates);
				unresolved ||= parsed.incomplete;
			}
			const seen = /* @__PURE__ */ new Map();
			const rejected = [];
			for (const candidate of new Set(candidates)) {
				const inspection = inspectWindowsElectronCandidate(candidate, this.platform, this.product.windows.exeBasename);
				if (inspection === "unresolved") {
					unresolved = true;
					continue;
				}
				if (inspection === void 0) {
					rejected.push(candidate);
					continue;
				}
				seen.set(inspection.identity, inspection.electronPath);
			}
			if (unresolved) throw discoveryIncomplete(this.product.productName, "some registry entries or candidates could not be checked");
			if (seen.size > 1) {
				const listed = [...seen.values()].map((path) => `  - ${path}`).join("\n");
				throw new WorkBuddyElectronPathError("electron-binary-ambiguous", `more than one ${this.product.productName} application was found, so none was chosen:\n${listed}\n set ${this.product.envVar} to the one to use`);
			}
			if (seen.size === 0) throw new WorkBuddyElectronPathError("electron-binary-not-found", rejected.length === 0 ? `no usable ${this.product.productName} Electron binary was found in the default location or Windows uninstall records; set ${this.product.envVar} to the app's Electron binary` : `Windows uninstall records found ${rejected.length} ${this.product.productName} candidate${rejected.length > 1 ? "s" : ""}, but ${rejected.length > 1 ? "none" : "it"} did not match the expected app layout (the app's exe beside a version file and resources\\app.asar); set ${this.product.envVar} to the installed app's executable to use it`);
			return [...seen.values()][0];
		} finally {
			clearTimeout(timer);
			controller.abort();
		}
	}
	async spawnPayload() {
		return await this.spawnHelper(await this.resolveElectronPath());
	}
	async spawnAt(electronPath) {
		return await new Promise((resolve, reject) => {
			execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
				timeout: this.timeoutMs,
				maxBuffer: 1048576,
				windowsHide: true,
				env: {
					...process.env,
					ELECTRON_RUN_AS_NODE: "1"
				}
			}, (error, stdout) => {
				if (error !== null && error !== void 0) {
					reject(new WorkBuddyElectronPathError("encrypted-credential-unreadable", `the WorkBuddy key helper (${electronPath}) ${error.killed === true ? `timed out or was killed after ${String(this.timeoutMs)}ms` : error.code !== void 0 ? `exited with code ${String(error.code)}` : "could not be started"}`));
					return;
				}
				const output = stdout.trim();
				if (output === "") {
					reject(new WorkBuddyElectronPathError("encrypted-credential-unreadable", `the WorkBuddy key helper (${electronPath}) produced no payload`));
					return;
				}
				resolve(output);
			});
		});
	}
};
/** Only known missing-key diagnostics can safely make a failed query empty. */
function windowsRegistryKeyMissing(stderr) {
	const detail = stderr.trim();
	return /^ERROR:\s*The system was unable to find the specified registry key or value\.?$/iu.test(detail) || /^错误[:：]\s*系统找不到指定的注册表项或值[。.]?$/u.test(detail);
}
/**
* Parse the value columns emitted by `reg query ... /s`.
*
* Entries are filtered by the product's DisplayName pattern *before* the
* DisplayIcon is judged, so another product's records — however broken — are
* excluded as decisively not ours and can never mark this product's search
* incomplete.
*/
function parseWindowsRegistryOutput(output, displayNamePattern) {
	const entries = /* @__PURE__ */ new Map();
	let currentKey;
	for (const line of output.split(/\r?\n/u)) {
		const keyMatch = /^\s*(HKEY_[^\r\n]+?)\s*$/iu.exec(line);
		if (keyMatch !== null) {
			currentKey = keyMatch[1];
			entries.set(currentKey, {});
			continue;
		}
		if (currentKey === void 0) continue;
		const valueMatch = /^\s+(DisplayName|DisplayIcon)\s+REG_[A-Z0-9_]+\s*(.*?)\s*$/iu.exec(line);
		if (valueMatch === null) continue;
		const entry = entries.get(currentKey);
		if (entry === void 0) continue;
		const value = valueMatch[2] ?? "";
		if (valueMatch[1].toLowerCase() === "displayname") entry.displayName = value;
		else entry.displayIcon = value;
	}
	const candidates = [];
	let incomplete = false;
	for (const entry of entries.values()) {
		if (entry.displayName === void 0) continue;
		if (!displayNamePattern.test(entry.displayName.trim())) continue;
		const displayIcon = entry.displayIcon === void 0 ? void 0 : parseWindowsDisplayIcon(entry.displayIcon);
		if (displayIcon === void 0) incomplete = true;
		else candidates.push(displayIcon);
	}
	return {
		candidates,
		incomplete
	};
}
/** Read a quoted DisplayIcon path and remove the Windows icon-index suffix. */
function parseWindowsDisplayIcon(value) {
	const raw = value.trim();
	let path;
	if (raw.startsWith("\"")) {
		const closingQuote = raw.indexOf("\"", 1);
		if (closingQuote < 0) return void 0;
		const suffix = raw.slice(closingQuote + 1).trim();
		if (suffix !== "" && !/^,\d+$/u.test(suffix)) return void 0;
		path = raw.slice(1, closingQuote).replace(/,\d+$/u, "");
	} else {
		const match = /^(.+?\.exe)(?:,\d+)?$/iu.exec(raw);
		if (match === null) return void 0;
		path = match[1];
	}
	path = path.trim();
	return /\.exe$/iu.test(path) ? path : void 0;
}
/**
* Validate the known Windows layout for the product's exe. `undefined` is a
* decidable exclusion; `unresolved` is reserved for errors that prevent
* checking.
*/
function inspectWindowsElectronCandidate(electronPath, platform, exeBasename) {
	if (platform !== "win32" || basename(electronPath).toLowerCase() !== exeBasename) return void 0;
	let binaryStat;
	try {
		binaryStat = statSync(electronPath);
	} catch (error) {
		return isENOENT$1(error) ? void 0 : "unresolved";
	}
	if (!binaryStat.isFile()) return void 0;
	try {
		accessSync(electronPath, constants.X_OK);
	} catch (error) {
		return isENOENT$1(error) ? void 0 : "unresolved";
	}
	const installRoot = dirname(electronPath);
	let version;
	try {
		version = readFileSync(join(installRoot, "version"), "utf8").trim();
	} catch (error) {
		return isENOENT$1(error) ? void 0 : "unresolved";
	}
	if (!WINDOWS_ELECTRON_VERSION_PATTERN.test(version)) return void 0;
	try {
		if (!readdirSync(join(installRoot, "resources")).includes("app.asar")) return void 0;
	} catch (error) {
		return isENOENT$1(error) ? void 0 : "unresolved";
	}
	let identity;
	try {
		identity = realpathSync(electronPath);
	} catch (error) {
		return isENOENT$1(error) ? void 0 : "unresolved";
	}
	return {
		electronPath,
		identity: platform === "win32" ? identity.toLowerCase() : identity
	};
}
/** Whether a path exists and is executable; never throws. */
function isExecutable(path) {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}
/**
* A failure the card must be able to classify. The code travels with the error
* so the store can promote it to `reasonCode` without re-deriving the cause
* from prose.
*/
var WorkBuddyElectronPathError = class extends Error {
	reasonCode;
	constructor(reasonCode, message) {
		super(message);
		this.name = "WorkBuddyElectronPathError";
		this.reasonCode = reasonCode;
	}
};
/** Read the reason code off an arbitrary thrown value, when it carries one. */
function reasonCodeOf(error) {
	return error instanceof WorkBuddyElectronPathError ? error.reasonCode : void 0;
}
/** Whether a filesystem error reports an absent path (`existsSync` cannot tell). */
function isENOENT$1(error) {
	return error?.code === "ENOENT";
}
function discoveryIncomplete(productName, detail) {
	return new WorkBuddyElectronPathError("electron-discovery-incomplete", `the ${productName} application search did not finish (${detail}); this is not proof that the app is missing`);
}
/**
* The helper: run inside WorkBuddy's Electron as plain Node, where the
* private `workbuddyStorage` binding exists, and print only the payload. It
* writes nothing else, so whatever reaches stdout is the payload.
*/
const HELPER_SCRIPT = "process.stdout.write(String(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet()))";
const HELPER_SCRIPT_ARGUMENT_FLAG = "-e";
//#endregion
//#region src/auth.ts
/**
* WorkBuddy credential resolution. The primary source is the WorkBuddy
* desktop app's own auth file, read-only; a plugin-owned copy under
* `$DSH_HOME` holds token refreshes so the desktop file is never written.
* The effective credential is whichever of the two expires later, so a
* refresh by either side wins.
*
* @module dsh-workbuddy-connect/auth
*/
/** Basename of the plugin-owned credential copy inside the Harness home. */
const WORKBUDDY_AUTH_FILENAME = ".workbuddy-auth.json";
/** Env variable that overrides the desktop auth-file location. */
const WORKBUDDY_AUTH_FILE_ENV = "WORKBUDDY_AUTH_FILE";
/** Current on-disk format of the plugin-owned copy; readers reject others. */
const OWN_FORMAT_VERSION = 1;
/** Plugin-owned copy path inside the Harness home. */
function workbuddyOwnAuthPath() {
	return join(resolveDshHome(), WORKBUDDY_AUTH_FILENAME);
}
const DESKTOP_AUTH_RELATIVE_PATH = [
	"CodeBuddyExtension",
	"Data",
	"Public",
	"auth",
	"workbuddy-desktop.info"
];
/** Whether this Linux process is running inside Windows Subsystem for Linux. */
function isWsl() {
	if (process.platform !== "linux") return false;
	if (process.env["WSL_DISTRO_NAME"] !== void 0 || process.env["WSL_INTEROP"] !== void 0) return true;
	return release().toLowerCase().includes("microsoft");
}
/** Convert a Windows drive path to WSL's conventional `/mnt/<drive>` form. */
function windowsPathForWsl(value) {
	const path = value?.trim();
	if (!path) return void 0;
	if (path.startsWith("/")) return path;
	const drivePath = /^([a-z]):[\\/](.*)$/iu.exec(path);
	if (drivePath === null) return void 0;
	return join("/mnt", drivePath[1].toLowerCase(), ...drivePath[2].split(/[\\/]+/u));
}
/** Windows desktop credential candidates visible from a WSL process. */
function wslDesktopAuthCandidates(home) {
	const profile = windowsPathForWsl(process.env["USERPROFILE"]) ?? join("/mnt/c/Users", basename(home));
	const localAppData = windowsPathForWsl(process.env["LOCALAPPDATA"]) ?? join(profile, "AppData", "Local");
	const roamingAppData = windowsPathForWsl(process.env["APPDATA"]) ?? join(profile, "AppData", "Roaming");
	return [join(localAppData, ...DESKTOP_AUTH_RELATIVE_PATH), join(roamingAppData, ...DESKTOP_AUTH_RELATIVE_PATH)];
}
/**
* Platform-default candidates for the WorkBuddy desktop app's auth file, in
* probe order. Windows probes both AppData roots: current builds write under
* `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). Linux
* probes both XDG bases — most distributions write under the config home,
* but UOS/deepin builds write under the data home (issue #43), and probing
* only one silently reads a signed-in app as signed out. WSL probes those
* same Windows locations through its mounted Windows profile before the
* native Linux locations.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "win32") return [join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"), join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "linux") {
		const configHome = xdgBase("XDG_CONFIG_HOME", join(home, ".config"));
		const dataHome = xdgBase("XDG_DATA_HOME", join(home, ".local", "share"));
		const linux = dedupeCandidates([join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH), join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH)]);
		return isWsl() ? dedupeCandidates([...wslDesktopAuthCandidates(home), ...linux]) : linux;
	}
	return [];
}
/** The XDG base directory for one env variable, or its platform default. */
function xdgBase(envName, fallback) {
	const value = process.env[envName]?.trim();
	if (value !== void 0 && value !== "" && value.startsWith("/")) return value;
	return fallback;
}
/** Drop duplicate candidates while keeping probe order. */
function dedupeCandidates(candidates) {
	return [...new Set(candidates)];
}
/**
* The platform-default candidates for one variant, in probe order.
*
* Both apps write into the *same* shared `CodeBuddyExtension` auth directory
* and differ only in the file's basename, so the per-platform ordering above
* is reused verbatim and just the filename is swapped.
*/
function desktopAuthCandidatesFor(variant) {
	return dedupeCandidates(defaultDesktopAuthCandidates().map((path) => join(dirname(path), variant.desktopFilename)));
}
/** First platform-default candidate; see {@link defaultDesktopAuthCandidates}. */
function defaultDesktopAuthPath(variant) {
	return (variant === void 0 ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(variant))[0];
}
/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
	if (value <= 0) return 0;
	return value > 0xe8d4a51000 ? value : value * 1e3;
}
function optionalString(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/**
* Parse a WorkBuddy auth document in either on-disk shape: the plugin OAuth
* nested form `{"auth":{...},"account":{...}}` and the flat panel form.
* Returns undefined when the document carries no access token.
*/
function parseWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	let auth;
	let identity;
	if (typeof document["auth"] === "object" && document["auth"] !== null) {
		auth = document["auth"];
		identity = typeof document["account"] === "object" && document["account"] !== null ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") return void 0;
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	};
}
/** Serialize the plugin-owned copy. */
function ownDocument(credential) {
	return {
		version: OWN_FORMAT_VERSION,
		credential
	};
}
/** Parse the plugin-owned copy; other versions and shapes are rejected. */
function parseOwnDocument(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return void 0;
	const document = parsed;
	if (document["version"] !== OWN_FORMAT_VERSION) return void 0;
	if (typeof document["credential"] !== "object" || document["credential"] === null) return void 0;
	const stored = document["credential"];
	const accessToken = typeof stored["accessToken"] === "string" ? stored["accessToken"] : "";
	if (accessToken === "") return void 0;
	const refreshExpiresAtMs = typeof stored["refreshExpiresAtMs"] === "number" ? stored["refreshExpiresAtMs"] : void 0;
	const enterpriseId = optionalString(stored["enterpriseId"]);
	const nickname = optionalString(stored["nickname"]);
	return {
		accessToken,
		refreshToken: typeof stored["refreshToken"] === "string" ? stored["refreshToken"] : "",
		expiresAtMs: typeof stored["expiresAtMs"] === "number" ? stored["expiresAtMs"] : 0,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(stored["domain"]) ?? "",
		uid: optionalString(stored["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "dsh"
	};
}
/** Whether a filesystem error reports an absent path. */
function isENOENT(error) {
	return error?.code === "ENOENT";
}
/**
* Read-only credential store with demand-driven refresh.
*
* Refresh policy: refresh only when the access token is inside the margin
* (or already expired), keep the refreshed credential in the plugin-owned
* copy, and never write the desktop app's file. A failed refresh still
* returns a not-yet-expired token so an unreachable refresh endpoint does
* not take down a working session.
*/
var WorkBuddyCredentialStore = class {
	variant;
	refresh;
	refreshMarginMs;
	ownPath;
	keyProvider;
	desktopPathOverride;
	inflight;
	constructor(options) {
		this.variant = options.variant;
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? (options.variant ? join(resolveDshHome(), options.variant.ownFilename) : workbuddyOwnAuthPath());
		this.keyProvider = options.keyProvider ?? new WorkBuddyAtRestKeyProvider({ product: electronProfileFor(options.variant) });
		this.desktopPathOverride = options.desktopPath;
	}
	/**
	* Configuration precedence for the desktop file: the plugin's configured
	* path, then the environment variable, then the platform defaults. An
	* explicit path is used verbatim; the defaults are a probe order.
	*/
	resolveDesktopCandidates() {
		const fromEnv = process.env[this.variant?.env ?? "WORKBUDDY_AUTH_FILE"];
		const explicit = this.desktopPathOverride ?? (fromEnv !== void 0 && fromEnv.trim() !== "" ? fromEnv : void 0);
		if (explicit !== void 0) return [explicit];
		return this.variant === void 0 ? defaultDesktopAuthCandidates() : desktopAuthCandidatesFor(this.variant);
	}
	resolveDesktopPath() {
		return this.resolveDesktopCandidates()[0];
	}
	/**
	* Repoint the desktop file; a settings change applies on the next read.
	*/
	setDesktopPath(path) {
		this.desktopPathOverride = path;
	}
	/** The resolved desktop auth-file path, for diagnostics. */
	desktopAuthPath() {
		return this.resolveDesktopPath();
	}
	/** The plugin-owned copy path, for diagnostics. */
	ownAuthPath() {
		return this.ownPath;
	}
	/** Read the freshest stored credential without refreshing anything. */
	async current() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		if (this.variant !== void 0) for (const [label, credential] of [["desktop file", desktop], ["plugin copy", own]]) {
			if (credential === void 0) continue;
			const region = regionOf(credential.domain);
			if (region !== this.variant.region) throw new WorkBuddyElectronPathError("credential-region-mismatch", `${this.variant.displayName} received a ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"} credential in its ${label} (domain ${JSON.stringify(credential.domain)}); point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`);
		}
		if (desktop === void 0) return own;
		if (own === void 0) return desktop;
		if (desktop.uid !== own.uid || desktop.enterpriseId !== own.enterpriseId) return desktop;
		return own.expiresAtMs > desktop.expiresAtMs ? own : desktop;
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const credential = await this.current();
		if (credential === void 0) {
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			const app = this.variant?.appName ?? "WorkBuddy";
			throw new Error(`workbuddy: no signed-in ${app} account found; sign in once in the ${app} desktop app (expected ${desktop} or ${this.variant?.env ?? "WORKBUDDY_AUTH_FILE"}), or refresh an existing session`);
		}
		if (!this.needsRefresh(credential)) return credential;
		this.inflight ??= this.refreshNow(credential).finally(() => {
			this.inflight = void 0;
		});
		return this.inflight;
	}
	/** Read-only sign-in summary; never refreshes and never throws. */
	async status() {
		try {
			const credential = await this.current();
			if (credential === void 0) return {
				state: "signed-out",
				reasonCode: "no-credential"
			};
			return {
				state: "signed-in",
				expiresAtMs: credential.expiresAtMs,
				...credential.refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs: credential.refreshExpiresAtMs },
				...credential.nickname === void 0 ? {} : { nickname: credential.nickname },
				...credential.domain === "" ? {} : { domain: credential.domain },
				source: credential.source
			};
		} catch (error) {
			return {
				state: "signed-out",
				reason: error instanceof Error ? error.message : String(error),
				...reasonCodeOf(error) === void 0 ? {} : { reasonCode: reasonCodeOf(error) }
			};
		}
	}
	/** Remove the plugin-owned copy; the desktop file is untouched. */
	async logout() {
		await rm(this.ownPath, { force: true });
		await rm(`${this.ownPath}.lock`, { force: true });
	}
	needsRefresh(credential) {
		if (credential.expiresAtMs <= 0) return true;
		return Date.now() + this.refreshMarginMs >= credential.expiresAtMs;
	}
	async refreshNow(credential) {
		if (credential.refreshToken === "") {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error("workbuddy: access token expired and no refresh token is stored; sign in again in the WorkBuddy desktop app");
		}
		try {
			const outcome = await this.refresh(credential);
			const refreshed = {
				...credential,
				accessToken: outcome.accessToken,
				...outcome.refreshToken === void 0 ? {} : { refreshToken: outcome.refreshToken },
				expiresAtMs: outcome.expiresInSec !== void 0 ? Date.now() + outcome.expiresInSec * 1e3 : credential.expiresAtMs,
				...outcome.domain === void 0 || outcome.domain === "" ? {} : { domain: outcome.domain },
				source: "dsh"
			};
			await this.saveOwn(refreshed);
			return refreshed;
		} catch (error) {
			if (credential.expiresAtMs > Date.now() + 3e4) return credential;
			throw new Error(`workbuddy: token refresh failed and the access token is expired (${String(error)}); open the WorkBuddy desktop app once to sign in again`);
		}
	}
	async saveOwn(credential) {
		await withFileLock(this.ownPath, async () => {
			await writeFileAtomic(this.ownPath, `${JSON.stringify(ownDocument(credential), null, 2)}\n`, {
				mode: 384,
				dirMode: 448
			});
		});
	}
	/**
	* Read the first desktop candidate that exists. Only an absent file
	* (ENOENT) falls through to the next candidate; a file that is present
	* but unparsable is authoritative for its slot, so a stale older-version
	* file never silently wins over a broken newer one.
	*
	* Since WorkBuddy 5.6 the token fields may arrive in at-rest envelopes, so
	* the text is classified before the regular parser sees it. An encrypted
	* document must be *opened*, never skipped; an unrecognized one must fail
	* loudly. The desktop file, as long as it exists, is the identity
	* authority — a document this plugin cannot read must surface as a
	* diagnosis rather than be papered over by the plugin-owned copy, which
	* belongs to whatever account was signed in when it was last refreshed.
	* Only an absent (or empty) file lets the probe continue.
	*/
	async readDesktop() {
		for (const desktopPath of this.resolveDesktopCandidates()) {
			let text;
			try {
				text = await readFile(desktopPath, "utf8");
			} catch (error) {
				if (!isENOENT(error)) throw error;
				continue;
			}
			const classification = classifyDesktopAuthDocument(text);
			if (classification.format === "plaintext") return parseWorkBuddyAuth(text);
			if (classification.format === "absent") continue;
			if (classification.format === "unrecognized") throw new Error(`the desktop auth file at ${desktopPath} exists but is unreadable (neither a plaintext credential nor a decodable WorkBuddy 5.6 envelope); fix or remove the file — it outranks the plugin-owned credential copy`);
			return await this.openEncryptedDesktop(classification);
		}
	}
	/** Open a 5.6 encrypted desktop document into the regular credential shape. */
	async openEncryptedDesktop(classification) {
		const wrapped = classification.wrapped;
		const key = await this.keyProvider.protectorKeyFor(keyIdsOf(wrapped.fields));
		return parseWorkBuddyAuth(unwrapDesktopAuthDocument(classification, (field) => {
			const plaintext = openAuthField(key, field.envelope);
			if (plaintext === void 0) throw new WorkBuddyElectronPathError("encrypted-credential-unreadable", `the encrypted desktop credential's ${field.field} could not be decrypted (envelope key id ${field.envelope.keyId}); the WorkBuddy app may hold a different at-rest key — open it once to reseal the sign-in`);
			return plaintext;
		}));
	}
	/**
	* Classify the first desktop candidate that exists and carries content;
	* `absent` when none does. An empty first file is skipped so it cannot mask
	* a real document on the next candidate. Diagnostics only — it never spawns
	* the key helper and never decrypts, so doctor can describe the file
	* without attempting the unlock.
	*/
	async desktopAuthFormat() {
		for (const desktopPath of this.resolveDesktopCandidates()) {
			let text;
			try {
				text = await readFile(desktopPath, "utf8");
			} catch (error) {
				if (!isENOENT(error)) throw error;
				continue;
			}
			const format = classifyDesktopAuthDocument(text).format;
			if (format !== "absent") return format;
		}
		return "absent";
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/**
	* The first desktop candidate the probe would actually read from; `undefined`
	* when none qualifies. Semantics deliberately match the probe: empty files
	* are skipped (the probe classifies them as absent and moves on), so on an
	* XDG layout where the config-home file is empty but the data-home file
	* holds the credential, diagnostics name the *data-home* file — the one
	* authentication really uses. Like the probe it never parses or decrypts.
	*/
	async resolvedDesktopAuthPath() {
		for (const desktopPath of this.resolveDesktopCandidates()) {
			let text;
			try {
				text = await readFile(desktopPath, "utf8");
			} catch (error) {
				if (!isENOENT(error)) throw error;
				continue;
			}
			if (text.trim() === "") continue;
			return desktopPath;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		return await this.resolvedDesktopAuthPath() !== void 0;
	}
};
//#endregion
//#region src/catalog.ts
/**
* WorkBuddy model catalog: a static fallback list captured from the live
* endpoint, replaced by the upstream's dynamic answer once it loads.
*
* @module dsh-workbuddy-connect/catalog
*/
/**
* Static CLI models observed on the CN endpoint (re-verified against the live
* `/v3/config` document 2026-09-23, including the thinking-effort and billing
* metadata). The upstream refresh replaces this list at startup; it exists so
* the provider registers with a usable catalog even while the first fetch is
* in flight or offline.
*
* The list tracks the `cli` agent's model roster exactly — the 16 models it
* offered that day. The roster churns quickly (`auto`, `kimi-k3-1`,
* `minimax-m3` each appeared or vanished within days, and a competing patch's
* 2026-09-22 snapshot named three ids that were gone a day later), so this
* table is a boot-time placeholder, never a promise: the live fetch
* intersects the day's roster with the document's usable rows, and
* `tests/upstream.spec.ts` pins this table to the same parse so the two
* cannot drift apart silently. Reasoning metadata is verbatim from the live
* document, and the `free` flag follows the normalized `x0.00` credits
* marker.
*
* Deliberately NOT baked in: promotional badges. `限时免费` and friends are
* dynamic console-side promotions with no reliable validity window, so a
* static table would keep them alive long after the offers end. The live
* refresh merges the day's badges best-effort from the console document (see
* `fetchPromoBadges` in upstream.ts); until then the rows simply ship
* without them.
*/
const FALLBACK_WORKBUDDY_MODELS = [
	{
		id: "hy4-preview",
		name: "Hy4 preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.29 credits",
			free: false
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.00 credits",
			free: true
		}
	},
	{
		id: "hy3-x",
		name: "Hy3-X",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.05 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.03 credits",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5.3-flash",
		name: "GLM-5.3-Flash",
		contextWindow: 1e6,
		maxTokens: 131072,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.06 credits",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			free: false
		}
	},
	{
		id: "glm-5v-turbo",
		name: "GLM-5v-Turbo",
		contextWindow: 2e5,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.71 credits",
			free: false
		}
	},
	{
		id: "minimax-m3",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.25 credits",
			free: false
		}
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax-M2.7",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.19 credits",
			free: false
		}
	},
	{
		id: "kimi-k3-1",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.8-preview",
		name: "Kimi-K2.8-Preview",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.77 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.7",
		name: "Kimi-K2.7-Code",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.57 credits",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52 credits",
			free: false
		}
	},
	{
		id: "deepseek-v4-pro",
		name: "Deepseek-V4-Pro",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.51 credits",
			free: false
		}
	}
];
/**
* Static CLI models for the international endpoint, captured 2026-09-11 from
* the App-form `/v3/config` document (the 20 ids of its `cli` agent, in order).
*
* Same purpose and same discipline as {@link FALLBACK_WORKBUDDY_MODELS}: it
* covers the window before the first successful fetch and an offline start,
* and it is deliberately *not* a promise about the upstream's current state.
* Reasoning metadata is verbatim from that snapshot. No promo badge is baked
* in: promotions are time-boxed (`modelPromotions` carries `validFrom`/
* `validUntil`), so hard-coding a "Free now" label would keep claiming a
* discount the upstream may have already ended.
*/
const FALLBACK_WORKBUDDY_AI_MODELS = [
	{
		id: "default-model",
		name: "Auto",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: { free: false }
	},
	{
		id: "fast-model",
		name: "Fast",
		contextWindow: 2e5,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.34",
			free: false
		}
	},
	{
		id: "balanced-model",
		name: "Balanced",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.59",
			free: false
		}
	},
	{
		id: "primary-model",
		name: "Primary",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "deep-model",
		name: "Deep",
		contextWindow: 176e3,
		maxTokens: 24e3,
		supportsImages: true,
		reasoning: {
			supports: false,
			onlyReasoning: false,
			canDisableThinking: true
		},
		billing: {
			credits: "x3.33",
			free: false
		}
	},
	{
		id: "hy4-preview-f",
		name: "Hy4 preview",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "hy3",
		name: "Hy3",
		contextWindow: 192e3,
		maxTokens: 64e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["low", "high"],
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "deepseek-v4.1-flash",
		name: "Deepseek-V4.1-Flash",
		contextWindow: 3e5,
		defaultContextWindow: 3e5,
		supportedContextWindows: [3e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "high",
			canDisableThinking: false
		},
		billing: {
			free: false,
			rateUnknown: true
		}
	},
	{
		id: "gpt-6-astra",
		name: "GPT-6-Astra",
		contextWindow: 4e5,
		defaultContextWindow: 4e5,
		supportedContextWindows: [4e5, 1e6],
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x6.67",
			free: false
		}
	},
	{
		id: "gpt-5.6-sol",
		name: "GPT-5.6-Sol",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x3.47",
			free: false
		}
	},
	{
		id: "gpt-5.6-terra",
		name: "GPT-5.6-Terra",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x1.39",
			free: false
		}
	},
	{
		id: "gpt-5.6-luna",
		name: "GPT-5.6-Luna",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh",
				"max"
			],
			defaultEffort: "medium",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.14",
			free: false
		}
	},
	{
		id: "gpt-5.5",
		name: "GPT-5.5",
		contextWindow: 1e6,
		maxTokens: 128e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x3.31",
			free: false
		}
	},
	{
		id: "gpt-5.4",
		name: "GPT-5.4",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"medium",
				"high",
				"xhigh"
			],
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.65",
			free: false
		}
	},
	{
		id: "gpt-5.3-codex",
		name: "GPT-5.3-Codex",
		contextWindow: 272e3,
		maxTokens: 72e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.25",
			free: false
		}
	},
	{
		id: "gemini-3.5-flash",
		name: "Gemini-3.5-Flash",
		contextWindow: 1e6,
		maxTokens: 65536,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.99",
			free: false
		}
	},
	{
		id: "glm-5.3",
		name: "GLM-5.3",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 48e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			supportedEfforts: ["high", "xhigh"],
			defaultEffort: "high",
			canDisableThinking: true
		},
		billing: {
			credits: "x0.79",
			free: false
		}
	},
	{
		id: "kimi-k3",
		name: "Kimi-K3",
		contextWindow: 1e6,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x1.62",
			free: false
		}
	},
	{
		id: "kimi-k2.6",
		name: "Kimi-K2.6",
		contextWindow: 256e3,
		maxTokens: 32e3,
		supportsImages: true,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.52",
			free: false
		}
	}
];
/**
* Mutable catalog shared by the shim's `/v1/models` and the adapter.
*
* Visibility is separate from content. A variant whose app has no credentials
* must expose *no* models rather than a fallback roster: the DSH model picker
* drops an empty group, so an empty catalog is exactly how a provider hides
* without touching registration. Serving the fallback to a signed-out user
* instead offers models that can only fail (`store.resolve()` throws on the
* first message), which is worse than showing nothing.
*
* The flag defaults to visible so a directly-constructed catalog behaves as it
* always has; the plugin runtime applies the credential gate.
*/
var WorkBuddyCatalog = class {
	models;
	visible = true;
	useMaximumContextWindow = false;
	constructor(initial = FALLBACK_WORKBUDDY_MODELS) {
		this.models = initial;
	}
	/** Current entries; empty while the variant has no usable credential. */
	current() {
		if (!this.visible) return [];
		return this.models.map((model) => {
			const current = modelWithCurrentPromotion(model);
			const maximum = current.supportedContextWindows === void 0 ? void 0 : Math.max(...current.supportedContextWindows);
			return this.useMaximumContextWindow && maximum !== void 0 && maximum > current.contextWindow ? {
				...current,
				defaultContextWindow: current.defaultContextWindow ?? current.contextWindow,
				contextWindow: maximum
			} : current;
		});
	}
	/** Replace the list; callers invalidate their adapter snapshot after this. */
	set(models) {
		this.models = [...models];
	}
	/** Whether this variant's models are exposed at all. */
	isVisible() {
		return this.visible;
	}
	/**
	* Show or hide the whole catalog. Returns whether the value changed, so the
	* caller can skip an invalidation that would re-render an identical list.
	*/
	setVisible(visible) {
		if (this.visible === visible) return false;
		this.visible = visible;
		return true;
	}
	/** Select the largest declared international window where the upstream offers one. */
	setUseMaximumContextWindow(useMaximum) {
		if (this.useMaximumContextWindow === useMaximum) return false;
		this.useMaximumContextWindow = useMaximum;
		return true;
	}
	/** Models to fall back to when the upstream fetch fails; ignores visibility. */
	fallback() {
		return this.models;
	}
};
//#endregion
//#region src/version.ts
const WORKBUDDY_CONNECT_VERSION = "0.7.2";
//#endregion
//#region src/host-heartbeat.ts
/**
* Host-side heartbeat: a small JSON file written under `$DSH_HOME` once the
* `workbuddy` provider is registered. The status CLI reads it to report
* whether the host bundle is alive, independent of the browser card.
*
* The browser (client) bundle cannot write files; its health is reported
* only through `console.error` on failure (see `src/client/index.tsx`).
* This asymmetry is intentional: the host is the load-bearing half, and
* a missing heartbeat unambiguously means the host never started.
*
* @module dsh-workbuddy-connect/host-heartbeat
*/
/** Basename of the host heartbeat file inside the Harness home. */
const WORKBUDDY_HOST_HEARTBEAT_FILENAME = ".workbuddy-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function workbuddyHostHeartbeatPath() {
	return join(resolveDshHome(), WORKBUDDY_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and
* the status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-workbuddy-connect",
		pluginVersion: WORKBUDDY_CONNECT_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(workbuddyHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(workbuddyHostHeartbeatPath(), { force: true });
	} catch {}
}
/** Read and validate the heartbeat; returns `undefined` when absent or malformed. */
async function readHostHeartbeat() {
	let raw;
	try {
		raw = await readFile(workbuddyHostHeartbeatPath(), "utf8");
	} catch {
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.version === HEARTBEAT_FORMAT_VERSION && parsed.package === "dsh-workbuddy-connect" && typeof parsed.registeredAt === "number" && typeof parsed.pid === "number") return {
			version: HEARTBEAT_FORMAT_VERSION,
			package: "dsh-workbuddy-connect",
			pluginVersion: typeof parsed.pluginVersion === "string" ? parsed.pluginVersion : "unknown",
			registeredAt: parsed.registeredAt,
			pid: parsed.pid
		};
	} catch {}
}
/**
* Parse a WMI `CreationDate` (CIM_DATETIME) into epoch milliseconds; returns
* `undefined` for anything that does not match the format, never throws.
*
* The CIM_DATETIME layout is `yyyymmddHHMMSS.mmmmmmsUUU`: local wall-clock
* fields, a 6-digit microsecond fraction, and a **3-digit signed UTC offset
* in minutes** (`+000`, `+480` for UTC+8, `-300` for UTC−5). The fields are
* therefore *not* UTC — the offset must be subtracted to obtain the epoch:
* `+480` means local time runs 480 minutes ahead of UTC, so
* `20260923104314.239907+480` is `2026-09-23T02:43:14.000Z`. A 4-digit offset
* is not part of the format and is rejected rather than partially matched.
*/
function parseWmiCreationDate(value) {
	const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d+)([+-]\d{3})$/);
	if (m === null) return void 0;
	const [, y, mo, d, h, mi, s, , offset] = m;
	const [year, month, day, hour, minute, second] = [
		y,
		mo,
		d,
		h,
		mi,
		s
	].map(Number);
	if (month < 1 || month > 12 || day < 1 || day > 31) return void 0;
	if (hour > 23 || minute > 59 || second > 59) return void 0;
	const epoch = Date.UTC(year, month - 1, day, hour, minute, second) - Number(offset) * 6e4;
	return Number.isFinite(epoch) ? epoch : void 0;
}
/**
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: `wmic` prints a CIM_DATETIME `CreationDate` — local fields plus a
*   signed minute offset (see {@link parseWmiCreationDate}); the epoch it
*   yields is comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const token = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{14})\.(\d+)([+-]\d{3})(?=\s|$)/)?.[0];
			if (token === void 0) return void 0;
			return parseWmiCreationDate(token);
		}
		const out = execFileSync("ps", [
			"-o",
			"lstart=",
			"-p",
			String(pid)
		], {
			encoding: "utf8",
			env: {
				...process.env,
				LC_ALL: "C",
				LANG: "C"
			}
		}).trim();
		if (out === "") return void 0;
		const ms = Date.parse(out);
		return Number.isFinite(ms) ? ms : void 0;
	} catch {
		return;
	}
}
/**
* Whether the heartbeat's PID is still alive *and* still the same process that
* registered it. A stale heartbeat (host crashed without clearing the file)
* is distinguished from a live host by two checks:
*
* 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
* 2. The process holding that PID started at or before `registeredAt`. A host
*    that registered the heartbeat must have been started before writing it,
*    so `start <= registeredAt`; a recycled PID belongs to an unrelated process
*    started after the host died, so `start > registeredAt` correctly reads dead.
*
* PID-only detection is not enough: after a crash the OS may hand the same PID
* to an unrelated process, and the un-cleared stale heartbeat would otherwise
* produce a false "Host running". When the process start time cannot be read
* (e.g. unsupported platform) the check degrades to plain PID liveness.
*/
function isHeartbeatProcessAlive(heartbeat) {
	try {
		process.kill(heartbeat.pid, 0);
	} catch {
		return false;
	}
	const startAtMs = processStartTimeMs(heartbeat.pid);
	if (startAtMs === void 0) return true;
	return startAtMs <= heartbeat.registeredAt;
}
//#endregion
export { validAppVersion as $, extractDisplayErrorMessage as A, randomSentinel as B, WORKBUDDY_VARIANTS as C, WORKBUDDY_UPDATE_PATH as D, WORKBUDDY_STATUS_PATH as E, prepareCnChatBody as F, readCliVersion as G, FALLBACK_CN_APP_VERSION as H, prepareInternationalChatBody as I, WORKBUDDY_APP_VERSION_FILENAME as J, resolveChatIdentity as K, regionOf as L, normalizeCredits as M, parseModelCatalog as N, WorkBuddyUpstreamClient as O, prepareChatBody as P, resolveAppVersion as Q, PROBE_EFFORT_CANDIDATES as R, CN_VARIANT as S, WORKBUDDY_PROBE_PATH as T, chatUserAgent as U, CN_APP_VERSION_FILENAME as V, fallbackChatIdentity as W, installedAppVersion as X, appUserAgent as Y, readBundleVersion as Z, desktopAuthCandidatesFor as _, readHostHeartbeat as a, atRestKeyProviderFor as b, WORKBUDDY_CONNECT_VERSION as c, WorkBuddyCatalog as d, WORKBUDDY_AUTH_FILENAME as f, defaultDesktopAuthPath as g, defaultDesktopAuthCandidates as h, processStartTimeMs as i, modelWithCurrentPromotion as j, classifyUpstreamError as k, FALLBACK_WORKBUDDY_AI_MODELS as l, WorkBuddyCredentialStore as m, clearHostHeartbeat as n, workbuddyHostHeartbeatPath as o, WORKBUDDY_AUTH_FILE_ENV as p, validCliVersion as q, isHeartbeatProcessAlive as r, writeHostHeartbeat as s, WORKBUDDY_HOST_HEARTBEAT_FILENAME as t, FALLBACK_WORKBUDDY_MODELS as u, parseWorkBuddyAuth as v, variantFor as w, AI_VARIANT as x, workbuddyOwnAuthPath as y, probeModel as z };
