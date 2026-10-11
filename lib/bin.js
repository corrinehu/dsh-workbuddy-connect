#!/usr/bin/env node
import { C as WORKBUDDY_VARIANTS, H as parseImportText, O as WorkBuddyUpstreamClient, S as CN_VARIANT, U as poolKeyOf, V as WorkBuddyAccountPool, a as readHostHeartbeat, b as atRestKeyProviderFor, c as WORKBUDDY_CONNECT_VERSION, l as FALLBACK_WORKBUDDY_AI_MODELS, m as WorkBuddyCredentialStore, nt as resolveAppVersion, o as workbuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, u as FALLBACK_WORKBUDDY_MODELS, w as variantFor } from "./host-heartbeat-m-4xv0-I.js";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/pool-cli.ts
/**
* Pool CLI commands: bulk import, listing, check-in, and enable/disable.
*
* Kept out of `bin.ts` so the existing doctor/status/logout paths stay
* untouched — the pool is additive, and a regression in it must not be able to
* break sign-in diagnostics.
*
* Every command here is *non-interactive by construction*: a batch tool that
* prompts is a batch tool that cannot run in a pipeline. Anything ambiguous (an
* unreadable file, a malformed line) is reported per input and the exit code says
* whether anything failed.
*
* @module dsh-workbuddy-connect/pool-cli
*/
/** Pool subcommands, so the CLI can dispatch on its first argument. */
const POOL_ACTIONS = /* @__PURE__ */ new Set([
	"accounts",
	"checkin",
	"clear",
	"disable",
	"enable",
	"import",
	"remove",
	"use"
]);
/** Import file extensions this reader will open when given a directory. */
const IMPORT_EXTENSIONS = /* @__PURE__ */ new Set([
	".json",
	".jsonl",
	".ndjson",
	".txt",
	".auth"
]);
/** A stable, non-reversible digest used for anonymous pool keys. */
function tokenHash(seed) {
	return createHash("sha256").update(seed).digest("hex");
}
/** Build one variant's pool. */
function makePool(path) {
	return new WorkBuddyAccountPool({
		...path === void 0 ? {} : { path },
		hashOf: tokenHash
	});
}
/**
* The default pool file for one variant.
*
* One file per variant, matching how every other per-variant store in this bundle
* names itself: the CN and international endpoints share account ids but never
* credentials, and one pool for both would hand a CN account to the international
* provider.
*/
function defaultPoolPath(variant) {
	return join(resolveDshHome(), variant.id === CN_VARIANT.id ? ".workbuddy-pool.json" : ".workbuddy-ai-pool.json");
}
/** Collect the files one import path refers to. */
function expandImportPaths(inputs) {
	const files = [];
	const errors = [];
	for (const input of inputs) {
		const absolute = resolve(input);
		let stats;
		try {
			stats = statSync(absolute);
		} catch (error) {
			errors.push({
				path: input,
				reason: `cannot read: ${error instanceof Error ? error.message : String(error)}`
			});
			continue;
		}
		if (stats.isDirectory()) {
			let names;
			try {
				names = readdirSync(absolute);
			} catch (error) {
				errors.push({
					path: input,
					reason: `cannot list: ${error instanceof Error ? error.message : String(error)}`
				});
				continue;
			}
			for (const name of names.sort()) {
				if (!IMPORT_EXTENSIONS.has(extname(name).toLowerCase())) continue;
				files.push(join(absolute, name));
			}
			continue;
		}
		files.push(absolute);
	}
	return {
		files,
		errors
	};
}
/**
* Read and parse every import file, returning the accounts found.
*
* A file that yields zero accounts is an error rather than a silent no-op: the
* most likely cause is pointing at the wrong file, and "imported 0 accounts" with
* exit 0 would let that mistake stand.
*/
function collectAccounts(files) {
	const accounts = [];
	const errors = [];
	const perFile = [];
	for (const file of files) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch (error) {
			errors.push({
				path: file,
				reason: `cannot read: ${error instanceof Error ? error.message : String(error)}`
			});
			continue;
		}
		try {
			const parsed = parseImportText(text);
			if (parsed.accounts.length === 0) {
				errors.push({
					path: file,
					reason: "no account document found (expected an auth document, an array, or JSON Lines)"
				});
				continue;
			}
			accounts.push(...parsed.accounts);
			perFile.push({
				path: file,
				accounts: parsed.accounts.length,
				...parsed.skippedLines === 0 ? {} : { skippedLines: parsed.skippedLines }
			});
		} catch (error) {
			errors.push({
				path: file,
				reason: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return {
		accounts,
		errors,
		perFile
	};
}
/** Secret-free summary of one pool entry, for CLI output. */
function describeEntry(entry, index) {
	return {
		index: index + 1,
		key: entry.key,
		...entry.credential.nickname === void 0 ? {} : { nickname: entry.credential.nickname },
		...entry.credential.domain === "" ? {} : { domain: entry.credential.domain },
		hasRefreshToken: entry.credential.refreshToken !== "",
		accessTokenExpiresAtMs: entry.credential.expiresAtMs,
		accessTokenExpires: entry.credential.expiresAtMs > 0 ? new Date(entry.credential.expiresAtMs).toISOString() : "unknown",
		disabled: entry.disabled === true,
		...entry.lastCheckinAtMs === void 0 ? {} : {
			lastCheckinAtMs: entry.lastCheckinAtMs,
			lastCheckinStatus: entry.lastCheckinStatus ?? "unknown"
		}
	};
}
/** Print a report as JSON or as the lines a human reads. */
function emit(report, jsonOutput, lines) {
	if (jsonOutput) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return;
	}
	process.stdout.write([...lines(), ""].join("\n"));
}
/**
* `import` — merge accounts from files or directories into the pool.
*
* `--replace` is offered because re-importing a *stale* export is a real workflow
* (the user may have regenerated their accounts elsewhere), and the default merge
* deliberately refuses to roll a fresher stored token back. The flag is explicit
* so the rollback is always a decision, never a side effect.
*/
function commandImport(pool, inputs, options) {
	if (inputs.length === 0) {
		process.stderr.write("workbuddy pool import: at least one file or directory is required\n");
		return 1;
	}
	const expanded = expandImportPaths(inputs);
	const collected = collectAccounts(expanded.files);
	const errors = [...expanded.errors, ...collected.errors];
	if (collected.accounts.length === 0) {
		emit({
			action: "import",
			pool: pool.filePath(),
			files: collected.perFile,
			errors,
			imported: 0,
			added: 0,
			updated: 0,
			skipped: 0,
			counts: pool.counts()
		}, options.json, () => [
			`Pool: ${pool.filePath()}`,
			...errors.map((error) => `ERROR ${error.path}: ${error.reason}`),
			"No accounts imported."
		]);
		return 1;
	}
	const deduped = /* @__PURE__ */ new Map();
	for (const account of collected.accounts) {
		const key = poolKeyOf(account, tokenHash);
		const previous = deduped.get(key);
		if (previous === void 0 || account.expiresAtMs > previous.expiresAtMs) deduped.set(key, account);
	}
	if (options.replace) pool.clear();
	const merged = pool.merge([...deduped.values()]);
	const counts = pool.counts();
	emit({
		action: "import",
		pool: pool.filePath(),
		files: collected.perFile,
		errors,
		imported: deduped.size,
		added: merged.added,
		updated: merged.updated,
		skipped: merged.skipped,
		entries: merged.entries,
		counts,
		...options.replace ? { replaced: true } : {}
	}, options.json, () => [
		`Pool: ${pool.filePath()}`,
		...collected.perFile.map((file) => `Read ${file.accounts} account(s) from ${file.path}${file.skippedLines === void 0 ? "" : ` (${file.skippedLines} line(s) without an account)`}`),
		...errors.map((error) => `ERROR ${error.path}: ${error.reason}`),
		...merged.entries.map((entry) => `  ${entry.action.padEnd(8)} ${entry.key}${entry.nickname === void 0 ? "" : ` (${entry.nickname})`}`),
		"",
		`Imported ${deduped.size} account(s): added=${merged.added} updated=${merged.updated} unchanged=${merged.skipped}`,
		`Pool now holds ${counts.total} account(s), ${counts.usable} usable.`
	]);
	return errors.length > 0 ? 1 : 0;
}
/** `accounts` — list the pool, secret-free. */
function commandAccounts(pool, options) {
	const entries = pool.all();
	const counts = pool.counts();
	emit({
		action: "accounts",
		pool: pool.filePath(),
		counts,
		accounts: entries.map(describeEntry)
	}, options.json, () => entries.length === 0 ? [`Pool: ${pool.filePath()}`, "No accounts in the pool; the plugin is using the desktop app's sign-in."] : [
		`Pool: ${pool.filePath()}`,
		`${counts.total} account(s), ${counts.usable} usable`,
		"",
		...entries.map((entry, index) => {
			const described = describeEntry(entry, index);
			return [
				`${String(described.index).padStart(3)}. ${described.key}`,
				described.nickname === void 0 ? "" : ` (${described.nickname})`,
				described.disabled ? " [disabled]" : "",
				`\n     expires ${described.accessTokenExpires}${described.hasRefreshToken ? "" : " (no refresh token)"}`,
				described.lastCheckinStatus === void 0 ? "" : `\n     last check-in ${described.lastCheckinStatus} at ${new Date(described.lastCheckinAtMs).toISOString()}`
			].join("");
		})
	]);
	return 0;
}
/**
* `checkin` — claim the daily grant for every usable account.
*
* Sequential on purpose. The accounts share one upstream origin, and a burst of
* parallel calls from one machine is the pattern most likely to be rate-limited —
* which would make the batch report a wall of transport failures and hide which
* accounts are actually fine.
*/
async function commandCheckin(pool, options, client = new WorkBuddyUpstreamClient()) {
	const entries = pool.usable();
	const rows = [];
	let ok = 0;
	let already = 0;
	let failed = 0;
	let auth = 0;
	for (const entry of entries) {
		const outcome = await client.dailyCheckin({
			...entry.credential,
			source: "dsh"
		});
		pool.markCheckin(entry.key, outcome.status);
		if (outcome.status === "ok") ok += 1;
		else if (outcome.status === "already") already += 1;
		else if (outcome.status === "auth") auth += 1;
		else failed += 1;
		const row = {
			key: entry.key,
			...entry.credential.nickname === void 0 ? {} : { nickname: entry.credential.nickname },
			status: outcome.status,
			detail: outcome.detail
		};
		if (options.credits && outcome.status !== "auth") try {
			row.credits = (await client.fetchCredits({
				...entry.credential,
				source: "dsh"
			})).total;
		} catch {}
		rows.push(row);
	}
	emit({
		action: "checkin",
		pool: pool.filePath(),
		total: entries.length,
		ok,
		already,
		failed,
		authInvalid: auth,
		results: rows
	}, options.json, () => entries.length === 0 ? [`Pool: ${pool.filePath()}`, "No usable accounts in the pool; nothing to check in."] : [
		`Pool: ${pool.filePath()}`,
		"",
		"key                                  | status  | credits | detail",
		"-------------------------------------+---------+---------+------------------------------",
		...rows.map((row) => [
			row.key.length > 36 ? row.key.slice(0, 36) : row.key.padEnd(36),
			"|",
			row.status.padEnd(7),
			"|",
			(row.credits === void 0 ? "-" : String(row.credits)).padEnd(7),
			"|",
			row.detail.replace(/\s+/gu, " ").slice(0, 40)
		].join(" ")),
		"",
		`total=${entries.length} ok=${ok} already=${already} failed=${failed} auth_invalid=${auth}`
	]);
	return auth > 0 ? 2 : failed > 0 ? 1 : 0;
}
/** Move one entry to the front of the pool, so rotation reaches it first. */
function moveToFront(pool, key) {
	const entries = pool.all();
	const index = entries.findIndex((entry) => entry.key === key);
	if (index <= 0) return index === 0;
	const [entry] = entries.splice(index, 1);
	entries.unshift(entry);
	pool.persist();
	return true;
}
/** `use` / `disable` / `enable` / `remove` — mutate one entry by key. */
function commandEntry(pool, action, key, options) {
	if (pool.get(key) === void 0) {
		process.stderr.write(`workbuddy pool ${action}: no account with key ${JSON.stringify(key)}\n`);
		return 1;
	}
	let changed;
	switch (action) {
		case "disable":
			changed = pool.setDisabled(key, true);
			break;
		case "enable":
			changed = pool.setDisabled(key, false);
			break;
		case "remove":
			changed = pool.remove(key);
			break;
		default: changed = moveToFront(pool, key);
	}
	const counts = pool.counts();
	emit({
		action,
		key,
		changed,
		counts
	}, options.json, () => [`${action}: ${changed ? "ok" : "no change"} — ${key}`, `Pool now holds ${counts.total} account(s), ${counts.usable} usable.`]);
	return changed ? 0 : 1;
}
/** `clear` — empty the pool. */
function commandClear(pool, options) {
	const counts = pool.counts();
	pool.clear();
	emit({
		action: "clear",
		removed: counts.total,
		counts: pool.counts()
	}, options.json, () => [`Cleared ${counts.total} account(s); the plugin falls back to the desktop app's sign-in.`]);
	return 0;
}
/**
* Parse and execute one pool subcommand; returns the process exit code.
*
* All argument handling lives here rather than in the CLI entry point so that
* entry point needs one import and one dispatch line — the pool is additive, and
* the smaller its footprint in the existing file, the smaller the chance a future
* upstream change collides with it.
*/
async function runPoolCommand(argv) {
	const [action, ...flags] = argv;
	let providerId;
	let poolPath;
	let jsonOutput = false;
	let replace = false;
	let credits = false;
	const positional = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--json") {
			jsonOutput = true;
			continue;
		}
		if (flag === "--replace") {
			replace = true;
			continue;
		}
		if (flag === "--credits") {
			credits = true;
			continue;
		}
		if (flag === "--provider" || flag === "--pool") {
			const value = flags[index + 1];
			if (value === void 0 || value.startsWith("--")) {
				process.stderr.write(`dsh-workbuddy-connect: ${flag} requires a value\n`);
				return 1;
			}
			if (flag === "--provider") providerId = value;
			else poolPath = value;
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		if (flag.startsWith("--pool=")) {
			poolPath = flag.slice(7);
			continue;
		}
		if (flag.startsWith("-")) {
			process.stderr.write(`dsh-workbuddy-connect: unknown option for pool ${action}: ${flag}\n`);
			return 1;
		}
		positional.push(flag);
	}
	const variant = providerId === void 0 ? CN_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	const pool = makePool(poolPath ?? defaultPoolPath(variant));
	const options = {
		json: jsonOutput,
		replace,
		credits
	};
	if ([
		"disable",
		"enable",
		"remove",
		"use"
	].includes(action)) {
		if (positional.length !== 1) {
			process.stderr.write(`dsh-workbuddy-connect: pool ${action} takes exactly one account key (see: dsh-workbuddy-connect accounts)\n`);
			return 1;
		}
		return commandEntry(pool, action, positional[0], options);
	}
	if (["accounts", "clear"].includes(action) && positional.length > 0) {
		process.stderr.write(`dsh-workbuddy-connect: pool ${action} takes no arguments; got ${positional.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "import": return commandImport(pool, positional, options);
			case "accounts": return commandAccounts(pool, options);
			case "checkin": return await commandCheckin(pool, options);
			case "clear": return commandClear(pool, options);
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: pool ${action} failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	return 1;
}
//#endregion
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-connect <command> [options]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  logout   remove the plugin-owned credential copy (the desktop app keeps its sign-in)",
		"",
		"Account pool (bulk import, rotation, daily check-in):",
		"  import <path...>   merge accounts from files or directories into the pool",
		"                     accepts the desktop auth document, the flat gateway auth,",
		"                     an array, a uid-keyed map, or JSON Lines",
		"  accounts           list the pool (never prints a token)",
		"  checkin            claim the daily credit grant for every usable account",
		"  use <key>          make one account the active one",
		"  enable|disable <key>   include or exclude one account from rotation",
		"  remove <key>       delete one account from the pool",
		"  clear              empty the pool (falls back to the desktop sign-in)",
		"",
		"  --provider  which product to inspect; defaults to workbuddy",
		`              one of: ${WORKBUDDY_VARIANTS.map((variant) => variant.id).join(", ")}`,
		"  --json      emit one secret-free JSON document (all commands)",
		"  --pool      pool file path (defaults to the plugin-owned file under $DSH_HOME)",
		"  --replace   import: replace the pool instead of merging into it",
		"  --credits   checkin: also read each account's remaining credit",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/**
* One variant's store plus the client that performs its refreshes.
*
* The key provider is built by the same shared helper the plugin host uses,
* so the CLI's `doctor`/`status` and the browser card can never disagree
* about which product's Electron a variant resolves.
*/
function makeStore(variant) {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({
		variant,
		refresh: (credential) => client.refreshToken(credential),
		keyProvider: atRestKeyProviderFor(variant)
	});
}
/** The plugin-owned credential copy for one variant, for display. */
function ownAuthPath(variant) {
	return makeStore(variant).ownAuthPath();
}
/** Fallback roster size for one variant. */
function fallbackCount(variant) {
	return variant.id === CN_VARIANT.id ? FALLBACK_WORKBUDDY_MODELS.length : FALLBACK_WORKBUDDY_AI_MODELS.length;
}
async function doctor(jsonOutput, variant) {
	const store = makeStore(variant);
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const desktopFormat = await store.desktopAuthFormat();
	const desktopPath = await store.resolvedDesktopAuthPath() ?? store.desktopAuthPath();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const appVersion = variant.region === "global" ? await resolveAppVersion() : void 0;
	const decryptionNote = status.state === "signed-out" && desktopFormat === "encrypted" && status.reason !== void 0 ? `Encrypted desktop credential could not be used: ${status.reason}` : void 0;
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-connect",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		provider: variant.id,
		displayName: variant.displayName,
		desktopAuthFile: {
			path: desktopPath ?? `(no platform default; set ${variant.env})`,
			present: desktopPresent,
			format: desktopFormat
		},
		ownAuthFile: ownAuthPath(variant),
		...appVersion === void 0 ? {} : { catalogUserAgent: {
			version: appVersion.version,
			source: appVersion.source,
			...appVersion.bundle === void 0 ? {} : { bundle: appVersion.bundle }
		} },
		hostHeartbeat: {
			path: workbuddyHostHeartbeatPath(),
			present: heartbeat !== void 0,
			...heartbeat === void 0 ? {} : {
				registeredAt: heartbeat.registeredAt,
				pid: heartbeat.pid
			},
			processAlive: hostAlive
		},
		signIn: status.state,
		fallbackModels: fallbackCount(variant),
		hints: [
			...decryptionNote !== void 0 ? [decryptionNote] : status.state === "signed-out" ? [`Sign in once in the ${variant.appName} desktop app, then run status again.`] : [],
			...desktopPresent ? [] : [`No ${variant.appName} desktop auth file at the expected path; set ${variant.env} if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson({
		...report,
		...decryptionNote === void 0 ? {} : { decryptionNote }
	});
	else process.stdout.write([
		`${variant.displayName} Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} — ${desktopFormat} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...appVersion === void 0 ? [] : [`Catalog User-Agent version: ${appVersion.version} (${appVersion.source})`],
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && desktopPresent ? 0 : 1;
}
async function status(jsonOutput, variant) {
	const store = makeStore(variant);
	const client = new WorkBuddyUpstreamClient();
	const authStatus = await store.status();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const hostState = hostAlive ? "running" : heartbeat !== void 0 ? "stale" : "not-started";
	if (authStatus.state !== "signed-in") {
		if (jsonOutput) printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-out",
			hostBundle: hostState
		});
		else process.stdout.write(`${variant.displayName} Connect: signed out\nHost bundle: ${hostState}\n`);
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) {
			const fetched = await client.fetchCredits(credential);
			credits = {
				total: fetched.total,
				...fetched.unlimited === true ? { unlimited: true } : {}
			};
		}
	} catch (error) {
		credits = {
			total: 0,
			error: safeMessage(error)
		};
	}
	const expiresAt = authStatus.expiresAtMs !== void 0 ? new Date(authStatus.expiresAtMs).toISOString() : void 0;
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			provider: variant.id,
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.unlimited === true ? { creditsUnlimited: true } : {},
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState
		});
		return 0;
	}
	process.stdout.write([
		`${variant.displayName} Connect: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error !== void 0 ? `Remaining credit: unavailable (${credits.error})` : credits?.unlimited === true ? "Remaining credit: unlimited" : `Remaining credit: ${credits?.total ?? "unknown"}`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (POOL_ACTIONS.has(rawAction)) return await runPoolCommand(argv);
	if (![
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy-connect: expected doctor, logout, status, or one of ${[...POOL_ACTIONS].sort().join(", ")}; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		rest.push(flag);
	}
	const variant = providerId === void 0 ? CN_VARIANT : variantFor(providerId);
	if (variant === void 0) {
		process.stderr.write(`dsh-workbuddy-connect: unknown provider ${JSON.stringify(providerId)}; expected one of ${WORKBUDDY_VARIANTS.map((v) => v.id).join(", ")}\n`);
		return 1;
	}
	if (rest.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-workbuddy-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, variant);
			case "status": return await status(jsonOutput, variant);
			case "logout": {
				const store = makeStore(variant);
				await store.logout();
				process.stdout.write(`${variant.displayName} Connect: removed ${store.ownAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
			}
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
