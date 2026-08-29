# WorkBuddy 渠道无法发送图片：定位与修复方案

日期：2026-08-29
状态：**已实施并验证，已随 v0.2.5 发布**（2026-08-29；65 个离线测试全过 + 真机只读验证 `glm-5.3-flash`/`auto` 解析出 `["text","image"]`、`glm-5.1` 保持 `["text"]`；DSH web 端 GLM-5.3-Flash 粘贴图片发送成功）
适用范围：`dsh-workbuddy-connect` v0.2.4（工作区未发布改动）

---

## 1. 问题现象

在 DSH 对话框里把模型切到 WorkBuddy 渠道的 `glm-5.3-flash` 后，粘贴/拖入图片会被拒绝，提示：

> The current model does not support images; switch to a model that does
> （当前模型不支持图片，请切换支持图片的模型）

同样的问题影响 **所有** WorkBuddy 模型，不只是 `glm-5.3-flash`。

---

## 2. 结论先行

拦截 **100% 是本地行为，与 WorkBuddy 上游无关**。

- 唯一的拦截点在本机 Host 侧，图片消息 **根本没有发出网络请求**——上游此刻不知道有这回事。
- 上游其实 **明确提供了** 每个模型是否支持图片的字段，且 `glm-5.3-flash` 的答案是 **支持**。
- 本插件没有读取该字段，而是在代码里把 **每一个** 模型硬编码为纯文本。

所以"上游支不支持"只决定 **该不该放行**，不决定 **被不被拦**。开关握在插件手里。

---

## 3. 拦截链路（三段，全在本机）

| # | 位置 | 行为 |
|---|---|---|
| 1 | 浏览器客户端 | 用户提交图片，发出 `prompt` RPC。**本身不做前置拦截** |
| 2 | Host `dsh-host-apiproxy` | 发现 content 含 `image` part，调 `ctx.llm.resolveModelInfo(provider, model)` |
| 3 | 同上 | 若 `inputModalities` 不含 `image` → 返回 `attachment-error`（`reason: MODEL_DOES_NOT_SUPPORT_IMAGES`），**消息未落库、未发出** |

关键源码（`dsh-host-apiproxy/lib/index.js:2750-2759`）：

```js
const hasImage = content.some((part) => part.type === "image");
if (hasImage) {
  const current = selectionFor(agent).current;
  const modelInfo = await ctx.llm.resolveModelInfo(current.provider, current.model);
  if (modelInfo.inputModalities !== undefined
      && !modelInfo.inputModalities.includes("image")) {
    return err(request, {
      code: "attachment-error",
      message: `Model "${current.model}" does not support image input.`,
      details: { reason: "MODEL_DOES_NOT_SUPPORT_IMAGES" }
    });
  }
}
```

客户端侧（`dsh-client-ui-conversation/lib/client.js:2608`）只是把 `MODEL_DOES_NOT_SUPPORT_IMAGES` 翻译成文案，**不参与判定**。因此不存在"客户端提前禁用"的第二道关卡。

---

## 4. 根因

`src/adapter.ts:86`，`toPiModel()` 中：

```ts
input: ['text'],   // ← 硬编码：每个模型都是纯文本
```

这个 `input` 就是 Host 读取的 `inputModalities` 的来源。

实测复现（用上游真实目录填充 catalog 后调 `adapter.resolveModel()`）：

```
catalog size: 16
glm-5.3-flash        inputModalities= ["text"]
glm-5.1              inputModalities= ["text"]
deepseek-v4-flash    inputModalities= ["text"]
hy4-preview          inputModalities= ["text"]
glm-5v-turbo         inputModalities= ["text"]
```

**全部** 返回 `["text"]`——包括 `glm-5v-turbo`、`deepseek-v4-flash` 这些明显的多模态模型。这证明是插件写死，而非上游能力问题。

旁证：`src/adapter.ts:26-29` 的注释也明确写着

> WorkBuddy routes are text-only today, so these bounds never bite unless image input is added to the catalog.

---

