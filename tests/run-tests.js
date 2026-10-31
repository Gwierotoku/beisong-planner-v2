/* 核心逻辑单元测试（Node，无第三方依赖）
 * 运行：node tests/run-tests.js
 */
'use strict';

const path = require('path');

['core', 'review', 'duration', 'priority', 'budget', 'scheduler', 'forecast', 'model'].forEach(
  function (name) {
    require(path.join(__dirname, '..', 'js', name + '.js'));
  }
);

const BS = globalThis.BS;
const C = BS.Core;
const Review = BS.Review;
const Duration = BS.Duration;
const Priority = BS.Priority;
const Budget = BS.Budget;
const Scheduler = BS.Scheduler;
const Forecast = BS.Forecast;
const Model = BS.Model;

const today = C.todayStr();

let passed = 0;
let failed = 0;
let currentGroup = '';
const failures = [];

function group(name) {
  currentGroup = name;
  console.log('\n' + name);
}

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    failures.push({ group: currentGroup, name: name, error: err });
    console.log('  ✗ ' + name + ' —— ' + err.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error((message || '值不相等') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}

function near(actual, expected, tolerance, message) {
  if (Math.abs(Number(actual) - Number(expected)) > tolerance) {
    throw new Error(
      (message || '数值不接近') +
        '：期望约 ' +
        expected +
        '，实际 ' +
        actual +
        '（容差 ' +
        tolerance +
        '）'
    );
  }
}

let seq = 0;
let logSeq = 0;

function makeState(opts) {
  const options = opts || {};
  const state = Model.defaultState();
  state.subjects = (options.subjects || [
    { id: 's1', name: '数学', color: '#ddeada' },
    { id: 's2', name: '英语', color: '#d9e7f2' },
  ]).map(function (subject) {
    return {
      id: subject.id,
      name: subject.name,
      color: subject.color || '#ddeada',
      archived: !!subject.archived,
      createdAt: C.nowIso(),
    };
  });
  const subjectMinutes = options.subjectMinutes || { s1: 30, s2: 30 };
  state.budgets.weekly = {};
  ['1', '2', '3', '4', '5', '6', '7'].forEach(function (key) {
    const subjects = {};
    state.subjects.forEach(function (subject) {
      if (subjectMinutes[subject.id] != null) {
        subjects[subject.id] = subjectMinutes[subject.id];
      }
    });
    state.budgets.weekly[key] = {
      subjects: subjects,
      general: options.general == null ? 20 : options.general,
    };
  });
  if (options.settings) Object.assign(state.settings, options.settings);
  return state;
}

function addEntry(state, cfg) {
  const config = cfg || {};
  seq += 1;
  const entry = {
    id: config.id || 'e' + seq,
    name: config.name || '条目' + seq,
    subjectId: config.subjectId || 's1',
    importance: config.importance || 3,
    difficulty: config.difficulty || 3,
    firstDate: config.firstDate === undefined ? today : config.firstDate,
    firstMinutes: config.firstMinutes || 20,
    prepared: false,
    status: config.status || 'active',
    note: '',
    createdAt: config.createdAt || C.nowIso(),
  };
  state.entries.push(entry);
  if (config.learned !== false) {
    addLog(state, entry, {
      type: 'learn',
      round: 1,
      date: entry.firstDate,
      planned: entry.firstMinutes,
      actual: entry.firstMinutes,
      recall: 'normal',
    });
    (config.reviews || []).forEach(function (review) {
      addLog(state, entry, Object.assign({ type: 'review' }, review));
    });
  }
  return entry;
}

function addLog(state, entry, cfg) {
  logSeq += 1;
  const round = cfg.round || 1;
  const planned =
    cfg.planned == null ? C.round1(entry.firstMinutes / Math.sqrt(round)) : cfg.planned;
  state.logs.push({
    id: cfg.id || 'lg' + logSeq,
    entryId: entry.id,
    type: cfg.type || (round === 1 ? 'learn' : 'review'),
    round: round,
    date: cfg.date,
    at: cfg.date + 'T12:00:00.000Z',
    plannedMinutes: planned,
    actualMinutes: cfg.actual == null ? planned : cfg.actual,
    recall: cfg.recall || 'normal',
    difficulty: 3,
    needsRelearn: cfg.recall === 'fail',
    completed: true,
    note: '',
    dueDate: cfg.dueDate || cfg.date,
    scheduledDate: cfg.date,
    subjectBudgetMinutes: 0,
    generalBudgetMinutes: 0,
    firstDateBefore: null,
    partial: !!cfg.partial,
    legacy: !!cfg.legacy,
  });
}

function setBudget(state, date, subjects, general) {
  Budget.setOverride(state, date, subjects, general, 'manual');
}

function taskOf(state, entryId, date) {
  return Scheduler.collectTasks(state, date || today).find(function (task) {
    return task.entryId === entryId;
  });
}

/* ---------------- 日期工具 ---------------- */
group('日期工具');

test('闰年 2 月 28 日加一天', function () {
  eq(C.addDays('2024-02-28', 1), '2024-02-29');
});

test('闰年 2 月 29 日加一天跨月', function () {
  eq(C.addDays('2024-02-29', 1), '2024-03-01');
});

test('跨月日期差', function () {
  eq(C.diffDays('2024-02-28', '2024-03-01'), 2);
});

test('ISO 星期：周六为 6', function () {
  eq(C.isoWeekday('2026-10-31'), 6);
});

test('拒绝非法日期', function () {
  assert(!C.isValidYmd('2026-02-30'));
  assert(!C.isValidYmd('2026-13-01'));
  assert(C.isValidYmd('2024-02-29'));
});

test('时长格式化', function () {
  eq(C.fmtDuration(75), '1 小时 15 分');
  eq(C.fmtDuration(45), '45 分钟');
});

/* ---------------- 理论轮次 ---------------- */
group('理论轮次');

test('新的理论节奏：第 1、2、4、10 天', function () {
  eq(Review.theoryOffset(1), 0);
  eq(Review.theoryOffset(2), 1);
  eq(Review.theoryOffset(3), 3);
  eq(Review.theoryOffset(4), 9);
  eq(Review.theoryOffset(5), 19);
});

test('共 13 轮，最后一天约 1179 天', function () {
  eq(Review.MAX_ROUNDS, 13);
  eq(Review.theoryOffset(13), 1178);
});

test('长间隔压缩到 300 天以内', function () {
  const gaps = Review.THEORY_GAPS.slice(1);
  assert(
    gaps.every(function (gap) {
      return gap <= Review.MAX_INTERVAL_DAYS;
    }),
    '任何间隔都不应超过 300 天'
  );
  eq(Math.max.apply(null, gaps), 300);
});

test('相邻轮次间隔与 300 天上限', function () {
  eq(Review.theoryGap(2), 1);
  eq(Review.theoryGap(3), 2);
  eq(Review.theoryGap(4), 6);
  eq(Review.theoryGap(5), 10);
  eq(Review.theoryGap(6), 17);
  eq(Review.theoryGap(12), 300);
  eq(Review.theoryGap(13), 300);
});

test('延迟容忍随间隔增加：1 个月约 5 天', function () {
  eq(Review.graceDaysForInterval(7), 2);
  eq(Review.graceDaysForInterval(30), 5);
  eq(Review.graceDaysForInterval(100), 14);
  eq(Review.graceDaysForInterval(1), 2);
});

/* ---------------- 间隔调整 ---------------- */
group('间隔调整');

test('顺利时按基准间隔的 2 倍延长', function () {
  eq(Review.adjustInterval(7, 7, 7, 'easy'), 14);
  eq(Review.adjustInterval(10, 10, 10, 'easy'), 20);
});

test('困难时缩短间隔', function () {
  eq(Review.adjustInterval(10, 10, 10, 'hard'), 6);
});

test('间隔最长 300 天，最短 1 天', function () {
  eq(Review.adjustInterval(300, 300, 300, 'easy'), 300);
  eq(Review.adjustInterval(1, 1, 1, 'hard'), 1);
});

test('撤销复习记录后到期日回退', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -5),
    reviews: [{ round: 2, date: C.addDays(today, -4) }],
  });
  const before = Review.derive(entry, state.logs);
  eq(before.dueDate, C.addDays(today, -2));
  state.logs = state.logs.filter(function (log) {
    return !(log.entryId === entry.id && log.type === 'review');
  });
  const after = Review.derive(entry, state.logs);
  eq(after.dueDate, C.addDays(today, -4));
});

