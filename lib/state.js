/**
 * 状态计算片段：全部为纯函数，只依据落盘记录推导，不写任何数据。
 * 刷新页面、重启服务后状态一致，调整目标值/允许范围后所有结论自动重判。
 */

const byTimeDesc = (a, b, field) => new Date(b[field]) - new Date(a[field]);

function currentSpec(clock) {
  return {
    targetDailyRateSeconds: Number(clock.targetDailyRateSeconds),
    allowedDeviationSeconds: Number(clock.allowedDeviationSeconds ?? 10),
    specVersion: clock.specVersion ?? 1
  };
}

/** 复测结果对某套规格是否合格：日差与目标值之差不得超出允许范围，任何接口都不得人工推翻 */
function rateWithinSpec(dailyRateSeconds, spec) {
  return Math.abs(Number(dailyRateSeconds) - Number(spec.targetDailyRateSeconds))
    <= Number(spec.allowedDeviationSeconds);
}

function tasksOf(db, clockId) {
  return db.retestTasks
    .filter((task) => task.clockId === clockId)
    .slice()
    .sort((a, b) => byTimeDesc(a, b, "createdAt"));
}

function latestTask(db, clockId) {
  return tasksOf(db, clockId)[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .slice()
    .sort((a, b) => byTimeDesc(a, b, "createdAt"))[0] || null;
}

/** 当前待复测任务（含逾期未复测） */
function openTask(db, clockId) {
  const task = latestTask(db, clockId);
  return task && task.status === "pending" ? task : null;
}

function retestView(db, retest) {
  const clock = db.clocks.find((item) => item.id === retest.clockId);
  const spec = clock ? currentSpec(clock) : retest.specSnapshot;
  const snapshot = retest.specSnapshot || spec;
  const stale = snapshot.specVersion !== spec.specVersion;
  return {
    ...retest,
    // 合格与否永远按当前目标值与允许范围重算，不采信任何历史标记或请求入参
    qualified: rateWithinSpec(retest.dailyRateSeconds, spec),
    qualifiedAgainstRecordedSpec: rateWithinSpec(retest.dailyRateSeconds, snapshot),
    specStale: stale,
    recordedSpec: snapshot,
    deviationFromTarget: Number((retest.dailyRateSeconds - spec.targetDailyRateSeconds).toFixed(2))
  };
}

function taskView(db, task, nowIso) {
  const adjustment = db.adjustments.find((item) => item.id === task.adjustmentId) || null;
  const retest = db.retests.find((item) => item.id === task.retestId) || null;
  const overdue = task.status === "pending" && new Date(task.dueAt).getTime() < new Date(nowIso).getTime();
  return {
    ...task,
    overdue,
    adjustment,
    retest: retest ? retestView(db, retest) : null
  };
}

/** 单钟表完整追溯：调校、任务（含作废留档）、复测、规格变更，一张聚合视图 */
function clockHistory(db, clock, nowIso = new Date().toISOString()) {
  const adjustments = db.adjustments
    .filter((item) => item.clockId === clock.id)
    .slice()
    .sort((a, b) => byTimeDesc(a, b, "createdAt"));
  const tasks = tasksOf(db, clock.id).map((task) => taskView(db, task, nowIso));
  const retests = db.retests
    .filter((item) => item.clockId === clock.id)
    .slice()
    .sort((a, b) => byTimeDesc(a, b, "testedAt"))
    .map((retest) => retestView(db, retest));
  const specChanges = (db.specChanges || [])
    .filter((item) => item.clockId === clock.id)
    .slice()
    .sort((a, b) => byTimeDesc(a, b, "changedAt"));
  return { adjustments, tasks, retests, specChanges };
}

/**
 * 钟表汇总状态。
 * - caseStatus: closed（已复测取数结案）/ awaiting-retest（待复测，含逾期）/ no-adjustment
 * - deliveryQualified: 交付合格，要求最新复测按当前规格合格；规格变更使旧结论失效时自动变 false 重判
 */
function clockSummary(db, clock, nowIso = new Date().toISOString()) {
  const adjustment = latestAdjustment(db, clock.id);
  const task = latestTask(db, clock.id);
  const history = clockHistory(db, clock, nowIso);
  const latestRetest = history.retests[0] || null;

  let caseStatus = "no-adjustment";
  if (task && task.status === "completed") caseStatus = "closed";
  else if (task && task.status === "pending") caseStatus = "awaiting-retest";

  const deliveryQualified = Boolean(
    task
      && task.status === "completed"
      && latestRetest
      && task.retestId === latestRetest.id
      && latestRetest.qualified
  );

  return {
    ...clock,
    ...currentSpec(clock),
    caseStatus,
    deliveryQualified,
    // qualified 为交付合格的简写，列表过滤沿用此字段，语义与交付一致
    qualified: deliveryQualified,
    latestAdjustment: adjustment,
    openRetestTask: task && task.status === "pending" ? taskView(db, task, nowIso) : null,
    latestRetest
  };
}

/** 逾期未复测列表：当前任务仍 pending 且已过 dueAt（已作废的任务不算逾期，仅留档） */
function overdueTasks(db, nowIso = new Date().toISOString()) {
  return db.clocks.flatMap((clock) => {
    const task = openTask(db, clock.id);
    if (!task) return [];
    const view = taskView(db, task, nowIso);
    if (!view.overdue) return [];
    return [{ clock: clockSummary(db, clock, nowIso), task: view }];
  });
}

module.exports = {
  currentSpec,
  rateWithinSpec,
  latestAdjustment,
  latestTask,
  openTask,
  retestView,
  taskView,
  clockHistory,
  clockSummary,
  overdueTasks
};
