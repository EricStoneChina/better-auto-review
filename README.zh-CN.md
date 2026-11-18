# Better Auto Review

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 的 Codex 式自动审查：保留沙箱，只审提权。**

[English](README.md) · [问题反馈](https://github.com/EricStoneChina/better-auto-review/issues) · [MIT 许可证](LICENSE)

---

DSH 自带的 Auto Review 会对**每一次工具调用**都询问审查模型，而一旦模型放行，整个会话就以 `danger-full-access` 运行。这只有在完全信任审查模型时才安全，而且连工作区内的 `read` 都要多一次模型往返。

Better Auto Review 采用 Codex 的思路：

- 会话始终留在 **`workspace-write` 沙箱**里；
- **只有当某一次工具调用通过 `sandbox_permissions` 显式请求放宽沙箱**时，才询问审查模型；
- 放行只覆盖**那一次调用**（`allowed-once`），不会变成整个会话的权限；
- 拒绝时给出原因；连续拒绝则转人工。

## 与内置版的区别

| | 内置 Auto Review | Better Auto Review |
| --- | --- | --- |
| 审查范围 | 每次工具调用 | 仅显式沙箱提权 |
| 基线沙箱 | `danger-full-access` | `workspace-write` |
| 放行范围 | 整个会话 | 单次调用（`allowed-once`） |
| 工作区内 read/write | 每次一次模型调用 | **0 次模型调用** |
| 拒绝提示 | 通用文案 | 附带审查模型给出的原因 |
| 审查模型 | 固定复用主会话模型 | 可配置为独立路由 |
| 审查异常 | 视实现而定 | **默认 fail closed** |

## 如何判定“提权”

插件监听 `tools/pre-execute`，只有以下条件全部满足才进入审查：

1. 调用属于某个 agent（`run_code` 内部的嵌套调用也算；最外层 `run_code` 包装跳过）；
2. 会话的权限预设等于配置的预设（默认 `auto-mode`）；
3. 工具参数里含有字符串 `sandbox_permissions`；
4. `rank(sandbox_permissions) > rank(baselineSandbox)`，等级为
   `read-only = 0`、`workspace-write = 1`、`danger-full-access = 2`。

默认 `baselineSandbox: workspace-write`，因此只有 `danger-full-access` 会触发审查；工作区内操作完全不调用模型。

模型 **allow**：记住该调用 id，并对工具随后发起的一次性提权审批返回 `allowed-once`，只放这一次。模型 **deny**：在工具执行前拒绝，并把原因带回给模型。连续 `maxConsecutiveDenials` 次拒绝后转人工。审查出错默认拒绝（`onError: deny`），也可设为 `ask` 转人工。

## 安装

### 从 npm 安装（推荐）

```bash
# 在你的 DSH profile 目录，例如 ~/.dsh/profiles/desktop
pnpm add @ericstonechina/better-auto-review
```

然后在 profile 的 `package.json` 中加入 bundle：

```json
{
  "dependencies": {
    "@ericstonechina/better-auto-review": "^0.1.3"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@ericstonechina/better-auto-review"
      ]
    }
  }
}
```

重启 DSH（或用插件管理器启用）。该 bundle 的 patch 会插入插件行，新增 **Better Auto Review** 权限预设，并将其设为新会话的默认预设。

### 从 GitHub 安装（预发布 / 开发版）

```bash
pnpm add github:EricStoneChina/better-auto-review
```

`dsh.profile.bundles` 中仍使用包名。

### 启用

bundle 会把 **Better Auto Review** 设为新会话的默认预设（通过在 bundle 的 `cordis.patch.yml` 中设置 `defaultPreset: auto-mode`），因此你无需手动选择。新会话会直接以 `workspace-write` + `approval: ask` 启动，插件只拦截提权请求，普通工作区操作不受影响。你仍可在权限选择器中把任意会话切换到其它预设；该默认值只对之后新建的会话生效。预设键特意叫 `auto-mode`：Claude 风格皮肤固定的四段控件会把 **Auto** 映射到 `auto-mode`（优先于 `auto`），所以点 Auto 就会走本审查器，而不会走内置的每次调用都审查的 auto 审查器，既不用加第五个按钮，也不必改皮肤源码。

仍停留在内置 `auto` 预设（或早期 `auto-review` 键）的会话会在 agent 出现时自动迁移到 `auto-mode`。内置插件会被保留，保证旧会话恢复不报错。

## 配置

默认值在 bundle 的 [cordis.patch.yml](cordis.patch.yml)。可在 profile 的 `cordis.patch.yml` 中用同一个行 id 覆盖：

```yaml
- id: better-auto-review
  config:
    provider: magpie-responses
    model: codex/gpt-6.2-sol
    reviewerProvider: magpie-responses
    reviewerModel: codex/gpt-6.2-sol
    reviewerReasoningEffort: low
    reviewerTimeoutMs: 60000
    maxTokens: 800
    reviewerSubagent: true
    reviewerSubagentProvider: spawn
    reviewerPreset: better-auto-review-readonly
    reviewerTools:
      - read
      - glob
      - grep
    reviewerFallback: llm
    preset: auto-mode
    baselineSandbox: workspace-write
    maxConsecutiveDenials: 3
    denialWindowSize: 10
    maxWindowDenials: 6
    maxReviewsPerTurn: 10
    maxFailuresPerTurn: 10
    verdictCacheTtlMs: 60000
    verdictCacheMaxEntries: 128
    onError: deny
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `provider` / `model` | `magpie-responses` / `codex/gpt-6.2-sol` | 兼容旧配置的默认路由，在未设置专用审查路由时使用 |
| `reviewerProvider` | 同 `provider` | 审查专用的 LLM 路由 |
| `reviewerModel` | 同 `model` | 审查模型；建议与主编码模型分开 |
| `reviewerReasoningEffort` | `low` | 审查推理强度；低强度更快更省 |
| `reviewerTimeoutMs` | `60000` | 单次审查硬超时；超时按失败处理 |
| `maxTokens` | `800` | 审查输出上限 |
| `reviewerSubagent` | `true` | 每次审查作为一个只读子代理运行，可自行查看工作区 |
| `reviewerSubagentProvider` | `spawn` | 审查子代理使用的 DSH provider（`spawn` 不继承父会话历史） |
| `reviewerPreset` | `better-auto-review-readonly` | 审查子代理的预设；只开放 `read`、`glob`、`grep` |
| `reviewerTools` | `read`、`glob`、`grep` | 审查子代理的工具白名单；`structured_output` 始终允许 |
| `reviewerFallback` | `llm` | 子代理无法启动时回退到内联审查模型；`deny` 表示直接 fail closed |
| `preset` | `auto-mode` | 本插件生效的权限预设 |
| `baselineSandbox` | `workspace-write` | 不高于此等级的请求不审查 |
| `maxConsecutiveDenials` | `3` | 连续拒绝多少次后转人工 |
| `denialWindowSize` | `10` | 拒绝熔断的滑动窗口大小 |
| `maxWindowDenials` | `6` | 窗口内拒绝多少次后转人工 |
| `maxReviewsPerTurn` | `10` | 单轮最多审查次数，超出转人工 |
| `maxFailuresPerTurn` | `10` | 单轮最多审查失败次数，超出转人工 |
| `verdictCacheTtlMs` | `60000` | 相同提权指纹的短时缓存；`0` 关闭 |
| `verdictCacheMaxEntries` | `128` | 缓存条数上限 |
| `onError` | `deny` | 审查异常时 `deny`（fail closed）或 `ask` |

审查模型可以是你的 DSH LLM 配置中的任意路由，不必与主会话模型相同。

## 审查输入

默认情况下，审查器是一个全新的 `spawn` 子代理，运行在只读预设 `better-auto-review-readonly` 上。它只收到下面这份有界摘要，以及它自己通过 `read`/`glob`/`grep` 读取到的结果；`agent/pre-step` 防火墙会丢弃注入的 system、plugin 与 runtime-context 消息，因此项目说明无法操纵判决。

- 当前工作目录；
- 基线与请求的沙箱模式；
- 最近 6 条真实用户消息（视为可信意图）；
- 最近 8 次工具调用的名称与截断参数；
- 本次待执行调用的完整名称与参数（含 `justification`）。

审查模型被指示：允许日常开发工作以及本地诊断、修复（包括修复工作区的文件权限），只拒绝明确的高风险操作。宽泛的“继续”“修好它”或“总失败”的抱怨，足以授权可逆的本地修复；每次拒绝都必须给出具体理由。

工具名、参数及其中的任何文本都按**不可信数据**处理，只有用户消息被视为授权来源。审查子代理不能调用 `write`、`edit`、`apply_patch`、`pwsh`/shell 或 `run_code`；即使预设被改错，`tools/pre-execute` 也会以 `AUTO_REVIEW_READ_ONLY` 拒绝。审查模型必须通过 `structured_output` 工具提交严格 JSON：

```json
{"decision":"allow","reason":"简短理由","riskLevel":"low"}
```

```json
{"decision":"deny","reason":"这次提权不被允许的原因","riskLevel":"high"}
```

插件还会在询问模型前执行确定性规则：磁盘/文件系统破坏、递归删除盘符根目录或用户主目录、向网络目的地外传密钥、凭据窃取或安全控制篡改，都会被硬拒绝，即使审查模型想放行。`high` 风险一律拒绝；`medium` 风险必须有用户对具体目标的明确授权；`low` 才放行。其它输出都算审查失败，按 `onError` 处理。

## 安全模型与边界

Better Auto Review 是**提权审查器**，不是沙箱的替代品。它的保证是：

> 只有当工具调用显式请求比基线更宽的 `sandbox_permissions`，**并且**审查模型放行时，这次调用才会以更宽权限执行。

因此：

- `workspace-write` 沙箱仍是主要防线；
- 完全无视 DSH 沙箱、也不使用 `sandbox_permissions` 的第三方/MCP 工具不在本插件控制范围内，应由其自身权限机制约束；
- 审查模型也会犯错：建议从 `workspace-write` 起步、保持 `onError: deny`，并用 `maxConsecutiveDenials` 尽早转人工。
- 只读子代理是审查器的纵深防御层，不是主 agent 的新沙箱。子代理无法启动时，`reviewerFallback: llm` 会保留内联审查路径；设为 `deny` 则直接 fail closed。
- 反复出现的 Windows 沙箱失败不会无限消耗审查额度：相同请求会命中短时判决缓存，单轮审查/失败预算和滑动拒绝熔断会把决定转给用户。

## 日志

所有日志带前缀 `better-auto-review:`，记录迁移、放行、拒绝与审查失败。

## 开发

```bash
npm test        # 插件状态机的 node:test 测试
npm run check   # 语法检查
npm pack --dry-run
```

测试用桩替代 DSH 宿主（权限预设、LLM 流、子代理服务、工具流水线、审批监听），无需安装 DSH 即可运行。

## 反馈

这是早期公开测试版。请通过 [Issues](https://github.com/EricStoneChina/better-auto-review/issues) 反馈，并附上：

- DSH 版本与操作系统；
- 使用的预设和 `cordis.patch.yml` 配置；
- 出问题前后的 `better-auto-review:` 日志。

## 许可证

MIT © 2026 EricStoneChina
