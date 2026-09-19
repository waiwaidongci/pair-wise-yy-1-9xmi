/**
 * 接口处理片段：HTTP 解析、参数校验与业务编排。
 * 状态判定一律走 state.js，落盘与并发串行化一律走 store.js。
 */
const http = require("http");
const crypto = require("crypto");
const { readDb, transact, makeId, idempotencyHit, saveIdempotency } = require("./store");
const {
  currentSpec,
  rateWithinSpec,
  openTask,
  retestView,
  taskView,
  clockHistory,
  clockSummary,
  overdueTasks
} = require("./state");

/** 路由表即接口清单，/health 与 404 都直接返回本表，保证接口列表一致 */
const routes = [
  "GET    /health",
  "GET    /clocks",
  "POST   /clocks",
  "GET    /clocks/not-qualified",
  "GET    /clocks/overdue-retests",
  "GET    /clocks/:id/history",
  "PATCH  /clocks/:id/spec",
  "POST   /clocks/:id/adjustments",
  "POST   /clocks/:id/retests",
  "GET    /clocks/:id/latest-retest",
  "GET    /adjustments",
  "GET    /retests",
  "GET    /retest-tasks",
  "GET    /retest-tasks/overdue"
];

const DEFAULT_RETEST_DUE_DAYS = 7;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "请求体必须是合法JSON");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw new HttpError(400, `缺少字段：${missing.join(", ")}`);
}

function asNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw new HttpError(400, `字段 ${field} 必须是数字`);
  return num;
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw new HttpError(404, "钟表不存在");
  return clock;
}

function specText(spec) {
  return `目标${spec.targetDailyRateSeconds}±${spec.allowedDeviationSeconds}秒/日`;
}

