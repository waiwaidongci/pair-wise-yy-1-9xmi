# 机械钟表擒纵调校API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化。代码按职责拆成三个独立片段：

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口，启动方式不变：`PORT=3021 node server.js` |
| `lib/http.js` | 接口处理片段：HTTP 解析、校验、编排；内嵌路由表即接口清单 |
| `lib/state.js` | 状态计算片段：纯函数，合格/逾期/结案/失效全部按落盘记录现算 |
| `lib/store.js` | 记录持久化片段：db.json 读写、结构迁移、写入串行事务、ID 与幂等留档 |

## 启动

```bash
PORT=3021 node server.js
```

## 接口清单

`GET /health` 与任何 404 响应都会返回同一份接口列表。

- `GET /clocks`（可选筛选 `?qualified=true&caseStatus=closed|awaiting-retest|no-adjustment`）
- `POST /clocks`（建档时可带 `targetDailyRateSeconds`、`allowedDeviationSeconds`，默认 20±10）
- `GET /clocks/not-qualified`
- `GET /clocks/overdue-retests` —— 逾期未复测列表
- `GET /clocks/:id/history` —— 单表追溯：调校 / 复测任务（含作废留档）/ 复测 / 规格变更
- `PATCH /clocks/:id/spec` —— 调整目标日差或允许范围（留档并使既有结论失效重判）
- `POST /clocks/:id/adjustments` —— 提交调校，自动生成带到期日的复测任务
- `POST /clocks/:id/retests` —— 复测取数，取数完成即结案
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`
- `GET /retest-tasks?clockId=&status=&overdue=`
- `GET /retest-tasks/overdue`

## 调校-复核闭环规则

1. **每次调校生成复测任务**：默认到期日为调校后 7 天，可用 `retestDueInDays` 或 `retestDueAt` 指定。
2. **复测取数完成才结案**：`POST /retests` 必须落在当前待复测任务上；取数后任务 `pending → completed`。
   已结案任务不能重复取数（409）。
3. **结案前再调校**：原 `pending` 任务**当即作废**（`status=voided`，记 `voidedAt/voidReason/supersededByAdjustmentId`）并留档，按新调校重排任务；
   已结案任务不复制作废。作废任务不可再取数（409）。
4. **合格判定**：`|实测日差 - 目标日差| ≤ 允许范围`。超范围时任务照常结案但**不得标记交付合格**，
   传 `qualified:true` 强标直接 400。合格结论不入库，任何时候都由 `state.js` 现算。
5. **调整目标值/允许范围**：`PATCH /spec` 递增 `specVersion` 并写 `specChanges` 留档；
   既有复测保留当时规格快照（`specSnapshot`），读取时按新规格自动失效、重判，列表与单表追溯同步翻案。
6. **并发幂等**：同一钟表同一调校请求并发只成功一次，重复提交沿用首次结果（响应含 `reused:true`）。
   - 未显式给键时，按请求体内容生成哈希键（10 分钟窗口内去重，防双击/重试）。
   - 显式键：请求头 `Idempotency-Key: xxx` 或 body 字段 `idempotencyKey`，长期有效，键同即沿用首次结果。
   - 写操作经全局串行事务排队，读-判-写不存在竞态。
7. **逾期未复测**：`GET /retest-tasks/overdue` 或 `GET /clocks/overdue-retests`；已作废任务只留档不算逾期。
8. **刷新/重启一致**：所有状态均由落盘记录推导，服务重启后结论不变；旧版 db.json 首次读库时自动迁移（补任务、快照、规格字段）。

## 闭环示例

```bash
# 1. 提交调校（得到带到期日的复测任务）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":31,"direction":"慢针方向","amount":"再微调0.2格","retestDueInDays":5}'

# 2. 查逾期未复测
curl http://127.0.0.1:3021/retest-tasks/overdue

# 3. 复测取数结案（日差与目标之差在允许范围内才交付合格）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":25,"amplitude":255,"note":"复测达标"}'

# 4. 调整允许范围，既有交付结论自动重判
curl -X PATCH http://127.0.0.1:3021/clocks/clock_demo/spec \
  -H 'Content-Type: application/json' \
  -d '{"allowedDeviationSeconds":3}'

# 5. 单表追溯
curl http://127.0.0.1:3021/clocks/clock_demo/history
```
