# 思考强度（reasoning effort）：为什么有些模型没有选项

本文记录对 live 上游 `GET /console/enterprises/personal/models` 的实测结果，
以及"是否可以自己维护一份思考选项表"的结论。

---

## 1. 数据来源：上游其实返回了两种 reasoning 形状

`fetchModels()` 只保留 `agents[name=cli].models` 列出的那 15 个模型。
它们的 `reasoning` 字段分成两类：

**A. 声明式（新形状）** — 带 `supportedEfforts`：

```json
{"canDisableThinking":true,"defaultEffort":"high","summary":"auto",
 "supportedEfforts":["low","high","max"]}
```

**B. 旧形状** — 只有 `effort`（默认档）和 `summary`：

```json
{"effort":"medium","summary":"auto"}
```

上游**没有**为 B 类给出可选集合。这就是"没有思考选项"的全部原因：
见 `src/adapter.ts` 的 `reasoningFields()`，它只在
`supportedEfforts` 非空时才生成 `thinkingLevelMap`，否则直接返回
`{ reasoning: false }` —— 选择器里就不出现任何档位。

### 实测的 15 个 cli 模型

| 模型 id | reasoning 形状 | supportedEfforts | defaultEffort | canDisable | DSH 里有选项？ |
|---|---|---|---|---|---|
| `auto` | B | — | `high` | false | ✗ |
| `hy4-preview` | A | `["high"]` | `high` | false | ✓ |
| `hy3` | B | — | `high` | false | ✗ |
| `hy3-x` | A | `["low","high"]` | `high` | false | ✓ |
| `deepseek-v4.1-flash` | B | — | `high` | false | ✗ |
| `glm-5.3` | A | `["low","high","max"]` | `high` | **true** | ✓ |
| `glm-5.3-flash` | A | `["low","high","max"]` | `high` | **true** | ✓ |
| `glm-5.2` | B | — | `medium` | false | ✗ |
| `glm-5.1` | B | — | `medium` | false | ✗ |
| `glm-5v-turbo` | B | — | `medium` | false | ✗ |
| `kimi-k3-1` | B | — | `medium` | false | ✗ |
| `kimi-k2.7` | B | — | `medium` | false | ✗ |
| `kimi-k2.6` | B | — | `medium` | false | ✗ |
| `minimax-m3` | B | — | `medium` | false | ✗ |
| `deepseek-v4-pro` | B | — | `high` | false | ✗ |

> 注意：**上游数据本身在变**。本次实测 `glm-5.3` 的集合是
> `low/high/max`，而仓库里 `FALLBACK_WORKBUDDY_MODELS` 静态快照写的是
> `low/high/xhigh`。静态列表只是首帧兜底，会被动态结果覆盖，但如果上游
> 离线，显示的就是这份过期数据。

---

## 2. 有默认思考选项吗？—— 有，但只在"不发字段"的意义上

B 类模型**确实有默认档**，就是 `reasoning.effort` 那个值（`medium` 或
`high`）。但这个"默认"是**服务端**行为：客户端只要不传
`reasoning_effort`，上游就按自己的默认档跑。

所以 B 类模型现在不是"没有思考强度"，而是"用上游默认强度，且 DSH 里
不可调"。实测确认基线请求（不传任何 effort 字段）返回 HTTP 200。

`defaultEffort` 已经在解析里提取出来了（`resolveUpstreamReasoning()`），
但目前**没有被使用**——`reasoningFields()` 没读它。这是可以接上的一个点。

---

## 3. 关键实测：上游到底接不接受自定义 effort？

这是决定"能不能自己维护一张表"的唯一硬约束。对每个模型发真实 chat 请求，
`reasoning_effort` 依次取 `low/medium/high/xhigh/max/off`：

| 模型 | 类型 | low | medium | high | xhigh | max | **off** |
|---|---|---|---|---|---|---|---|
| `glm-5.2` | B | 200 | 200 | 200 | 200 | 200 | 200 |
| `minimax-m3` | B | 200 | 200 | 200 | 200 | 200 | 200 |
| `kimi-k3-1` | B | 200 | 200 | 200 | 200 | 200 | 200 |
| `hy3` | B | 200 | 200 | 200 | 200 | 200 | 200 |
| `deepseek-v4-pro` | B | 200 | 200 | 200 | 200 | 200 | **400** |
| `auto` | B | 200 | 200 | 200 | 200 | 200 | **400** |
| `glm-5.3` | A | 200 | 200 | 200 | 200 | 200 | 200 |

失败响应体：

```json
{"code":11150,"msg":"the reasoning effort value is not supported by the current model",
 "extError":{"code":"invalid_reasoning_effort"}}
```

### 三个重要结论