function canonicalKey(payload) {
  const picked = ["currentDailyRateSeconds", "direction", "amount", "note"];
  const canonical = JSON.stringify(
    picked.sort().reduce((acc, key) => ({ ...acc, [key]: payload[key] ?? null }), {})
  );
  return `auto:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
}

/* ---------------- 业务动作（均在串行事务内完成读-改-写） ---------------- */

function createClock(db, body) {
  required(body, ["code", "escapementType", "balanceFrequency"]);
  const clock = {
    id: makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency: body.balanceFrequency,
    targetDailyRateSeconds: asNumber(body.targetDailyRateSeconds ?? 20, "targetDailyRateSeconds"),
    allowedDeviationSeconds: asNumber(body.allowedDeviationSeconds ?? 10, "allowedDeviationSeconds"),
    specVersion: 1,
    note: body.note || "",
    createdAt: new Date().toISOString()
  };
  if (clock.allowedDeviationSeconds < 0) throw new HttpError(400, "允许范围不能为负数");
  db.clocks.push(clock);
  return { data: clockSummary(db, clock) };
}

/**
 * 提交调校：
 * 1. 同一钟表同一调校请求并发只成功一次（幂等键命中则沿用首次结果）
 * 2. 结案前再次调校：原待复测任务当即可作废并留档，按新调校重排复测任务（带到期日）
 */
function createAdjustment(db, clockId, body, idempotencyHeader, nowIso) {
  const clock = findClock(db, clockId);
  const explicit = (idempotencyHeader || body.idempotencyKey || "").toString().trim();
  const key = explicit ? `explicit:${explicit}` : canonicalKey(body);

  const hit = idempotencyHit(db, clockId, key, Boolean(explicit));
  if (hit) return { reused: true, idempotencyKey: key, ...hit.response };

  required(body, ["currentDailyRateSeconds", "direction", "amount"]);
  const currentRate = asNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds");

  let dueAtIso;
  if (body.retestDueAt) {
    const dueAt = new Date(body.retestDueAt);
    if (Number.isNaN(dueAt.getTime())) throw new HttpError(400, "retestDueAt 必须是合法时间");
    dueAtIso = dueAt.toISOString();
  } else {
    const dueDays = body.retestDueInDays === undefined
      ? DEFAULT_RETEST_DUE_DAYS
      : asNumber(body.retestDueInDays, "retestDueInDays");
    if (dueDays <= 0) throw new HttpError(400, "retestDueInDays 必须大于0");
    dueAtIso = new Date(new Date(nowIso).getTime() + dueDays * 24 * 60 * 60 * 1000).toISOString();
  }

  const adjustment = {
    id: makeId("adjustment"),
    clockId: clock.id,
    currentDailyRateSeconds: currentRate,
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    createdAt: nowIso
  };
  db.adjustments.push(adjustment);

  // 结案前再调校：原 pending 任务立即作废并留档
  const voidedTasks = [];
  for (const task of db.retestTasks) {
    if (task.clockId === clock.id && task.status === "pending") {
      task.status = "voided";
      task.voidedAt = nowIso;
      task.voidReason = "superseded";
      task.supersededByAdjustmentId = adjustment.id;
      voidedTasks.push(task.id);
    }
  }

  const task = {
    id: makeId("retestTask"),
    clockId: clock.id,
    adjustmentId: adjustment.id,
    dueAt: dueAtIso,
    status: "pending",
    createdAt: nowIso
  };
  db.retestTasks.push(task);

  const response = {
    data: adjustment,
    retestTask: taskView(db, task, nowIso),
    voidedTaskIds: voidedTasks,
    clock: clockSummary(db, clock, nowIso)
  };
  saveIdempotency(db, { clockId: clock.id, key, response });
  return response;
}

/** 复测取数：只能对当前待复测任务完成取数，取数完成即结案；超范围一律不得判合格 */
function submitRetest(db, clockId, body, nowIso) {
  const clock = findClock(db, clockId);
  required(body, ["dailyRateSeconds", "amplitude"]);
  const dailyRateSeconds = asNumber(body.dailyRateSeconds, "dailyRateSeconds");
  const amplitude = asNumber(body.amplitude, "amplitude");

  let task;
  if (body.taskId) {
    task = db.retestTasks.find((item) => item.id === body.taskId && item.clockId === clock.id);
    if (!task) throw new HttpError(404, "复测任务不存在");
    if (task.status === "voided") throw new HttpError(409, "该复测任务已随重新调校作废，仅作留档，不可再取数");
    if (task.status === "completed") throw new HttpError(409, "该复测任务已结案，不能重复取数");
  } else {
    task = openTask(db, clock.id);
    if (!task) throw new HttpError(409, "当前没有待复测任务，请先提交调校");
  }

  const spec = currentSpec(clock);
  const qualified = rateWithinSpec(dailyRateSeconds, spec);
  if (body.qualified !== undefined && Boolean(body.qualified) && !qualified) {
    throw new HttpError(400, `复测日差与目标差${Math.abs(dailyRateSeconds - spec.targetDailyRateSeconds)}秒/日，超出${specText(spec)}允许范围，不得标记交付合格`);
  }

  const testedAtIso = body.testedAt ? new Date(body.testedAt).toISOString() : nowIso;
  if (Number.isNaN(new Date(testedAtIso).getTime())) throw new HttpError(400, "testedAt 必须是合法时间");

  const retest = {
    id: makeId("retest"),
    clockId: clock.id,
    adjustmentId: task.adjustmentId,
    taskId: task.id,
    testedAt: testedAtIso,
    dailyRateSeconds,
    amplitude,
    note: body.note || "",
    specSnapshot: spec
  };
  db.retests.push(retest);

  task.status = "completed";
  task.retestId = retest.id;
  task.completedAt = testedAtIso;

  return {
    data: retestView(db, retest),
    retestTask: taskView(db, task, nowIso),
    clock: clockSummary(db, clock, nowIso)
  };
}

/**
 * 调整目标日差或允许范围：留规格变更档、specVersion 递增。
 * 既有复测与交付结论不做物理改写，读取时按新规格自动失效重判。
 */
function updateSpec(db, clockId, body, nowIso) {
  const clock = findClock(db, clockId);
  const hasTarget = body.targetDailyRateSeconds !== undefined;
  const hasDeviation = body.allowedDeviationSeconds !== undefined;
  if (!hasTarget && !hasDeviation) throw new HttpError(400, "至少提供 targetDailyRateSeconds 或 allowedDeviationSeconds");

  const nextTarget = hasTarget ? asNumber(body.targetDailyRateSeconds, "targetDailyRateSeconds") : clock.targetDailyRateSeconds;
  const nextDeviation = hasDeviation ? asNumber(body.allowedDeviationSeconds, "allowedDeviationSeconds") : clock.allowedDeviationSeconds;
  if (nextDeviation < 0) throw new HttpError(400, "允许范围不能为负数");

  const from = currentSpec(clock);
  if (nextTarget === from.targetDailyRateSeconds && nextDeviation === from.allowedDeviationSeconds) {
    return { data: { changed: false, clock: clockSummary(db, clock, nowIso) } };
  }

  clock.targetDailyRateSeconds = nextTarget;
  clock.allowedDeviationSeconds = nextDeviation;
  clock.specVersion = (clock.specVersion ?? 1) + 1;

  const specChange = {
    id: makeId("specChange"),
    clockId: clock.id,
    from,
    to: currentSpec(clock),
    changedAt: nowIso,
    note: body.note || ""
  };
  db.specChanges.push(specChange);

  // 既有结论按新规格重判，直接随响应返回，便于确认失效结果
  const retests = db.retests
    .filter((item) => item.clockId === clock.id)
    .map((item) => retestView(db, item));

  return {
    data: {
      changed: true,
      specChange,
      retests,
      clock: clockSummary(db, clock, nowIso)
    }
  };
}

/* ---------------- 路由匹配与分发 ---------------- */

const routePatterns = [
  ["GET", /^\/clocks$/, "listClocks"],
  ["POST", /^\/clocks$/, "postClock"],
  ["GET", /^\/clocks\/not-qualified$/, "notQualified"],
  ["GET", /^\/clocks\/overdue-retests$/, "overdue"],
  ["GET", /^\/clocks\/([^/]+)\/history$/, "history"],
  ["PATCH", /^\/clocks\/([^/]+)\/spec$/, "patchSpec"],
  ["POST", /^\/clocks\/([^/]+)\/adjustments$/, "postAdjustment"],
  ["POST", /^\/clocks\/([^/]+)\/retests$/, "postRetest"],
  ["GET", /^\/clocks\/([^/]+)\/latest-retest$/, "latestRetest"],
  ["GET", /^\/adjustments$/, "listAdjustments"],
  ["GET", /^\/retests$/, "listRetests"],
  ["GET", /^\/retest-tasks\/overdue$/, "overdue"],
  ["GET", /^\/retest-tasks$/, "listTasks"]
];

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const nowIso = new Date().toISOString();

  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  for (const [method, pattern, action] of routePatterns) {
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;
    const db = await readDb();
    const params = { url, nowIso, id: match[1], idempotencyHeader: req.headers["idempotency-key"] };

    switch (action) {
      case "listClocks": {
        const qualified = url.searchParams.get("qualified");
        const caseStatus = url.searchParams.get("caseStatus");
        let data = db.clocks.map((clock) => clockSummary(db, clock, nowIso));
        if (caseStatus !== null) data = data.filter((clock) => clock.caseStatus === caseStatus);
        if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
        return send(res, 200, { data });
      }
      case "postClock": {
        const body = await parseBody(req);
        const result = await transact((liveDb) => createClock(liveDb, body));
        return send(res, 201, result);
      }
      case "notQualified": {
        const data = db.clocks
          .map((clock) => clockSummary(db, clock, nowIso))
          .filter((clock) => !clock.deliveryQualified);
        return send(res, 200, { data });
      }
      case "overdue": {
        return send(res, 200, { data: overdueTasks(db, nowIso), checkedAt: nowIso });
      }
      case "history": {
        const clock = findClock(db, params.id);
        const task = db.retestTasks
          .filter((item) => item.clockId === clock.id)
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
        return send(res, 200, {
          data: {
            clock: clockSummary(db, clock, nowIso),
            ...clockHistory(db, clock, nowIso),
            currentRetestTask: task ? taskView(db, task, nowIso) : null
          }
        });
      }
      case "patchSpec": {
        const body = await parseBody(req);
        const result = await transact((liveDb) => updateSpec(liveDb, params.id, body, nowIso));
        return send(res, 200, result);
      }
      case "postAdjustment": {
        const body = await parseBody(req);
        const result = await transact((liveDb) =>
          createAdjustment(liveDb, params.id, body, params.idempotencyHeader, nowIso));
        return send(res, 201, result);
      }
      case "postRetest": {
        const body = await parseBody(req);
        const result = await transact((liveDb) => submitRetest(liveDb, params.id, body, nowIso));
        return send(res, 201, result);
      }
      case "latestRetest": {
        findClock(db, params.id);
        const latest = db.retests
          .filter((item) => item.clockId === params.id)
          .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0];
        return send(res, 200, { data: latest ? retestView(db, latest) : null });
      }
      case "listAdjustments": {
        const clockId = url.searchParams.get("clockId");
        return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
      }
      case "listRetests": {
        const clockId = url.searchParams.get("clockId");
        const qualified = url.searchParams.get("qualified");
        let data = db.retests
          .filter((item) => !clockId || item.clockId === clockId)
          .map((item) => retestView(db, item));
        if (qualified !== null) data = data.filter((item) => item.qualified === (qualified === "true"));
        return send(res, 200, { data });
      }
      case "listTasks": {
        const clockId = url.searchParams.get("clockId");
        const status = url.searchParams.get("status");
        const overdueOnly = url.searchParams.get("overdue");
        let data = db.retestTasks
          .filter((item) => !clockId || item.clockId === clockId)
          .map((item) => taskView(db, item, nowIso))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        if (status !== null) data = data.filter((item) => item.status === status);
        if (overdueOnly !== null) data = data.filter((item) => item.overdue === (overdueOnly === "true"));
        return send(res, 200, { data });
      }
      default:
        return send(res, 200, { ok: true, routes });
    }
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      send(res, error.status || 500, { error: error.message || "服务器错误" });
    });
  });
}

module.exports = { createServer, routes };
