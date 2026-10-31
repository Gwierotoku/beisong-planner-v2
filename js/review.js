/* 复习记忆模型：理论轮次、动态间隔、条目状态推导。
 * 所有状态都从执行记录推导，撤销记录即可回退。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  // 理论间隔表：第 n 轮距离上一轮的天数（下标 0 占位，第 1 轮是首次学习）
  // 第 1 天首次 → 第 2 天 → 第 4 天 → 第 10 天 → 第 20 天……
  // 后期间隔按约 1.7 倍增长，但最长压缩到 300 天，避免几百天的空档。
  const THEORY_GAPS = [0, 0, 1, 2, 6, 10, 17, 29, 49, 83, 141, 240, 300, 300];
  const MAX_ROUNDS = THEORY_GAPS.length - 1; // 13 轮
  const MAX_INTERVAL_DAYS = 300;
  const MAX_GRACE_DAYS = 14;
  // 同一轮连续失败达到这个次数后，回退一轮，避免在同一个难点上无限打转
  const MAX_FAIL_STREAK = 3;
  // 补救完成后，第二天重做失败的那一轮；成功后才继续往后走
  const RETRY_INTERVAL_DAYS = 1;

  // 回忆结果对下一次间隔的倍率；失败会进入补救流程
  const RECALL_FACTORS = { easy: 2, normal: 1, hard: 0.55, fail: 0.25 };
  const RECALL_LABELS = { easy: '顺利', normal: '正常', hard: '困难', fail: '失败' };
  const TYPE_LABELS = { learn: '首次学习', review: '复习', remedial: '补救学习' };

  const THEORY_OFFSETS = (function () {
    const offsets = [0, 0];
    for (let round = 2; round <= MAX_ROUNDS; round++) {
      offsets[round] = offsets[round - 1] + THEORY_GAPS[round];
    }
    return offsets;
  })();

  const MAX_SPAN_DAYS = THEORY_OFFSETS[MAX_ROUNDS];
  const LEGACY_SESSION_BASE = 1.7;

  function theoryOffset(round) {
    if (round <= 1) return 0;
    if (round > MAX_ROUNDS) return MAX_SPAN_DAYS;
    return THEORY_OFFSETS[round];
  }

  // 旧版固定 1.7 倍节奏的日期，仅用于迁移时保留旧计划日期
  function legacyTheoryOffset(round) {
    if (round <= 1) return 0;
    return Math.round(Math.pow(LEGACY_SESSION_BASE, round - 1)) - 1;
  }

  function legacyTheoryGap(round) {
    if (round <= 1) return 0;
    return legacyTheoryOffset(round) - legacyTheoryOffset(round - 1);
  }

  function maxRound() {
    return MAX_ROUNDS;
  }

  function theoryGap(round) {
    if (round <= 1 || round > MAX_ROUNDS) return 0;
    return THEORY_GAPS[round];
  }

  // 间隔越长，允许延迟的天数越多：1 个月约 5 天，最少 2 天，最多 14 天
  function graceDaysForInterval(intervalDays) {
    const interval = Math.max(1, Number(intervalDays) || 1);
    return C.clamp(Math.round(interval / 6), 2, MAX_GRACE_DAYS);
  }

  // 下一次间隔只取决于「理论基准间隔 + 上一次回忆结果」，不累积历史偏差
  function adjustInterval(theoryNext, prevInterval, prevTheory, recall) {
    const base = theoryNext > 0 ? theoryNext : prevTheory || 1;
    const factor = RECALL_FACTORS[recall] || 1;
    return C.clamp(Math.round(base * factor), 1, MAX_INTERVAL_DAYS);
  }

  function compareLogs(a, b) {
    return (
      String(a.date).localeCompare(String(b.date)) ||
      String(a.at || '').localeCompare(String(b.at || '')) ||
      String(a.id).localeCompare(String(b.id))
    );
  }

  function sortLogs(logs) {
    return (logs || []).slice().sort(compareLogs);
  }

  function logsOf(entry, allLogs) {
    return sortLogs(
      (allLogs || []).filter(function (log) {
        return log && log.entryId === entry.id && log.completed !== false && C.isValidYmd(log.date);
      })
    );
  }

  /**
   * 推导条目的当前记忆状态。
   * @returns {object} learned / nextRound / nextType / dueDate / intervalDays / ...
   */
  function derive(entry, allLogs) {
    const logs = logsOf(entry, allLogs);
    // 部分完成只记录时间，不代表这一轮已经复习过；推导状态时完全忽略
    const effectiveLogs = logs.filter(function (log) {
      return log.partial !== true;
    });
    const learnLog = effectiveLogs.find(function (log) {
      return log.type === 'learn';
    });
    const base = {
      entryId: entry.id,
      learned: false,
      learnDate: null,
      logs: logs,
      status: 'new',
      round: 0,
      nextRound: null,
      nextType: 'learn',
      remedialRound: null,
      retryRound: null,
      failureStreak: 0,
      intervalDays: 0,
      theoryIntervalDays: 0,
      dueDate: entry.firstDate || null,
      theoryDueDate: entry.firstDate || null,
      lastDate: null,
      lastRecall: null,
      lastType: null,
      lapses: 0,
      completedReviews: 0,
      totalRounds: MAX_ROUNDS,
      finished: false,
    };

    if (!learnLog) {
      base.dueDate = entry.firstDate || null;
      base.theoryDueDate = entry.firstDate || null;
      return base;
    }

    let interval =
      learnLog.recall === 'fail'
        ? RETRY_INTERVAL_DAYS
        : adjustInterval(theoryGap(2), 0, 0, learnLog.recall || 'normal');
    let round = 1; // 已经成功完成的最后一个常规轮次（首次学习 = 1）
    let pendingRemedial = learnLog.recall === 'fail';
    // 失败的是哪一轮：补救任务沿用它作为标签；retryRound 是补救后要重做的轮次
    let remedialRound = pendingRemedial ? 1 : null;
    let retryRound = null;
    let failureStreak = pendingRemedial ? 1 : 0;
    let lapses = pendingRemedial ? 1 : 0;
    let lastDate = learnLog.date;
    let lastRecall = learnLog.recall || null;
    let lastType = 'learn';
    let completedReviews = 0;

    effectiveLogs.forEach(function (log) {
      if (log === learnLog) return;
      if (log.type === 'learn') return; // 异常数据：只认最早的一次首次学习
      if (log.date < learnLog.date) return; // 异常数据：早于首次学习的记录忽略

      if (log.type === 'remedial') {
        if (log.recall === 'fail') {
          // 补救仍然失败：继续安排第二天的补救，不推进轮次
          lapses += 1;
          failureStreak += 1;
          pendingRemedial = true;
          interval = RETRY_INTERVAL_DAYS;
          if (!remedialRound) remedialRound = retryRound || round;
          if (failureStreak >= MAX_FAIL_STREAK) {
            round = Math.max(1, round - 1);
            retryRound = Math.min(MAX_ROUNDS, round + 1);
            failureStreak = 0;
          }
        } else {
          // 补救完成：第二天重做失败的那一轮，成功后才继续往后走
          pendingRemedial = false;
          if (!retryRound) retryRound = Math.min(MAX_ROUNDS, round + 1);
          interval = RETRY_INTERVAL_DAYS;
        }
        lastDate = log.date;
        lastRecall = log.recall || null;
        lastType = 'remedial';
        return;
      }

      if (log.recall === 'fail') {
        // 失败不推进轮次：只记录这次失败，补救后重做同一轮
        lapses += 1;
        failureStreak += 1;
        pendingRemedial = true;
        remedialRound = Math.min(MAX_ROUNDS, round + 1);
        retryRound = remedialRound;
        interval = RETRY_INTERVAL_DAYS;
        if (failureStreak >= MAX_FAIL_STREAK) {
          // 同一轮连续失败太多次：回退一轮，用更短的间隔重新巩固
          round = Math.max(1, round - 1);
          retryRound = Math.min(MAX_ROUNDS, round + 1);
          failureStreak = 0;
        }
      } else {
        // 成功才推进轮次；如果这是补救后的重做，round 会正好回到 retryRound
        round = Math.min(MAX_ROUNDS, round + 1);
        completedReviews += 1;
        pendingRemedial = false;
        retryRound = null;
        remedialRound = null;
        failureStreak = 0;
        const prevTheory = theoryGap(round) || 1;
        const nextTheory = theoryGap(round + 1) || prevTheory;
        interval = adjustInterval(nextTheory, interval, prevTheory, log.recall || 'normal');
      }
      lastDate = log.date;
      lastRecall = log.recall || null;
      lastType = 'review';
    });

    const finished = !pendingRemedial && !retryRound && round >= MAX_ROUNDS;
    let nextRound = null;
    if (!finished) {
      if (pendingRemedial) {
        nextRound = retryRound || Math.min(MAX_ROUNDS, round + 1);
      } else if (retryRound) {
        nextRound = retryRound;
      } else {
        nextRound = Math.min(MAX_ROUNDS, round + 1);
      }
    }
    let nextType = 'review';
    if (finished) nextType = null;
    else if (pendingRemedial) nextType = 'remedial';

    const dueDate = finished
      ? null
      : pendingRemedial
      ? C.addDays(lastDate, RETRY_INTERVAL_DAYS)
      : C.addDays(lastDate, interval);
    const theoryDueDate =
      finished || !nextRound
        ? null
        : C.addDays(learnLog.date, theoryOffset(nextRound) - 1);

    const result = {
      entryId: entry.id,
      learned: true,
      learnDate: learnLog.date,
      logs: logs,
      status: finished ? 'finished' : 'learning',
      round: round,
      nextRound: nextRound,
      nextType: nextType,
      remedialRound: pendingRemedial ? remedialRound : null,
      retryRound: retryRound,
      failureStreak: failureStreak,
      intervalDays: interval,
      theoryIntervalDays: nextRound ? theoryGap(nextRound) : 0,
      dueDate: dueDate,
      theoryDueDate: theoryDueDate,
      lastDate: lastDate,
      lastRecall: lastRecall,
      lastType: lastType,
      lapses: lapses,
      completedReviews: completedReviews,
      totalRounds: MAX_ROUNDS,
      finished: finished,
    };

    // 撤销/迁移时恢复的任务：保留当时的到期日与轮次，不重新按新规则追究过去
    const pending = entry.pendingTask;
    if (pending && C.isValidYmd(pending.dueDate)) {
      const pendingValid =
        pending.type === 'remedial' ? pending.round >= round : pending.round > round;
      if (pendingValid) {
        result.nextType = pending.type === 'remedial' ? 'remedial' : 'review';
        result.nextRound =
          pending.type === 'review' ? pending.round : Math.min(MAX_ROUNDS, pending.round + 1);
        result.remedialRound = pending.type === 'remedial' ? pending.round : null;
        result.dueDate = pending.dueDate;
        result.theoryDueDate = C.isValidYmd(pending.theoryDueDate)
          ? pending.theoryDueDate
          : pending.dueDate;
        if (pending.intervalDays > 0) result.intervalDays = pending.intervalDays;
        if (pending.theoryIntervalDays > 0) {
          result.theoryIntervalDays = pending.theoryIntervalDays;
        }
        result.status = 'learning';
        result.finished = false;
      }
    }

    return result;
  }

  // 下一次任务的轮次编号（补救任务沿用失败的那一轮）
  function taskRound(derived) {
    if (!derived || !derived.learned) return 1;
    if (derived.nextType === 'remedial') return derived.remedialRound;
    return derived.nextRound;
  }

  function taskLabel(derived) {
    if (!derived || !derived.learned) return '首次学习';
    if (derived.finished) return '全部完成';
    if (derived.nextType === 'remedial') {
      return '补救学习（第 ' + derived.remedialRound + ' 次复习未通过）';
    }
    if (derived.retryRound) {
      return '第 ' + derived.retryRound + ' 次复习（补救后重做）';
    }
    return '第 ' + derived.nextRound + ' 次复习';
  }

  // 完成当前任务后，下一次预计在什么时候（用于完成后的提示）
  function previewAfterCompletion(entry, derived, recall, doneDate) {
    if (!derived || !derived.learned) {
      const nextTheory = theoryGap(2);
      if (recall === 'fail') {
        return { type: 'remedial', intervalDays: 1, dueDate: C.addDays(doneDate, 1) };
      }
      const interval = adjustInterval(nextTheory, 0, 0, recall);
      return {
        type: 'review',
        intervalDays: interval,
        dueDate: C.addDays(doneDate, interval),
      };
    }
    if (derived.nextType === 'remedial') {
      if (recall === 'fail') {
        return { type: 'remedial', intervalDays: 1, dueDate: C.addDays(doneDate, 1) };
      }
      // 补救完成后不直接进入下一轮，而是第二天重做失败的那一轮
      return {
        type: 'review',
        retry: true,
        intervalDays: RETRY_INTERVAL_DAYS,
        dueDate: C.addDays(doneDate, RETRY_INTERVAL_DAYS),
      };
    }
    if (recall === 'fail') {
      return { type: 'remedial', intervalDays: 1, dueDate: C.addDays(doneDate, 1) };
    }
    const prevTheory = theoryGap(derived.nextRound) || 1;
    const nextTheory = theoryGap(derived.nextRound + 1) || prevTheory;
    const interval = adjustInterval(nextTheory, derived.intervalDays, prevTheory, recall);
    return { type: 'review', intervalDays: interval, dueDate: C.addDays(doneDate, interval) };
  }

  // 理论计划（用于表单预览与详情页）
  function theoryPlan(firstDate) {
    if (!C.isValidYmd(firstDate)) return [];
    const plan = [];
    for (let round = 1; round <= MAX_ROUNDS; round++) {
      const offset = theoryOffset(round);
      plan.push({
        round: round,
        offsetDays: offset,
        date: C.addDays(firstDate, offset),
      });
    }
    return plan;
  }

  BS.Review = {
    THEORY_GAPS: THEORY_GAPS,
    THEORY_OFFSETS: THEORY_OFFSETS,
    MAX_INTERVAL_DAYS: MAX_INTERVAL_DAYS,
    MAX_SPAN_DAYS: MAX_SPAN_DAYS,
    MAX_ROUNDS: MAX_ROUNDS,
    MAX_GRACE_DAYS: MAX_GRACE_DAYS,
    MAX_FAIL_STREAK: MAX_FAIL_STREAK,
    RETRY_INTERVAL_DAYS: RETRY_INTERVAL_DAYS,
    RECALL_FACTORS: RECALL_FACTORS,
    RECALL_LABELS: RECALL_LABELS,
    TYPE_LABELS: TYPE_LABELS,
    theoryOffset: theoryOffset,
    legacyTheoryOffset: legacyTheoryOffset,
    legacyTheoryGap: legacyTheoryGap,
    theoryGap: theoryGap,
    graceDaysForInterval: graceDaysForInterval,
    maxRound: maxRound,
    adjustInterval: adjustInterval,
    sortLogs: sortLogs,
    logsOf: logsOf,
    derive: derive,
    taskRound: taskRound,
    taskLabel: taskLabel,
    previewAfterCompletion: previewAfterCompletion,
    theoryPlan: theoryPlan,
  };
})(typeof window !== 'undefined' ? window : globalThis);
