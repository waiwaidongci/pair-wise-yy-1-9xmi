const DAY_MS = 24 * 60 * 60 * 1000;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function toTime(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function addDaysIso(iso, days) {
  return new Date(toTime(iso) + days * DAY_MS).toISOString();
}

module.exports = { DAY_MS, makeId, toTime, addDaysIso };
