const { toTime } = require("./util");

// 复测任务默认到期窗口：调校后 7 天内需完成复测取数
const DEFAULT_REVIEW_WINDOW_DAYS = 7;
// 允许范围默认值（秒/日）
const DEFAULT_ALLOWED_DEVIATION_SECONDS = 10;

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))[0] || null;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => toTime(b.testedAt) - toTime(a.testedAt))[0] || null;
}

function tasksOfClock(db, clockId) {
  return db.retestTasks
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => toTime(a.createdAt) - toTime(b.createdAt));
}

// 当前待复测任务（结案前唯一有效的取数入口）
function activeTask(db, clockId) {
  const pending = tasksOfClock(db, clockId).filter((task) => task.status === "pending");
  return pending[pending.length - 1] || null;
}

function retestOfTask(db, task) {
  if (!task) return null;
  return db.retests.find((item) => item.id === task.completedByRetestId)
    || db.retests.find((item) => item.taskId === task.id)
    || null;
}

function deviationSeconds(clock, retest) {
  return Number(retest.dailyRateSeconds) - Number(clock.targetDailyRateSeconds);
}

function allowedDeviation(clock) {
  return Number(clock.allowedDeviationSeconds ?? DEFAULT_ALLOWED_DEVIATION_SECONDS);
}

// 复测日差与目标日差的偏差是否在允许范围内
function withinAllowedRange(clock, retest) {
  return Math.abs(deviationSeconds(clock, retest)) <= allowedDeviation(clock);
}

// 交付合格判定：超出允许范围一律不得合格；被人工标记不合格的维持不合格
function retestQualified(clock, retest) {
  return withinAllowedRange(clock, retest) && !retest.forcedUnqualified;
}

// 复测结论按当前目标值/允许范围实时重判，历史记录本身不改写
function enrichRetest(clock, retest) {
  if (!retest) return null;
  return {
    ...retest,
    targetDailyRateSeconds: Number(clock.targetDailyRateSeconds),
    allowedDeviationSeconds: allowedDeviation(clock),
    deviationSeconds: deviationSeconds(clock, retest),
    withinAllowedRange: withinAllowedRange(clock, retest),
    qualified: retestQualified(clock, retest)
  };
}

function taskView(task, now = Date.now()) {
  if (!task) return null;
  return {
    ...task,
    overdue: task.status === "pending" && toTime(task.dueAt) < now
  };
}

function overdueTasks(db, now = Date.now()) {
  return db.retestTasks
    .filter((task) => task.status === "pending" && toTime(task.dueAt) < now)
    .sort((a, b) => toTime(a.dueAt) - toTime(b.dueAt));
}

// 钟表交付状态汇总：以最新复测任务为主线，结案与否、合格与否全部实时推导
function clockSummary(db, clock, now = Date.now()) {
  const adjustment = latestAdjustment(db, clock.id);
  const retest = latestRetest(db, clock.id);
  const tasks = tasksOfClock(db, clock.id);
  const active = [...tasks].reverse().find((task) => task.status === "pending") || null;
  const latestTask = tasks[tasks.length - 1] || null;

  let status;
  let statusLabel;
  let qualified = false;

  if (!latestTask) {
    status = adjustment ? "no_task" : "no_adjustment";
    statusLabel = adjustment ? "无复测任务" : "未调校";
    qualified = retest ? retestQualified(clock, retest) : false;
  } else if (latestTask.status === "pending") {
    const overdue = toTime(latestTask.dueAt) < now;
    status = overdue ? "overdue" : "pending_retest";
    statusLabel = overdue ? "逾期未复测" : "待复测";
  } else {
    const taskRetest = retestOfTask(db, latestTask);
    qualified = taskRetest ? retestQualified(clock, taskRetest) : false;
    status = qualified ? "closed_qualified" : "closed_unqualified";
    statusLabel = qualified ? "已结案·交付合格" : "已结案·交付不合格";
  }

  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: enrichRetest(clock, retest),
    activeTask: taskView(active, now),
    latestTask: taskView(latestTask, now),
    qualified,
    status,
    statusLabel
  };
}

module.exports = {
  DEFAULT_REVIEW_WINDOW_DAYS,
  DEFAULT_ALLOWED_DEVIATION_SECONDS,
  findClock,
  latestAdjustment,
  latestRetest,
  tasksOfClock,
  activeTask,
  retestOfTask,
  deviationSeconds,
  allowedDeviation,
  withinAllowedRange,
  retestQualified,
  enrichRetest,
  taskView,
  overdueTasks,
  clockSummary
};