test('恢复任务使用原来的到期日，而不是推算到下一轮', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -20),
    firstMinutes: 20,
    reviews: [
      { round: 2, date: C.addDays(today, -15) },
      { round: 3, date: C.addDays(today, -10) },
      { round: 4, date: C.addDays(today, -5) },
    ],
  });
  const withoutPending = Review.derive(entry, state.logs);
  eq(withoutPending.dueDate, C.addDays(today, 5));

  entry.pendingTask = {
    type: 'review',
    round: 5,
    dueDate: today,
    theoryDueDate: today,
    intervalDays: 3,
    theoryIntervalDays: 3,
    scheduledDate: today,
    createdAt: C.nowIso(),
  };
  const restored = Review.derive(entry, state.logs);
  eq(restored.nextRound, 5);
  eq(restored.dueDate, today);
  eq(restored.finished, false);

  // 完成恢复的任务后，后续重新按当前间隔推算
  addLog(state, entry, {
    type: 'review',
    round: 5,
    date: today,
    planned: 10,
    actual: 10,
    recall: 'normal',
  });
  entry.pendingTask = null;
  const next = Review.derive(entry, state.logs);
  eq(next.nextRound, 6);
  eq(next.dueDate, C.addDays(today, 17));
});

test('连续按时完成时下一轮仍落在理论日期', function () {
  const firstDate = '2026-01-01';
  const state = makeState();
  const entry = addEntry(state, { firstDate: firstDate, firstMinutes: 10 });
  for (let round = 2; round <= 5; round++) {
    addLog(state, entry, {
      type: 'review',
      round: round,
      date: C.addDays(firstDate, Review.theoryOffset(round) - 1),
      planned: 10 / Math.sqrt(round),
      actual: 10 / Math.sqrt(round),
      recall: 'normal',
    });
  }
  const derived = Review.derive(entry, state.logs);
  eq(derived.nextRound, 6);
  eq(derived.dueDate, C.addDays(firstDate, Review.theoryOffset(6) - 1));
});

/* ---------------- 耗时估计 ---------------- */
group('耗时估计');

test('无历史时按初始难度修正', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: today,
    firstMinutes: 20,
    difficulty: 5,
    learned: false,
  });
  const derived = Review.derive(entry, state.logs);
  const estimate = Duration.estimateMinutes(entry, derived, state.logs);
  near(estimate.minutes, 24, 0.2);
});

test('实际比计划快时降低估计', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -3),
    firstMinutes: 20,
    reviews: [{ round: 2, date: C.addDays(today, -2), planned: 14.1, actual: 7 }],
  });
  const derived = Review.derive(entry, state.logs);
  const estimate = Duration.estimateMinutes(entry, derived, state.logs);
  near(estimate.theoryMinutes, 20 / Math.sqrt(3), 0.1);
  assert(estimate.minutes < estimate.theoryMinutes, '估计值应低于理论值');
});

test('单次异常不会完全改变估计', function () {
  const state = makeState();
  const reviews = [];
  for (let i = 0; i < 8; i++) {
    reviews.push({
      round: i + 2,
      date: C.addDays(today, -20 + i),
      planned: 10,
      actual: 100,
      recall: 'hard',
    });
  }
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -30),
    firstMinutes: 10,
    reviews: reviews,
  });
  const derived = Review.derive(entry, state.logs);
  const estimate = Duration.estimateMinutes(entry, derived, state.logs);
  assert(
    estimate.minutes <= entry.firstMinutes * 2 + 0.1,
    '估计值不应超过首次用时的 2 倍'
  );
  assert(
    estimate.minutes >= entry.firstMinutes / 4 - 0.1,
    '估计值不应低于首次用时的 1/4'
  );
});

