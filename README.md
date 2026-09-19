# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测任务和复测取数记录，覆盖「调校 → 复测任务 → 取数结案 → 交付判定」的复核闭环。

## 启动

```bash
PORT=3021 node server.js
```

## 代码结构

- `server.js` — 进程引导与端口监听（启动方式不变）
- `src/routes.js` — 接口处理：路由、入参校验、响应组装
- `src/domain.js` — 状态计算：合格判定、任务状态、逾期与交付结论（纯函数，读取时实时推导）
- `src/store.js` — 记录持久化：`data/db.json` 读写、串行写锁、历史数据迁移
- `src/util.js` — ID 与时间工具

## 复核闭环规则

1. **每次调校生成复测任务**：`POST /clocks/:id/adjustments` 成功后创建 `pending` 状态的复测任务，默认 7 天到期（可用 `reviewDueInDays` 或 `dueAt` 指定）。
2. **取数完成才结案**：`POST /clocks/:id/retests` 录入复测数据后任务转为 `completed`，钟配方可进入交付判定。
3. **结案前再调校即重排**：新调校会把该钟表未结案的任务置为 `voided`（记录作废原因与后继任务号，留档可查），并按新调校生成新任务。
4. **合格判定**：`|复测日差 - 目标日差| ≤ 允许范围` 才可交付合格；超范围时请求里强制 `qualified:true` 会被 400 拒绝。
5. **目标值/允许范围变更即重判**：`PATCH /clocks/:id` 修改 `targetDailyRateSeconds` 或 `allowedDeviationSeconds` 后，既有复测与交付结论按新政策实时重判（历史记录不改写）。
6. **幂等调校**：同一钟表携带相同 `requestId`（或 `Idempotency-Key` 请求头）的调校请求只成功一次，重复提交返回首次结果并带 `deduplicated: true`。
7. **逾期可查**：`GET /retest-tasks/overdue` 列出到期未取数的任务。

## 接口列表

- `GET /health`
- `GET /clocks?qualified=`
- `POST /clocks`（`code`、`escapementType`、`balanceFrequency` 必填；`targetDailyRateSeconds` 默认 0，`allowedDeviationSeconds` 默认 10）
- `PATCH /clocks/:id`（调整 `targetDailyRateSeconds` / `allowedDeviationSeconds` / `note`，触发结论重判）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（单表追溯：调校、复测任务含作废留档、复测取数全链路）
- `POST /clocks/:id/adjustments`（支持 `requestId` 幂等、`reviewDueInDays` / `dueAt` 到期日）
- `POST /clocks/:id/retests`（可指定 `taskId`；已作废/已结案任务拒绝取数）
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /retest-tasks?clockId=&status=`（`pending` / `completed` / `voided`）
- `GET /retest-tasks/overdue`

## 闭环示例

```bash
# 1. 调校并生成复测任务（幂等键防止并发重复建单）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: req-20260919-001' \
  -d '{"currentDailyRateSeconds":31,"direction":"慢针方向","amount":"快慢针再调0.2格","reviewDueInDays":5}'

# 2. 逾期未复测列表
curl http://127.0.0.1:3021/retest-tasks/overdue

# 3. 复测取数，任务结案
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":22,"amplitude":252,"note":"复测进入允许范围"}'

# 4. 调整目标值/允许范围，既有结论实时重判
curl -X PATCH http://127.0.0.1:3021/clocks/clock_demo \
  -H 'Content-Type: application/json' \
  -d '{"targetDailyRateSeconds":15,"allowedDeviationSeconds":5}'

# 5. 单表追溯（含作废任务留档）
curl http://127.0.0.1:3021/clocks/clock_demo/history
```
