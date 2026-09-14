# WorkBuddy client wire contract — the model/chat request

Requirements gate for the outbound-wire fix (team task `t2`). Everything below was read from the
WorkBuddy build installed on **this** machine on 2026-09-14. No plugin code was run, no network
request was sent, no credit was spent.

## 0. Scope, method, and a correction to the briefing

**"The model/chat request"** means the single HTTP request the official WorkBuddy desktop client
issues for one agent turn. On the CN gateway it is exactly:

```
POST https://copilot.tencent.com/v2/chat/completions
```

**Who builds it.** Not the Electron main process. The desktop spawns the bundled agent CLI and hands
it a `CLIENT_INFO_*` environment bag; the CLI builds and sends the request. So the binding contract
for the chat request is the **CLI's** code, and the desktop's role is to supply the client-identity
*inputs* (§3).

**How to read the citations.** Two file trees are involved and they are not the same tree:

| Citation form | Meaning |
| --- | --- |
| `app.asar.unpacked/cli/...` | Real file on disk, readable directly. |
| `app.asar!main/...` | Entry **inside** `app.asar`, not on disk. Extracted by parsing the asar header and reading only that entry's byte range. |

Every code block in this document was emitted by reading those bytes and writing them out verbatim
— no quote was retyped. Offsets are byte offsets into the cited file (for `app.asar!` entries, into
the extracted entry).

**Correction to the task briefing.** The briefing says `main/common.js`, `main/module-base.js` and
`main/stdio-mcp-inspector.js` are unpacked under `app.asar.unpacked/`. They are **not**.
`app.asar.unpacked/main/` contains exactly one file, `qimei-helper.js`:

```
$ ls /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/main/
qimei-helper.js
```

The three files above live inside `app.asar` and were extracted read-only, entry by entry, without
loading the 298 MB archive into memory. Line numbers given for them are line numbers **within the
extracted entry**, which is what the briefing's cross-references quote, so those still line up.

**Confidence legend**

| Mark | Meaning |
| --- | --- |
| ✅ confirmed | Bytes present on this machine establish the claim directly. |
| ◐ inferred | Composed from confirmed rules plus inputs read on this machine; deterministic, but no packet capture exists to confirm the end-to-end value. |
| ⛔ unknown | Not established from bytes read here. |

**The briefing's offsets were re-checked, not trusted.**

The briefing's numeric offsets are **character indices**, not byte offsets: they were produced with a
JavaScript `indexOf` on the decoded bundle string. This file is UTF-8 and contains 22956034
characters in 23318379 bytes — a difference of 362345 bytes of multi-byte text (mostly Chinese
comments, UI strings and log formats) sitting *before* the chat code. Converted to bytes, the three
chat-path anchors land 4 bytes past the constructs they name — a constant, character-scale residue,
which is exactly what a character index produces when it is read as a byte offset. **The installed app
has not changed between the briefing and this document and no code moved; only the unit differed.** Every offset in
this document is a **byte** offset, because that is the unit the tools used here (`dd`, Python,
an asar reader) actually address.

| Briefing anchor (the text it names) | Briefing number (character index) | That number converted to bytes | Byte offset of that same text | Verdict |
| --- | --- | --- | --- | --- |
| `axiosToFetchAdapter()` | 10321406 | 10388194 | 10388190 | same code, +4 bytes |
| `CONVERSATION_ID_HEADER]=ew.id` | 10321865 | 10388653 | 10388649 | same code, +4 bytes |
| `AGENT_INTENT]=ew.meta` | 10322057 | 10388845 | 10388841 | same code, +4 bytes |
| `HTTP_HEADER_USER_ID="X-User-Id"` | ~16013366 (approximate) | 16093397 | 16093182 | same constants block, +215 bytes |
| `main/common.js` auth interceptor | line ~73605 | — | line 73606 | confirmed |
| `main/module-base.js` UA interceptor | line ~669 | — | line 658 | confirmed |
| `main/stdio-mcp-inspector.js` X-IDE-* banner headers | lines 14218-14222 | — | line 14217 | confirmed |
| `X-Auth-Refresh-Source` | — | — | literal at bytes 16058560, 16109305, 16125297 | confirmed |
| `cli/package.json` CLI version | 2.137.1 | — | 2.137.1 (line 150) | confirmed |
| `Info.plist` app version | 5.5.6 | — | 5.5.6 | confirmed |

**One anchor was genuinely misleading, and this is the part worth keeping.** The briefing paired the
number `10322057` with the snippet `` `[lz.AGENT_INTENT]:"craft"` ``. The *number* is right — in
character units it points at the **chat** path's `ey[t5.AGENT_INTENT]=ew.meta?.["codebuddy.ai/mode"]??"craft"`
at byte 10388835. But the *snippet* is not from that code. The string
`` `[lz.AGENT_INTENT]:"craft"` `` occurs verbatim exactly once in the bundle, at byte
12596890 (line 2004), inside the **WebFetch tool's** outbound call — `fetchContentViaApi`
at byte 12593985. That is a content-extraction request, not a chat completion: it is the one
that races a local fetch and logs `WebFetch API timed out after ${l5/1e3}s`. An implementer who grepped the
briefing's snippet would have landed in the WebFetch tool. The chat path's own header construction is
the `ey[t5.*]` block starting at byte 10388643, quoted verbatim in §2.0 (block B1).

## 1. Versions read on this machine

| Item | Value | Evidence | Confidence |
| --- | --- | --- | --- |
| WorkBuddy desktop app | `5.5.6` | `Info.plist` `CFBundleShortVersionString` = `5.5.6`, and `CFBundleVersion` = `5.5.6`, read with `PlistBuddy` | ✅ confirmed |
| Bundled agent CLI (real version) | `2.137.1` | `app.asar.unpacked/cli/package.json:150` — `"version": "2.137.1"` inside `publishConfig.customPackage` (`:148`). Line `:3` is `"version": "0.0.0"`, a placeholder. | ✅ confirmed |
| Same version, second source | `5.5.6` | `app.asar.unpacked/cli/product.json:2477` — `"genieVersion": "5.5.6"` | ✅ confirmed |
| openai SDK used by the CLI | `6.25.0` | `app.asar!node_modules/openai/package.json` → `"version": "6.25.0"`; `app.asar!node_modules/openai/src/version.ts` → `export const VERSION = '6.25.0';` | ✅ confirmed |
| Product identity | `productName` = `WorkBuddy`, `applicationName` = `WorkBuddy`, `deploymentType` = `SaaS`, `platform` = `CLI` | `app.asar.unpacked/cli/product.json:3`, `:2369`, `:2102` | ✅ confirmed |

Real observed request line from this machine's own CLI log (a historical log already on disk — not a
run performed for this document):

```
~/.workbuddy/logs/2026-08-28/ve_research__f468af9598d72c9f7ea4d032a5fa32a2.log (byte 623561)
[ModelProvider] Sending request: agent=cli, model=hy4-preview, requestId=6aa41bad1a304877ba6e3244f22b5331, stream=true, url=https://copilot.tencent.com/v2/chat/completions
```

That line is emitted by the logger call at `codebuddy.js` byte 10394762, whose template literal is
exactly `[ModelProvider] Sending request: agent=${eN}, model=${eP}, requestId=${ex}, stream=${eM}, url=${eF}`.
The endpoint itself resolves as: `product.json:11` `"endpoint": "https://copilot.tencent.com"` →
`resolveModelBaseURL()`, which returns `` `${ed}/v2` `` →