test('压缩安排的记录不参与耗时修正', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -3),
    firstMinutes: 20,
    reviews: [
      {
        round: 2,
        date: C.addDays(today, -2),
        planned: 14.1,
        actual: 4,
        partial: true,
      },
    ],
  });
  const derived = Review.derive(entry, state.logs);
  const estimate = Duration.estimateMinutes(entry, derived, state.logs);
  near(estimate.minutes, estimate.theoryMinutes, 0.1);
});

test('上次回忆很好时建议用时降到 1/4 下限，很差时明显增加', function () {
  const state = makeState();
  const firstDate = '2024-01-01';
  const entry = addEntry(state, { firstDate: firstDate, firstMinutes: 20 });
  let date = firstDate;
  for (let round = 2; round <= 12; round++) {
    date = C.addDays(date, Review.theoryGap(round));
    addLog(state, entry, {
      type: 'review',
      round: round,
      date: date,
      planned: 20 / Math.sqrt(round),
      actual: 20 / Math.sqrt(round),
      recall: 'normal',
    });
  }
  const lastReview = state.logs.find(function (log) {
    return log.entryId === entry.id && log.round === 12;
  });

  lastReview.recall = 'easy';
  let derived = Review.derive(entry, state.logs);
  let estimate = Duration.estimateMinutes(entry, derived, state.logs);
  near(estimate.minutes, 5, 0.05, '很好时应落到首次用时 20 分钟的 1/4');

  lastReview.recall = 'fail';
  derived = Review.derive(entry, state.logs);
  estimate = Duration.estimateMinutes(entry, derived, state.logs);
  assert(estimate.minutes >= 10, '很差时应明显增加，实际 ' + estimate.minutes);
  assert(estimate.minutes <= 20, '增加后不应超过首次用时的 2 倍上限');
});

test('长间隔任务可以比短间隔多推迟几天', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 0 }, general: 0 });
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -10),
    firstMinutes: 20,
    subjectId: 's1',
  });
  entry.pendingTask = {
    type: 'review',
    round: 2,
    dueDate: C.addDays(today, -4),
    theoryDueDate: C.addDays(today, -4),
    intervalDays: 30,
    theoryIntervalDays: 30,
    estimateMinutes: 10,
    scheduledDate: C.addDays(today, -4),
    createdAt: C.nowIso(),
  };
  let plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].forced, false, '间隔 30 天、延期 4 天不应强制');

  entry.pendingTask.dueDate = C.addDays(today, -5);
  plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].forced, true, '延期达到可延迟 5 天时应强制');
});

/* ---------------- 预算解析 ---------------- */
group('预算与标签');

test('日期覆盖优先于每周默认', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 20 }, general: 20 });
  setBudget(state, today, { s1: 5, s2: 5 }, 0);
  const resolved = Budget.resolve(state, today);
  eq(resolved.source, 'override');
  eq(resolved.subjects.s1, 5);
  eq(resolved.general, 0);
  eq(resolved.total, 10);
});

test('没有覆盖时使用每周默认', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 20 }, general: 20 });
  const resolved = Budget.resolve(state, today);
  eq(resolved.source, 'weekly');
  eq(resolved.subjects.s1, 30);
  eq(resolved.total, 70);
});

test('应用标签是复制预算，不是实时引用', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 5, s2: 5 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  const date = C.addDays(today, 5);
  Budget.applyLabel(state, date, 'lb1');
  eq(Budget.resolve(state, date).subjects.s1, 5);
  state.budgets.labels[0].subjects.s1 = 99;
  eq(Budget.resolve(state, date).subjects.s1, 5, '修改标签模板不应影响已应用日期');
});

test('手动修改后的日期不会随标签模板同步', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 5, s2: 5 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  const date = C.addDays(today, 5);
  Budget.applyLabel(state, date, 'lb1');
  Budget.setOverride(state, date, { s1: 20, s2: 5 }, 0, 'manual');
  const count = Budget.syncLabelToDates(state, state.budgets.labels[0]);
  eq(count, 0);
  eq(Budget.resolve(state, date).subjects.s1, 20);
});

test('删除标签后已设置日期预算仍然保留', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 5, s2: 5 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  const date = C.addDays(today, 5);
  Budget.applyLabel(state, date, 'lb1');
  const result = Budget.removeLabel(state, 'lb1');
  eq(result.detached, 1);
  eq(Budget.resolve(state, date).subjects.s1, 5);
  eq(Budget.resolve(state, date).source, 'override');
});

test('同步标签模板会更新未手动修改的日期', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 5, s2: 5 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  const date = C.addDays(today, 6);
  Budget.applyLabel(state, date, 'lb1');
  state.budgets.labels[0].subjects.s1 = 8;
  const count = Budget.syncLabelToDates(state, state.budgets.labels[0]);
  eq(count, 1);
  eq(Budget.resolve(state, date).subjects.s1, 8);
  eq(Budget.resolve(state, date).origin, 'label');
});

test('修改每周默认预算不会覆盖已有日期覆盖', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 20 }, general: 20 });
  const date = C.addDays(today, 2);
  setBudget(state, date, { s1: 5, s2: 5 }, 0);
  Budget.WEEKDAY_KEYS.forEach(function (key) {
    state.budgets.weekly[key].subjects.s1 = 999;
    state.budgets.weekly[key].general = 999;
  });
  const resolved = Budget.resolve(state, date);
  eq(resolved.source, 'override');
  eq(resolved.subjects.s1, 5);
  eq(resolved.general, 0);
});

