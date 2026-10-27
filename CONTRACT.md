# dsh-quota-dock · 冻结接口契约

插件目录 `E:\dsh\dsh-quota-dock`，包名 `dsh-quota-dock`。
本文件是 host 半与 client 半之间**唯一**的接口来源；两边都不许改它，要改先找 Lead。

## 文件归属（写作用域不重叠）

| 文件 | 归属 |
|---|---|
| `index.js` | host-dev |
| `client.js` | client-dev |
| `package.json` / `cordis.patch.yml` / `icon.svg` / `CONTRACT.md` | Lead（已写好，别动） |
| `~/.dsh/profiles/desktop/package.json` 等 profile 接线 | verifier |

## 1. HTTP 面（host 用 `ctx.webServer.register({ kind: 'exact', path, handler })` 注册，返回 disposer）

### `GET /api/dsh-quota-dock/snapshot`
**必须立刻返回**（绝不 await 上游）。200 + JSON：

```json
{
  "ok": true,
  "fetchedAt": 1760000000000,
  "ageMs": 12345,
  "stale": false,
  "fetching": false,
  "error": null,
  "cc": { "ok": true, "error": null, "windows": [], "remainingMonthlyCredits": 580, "subscription": null },
  "deepseek": { "ok": true, "error": null, "balances": [] }
}
```

- `fetchedAt` = 最近一次**成功**上游读取的 ms 时间戳；从未成功过则 `null`。
- `stale` = 正在展示的是旧数据：缓存超过 TTL **且没有刷新在飞**，或上次刷新失败。读到 TTL 边界本身就是下一轮刷新的触发点，所以「刚好过期 + `fetching:true`」不算旧数据——客户端据此跟着这轮刷新，而不是先闪一下警告；客户端另有一道保险：`stale && fetching` 时同样不亮标记，`error` / `cc.ok` / `deepseek.ok` 的失败态不受这道保险影响。
- `fetching` = 当前是否有刷新在飞。客户端在 `true` 时以更短的间隔连读，刷新一落地就拿到新数字；还没有数字可显示时也可以用它写「查询中…」。
- `error` = 最近一次刷新失败的首个错误字符串，成功时为 `null`。
- `cc` / `deepseek` 在某家失败时**不是 null**，而是 `{ "ok": false, "error": "...", "windows": [] }` / `{ "ok": false, "error": "...", "balances": [] }`。客户端不得因缺字段崩。

**cc.windows** 固定三项、固定顺序：

```json
[
  { "id": "fiveHour", "used": 12, "cap": 50, "resetAt": "2026-10-18T03:00:00.000Z", "error": null },
  { "id": "weekly",   "used": 88, "cap": 300, "resetAt": "...", "error": null },
  { "id": "monthly",  "used": 420, "cap": 1000, "resetAt": "...", "error": null }
]
```

- `used` / `cap` = 数值（积分），**拿不到就给 `null`，绝不给 NaN / 字符串**。
- `resetAt` = ISO 字符串或 `null`。
- `remainingMonthlyCredits` = `credits.monthlyCredits`（**剩余**，不是总额），数值或 `null`。
- 月度窗口**必须两边拼**：`cap = usage.totalMonthlyCredits + credits.monthlyCredits`，`used = usage.totalMonthlyCredits`，`resetAt = credits.windowLimits?.monthly?.resetAt`。若 `windowLimits` 里有更可靠的 `used`/`cap` 就用它，缺的再用推导值补。

**deepseek.balances**：

```json
[ { "currency": "CNY", "totalBalance": "45.67", "grantedBalance": "0.00", "toppedUpBalance": "45.67" } ]
```

### `POST /api/dsh-quota-dock/refresh`
立刻返回，后台去刷（并发去重：同一时刻只跑一个刷新循环）：
`{"ok":true,"started":true,"fetching":true}`

## 2. 刷新策略（host）

