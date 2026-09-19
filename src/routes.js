const store = require("./store");
const domain = require("./domain");
const { makeId, addDaysIso } = require("./util");

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "PATCH /clocks/:id",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "GET /retest-tasks",
  "GET /retest-tasks/overdue"
];

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
    throw httpError(400, "请求体必须是合法JSON");
  }
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function toNumber(value, field) {
  const num = Number(value);
  if (!Number.isFinite(num)) throw httpError(400, `字段 ${field} 必须是数字`);
  return num;
}

function toIsoDate(value, field) {
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw httpError(400, `字段 ${field} 必须是合法日期`);
  return time.toISOString();
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await store.read();
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => domain.clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const result = await store.update((db) => {
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: body.targetDailyRateSeconds === undefined
          ? 0
          : toNumber(body.targetDailyRateSeconds, "targetDailyRateSeconds"),
        allowedDeviationSeconds: body.allowedDeviationSeconds === undefined
          ? domain.DEFAULT_ALLOWED_DEVIATION_SECONDS
          : toNumber(body.allowedDeviationSeconds, "allowedDeviationSeconds"),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      if (clock.allowedDeviationSeconds < 0) throw httpError(400, "allowedDeviationSeconds 不能为负数");
      db.clocks.push(clock);
      return { status: 201, body: { data: domain.clockSummary(db, clock) } };
    });
    return send(res, result.status, result.body);
  }

  // 调整目标日差或允许范围：既有复测与交付结论随即按新政策重判
  const clockMatch = pathname.match(/^\/clocks\/([^/]+)$/);
  if (clockMatch && req.method === "PATCH") {
    const body = await parseBody(req);
    const result = await store.update((db) => {
      const clock = domain.findClock(db, clockMatch[1]);
      const previousPolicy = {
        targetDailyRateSeconds: Number(clock.targetDailyRateSeconds),
        allowedDeviationSeconds: domain.allowedDeviation(clock)
      };
      let touched = false;
      if (body.targetDailyRateSeconds !== undefined) {
        clock.targetDailyRateSeconds = toNumber(body.targetDailyRateSeconds, "targetDailyRateSeconds");
        touched = true;
      }
      if (body.allowedDeviationSeconds !== undefined) {
        const value = toNumber(body.allowedDeviationSeconds, "allowedDeviationSeconds");
        if (value < 0) throw httpError(400, "allowedDeviationSeconds 不能为负数");
        clock.allowedDeviationSeconds = value;
        touched = true;
      }
      if (body.note !== undefined) {
        clock.note = String(body.note);
        touched = true;
      }
      if (!touched) throw httpError(400, "未提供可更新字段：targetDailyRateSeconds / allowedDeviationSeconds / note");
      clock.updatedAt = new Date().toISOString();
      const rejudgedRetests = db.retests
        .filter((item) => item.clockId === clock.id)
        .map((item) => domain.enrichRetest(clock, item));
      return {
        status: 200,
        body: { data: domain.clockSummary(db, clock), previousPolicy, rejudgedRetests }
      };
    });
    return send(res, result.status, result.body);
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await store.read();
    const data = db.clocks.map((clock) => domain.clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  // 单表追溯：一只钟表的调校、复测任务（含作废留档）、复测取数全链路
  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await store.read();
    const clock = domain.findClock(db, historyMatch[1]);
    const now = Date.now();
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retestTasks = domain.tasksOfClock(db, clock.id).map((task) => domain.taskView(task, now));
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .map((item) => domain.enrichRetest(clock, item));
    return send(res, 200, {
      data: {
        clock: domain.clockSummary(db, clock, now),
        adjustments,
        retestTasks,
        retests,
        latestRetest: domain.enrichRetest(clock, domain.latestRetest(db, clock.id))
      }
    });
  }

  // 调校：生成带到期日的复测任务；结案前再调校则原任务作废留档、按新调校重排。
  // 幂等：requestId（或 Idempotency-Key 头）相同的并发/重复提交沿用首次结果。
  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const clockId = adjustmentMatch[1];
    const requestId = body.requestId || req.headers["idempotency-key"] || null;
    const result = await store.update((db) => {
      const clock = domain.findClock(db, clockId);
      if (requestId) {
        const existing = db.adjustments.find(
          (item) => item.clockId === clock.id && item.requestId === requestId
        );
        if (existing) {
          return {
            status: 200,
            body: {
              data: existing,
              task: domain.taskView(db.retestTasks.find((task) => task.adjustmentId === existing.id) || null),
              deduplicated: true
            }
          };
        }
      }
      const nowIso = new Date().toISOString();
      let dueAt;
      if (body.dueAt !== undefined) {
        dueAt = toIsoDate(body.dueAt, "dueAt");
      } else {
        const days = body.reviewDueInDays === undefined
          ? domain.DEFAULT_REVIEW_WINDOW_DAYS
          : toNumber(body.reviewDueInDays, "reviewDueInDays");
        if (days <= 0) throw httpError(400, "reviewDueInDays 必须大于 0");
        dueAt = addDaysIso(nowIso, days);
      }
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        requestId,
        currentDailyRateSeconds: toNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds"),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: nowIso
      };
      db.adjustments.push(adjustment);
      const voidedTasks = [];
      for (const task of db.retestTasks) {
        if (task.clockId === clock.id && task.status === "pending") {
          task.status = "voided";
          task.voidedAt = nowIso;
          task.voidReason = body.voidReason || "结案前再次调校，原复测任务作废重排";
          voidedTasks.push(task);
        }
      }
      const task = {
        id: makeId("task"),
        clockId: clock.id,
        adjustmentId: adjustment.id,
        status: "pending",
        createdAt: nowIso,
        dueAt,
        completedAt: null,
        completedByRetestId: null,
        voidedAt: null,
        voidReason: null,
        supersededByTaskId: null
      };
      for (const voided of voidedTasks) voided.supersededByTaskId = task.id;
      db.retestTasks.push(task);
      return {
        status: 201,
        body: {
          data: adjustment,
          task: domain.taskView(task),
          voidedTasks: voidedTasks.map((item) => domain.taskView(item))
        }
      };
    });
    return send(res, result.status, result.body);
  }

  // 复测取数：完成取数后任务结案；超出允许范围不得标记交付合格
  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const clockId = retestMatch[1];
    const result = await store.update((db) => {
      const clock = domain.findClock(db, clockId);
      const dailyRateSeconds = toNumber(body.dailyRateSeconds, "dailyRateSeconds");
      const amplitude = toNumber(body.amplitude, "amplitude");
      let task = null;
      if (body.taskId !== undefined) {
        task = db.retestTasks.find((item) => item.id === body.taskId && item.clockId === clock.id) || null;
        if (!task) throw httpError(404, "复测任务不存在");
        if (task.status === "voided") throw httpError(409, "复测任务已作废，请按最新调校任务取数");
        if (task.status === "completed") throw httpError(409, "复测任务已结案，不能重复取数");
      } else {
        task = domain.activeTask(db, clockId);
      }
      if (body.qualified === true && !domain.withinAllowedRange(clock, { dailyRateSeconds })) {
        throw httpError(400, "复测日差超出允许范围，不得标记交付合格");
      }
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId: task
          ? task.adjustmentId
          : body.adjustmentId || domain.latestAdjustment(db, clockId)?.id || null,
        taskId: task ? task.id : null,
        testedAt: body.testedAt === undefined ? new Date().toISOString() : toIsoDate(body.testedAt, "testedAt"),
        dailyRateSeconds,
        amplitude,
        forcedUnqualified: body.qualified === false,
        note: body.note || ""
      };
      db.retests.push(retest);
      if (task) {
        task.status = "completed";
        task.completedAt = retest.testedAt;
        task.completedByRetestId = retest.id;
      }
      return {
        status: 201,
        body: {
          data: domain.enrichRetest(clock, retest),
          task: domain.taskView(task),
          clock: domain.clockSummary(db, clock)
        }
      };
    });
    return send(res, result.status, result.body);
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await store.read();
    const clock = domain.findClock(db, latestMatch[1]);
    return send(res, 200, { data: domain.enrichRetest(clock, domain.latestRetest(db, clock.id)) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests
      .filter((item) => !clockId || item.clockId === clockId)
      .map((item) => {
        const clock = db.clocks.find((entry) => entry.id === item.clockId);
        return clock ? domain.enrichRetest(clock, item) : item;
      })
      .filter((item) => qualified === null || item.qualified === (qualified === "true"));
    return send(res, 200, { data });
  }

  // 逾期未复测列表：到期日已过仍未取数的任务
  if (req.method === "GET" && pathname === "/retest-tasks/overdue") {
    const db = await store.read();
    const now = Date.now();
    const data = domain.overdueTasks(db, now).map((task) => {
      const clock = db.clocks.find((item) => item.id === task.clockId) || null;
      return {
        ...domain.taskView(task, now),
        clock: clock && { id: clock.id, code: clock.code, escapementType: clock.escapementType }
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "GET" && pathname === "/retest-tasks") {
    const db = await store.read();
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const now = Date.now();
    const data = db.retestTasks
      .filter((task) => (!clockId || task.clockId === clockId) && (!status || task.status === status))
      .map((task) => domain.taskView(task, now));
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle, send, routes };