test('实际用量先专属后通用，并识别超支', function () {
  const state = makeState({ subjectMinutes: { s1: 10, s2: 0 }, general: 5 });
  const entry = addEntry(state, { firstDate: today, firstMinutes: 10, learned: false });
  addLog(state, entry, { type: 'learn', round: 1, date: today, planned: 8, actual: 8, recall: 'normal' });
  addLog(state, entry, { type: 'review', round: 2, date: today, planned: 10, actual: 10, recall: 'normal' });
  const budget = Budget.resolve(state, today);
  const usage = Budget.dayUsage(state, today, budget);
  eq(usage.actualTotal, 18);
  eq(usage.bySubject.s1.direct, 10);
  eq(usage.bySubject.s1.general, 8);
  eq(usage.generalUsed, 8);
  eq(usage.generalOverspend, 3);
  eq(usage.overspend, 3);
});

test('通用预算只扣一次，不能被重复占用', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 20 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, subjectId: 's1', name: 'A' });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, subjectId: 's2', name: 'B' });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, subjectId: 's1', name: 'C' });
  const plan = Scheduler.scheduleDay(state, today);
  const generalUsed = plan.assignments.reduce(function (sum, row) {
    return sum + row.allocation.general;
  }, 0);
  assert(generalUsed <= 20 + 0.001, '通用预算合计不应超过总量，实际 ' + generalUsed);
  eq(plan.assignments.length, 2);
  eq(plan.unscheduled.length, 1);
});

test('休息日/考试日默认关闭强制安排，普通日默认开启', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'rest', name: '休息日', color: '#e9e4e0', kind: 'rest', subjects: { s1: 0 }, general: 0, note: '', createdAt: C.nowIso() },
    { id: 'exam', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 5 }, general: 0, note: '', createdAt: C.nowIso() },
    { id: 'normal', name: '普通日', color: '#ddeada', kind: 'normal', subjects: { s1: 10 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  eq(Budget.defaultAllowForced('rest'), false);
  eq(Budget.defaultAllowForced('exam'), false);
  eq(Budget.defaultAllowForced('normal'), true);
});

test('旧标签没有 allowForced 字段时按类型补默认值', function () {
  const raw = {
    version: 2,
    subjects: [{ id: 's1', name: '数学', color: '#ddeada' }],
    entries: [],
    logs: [],
    budgets: {
      labels: [
        { id: 'rest', name: '休息日', kind: 'rest', subjects: {}, general: 0 },
        { id: 'normal', name: '普通日', kind: 'normal', subjects: {}, general: 0 },
      ],
      weekly: {},
      overrides: {},
    },
  };
  const state = Model.normalizeState(raw);
  const rest = state.budgets.labels.find(function (label) { return label.id === 'rest'; });
  const normal = state.budgets.labels.find(function (label) { return label.id === 'normal'; });
  eq(rest.allowForced, false);
  eq(normal.allowForced, true);
});

/* ---------------- 动态调度 ---------------- */
group('动态调度');

test('预算充足时到期任务全部安排', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 20 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, subjectId: 's1', name: 'A' });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, subjectId: 's2', name: 'B' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.dueCount, 2);
  eq(plan.assignments.length, 2);
  eq(plan.unscheduled.length, 0);
});

test('专属预算不足时借用通用预算', function () {
  const state = makeState({ subjectMinutes: { s1: 4, s2: 0 }, general: 6 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's1' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  const row = plan.assignments[0];
  near(row.allocation.subject, 4, 0.05);
  near(row.allocation.general, 6, 0.05);
  assert(row.partial, '应标记为压缩安排');
});

test('专属预算剩余不会转移给其他科目', function () {
  const state = makeState({ subjectMinutes: { s1: 100, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, subjectId: 's2', name: 'B' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 0);
  eq(plan.unscheduled.length, 1);
});

test('超过可延迟天数后强制安排，但强制部分有上限', function () {
  const state = makeState({ subjectMinutes: { s1: 20, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -4), firstMinutes: 40, subjectId: 's1' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].forced, true);
  eq(plan.assignments[0].partial, true, '超过预算的部分应压缩');
  assert(plan.assignments[0].deferralDays >= 2, '测试前提：已超过可延迟天数');
  near(plan.summary.forcedCapMinutes, 25, 0.1, '预算 20 时强制上限为 25');
  near(plan.summary.plannedTotal, 25, 0.1);
  assert(plan.summary.overflowMinutes > 0, '应暴露超预算');
  assert(
    plan.warnings.some(function (warning) {
      return warning.text.indexOf('强制安排') >= 0;
    }),
    '应给出强制安排警告'
  );
});

test('预算为 0 时不再强制安排', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -4), firstMinutes: 40, subjectId: 's1' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 0);
  eq(plan.summary.forcedBlockedCount, 1);
  eq(plan.unscheduled.length, 1);
});

test('休息日关闭强制安排时，逾期任务进入未安排', function () {
  const state = makeState({ subjectMinutes: { s1: 20, s2: 0 }, general: 0 });
  state.budgets.labels = [
    {
      id: 'lb_rest',
      name: '休息日',
      color: '#e9e4e0',
      kind: 'rest',
      subjects: { s1: 20, s2: 0 },
      general: 0,
      allowForced: false,
      note: '',
      createdAt: C.nowIso(),
    },
  ];
  Budget.applyLabel(state, today, 'lb_rest');
  addEntry(state, { firstDate: C.addDays(today, -4), firstMinutes: 40, subjectId: 's1' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.budget.allowForced, false);
  eq(plan.assignments.length, 0);
  eq(plan.summary.forcedBlockedCount, 1);
  assert(
    plan.unscheduled[0].reason.indexOf('休息日') >= 0,
    '未安排原因应说明休息日关闭强制'
  );
});

test('延期一天且无预算时进入未安排', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -2), firstMinutes: 20 });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 0);
  eq(plan.unscheduled.length, 1);
  assert(plan.unscheduled[0].reason.indexOf('逾期') >= 0, '应说明逾期原因');
});

test('任务不足 3 分钟预算时不安排', function () {
  const state = makeState({ subjectMinutes: { s1: 2, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20 });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 0);
  eq(plan.unscheduled.length, 1);
});

