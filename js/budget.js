/* 时间预算：每周默认模板、日期标签模板、具体日期覆盖、预算解析与实际用量核算。
 * 预算解析优先级：日期覆盖 > 每周默认；标签只是「复制到日期」的模板。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  const WEEKDAY_KEYS = ['1', '2', '3', '4', '5', '6', '7'];
  const DEFAULT_SUBJECT_MINUTES = 15;
  const DEFAULT_GENERAL_MINUTES = 20;
  const MAX_SUBJECT_MINUTES = 600;
  const MAX_GENERAL_MINUTES = 600;

  const KIND_LABELS = {
    normal: '普通日',
    exam: '考试日',
    preExam: '考试前一天',
    activity: '活动日',
    free: '空闲日',
    rest: '休息日',
    other: '其他',
  };

  // 休息日、考试日默认不允许把逾期任务强行塞进来；用户仍可在标签里手动打开
  function defaultAllowForced(kind) {
    return kind !== 'rest' && kind !== 'exam';
  }

  function clampMinutes(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(MAX_SUBJECT_MINUTES, Math.round(n * 10) / 10);
  }

  function emptyDay() {
    return { subjects: {}, general: 0 };
  }

  function subjectIds(state) {
    return state.subjects.map(function (subject) {
      return subject.id;
    });
  }

  function makeWeekly(subjects, subjectMinutes, generalMinutes) {
    const weekly = {};
    WEEKDAY_KEYS.forEach(function (key) {
      const day = emptyDay();
      day.general = clampMinutes(generalMinutes);
      (subjects || []).forEach(function (subject) {
        day.subjects[subject.id || subject] = clampMinutes(subjectMinutes);
      });
      weekly[key] = day;
    });
    return weekly;
  }

  // 新增科目时，把该科目补进每周模板，避免默认 0 分钟而无法安排
  function ensureWeeklySubject(state, subjectId, minutes) {
    if (!state.budgets || !state.budgets.weekly) return;
    WEEKDAY_KEYS.forEach(function (key) {
      const day = state.budgets.weekly[key];
      if (!day) return;
      if (!(subjectId in day.subjects)) {
        day.subjects[subjectId] = clampMinutes(
          minutes == null ? DEFAULT_SUBJECT_MINUTES : minutes
        );
      }
    });
  }

  function labelById(state, id) {
    const labels = (state.budgets && state.budgets.labels) || [];
    return labels.find(function (label) {
      return label.id === id;
    }) || null;
  }

  function fillSubjectBudgets(source, state) {
    const out = {};
    subjectIds(state).forEach(function (id) {
      out[id] = clampMinutes(source && source[id]);
    });
    return out;
  }

  function resolve(state, date) {
    const weekday = C.isoWeekday(date);
    const key = String(weekday);
    const overrides = (state.budgets && state.budgets.overrides) || {};
    const override = overrides[date];

    if (override && override.subjects) {
      const label = override.labelId ? labelById(state, override.labelId) : null;
      const subjects = fillSubjectBudgets(override.subjects, state);
      const general = clampMinutes(override.general);
      const allowForced =
        override.allowForced === false
          ? false
          : override.allowForced === true
          ? true
          : label
          ? label.allowForced !== false
          : true;
      return {
        date: date,
        weekday: weekday,
        source: 'override',
        origin: override.origin === 'manual' ? 'manual' : 'label',
        labelId: override.labelId || null,
        label: label,
        subjects: subjects,
        general: general,
        allowForced: allowForced,
        total: C.round1(C.sumValues(subjects) + general),
      };
    }

    const day =
      (state.budgets && state.budgets.weekly && state.budgets.weekly[key]) || emptyDay();
    const subjects = fillSubjectBudgets(day.subjects, state);
    const general = clampMinutes(day.general);
    return {
      date: date,
      weekday: weekday,
      source: 'weekly',
      origin: 'weekly',
      labelId: null,
      label: null,
      subjects: subjects,
      general: general,
      allowForced: true,
      total: C.round1(C.sumValues(subjects) + general),
    };
  }

  function sourceText(budget) {
    let text;
    if (budget.source === 'override') {
      if (budget.label) {
        text =
          (budget.origin === 'manual' ? '手动调整 · 标签「' : '标签「') +
          budget.label.name +
          '」';
      } else {
        text = '手动设置';
      }
    } else {
      text = '每周默认（' + C.weekdayName(budget.date) + '）';
    }
    if (budget.allowForced === false) text += ' · 不强制安排';
    return text;
  }

  function copyLabelBudgets(state, label) {
    const subjects = fillSubjectBudgets(label.subjects, state);
    return { subjects: subjects, general: clampMinutes(label.general) };
  }

  function applyLabel(state, date, labelId) {
    const label = labelById(state, labelId);
    if (!label) return null;
    const copy = copyLabelBudgets(state, label);
    const override = {
      subjects: copy.subjects,
      general: copy.general,
      labelId: label.id,
      origin: 'label',
      allowForced: label.allowForced !== false,
      updatedAt: C.nowIso(),
    };
    state.budgets.overrides[date] = override;
    return override;
  }

  function setOverride(state, date, subjects, general, origin, allowForced) {
    const previous = state.budgets.overrides[date];
    const nextForced =
      allowForced === undefined
        ? previous && typeof previous.allowForced === 'boolean'
          ? previous.allowForced
          : true
        : allowForced !== false;
    const next = {
      subjects: fillSubjectBudgets(subjects, state),
      general: clampMinutes(general),
      labelId: null,
      origin: origin === 'label' ? 'label' : 'manual',
      allowForced: nextForced,
      updatedAt: C.nowIso(),
    };
    if (previous && previous.labelId) next.labelId = previous.labelId;
    state.budgets.overrides[date] = next;
    return next;
  }

  function clearOverride(state, date) {
    if (state.budgets.overrides[date]) {
      delete state.budgets.overrides[date];
      return true;
    }
    return false;
  }

  function syncLabelToDates(state, label) {
    let count = 0;
    Object.keys(state.budgets.overrides || {}).forEach(function (date) {
      const override = state.budgets.overrides[date];
      if (override.labelId !== label.id || override.origin !== 'label') return;
      const copy = copyLabelBudgets(state, label);
      override.subjects = copy.subjects;
      override.general = copy.general;
      override.allowForced = label.allowForced !== false;
      override.updatedAt = C.nowIso();
      count += 1;
    });
    return count;
  }

  function removeLabel(state, labelId) {
    const before = state.budgets.labels.length;
    state.budgets.labels = state.budgets.labels.filter(function (label) {
      return label.id !== labelId;
    });
    let detached = 0;
    Object.keys(state.budgets.overrides || {}).forEach(function (date) {
      const override = state.budgets.overrides[date];
      if (override.labelId === labelId) {
        override.labelId = null;
        override.origin = 'manual';
        override.updatedAt = C.nowIso();
        detached += 1;
      }
    });
    return { removed: before !== state.budgets.labels.length, detached: detached };
  }

  /**
   * 计算某天已完成任务的实际预算消耗。
   * 每笔记录先占用本科目剩余专属预算，超出部分计入通用预算；
   * 实际耗时超出预算时会出现 overspend。
   */
  function dayUsage(state, date, budget) {
    const logs = (state.logs || [])
      .filter(function (log) {
        return log && log.completed !== false && log.date === date;
      })
      .sort(function (a, b) {
        return (
          String(a.at || '').localeCompare(String(b.at || '')) ||
          String(a.id).localeCompare(String(b.id))
        );
      });

    const entryMap = {};
    state.entries.forEach(function (entry) {
      entryMap[entry.id] = entry;
    });

    const bySubject = {};
    const subjectDirect = {};
    subjectIds(state).forEach(function (id) {
      subjectDirect[id] = 0;
      bySubject[id] = { actual: 0, direct: 0, general: 0 };
    });
    let generalUsed = 0;
    let actualTotal = 0;

    logs.forEach(function (log) {
      const entry = entryMap[log.entryId];
      const sid = entry ? entry.subjectId : null;
      const actual = Math.max(0, Number(log.actualMinutes) || 0);
      actualTotal += actual;
      const limit = sid && budget.subjects[sid] != null ? budget.subjects[sid] : 0;
      const directUsed = sid ? subjectDirect[sid] || 0 : 0;
      const direct = Math.min(actual, Math.max(0, limit - directUsed));
      const general = actual - direct;
      if (sid) {
        subjectDirect[sid] = directUsed + direct;
        bySubject[sid].actual += actual;
        bySubject[sid].direct += direct;
        bySubject[sid].general += general;
      }
      generalUsed += general;
    });

    Object.keys(bySubject).forEach(function (sid) {
      const row = bySubject[sid];
      row.actual = C.round1(row.actual);
      row.direct = C.round1(row.direct);
      row.general = C.round1(row.general);
      row.budget = budget.subjects[sid] || 0;
      row.remaining = C.round1(Math.max(0, row.budget - row.direct));
    });

    return {
      date: date,
      logs: logs,
      bySubject: bySubject,
      subjectDirect: subjectDirect,
      actualBySubject: bySubject,
      generalUsed: C.round1(generalUsed),
      actualTotal: C.round1(actualTotal),
      generalOverspend: C.round1(Math.max(0, generalUsed - budget.general)),
      overspend: C.round1(Math.max(0, actualTotal - budget.total)),
    };
  }

  function remainingAfterUsage(budget, usage) {
    const subjects = {};
    subjectIdsFromBudget(budget).forEach(function (sid) {
      subjects[sid] = C.round1(Math.max(0, (budget.subjects[sid] || 0) - (usage.subjectDirect[sid] || 0)));
    });
    return {
      subjects: subjects,
      general: C.round1(Math.max(0, budget.general - usage.generalUsed)),
    };
  }

  function subjectIdsFromBudget(budget) {
    return Object.keys(budget.subjects || {});
  }

  // 未来 n 天的预算与来源，用于预算页 / 预测页
  function upcoming(state, start, days) {
    return C.dateRange(start, days).map(function (date) {
      const budget = resolve(state, date);
      return {
        date: date,
        budget: budget,
        sourceText: sourceText(budget),
      };
    });
  }

  BS.Budget = {
    WEEKDAY_KEYS: WEEKDAY_KEYS,
    DEFAULT_SUBJECT_MINUTES: DEFAULT_SUBJECT_MINUTES,
    DEFAULT_GENERAL_MINUTES: DEFAULT_GENERAL_MINUTES,
    MAX_SUBJECT_MINUTES: MAX_SUBJECT_MINUTES,
    KIND_LABELS: KIND_LABELS,
    defaultAllowForced: defaultAllowForced,
    clampMinutes: clampMinutes,
    emptyDay: emptyDay,
    subjectIds: subjectIds,
    makeWeekly: makeWeekly,
    ensureWeeklySubject: ensureWeeklySubject,
    labelById: labelById,
    resolve: resolve,
    sourceText: sourceText,
    applyLabel: applyLabel,
    setOverride: setOverride,
    clearOverride: clearOverride,
    syncLabelToDates: syncLabelToDates,
    removeLabel: removeLabel,
    dayUsage: dayUsage,
    remainingAfterUsage: remainingAfterUsage,
    upcoming: upcoming,
  };
})(typeof window !== 'undefined' ? window : globalThis);
