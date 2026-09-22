import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, release } from "node:os";
import { basename, dirname, join } from "node:path";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
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
* The version is only ever a UA component: a missing App, an unreadable
* plist, or a bad cached value degrades to the last saved value and finally to
* a compiled-in constant, and never blocks credential use or the provider.
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
* The upstream's "this effort value is not supported" code, measured
* 2026-09-11 (plan §4.2). It is *not* treated as a permanent protocol promise:
* anything unrecognized degrades to `unknown` rather than to a capability
* conclusion.
*/
const INVALID_EFFORT_CODE = "invalid_reasoning_effort";
/** Whether an attempt is an attributable rejection of the effort value. */
function isEffortRejection(attempt) {
	return attempt.status === 400 && attempt.errorCode === INVALID_EFFORT_CODE;
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
* uses {@link PROBE_EFFORT_CANDIDATES}.
*/
async function probeModel(options) {
	const sentinel = options.sentinel ?? randomSentinel;
	const candidates = options.candidates ?? PROBE_EFFORT_CANDIDATES;
	const timeoutMs = options.timeoutMs ?? 3e4;
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
	if (!isEffortRejection(sentinelAttempt)) return {
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
		if (isEffortRejection(levelAttempt)) continue;
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
* @param extraTags - badge tags recovered from another document, merged after
* the row's own (the product document carries the roster, the console one the
* badges; see `fetchPromoBadges`).
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
	const normalized = normalizeCredits(credits);
	const free = normalized !== void 0 && /^x?0\.0+$/u.test(normalized);
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
	const lower = body.toLowerCase();
	for (const marker of HARD_CREDIT_MARKERS) if (lower.includes(marker.toLowerCase()) || body.includes(marker)) return "hard_credit";
	for (const marker of SESSION_DEAD_MARKERS) if (body.includes(marker)) return "session_dead";
	if (status === 429) return "soft_rate";
	if (status === 404) return "not_found";
	if (status >= 500) return "server";
	if (status >= 400) return "client";
	return "client";
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
* `userAgent` carries the desktop identity for chat and probe requests; when
* it is absent the shared CLI-form UA applies. Refresh shares `commonHeaders`
* but never this override, so the two paths cannot drift into each other.
*/
function chatHeaders(credential, userAgent) {
	return {
		...commonHeaders(credential),
		...userAgent === void 0 ? {} : { "User-Agent": userAgent },
		"Content-Type": "application/json",
		...credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid },
		...credential.enterpriseId === void 0 || credential.enterpriseId === "" ? { "X-No-Enterprise-Id": "1" } : { "X-Enterprise-Id": credential.enterpriseId },
		...credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain },
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
		let userAgent;
		try {
			userAgent = chatUserAgent(await this.resolveChatIdentity(region), region);
		} catch {
			userAgent = chatUserAgent(fallbackChatIdentity(region), region);
		}
		let response;
		try {
			response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
				method: "POST",
				headers: {
					...chatHeaders(credential, userAgent),
					"Authorization": `Bearer ${credential.accessToken}`
				},
				body: region === "global" ? prepareInternationalChatBody(bodyJson) : bodyJson,
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
	* itself fetches. CN used to read `/console/enterprises/personal/models` (the
	* console catalog) instead, and that was the reason its model list drifted
	* from the desktop App's: the console document lags the product one, still
	* offering `auto`/`kimi-k3-1` while withholding `glm-5.3-flashx`,
	* `kimi-k3-2`, `minimax-m3-pay` and `minimax-m2.7`.
	*
	* What actually distinguishes the two variants here is the User-Agent, not
	* the path: the gateway splits `/v3/config` by client identity, and the split
	* is load-bearing rather than cosmetic. A CLI-shaped UA yields the CLI's
	* roster (the chat models this plugin serves), while an App-shaped UA yields
	* the App's internal roster (`codewise-*`, NES/completion helpers). CN keeps
	* the CLI UA it sends for chat — the catalog it advertises is the one its own
	* requests can use, which is also the discipline that keeps a never-servable
	* id like `hy4-preview-x` out of the picker. The international variant has no
	* CLI identity, so it keeps the App-shaped UA.
	*
	* Promo badges are the one thing `/v3/config` does not carry, so the CN path
	* makes a second, best-effort read of the console catalog for them alone —
	* see {@link fetchPromoBadges}.
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
	* `/console/enterprises/personal/models`. Since the roster now comes from the
	* product document, those tags are read from the console one in a second
	* request and merged by id.
	*
	* Best-effort by construction: a badge is a label on a price, so failing to
	* read this document must not fail a catalog refresh. Every failure — network,
	* envelope, an unreadable body — returns undefined, and the models simply
	* ship without badges.
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
			accounts.push({
				packageName: typeof account["PackageName"] === "string" ? account["PackageName"] : "(unnamed)",
				remain,
				size: size > 0 ? size : numberField("CapacitySize")
			});
		}
		return {
			total,
			accounts
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
		let userAgent;
		try {
			userAgent = chatUserAgent(await this.resolveChatIdentity(international ? "global" : "cn"), international ? "global" : "cn");
		} catch {
			userAgent = chatUserAgent(fallbackChatIdentity(international ? "global" : "cn"), international ? "global" : "cn");
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
					...chatHeaders(credential, userAgent),
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
* allowed to chat with, and joining rather than trusting it outright drops ids
* the document lists but cannot serve (`hy4-preview-x` and `minimax-m2.5` are
* both published and both answer `code 11102 service info not found` on the
* chat route).
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
function prepareInternationalChatBody(source) {
	const prepared = prepareChatBody(source);
	let body;
	try {
		body = JSON.parse(prepared);
	} catch {
		return prepared;
	}
	if (!isObject(body)) return prepared;
	const messages = body["messages"];
	if (!Array.isArray(messages)) return prepared;
	const first = messages[0];
	if (isObject(first) && first["role"] === "system") return prepared;
	messages.unshift({
		role: "system",
		content: INTERNATIONAL_SYSTEM_PROMPT
	});
	return JSON.stringify(body);
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
* `%LOCALAPPDATA%` (Local), older ones under `%APPDATA%` (Roaming). WSL probes
* those same Windows locations through its mounted Windows profile before the
* native Linux location.
*/
function defaultDesktopAuthCandidates() {
	const home = homedir();
	if (process.platform === "darwin") return [join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "win32") return [join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"), join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")];
	if (process.platform === "linux") {
		const linux = join(home, ".config", ...DESKTOP_AUTH_RELATIVE_PATH);
		return isWsl() ? [...wslDesktopAuthCandidates(home), linux] : [linux];
	}
	return [];
}
/**
* The platform-default candidates for one variant, in probe order.
*
* Both apps write into the *same* shared `CodeBuddyExtension` auth directory
* and differ only in the file's basename, so the per-platform ordering above
* is reused verbatim and just the filename is swapped.
*/
function desktopAuthCandidatesFor(variant) {
	return defaultDesktopAuthCandidates().map((path) => join(dirname(path), variant.desktopFilename));
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
/** Whether a value is a mutable record (not null, not an array). */
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
/**
* The key a newer desktop app wraps its sensitive fields in.
*
* WorkBuddy 5.6.0 writes `accessToken`, `refreshToken`, and the account's own
* details as `{"$wbEncrypted":1,"envelope":"<base64>"}` instead of plain
* strings. The envelope's key belongs to the desktop app, so the payload is
* opaque to this plugin — but the *presence* of the marker is not, and that is
* what makes "the file is newer than the plugin" distinguishable from "nobody
* is signed in".
*/
const WORKBUDDY_ENCRYPTED_MARKER = "$wbEncrypted";
/** The marker value of an envelope object; undefined for every other value. */
function envelopeMarker(value) {
	if (!isRecord(value)) return void 0;
	const marker = value[WORKBUDDY_ENCRYPTED_MARKER];
	return typeof marker === "number" && Number.isFinite(marker) ? marker : void 0;
}
/** Collect every enveloped field a document declares, identity fields included. */
function collectEnvelopes(...records) {
	const fields = [];
	let marker;
	for (const record of records) for (const [field, value] of Object.entries(record)) {
		const found = envelopeMarker(value);
		if (found === void 0 || fields.includes(field)) continue;
		marker ??= found;
		fields.push(field);
	}
	return marker === void 0 ? void 0 : {
		marker,
		fields
	};
}
/**
* Read a WorkBuddy auth document in either *plaintext* on-disk shape — the
* plugin OAuth nested form `{"auth":{...},"account":{...}}` and the flat panel
* form — and report the encrypted shape when that is what the file is.
*
* The plaintext branch is checked first and unconditionally: every desktop app
* up to 5.5.6 writes a string token, and that must keep parsing exactly as it
* always has. Only when a document carries *no* plaintext access token is an
* envelope looked for — the case that used to be indistinguishable from an
* empty file.
*/
function inspectWorkBuddyAuth(text) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {};
	}
	if (!isRecord(parsed)) return {};
	const document = parsed;
	let auth;
	let identity;
	if (isRecord(document["auth"])) {
		auth = document["auth"];
		identity = isRecord(document["account"]) ? document["account"] : {};
	} else {
		auth = document;
		identity = document;
	}
	const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
	if (accessToken === "") {
		const encrypted = collectEnvelopes(auth, identity);
		return encrypted === void 0 ? {} : { encrypted };
	}
	const expiresAtMs = typeof auth["expiresAt"] === "number" ? expiryToMs(auth["expiresAt"]) : 0;
	const refreshExpiresAtMs = typeof auth["refreshExpiresAt"] === "number" ? expiryToMs(auth["refreshExpiresAt"]) : void 0;
	const enterpriseId = optionalString(identity["enterpriseId"]);
	const nickname = optionalString(identity["nickname"]);
	return { credential: {
		accessToken,
		refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
		expiresAtMs,
		...refreshExpiresAtMs === void 0 ? {} : { refreshExpiresAtMs },
		domain: optionalString(auth["domain"]) ?? "",
		uid: optionalString(identity["uid"]) ?? "",
		...enterpriseId === void 0 ? {} : { enterpriseId },
		...nickname === void 0 ? {} : { nickname },
		source: "desktop"
	} };
}
/**
* Parse a WorkBuddy auth document into a credential.
*
* Kept as the compatibility surface for callers that only want the token; it
* cannot say *why* a document yielded nothing. Use
* {@link inspectWorkBuddyAuth} when that distinction matters — a newer desktop
* app's encrypted document parses to `undefined` here exactly like an empty
* one, which is how "the file is present and unreadable" used to be reported as
* "nobody is signed in".
*/
function parseWorkBuddyAuth(text) {
	return inspectWorkBuddyAuth(text).credential;
}
/**
* Explain a desktop auth file whose tokens this build cannot read.
*
* One sentence shared by {@link WorkBuddyCredentialStore.status}'s `reason`
* (which the card renders verbatim), the store's `resolve()` error, and
* `doctor`. It deliberately leads with what was *found*, because the generic
* hint it replaces — "sign in once in the desktop app" — sends the user to
* re-sign-in, which rewrites the very file that cannot be read, instead of
* pointing at the version gap.
*/
function encryptedDesktopAuthReason(appName, file) {
	return `${appName} desktop auth file at ${file.path} is written in an encrypted format this plugin version cannot read (${WORKBUDDY_ENCRYPTED_MARKER}=${file.format.marker}, encrypted fields: ${file.format.fields.join(", ")}); the ${appName} desktop app that wrote it is newer than this plugin — update dsh-workbuddy-connect to read it (signing in again rewrites the same file and will not help)`;
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
	desktopPathOverride;
	inflight;
	constructor(options) {
		this.variant = options.variant;
		this.refresh = options.refresh;
		this.refreshMarginMs = options.refreshMarginMs ?? 3e5;
		this.ownPath = options.ownPath ?? (options.variant ? join(resolveDshHome(), options.variant.ownFilename) : workbuddyOwnAuthPath());
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
		return (await this.readCredential()).credential;
	}
	/**
	* Read both slots and pick the credential to serve, keeping the desktop
	* slot's verdict for the callers that have to *explain* a sign-out.
	*/
	async readCredential() {
		const [desktop, own] = await Promise.all([this.readDesktop(), this.readOwn()]);
		const desktopCredential = desktop.credential;
		if (this.variant !== void 0) for (const [label, credential] of [["desktop file", desktopCredential], ["plugin copy", own]]) {
			if (credential === void 0) continue;
			const region = regionOf(credential.domain);
			if (region !== this.variant.region) throw new Error(`${this.variant.displayName} received a ${region === "cn" ? "WorkBuddy (CN)" : "WorkBuddy AI"} credential in its ${label} (domain ${JSON.stringify(credential.domain)}); point ${this.variant.env} at the ${this.variant.appName} sign-in, or remove the mismatched file`);
		}
		const encrypted = desktop.encrypted === void 0 ? {} : { encrypted: desktop.encrypted };
		if (desktopCredential === void 0) return own === void 0 ? encrypted : {
			credential: own,
			...encrypted
		};
		if (own === void 0) return { credential: desktopCredential };
		if (desktopCredential.uid !== own.uid || desktopCredential.enterpriseId !== own.enterpriseId) return { credential: desktopCredential };
		return { credential: own.expiresAtMs > desktopCredential.expiresAtMs ? own : desktopCredential };
	}
	/**
	* The credential to send upstream: {@link current}, refreshed on demand.
	* Single-flight, so parallel requests share one refresh.
	*/
	async resolve() {
		const read = await this.readCredential();
		const credential = read.credential;
		if (credential === void 0) {
			const candidates = this.resolveDesktopCandidates();
			const desktop = candidates.length > 0 ? candidates.join(" or ") : "(no desktop path on this platform)";
			const app = this.variant?.appName ?? "WorkBuddy";
			throw new Error(`workbuddy: no signed-in ${app} account found; sign in once in the ${app} desktop app (expected ${desktop} or ${this.variant?.env ?? "WORKBUDDY_AUTH_FILE"}), or refresh an existing session` + (read.encrypted === void 0 ? "" : ` — ${encryptedDesktopAuthReason(app, read.encrypted)}`));
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
			const read = await this.readCredential();
			const credential = read.credential;
			if (credential === void 0) return {
				state: "signed-out",
				...read.encrypted === void 0 ? {} : { reason: encryptedDesktopAuthReason(this.variant?.appName ?? "WorkBuddy", read.encrypted) }
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
				reason: error instanceof Error ? error.message : String(error)
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
			const inspection = inspectWorkBuddyAuth(text);
			if (inspection.credential !== void 0) return { credential: inspection.credential };
			if (inspection.encrypted !== void 0) return { encrypted: {
				path: desktopPath,
				format: inspection.encrypted
			} };
			return {};
		}
		return {};
	}
	async readOwn() {
		try {
			return parseOwnDocument(await readFile(this.ownPath, "utf8"));
		} catch (error) {
			if (isENOENT(error)) return void 0;
			return;
		}
	}
	/** Whether any desktop-file candidate exists as a regular file; diagnostics only. */
	async desktopFilePresent() {
		for (const desktopPath of this.resolveDesktopCandidates()) try {
			if ((await stat(desktopPath)).isFile()) return true;
		} catch {}
		return false;
	}
	/**
	* Classify the desktop auth file's first present candidate.
	*
	* Subsumes {@link desktopFilePresent} for `doctor`, which needs the *reason*
	* a present file yielded nothing — "present" beside "signed-out" is exactly
	* the pair that made a newer App's format look like a stale path. Reads the
	* file (the presence question alone is a `stat`), never refreshes, never
	* throws, and never returns token material.
	*/
	async inspectDesktopAuthFile() {
		for (const desktopPath of this.resolveDesktopCandidates()) {
			let text;
			try {
				text = await readFile(desktopPath, "utf8");
			} catch (error) {
				if (isENOENT(error)) continue;
				return {
					format: "unrecognized",
					path: desktopPath
				};
			}
			const inspection = inspectWorkBuddyAuth(text);
			if (inspection.credential !== void 0) return {
				format: "plaintext",
				path: desktopPath
			};
			if (inspection.encrypted !== void 0) return {
				format: "encrypted",
				path: desktopPath,
				encrypted: {
					path: desktopPath,
					format: inspection.encrypted
				}
			};
			return {
				format: "unrecognized",
				path: desktopPath
			};
		}
		return { format: "absent" };
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
* Static CLI models observed on the CN product document (re-verified against
* `/v3/config` 2026-09-22, including the thinking-effort and billing metadata).
* The upstream refresh replaces this list at startup; it exists so the provider
* registers with a usable catalog even while the first fetch is in flight or
* offline.
*
* The list tracks the `cli` agent's model roster exactly: the 17 models the
* desktop CLI offers. Reasoning metadata is taken verbatim from the live
* document — each model's supported effort set and whether thinking can be
* disabled — and the `free` flag follows the upstream `x0.00` credits marker.
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
			badges: ["夜间免费"],
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
			badges: ["限时免费"],
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
			badges: ["独家优惠"],
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
		id: "glm-5.3-flashx",
		name: "GLM-5.3-FlashX",
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
			credits: "x0.14 credits",
			free: false
		}
	},
	{
		id: "glm-5.2",
		name: "GLM-5.2",
		contextWindow: 1e6,
		maxTokens: 64e3,
		supportsImages: false,
		reasoning: {
			supports: true,
			onlyReasoning: true,
			defaultEffort: "medium",
			canDisableThinking: false
		},
		billing: {
			credits: "x0.79 credits",
			badges: ["夜间折扣"],
			free: false
		}
	},
	{
		id: "glm-5.1",
		name: "GLM-5.1",
		contextWindow: 2e5,
		maxTokens: 48e3,
		supportsImages: false,
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
		id: "minimax-m3-pay",
		name: "MiniMax-M3",
		contextWindow: 512e3,
		maxTokens: 128e3,
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
			credits: "x0.26 credits",
			free: false
		}
	},
	{
		id: "kimi-k3-2",
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
//#endregion
//#region src/version.ts
const WORKBUDDY_CONNECT_VERSION = "0.6.0";
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
* Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
* when it cannot be determined (no such PID, platform lacks a readable source).
*
* - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
*   `Date.parse` resolves it against the local clock, which matches how
*   `registeredAt` (a `Date.now()` absolute value) is expressed.
* - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
*   `Date.UTC`, again comparable to `registeredAt`.
*
* Failures return `undefined` so callers can fall back to plain PID liveness
* rather than mis-report a running host as dead.
*/
function processStartTimeMs(pid) {
	try {
		if (process.platform === "win32") {
			const m = execFileSync("wmic", [
				"process",
				"where",
				`processid=${pid}`,
				"get",
				"CreationDate"
			], {
				encoding: "utf8",
				windowsHide: true
			}).match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/);
			if (m === null) return void 0;
			const [, y, mo, d, h, mi, s] = m;
			const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
			return Number.isFinite(ms) ? ms : void 0;
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
	desktopFilename: "workbuddy-desktop.info",
	ownFilename: ".workbuddy-auth.json",
	probeFilename: ".workbuddy-probe.json",
	catalogFilename: ".workbuddy-catalog.json",
	statusPath: WORKBUDDY_STATUS_PATH,
	probePath: WORKBUDDY_PROBE_PATH
}, {
	id: "workbuddy-ai",
	displayName: "WorkBuddy AI",
	appName: "WorkBuddy AI",
	region: "global",
	env: "WORKBUDDY_AI_AUTH_FILE",
	desktopFilename: "workbuddy-desktop-ai.info",
	ownFilename: ".workbuddy-ai-auth.json",
	probeFilename: ".workbuddy-ai-probe.json",
	catalogFilename: ".workbuddy-ai-catalog.json",
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
//#endregion
export { classifyUpstreamError as A, CN_APP_VERSION_FILENAME as B, defaultDesktopAuthPath as C, parseWorkBuddyAuth as D, inspectWorkBuddyAuth as E, prepareInternationalChatBody as F, resolveChatIdentity as G, chatUserAgent as H, regionOf as I, appUserAgent as J, validCliVersion as K, PROBE_EFFORT_CANDIDATES as L, normalizeCredits as M, parseModelCatalog as N, workbuddyOwnAuthPath as O, prepareChatBody as P, validAppVersion as Q, probeModel as R, defaultDesktopAuthCandidates as S, encryptedDesktopAuthReason as T, fallbackChatIdentity as U, FALLBACK_CN_APP_VERSION as V, readCliVersion as W, readBundleVersion as X, installedAppVersion as Y, resolveAppVersion as Z, WorkBuddyCatalog as _, WORKBUDDY_HOST_HEARTBEAT_FILENAME as a, WORKBUDDY_ENCRYPTED_MARKER as b, processStartTimeMs as c, writeHostHeartbeat as d, WORKBUDDY_CONNECT_VERSION as f, FALLBACK_WORKBUDDY_MODELS as g, FALLBACK_WORKBUDDY_AI_MODELS as h, variantFor as i, modelWithCurrentPromotion as j, WorkBuddyUpstreamClient as k, readHostHeartbeat as l, WORKBUDDY_STATUS_PATH as m, CN_VARIANT as n, clearHostHeartbeat as o, WORKBUDDY_PROBE_PATH as p, WORKBUDDY_APP_VERSION_FILENAME as q, WORKBUDDY_VARIANTS as r, isHeartbeatProcessAlive as s, AI_VARIANT as t, workbuddyHostHeartbeatPath as u, WORKBUDDY_AUTH_FILENAME as v, desktopAuthCandidatesFor as w, WorkBuddyCredentialStore as x, WORKBUDDY_AUTH_FILE_ENV as y, randomSentinel as z };