test('预计用时不足 3 分钟的任务只要预算够就应安排', function () {
  const state = makeState({ subjectMinutes: { s1: 10, s2: 0 }, general: 0 });
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -1),
    firstMinutes: 4,
    subjectId: 's1',
  });
  const task = taskOf(state, entry.id);
  assert(task.estimateMinutes < 3, '测试前提：预计用时小于 3 分钟');
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].partial, false);
  near(plan.assignments[0].plannedMinutes, task.estimateMinutes, 0.05);
});

test('预算刚好等于短任务预计用时时也能安排', function () {
  const state = makeState({ subjectMinutes: { s1: 2.8, s2: 0 }, general: 0 });
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -1),
    firstMinutes: 4,
    subjectId: 's1',
  });
  const task = taskOf(state, entry.id);
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  near(plan.assignments[0].plannedMinutes, task.estimateMinutes, 0.05);
});

test('科目预算耗尽时短任务仍可用通用预算安排', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 10 });
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -1),
    firstMinutes: 4,
    subjectId: 's1',
  });
  const task = taskOf(state, entry.id);
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  near(plan.assignments[0].allocation.subject, 0, 0.05);
  near(plan.assignments[0].allocation.general, task.estimateMinutes, 0.05);
  eq(plan.unscheduled.length, 0);
});

test('短新内容也能用不足 5 分钟的剩余预算启动', function () {
  const state = makeState({ subjectMinutes: { s1: 3.5, s2: 0 }, general: 0 });
  addEntry(state, {
    firstDate: null,
    firstMinutes: 3.5,
    subjectId: 's1',
    name: '短新内容',
    learned: false,
  });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.newContentCount, 1);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].isNewContent, true);
});

test('重复计算不会产生重复任务', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 20 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14 });
  const plan1 = Scheduler.scheduleDay(state, today);
  const plan2 = Scheduler.scheduleDay(state, today);
  eq(
    plan1.assignments.map(function (row) { return row.key; }).join(','),
    plan2.assignments.map(function (row) { return row.key; }).join(',')
  );
  eq(state.logs.length, 1);
});

test('暂停的条目不会进入调度', function () {
  const state = makeState();
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, status: 'paused' });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.dueCount, 0);
  eq(plan.assignments.length, 0);
});

test('完成当前任务后不再重复安排', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 20 });
  const entry = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14 });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.assignments.length, 1);
  addLog(state, entry, { type: 'review', round: 2, date: today, planned: 9.9, actual: 9.9 });
  const plan2 = Scheduler.scheduleDay(state, today);
  eq(plan2.assignments.length, 0);
  eq(plan2.usage.actualTotal, 9.9);
});

test('回忆失败后安排第二天的补救学习', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 20 });
  const entry = addEntry(state, { firstDate: C.addDays(today, -3), firstMinutes: 20 });
  addLog(state, entry, {
    type: 'review',
    round: 2,
    date: C.addDays(today, -1),
    planned: 14.1,
    actual: 16,
    recall: 'fail',
  });
  const task = taskOf(state, entry.id);
  eq(task.type, 'remedial');
  eq(task.dueDate, today);
  const derived = Review.derive(entry, state.logs);
  eq(derived.nextRound, 2, '失败不推进轮次，下一轮仍是失败的第 2 轮');
  eq(derived.remedialRound, 2);
  eq(derived.retryRound, 2);
  eq(derived.round, 1);
  eq(derived.completedReviews, 0);
});

test('补救成功后第二天重做同一轮，成功后才推进', function () {
  const state = makeState();
  const entry = addEntry(state, { firstDate: C.addDays(today, -3), firstMinutes: 20 });
  addLog(state, entry, {
    type: 'review',
    round: 2,
    date: C.addDays(today, -1),
    planned: 14.1,
    actual: 16,
    recall: 'fail',
  });
  addLog(state, entry, {
    type: 'remedial',
    round: 2,
    date: today,
    planned: 14.1,
    actual: 12,
    recall: 'normal',
  });
  let derived = Review.derive(entry, state.logs);
  eq(derived.nextType, 'review');
  eq(derived.nextRound, 2);
  eq(derived.retryRound, 2);
  eq(derived.dueDate, C.addDays(today, 1));
  eq(derived.intervalDays, 1);

  addLog(state, entry, {
    type: 'review',
    round: 2,
    date: C.addDays(today, 1),
    planned: 14.1,
    actual: 12,
    recall: 'normal',
  });
  derived = Review.derive(entry, state.logs);
  eq(derived.round, 2);
  eq(derived.nextRound, 3);
  eq(derived.completedReviews, 1);
});

test('同一轮连续失败 3 次后回退一轮', function () {
  const state = makeState();
  const entry = addEntry(state, {
    firstDate: C.addDays(today, -20),
    firstMinutes: 20,
    reviews: [
      { round: 2, date: C.addDays(today, -18) },
      { round: 3, date: C.addDays(today, -16) },
      { round: 4, date: C.addDays(today, -13) },
      { round: 5, date: C.addDays(today, -8) },
    ],
  });
  addLog(state, entry, {
    type: 'review',
    round: 6,
    date: C.addDays(today, -5),
    planned: 8,
    actual: 12,
    recall: 'fail',
  });
  addLog(state, entry, {
    type: 'remedial',
    round: 6,
    date: C.addDays(today, -4),
    planned: 8,
    actual: 12,
    recall: 'fail',
  });
  addLog(state, entry, {
    type: 'remedial',
    round: 6,
    date: C.addDays(today, -3),
    planned: 8,
    actual: 10,
    recall: 'normal',
  });
  addLog(state, entry, {
    type: 'review',
    round: 6,
    date: C.addDays(today, -2),
    planned: 8,
    actual: 12,
    recall: 'fail',
  });
  const derived = Review.derive(entry, state.logs);
  eq(derived.round, 4, '连续失败 3 次后应回退一轮');
  eq(derived.retryRound, 5);
  eq(derived.remedialRound, 6, '补救任务仍标记失败的第 6 轮');
  eq(derived.failureStreak, 0);
});

