# dsh-commandcode

一个 DeepSeek Harness 插件：**用 API Key 把 CommandCode（[commandcode.ai](https://commandcode.ai)）的套餐模型接进 Harness，并在 Web UI 里显示账户余额与套餐用量。**

实现参考了 VS Code 扩展 [GCMP](https://github.com/VicBilibily/GCMP) 的 CommandCode 适配（`src/quota/providers/commandcode.ts` 与 `src/providers/config/commandcode.json`），但走的是 Harness 自己的扩展点，而不是移植 VSCode API。

---

## 1. 它怎么"连接"

CommandCode 的推理端点是 **OpenAI 兼容网关**（`https://api.commandcode.ai/provider/v1`，`POST /chat/completions`），Harness 里已经有专门服务这类网关的适配器 `@deepseek-ai/dsh-llm-pi-ai`。所以本插件**不自己写 LlmAdapter**，而是：

1. 用 `ctx.llm` 读不到的东西都不碰——只在 `llm-pi-ai` 的 `providers` 字典里**声明并维护一条 `commandcode` 路由**；
2. 写入走 `ctx.configEditor.edit()`，这是 Harness 持久化 profile 配置并让 Loader 重新协调的正式路径；
3. 写入是**按 key 合并**的（`upsertRoute`），不会碰同一字典里的其他路由；且先比对再写，内容一致时**不写**（幂等）。

模型目录来自实时发现，不是硬编码：`GET {providerBaseUrl}/models` 返回 82 条，插件只把**支持 `/chat/completions` 的 73 条**写进路由——Claude 家族那 9 条只提供 `/messages`，而一条 `llm-pi-ai` 路由只能说一种协议，硬塞进去会在请求时以 `UNKNOWN_MODEL` 失败。

读密钥只经过 `ctx.credentials`（键名默认 `COMMANDCODE_API_KEY`），**密钥永远不进入设置文件、不进入会话日志、不进入插件返回值**。

## 2. 界面在哪

| 位置 | 内容 |
|---|---|
| **设置 → CommandCode**（`settings.section`） | 完整面板：套餐名/状态/续费日、四项余额（可用/每月/充值/赠送）、5 小时与每周窗口的剩余百分比与重置倒计时（带进度条）、API Key 的保存/清除、路由状态与「连接模型」按钮、刷新按钮、最后更新时间 |
| **侧边栏底部**（`sidebar.footer.action`） | 紧凑指示器：一个按剩余量变色的圆点 + 摘要（如 `94%`），悬停显示套餐与明细，点击立即刷新。侧栏收窄为 56px 轨道时只显示圆点 |

配色只用 Harness 的 `--dsw-alias-*` 主题 token，明暗主题自动跟随；文案经 `ctx.locale` 提供中英文。

## 3. 两个 agent 工具

| 工具 | 作用 |
|---|---|
| `commandcode_usage` | 读余额与用量。用户问"我的 CommandCode 额度还剩多少"时调用 |
| `commandcode_connect` | 读实时模型目录并写入/刷新路由（幂等）。模型选择器里看不到 CommandCode 模型时调用 |

**故意没有"写入 API Key"的工具**：那会让密钥经由会话日志传输。密钥只通过设置面板写。

## 4. 安装

在 workspace 里用插件管理器安装本目录（绝对路径）：

```jsonc
// plugin_manager  action: install_bundle
// target: <workspace>\dsh-commandcode
```

`plugin_manager` 会 `pnpm link` 本包、把 `dsh-commandcode` 追加到 `dsh.profile.bundles`，并应用 `cordis.patch.yml` 里的那一行 Host 行。

**注意**：本地目录是以 `link:`/junction 方式装进 profile 的。因此

- 本插件**任何代码都不 import `@deepseek-ai/*`**。Node 会按 junction 的 realpath（本目录）解析裸模块名，那里没有 Harness 的包，静态或动态 import 都会 `ERR_MODULE_NOT_FOUND`。工具定义直接写成注册表要的完成态 JSON Schema（`test/dsh-schema.test.js` 会用真实 `dsh-tools` 的校验器与 `defineTool` 交叉验证这一点）。
- 改完代码后，Host 半需要**重启 DSH** 才能加载新一代模块；Client 半由浏览器从磁盘加载，刷新页面即可。

## 5. 配置（可选）

本插件不导出 `Config` schema，行 `config` 里的字段按需读取、缺省即默认值：

```yaml
- insert:
    - id: commandcode-usage
      name: 'dsh-commandcode'
      config:
        apiKeyRef: COMMANDCODE_API_KEY            # 凭据引用
        routeKey: commandcode                     # llm-pi-ai providers 里的键
        accountBaseUrl: https://api.commandcode.ai
        providerBaseUrl: https://api.commandcode.ai/provider/v1
        displayName: CommandCode                  # 模型选择器里的提供方名
        timeoutMs: 20000
```

## 6. 数据来源

两个只读接口，均以 `Authorization: Bearer <key>` 调用。字段映射来自对真实账号的一次实测（下例是 `individual-goat` 套餐当时的响应）：

```jsonc
// GET /alpha/billing/credits
{
  "credits": { "belowThreshold": false, "creditThreshold": 0,
               "monthlyCredits": 61.48327073, "purchasedCredits": 0, "freeCredits": 0 },
  "windowLimits": {
    "limited": true, "exceeded": null,
    "fiveHour": { "used": 0.586188554, "cap": 14, "exceeded": false, "resetAt": 1790580173758 },
    "weekly":   { "used": 2.085095061, "cap": 35, "exceeded": false, "resetAt": 1790945896672 }
  },
  "sandboxAccess": false, "sandboxMinutes": null
}

// GET /alpha/billing/subscriptions   （软失败：读不到只影响套餐名，不影响余额）
{ "success": true, "data": { "planId": "individual-goat", "status": "active",
                             "currentPeriodEnd": "2026-10-17T12:47:21.000Z", ... } }
```

- `resetAt` 是**毫秒**时间戳，转成 ISO 后由前端算倒计时。
- 可用余额 = 每月 + 充值 + 赠送。
- 摘要规则：以**每周**窗口为主；只有当 **5 小时窗口比每周更紧张**时才在旁边附上它（`94% (50%)`）。GCMP 用的是 `剩余 < 100%`，那在任何用量下都成立，等于恒显示一个不改变决策的数字。

## 7. 验证状态

**已验证**

- 46 个测试全部通过（`node --test`）：用量归一化与格式化、HTTP 失败码映射（含 401/超时/非 JSON）、工具定义形状、`apply` 真的把两个工具和路由注册出去、面板与侧栏指示器的渲染输出。
- 上述 46 项中有 2 项用**真实 `@deepseek-ai/dsh-tools`** 的 `assertObjectJsonSchema` / `assertSupportedJsonSchema` 与 `defineTool` 交叉验证手写 schema（设 `DSH_TOOLS_PATH` 后运行）。
- 三个真实端点用账号密钥做过只读实测：`credits`、`subscriptions`、`models` 均 200，字段与 GCMP 一致。
- 插件行 `include:commandcode-usage` 在当前 desktop profile 中状态为 **active**（`plugin_manager list_plugins`），插件注册的同源路由已由被加载的那一代代码注册。
- Client 半**已在运行中的页面里注册生效**（`cordis_inspect_query` → `Slots.listSubTree`）：
  `settings.section` 有 `id: dsh-commandcode, order: 35, active: true`；
  `sidebar.footer.action` 有 `id: dsh-commandcode, order: 20, active: true`。
  也就是说 **设置 → CommandCode 与侧栏底部的指示器现在就能打开，无需刷新**（已加载的那一代 Host 代码里 5 个 HTTP 方法齐全，面板功能完整）。

**尚未验证（需要你操作）**

- 两个 agent 工具在运行中的 Host 里出现：第一次安装加载的是修复前的代码，而 Host 半的模块换代需要**重启 DSH**。重启后可用 `cordis_inspect_query` → `Tool.listTools` 确认 `commandcode_usage` / `commandcode_connect` 存在。
- 面板与指示器的**外观**（配色、明暗主题、窄侧栏形态）：注册已确认，但本会话没有浏览器控制能力，无法截图核对，需要你目视确认。
- 「连接模型」的实际写入效果：**没有执行**，因为它会改写你 `cordis.patch.yml` 里手工调过的那条路由（85 个模型 → 73 个，去掉只支持 `/messages` 的 9 个 Claude 条目）。是否刷新由你点按钮决定。

## 8. 已知限制

- **一条路由一种协议**。Claude 家族（9 个模型）只提供 `/messages`，因此不在 OpenAI 兼容路由里。要用它们需要再加一条 `api: anthropic-messages` 的路由，而那条路的鉴权头语义（`x-api-key` vs `Bearer`）未在本项目中验证，故未实现。
- `llm-pi-ai` 对**手工声明的路由**要求非空 `models` 列表，所以"连接"必须先成功发现目录（即需要可用密钥）。
- 面板轮询 60 秒；侧栏指示器点击是"立即刷新"，不会跳转到设置页。
- 无 `Config` schema 意味着行配置不做 schema 校验，写错字段会静默回落默认值。

## 9. 开发

```powershell
cd dsh-commandcode
node --test                       # 44 通过 + 2 跳过

# 连真实 dsh-tools 一起交叉验证（路径按你的安装调整）
$env:DSH_TOOLS_PATH = 'C:\Users\<you>\AppData\Local\Programs\DSH NEXT\resources\app\node_modules\@deepseek-ai\dsh-tools\lib\index.js'
node --test                       # 46 通过
```

目录：

```
index.js                  Host 半：路由、凭据、幂等写配置、两个工具
client.js                 Client 半：设置面板 + 侧栏指示器（纯 JS，无构建）
lib/usage.js              纯函数：端点常量、归一化、格式化、路由合并/比对
lib/commandcode-client.js 纯传输：三个 GET + 稳定失败码
cordis.patch.yml          插入那一行 Host 行
locale/{en,zh}.json       插件管理器卡片文案
test/                     46 个测试
```

## License

MIT