```js
resolveModelBaseURL(eA){let{envBaseURL:el,modelConfigUrl:ec,productEndpoint:eu}=eA;if(ec)return ec;if(el)return el;let ed=this.productManager.getEndpoint()||eu;if(!ed)throw new A0.ModelConfigError("Cannot resolve model request endpoint: neither getEndpoint() nor product.endpoint is available yet. Set CODEBUDDY_BASE_URL, or ensure the product configuration has finished loading.");return this.warnIfEnvEndpointMismatch(ed),`${ed}/v2`}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10409285 (line 883) ✅ confirmed

→ the openai SDK's `Completions.create`, which posts

```js
this._client.post("/chat/completions",{body:eA,...el,stream:eA.stream??!1})
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10302856 (line 883) ✅ confirmed

Concatenated: `https://copilot.tencent.com/v2/chat/completions`. ✅ confirmed

## 2. The chat request header contract

The header *values* all come from `axiosToFetchAdapter()` — the `fetch` implementation handed to the
openai SDK. It opens at `app.asar.unpacked/cli/dist/codebuddy.js` byte 10388190 (line 883), verbatim:

```js
axiosToFetchAdapter(){return async(eA,el)=>{let ec,eu,ed,ep,eg,eh="string"==typeof eA?eA:eA.url
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10388190 (line 883) ✅ confirmed

### 2.0 Verbatim source blocks

Every claim in §2.2, §2.3 and §2.4 points at one of these blocks. They are contiguous byte runs, quoted
whole, with no elisions.

**B1 — identity/trace headers** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10388643 (line 883)

```js
ey[t5.CONVERSATION_ID_HEADER]=ew.id,ey[t5.CONVERSATION_REQUEST_ID_HEADER]=ew.conversationRequestId||"",ey[t5.CONVERSATION_MESSAGE_ID_HEADER]=ew.messageId,ey[t5.REQUEST_ID_HEADER]=ew.messageId,ey[t5.AGENT_INTENT]=ew.meta?.["codebuddy.ai/mode"]??"craft",
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10388643 (line 883) ✅ confirmed

**B2 — client-identity headers (`X-IDE-*`)** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10389019 (line 883)

```js
let e_=ew.telemetryClientInfo;if(!e_?.ideType||!e_.ideName||!e_.ideVersion){let eA=await this.clientInfoProvider.get();ec=eA.ideType,eu=eA.platform,ed=eA.platformVersion}ey[t5.IDE_TYPE_HEADER]=e_?.ideType||ec||Aj.PRODUCT_TYPE,ey[t5.IDE_NAME_HEADER]=e_?.ideName||eu||"",ey[t5.IDE_VERSION_HEADER]=e_?.ideVersion||ed||"0.0.0";
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10389019 (line 883) ✅ confirmed

**B3 — conditional headers** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10391113 (line 883)

```js
let eQ=this.resolveRootRequestId(ew);eQ&&this.setHeaderCaseInsensitive(ey,t5.ROOT_REQUEST_ID_HEADER,eQ);let eD=this.resolveParentConversationId(ew);eD&&this.setHeaderCaseInsensitive(ey,t5.PARENT_CONVERSATION_ID_HEADER,eD),this.setHeaderCaseInsensitive(ey,t5.AGENT_TYPE_HEADER,this.resolveAgentType(ew));
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10391113 (line 883) ✅ confirmed

**B4 — the deletion that decides the User-Agent** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10390555 (line 883)

```js
if(delete ey.authorization,delete ey["user-agent"],this.isCustomModelRequest(ep,eg)){
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10390555 (line 883) ✅ confirmed

**B5 — header name constants** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16178783 (line 3082)

```js
el.TRACE_ID_HEADER="X-Trace-ID",el.REQUEST_ID_HEADER="X-Request-ID",el.ROOT_REQUEST_ID_HEADER="X-Root-Request-ID",el.PARENT_CONVERSATION_ID_HEADER="X-Parent-Conversation-ID",el.AGENT_TYPE_HEADER="X-Agent-Type",el.CONVERSATION_ID_HEADER="X-Conversation-ID",el.SESSION_ID_HEADER="X-Session-ID",el.CONVERSATION_REQUEST_ID_HEADER="X-Conversation-Request-ID",el.CONVERSATION_MESSAGE_ID_HEADER="X-Conversation-Message-ID",el.AGENT_INTENT="X-Agent-Intent",el.PRODUCT="X-Product",el.IDE_TYPE_HEADER="X-IDE-Type",el.IDE_NAME_HEADER="X-IDE-Name",el.IDE_VERSION_HEADER="X-IDE-Version",el.API_KEY_HEADER="X-API-Key",el.PRODUCT_VERSION_HEADER="X-Product-Version",el.USER_ID_HEADER="X-User-Id",el.PRIVATE_DATA_HEADER="X-Private-Data",el.DATA_TAG_HEADER="X-Data-Tag",el.MODEL_ID_HEADER="X-Model-ID",el.AGENT_PURPOSE="X-Agent-Purpose"
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16178783 (line 3082) ✅ confirmed

**B6 — the auth interceptor that supplies `Authorization` and the `X-User-Id` family** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16067651 (line 3082)

```js
let{account:ec,auth:eu}=el;eA.headers[eg.HttpHeaders.AUTHORIZATION]||!eu.accessToken||eA.headers[ef.HTTP_HEADER_NO_AUTHORIZATION]||(eA.headers[eg.HttpHeaders.AUTHORIZATION]=`Bearer ${eu.accessToken}`),!eA.headers[ef.HTTP_HEADER_USER_ID]&&ec?.uid&&!eA.headers[ef.HTTP_HEADER_NO_USER_ID]&&(eA.headers[ef.HTTP_HEADER_USER_ID]=ec.uid),!eA.headers[ef.HTTP_HEADER_ENTERPRISE_ID]&&ec?.enterpriseId&&!eA.headers[ef.HTTP_HEADER_NO_ENTERPRISE_ID]&&(eA.headers[ef.HTTP_HEADER_ENTERPRISE_ID]=ec.enterpriseId),!eA.headers[ef.HTTP_HEADER_DEPARTMENT_INFO]&&ec?.departmentFullName&&!eA.headers[ef.HTTP_HEADER_NO_DEPARTMENT_INFO]&&(eA.headers[ef.HTTP_HEADER_DEPARTMENT_INFO]=ec.departmentFullName),!eA.headers[ef.HTTP_HEADER_TENANT_ID]&&ec?.enterpriseId&&(eA.headers[ef.HTTP_HEADER_TENANT_ID]=ec.enterpriseId),!eA.headers[ef.HTTP_HEADER_DOMAIN]&&eu.domain&&(eA.headers[ef.HTTP_HEADER_DOMAIN]=eu.domain)
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16067651 (line 3082) ✅ confirmed

**B7 — the CLI User-Agent rule** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16318366 (line 3120)

```js
eA.headers[eh.SkipUserAgentMergeHeader])?delete eA.headers[eh.SkipUserAgentMergeHeader]:eA.headers[eg.HttpHeaders.USER_AGENT]=await this.buildUserAgent(`${eA.headers[eg.HttpHeaders.USER_AGENT]||""}`),eA))}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16318366 (line 3120) ✅ confirmed

**B8 — the same rule's body** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16318571 (line 3120)

```js
async buildUserAgent(eA=""){let el=eA?[eA]:[],ec=await this.clientInfoProvider.get()||{};return ec.productName&&el.unshift(`${ec.productName}/${ec.productVersion||"unknown"}`),ec.platform&&el.unshift(`${ec.platform}/${ec.platformVersion||"unknown"}`),ec.userAgentExtension&&el.push(ec.userAgentExtension),el.join(" ")}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16318571 (line 3120) ✅ confirmed

**B9 — token refresh** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16058392 (line 3082)

```js
let ec=await this.restOperations.post(`/v2${this.prefixPath}/auth/token/refresh`,{},{headers:{...this.enterpriseHeaders(eA.auth),"X-Refresh-Token":eA.auth.refreshToken,"X-Auth-Refresh-Source":"plugin",...el.traceSpan.requestHeaders}})
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16058392 (line 3082) ✅ confirmed