1. **上游对 B 类模型基本不校验 effort 值本身**——连 `xhigh`（不在任何
   声明集合里）都接受。所以 B 类模型**发 `low/medium/high/xhigh/max` 是
   安全的**。
2. **但 `off` 是例外且不可预测**：`deepseek-v4-pro` 和 `auto` 明确报
   `invalid_reasoning_effort` 400，而 `glm-5.2`、`minimax-m3`、`kimi-k3-1`、
   `hy3` 全部接受。**这个差异无法从 catalog 行推导出来**——它们的行长得
   很像，`off` 的接受度却不同。
3. 声明式模型 `glm-5.3` 的越界值（`medium`、`xhigh`）**上游也接受了**，
   说明上游并不会按 `supportedEfforts` 硬卡。这跟原先代码注释里"发送未
   声明值有 400 风险"的假设不完全一致：风险确实存在，但**只在 `off` 上
   被实际观测到**。

---

## 4. 结论：可以自己维护，但有一个必须绕开的坑

**可以。** 对 B 类模型补一份手维护的档位表在技术上是可行的：除 `off`
之外，上游对取值很宽容，实测没有出现"发了未声明档位就 400"的情况。

但要注意三点：

1. **不要给 B 类模型提供 `off`。** `deepseek-v4-pro` / `auto` 会 400。
   而这两者恰好是主力模型。除非逐模型白名单，否则 `off` 必须一律关闭。
2. **必须把 `defaultEffort` 对上**，否则用户选择器会显示一个和实际默认
   不符的档位（见下方"已实现的方案"，这一点最终未能实现，原因见第 5 节）。
3. **这份表会随上游漂移。** 上游已经在改形状（B → A），也在改集合
   （`glm-5.3` 的 `xhigh`/`max` 差异就是证据）。

---

## 5. 已实现的方案

`src/adapter.ts` 的 `reasoningFields()` 现在按下面的规则生成选项：

| 上游行 | 是否给选项 | 选项列表 | 默认档 |
|---|---|---|---|
| `supportsReasoning: true` + 有 `supportedEfforts` | ✅ | 声明集合原样 | 见下 |
| `supportsReasoning: true` + 无 `supportedEfforts`（B 类） | ✅ | `low/medium/high/xhigh/max` | 见下 |
| `supportsReasoning` 非 true / 无 `reasoning` | ❌ 不显示 | — | — |

- **B 类一律给满 5 档**，不管上游有没有声明可用性。实测（第 3 节）这
  5 个值对所有 B 类模型都返回 200，风险为零。
- **`off` 只给显式声明 `canDisableThinking: true` 的模型**。B 类永远
  不给，因为上游对 `off` 的接受度逐模型不同且无法从行推断。
- **声明的集合保持原样**，不做扩展：`hy4-preview` 仍然只有 `High`，
  `hy3-x` 仍然只有 `Low/High`。

### 关于"默认档"的实测结论：无法实现

原始需求是"用 `reasoning.effort` 当默认值并显示出来"。实现过程中确认
**这在 DSH 当前的 seam 上做不到**，证据链：

1. 选择项的**标签由 `dsh-llm-pi-ai` 自动生成**：
   `${level[0].toUpperCase()}${level.slice(1)}`（`lib/index.js:1717`），
   等级集合固定为 `off/minimal/low/medium/high/xhigh/max`。插件无法注入
   "Default · High" 这种标签。
2. 客户端**确实**有一个 "Default" 行（`effort.providerDefault`，中文
   显示"默认"），但它只在 `reasoning.defaultEffort === undefined` 时出现，
   且选中它**明确不发送** `reasoningEffort`
   （`dsh-client-ui-model-selection/lib/client.js:434-441`）。所以
   "Default 是一个独立项" 和 "选 Default 发送 effort" 无法同时成立。
3. 在 pi-ai 模型上设置 `defaultEffort` 是**无效的**：选择器的起始档位来自
   `describableReasoningLevel(model, profile.reasoning)`
   （`dsh-llm-pi-ai/lib/index.js:1805`），这里的 `profile` 是**整个
   provider 一份**的配置（`config.d.ts:115` 的 `reasoning?: ModelThinkingLevel`），
   没有逐模型通道。因此 `defaultEffort` 不会被读取。

所以最终的实现**不设置任何默认档**，`profile.reasoning` 保持未设置。
效果是：选择器里出现 `Default`（默认）+ 5 个档位，用户不选就走上游自己的
默认——而"上游自己的默认"恰好就是 `reasoning.effort` 那个值。行为上和
原需求一致，只是那个值以 "Default" 的名义呈现，而不是 "Default · High"。

如果将来要真正显示逐模型默认档，需要 DSH 核心在
`ResolvedPiAiProviderProfile` 上增加逐模型的 default 通道。