test('部分完成记录不推进轮次', function () {
  const state = makeState();
  const entry = addEntry(state, { firstDate: C.addDays(today, -3), firstMinutes: 20 });
  addLog(state, entry, {
    type: 'review',
    round: 2,
    date: C.addDays(today, -1),
    planned: 20,
    actual: 5,
    recall: 'fail',
    partial: true,
  });
  const derived = Review.derive(entry, state.logs);
  eq(derived.round, 1);
  eq(derived.nextRound, 2);
  eq(derived.completedReviews, 0);
  eq(derived.lapses, 0, '部分完成不应记录为一次失败');
  eq(derived.dueDate, C.addDays(today, -2));
});

test('补救仍失败时继续安排补救', function () {
  const state = makeState();
  const entry = addEntry(state, { firstDate: C.addDays(today, -4), firstMinutes: 20 });
  addLog(state, entry, {
    type: 'review',
    round: 2,
    date: C.addDays(today, -2),
    planned: 14.1,
    actual: 16,
    recall: 'fail',
  });
  addLog(state, entry, {
    type: 'remedial',
    round: 2,
    date: C.addDays(today, -1),
    planned: 14.1,
    actual: 12,
    recall: 'fail',
  });
  const derived = Review.derive(entry, state.logs);
  eq(derived.nextType, 'remedial');
  eq(derived.dueDate, today);
  eq(derived.lapses, 2);
});

test('当天实际用量会占用剩余预算', function () {
  const state = makeState({ subjectMinutes: { s1: 12, s2: 0 }, general: 0 });
  const entryA = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, name: 'A' });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, name: 'B' });
  const plan1 = Scheduler.scheduleDay(state, today);
  eq(plan1.assignments.length, 1);
  eq(plan1.assignments[0].entryId, entryA.id);
  addLog(state, entryA, { type: 'review', round: 2, date: today, planned: 9.9, actual: 6 });
  const plan2 = Scheduler.scheduleDay(state, today);
  eq(plan2.assignments.length, 1);
  near(plan2.assignments[0].plannedMinutes, 6, 0.05);
  assert(plan2.assignments[0].partial, '预算减少后应压缩安排');
});

test('到期任务安排不下时不启动新内容', function () {
  const state = makeState({ subjectMinutes: { s1: 2, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's1', name: 'A' });
  addEntry(state, { firstDate: null, firstMinutes: 20, subjectId: 's1', name: '新内容', learned: false });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.unscheduled.length, 1);
  eq(plan.summary.newContentCount, 0);
  assert(plan.newContentDeferred.length >= 1, '应说明新内容为何没安排');
  assert(
    plan.newContentDeferred[0].reason.indexOf('到期任务') >= 0,
    '新内容延后原因应提到到期任务'
  );
});

test('到期任务都安排完后使用剩余预算启动新内容', function () {
  const state = makeState({ subjectMinutes: { s1: 40, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 14, subjectId: 's1', name: 'A' });
  addEntry(state, { firstDate: null, firstMinutes: 20, subjectId: 's1', name: '新内容', learned: false });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.unscheduled.length, 0);
  eq(plan.summary.newContentCount, 1);
  const row = plan.assignments.find(function (item) {
    return item.isNewContent;
  });
  assert(row, '应有新内容被安排');
  eq(row.plannedMinutes, 20);
});

test('新内容每日上限生效', function () {
  const state = makeState({ subjectMinutes: { s1: 200, s2: 0 }, general: 0 });
  state.settings.newContentDailyLimit = 1;
  addEntry(state, { firstDate: null, firstMinutes: 10, subjectId: 's1', name: '新1', learned: false });
  addEntry(state, { firstDate: null, firstMinutes: 10, subjectId: 's1', name: '新2', learned: false });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.newContentCount, 1);
  assert(plan.newContentDeferred.some(function (row) {
    return row.reason.indexOf('上限') >= 0;
  }), '应有达到上限的原因');
});

test('到期任务安排不下时，只冻结本科目的新内容', function () {
  const state = makeState({ subjectMinutes: { s1: 2, s2: 30 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's1', name: '数学到期' });
  addEntry(state, { firstDate: null, firstMinutes: 20, subjectId: 's1', name: '数学新内容', learned: false });
  addEntry(state, { firstDate: null, firstMinutes: 20, subjectId: 's2', name: '英语新内容', learned: false });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.unscheduled.length, 1);
  eq(plan.summary.newContentCount, 1, '英语新内容不应被数学的到期任务冻结');
  const row = plan.assignments.find(function (item) {
    return item.isNewContent;
  });
  eq(row.subjectId, 's2');
  assert(
    plan.newContentDeferred.some(function (item) {
      return item.subjectId === 's1' && item.reason.indexOf('本科目') >= 0;
    }),
    '数学新内容应说明本科目还有到期任务'
  );
});

test('剩余预算拆分通用余额与分科余额', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 10 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 10, subjectId: 's1', name: 'A' });
  const plan = Scheduler.scheduleDay(state, today);
  assert(plan.summary.remainingGeneral >= 0, '应显示通用余额');
  assert(plan.summary.subjectLockedMinutes >= 0, '应显示分科余额');
  near(
    plan.summary.remainingGeneral,
    Math.max(0, 10 - plan.summary.plannedGeneral),
    0.1
  );
});

test('提前复习：困难内容在预算空闲时提前一天安排', function () {
  const state = makeState({ subjectMinutes: { s1: 50, s2: 0 }, general: 0 });
  addEntry(state, {
    firstDate: C.addDays(today, -7),
    firstMinutes: 20,
    subjectId: 's1',
    reviews: [
      { round: 2, date: C.addDays(today, -6), planned: 14, actual: 14, recall: 'normal' },
      { round: 3, date: C.addDays(today, -2), planned: 10, actual: 10, recall: 'hard' },
    ],
  });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.dueCount, 0);
  eq(plan.summary.earlyCount, 1);
  eq(plan.assignments.length, 1);
  eq(plan.assignments[0].early, true);
  eq(plan.assignments[0].earlyDays, 1);
  eq(plan.assignments[0].dueDate, C.addDays(today, 1));
});

