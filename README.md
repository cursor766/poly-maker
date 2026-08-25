# poly-maker

将经授权的 MQTT 博彩赔率转换为去水后的公平概率，并以 Polymarket CLOB
订单簿为执行场所生成安全的模拟或真实做市报价。

## 安全边界

- 默认模式是 `paper`；`shadow` 会认证并读取真实账户但不提交或撤销订单。
- `live` 只允许 type=3 Deposit Wallet，并要求市场白名单和两段显式确认。
- MQTT 和 Polymarket 凭据只能通过 `.env` 注入，不得提交到仓库。
- 未明确配置两个 `sourceOddId` 到 Polymarket outcome 的映射时不会报价。
- MQTT/Polymarket WS 断线、赔率陈旧、源盘口停盘/隐藏、heartbeat 失败、
  CLOB 异常或仓位超限都会先阻止新单，再按 `conditionId` 精确撤单并确认归零。
- 使用第三方数据前，请确认访问许可、服务条款和所在地法规。

## 配置

```bash
cp .env.example .env
```

填入 MQTT 用户名和密码。首次运行保留：

```dotenv
DISCOVERY_MODE=true
OBSERVE_ONLY=true
TUI_ENABLED=true
TRADING_MODE=paper
```

然后启动只读赔率观察台：

```bash
pnpm observe
```

真实交易使用 Node.js 24+、`@polymarket/client` 和 type=3 Deposit Wallet。先配置：

```dotenv
OBSERVE_ONLY=false
TRADING_MODE=shadow
POLYMARKET_MARKET_ALLOWLIST=hok-lgd-rw-2026-07-31
POLYMARKET_B_FUNDER=0x你的DepositWallet
POLYMARKET_B_PRIVATE_KEY=0x你的EOA私钥
POLYMARKET_B_SIGNATURE_TYPE=3
ORDER_NOTIONAL=5
QUOTE_LEVELS=3
QUOTE_LEVEL_SPACING_TICKS=2
MAX_ORDER_NOTIONAL=5
MAX_ACCOUNT_NOTIONAL=30
```

`shadow` 启动时会验证 Deposit Wallet 身份、Polygon 137、closed-only 状态、
USDC 余额和 allowance，并对账白名单市场的远端订单；不会产生任何交易写操作。
确认审计日志、互补 BUY 报价和锁盘原因后，才设置：

```dotenv
TRADING_MODE=live
LIVE_TRADING_ACK=I_UNDERSTAND_REAL_ORDERS_WILL_BE_PLACED
LIVE_TRADING_ACK_2=ENABLE_TYPE3_LIVE_FOR_ALLOWLIST_ONLY
```

上述多层配置会在每个 outcome 挂 3 层、每层约 5 USDC，相邻层相差 2 个 tick；
单个二元市场最多占用约 30 USDC。建议第一阶段白名单只放一个盘口，并保持很小的
资金上限。私钥不得写入 `markets.json`、日志或版本库。

TUI 会显示 MQTT 连接状态、`marketId`、`matchId`、`oddId`、十进制赔率、
隐含概率和二元市场去水概率。`OBSERVE_ONLY=true` 时不会请求 Gamma/CLOB，
也不会生成或提交任何 Polymarket 报价。若配置 `SOURCE_API_TOKEN`，程序会从
源站 `/game/matchList` 加载比赛元数据，将 `mkt_ids["0"]` 标为全场盘口，
`mkt_ids["1"]` 至 `["5"]` 标为对应局盘口，并把 `@T1/@T2` 映射为队伍名称。
设置 `SOURCE_MATCH_IDS=5975531956975952` 后，只订阅和显示 LGD NBW vs
Rogue Warriors；不会接收其他比赛的全局赔率流。
确认 LGD NBW 与
Rogue Warriors 的 ID 方向后，编辑 `config/markets.json`：

```json
[
  {
    "name": "LGD NBW vs Rogue Warriors - Match Winner",
    "enabled": true,
    "sourceMatchId": "从消息确认",
    "sourceMarketId": "从消息确认",
    "polymarketSlug": "hok-lgd-rw-2026-07-31",
    "outcomes": [
      { "sourceOddId": "从页面确认", "outcome": "LGD NBW" },
      { "sourceOddId": "从页面确认", "outcome": "Rogue Warriors" }
    ]
  }
]
```

禁止根据数组顺序猜测队伍方向。赔率更新样本中的 `market_id=4619667554695260`
来自另一场比赛，不能用于当前赛事映射。

## 控制面板

本地控制台可粘贴源站与 Polymarket URL，预览盘口、配置每层挂单参数，并启停做市进程。

终端 1（控制 API，仅监听 `127.0.0.1:48787`）：

```bash
pnpm web:api
```

终端 2（Next.js 前端）：

```bash
pnpm web:dev
```

打开 `http://127.0.0.1:3000`：优先用联赛扫描（KPL / KGL）批量配置全场胜负，或粘贴两个 URL
精细配置各局。勾选盘口或启动自动跟赔后会直接实盘挂单，无需再到交易台启动核心。运行中的市场配置会自动热加载；交易台通过 SSE
显示连接、额度、挂单和风控原因。`live` 仍要求 `.env` 双重确认。

联赛扫描按 `tournament_id` 区分 KPL 与 KGL，再用队名 + 开赛时间对齐 Polymarket。
默认只选择高置信、且买一加 1 tick 仍低于源赔率安全上限的全场盘；确认后每边一层 BUY。

## 命令

```bash
pnpm web:api
pnpm web:dev
pnpm observe
pnpm check
pnpm build
pnpm start
```

PAPER、SHADOW 和 LIVE 的计划、撤单、heartbeat、成交/仓位同步写入
`data/audit.ndjson`。模拟成交规则为：已有挂单在
下一次 CLOB 快照中被最优对手价穿过时成交。

LIVE 使用互补 BUY-only：目标 `SELL A @ qA` 会转换成 `BUY B @ 1-qA`，
目标 `SELL B @ qB` 会转换成 `BUY A @ 1-qB`。订单始终 `postOnly`；若目标价
会吃单，则退一 tick。锁盘后必须同时收到锁盘时间之后的双边源赔率、源盘口重新开放、
Polymarket WS/订单簿新鲜数据以及健康 heartbeat，才会解除屏障。

## 概率处理

对两侧十进制赔率 `o1, o2`：

```text
raw_i = 1 / o_i
fair_i = raw_i / (raw_1 + raw_2)
```

例如 `1.962 / 1.804` 去水后约为 `47.9% / 52.1%`，源站 overround 约 `105.3%`。自动跟赔
挂单时不去掉这笔水分，再额外加目标抽水（95% 回报 = +5 个点），卖价合计 =
`overround + 5¢`，互补买单合计 = `200¢ − 卖价合计`。

`odd_group` 的业务含义尚未
验证，因此首版只使用消息顶层 `odd`。