- 缓存 TTL 60s。`snapshot` 被调用时：缓存空 → 触发一次刷新；缓存超 TTL → 触发一次刷新；**无论如何都立刻回当前缓存**。
- 两家并行取数，各自 `AbortSignal.timeout(25000)`；CC 真实耗时 10~20s，所以绝不能同步等。
- **保留每家最后一次成功值**：DeepSeek 失败不能把 CC 的数字抹掉。
- 任何路径都不许把 key 写进返回值、错误信息或日志（只写 key 是否配置）。

## 3. 凭据（host）

- ref 字面量就是环境变量名：CC = `"COMMANDCODE_API_KEY"`，DS = `"DEEPSEEK_API_KEY"`。
- 取值链：`ctx.get('credentials')?.resolve(ref)` → `{ value, source } | undefined`；拿不到再退 `process.env[ref]`。
- 都没 → 该家 `ok:false`，`error` 写明「<REF> 未配置」。
- 用全局 `fetch`，不新增依赖。

## 4. 上游端点（host）

- `GET https://api.commandcode.ai/alpha/billing/credits`（`Authorization: Bearer <key>`）→ 余额 + `windowLimits`
- `GET https://api.commandcode.ai/alpha/usage/summary` → `totalMonthlyCredits`（本周期**已用**）
- 可选 `GET /alpha/billing/subscriptions` → `{ status, createdAt }`
- `GET https://api.deepseek.com/user/balance` → `balance_infos[]`
- 字段名容错：接受 `used`/`usage`/`usedCredits`、`cap`/`limit`/`credits` 等别名；单个字段缺失只让该字段为 null 并在该窗口写 `error`，**不许整体 throw**。

## 5. Client 半（client.js）

- 形态照抄 `E:\dsh\dsh-session-cost\client.js`：`window.__ModuleLoader__.load({ id: 'dsh-quota-dock', factory(require) {...} })`，`require('react')` / `require('react-dom')`，无构建。
- `apply(ctx)`：`inject: ['slots','locale']`；`ctx.effect(() => ctx.locale.register(NS, {en:{...},zh:{...}}), '...')`；然后

```js
ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
  name: 'conversation.input.dock',   // "Full-width entries above the composer card" = 输入框上方
  id: 'quota-dock',
  order: -1,                 // 该列表最上一条（现有 0/10/20/40）
  locale: NS,
  inject: () => ({ load }),
}, QuotaDock))
```

- 注入的 `load` 每次 render 都是新函数 → 像 session-cost 那样放进 `useRef`，别写进依赖数组。
- **常显行必须带具体数字**（硬约束），三个窗口都显示，「余」不再输出：

```
5h ▮▮▯ 12/50 · 周 ▮▯▯ 88/300 · 月 ▮▯▯ 420/1000      |  DS ¥45.67
```

  可以配细进度条，但**不能只有百分比/进度条**。CRITICAL：不要藏在二级菜单里。
- 视觉：整行 flex + wrap、12px、tabular-nums；label 与数字走 `--dsw-alias-label-*` 色阶（数字主体比 `/cap` 重）；条 48×5、圆角 999px、轨道 `--dsw-alias-fill-l2`；DS 组靠右、前有 1px 竖线。只用 `--dsw-alias-*` token，不硬编码颜色。
- 状态：无数据 → 「查询中…」；失败 → 显示上次成功数字 + 警告标记；key 未配置 → 「未配置 key」。
- 取数：`GET /api/dsh-quota-dock/snapshot`。若 `fetchedAt === null` → 再 `POST /api/dsh-quota-dock/refresh`，然后每 2s 轮询一次 snapshot（最多 30s）直到有数。之后每 5min 刷新一次；`window` focus 时也刷。
- 点击整条可以展开一个详情面板（可选加分项），**但常显行本身永远保留数字**。
- 样式：直接复用 `--dsw-alias-*` / `--dsw-specific-menu` token（照抄 session-cost 的 CSS），`font-variant-numeric: tabular-nums`。
- 任何 `null` / `NaN` 一律渲染成 `—`。
- i18n：en + zh 各一套 key。

