# dsh-quota-dock

输入框上方常驻一行：Command Code 的 5h / 周 / 月三个窗口（进度条 + 百分比），加一条 DeepSeek 官方的峰谷时段轨道。点这一行，从界面中央浮出「只谈钱」的面板；平台接入在 设置 → 额度与平台。

```
5h ▮▮▯▯▯ 6%   周 ▮▮▯▯▯ 14%   月 ▮▮▯▯▯ 12%  │  ▮▮▮▯ 谷时 · 全天谷价
```

## 安装

```bash
dsh plugin add dsh-quota-dock
```

DSH 会把包内自带的 `cordis.patch.yml` 展开进你的 profile，不用手工改补丁。

桌面版的 profile 由应用托管，本地开发时走的是 link：profile 的 `package.json` 里写 `"dsh-quota-dock": "link:E:/dsh/dsh-quota-dock"`，并把 `dsh-quota-dock` 登记进 `dsh.profile.bundles`。

装完在 设置 → 额度与平台 里接入平台；内置的 Command Code 与 DeepSeek 只要环境里有 key 就会自己出现。

## 常显行

- 常驻显示，不用点开，不在二级菜单里。
- 条 + 百分比：比例看条，读数看百分比。
- 条长 = `used / cap`；取不到就留空轨道、读数打 `—`，不编数。
- 分档：< 80% 淡绿 `#7BB295`，≥ 80% 橙黄，≥ 95% 红。百分比文字只在报警档变色。
- 不单列「余」：月度条已经说明剩多少。
- DeepSeek 那组是时钟不是钱包：一条轨道画完整计价周期（08:30 起 16h 峰 + 8h 谷），橙黄为峰、蓝为谷，竖线标出当前位置，右侧是当前档位与倒计时（`峰时 · 距谷 3h42m`），30 秒走一次。谷 = 00:30–08:30；2026-08-23 起整周末算谷，显示 `谷时 · 全天谷价`、轨道全蓝。
- CC 与 DS 之间有一条小竖条。

## 点开面板

居中浮层，最宽 820px、最高 78vh，圆角 14px，从上方淡入。

- **顶部**：额度与余额 + 更新于 10-18 20:04 + 刷新 + ×。
- **概览**：本月剩余（大号）+ 本月已用 + 还能用 N 天。N 按当前消耗速度推算，取不到显示 `—`。
- **Command Code**：独占一行宽度，三窗口各一行，`已用/额度 credits`、条、百分比、右侧时间（5h/周 是「x 后重置」，月直接给周期结束日期）；月行下面一行小字：已用 · 剩余 · 订阅。
- **DeepSeek**：币种写在卡片右上角，下面是 总额 / 赠送 / 充值 / 可用 + 峰谷一行说明。
- **其他平台**：已接入平台各一行，有钱显示钱，没钱显示错误；一家都没有时给一句说明。
- **页脚**：左边「每 N 自动重取一次」（N 就是设置里的刷新间隔），右边告诉你配置在哪。

金额都带单位：CC 写 `credits`，DeepSeek 按币种给符号（`¥` / `$` …），OpenRouter 固定 USD，自定义接口没有币种信息只显示数字。

面板里没有任何配置项：没有输入框、没有 key 字段、没有「添加」按钮。按 Esc、点右上角 ×、或再点一次那一行都能关。

## 设置 → 额度与平台

左下角设置对话框侧边栏多一页，只做配置，四段固定顺序：

- **内置平台**：Command Code 与 DeepSeek 各一行 —— 状态点、名称、它读的环境变量、一个关键数字（当月已用占比 / 钱包总额）、更新时间、单行刷新。
- **已接入平台**：一行 = 状态点 + 名称 + `类型 · 地址` + 正常/失败 + 金额 + 删除。没接任何平台时是一行虚线框，带「去添加」。
- **接入新平台**：六个预设（OpenRouter / LiteLLM / New API / 硅基流动 / Kimi / 自定义），点一下把名称和地址填好；OpenRouter 的地址由插件固定，只读显示并说明原因。字段标签在上、输入在下。
- **数据与刷新**：刷新间隔（30 秒 / 1 分钟 / 2 分钟 / 5 分钟 / 10 分钟）+ 立即刷新、最近刷新、配置文件路径。

## 刷新与缓存

- 间隔默认 60 秒，可在设置页改成 30 秒 ~ 10 分钟，落到 `platforms.json` 的 `refreshMs`。
- 这个间隔只喂懒触发判定：没有人看的时候一次请求都不发，没有后台定时器。
- 客户端只在三个时机取数：首次挂载（还没数据时）、**切换会话时**（同一会话只刷一次）、面板里的「刷新」按钮。
- 数据时间写在 tooltip 里（`更新于 10-09 16:53`）。超过 24 小时才追加一句「数据较旧」，行内不显示警告。
- 刷新失败继续显示上一次成功的数据；两家的值与缓存互不影响。
- 连续点刷新只发一次请求。

## 接入别的平台

- `openrouter`：固定打 `GET https://openrouter.ai/api/v1/credits`，余额 = `total_credits − total_usage`。
- `custom`：打你填的地址，带 `Authorization: Bearer <key>`，把响应前两层的数字字段铺开显示。
- 单家失败不影响其他家，也不影响常显行；每家 15 秒超时。

key 存在 `<DSH_HOME>/dsh-quota-dock/platforms.json`（明文），接口只回 `hasKey`，不回显。

## 数据来源

| 供应商 | 端点 | 说明 |
|---|---|---|
| Command Code | `GET /alpha/billing/credits` | `windowLimits.{fiveHour,weekly}`；`monthlyCredits` 是**剩余**额度 |
| Command Code | `GET /alpha/usage/summary` | `totalMonthlyCredits` 是本周期**已用**额度（字段平铺在响应根上） |
| Command Code | `GET /alpha/billing/subscriptions` | `data.currentPeriodEnd` = 月度窗口重置时间 |
| DeepSeek | `GET /user/balance` | `balance_infos[]`，按币种显示 |

月度窗口总额 = `totalMonthlyCredits` + `monthlyCredits`，只读其中一个会算错。

峰谷时段不取数，按本机时钟算，跟接口是否成功无关。

## 凭据

Host 端从 `ctx.credentials` 读 `COMMANDCODE_API_KEY` 与 `DEEPSEEK_API_KEY`，环境变量兜底。密钥不进源码、不进接口返回、不进日志。

## 安装与测试

装载走 desktop profile 的 `dsh.profile.bundles`（`package.json` 里同时保留 `"dsh-quota-dock": "link:E:/dsh/dsh-quota-dock"`）。改 `index.js` 要触发 patchReload 或重开应用；改 `client.js` 刷新页面即可。

```powershell
cd E:\dsh\dsh-quota-dock
```

```powershell
npm test
```

离线 harness（`test/smoke.cjs`）用 stub 的 `window.__ModuleLoader__` 与 `react` 真渲染组件，断言三个槽位、常显行百分比与峰谷分支、进度条填充比与分档、面板开关、面板内无输入框、设置页四段与六个预设、刷新间隔档位，以及降级态不出现 `undefined` / `NaN`。时钟是注入的，凌晨和白天跑结论一致。