## 5. 关键发现：上游已有权威数据

直接请求上游 `GET /console/enterprises/personal/models`，原始响应的每个模型对象包含这些字段（粗体为本方案需要的）：

```
credits, descriptionEn, descriptionZh, disabledMultimodal, iconUrl, id,
isDefault, maxAllowedSize, maxInputTokens, maxOutputTokens, name,
onlyReasoning, reasoning, relatedModels, repetition_penalty,
**supportsImages**, supportsReasoning, supportsToolCall, tags,
temperature, top_k, top_p, vendor
```

而 `src/upstream.ts:352-360` 只解析了 4 个字段，其余（含 `supportsImages`）全部丢弃：

```ts
byId.set(id, {
  id,
  name: ...,
  contextWindow: input,
  maxTokens: output,
})
```

### 5.1 上游真实能力（16 个 cli 模型，实测）

| 模型 | supportsImages |
|---|---|
| auto | ✅ true |
| hy4-preview | ✅ true |
| hy4-preview-x | ✅ true |
| hy3 | ✅ true |
| hy3-x | ✅ true |
| glm-5.3 | ✅ true |
| **glm-5.3-flash** | ✅ **true** |
| glm-5.2 | ✅ true |
| **glm-5.1** | ❌ **false** |
| glm-5v-turbo | ✅ true |
| kimi-k3-1 | ✅ true |
| kimi-k2.7 | ✅ true |
| kimi-k2.6 | ✅ true |
| minimax-m3 | ✅ true |
| deepseek-v4-flash | ✅ true |
| deepseek-v4-pro | ✅ true |

`glm-5.3-flash` 的 `descriptionZh` 为「原生多模态，擅长处理复杂的长程自主任务。」，`supportsImages: true`，未设置 `disabledMultimodal`。

**15/16 支持，只有 `glm-5.1` 不支持。**

---

## 6. 修复方案

按上游 `supportsImages` **逐模型**声明能力。共 3 个文件，约 15 行。

### 6.1 `src/upstream.ts` — 读取上游已有字段

`WorkBuddyUpstreamModel`（第 25–30 行）加一个可选字段：

```ts
export interface WorkBuddyUpstreamModel {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  /** Upstream multimodal capability; absent means unknown → treat as text-only. */
  supportsImages?: boolean
}
```

`fetchModels()` 的 `byId.set(id, {...})`（第 355–360 行）加一行：

```ts
supportsImages: wrapped['supportsImages'] === true,
```

可选（更稳妥）：同时排除 `disabledMultimodal`

```ts
supportsImages: wrapped['supportsImages'] === true
  && wrapped['disabledMultimodal'] !== true,
```

> 本次采样中 `disabledMultimodal` 只出现 `false` 与 `undefined`，未出现 `true`，因此不加也不会出错；加上是防止上游日后将其改作总开关。

字段用 **可选**（`?`）而非必填：静态兜底目录没有这个信息，且上游未来可能省略——未知即按纯文本处理，与 pi-ai 的保守默认一致。

### 6.2 `src/adapter.ts` — 用真实能力替换写死值

第 86 行：

```ts
input: ['text'],
```

改为：

```ts
input: info.supportsImages === true ? ['text', 'image'] : ['text'],
```

顺带修正第 26–29 行已过时的注释（"WorkBuddy routes are text-only today"）。

`REQUEST_IMAGE_BUDGETS`（第 31–35 行）**无需改动**：三个值（20MB / 2048²像素 / 1MB）已是 pi-ai 默认值，图片一放开即正确生效。

### 6.3 `src/catalog.ts` — 静态兜底策略（需决策）

`FALLBACK_WORKBUDDY_MODELS`（第 18–30 行）是"首次上游刷新前 / 离线"用的 11 条，没有 `supportsImages` 信息。两个选项：

