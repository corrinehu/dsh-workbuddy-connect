#!/usr/bin/env node
import { T as workbuddyOwnAuthPath, a as readHostHeartbeat, c as WORKBUDDY_CONNECT_VERSION, l as WorkBuddyUpstreamClient, m as FALLBACK_WORKBUDDY_MODELS, o as workbuddyHostHeartbeatPath, r as isHeartbeatProcessAlive, v as WorkBuddyAccountManager, y as WorkBuddyCredentialStore } from "./host-heartbeat-qowTH6eb.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/** Standalone status/diagnostics CLI for the dsh-workbuddy-connect bundle. */
const JSON_SCHEMA_VERSION = 1;
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function printHelp() {
	process.stdout.write([
		"Usage: dsh-workbuddy-connect <action> [args] [--json]",
		"",
		"  doctor    secret-free sign-in and environment diagnostics",
		"  status    sign-in state, remaining WorkBuddy credit, and host-bundle health",
		"  logout    remove the single-account plugin-owned credential copy",
		"  accounts  list imported WorkBuddy accounts",
		"  import    import the live desktop sign-in as <key>: import <key> [label] [--force]",
		"  remove    remove an imported account: remove <key>",
		"  --json    emit one secret-free JSON document (doctor/status/accounts only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
function makeStore() {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyCredentialStore({ refresh: (credential) => client.refreshToken(credential) });
}
function makeManager() {
	const client = new WorkBuddyUpstreamClient();
	return new WorkBuddyAccountManager({ refresh: (credential) => client.refreshToken(credential) });
}
async function doctor(jsonOutput) {
	const store = makeStore();
	const status = await store.status();
	const desktopPresent = await store.desktopFilePresent();
	const heartbeat = await readHostHeartbeat();
	const hostAlive = heartbeat !== void 0 && isHeartbeatProcessAlive(heartbeat);
	const report = {
		schemaVersion: JSON_SCHEMA_VERSION,
		package: "dsh-workbuddy-connect",
		version: WORKBUDDY_CONNECT_VERSION,
		node: process.version,
		desktopAuthFile: {
			path: store.desktopAuthPath() ?? "(no platform default; set WORKBUDDY_AUTH_FILE)",
			present: desktopPresent
		},
		ownAuthFile: workbuddyOwnAuthPath(),
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
		fallbackModels: FALLBACK_WORKBUDDY_MODELS.length,
		hints: [
			...status.state === "signed-in" ? [] : ["Sign in once in the WorkBuddy desktop app, then run status again."],
			...desktopPresent ? [] : [`No WorkBuddy desktop auth file at the expected path; set WORKBUDDY_AUTH_FILE if it lives elsewhere.`],
			...hostAlive ? [] : ["Host bundle not running in this DSH profile (or the process exited). The browser card and provider are unavailable until DSH starts the plugin."]
		]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`WorkBuddy Connect ${WORKBUDDY_CONNECT_VERSION} on ${process.version}`,
		`Desktop auth file: ${report.desktopAuthFile.present ? "present" : "missing"} (${report.desktopAuthFile.path})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : heartbeat !== void 0 ? "stale heartbeat (process exited)" : "not started"}`,
		`Sign-in state: ${report.signIn}`,
		`Static fallback models: ${report.fallbackModels}`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && desktopPresent ? 0 : 1;
}
async function status(jsonOutput) {
	const store = makeStore();
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
			status: "signed-out",
			hostBundle: hostState
		});
		else process.stdout.write(`WorkBuddy Connect: signed out\nHost bundle: ${hostState}\n`);
		return 1;
	}
	let credits;
	try {
		const credential = await store.current();
		if (credential !== void 0) credits = { total: (await client.fetchCredits(credential)).total };
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
			status: "signed-in",
			...expiresAt === void 0 ? {} : { accessTokenExpires: expiresAt },
			...authStatus.nickname === void 0 ? {} : { nickname: authStatus.nickname },
			...authStatus.domain === void 0 || authStatus.domain === "" ? {} : { domain: authStatus.domain },
			source: authStatus.source,
			credits: credits?.total,
			...credits?.error === void 0 ? {} : { creditsError: credits.error },
			hostBundle: hostState
		});
		return 0;
	}
	process.stdout.write([
		`WorkBuddy Connect: signed in${authStatus.nickname === void 0 ? "" : ` as ${authStatus.nickname}`}`,
		...expiresAt === void 0 ? [] : [`Access token expires ${expiresAt} (refresh is automatic)`],
		credits?.error === void 0 ? `Remaining credit: ${credits?.total ?? "unknown"}` : `Remaining credit: unavailable (${credits.error})`,
		`Host bundle: ${hostAlive ? `running (pid ${heartbeat.pid})` : hostState === "stale" ? "stale heartbeat (DSH process exited)" : "not started in this profile"}`,
		"Client card: load failures are logged to the browser console only; the host provider is unaffected.",
		""
	].join("\n"));
	return 0;
}
async function accounts(jsonOutput) {
	const statuses = await makeManager().statuses();
	if (jsonOutput) {
		printJson({
			schemaVersion: JSON_SCHEMA_VERSION,
			package: "dsh-workbuddy-connect",
			version: WORKBUDDY_CONNECT_VERSION,
			accounts: statuses
		});
		return 0;
	}
	if (statuses.length === 0) {
		process.stdout.write("WorkBuddy Connect: no imported accounts. Run `import <key>` after signing in on the desktop app.\n");
		return 0;
	}
	for (const entry of statuses) {
		const who = entry.nickname ?? entry.key;
		process.stdout.write(`- ${entry.key}${entry.state === "signed-in" ? `  (${who})` : "  (signed-out)"}\n`);
	}
	return 0;
}
async function importAccount(args) {
	const key = args[0];
	if (key === void 0 || key.startsWith("--")) {
		process.stderr.write("dsh-workbuddy-connect: import requires an account key: import <key> [label] [--force]\n");
		return 1;
	}
	const label = args[1] === void 0 || args[1].startsWith("--") ? void 0 : args[1];
	const force = args.includes("--force");
	try {
		const info = await makeManager().importFromDesktop(key, {
			...label === void 0 ? {} : { label },
			force
		});
		process.stdout.write(`WorkBuddy Connect: imported desktop sign-in as account "${info.key}"${label === void 0 ? "" : ` (${label})`}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: import failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
async function removeAccount(args) {
	const key = args[0];
	if (key === void 0 || key.startsWith("--")) {
		process.stderr.write("dsh-workbuddy-connect: remove requires an account key: remove <key>\n");
		return 1;
	}
	try {
		await makeManager().remove(key);
		process.stdout.write(`WorkBuddy Connect: removed account "${key}"; the desktop app's sign-in is untouched\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: remove failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
/** Execute one boot-free command. */
async function run(argv) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...rest] = argv;
	if (![
		"accounts",
		"doctor",
		"import",
		"logout",
		"remove",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-workbuddy-connect: expected accounts, doctor, import, logout, remove, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const flags = rest.filter((arg) => arg.startsWith("--"));
	const positional = rest.filter((arg) => !arg.startsWith("--"));
	const jsonOutput = flags.includes("--json");
	try {
		switch (action) {
			case "accounts": return await accounts(jsonOutput);
			case "doctor": return await doctor(jsonOutput);
			case "status": return await status(jsonOutput);
			case "import": return await importAccount(positional);
			case "remove": return await removeAccount(positional);
			case "logout":
				await makeStore().logout();
				process.stdout.write(`WorkBuddy Connect: removed ${workbuddyOwnAuthPath()}; the desktop app's sign-in is untouched\n`);
				return 0;
		}
	} catch (error) {
		process.stderr.write(`dsh-workbuddy-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