## 6. 参考代码（只读，别改）

- `E:\dsh\dsh-session-cost\client.js` —— dock 药丸 + 弹出面板的形态参考（槽位不同：它挂 composer.dock）
- `E:\dsh\dsh-session-cost\index.js` —— host 半导出形态：`export const inject = [...]` + `export function apply(ctx)`
- `C:\Users\camellia\.dsh\profiles\desktop\node_modules\dsh-token-quota\lib\index.js` —— `ctx.webServer.register` + `writeJson`（第 470、1057 行附近）
- `C:\Users\camellia\.dsh\profiles\desktop\node_modules\dsh-token-quota\lib\providers.js` —— CC / DeepSeek 两家适配层的字段名
- `E:\dsh\dsh-quota-plugin-brief.md` —— 需求原文（含实测字段语义）

## 7. v2（2026-10-18）—— 点击面板 + 平台接入

§5 的「12/50」示例作废：常显行只留百分比与进度条，DeepSeek 组不写 “DS” 前缀。行可点击，展开面板。

### 7.1 快照补充字段（全部 additive，client 必须容忍缺失）

```
cc: {
  ok, error, windows: [{ id, used, cap, resetAt, error }],
  remainingMonthlyCredits,   // = credits.monthlyCredits（剩余）
  usedMonthlyCredits,        // = usage.totalMonthlyCredits（已用）
  monthlyCap,                // 派生 = usedMonthlyCredits + remainingMonthlyCredits
  subscription: { status, planId, currentPeriodStart, currentPeriodEnd },
  credits: { monthlyCredits, purchasedCredits, freeCredits, belowThreshold, creditThreshold }
}
deepseek: {
  ok, error, isAvailable,
  balances: [{ currency, totalBalance, grantedBalance, toppedUpBalance }]
}
platforms: [                 // 非内置平台（§7.3）的余额，失败也保留上一份好值 + ok:false
  { id, name, kind, ok, error, fetchedAt, fields: [{ label, value }] }
]
```

- 顶层另有 `refreshMs`（2026-10-18 新增）：当前生效的刷新间隔，面板页脚据此写「每 N 自动重取一次」。缺失时 client 不猜，改显示设置入口。

### 7.2 面板（client 半）

- 整行是 `<button>`（`aria-expanded`），点击在行**上方**弹出面板；Esc、右上角 × 与再次点击都能关。
- 面板**只放钱**，不放任何配置（配置见 §7.4）：
  - 顶部：`额度与余额` + `更新于 MM-DD HH:mm` + 刷新 + ×；下面一行 hero——本月剩余（大号）+ 本月已用 + 还能用 N 天。
  - **Command Code 独占整行**：三个窗口各一行（label / `已用/额度` / 5px 条 / 百分比 / 右侧时间）；5h 与周用倒计时，月直接给周期结束日期（一个月外的倒计时没有信息量）；月行下面接**一行**明细（已用 · 剩余 · 订阅），「月」全卡只出现一次，周期结束也不重复。
  - **DeepSeek**：单币种时币种写在卡片右上角；下面是 总额 / 赠送 / 充值 / 可用（圆点 + 文字，颜色不单独承载状态）+ 峰谷一行说明。
  - **其他平台**：已接入平台各一行；一家都没有时给一句说明，不堆空行。
  - 页脚：左「每 N 自动重取一次」（N 取快照的 `refreshMs`），右「平台接入在 设置 → 额度与平台」。
- 面板 `min(820px, 90vw)`、最高 78vh、圆角 14px；卡片两列网格，Command Code 跨两列。
- 只用 `--dsw-alias-*` token；语义色只有绿/黄/红三档（`#7BB295` / `#E0A03A` / `#E0574F` 作回退字面量）。
- 面板本身可以拥挤；**常显行**仍然是「一眼能读」的那一行。
- 不用 gift/emoji。