- **A. 保守（默认推荐）**：不改动。上游刷新在启动时发生，联网场景下用户感知不到差别；仅离线启动时仍不能发图。
- **B. 补齐**：按上游真实值给这 11 条标 `supportsImages`
  （`auto`、`hy3`、`glm-5v-turbo`、`glm-5.2`、`minimax-m3`、`deepseek-v4-flash`、`deepseek-v4-pro` 为 `true`；`glm-5.1` 为 `false`），离线也能正确。

**注意**：只加字段，**不要增删条目**——`tests/shim.spec.ts:98` 断言 `expect(ids.length).toBe(11)`，改动数量会红。

另注：`glm-5.3-flash` 本身 **不在** 静态列表中（比该列表更新），故离线场景下它根本不存在，不涉及"能否发图"。

---

## 7. 为什么不能整体无条件放行

实测 16 个模型中 **15 个支持，仅 `glm-5.1` 不支持**。若图省事改成无条件 `['text', 'image']`，会把 `glm-5.1` 也放行——那种失败 **比拒绝更糟**：

- 图片消息 **已经落库**；
- provider 在中途拒绝；
- 会话会反复重试一个不可能成功的请求。

这正是 pi-ai 把 `DEFAULT_INPUT` 设为保守 `["text"]` 的理由（源码注释：「under-claiming costs a refusal naming the model, while over-claiming admits an image the provider then rejects mid-turn — after the message is durable」）。

---

## 8. 验证与落地

```sh
cd dsh-workbuddy-connect
pnpm run check        # typecheck + vitest + build（AGENTS.md 规定的顺序）
```

**必须重启 DSH 才生效**：本插件是 Node 产物（`lib/`），`dsh-settings-file` 的 chokidar 只热重载 `settings.yaml`，管不到插件代码。本机 web profile 通过 `link:` 指向本工作区，故 `check` 后重启即可，**无需重新安装**。

验证方法：模型切到 WorkBuddy 渠道的 `glm-5.3-flash`，粘贴一张图片发送。

### 建议补测

新增一个单元测试，断言 `supportsImages: true` 的模型解析出含 `image` 的 `inputModalities`、为 `false` 的不含——防止日后有人把 `input` 再写死回去。

---

## 9. 已排除的旁路（无需考虑）

- **配置旁路**：插件 `Config`（`src/index.ts:74`）只有 `authFile` 一项，无模态相关开关。
- **客户端前置拦截**：不存在，客户端仅在收到 Host 拒绝后渲染文案。

---

## 10. 待决策（2026-08-29 已定）

1. **静态兜底**：选了 **B（补齐字段）**——11 条按上游真值标注（10 true / `glm-5.1` false），条目数不变，`tests/shim.spec.ts` 的 11 条断言不受影响。
2. **`glm-5.1` 确认**：按上游标注保守处理（不给它放行）。新版 WorkBuddy（2026-08-29 实测）仍标 `supportsImages: false`；若日后发现它实际支持图片，属上游标注错误，届时改为无条件放行。

实施落点（与 §6 一致）：`src/upstream.ts`（`WorkBuddyUpstreamModel.supportsImages: boolean`，解析 `supportsImages === true && disabledMultimodal !== true`）、`src/adapter.ts`（`input` 按真实能力声明）、`src/catalog.ts`（兜底补齐）。测试：`tests/upstream.spec.ts` 新增 fetchModels 解析用例（true/false/缺省/disabledMultimodal 四态）；`tests/settings-integration.spec.ts` 增加端到端模态断言（`auto` 含 `image`、`glm-5.1` 仅 `text`），防止日后把 `input` 写死回去。

另：新版 WorkBuddy（2026-08-29 实测）`glm-5.3-flash` 已进入 cli 模型列表（16 个），其 `supportsImages: true`。

---

## 11. 附：排查过程中的相关发现（未处理）

上游响应中还有多个本插件同样丢弃的字段，未来可一并接入：

- `supportsToolCall`：工具调用能力
- `reasoning.supportedEfforts` / `canDisableThinking` / `defaultEffort`：推理档位（目前插件不提供 reasoning effort 选择）
- `supportsReasoning`、`onlyReasoning`
- `tags`、`vendor`、`credits`（如 `x0.71 credits`）