test('提前复习可以关闭', function () {
  const state = makeState({ subjectMinutes: { s1: 50, s2: 0 }, general: 0 });
  state.settings.earlyReviewEnabled = false;
  addEntry(state, {
    firstDate: C.addDays(today, -7),
    firstMinutes: 20,
    subjectId: 's1',
    reviews: [
      { round: 2, date: C.addDays(today, -6), planned: 14, actual: 14, recall: 'normal' },
      { round: 3, date: C.addDays(today, -2), planned: 10, actual: 10, recall: 'hard' },
    ],
  });
  const plan = Scheduler.scheduleDay(state, today);
  eq(plan.summary.earlyCount, 0);
  eq(plan.assignments.length, 0);
});

/* ---------------- 优先级 ---------------- */
group('优先级');

test('延期越久优先级越高', function () {
  const state = makeState();
  const a = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, name: 'A' });
  const b = addEntry(state, { firstDate: C.addDays(today, -3), firstMinutes: 20, name: 'B' });
  const scoreA = Priority.scoreTask(taskOf(state, a.id), {}).score;
  const scoreB = Priority.scoreTask(taskOf(state, b.id), {}).score;
  assert(scoreB > scoreA, '延期 2 天应高于今天到期：' + scoreB + ' vs ' + scoreA);
});

test('重要程度影响优先级', function () {
  const state = makeState();
  const low = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, importance: 1, name: '低' });
  const high = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, importance: 5, name: '高' });
  const lowScore = Priority.scoreTask(taskOf(state, low.id), {}).score;
  const highScore = Priority.scoreTask(taskOf(state, high.id), {}).score;
  assert(highScore > lowScore, '高重要度应优先');
});

test('补救任务优先级高于普通复习', function () {
  const state = makeState();
  const normal = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, name: '普通' });
  const fail = addEntry(state, { firstDate: C.addDays(today, -3), firstMinutes: 20, name: '失败' });
  addLog(state, fail, {
    type: 'review',
    round: 2,
    date: C.addDays(today, -1),
    planned: 14.1,
    actual: 15,
    recall: 'fail',
  });
  const normalScore = Priority.scoreTask(taskOf(state, normal.id), {}).score;
  const remedialScore = Priority.scoreTask(taskOf(state, fail.id), {}).score;
  assert(remedialScore > normalScore, '补救任务应更靠前');
});

test('考试日期标签提升优先级', function () {
  const state = makeState();
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: {}, general: 0, note: '', createdAt: C.nowIso() },
  ];
  Budget.applyLabel(state, C.addDays(today, 3), 'lb1');
  const entry = addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20 });
  const withExam = Priority.scoreTask(taskOf(state, entry.id), {
    exam: Priority.examInfo(state, today),
  });
  const withoutExam = Priority.scoreTask(taskOf(state, entry.id), {});
  assert(withExam.score > withoutExam.score, '临近考试应加分');
});

/* ---------------- 迁移 ---------------- */
group('数据迁移');

function legacyRaw() {
  return {
    version: 1,
    subjects: [{ id: 's1', name: '英语', color: 0, archived: false }],
    entries: [
      {
        id: 'e1',
        name: '单词 Unit 1',
        subjectId: 's1',
        firstDate: '2026-10-20',
        firstMinutes: 20,
        done: { 1: '2026-10-20', 2: '2026-10-21', 3: '2026-10-22' },
      },
    ],
    settings: { cols: 3 },
  };
}

test('v1 的 done 迁移为执行记录', function () {
  const state = Model.normalizeState(legacyRaw());
  eq(state.version, 2);
  eq(state.logs.length, 3);
  const learn = state.logs.find(function (log) { return log.type === 'learn'; });
  eq(learn.date, '2026-10-20');
  const review3 = state.logs.find(function (log) { return log.round === 3; });
  near(review3.plannedMinutes, 20 / Math.sqrt(3), 0.1);
  eq(state.entries[0].prepared, false);
});

test('迁移是幂等的（不会重复生成记录）', function () {
  const once = Model.normalizeState(legacyRaw());
  const twice = Model.normalizeState(once);
  eq(twice.logs.length, 3);
});

test('迁移保留旧版下一轮的原始计划日期', function () {
  const raw = legacyRaw();
  raw.entries[0].done = {
    1: '2026-10-20',
    2: '2026-10-29',
    3: '2026-10-30',
  };
  const state = Model.normalizeState(raw);
  const entry = state.entries[0];
  assert(entry.pendingTask, '迁移后应保留待复习任务');
  eq(entry.pendingTask.round, 4);
  eq(
    entry.pendingTask.dueDate,
    C.addDays(entry.firstDate, Review.legacyTheoryOffset(4) - 1),
    '应使用旧版第 4 轮的原始计划日期'
  );
  const derived = Review.derive(entry, state.logs);
  eq(derived.nextRound, 4);
  eq(derived.dueDate, entry.pendingTask.dueDate);
  eq(entry.pendingTask.legacyPin, true);
  eq(state.meta.pinPending, true);
  eq(state.meta.pinnedCount, 1);
});

test('迁移记录的原始建议日期使用理论日期', function () {
  const state = Model.normalizeState(legacyRaw());
  const review = state.logs.find(function (log) {
    return log.type === 'review' && log.round === 3;
  });
  eq(review.dueDate, C.addDays('2026-10-20', Review.legacyTheoryOffset(3) - 1));
  eq(review.intervalDays, Review.legacyTheoryGap(3));
});