**B11 — `X-Product`** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16714184 (line 3120)

```js
eA.headers[eh.PRODUCT]||(eA.headers[eh.PRODUCT]=el.getCurrentConfiguration()?.deploymentType??el.configuration.getValue()?.deploymentType??"SaaS")
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16714184 (line 3120) ✅ confirmed

**B12 — the openai SDK's own headers, and why the UA deletion works** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10365487 (line 883)

```js
{Accept:"application/json","User-Agent":this.getUserAgent(),"X-Stainless-Retry-Count":String(eu),...eA.timeout?{"X-Stainless-Timeout":String(Math.trunc(eA.timeout/1e3))}:{},...getPlatformHeaders(),"OpenAI-Organization":this.organization,"OpenAI-Project":this.project},await this.authHeaders(eA),this._options.defaultHeaders,ec,eA.headers]);return this.validateHeaders(ep),ep.values}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10365487 (line 883) ✅ confirmed

and, the reason the adapter's `Headers` branch (not the object-spread branch) runs, from
`app.asar!node_modules/openai/src/internal/headers.ts`:

```js
export const buildHeaders = (newHeaders: HeadersLike[]): NullableHeaders => {
  const targetHeaders = new Headers();
  const nullHeaders = new Set<string>();
  for (const headers of newHeaders) {
    const seenHeaders = new Set<string>();
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
  return { [brand_privateNullableHeaders]: true, values: targetHeaders, nulls: nullHeaders };
```

— app.asar!node_modules/openai/src/internal/headers.ts byte 2118 (line 71) ✅ confirmed

**B13 — how the CLI's client-info provider ingests the desktop env bag** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 8843822 (line 436)

```js
initClientInfo(){let eA=this.productManager.configuration.getValue(),el=this.getProcessEnvInfo(),ec=el.machineId||machineIdSync();this._ClientInfo={machineId:ec,sessionId:this.sessionId,platform:eA?.platform||ud.PRODUCT_TYPE,platformVersion:eA?.productVersion||uC.version,pluginName:uC.name,pluginVersion:eA?.productVersion||uC.version,productName:eA?.productName||uC.name,applicationName:eA?.applicationName||"",productVersion:eA?.productVersion||uC.version,ideType:eA?.platform||ud.PRODUCT_TYPE,downloadChannel:eA?.downloadChannel,...el},this.filePathService?.setIDEType(this._ClientInfo.ideType||ud.PRODUCT_TYPE),this.clientInfo$.next(this._ClientInfo)}getProcessEnvInfo(){let eA={};if(ul.EnvUtils.isNodeRuntime()&&process.env)for(let el of Object.keys(uc.ENV_CLIENT_INFO_KEYS)){let ec=el,eu=uc.ENV_CLIENT_INFO_KEYS[ec];eu in process.env&&process.env[eu]&&(eA[ec]=process.env[eu])}return eA}}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 8843822 (line 436) ✅ confirmed

**B15 — the desktop env bag itself** — `app.asar!main/client-info-env.js` byte 159271 (line 3703)

```js
cachedEnv = {
		CLIENT_INFO_PLATFORM: WORKBUDDY_PLATFORM,
		CLIENT_INFO_PLATFORM_VERSION: version,
		CLIENT_INFO_IDE_TYPE: WORKBUDDY_PLATFORM,
		CLIENT_INFO_PRODUCT_NAME: productName,
		CLIENT_INFO_PRODUCT_VERSION: version,
		CLIENT_INFO_PLUGIN_NAME: WORKBUDDY_PLUGIN_NAME,
		CLIENT_INFO_PLUGIN_VERSION: version,
		...cliVersion ? { CLIENT_INFO_USER_AGENT_EXTENSION: `CLI/${cliVersion}` } : {}
	};
