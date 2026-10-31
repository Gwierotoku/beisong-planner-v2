/* 数据模型：默认值、字段校验、v1 → v2 迁移、localStorage 读写、示例数据。 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  const VERSION = 2;
  const STORE_KEY = 'beisong-plan-v2';
  const LEGACY_KEY = 'beisong-plan-v1';
  const DEFAULT_COLOR = '#d9e7f2';
  const MAX_ROUND_KEYS = 50;
  const WEEKDAY_KEYS = ['1', '2', '3', '4', '5', '6', '7'];

  function makeEmptyWeekly(general) {
    const weekly = {};
    WEEKDAY_KEYS.forEach(function (key) {
      weekly[key] = { subjects: {}, general: C.clamp(Number(general) || 0, 0, 600) };
    });
    return weekly;
  }

  function defaultState() {
    const weekly = makeEmptyWeekly(20);
    return {
      version: VERSION,
      meta: {
        createdAt: C.nowIso(),
        migratedFrom: null,
        migratedAt: null,
        pendingPinned: false,
        pinnedCount: 0,
        pinPending: false,
        pinAcknowledged: false,
        notice: '',
      },
      subjects: [],
      entries: [],
      logs: [],
      budgets: { weekly: weekly, labels: [], overrides: {} },
      settings: {
        newContentEnabled: true,
        newContentDailyLimit: 3,
        earlyReviewEnabled: true,
        earlyReviewWindowDays: 1,
        forecastDays: 14,
      },
    };
  }

  function normalizeDone(rawDone) {
    const done = {};
    if (!rawDone || typeof rawDone !== 'object') return done;
    Object.keys(rawDone).forEach(function (key) {
      const n = Number(key);
      const value = rawDone[key];
      if (Number.isInteger(n) && n >= 1 && n <= MAX_ROUND_KEYS && C.isValidYmd(value)) {
        done[n] = value;
      }
    });
    return done;
  }

  function normalizeSubjects(rawSubjects) {
    const subjects = [];
    const seen = new Set();
    if (!Array.isArray(rawSubjects)) return subjects;
    rawSubjects.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return;
      const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 20);
      if (!name) return;
      seen.add(raw.id);
      let color = DEFAULT_COLOR;
      if (typeof raw.color === 'number' && Number.isInteger(raw.color)) {
        // 极旧版本：颜色存的是预设色索引
        if (raw.color >= 0 && raw.color < C.PRESET_COLORS.length) {
          color = C.PRESET_COLORS[raw.color];
        }
      } else {
        const hex = C.normalizeHex(raw.color);
        if (hex) color = hex;
      }
      subjects.push({
        id: raw.id,
        name: name,
        color: color,
        archived: !!raw.archived,
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : C.nowIso(),
      });
    });
    return subjects;
  }

  function normalizePendingTask(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const type = raw.type === 'remedial' ? 'remedial' : raw.type === 'review' ? 'review' : null;
    if (!type) return null;
    if (!C.isValidYmd(raw.dueDate)) return null;
    const round = Math.round(Number(raw.round));
    if (!Number.isInteger(round) || round < 1) return null;
    const maxRound = BS.Review && BS.Review.MAX_ROUNDS ? BS.Review.MAX_ROUNDS : 50;
    return {
      type: type,
      round: C.clamp(round, 1, maxRound),
      dueDate: raw.dueDate,
      theoryDueDate: C.isValidYmd(raw.theoryDueDate) ? raw.theoryDueDate : raw.dueDate,
      intervalDays: Math.max(0, Number(raw.intervalDays) || 0),
      theoryIntervalDays: Math.max(0, Number(raw.theoryIntervalDays) || 0),
      estimateMinutes: Math.max(0, Number(raw.estimateMinutes) || 0),
      scheduledDate: C.isValidYmd(raw.scheduledDate) ? raw.scheduledDate : raw.dueDate,
      legacyPin: raw.legacyPin === true,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : C.nowIso(),
    };
  }

  function normalizeEntries(rawEntries) {
    const entries = [];
    const seen = new Set();
    if (!Array.isArray(rawEntries)) return entries;
    rawEntries.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return;
      const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 100);
      if (!name) return;
      const firstMinutes = Number(raw.firstMinutes);
      if (!Number.isFinite(firstMinutes) || firstMinutes <= 0 || firstMinutes > 600) return;

      const done = normalizeDone(raw.legacyDone || raw.done);
      const firstDate = C.isValidYmd(raw.firstDate) ? raw.firstDate : null;
      const importance = C.clamp(Math.round(Number(raw.importance) || 3), 1, 5);
      const difficulty = C.clamp(Math.round(Number(raw.difficulty) || 3), 1, 5);
      let status = 'active';
      if (raw.status === 'paused' || raw.status === 'archived') status = raw.status;

      const entry = {
        id: raw.id,
        name: name,
        subjectId: typeof raw.subjectId === 'string' && raw.subjectId ? raw.subjectId : null,
        importance: importance,
        difficulty: difficulty,
        firstDate: firstDate,
        firstMinutes: C.round1(firstMinutes),
        prepared: raw.prepared === true,
        status: status,
        note: String(raw.note == null ? '' : raw.note).slice(0, 200),
        pendingTask: normalizePendingTask(raw.pendingTask),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : C.nowIso(),
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : undefined,
      };
      if (Object.keys(done).length) entry.legacyDone = done;
      seen.add(entry.id);
      entries.push(entry);
    });
    return entries;
  }

  function normalizeLogs(rawLogs, entryIds) {
    const logs = [];
    const seen = new Set();
    if (!Array.isArray(rawLogs)) return logs;
    rawLogs.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (!entryIds.has(raw.entryId)) return;
      if (!C.isValidYmd(raw.date)) return;
      const type = raw.type === 'learn' || raw.type === 'review' || raw.type === 'remedial'
        ? raw.type
        : null;
      if (!type) return;
      let id = typeof raw.id === 'string' && raw.id ? raw.id : C.uid('l');
      if (seen.has(id)) id = C.uid('l');
      seen.add(id);
      const planned = Math.max(0, Number(raw.plannedMinutes) || 0);
      const actual = Math.max(0, Number(raw.actualMinutes));
      const recall =
        raw.recall === 'easy' || raw.recall === 'normal' || raw.recall === 'hard' || raw.recall === 'fail'
          ? raw.recall
          : null;
      const round = Number.isInteger(Number(raw.round)) && Number(raw.round) >= 1
        ? Number(raw.round)
        : type === 'learn'
        ? 1
        : null;
      logs.push({
        id: id,
        entryId: raw.entryId,
        type: type,
        round: round,
        date: raw.date,
        at: typeof raw.at === 'string' ? raw.at : raw.date + 'T12:00:00.000Z',
        plannedMinutes: C.round1(planned),
        actualMinutes: Number.isFinite(actual) && actual > 0 ? C.round1(actual) : C.round1(planned),
        recall: recall,
        difficulty: Number.isFinite(Number(raw.difficulty))
          ? C.clamp(Math.round(Number(raw.difficulty)), 1, 5)
          : null,
        needsRelearn: raw.needsRelearn === true || recall === 'fail',
        completed: raw.completed !== false,
        note: String(raw.note == null ? '' : raw.note).slice(0, 200),
        dueDate: C.isValidYmd(raw.dueDate) ? raw.dueDate : null,
        theoryDueDate: C.isValidYmd(raw.theoryDueDate) ? raw.theoryDueDate : null,
        intervalDays: Math.max(0, Number(raw.intervalDays) || 0),
        theoryIntervalDays: Math.max(0, Number(raw.theoryIntervalDays) || 0),
        scheduledDate: C.isValidYmd(raw.scheduledDate) ? raw.scheduledDate : null,
        subjectBudgetMinutes: Math.max(0, Number(raw.subjectBudgetMinutes) || 0),
        generalBudgetMinutes: Math.max(0, Number(raw.generalBudgetMinutes) || 0),
        firstDateBefore: C.isValidYmd(raw.firstDateBefore) ? raw.firstDateBefore : null,
        partial: raw.partial === true,
        legacy: !!raw.legacy,
      });
    });
    return logs;
  }

  function migrateLegacy(out, today) {
    const existingIds = new Set(
      out.logs.map(function (log) {
        return log.id;
      })
    );

    out.entries.forEach(function (entry) {
      const done = entry.legacyDone;
      if (!done || !Object.keys(done).length) return;

      let learnDate = null;
      if (C.isValidYmd(done[1])) {
        learnDate = done[1];
      } else if (entry.firstDate && entry.firstDate <= today && entry.prepared !== true) {
        learnDate = entry.firstDate;
      }

      if (learnDate && !out.logs.some(function (log) {
        return log.entryId === entry.id && log.type === 'learn';
      })) {
        const id = 'legacy-learn-' + entry.id;
        if (!existingIds.has(id)) {
          existingIds.add(id);
          out.logs.push({
            id: id,
            entryId: entry.id,
            type: 'learn',
            round: 1,
            date: learnDate,
            at: learnDate + 'T12:00:00.000Z',
            plannedMinutes: C.round1(entry.firstMinutes),
            actualMinutes: C.round1(entry.firstMinutes),
            recall: 'normal',
            difficulty: entry.difficulty,
            needsRelearn: false,
            completed: true,
            note: '旧版本数据迁移',
            dueDate: entry.firstDate || learnDate,
            theoryDueDate: entry.firstDate || learnDate,
            intervalDays: 1,
            theoryIntervalDays: 1,
            scheduledDate: learnDate,
            subjectBudgetMinutes: 0,
            generalBudgetMinutes: 0,
            legacy: true,
          });
        }
      }

      Object.keys(done).forEach(function (key) {
        const n = Number(key);
        if (!Number.isInteger(n) || n < 2) return;
        const id = 'legacy-review-' + entry.id + '-' + n;
        if (existingIds.has(id)) return;
        const date = done[key];
        if (!C.isValidYmd(date)) return;
        existingIds.add(id);
        const planned = C.round1(entry.firstMinutes / Math.sqrt(n));
        const theoryDue =
          C.isValidYmd(entry.firstDate) && n <= BS.Review.MAX_ROUNDS
            ? C.addDays(entry.firstDate, BS.Review.legacyTheoryOffset(n) - 1)
            : date;
        const theoryGap =
          n <= BS.Review.MAX_ROUNDS ? BS.Review.legacyTheoryGap(n) : 0;
        out.logs.push({
          id: id,
          entryId: entry.id,
          type: 'review',
          round: n,
          date: date,
          at: date + 'T12:00:00.000Z',
          plannedMinutes: planned,
          actualMinutes: planned,
          recall: 'normal',
          difficulty: entry.difficulty,
          needsRelearn: false,
          completed: true,
          note: '旧版本数据迁移',
          dueDate: theoryDue,
          theoryDueDate: theoryDue,
          intervalDays: theoryGap,
          theoryIntervalDays: theoryGap,
          scheduledDate: theoryDue,
          subjectBudgetMinutes: 0,
          generalBudgetMinutes: 0,
          legacy: true,
        });
      });
    });

    const pinned = pinLegacyNextTasks(out);
    out.meta.pendingPinned = true;
    out.meta.pinnedCount = pinned;
    out.meta.pinPending = pinned > 0;
    out.meta.pinAcknowledged = false;
  }

  // 为旧版迁移过来的条目保留下一轮的原始计划日期
  function pinLegacyNextTasks(out) {
    let count = 0;
    out.entries.forEach(function (entry) {
      if (!entry.legacyDone || entry.pendingTask) return;
      const hasLearn = out.logs.some(function (log) {
        return log.entryId === entry.id && log.type === 'learn' && log.partial !== true;
      });
      if (!hasLearn || !C.isValidYmd(entry.firstDate)) return;
      const derived = BS.Review.derive(entry, out.logs);
      if (derived.finished || !derived.nextRound) return;
      const dueDate = C.addDays(
        entry.firstDate,
        BS.Review.legacyTheoryOffset(derived.nextRound) - 1
      );
      entry.pendingTask = {
        type: 'review',
        round: derived.nextRound,
        dueDate: dueDate,
        theoryDueDate: dueDate,
        intervalDays: BS.Review.legacyTheoryGap(derived.nextRound),
        theoryIntervalDays: BS.Review.legacyTheoryGap(derived.nextRound),
        estimateMinutes: C.round1(entry.firstMinutes / Math.sqrt(derived.nextRound)),
        scheduledDate: dueDate,
        legacyPin: true,
        createdAt: C.nowIso(),
      };
      count += 1;
    });
    return count;
  }

  function appendNotice(out, text) {
    if (!text) return;
    out.meta.notice = out.meta.notice ? out.meta.notice + ' ' + text : text;
  }

  // 用户确认保留旧计划：只关闭提示，pendingTask 继续保留
  function acknowledgePin(state) {
    state.meta.pinPending = false;
    state.meta.pinAcknowledged = true;
    return true;
  }

  // 用户选择改用新规则：清除一次性补上的旧计划日期，让任务按当前模型重算
  function clearLegacyPins(state) {
    let count = 0;
    state.entries.forEach(function (entry) {
      if (entry.pendingTask && entry.pendingTask.legacyPin) {
        entry.pendingTask = null;
        entry.updatedAt = C.nowIso();
        count += 1;
      }
    });
    state.meta.pinPending = false;
    state.meta.pinAcknowledged = true;
    state.meta.pinnedCount = 0;
    return count;
  }

  function syncEntriesWithLogs(out) {
    out.entries.forEach(function (entry) {
      const learnLog = out.logs.find(function (log) {
        return (
          log.entryId === entry.id &&
          log.type === 'learn' &&
          log.completed !== false &&
          log.partial !== true
        );
      });
      if (learnLog) {
        entry.prepared = false;
        if (!C.isValidYmd(entry.firstDate)) entry.firstDate = learnLog.date;
      } else {
        entry.prepared = true;
        entry.pendingTask = null;
        if (!C.isValidYmd(entry.firstDate)) entry.firstDate = null;
      }
    });
  }

  function normalizeWeekly(rawWeekly, subjects, isLegacy) {
    const weekly = makeEmptyWeekly(0);
    const keys = WEEKDAY_KEYS;
    const hasRaw = rawWeekly && typeof rawWeekly === 'object' && !Array.isArray(rawWeekly);

    if (hasRaw) {
      keys.forEach(function (key) {
        const rawDay = rawWeekly[key];
        if (!rawDay || typeof rawDay !== 'object') return;
        weekly[key].general = BS.Budget.clampMinutes(rawDay.general);
        subjects.forEach(function (subject) {
          if (rawDay.subjects && Object.prototype.hasOwnProperty.call(rawDay.subjects, subject.id)) {
            weekly[key].subjects[subject.id] = BS.Budget.clampMinutes(
              rawDay.subjects[subject.id]
            );
          }
        });
      });
      return weekly;
    }

    if (isLegacy) {
      // 旧版本没有预算概念：给一个可用的初始值，用户可在预算页修改
      keys.forEach(function (key) {
        weekly[key].general = 20;
        subjects.forEach(function (subject) {
          weekly[key].subjects[subject.id] = 20;
        });
      });
    } else {
      keys.forEach(function (key) {
        weekly[key].general = 20;
      });
    }
    return weekly;
  }

  function normalizeLabels(rawLabels, subjects) {
    const labels = [];
    const seen = new Set();
    if (!Array.isArray(rawLabels)) return labels;
    rawLabels.forEach(function (raw) {
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) return;
      const name = String(raw.name == null ? '' : raw.name).trim().slice(0, 20);
      if (!name) return;
      seen.add(raw.id);
      const kind = BS.Budget.KIND_LABELS[raw.kind] ? raw.kind : 'normal';
      const subjectBudgets = {};
      subjects.forEach(function (subject) {
        if (raw.subjects && Object.prototype.hasOwnProperty.call(raw.subjects, subject.id)) {
          subjectBudgets[subject.id] = BS.Budget.clampMinutes(raw.subjects[subject.id]);
        }
      });
      labels.push({
        id: raw.id,
        name: name,
        color: C.normalizeHex(raw.color) || DEFAULT_COLOR,
        kind: kind,
        subjects: subjectBudgets,
        general: BS.Budget.clampMinutes(raw.general),
        allowForced:
          raw.allowForced === true
            ? true
            : raw.allowForced === false
            ? false
            : BS.Budget.defaultAllowForced(kind),
        note: String(raw.note == null ? '' : raw.note).slice(0, 200),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : C.nowIso(),
      });
    });
    return labels;
  }

  function normalizeOverrides(rawOverrides, subjects, labels) {
    const overrides = {};
    if (!rawOverrides || typeof rawOverrides !== 'object') return overrides;
    const labelIds = new Set(
      labels.map(function (label) {
        return label.id;
      })
    );
    const labelMap = {};
    labels.forEach(function (label) {
      labelMap[label.id] = label;
    });
    Object.keys(rawOverrides).forEach(function (date) {
      if (!C.isValidYmd(date)) return;
      const raw = rawOverrides[date];
      if (!raw || typeof raw !== 'object') return;
      const subjectBudgets = {};
      subjects.forEach(function (subject) {
        if (raw.subjects && Object.prototype.hasOwnProperty.call(raw.subjects, subject.id)) {
          subjectBudgets[subject.id] = BS.Budget.clampMinutes(raw.subjects[subject.id]);
        }
      });
      const labelId =
        typeof raw.labelId === 'string' && labelIds.has(raw.labelId) ? raw.labelId : null;
      const label = labelId ? labelMap[labelId] : null;
      const allowForced =
        raw.allowForced === false
          ? false
          : raw.allowForced === true
          ? true
          : label
          ? label.allowForced !== false
          : true;
      overrides[date] = {
        subjects: subjectBudgets,
        general: BS.Budget.clampMinutes(raw.general),
        labelId: labelId,
        origin: raw.origin === 'label' && labelId ? 'label' : 'manual',
        allowForced: allowForced,
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : C.nowIso(),
      };
    });
    return overrides;
  }

  function normalizeSettings(rawSettings) {
    const raw = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    return {
      newContentEnabled: raw.newContentEnabled !== false,
      newContentDailyLimit: C.clamp(Math.round(Number(raw.newContentDailyLimit) || 3), 0, 20),
      earlyReviewEnabled: raw.earlyReviewEnabled !== false,
      earlyReviewWindowDays: C.clamp(
        Math.round(Number(raw.earlyReviewWindowDays) || 1),
        1,
        3
      ),
      forecastDays: C.clamp(Math.round(Number(raw.forecastDays) || 14), 7, 21),
    };
  }

  function normalizeState(raw) {
    const out = defaultState();
    if (!raw || typeof raw !== 'object') return out;

    const version = Number(raw.version) || 1;
    const isLegacy = version < 2;
    const today = C.todayStr();

    out.subjects = normalizeSubjects(raw.subjects);
    out.entries = normalizeEntries(raw.entries);
    out.logs = normalizeLogs(raw.logs, new Set(out.entries.map(function (e) { return e.id; })));
    if (isLegacy) migrateLegacy(out, today);
    syncEntriesWithLogs(out);

    out.budgets.labels = normalizeLabels(raw.budgets && raw.budgets.labels, out.subjects);
    out.budgets.weekly = normalizeWeekly(
      raw.budgets && raw.budgets.weekly,
      out.subjects,
      isLegacy
    );
    out.budgets.overrides = normalizeOverrides(
      raw.budgets && raw.budgets.overrides,
      out.subjects,
      out.budgets.labels
    );
    out.settings = normalizeSettings(raw.settings);

    out.meta.createdAt =
      raw.meta && typeof raw.meta.createdAt === 'string'
        ? raw.meta.createdAt
        : C.nowIso();
    if (isLegacy) {
      out.meta.migratedFrom = version;
      out.meta.migratedAt = C.nowIso();
      out.meta.pendingPinned = true;
      out.meta.notice =
        '已从旧版本数据迁移：历史复习记录已保留为执行记录；因为旧版本没有时间预算，系统为每个科目临时分配了每天 20 分钟 + 通用 20 分钟，请到「预算与标签」调整。';
      if (out.meta.pinnedCount) {
        appendNotice(
          out,
          '已为 ' + out.meta.pinnedCount + ' 条旧条目保留原计划日期；你可以保留旧计划，或改用新规则重新排期。'
        );
      }
    } else if (raw.meta && typeof raw.meta === 'object') {
      out.meta.migratedFrom = raw.meta.migratedFrom || null;
      out.meta.migratedAt = raw.meta.migratedAt || null;
      out.meta.pendingPinned = raw.meta.pendingPinned === true;
      out.meta.pinnedCount = Math.max(0, Math.round(Number(raw.meta.pinnedCount) || 0));
      out.meta.pinPending = raw.meta.pinPending === true;
      out.meta.pinAcknowledged = raw.meta.pinAcknowledged === true;
      out.meta.notice = typeof raw.meta.notice === 'string' ? raw.meta.notice : '';
    }

    // 旧版本已经迁移过、但尚未按“保留旧计划日期”规则处理的数据：只处理一次
    if (!isLegacy && out.meta.migratedFrom === 1 && !out.meta.pendingPinned) {
      const pinned = pinLegacyNextTasks(out);
      out.meta.pendingPinned = true;
      out.meta.pinnedCount = pinned;
      out.meta.pinPending = pinned > 0;
      out.meta.pinAcknowledged = false;
      if (pinned) {
        appendNotice(
          out,
          '已为 ' + pinned + ' 条旧条目保留原计划日期；你可以保留旧计划，或改用新规则重新排期。'
        );
      }
    }

    return out;
  }

  function load() {
    if (typeof localStorage === 'undefined') return defaultState();
    try {
      const current = localStorage.getItem(STORE_KEY);
      if (current) return normalizeState(JSON.parse(current));
    } catch (err) {
      console.warn('读取新版本地数据失败：', err);
    }
    try {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) return normalizeState(JSON.parse(legacy));
    } catch (err) {
      console.warn('读取旧版本地数据失败：', err);
    }
    return defaultState();
  }

  function save(state) {
    if (typeof localStorage === 'undefined') return false;
    try {
      state.version = VERSION;
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
      return true;
    } catch (err) {
      console.warn('保存本地数据失败：', err);
      return false;
    }
  }

  function serialize(state) {
    return {
      version: VERSION,
      exportedAt: C.nowIso(),
      meta: state.meta,
      subjects: state.subjects,
      entries: state.entries,
      logs: state.logs,
      budgets: state.budgets,
      settings: state.settings,
    };
  }

  /* ---------------- 示例数据 ---------------- */

  function isoDaysAgo(days) {
    return new Date(Date.now() - days * 86400000).toISOString();
  }

  function demoState() {
    const today = C.todayStr();
    const created = C.nowIso();
    const defs = [
      ['英语', '#d9e7f2'],
      ['数学', '#ddeada'],
      ['专业课', '#e5deef'],
      ['政治', '#f6e0cd'],
    ];
    const subjects = defs.map(function (def, index) {
      return {
        id: 's_demo_' + index,
        name: def[0],
        color: def[1],
        archived: false,
        createdAt: created,
      };
    });

    const weekdayValues = [15, 20, 15, 10];
    const saturdayValues = [20, 25, 20, 15];
    const sundayValues = [10, 10, 10, 10];
    const weekly = {};
    WEEKDAY_KEYS.forEach(function (key) {
      const dayIndex = Number(key); // 1=周一 …… 7=周日
      let values = weekdayValues;
      let general = 15;
      if (dayIndex === 6) {
        values = saturdayValues;
        general = 25;
      } else if (dayIndex === 7) {
        values = sundayValues;
        general = 20;
      }
      const day = { subjects: {}, general: general };
      values.forEach(function (minutes, index) {
        day.subjects[subjects[index].id] = minutes;
      });
      weekly[key] = day;
    });

    const labels = [
      {
        id: 'lb_demo_normal',
        name: '普通日',
        color: '#ddeada',
        kind: 'normal',
        subjects: {},
        general: 15,
        note: '常规工作日',
        createdAt: created,
      },
      {
        id: 'lb_demo_exam',
        name: '考试日',
        color: '#f3dde0',
        kind: 'exam',
        subjects: {},
        general: 0,
        note: '只保留最低复习量',
        createdAt: created,
      },
      {
        id: 'lb_demo_sprint',
        name: '考前冲刺',
        color: '#f6e0cd',
        kind: 'preExam',
        subjects: {},
        general: 10,
        note: '考试前一天的预算',
        createdAt: created,
      },
      {
        id: 'lb_demo_rest',
        name: '休息日',
        color: '#e9e4e0',
        kind: 'rest',
        subjects: {},
        general: 0,
        note: '完全不安排',
        createdAt: created,
      },
    ];
    labels.forEach(function (label) {
      label.allowForced = BS.Budget.defaultAllowForced(label.kind);
      subjects.forEach(function (subject) {
        label.subjects[subject.id] = label.kind === 'rest' ? 0 : label.kind === 'exam' ? 5 : 12;
      });
    });
    labels[0].subjects = C.clone(weekly['1'].subjects);

    const overrides = {};
    function putOverride(date, labelId) {
      const label = labels.find(function (item) {
        return item.id === labelId;
      });
      const copy = {};
      subjects.forEach(function (subject) {
        copy[subject.id] = label.subjects[subject.id] || 0;
      });
      overrides[date] = {
        subjects: copy,
        general: label.general,
        labelId: label.id,
        origin: 'label',
        allowForced: label.allowForced !== false,
        updatedAt: created,
      };
    }
    putOverride(C.addDays(today, 10), 'lb_demo_exam');
    putOverride(C.addDays(today, 3), 'lb_demo_rest');

    const entries = [];
    const logs = [];

    function addEntry(config) {
      const index = entries.length;
      const entry = {
        id: 'e_demo_' + index,
        name: config.name,
        subjectId: subjects[config.subject].id,
        importance: config.importance || 3,
        difficulty: config.difficulty || 3,
        firstDate: config.firstDate == null ? null : config.firstDate,
        firstMinutes: config.firstMinutes,
        prepared: config.prepared === true,
        status: config.status || 'active',
        note: '',
        createdAt: config.createdAt || isoDaysAgo(30),
      };
      entries.push(entry);

      if (config.recalls && config.firstDate) {
        addDemoLogs(entry, index, config.recalls);
      }
      return entry;
    }

    function addDemoLogs(entry, entryIndex, recalls) {
      let sequence = 0;
      function push(log) {
        sequence += 1;
        logs.push(
          Object.assign(
            {
              id: 'l_demo_' + entryIndex + '_' + sequence,
              entryId: entry.id,
              completed: true,
              needsRelearn: log.recall === 'fail',
              note: '',
              legacy: false,
              subjectBudgetMinutes: 0,
              generalBudgetMinutes: 0,
              at: log.date + 'T12:00:00.000Z',
            },
            log
          )
        );
      }

      const learnPlanned = C.round1(entry.firstMinutes);
      push({
        type: 'learn',
        round: 1,
        date: entry.firstDate,
        plannedMinutes: learnPlanned,
        actualMinutes: C.round1(learnPlanned * 1.05),
        recall: 'normal',
        difficulty: entry.difficulty,
        dueDate: entry.firstDate,
        scheduledDate: entry.firstDate,
      });

      let lastDate = entry.firstDate;
      let interval = 1;
      let round = 1;
      let pendingRemedial = false;
      const ratios = [1.05, 0.92, 1.12, 0.95, 1.02];

      recalls.forEach(function (recall, recallIndex) {
        if (pendingRemedial) {
          const date = C.addDays(lastDate, 1);
          const planned = C.round1(entry.firstMinutes / Math.sqrt(round));
          push({
            type: 'remedial',
            round: round,
            date: date,
            plannedMinutes: planned,
            actualMinutes: C.round1(planned * ratios[recallIndex % ratios.length]),
            recall: recall === 'fail' ? 'normal' : recall,
            difficulty: entry.difficulty,
            dueDate: date,
            scheduledDate: date,
          });
          lastDate = date;
          interval = C.clamp(
            Math.round(BS.Review.theoryGap(round + 1) * 0.5),
            1,
            BS.Review.MAX_INTERVAL_DAYS
          );
          pendingRemedial = false;
          return;
        }

        round += 1;
        const date = C.addDays(lastDate, interval);
        const planned = C.round1(entry.firstMinutes / Math.sqrt(round));
        push({
          type: 'review',
          round: round,
          date: date,
          plannedMinutes: planned,
          actualMinutes: C.round1(planned * ratios[recallIndex % ratios.length]),
          recall: recall,
          difficulty: entry.difficulty,
          dueDate: date,
          scheduledDate: date,
        });
        lastDate = date;
        if (recall === 'fail') {
          pendingRemedial = true;
          interval = 1;
        } else {
          interval = BS.Review.adjustInterval(
            BS.Review.theoryGap(round + 1) || BS.Review.theoryGap(round),
            interval,
            BS.Review.theoryGap(round),
            recall
          );
        }
      });
    }

    addEntry({
      name: '英语单词 Unit 1',
      subject: 0,
      firstMinutes: 20,
      firstDate: C.addDays(today, -6),
      importance: 4,
      difficulty: 3,
      recalls: ['normal', 'normal'],
      createdAt: isoDaysAgo(40),
    });
    addEntry({
      name: '数学 极限的定义',
      subject: 1,
      firstMinutes: 15,
      firstDate: C.addDays(today, -2),
      importance: 4,
      difficulty: 3,
      recalls: ['normal'],
      createdAt: isoDaysAgo(30),
    });
    addEntry({
      name: '专业课 第一章 框架',
      subject: 2,
      firstMinutes: 35,
      firstDate: C.addDays(today, -8),
      importance: 5,
      difficulty: 4,
      recalls: ['normal', 'normal', 'normal', 'normal'],
      createdAt: isoDaysAgo(45),
    });
    addEntry({
      name: '政治 马原 唯物论',
      subject: 3,
      firstMinutes: 25,
      firstDate: C.addDays(today, -1),
      importance: 3,
      difficulty: 3,
      recalls: [],
      createdAt: isoDaysAgo(20),
    });
    addEntry({
      name: '英语长难句 01',
      subject: 0,
      firstMinutes: 18,
      firstDate: C.addDays(today, -4),
      importance: 4,
      difficulty: 4,
      recalls: ['normal', 'fail'],
      createdAt: isoDaysAgo(25),
    });
    addEntry({
      name: '政治 时政 专题',
      subject: 3,
      firstMinutes: 20,
      firstDate: C.addDays(today, -20),
      importance: 3,
      difficulty: 3,
      recalls: ['normal', 'normal', 'normal', 'normal', 'normal'],
      createdAt: isoDaysAgo(60),
    });
    addEntry({
      name: '英语作文模板 1',
      subject: 0,
      firstMinutes: 30,
      firstDate: C.addDays(today, 2),
      importance: 3,
      difficulty: 3,
      prepared: true,
      createdAt: isoDaysAgo(1),
    });
    addEntry({
      name: '数学 错题 01',
      subject: 1,
      firstMinutes: 18,
      firstDate: null,
      importance: 4,
      difficulty: 4,
      recalls: [],
      createdAt: isoDaysAgo(2),
    });
    addEntry({
      name: '专业课 名词解释 20 个',
      subject: 2,
      firstMinutes: 25,
      firstDate: null,
      importance: 4,
      difficulty: 3,
      recalls: [],
      createdAt: isoDaysAgo(0),
    });
    addEntry({
      name: '数学 泰勒展开（已暂停）',
      subject: 1,
      firstMinutes: 35,
      firstDate: C.addDays(today, -20),
      importance: 3,
      difficulty: 4,
      status: 'paused',
      recalls: ['normal', 'normal', 'normal', 'normal', 'normal', 'normal'],
      createdAt: isoDaysAgo(60),
    });

    return {
      version: VERSION,
      meta: {
        createdAt: created,
        migratedFrom: null,
        migratedAt: null,
        pendingPinned: false,
        pinnedCount: 0,
        pinPending: false,
        pinAcknowledged: false,
        notice: '',
      },
      subjects: subjects,
      entries: entries,
      logs: logs,
      budgets: { weekly: weekly, labels: labels, overrides: overrides },
      settings: {
        newContentEnabled: true,
        newContentDailyLimit: 3,
        earlyReviewEnabled: true,
        earlyReviewWindowDays: 1,
        forecastDays: 14,
      },
    };
  }

  BS.Model = {
    VERSION: VERSION,
    STORE_KEY: STORE_KEY,
    LEGACY_KEY: LEGACY_KEY,
    DEFAULT_COLOR: DEFAULT_COLOR,
    defaultState: defaultState,
    normalizeState: normalizeState,
    normalizeDone: normalizeDone,
    acknowledgePin: acknowledgePin,
    clearLegacyPins: clearLegacyPins,
    load: load,
    save: save,
    serialize: serialize,
    demoState: demoState,
  };
})(typeof window !== 'undefined' ? window : globalThis);
