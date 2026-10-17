# dsh-quota-dock

输入框上方常驻一行：Command Code 的 5h、周、月三个窗口（各带进度条 + 百分比），加 DeepSeek 官方的峰谷时段条（时段进度参考 dsh-cost-meter 的表现形式）。

```
5h ▮▮▯▯▯ 6%   周 ▮▮▯▯▯ 14%   月 ▮▮▯▯▯ 12%  │  DS ▮▮▮▯ 峰时 · 距谷 3h42m
```

- 常驻显示，不用点开，不在二级菜单里。
- 每条给条 + 百分比：比例看条，读数看百分比。
- 条长 = `used / cap`，取不到就留空轨道、读数照打 `—`，不编数。
- 条有描边，空轨道和填充都看得清。
- 分档：< 80% 淡绿，≥ 80% 橙黄，≥ 95% 红；百分比文字只在报警档变色。
- 不单独列「余」：月度条已经说明剩多少。
- DeepSeek 那组是时钟不是钱包：一条轨道画完整计价周期（08:30 起的 16h 峰 + 8h 谷），橙黄 = 峰段、蓝 = 谷段，轨道上的竖线标出现在走到哪；右侧文字是当前档位与距下次切换的倒计时（`峰时 · 距谷 3h42m`，30 秒刷新一次）。谷 = 00:30–08:30，2026-08-23 起整个周末算谷，周末显示 `谷时 · 全天谷价`、轨道全蓝。
- CC 与 DS 之间有一条小竖条分隔。

## 数据来源

| 供应商 | 端点 | 说明 |
|---|---|---|
| Command Code | `GET /alpha/billing/credits` | `windowLimits.{fiveHour,weekly}`；`monthlyCredits` 是**剩余**额度 |
| Command Code | `GET /alpha/usage/summary` | `totalMonthlyCredits` 是本周期**已用**额度（字段平铺在响应根上） |
| Command Code | `GET /alpha/billing/subscriptions` | `data.currentPeriodEnd` = 本月窗口的重置时间 |
| DeepSeek | `GET /user/balance` | `balance_infos[]`；host 仍取，行上不显示 |

月度窗口总额 = `totalMonthlyCredits` + `monthlyCredits`（两边拼，单看一个会算错）。

峰谷时段不取数：按本机时钟算，跟余额接口是否成功无关。

## 行为

- 位置在输入框上方（`conversation.input.dock` 槽位，与待办、队列等条目同列）。
- Command Code 接口实测 10~20 秒返回，所以 host 端缓存 60 秒：页面永远秒开，后台在刷新。
- 刷新失败时继续显示上一次成功的数据，并标记为陈旧。
- 两家的值与缓存互不影响：DeepSeek 挂了不会把 Command Code 的数字抹掉。
- 每 5 分钟自动刷新一次，窗口重新获得焦点时也刷。

## 凭据

从 host 端 `ctx.credentials` 读 `COMMANDCODE_API_KEY` 与 `DEEPSEEK_API_KEY`，环境变量作为兜底。密钥不会进源码、不会出现在接口返回或日志里。

## 安装与测试

装载方式是 desktop profile 的 `dsh.profile.bundles`（`package.json` 里同时留了 `"@local/dsh-quota-dock": "link:E:/dsh/dsh-quota-dock"` 依赖，跑 pnpm install 也不会掉）。改 `index.js` 要触发一次 patchReload（往 profile 的 `cordis.patch.yml` 追加一行注释）或重开应用；改 `client.js` 刷新页面即可。

```powershell
cd E:\dsh\dsh-quota-dock
```

```powershell
npm test
```

离线 harness 用 stub 的 `window.__ModuleLoader__` 与 `react` 真渲染组件，断言槽位、三窗口、百分比、峰谷分支与降级态；时钟是注入的，凌晨和白天跑结论一致。
