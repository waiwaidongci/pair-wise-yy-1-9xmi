/**
 * 记录持久化片段：只负责 db.json 的读写、结构迁移、写入串行化与 ID 生成。
 * 不承载任何业务状态判定（合格/逾期/失效一律由 state.js 现算）。
 */
const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const SCHEMA_VERSION = 2;
const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;

const demoNow = "2026-06-16T00:00:00.000Z";

const initialData = {
  schemaVersion: SCHEMA_VERSION,
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      allowedDeviationSeconds: 10,
      specVersion: 1,
      note: "怀表机芯，走时偏快",
      createdAt: demoNow
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: demoNow
    }
  ],
  retestTasks: [
    {
      id: "retestTask_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      dueAt: "2026-06-23T00:00:00.000Z",
      status: "completed",
      retestId: "retest_demo",
      createdAt: demoNow,
      completedAt: demoNow
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      taskId: "retestTask_demo",
      testedAt: demoNow,
      dailyRateSeconds: 31,
      amplitude: 248,
      note: "仍偏快，振幅尚可",
      specSnapshot: {
        targetDailyRateSeconds: 20,
        allowedDeviationSeconds: 10,
        specVersion: 1
      }
    }
  ],
  specChanges: [],
  idempotencies: []
};

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/** 旧数据补齐到当前结构：新增复测任务/规格变更/幂等留档，并为历史复测补规格快照。返回是否有变更 */
function migrate(db) {
  let changed = false;
  if (db.schemaVersion === SCHEMA_VERSION) return false;

  for (const coll of ["retestTasks", "specChanges", "idempotencies"]) {
    if (!Array.isArray(db[coll])) {
      db[coll] = [];
      changed = true;
    }
  }

  for (const clock of db.clocks || []) {
    if (clock.allowedDeviationSeconds === undefined) {
      clock.allowedDeviationSeconds = 10;
      changed = true;
    }
    if (clock.specVersion === undefined) {
      clock.specVersion = 1;
      changed = true;
    }
  }

  const sortTime = (a, b) => new Date(a.createdAt || a.testedAt) - new Date(b.createdAt || b.testedAt);

  for (const adjustment of db.adjustments || []) {
    const exists = db.retestTasks.some((task) => task.adjustmentId === adjustment.id);
    if (exists) continue;
    const linked = db.retests
      .filter((retest) => retest.adjustmentId === adjustment.id)
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt));
    const base = new Date(adjustment.createdAt).getTime();
    const dueAt = new Date(base + 7 * 24 * 60 * 60 * 1000).toISOString();
    if (linked.length) {
      const retest = linked[0];
      db.retestTasks.push({
        id: makeId("retestTask"),
        clockId: adjustment.clockId,
        adjustmentId: adjustment.id,
        dueAt,
        status: "completed",
        retestId: retest.id,
        createdAt: adjustment.createdAt,
        completedAt: retest.testedAt
      });
      retest.taskId = db.retestTasks[db.retestTasks.length - 1].id;
    } else {
      db.retestTasks.push({
        id: makeId("retestTask"),
        clockId: adjustment.clockId,
        adjustmentId: adjustment.id,
        dueAt,
        status: "pending",
        createdAt: adjustment.createdAt
      });
    }
    changed = true;
  }

  for (const retest of db.retests || []) {
    if (!retest.specSnapshot) {
      const clock = (db.clocks || []).find((item) => item.id === retest.clockId);
      retest.specSnapshot = clock
        ? {
            targetDailyRateSeconds: clock.targetDailyRateSeconds,
            allowedDeviationSeconds: clock.allowedDeviationSeconds,
            specVersion: clock.specVersion
          }
        : { targetDailyRateSeconds: 30, allowedDeviationSeconds: 10, specVersion: 1 };
      changed = true;
    }
    if (!retest.taskId) {
      const task = db.retestTasks
        .filter((item) => item.adjustmentId === retest.adjustmentId)
        .sort(sortTime)
        .at(-1);
      if (task) retest.taskId = task.id;
      changed = true;
    }
  }

  db.schemaVersion = SCHEMA_VERSION;
  changed = true;
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await persist(initialData);
  }
}

async function loadDb() {
  await ensureDb();
  const raw = JSON.parse(await readFile(DB_FILE, "utf8"));
  const changed = migrate(raw);
  if (changed) await persist(raw);
  return raw;
}

/** GET 类请求直接取最新落盘数据，保证刷新/重启后状态一致 */
async function readDb() {
  return loadDb();
}

let writeSeq = 0;
async function persist(data) {
  const tmp = `${DB_FILE}.${process.pid}.${++writeSeq}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, DB_FILE);
}

/**
 * 全局串行事务：同一时刻只有一个读-改-写在途。
 * 同一钟表的并发调校因此天然排队，幂等去重在事务内判定，只可能成功一次。
 */
let txTail = Promise.resolve();
function transact(mutator) {
  const run = txTail.then(async () => {
    const db = await loadDb();
    const result = await mutator(db);
    await persist(db);
    return result;
  });
  txTail = run.catch(() => {});
  return run;
}

function idempotencyHit(db, clockId, key, explicit) {
  const now = Date.now();
  return (db.idempotencies || []).find((item) => {
    if (item.clockId !== clockId || item.scope !== "adjustment" || item.key !== key) return false;
    if (explicit) return true;
    return now - new Date(item.createdAt).getTime() <= IDEMPOTENCY_WINDOW_MS;
  });
}

function saveIdempotency(db, { clockId, key, response }) {
  db.idempotencies.push({
    id: makeId("idem"),
    clockId,
    scope: "adjustment",
    key,
    response,
    createdAt: new Date().toISOString()
  });
}

module.exports = {
  DB_FILE,
  makeId,
  readDb,
  transact,
  idempotencyHit,
  saveIdempotency
};
