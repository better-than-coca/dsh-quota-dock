# dsh-quota-dock · 冻结接口契约

插件目录 `E:\dsh\dsh-quota-dock`，包名 `@local/dsh-quota-dock`。
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
- `stale` = 正在展示的是旧数据（超过 TTL 或上次刷新失败）。
- `fetching` = 当前是否有刷新在飞（用于客户端显示「查询中…」）。
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

- 形态照抄 `E:\dsh\dsh-session-cost\client.js`：`window.__ModuleLoader__.load({ id: '@local/dsh-quota-dock', factory(require) {...} })`，`require('react')` / `require('react-dom')`，无构建。
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