test('待复习任务可以随数据保存和重新加载', function () {
  const raw = legacyRaw();
  raw.entries[0].done = { 1: '2026-10-20', 2: '2026-10-21', 3: '2026-10-22' };
  const once = Model.normalizeState(raw);
  const twice = Model.normalizeState(once);
  eq(twice.entries[0].pendingTask.round, once.entries[0].pendingTask.round);
  eq(twice.entries[0].pendingTask.dueDate, once.entries[0].pendingTask.dueDate);
});

test('已迁移的 v2 数据会一次性补上旧计划日期', function () {
  const migrated = Model.normalizeState(legacyRaw());
  const raw = JSON.parse(JSON.stringify(migrated));
  delete raw.entries[0].pendingTask;
  delete raw.meta.pendingPinned;
  const again = Model.normalizeState(raw);
  assert(again.entries[0].pendingTask, '旧的 v2 数据应补上 pendingTask');
  eq(again.meta.pendingPinned, true);
  eq(again.meta.pinPending, true);
  eq(again.meta.pinnedCount, 1);
  assert(again.meta.notice.indexOf('保留原计划日期') >= 0, '应提示已保留旧计划日期');
  const third = Model.normalizeState(again);
  eq(third.entries[0].pendingTask.dueDate, again.entries[0].pendingTask.dueDate);
});

test('用户可以选择改用新规则清除旧计划日期', function () {
  const migrated = Model.normalizeState(legacyRaw());
  const cleared = Model.clearLegacyPins(migrated);
  eq(cleared, 1);
  eq(migrated.entries[0].pendingTask, null);
  eq(migrated.meta.pinPending, false);
  eq(migrated.meta.pinnedCount, 0);
  const derived = Review.derive(migrated.entries[0], migrated.logs);
  assert(derived.dueDate, '清除后应按当前规则重新得到到期日');
});

test('迁移保留旧 done 字段', function () {
  const state = Model.normalizeState(legacyRaw());
  eq(Object.keys(state.entries[0].legacyDone).length, 3);
});

test('旧版本数字颜色索引还原为预设色', function () {
  const state = Model.normalizeState(legacyRaw());
  eq(state.subjects[0].color, C.PRESET_COLORS[0]);
});

test('旧版本没有预算时生成默认预算', function () {
  const state = Model.normalizeState(legacyRaw());
  eq(state.budgets.weekly['1'].subjects.s1, 20);
  eq(state.budgets.weekly['7'].general, 20);
  eq(state.meta.migratedFrom, 1);
});

test('未来首次日期的预备诵不生成学习记录', function () {
  const raw = legacyRaw();
  raw.entries[0].firstDate = '2099-01-01';
  raw.entries[0].prepared = true;
  raw.entries[0].done = {};
  const state = Model.normalizeState(raw);
  eq(state.logs.length, 0);
  eq(state.entries[0].prepared, true);
  eq(state.entries[0].firstDate, '2099-01-01');
});

/* ---------------- 未来预测 ---------------- */
group('未来预测');

test('预算不足的日子会被标记为超载', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's1' });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's2' });
  const forecast = Forecast.run(state, today, 7);
  assert(forecast.summary.overloadedDays > 0, '应存在超载日');
  assert(forecast.days[0].summary.unscheduledCount >= 1, '今天应有未安排任务');
});

test('未来日期应用标签预算后预测跟随变化', function () {
  const state = makeState({ subjectMinutes: { s1: 30, s2: 30 }, general: 20 });
  state.budgets.labels = [
    { id: 'lb1', name: '考试日', color: '#f3dde0', kind: 'exam', subjects: { s1: 0, s2: 0 }, general: 0, note: '', createdAt: C.nowIso() },
  ];
  const tomorrow = C.addDays(today, 1);
  Budget.applyLabel(state, tomorrow, 'lb1');
  addEntry(state, { firstDate: today, firstMinutes: 30, subjectId: 's1' });
  const forecast = Forecast.run(state, today, 3);
  const day = forecast.days.find(function (item) { return item.date === tomorrow; });
  eq(day.budget.source, 'override');
  eq(day.budget.total, 0);
  assert(day.summary.unscheduledCount >= 1, '考试日预算不足应提示未安排');
});

test('未安排任务会逐日传递，预算为 0 时不会强制击穿', function () {
  const state = makeState({ subjectMinutes: { s1: 0, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 30, subjectId: 's1' });
  const forecast = Forecast.run(state, today, 5);
  assert(forecast.days[1].carriedOut >= 1, '第二天应仍有延期任务');
  eq(forecast.days[1].assignments.length, 0);
  eq(forecast.days[2].summary.forcedCount, 0);
  eq(forecast.summary.totalForced, 0);
});

test('预测会模拟新内容后续产生的复习', function () {
  const state = makeState({ subjectMinutes: { s1: 100, s2: 0 }, general: 50 });
  addEntry(state, {
    firstDate: null,
    firstMinutes: 20,
    subjectId: 's1',
    name: '新内容',
    learned: false,
  });
  const forecast = Forecast.run(state, today, 7);
  eq(forecast.days[0].summary.newContentCount, 1);
  assert(forecast.summary.simulatedReviews >= 2, '应模拟出后续复习');
  assert(forecast.summary.predictedReviews >= 2, '预计复习次数应包含后续复习');
});

test('新内容不会挤占到期任务', function () {
  const state = makeState({ subjectMinutes: { s1: 10, s2: 0 }, general: 0 });
  addEntry(state, { firstDate: C.addDays(today, -1), firstMinutes: 20, subjectId: 's1', name: '复习' });
  addEntry(state, { firstDate: null, firstMinutes: 20, subjectId: 's1', name: '新内容', learned: false });
  const forecast = Forecast.run(state, today, 3);
  eq(forecast.days[0].summary.newContentCount, 0);
});

/* ---------------- 汇总 ---------------- */
console.log('\n' + '='.repeat(48));
console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) {
  failures.forEach(function (failure) {
    console.log('\n[' + failure.group + '] ' + failure.name);
    console.log(failure.error.stack);
  });
  process.exitCode = 1;
} else {
  console.log('全部测试通过。');
}