### 7.3 平台接入（host 半）

- 存储：`<DSH_HOME>/dsh-quota-dock/platforms.json`（目录不存在则创建；文件权限尽量 0600）。文档形态 `{ version:1, refreshMs, platforms:[...] }`；旧版纯数组文件仍能读，读入后按默认间隔补齐。key **只进不出**：GET 只回 `hasKey: true`。
- `GET /api/dsh-quota-dock/platforms` → `{ ok:true, refreshMs, refreshChoices, storePath, platforms:[{id,name,kind,baseUrl,hasKey,ok,error,fetchedAt,fields:[{label,value}]}] }`（永不回显 key）。`refreshChoices` = `[30000,60000,120000,300000,600000]`。
- `POST /api/dsh-quota-dock/platforms`，body JSON：
  - `{ action:'add', name, kind:'openrouter'|'custom', baseUrl?, apiKey }`
  - `{ action:'remove', id }`
  - `{ action:'settings', refreshMs }` —— 必须是 `refreshChoices` 里的值，否则 400
  → 返回与 GET 相同的负载；非法输入 400 + `{ ok:false, error }`。
- 刷新节奏：`refreshMs` 是懒触发的 TTL（行、面板、平台列表三处判断），clamp 到 15s–1h，默认 60s。**Host 没有后台定时器**：没有人看的时候一次请求都不发。
- 定时器在客户端行内：按快照里的 `refreshMs` 自调度下一次 `GET /snapshot`（落在 TTL 刚过期 + 500ms 左右），读到 `fetching:true` 就以 1.5s 连读，直到新数字落地；上一轮失败时退到 15s 重试。「刷新」按钮和切换会话会立即重排这个定时器，不必等满一个周期。
- 适配器：
  - `deepseek`（内置）：`GET https://api.deepseek.com/user/balance`
  - `openrouter`（内置）：`GET https://openrouter.ai/api/v1/credits` → `data.total_credits` / `data.total_usage`，余额 = 两者之差
  - `custom`：`GET <baseUrl>`，`authorization: Bearer <key>`，把响应里前两层的数字字段铺成 `fields`
- 超时 15s，单个平台失败不影响其它平台；`POST /refresh` 同时刷新平台。

### 7.4 设置页（client 半）

设置二级菜单分四段，顺序固定为 `builtin` → `platforms` → `add` → `data`：

- **内置平台**：Command Code（`COMMANDCODE_API_KEY`，读当月已用占比）与 DeepSeek（`DEEPSEEK_API_KEY`，读第一个钱包总额），每行 状态点 + 名称 + 环境变量名 + 一个关键数字 + 更新时间 + 单行刷新。数字只作「配没配好」的提示，金额看常显行与面板。
- **已接入平台**：一行 = 状态点 + 名称 + `kind · baseUrl` + 状态词 + 金额 + 删除。空态是一行虚线框（「还没有接入任何平台 / 下面添加一个即可」+ 跳到表单）。
- **接入新平台**：预设 chips 六个（OpenRouter / LiteLLM / New API / 硅基流动 / Kimi / 自定义），选中即填名称与地址；OpenRouter 地址由插件固定、只读展示并说明原因，其余预设地址可改。字段一律标签在上、输入在下，不拿 placeholder 当标签。提交按钮靠右。
- **数据与刷新**：刷新间隔 select（`refreshChoices` 五档，显示成「30 秒 / 1 分钟 / …」）+ 立即刷新、最近刷新、配置文件路径。改间隔走 `POST { action:'settings' }`，落后端 `platforms.json`。
- 设置页不显示金额汇总（金额属于行与面板）；颜色只用 `--dsw-alias-*`，语义色只有 ok/warn/bad 三个档。