```

— app.asar!main/client-info-env.js byte 159271 (line 3703) ✅ confirmed

**B16 — the desktop main-process auth interceptor: the same gate, with the same absent-by-default values** — `app.asar!main/common.js` byte 2688493 (line 73598)

```js
if (config.headers["X-Skip-Auth-Interceptor"]) {
					delete config.headers[HTTP_HEADER_SKIP_AUTH_INTERCEPTOR];
					return config;
				}
				const currentSession = this.authenticationManager.currentSessionSubject.getValue();
				if (currentSession) {
					const { account, auth } = currentSession;
					if (!config.headers[import_common$7.HttpHeaders.AUTHORIZATION] && auth.accessToken && !config.headers["X-No-Authorization"]) config.headers[import_common$7.HttpHeaders.AUTHORIZATION] = `Bearer ${auth.accessToken}`;
					if (!config.headers["X-User-Id"] && account?.uid && !config.headers["X-No-User-Id"]) config.headers[HTTP_HEADER_USER_ID] = account.uid;
					if (!config.headers["X-Enterprise-Id"] && account?.enterpriseId && !config.headers["X-No-Enterprise-Id"]) config.headers[HTTP_HEADER_ENTERPRISE_ID] = account.enterpriseId;
					if (!config.headers["X-Department-Info"] && account?.departmentFullName && !config.headers["X-No-Department-Info"]) config.headers[HTTP_HEADER_DEPARTMENT_INFO] = account.departmentFullName;
					if (!config.headers["X-Tenant-Id"] && account?.enterpriseId) config.headers[HTTP_HEADER_TENANT_ID] = account.enterpriseId;
					if (!config.headers["X-Domain"] && auth.domain) config.headers[HTTP_HEADER_DOMAIN] = auth.domain;
```

— app.asar!main/common.js byte 2688493 (line 73598) ✅ confirmed

**B17 — adjacent client-identity evidence, the banner endpoint (NOT the chat request)** — `app.asar!main/stdio-mcp-inspector.js` byte 465003 (line 14217)

```js
"User-Agent": `WorkBuddy/${_AuthService.WORKBUDDY_CLIENT_VERSION}`,
				"X-IDE-Type": "WorkBuddy",
				"X-IDE-Name": "WorkBuddy",
				"X-IDE-Version": _AuthService.WORKBUDDY_CLIENT_VERSION,
				"X-Product": "WorkBuddy"
```

— app.asar!main/stdio-mcp-inspector.js byte 465003 (line 14217) ✅ confirmed

**B25 — the `Authorization` line of B6, isolated for readability** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 16067678 (line 3082)

```js
eA.headers[eg.HttpHeaders.AUTHORIZATION]||!eu.accessToken||eA.headers[ef.HTTP_HEADER_NO_AUTHORIZATION]||(eA.headers[eg.HttpHeaders.AUTHORIZATION]=`Bearer ${eu.accessToken}`),
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 16067678 (line 3082) ✅ confirmed

**B26 — the message id** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10388590 (line 883)

```js
ew.messageId=(0,t1.generateUUUID)().replace(/-/g,"")
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10388590 (line 883) ✅ confirmed

**B27 — `X-Agent-Type`'s resolver** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10371928 (line 883)

```js
resolveAgentType(eA){return eA.meta?.teamContext?"team":eA.meta?.parentConversationId?"subagent":"main"}getHeaderCaseInsensitive(eA,el){
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10371928 (line 883) ✅ confirmed

### 2.1 Which copy is on the live path — the duplicate-bundle question

The bundle is 23 MB of webpack modules, and it contains **two independent copies of the openai SDK**,
so it is fair to ask whether the code quoted above is the copy that a real chat turn reaches.
It is, and the reason is that the adapter is not duplicated:

| Fact | Measurement |
| --- | --- |
| Definition of `axiosToFetchAdapter` | exactly **one**, byte 10388190 |
| Uses of the name `axiosToFetchAdapter` | exactly **two**: that definition, and the call site `fetch:this.axiosToFetchAdapter()` at byte 10408989 |
| Class owning both | one class, declared at byte 10370423 — `let rc=class{constructor(){this.modelRequestProcessors=[],this.modelCache=new Map}`; no other `=class` declaration exists between it and the client construction |
| Client construction | `new OpenAI(this.buildOpenAIClientOptions(eA,el))` at byte 10408768, and the options object it passes is `{baseURL:eA,apiKey:el,fetch:this.axiosToFetchAdapter(),maxRetries:0,timeout:this.resolveRequestTimeoutMs()}` at byte 10408929 |
| The same class emits the live log line | the string `` `[ModelProvider] Sending request: agent=${eN}, model=${eP}, requestId=${ex}, stream=${eM}, url=${eF}` `` occurs **exactly once** in the whole bundle (byte 10394762), inside that same class |
| That log line is really on the wire | this machine's own logs contain it for real requests to the CN chat endpoint — see §1 |

So the adapter is installed as the `fetch` of the `OpenAI` client built by that one class, and that
class is the `ModelProvider` that logged the requests this contract is about. There is no second
adapter to choose between.

**What the duplicate SDK copies actually are.** Two `let Completions=class Completions extends APIResource{`
declarations exist — byte 10302706 (line 883) and byte 18146723 (line 3192) — because
two different bundle modules each vendor the SDK. They are **not** byte-identical (module-local minified
aliases differ), but every construct this contract depends on is textually identical in both:

| Construct | Copy A | Copy B |
| --- | --- | --- |
| `this._client.post("/chat/completions"` | byte 10302856 | byte 18146873 |
| `{Accept:"application/json","User-Agent":this.getUserAgent(),"X-Stainless-Retry-Count":String(eu)` header block | byte 10365487 | byte 18207844 |
| `return this.validateHeaders(ep),ep.values` | byte 10365827 | byte 18208184 |

So the header contract holds either way, and the question is closed: **one adapter definition, one call
site, one live class.**

For completeness, the second bundle region also carries the openai-agents runtime
(`let OpenAIProvider=class OpenAIProvider{` at byte 18273929, whose chat-completions model makes
its own call at byte 18273208, and whose client falls back to
`new OpenAI({apiKey:this.#ei.apiKey??getDefaultOpenAIKey(),baseURL:this.#ei.baseURL,organization:this.#ei.organization,project:this.#ei.project})` at byte 18274566 when no client
is injected). **No client is ever injected into it from this bundle:**
`setDefaultOpenAIClient` is exported (byte 18210927) but never called anywhere in the file, and
that fallback would point at `api.openai.com`, not at `copilot.tencent.com`. Nothing in this build
connects that region to the requests observed in the logs, so it is not the path this contract
describes. If a future build routes chat through it, the header rules would have to be re-derived from
that region — the same `X-Conversation-*` / `X-Agent-Intent` tuple also appears there, but built by
different code.

### 2.2 Headers on the chat request — values for a **personal** account

"Personal" means `account.type === "personal"` with no `enterpriseId`. That is the shape the CLI
itself constructs — `app.asar.unpacked/cli/dist/codebuddy.js` byte 7330798 (line 206):

```js
type:eu?.type||"personal",lastLogin:!0}
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 7330798 (line 206) ✅ confirmed

| # | Header | Value on the official chat request | Evidence | Confidence |
| --- | --- | --- | --- | --- |
| 1 | `X-Conversation-ID` | the session id (`ew.id`); format is opaque (a UUID-shaped string for desktop sessions) | B1 | ✅ confirmed (the plugin cannot reach a session id and mints one per request — §6.2, §7) |
| 2 | `X-Conversation-Request-ID` | `session.conversationRequestId`; **an empty string `""` is sent when unset** — the header is not dropped | B1 | ✅ confirmed |
| 3 | `X-Conversation-Message-ID` | a fresh UUID v4 with dashes stripped | B26 | ✅ confirmed |
| 4 | `X-Request-ID` | **identical to** `X-Conversation-Message-ID` (both are `ew.messageId`) | B1 | ✅ confirmed |
| 5 | `X-Agent-Intent` | session mode: one of `craft`, `ask`, `plan`, `expert`; `"craft"` when the session has no `codebuddy.ai/mode` meta | B1; enum — `app.asar.unpacked/cli/dist/codebuddy.js` byte 6504919 (line 42) | ✅ confirmed |
| 6 | `X-IDE-Type` | `telemetryClientInfo.ideType ?? clientInfo.ideType ?? "CodeBuddy"` → **`WorkBuddy`** for the desktop-spawned CLI | B2; `CLIENT_INFO_IDE_TYPE: WORKBUDDY_PLATFORM` and `var WORKBUDDY_PLATFORM = "WorkBuddy";` in B15 | ◐ inferred (deterministic; a per-session `telemetryClientInfo` can override) |
| 7 | `X-IDE-Name` | `telemetryClientInfo.ideName ?? clientInfo.platform ?? ""` → **`WorkBuddy`** | B2; `CLIENT_INFO_PLATFORM: WORKBUDDY_PLATFORM` in B15 | ◐ inferred |
| 8 | `X-IDE-Version` | `telemetryClientInfo.ideVersion ?? clientInfo.platformVersion ?? "0.0.0"` → **`5.5.6`** | B2; `CLIENT_INFO_PLATFORM_VERSION: version` with `version = resolveDesktopVersion(options)` in B15 | ◐ inferred |
| 9 | `X-Agent-Type` | `"main"` for a normal turn; `"subagent"` when `meta.parentConversationId` is set; `"team"` when `meta.teamContext` is set | B3, B27 | ✅ confirmed |
| 10 | `X-Product` | `deploymentType ?? "SaaS"` → **`SaaS`** on CN | B11 | ✅ confirmed |
| 11 | `Authorization` | `Bearer ${auth.accessToken}` | B6, B16 | ✅ confirmed |
| 12 | `X-User-Id` | `account.uid`; **omitted entirely** when `account.uid` is falsy | B6 | ✅ confirmed |
| 13 | `X-Enterprise-Id` | **omitted entirely** for a personal account | B6 | ✅ confirmed |
| 14 | `X-Tenant-Id` | **omitted entirely** for a personal account | B6 | ✅ confirmed |
| 15 | `X-Department-Info` | **omitted entirely** unless the account has `departmentFullName` | B6 | ✅ confirmed |
| 16 | `X-Domain` | `auth.domain`, present only when the login produced a domain | B6; value read from this machine's auth document, `www.workbuddy.cn` (§6.1) | ✅ confirmed — gate **and** value; the value comes from the auth document, not from a wire capture |
| 17 | `User-Agent` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | §3 | ◐ inferred (fully derived from confirmed bytes) |
| 18 | `Accept` | `application/json` | B12 | ✅ confirmed |
| 19 | `Content-Type` | `application/json` | B12 | ✅ confirmed |
| 20 | `X-Stainless-Lang`, `X-Stainless-Package-Version`, `X-Stainless-OS`, `X-Stainless-Arch`, `X-Stainless-Runtime`, `X-Stainless-Runtime-Version`, `X-Stainless-Retry-Count` | `js`, `6.25.0`, `MacOS`, `arm64`, `node`, the CLI's `process.version`, `0` | B23; platform values from `app.asar!node_modules/openai/src/internal/detect-platform.ts` | ✅ confirmed present — but not client identity (§5) |
| 21 | `X-Root-Request-ID` | present **only** when a root request id resolves | B3 | ✅ confirmed |
| 22 | `X-Parent-Conversation-ID` | present **only** for a subagent | B3 | ✅ confirmed |
| 23 | `X-Agent-Purpose` | present **only** when `process.env.PERSONAL_AGENT_ROLE` is set (`"person_agent"`) or the session carries `agentPurpose` (e.g. automation) | B1 | ✅ confirmed |

### 2.3 Retry and idempotency identity — what actually identifies a request

The team brief lists "absent request idempotency" as a plugin defect, so it is worth stating exactly
what the official client uses, because it is **not** an SDK idempotency header.

| Fact | Evidence |
| --- | --- |
| The openai SDK *can* send `Idempotency-Key`, but only if `this.idempotencyHeader` is set | the guard, verbatim: `let ed={};this.idempotencyHeader&&"get"!==el&&(eA.idempotencyKey\|\|(eA.idempotencyKey=this.defaultIdempotencyKey()),ed[this.idempotencyHeader]=eA.idempotencyKey);` — byte 10365302 in the SDK copy the live path uses, and byte 18207659 in the other copy |
| `idempotencyHeader` is declared but **never assigned** anywhere in this build | `protected idempotencyHeader?: string;` (`app.asar!node_modules/openai/src/client.ts` byte 10460) and a whole-file search finds no assignment |
| Therefore no `Idempotency-Key` is sent | the literal `Idempotency-Key` occurs **0 times** in the 23 MB bundle |

Because a table cell cannot hold a verbatim fence intact (a literal `|` has to be escaped in
Markdown), here is the same guard as bytes, unescaped:

**B28 — the SDK idempotency guard** — `app.asar.unpacked/cli/dist/codebuddy.js` byte 10365302 (line 883)

```js
let ed={};this.idempotencyHeader&&"get"!==el&&(eA.idempotencyKey||(eA.idempotencyKey=this.defaultIdempotencyKey()),ed[this.idempotencyHeader]=eA.idempotencyKey);
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 10365302 (line 883) ✅ confirmed

What the official client uses instead is a **pair of dash-stripped UUIDs**, regenerated per turn and
per message:

| Header | Generated where |
| --- | --- |
| `X-Conversation-Request-ID` | `let ec=eA.session.state,eu=eA.session.conversationRequestId\|\|(0,AY.generateUUUID)().replace(/-/g,"")` at byte 7165819 — the session's request id, minted fresh when absent |
| `X-Conversation-Message-ID` and `X-Request-ID` | `ew.messageId=(0,t1.generateUUUID)().replace(/-/g,"")` (block B26) |

and every run re-mints the conversation-request id —
`let eC=eg.conversationRequestId;return eg.conversationRequestId=(0,AY.generateUUUID)().replace(/-/g,"")`
at byte 7209185 — restoring the previous value in its `finally`.

**Consequence for the fix.** The official request is idempotent-by-identity, not by an idempotency
header: the server can tell a retry from a new request because it receives two fresh UUIDs. At the
requirements revision the plugin sent *neither* of them; `t3` now sends both
(`src/upstream.ts:535-538`), minting them per request — the deviation that remains is their
*stability*, not their presence (§6.2, §7.1). The `""` fallback in `ew.conversationRequestId||""`
(block B1) is the only case where the field is empty, and it means "this session has no request id
yet", not "no identity is required".

### 2.4 What the chat request does **not** carry

Established absences. At the requirements revision two of them were headers the plugin sent anyway —
`X-No-Department-Info` and the other `X-No-*` markers on the chat path, plus `Origin`/`Referer`/
`X-Requested-With`. `t3` removed all of them from chat (§6).

| Header | Status on the official chat request | Evidence | Confidence |
| --- | --- | --- | --- |
| `X-No-User-Id`, `X-No-Enterprise-Id`, `X-No-Department-Info`, `X-No-Authorization` | **never sent.** They are suppressor markers read by the auth interceptor (B6), and the official client attaches them only to login/state endpoints — e.g. `app.asar.unpacked/cli/dist/codebuddy.js` byte 7335534 (line 206) | `codebuddy.js` 7335534; `app.asar!main/common.js` line 72705; **absent from the whole adapter body** (bytes 10388190–10396000) | ✅ confirmed |
| `X-Enterprise-Id`, `X-Tenant-Id`, `X-Department-Info` | not sent for a personal account (§2.2 #13–15) | B6 | ✅ confirmed |
| `X-Refresh-Token` | never on the chat request; only on `/v2/plugin/auth/token/refresh` | B9 | ✅ confirmed |
| `X-Skip-Auth-Interceptor`, `X-Skip-User-Agent-Merge` | never sent on chat. `X-Skip-Auth-Interceptor` is set only when `CODEBUDDY_SKIP_INTERNAL_HEADERS` is configured, together with a block that **deletes** the client-identity headers — listed as `X-Conversation-ID`, `X-Conversation-Request-ID`, `X-Conversation-Message-ID`, `X-Parent-Conversation-ID`, `X-Agent-Type`, `X-Request-ID`, `X-Agent-Intent`, `X-Agent-Purpose`, `X-IDE-Type`, `X-IDE-Name`, `X-IDE-Version`, `X-Product`, `X-API-Key`, `X-Private-Data` | `codebuddy.js` byte 10391570 (the `delete ey[eA]` loop over that list); env read at byte 10391480 | ✅ confirmed |
| `X-Requested-With` | **not sent.** Only three occurrences in the CLI, all outside the model path | bytes 11181685, 12596751, 12614839 | ✅ confirmed |
| `Origin`, `Referer` | no occurrence in the model path; the CLI is a Node process and adds neither | adapter body 10388190–10396000 contains neither | ✅ confirmed |
| `x-stainless-*` | present by default; deleted only under `CODEBUDDY_SKIP_INTERNAL_HEADERS`, whose skip list includes `el=["x-stainless-"]` | byte 10393706 | ✅ confirmed |

### 2.5 Adjacent client-identity evidence (corroborating, **not** the chat request)

B17 shows the desktop identifying itself to `` `${endpoint}/v2/activity/workbuddy/banner` `` with
`X-IDE-Type`, `X-IDE-Name`, `X-IDE-Version` and `X-Product`. The accompanying comment, verbatim:

```
/**
* WorkBuddy 客户端版本号，用于服务端白名单识别客户端身份。
* 仅供 `/v2/activity/workbuddy/banner` 等需要白名单校验的接口使用。
* 由 main/daemon entry 注入 runtime context，避免 app-server 直接依赖 Electron。
*/
```

— `app.asar!main/stdio-mcp-inspector.js` byte 451988 (line 13874) ✅ confirmed, with the provider at
byte 448532 (line 13793): `workbuddyAuthClientVersionProvider = () => process.env.WORKBUDDY_APP_VERSION ?? "";`

This shows the server treats `X-IDE-Type` / `X-IDE-Name` / `X-IDE-Version` / `X-Product` as the
**client-identity tuple** — the 使用端 axis. But it is the banner endpoint, so it corroborates the
*shape* of the tuple only; do **not** cite it as a chat-request requirement. Note the tuple differs
between the two paths: the banner uses `X-Product: "WorkBuddy"` while the chat path uses the
deployment type `SaaS` (B11). The chat path is the binding one.

## 3. User-Agent

There is exactly one place the chat request's User-Agent can come from, because the adapter deletes
the SDK's.

**3.1 The SDK's UA is removed, and the delete really works.** openai 6.25.0's `buildHeaders` returns an object whose `values` field is a `Headers` instance, and `buildRequest` returns
that `values` (B12). So in the adapter
`ef instanceof Headers` is **true**, the `forEach` branch runs, and the copied keys are
**lowercased** — which is why `delete ey["user-agent"]` in B4 actually takes effect. Had the keys
kept their original case, that delete would be a no-op.

**3.2 The CLI re-adds it**, in B7 and B8. The parts, in order: `platform/platformVersion`,
`productName/productVersion`, the (now empty) pre-existing UA, then `userAgentExtension`, joined by
single spaces. The same rule exists in the desktop main process as
`app.asar!main/module-base.js` byte 28115 (line 665), which uses
`clientInfo.applicationName` where the CLI uses `productName`:

```js
const userAgentParts = [];
			if (clientInfo.applicationName) userAgentParts.push(`${clientInfo.applicationName}/${clientInfo.productVersion || "unknown"}`);
			if (clientInfo.platform) userAgentParts.push(`${clientInfo.platform}/${clientInfo.platformVersion || "unknown"}`);
			if (clientInfo.userAgentExtension) userAgentParts.push(clientInfo.userAgentExtension);
			config.headers[import_common$28.HttpHeaders.USER_AGENT] = userAgentParts.join(" ");
			config.headers[require_common$2.SkipUserAgentMergeHeader] = "1";
```

— app.asar!main/module-base.js byte 28115 (line 665) ✅ confirmed

**3.3 The inputs, for a desktop-spawned CLI.** B13 shows the CLI's provider reading the env bag and
spreading it **last**, so `CLIENT_INFO_*` overrides the product.json defaults. B15 shows the desktop
filling that bag: `CLIENT_INFO_PLATFORM = "WorkBuddy"`, `CLIENT_INFO_PLATFORM_VERSION = version`,
`CLIENT_INFO_IDE_TYPE = "WorkBuddy"`, `CLIENT_INFO_PRODUCT_NAME = productName`,
`CLIENT_INFO_PRODUCT_VERSION = version`, `CLIENT_INFO_PLUGIN_NAME` (whose value is the constant `var WORKBUDDY_PLUGIN_NAME = "workbuddy-desktop";`
at `app.asar!main/client-info-env.js` byte 157826),
`CLIENT_INFO_PLUGIN_VERSION = version`, and
`CLIENT_INFO_USER_AGENT_EXTENSION` set to `` `CLI/${cliVersion}` `` when a CLI version resolves. Here
`version = resolveDesktopVersion(options)` → `options.getAppVersion?.() ?? ""` → **`5.5.6`**, and
`resolveBundledCliVersion` takes `pkg.version` only when it is not the `"0.0.0"` placeholder, falling
back to `const customPkg = pkg.publishConfig?.customPackage;` → **`2.137.1`**.

**Result.** With the SDK UA deleted, `buildUserAgent("")` runs with productName `WorkBuddy`,
productVersion `5.5.6`, platform `WorkBuddy`, platformVersion `5.5.6`, and
userAgentExtension `CLI/2.137.1`:

```
User-Agent: WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1
```

◐ inferred — every input and every rule was read on this machine, but the join was not captured on
the wire. Degradations: `buildUserAgent` writes `unknown` in place of a missing version
(`` `${ec.platform}/${ec.platformVersion||"unknown"}` ``, byte 16318771), and drops the trailing `CLI/…` part when
`CLIENT_INFO_USER_AGENT_EXTENSION` is absent.

## 4. `X-Auth-Refresh-Source`

**Value: `"plugin"`.** Three occurrences in `codebuddy.js`, all on
`POST /v2${prefixPath}/auth/token/refresh`; `prefixPath` is `/plugin`
(`app.asar.unpacked/cli/product.json`, `authentication.attributes.prefixPath`), so the URL is
`/v2/plugin/auth/token/refresh`. B9 is the first occurrence, `app.asar.unpacked/cli/dist/codebuddy.js` byte 16058392 (line 3082). ✅ confirmed

The same literal also appears at bytes 16109305 and 16125297, and the quoted one starts at byte
16058560. ✅ confirmed

The header is **not** present anywhere on the chat request. The plugin used to send
`X-Auth-Refresh-Source: 'workbuddy'` (`src/upstream.ts:309`, the pre-`t3` revision) — a value that
appears nowhere in the official client; `t3` corrected it to `plugin` (`src/upstream.ts:201`, `:493`),
see §6.

## 5. Is `messages[0].role === "system"` guaranteed?

**No — it is conditional on the agent's own instructions, and no CN-specific rule exists.**

B10 — `app.asar.unpacked/cli/dist/codebuddy.js` byte 18272142 (line 3192) — is the whole rule:

```js
let eg=itemsToMessages(eA.input);eA.systemInstructions&&eg.unshift({content:eA.systemInstructions,role:"system"}),
```

— app.asar.unpacked/cli/dist/codebuddy.js byte 18272142 (line 3192) ✅ confirmed

and the body it feeds is `em={model:this.#Am,messages:eg,tools:ed.length?ed:void 0` (byte
18272567), sent through `let ef=await this.#et.chat.completions.create(em,{headers:Ax,signal:eA.signal})`
(byte 18273208). ✅ confirmed

Callers always pass the assembled agent instructions into that slot — for example
`systemInstructions:eI.modelInput.instructions` at byte 17938873 (and again at 17944541, 18495651,
18501242). ✅ confirmed

Therefore:

| Question | Answer | Confidence |
| --- | --- | --- |
| Is the system message `messages[0]` when instructions exist? | **Yes** — `unshift` puts it at index 0 | ✅ confirmed |
| Is a system message guaranteed when instructions are empty? | **No** — the guard is falsy, nothing is inserted, and `messages[0]` becomes whatever the first mapped input item is (typically `user`) | ✅ confirmed |
| Is there a CN-specific system-first rule? | **None found.** No branch on region, deployment type or endpoint in that builder | ✅ confirmed |
| Does the gateway reject a non-system-first body with code `11128`? | Not confirmable here. No `11128` table exists in this build. The plugin records *two* readings of that code — international: first message is not `system` (`src/upstream.ts:1278-1286`); CN: a rejected `developer` role (`src/upstream.ts:585-590`). Those are the plugin's own asserts, not bytes read from the client, so both stay unconfirmed | ⛔ unknown |

Practical reading for the fix: the CN chat path does not appear to *require*
`messages[0].role === 'system'`, but the official client *does* send one on every real turn, because
every agent turn has instructions. If the goal is wire parity, sending the harness system prompt
first is correct. Do **not** invent an artificial CN system prompt on the strength of the `11128`
story alone.

## 6. Delta — official contract vs. the plugin

**Treatment: was → now, with both columns present.** So that no row can be misread as describing
"today", the table carries two plugin columns:

- **before t3** — `src/upstream.ts` at the requirements revision. This is the state the document was
  written to critique, kept as the historical record.
- **after t3** — `src/upstream.ts` read from the **current working tree on 2026-09-14**. Task `t3`
  rewrote that file (+385 / −44 lines by `git diff --stat`) and touched no other file this table
  describes. The change is not committed, so there is no commit hash to cite; the working tree is the
  revision.

Every "after t3" cell was re-read from the current file for this revision of the document, row by row
(§6.2 records what that changed). The **before t3** line numbers are historical and resolve against the
pre-`t3` revision of the file — which, while the change is uncommitted, is exactly `git show
HEAD:src/upstream.ts`; all 22 of them were re-checked against it. They do **not** resolve against the
current tree, and reading them there lands in unrelated code.

**Closure note (2026-09-14): t3 has landed.** Every identity gap this table originally listed is
closed — the missing `X-Conversation-*` / `X-Agent-Intent` / `X-Agent-Type` / `X-IDE-*` set, the wrong
chat User-Agent, the wrong `X-Auth-Refresh-Source`, and the three `X-No-*` markers. What remains open
is no longer a missing field but the *provenance of two values* and one deliberate deviation, both
recorded in §6.2 and §7.

**Confidence for the "official" column is the §2.2 row of the same header name** — legend
✅ confirmed / ◐ inferred / ⛔ unknown. Every official value here is ✅ byte-confirmed except the
composed User-Agent and the three `X-IDE-*` values, which are ◐: derived deterministically from
confirmed bytes plus the desktop's env bag, but never captured on the wire (§7).

| Header | Official chat request (§2.2 / §2.4 / §3 / §4) | before t3 | after t3 (current tree) | Verdict |
| --- | --- | --- | --- | --- |
| `User-Agent` | `WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1` | hardcoded `CLI/2.63.2 CodeBuddy/2.63.2` (`:131`, `:284`) | `clientUserAgent(identity)` (`:246-250`), sent at `:534` (chat) and `:489` (refresh) | ✅ rule parity — value ◐ (§7) |
| `X-Conversation-ID` | the session id `ew.id` (B1) | — | fresh dash-stripped UUID per request (`:537`) | ⚠ **deviation** — sent, but not a session id (§6.2, §7) |
| `X-Conversation-Request-ID` | the session's `conversationRequestId`, `""` when it has none (B1) | — | fresh dash-stripped UUID per request (`:538`) | ⚠ same deviation — never the `""` case |
| `X-Conversation-Message-ID` | fresh dash-stripped UUID (B26) | — | `messageId` (`:536`) | ✅ parity |
| `X-Request-ID` | identical to the message id (B1) | — | `messageId` (`:535`) | ✅ parity |
| `X-Agent-Intent` | `craft` when the session has no mode meta (B1) | — | `AGENT_INTENT_DEFAULT = 'craft'` (`:192`, `:539`) | ✅ parity |
| `X-IDE-Type` | `WorkBuddy` (B2) | — | `CLIENT_PRODUCT` (`:183`, `:543`) | ✅ rule — value ◐ (§7) |
| `X-IDE-Name` | `WorkBuddy` (B2) | — | `CLIENT_PRODUCT` (`:544`) | ✅ rule — value ◐ (§7) |
| `X-IDE-Version` | `5.5.6` (B2) | — | `identity.appVersion` (`:545`) | ✅ rule — value ◐ (§7) |
| `X-Agent-Type` | `main` / `subagent` / `team` (B3, B27) | — | `AGENT_TYPE_MAIN = 'main'` (`:195`, `:540`) | ✅ correct for a single-turn plugin request |
| `X-Product` | `SaaS` (B11) | `'SaaS'` (`:299`) | `PRODUCT_SAAS` (`:546`) | ✅ unchanged, parity |
| `X-User-Id` | `account.uid` (B6) | `credential.uid` (`:294`) | `credential.uid` when non-empty (`:549`) | ✅ parity |
| `X-Enterprise-Id` | only when the account has one (B6) | omitted for a personal account | same (`:552-554`) | ✅ parity |
| `X-Tenant-Id` | from `account.enterpriseId` (B6) | not sent on chat | sent alongside `X-Enterprise-Id` (`:554`) | ✅ parity, now including the enterprise case |
| `X-Department-Info` | only with `departmentFullName` (B6) | not sent | not sent; the credential does not model the field (`:519-520`) | ✅ correct for a personal account |
| `X-Domain` | `auth.domain` when the login produced one (B6) | `credential.domain` (`:298`) | `credential.domain` when non-empty (`:559`) | ✅ **parity** — the old "semantics wrong" verdict is retracted in §6.1 |
| `Authorization` | `Bearer <accessToken>` | `Bearer` (`:502`) | `Bearer`, merged at the call site (`:841`) | ✅ parity |
| `Accept` | `application/json` (B12) | `application/json, text/plain, */*` (`:280`) | `application/json` on chat (`:532`) | ✅ parity on the chat path |
| `Content-Type` | `application/json` (B12) | `application/json` (`:292`) | `application/json` (`:533`) | ✅ unchanged |
| `X-No-User-Id` | never sent (§2.4) | `'1'` when `uid` was empty (`:294`) | never sent | ✅ removed |
| `X-No-Enterprise-Id` | never sent (§2.4) | `'1'` when there was no enterprise id (`:296`) | never sent | ✅ removed |
| `X-No-Department-Info` | never sent (§2.4) | `'1'` when the domain was empty (`:298`) | never sent | ✅ removed |
| `X-Requested-With` | never on chat (§2.4) | sent (`:281`) | not on chat; still on the international **catalog** request (`:908`) | ✅ removed from chat |
| `Origin`, `Referer` | never on chat (§2.4) | sent (`:282-283`) | not on chat; still on the **catalog** request (`:906-907`) | ✅ removed from chat |
| `X-Stainless-*` | SDK-inherited, not client identity (§2.2 #20) | — | not sent | ✅ correct to omit |
| `X-Auth-Refresh-Source` (refresh path) | `plugin` (§4) | `'workbuddy'` (`:309`) | `REFRESH_SOURCE = 'plugin'` (`:201`, `:493`) | ✅ fixed |
| `X-Refresh-Token` (refresh path) | sent | sent (`:308`) | sent (`:490`) | ✅ unchanged |
| `messages[0].role === 'system'` | present whenever the agent has instructions (B10) | injected only for `global`, gated at `:503` | unchanged: CN goes through `prepareChatBody`, which rewrites `developer`→`system` but injects no message (`:842`, `:591-604`) | ✅ deliberate — the CN gateway has no such rule (§5) |

The `CLI/2.63.2 CodeBuddy/2.63.2` literal is gone from the chat and refresh paths but **deliberately
survives** as `CN_CATALOG_UA` (`:162`), the User-Agent of the plugin's own CN model-catalog request —
a path the official CLI never calls. It is not a chat-request value and must not be read as one.

### 6.1 Correction — the `X-Domain` row was wrong

The requirements revision of this table called the plugin's `X-Domain` "**semantics wrong** — the
plugin's `domain` is the login region, not `auth.domain`". **That verdict was wrong and is retracted.**
The row above now reads *parity*, and the reason is a two-line chain:

```
src/auth.ts:203    domain: optionalString(auth['domain']) ?? '',
```

`credential.domain` is read straight out of the desktop auth document's `auth.domain` — the exact field
that block B6 gates `X-Domain` on (`!eA.headers[ef.HTTP_HEADER_DOMAIN]&&eu.domain&&(eA.headers[ef.HTTP_HEADER_DOMAIN]=eu.domain)`).
The plugin's value **is** the official value; there is no second interpretation. The current source
says so at `src/upstream.ts:556-559`.

**The trap that produced the error — two unrelated domain-ish values.** The plugin holds both, and
conflating them is what made the header look wrong:

| Value | Where it comes from | What it drives |
| --- | --- | --- |
| `credential.domain` | `auth.domain` in the desktop auth document, via `src/auth.ts:203` — on this machine `"www.workbuddy.cn"` | `X-Domain` (`:559`), and the region decision `regionOf()` (`:460-464`) |
| `CN_BILLING_BASE` | a hardcoded constant, `'https://www.codebuddy.cn'` (`:147`) | `Origin` / `Referer` on the plugin's own **catalog** request (`:906-907`) — never `X-Domain` |

**Measured on this machine.** The CN desktop auth document
`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` contains
`auth.domain = "www.workbuddy.cn"`, with `account.sso.domain = ""` and `account.type = "personal"`.
So on this machine `X-Domain` **is** sent, carrying `www.workbuddy.cn`. The string
`www.codebuddy.cn` is the billing/Origin constant and nothing else: it is not the auth domain, and
describing the observed domain as `www.codebuddy.cn` conflates the two constants this table separates.
(The auth document also carries the tokens; only the fields named here were read, and no token value is
reproduced anywhere in this document.)

### 6.2 What the row-by-row re-verification changed

| Outcome | Rows |
| --- | --- |
| **Judged correct and confirmed unchanged** | `X-Conversation-Message-ID`, `X-Request-ID`, `X-Agent-Intent`, `X-Agent-Type`, `X-Product` (the only row that was already at parity before t3), `X-User-Id`, `X-Enterprise-Id`, `X-Department-Info`, `Authorization`, `Content-Type`, `X-Stainless-*`, `X-Refresh-Token`, and the `messages[0].role === 'system'` row |
| **Corrected** | `X-Domain` — the verdict was wrong, retracted in §6.1. Every plugin line reference — the file was rewritten, so all 22 old numbers pointed at unrelated code (for example `:938-944`, which used to hold the international-system-prompt comment, is now date formatting); each cell above carries its current number. `X-Tenant-Id` — the plugin now sends it in the enterprise case too, so the row reads parity rather than "matches for personal only". |
| **Split by request path** | `X-Requested-With`, `Origin`, `Referer` — removed from chat (correct), but still sent on the plugin's own catalog request. That is outside the chat contract; it is recorded so the grep hits are not mistaken for a chat regression. |
| **Still open (not a defect)** | `X-Conversation-ID` and `X-Conversation-Request-ID` carry fresh per-request ids instead of a session id, because no session id reaches `chatStream`. §7 records this as a limitation with its follow-up. |
| **Residual uncertainty, unchanged** | the composed User-Agent and the three `X-IDE-*` values remain ◐: derived from confirmed bytes plus the desktop's env bag, never captured on the wire. §7 states plainly that no live request was made. |

## 7. What I could not confirm

| Item | Status | Note |
| --- | --- | --- |
| The concrete CN value of `auth.domain` (→ `X-Domain`) | ✅ **resolved in this revision** | Read from this machine's auth document: `www.workbuddy.cn` (§6.1). The gate is B6; the value is the auth document's, so it is not a wire capture. |
| Whether a per-session `telemetryClientInfo` changes `X-IDE-*` for desktop-spawned runs | ⛔ unknown | The override branch is confirmed in B2, but no producer of `telemetryClientInfo` exists in the desktop main bundle and no `TELEMETRY_CLIENT_INFO_KEYS` constant exists in this build. Rows 6–8 assume the override is absent. |
| An end-to-end capture of the model request headers | ⛔ unknown | The CLI logs the request line and, with `CODEBUDDY_DEBUG_REQUEST`, the body — never the headers. No capture exists on this machine, and the historical logs under `~/.workbuddy/logs/` contain no header dump. |
| Meaning of gateway error code `11128` | ⛔ unknown | No `11128` table in this build. |
| Whether 使用端 is fed by `X-IDE-*`, `X-Product`, or the User-Agent | ⛔ unknown | No server-side code is available here. §2.5 is the strongest local signal, but it is the banner endpoint, not chat. |
| The exact injected value of `WORKBUDDY_APP_VERSION` for the banner call | ◐ inferred | The provider defaults to `process.env.WORKBUDDY_APP_VERSION` and the daemon entry overrides it; likely `5.5.6`, not read. |
| Whether the desktop's own `main`-process UA is used for any chat-adjacent call | ◐ inferred | §3.2 shows the desktop's UA rule, but the chat request is issued by the CLI process. |

### 7.1 Known limitations carried forward

Two boundaries are structural, not oversights. They are recorded here so that the fix is not read as
claiming more than it establishes.

**1. The composed User-Agent and the `X-IDE-*` values were never captured on the wire.**
`WorkBuddy/5.5.6 WorkBuddy/5.5.6 CLI/2.137.1`, `X-IDE-Type: WorkBuddy`, `X-IDE-Name: WorkBuddy` and
`X-IDE-Version: 5.5.6` are each derived deterministically from two things that *are* confirmed on this
machine — the join rule in `buildUserAgent` (B8) and the desktop's own `CLIENT_INFO_*` env bag (B15).
They stay marked ◐ everywhere they appear, because **no live request was made**: this document ran no
plugin code, sent no request and spent no credit, and the official CLI never logs request headers (the
logs carry the request line and, with `CODEBUDDY_DEBUG_REQUEST`, the body — never the headers). A
packet capture, or a `CODEBUDDY_*`-level header dump if one ever exists, is what would close this.

**2. The plugin mints fresh per-request conversation ids, because no session id reaches it.**
`chatStream` is called as `chatStream(credential, bodyJson, signal)` (`src/upstream.ts:830-834`) — a
credential, an OpenAI body and a signal, nothing that marks a conversation boundary. The official
client takes `X-Conversation-ID` from a session it owns (`ew.id`) and only mints an id when the session
has none (§2.3). The plugin therefore applies that minting rule per request (`:537-538`): every request
is its own single-turn session.

Consequences, stated plainly: the ids are well-formed and satisfy "a request carries a fresh identity"
for retry deduplication, but they are **not** stable across the turns of one conversation, so the
server cannot group the plugin's turns into a conversation the way it groups the official client's.

The follow-up this implies: a stable conversation id has to be obtained where the session actually
exists. This machine's CN auth document does carry `auth.sessionState` (a UUID-shaped value, not
reproduced here) — but reading it means reading the desktop auth document through `src/auth.ts`, which
was outside `t3`'s single-file scope and is outside this document's. Threading that value (or an
equivalent per-conversation id the host already knows) into `chatStream` is the change that would lift
this limitation; nothing in the contract blocks it, and §2.2 / §2.3 already state the official rule it
would have to satisfy.

## 8. Reproducing every citation

Read-only; no network, no plugin execution.

```bash
# versions
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" /Applications/WorkBuddy.app/Contents/Info.plist
sed -n '148,151p' /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/package.json

# chat-path header construction (single minified line; offsets are byte offsets)
F=/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/dist/codebuddy.js
dd if="$F" bs=1 skip=10388643 count=262 2>/dev/null   # B1
dd if="$F" bs=1 skip=10389019 count=333 2>/dev/null   # B2
dd if="$F" bs=1 skip=10391113 count=313 2>/dev/null   # B3
dd if="$F" bs=1 skip=10388590 count=62 2>/dev/null   # B26
dd if="$F" bs=1 skip=10371928 count=146 2>/dev/null   # B27
dd if="$F" bs=1 skip=10390555 count=95 2>/dev/null   # B4
dd if="$F" bs=1 skip=16178783 count=828 2>/dev/null   # B5
dd if="$F" bs=1 skip=16067651 count=895 2>/dev/null   # B6
dd if="$F" bs=1 skip=16318366 count=215 2>/dev/null   # B7
dd if="$F" bs=1 skip=16318571 count=328 2>/dev/null   # B8
dd if="$F" bs=1 skip=16058392 count=244 2>/dev/null   # B9
dd if="$F" bs=1 skip=18272142 count=124 2>/dev/null   # B10
dd if="$F" bs=1 skip=16714184 count=156 2>/dev/null   # B11
dd if="$F" bs=1 skip=10365487 count=392 2>/dev/null   # B12
dd if="$F" bs=1 skip=10409285 count=445 2>/dev/null   # B14

# entries INSIDE app.asar (not unpacked): parse the asar header, read one entry's byte range.
# app.asar.unpacked/main/ holds only qimei-helper.js, so main/common.js must come from the archive.
ls /Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/main/
```

**Evidence-integrity note.** Every fenced code block in this document was written out by the same
script that measured its byte offset, straight from the bytes on disk — no quote was retyped or
reformatted, and no elision (`...`, `…`) appears inside a quoted block. Where a line number is given
instead of an offset it is because the file is human-readable (`.json`, `.plist`) or because the
entry's own line numbering is what the briefing cross-references (`app.asar!main/...`).
