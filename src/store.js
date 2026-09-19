const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const { makeId, toTime, addDaysIso } = require("./util");
const {
  DEFAULT_REVIEW_WINDOW_DAYS,
  DEFAULT_ALLOWED_DEVIATION_SECONDS
} = require("./domain");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

function initialData() {
  const now = new Date().toISOString();
  return {
    clocks: [
      {
        id: "clock_demo",
        code: "CLK-1890-07",
        escapementType: "瑞士杠杆式",
        balanceFrequency: "18000vph",
        targetDailyRateSeconds: 20,
        allowedDeviationSeconds: 10,
        note: "怀表机芯，走时偏快",
        createdAt: now
      }
    ],
    adjustments: [
      {
        id: "adjustment_demo",
        clockId: "clock_demo",
        requestId: null,
        currentDailyRateSeconds: 68,
        direction: "慢针方向",
        amount: "游丝快慢针向慢侧微调0.4格",
        note: "初次调校，先保守处理",
        createdAt: now
      }
    ],
    retestTasks: [
      {
        id: "task_demo",
        clockId: "clock_demo",
        adjustmentId: "adjustment_demo",
        status: "completed",
        createdAt: now,
        dueAt: addDaysIso(now, DEFAULT_REVIEW_WINDOW_DAYS),
        completedAt: now,
        completedByRetestId: "retest_demo",
        voidedAt: null,
        voidReason: null,
        supersededByTaskId: null
      }
    ],
    retests: [
      {
        id: "retest_demo",
        clockId: "clock_demo",
        adjustmentId: "adjustment_demo",
        taskId: "task_demo",
        testedAt: now,
        dailyRateSeconds: 31,
        amplitude: 248,
        forcedUnqualified: false,
        note: "仍偏快，振幅尚可"
      }
    ]
  };
}

// 兼容旧版数据：补齐集合、允许范围字段，并为历史调校补建复测任务
function migrate(db) {
  let changed = false;
  for (const key of ["clocks", "adjustments", "retests", "retestTasks"]) {
    if (!Array.isArray(db[key])) {
      db[key] = [];
      changed = true;
    }
  }
  for (const clock of db.clocks) {
    if (clock.targetDailyRateSeconds === undefined) {
      clock.targetDailyRateSeconds = 0;
      changed = true;
    }
    if (clock.allowedDeviationSeconds === undefined) {
      clock.allowedDeviationSeconds = DEFAULT_ALLOWED_DEVIATION_SECONDS;
      changed = true;
    }
  }
  for (const clock of db.clocks) {
    const adjustments = db.adjustments
      .filter((item) => item.clockId === clock.id)
      .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
    adjustments.forEach((adjustment, index) => {
      const exists = db.retestTasks.some((task) => task.adjustmentId === adjustment.id);
      if (exists) return;
      const retest = db.retests
        .filter((item) => item.adjustmentId === adjustment.id)
        .sort((a, b) => toTime(a.testedAt) - toTime(b.testedAt))[0] || null;
      const isLast = index === adjustments.length - 1;
      const task = {
        id: makeId("task"),
        clockId: clock.id,
        adjustmentId: adjustment.id,
        status: retest ? "completed" : isLast ? "pending" : "voided",
        createdAt: adjustment.createdAt,
        dueAt: addDaysIso(adjustment.createdAt, DEFAULT_REVIEW_WINDOW_DAYS),
        completedAt: retest ? retest.testedAt : null,
        completedByRetestId: retest ? retest.id : null,
        voidedAt: !retest && !isLast ? adjustment.createdAt : null,
        voidReason: !retest && !isLast ? "结案前再次调校，原复测任务作废重排（历史数据迁移）" : null,
        supersededByTaskId: null
      };
      db.retestTasks.push(task);
      if (retest && retest.taskId === undefined) retest.taskId = task.id;
      changed = true;
    });
    // 作废留档的任务串上后继任务，保证单表可追溯
    const tasks = db.retestTasks
      .filter((task) => task.clockId === clock.id)
      .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
    tasks.forEach((task, index) => {
      if (task.status === "voided" && !task.supersededByTaskId) {
        const next = tasks[index + 1];
        if (next) {
          task.supersededByTaskId = next.id;
          changed = true;
        }
      }
    });
  }
  return changed;
}

// 写操作串行化：同一钟表同一请求并发提交时，后者读到前者落库的结果
let queue = Promise.resolve();
function withLock(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData(), null, 2));
  }
}

async function readRaw() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

async function read() {
  const db = await readRaw();
  migrate(db);
  return db;
}

// 启动时迁移并落库，保证刷新/重启后状态一致
async function init() {
  await withLock(async () => {
    const db = await readRaw();
    if (migrate(db)) await writeDb(db);
  });
}

// 读-改-写整体入锁；mutator 抛错时不落库
async function update(mutator) {
  return withLock(async () => {
    const db = await readRaw();
    migrate(db);
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
}

module.exports = { DB_FILE, ensureDb, read, init, update };
