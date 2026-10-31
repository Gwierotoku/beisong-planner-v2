/* 单日动态调度：把候任务按优先级放进当天的科目专属预算与通用预算。
 * 纯函数：同一 state + 日期 + 预算，结果确定，不会重复创建任务。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  const MIN_PARTIAL_MINUTES = 3; // 预算不足时，至少值得做 3 分钟才安排
  const NEW_CONTENT_MIN_MINUTES = 5; // 新内容至少需要这么多预算才启动
  const FORCED_BUDGET_FACTOR = 1.25; // 强制安排最多超出可用预算 25%
  const EARLY_REVIEW_WINDOW_DEFAULT = 1; // 默认只提前 1 天安排困难/失败内容

  function waitDaysFor(entry, date) {
    const created = C.isoToLocalDate(entry.createdAt) || date;
    return Math.max(0, C.diffDays(created, date));
  }

  /**
   * 收集所有启用条目的「下一个任务」。不做到期过滤，方便预测与展示。
   */
  function collectTasks(state, date) {
    const tasks = [];
    (state.entries || []).forEach(function (entry) {
      if (entry.status && entry.status !== 'active') return;
      const derived = BS.Review.derive(entry, state.logs);
      const estimate = BS.Duration.estimateMinutes(entry, derived, state.logs);
      const common = {
        entryId: entry.id,
        name: entry.name,
        subjectId: entry.subjectId,
        importance: entry.importance || 3,
        difficulty: entry.difficulty || 3,
        estimateMinutes: estimate.minutes,
        theoryEstimateMinutes: estimate.theoryMinutes,
        estimateInfo: estimate,
        lapses: derived.lapses,
        failureStreak: derived.failureStreak || 0,
        retry: !!(derived.retryRound && derived.nextType === 'review'),
        intervalDays: derived.intervalDays,
        theoryIntervalDays: derived.theoryIntervalDays,
        graceDays: BS.Review.graceDaysForInterval(derived.intervalDays),
        derived: derived,
        entry: entry,
        isQueuedNew: false,
        waitDays: 0,
      };

      if (!derived.learned) {
        if (entry.firstDate) {
          tasks.push(
            Object.assign({}, common, {
              type: 'learn',
              round: 1,
              dueDate: entry.firstDate,
              theoryDueDate: entry.firstDate,
              deferralDays: Math.max(0, C.diffDays(entry.firstDate, date)),
              notDue: entry.firstDate > date,
            })
          );
        } else {
          tasks.push(
            Object.assign({}, common, {
              type: 'learn',
              round: 1,
              dueDate: date,
              theoryDueDate: null,
              deferralDays: 0,
              isQueuedNew: true,
              waitDays: waitDaysFor(entry, date),
            })
          );
        }
        return;
      }

      if (derived.finished || !derived.dueDate) return;
      tasks.push(
        Object.assign({}, common, {
          type: derived.nextType,
          round: BS.Review.taskRound(derived),
          nextRound: derived.nextRound,
          remedialRound: derived.remedialRound,
          dueDate: derived.dueDate,
          theoryDueDate: derived.theoryDueDate,
          deferralDays: Math.max(0, C.diffDays(derived.dueDate, date)),
          notDue: derived.dueDate > date,
          intervalDays: derived.intervalDays,
        })
      );
    });

    tasks.forEach(function (task) {
      task.key = task.entryId + ':' + task.type + ':' + task.round;
    });
    return tasks;
  }

  function scoreDueTasks(state, date, tasks) {
    const exam = BS.Priority.examInfo(state, date);
    tasks.forEach(function (task) {
      task.deferralDays = task.dueDate ? Math.max(0, C.diffDays(task.dueDate, date)) : 0;
      const scored = BS.Priority.scoreTask(task, { exam: exam });
      task.score = scored.score;
      task.reasons = scored.reasons;
    });
    return exam;
  }

  function scoreNewTasks(tasks) {
    tasks.forEach(function (task) {
      const scored = BS.Priority.scoreNewContent(task, {});
      task.score = scored.score;
      task.reasons = scored.reasons;
    });
  }

  function availableMinutes(remaining, subjectId) {
    const subject = Math.max(0, Number(remaining.subjects[subjectId]) || 0);
    const general = Math.max(0, Number(remaining.general) || 0);
    return C.round1(subject + general);
  }

  function allocate(task, remaining, allowOverdraft, minMinutes) {
    const subjectId = task.subjectId;
    const subjectLeft = Number(remaining.subjects[subjectId]) || 0;
    const generalLeft = Number(remaining.general) || 0;
    const available = C.round1(Math.max(0, subjectLeft) + Math.max(0, generalLeft));
    const estimate = Math.max(0.1, Number(task.estimateMinutes) || 0.1);

    if (allowOverdraft) {
      const subjectUse = C.round1(Math.min(estimate, Math.max(0, subjectLeft)));
      const generalUse = C.round1(estimate - subjectUse);
      remaining.subjects[subjectId] = C.round1(subjectLeft - subjectUse);
      remaining.general = C.round1(generalLeft - generalUse);
      return {
        subject: subjectUse,
        general: generalUse,
        total: C.round1(estimate),
        partial: false,
        forced: true,
      };
    }

    const minimum = minMinutes || MIN_PARTIAL_MINUTES;
    // 任务本身比最小压缩时长还短时，只要预算够全额就应该安排
    if (available < Math.min(minimum, estimate)) return null;

    const planned = C.round1(Math.min(estimate, available));
    // 只有「被压缩」时才要求不少于最小分钟数
    if (planned < estimate - 0.05 && planned < minimum) return null;

    const subjectUse = C.round1(Math.min(planned, Math.max(0, subjectLeft)));
    const generalUse = C.round1(planned - subjectUse);
    remaining.subjects[subjectId] = C.round1(subjectLeft - subjectUse);
    remaining.general = C.round1(generalLeft - generalUse);

    return {
      subject: subjectUse,
      general: generalUse,
      total: C.round1(planned),
      partial: planned < estimate - 0.05,
      forced: false,
    };
  }

  function allocateForced(task, remaining, maxMinutes) {
    const subjectId = task.subjectId;
    const subjectLeft = Number(remaining.subjects[subjectId]) || 0;
    const generalLeft = Number(remaining.general) || 0;
    const estimate = Math.max(0.1, Number(task.estimateMinutes) || 0.1);
    const allowed = Math.max(0, Number(maxMinutes) || 0);
    const planned = C.round1(Math.min(estimate, allowed));
    if (planned < Math.min(MIN_PARTIAL_MINUTES, estimate)) return null;

    const subjectUse = C.round1(Math.min(planned, Math.max(0, subjectLeft)));
    const generalUse = C.round1(planned - subjectUse);
    remaining.subjects[subjectId] = C.round1(subjectLeft - subjectUse);
    remaining.general = C.round1(generalLeft - generalUse);
    return {
      subject: subjectUse,
      general: generalUse,
      total: C.round1(planned),
      partial: planned < estimate - 0.05,
      forced: true,
    };
  }

  function unscheduledRow(task, remaining, reason, extra) {
    const available = availableMinutes(remaining, task.subjectId);
    return Object.assign(
      {
        key: task.key,
        entryId: task.entryId,
        name: task.name,
        subjectId: task.subjectId,
        type: task.type,
        round: task.round,
        dueDate: task.dueDate,
        deferralDays: task.deferralDays,
        graceDays: task.graceDays,
        estimateMinutes: task.estimateMinutes,
        intervalDays: task.intervalDays,
        theoryIntervalDays: task.theoryIntervalDays,
        theoryDueDate: task.theoryDueDate,
        score: task.score,
        reasons: task.reasons,
        available: available,
        deficit: C.round1(Math.max(0, task.estimateMinutes - available)),
        reason: reason,
      },
      extra || {}
    );
  }

  function buildWarnings(state, date, budget, usage, result) {
    const warnings = [];
    if (result.summary.forcedCount) {
      warnings.push({
        type: 'warning',
        text:
          '有 ' +
          result.summary.forcedCount +
          ' 条任务已超过各自的可延迟天数，已优先强制安排；强制部分最多可用预算的 ' +
          Math.round((FORCED_BUDGET_FACTOR - 1) * 100) +
          '%。',
      });
    }
    if (result.summary.forcedBlockedCount) {
      warnings.push({
        type: 'warning',
        text:
          (budget.allowForced === false
            ? '今天是休息日/考试日，已关闭强制安排：'
            : '强制安排已达上限：') +
          result.summary.forcedBlockedCount +
          ' 条逾期任务转入未安排，建议调整当天预算或日期标签。',
      });
    }
    if (result.summary.unscheduledCount) {
      warnings.push({
        type: 'warning',
        text:
          '预算不足：' +
          result.summary.unscheduledCount +
          ' 条到期任务今天安排不下，合计缺口约 ' +
          Math.round(result.summary.deficitMinutes) +
          ' 分钟。',
      });
    }
    if (budget.total <= 0 && result.summary.dueCount > 0) {
      warnings.push({ type: 'warning', text: '今天的预算为 0，所有到期任务都无法安排。' });
    }
    if (result.summary.overflowMinutes > 0) {
      warnings.push({
        type: 'danger',
        text:
          '今日安排已超出总预算 ' +
          Math.round(result.summary.overflowMinutes) +
          ' 分钟，建议提高预算或减少新内容。',
      });
    }
    if (usage.overspend > 0) {
      warnings.push({
        type: 'danger',
        text:
          '已完成任务的实际用时超出总预算 ' +
          Math.round(usage.overspend) +
          ' 分钟。',
      });
    }
    return warnings;
  }

  /**
   * 用给定任务集合和剩余预算做一次调度。供单日调度和未来预测复用。
   */
  function planTasks(state, date, tasks, budget, usage, opts) {
    const settings = Object.assign(
      {
        newContentEnabled: true,
        newContentDailyLimit: 3,
        earlyReviewEnabled: true,
        earlyReviewWindowDays: EARLY_REVIEW_WINDOW_DEFAULT,
      },
      state.settings || {},
      opts || {}
    );
    const remaining = BS.Budget.remainingAfterUsage(budget, usage);
    const exam = scoreDueTasks(state, date, tasks);

    const due = tasks.filter(function (task) {
      return !task.isQueuedNew && task.dueDate && task.dueDate <= date;
    });
    const queued = tasks.filter(function (task) {
      return task.isQueuedNew;
    });

    const forced = [];
    const normal = [];
    due.forEach(function (task) {
      const grace = Math.max(1, Number(task.graceDays) || 2);
      if (task.deferralDays >= grace) forced.push(task);
      else normal.push(task);
    });
    forced.sort(BS.Priority.compareScored);
    normal.sort(BS.Priority.compareScored);
    scoreNewTasks(queued);
    queued.sort(BS.Priority.compareScored);

    const assignments = [];
    const unscheduled = [];
    const earlyDeferred = [];
    let order = 0;

    function assign(task, allocation, isNewContent) {
      order += 1;
      assignments.push({
        key: task.key,
        entryId: task.entryId,
        name: task.name,
        subjectId: task.subjectId,
        type: task.type,
        round: task.round,
        nextRound: task.nextRound,
        remedialRound: task.remedialRound,
        dueDate: task.dueDate,
        deferralDays: task.deferralDays,
        graceDays: task.graceDays,
        estimateMinutes: task.estimateMinutes,
        theoryEstimateMinutes: task.theoryEstimateMinutes,
        intervalDays: task.intervalDays,
        theoryIntervalDays: task.theoryIntervalDays,
        importance: task.importance,
        lapses: task.lapses,
        score: task.score,
        reasons: task.reasons,
        allocation: allocation,
        plannedMinutes: allocation.total,
        partial: allocation.partial,
        forced: allocation.forced,
        early: !!task.early,
        earlyDays: task.earlyDays || 0,
        simulated: !!task.simulated,
        isNewContent: !!isNewContent,
        waitDays: task.waitDays || 0,
        order: order,
        theoryDueDate: task.theoryDueDate,
      });
    }

    // 强制安排必须有上限，不能因为逾期就把休息日/考试日整天击穿
    const forcedCapMinutes = C.round1(
      Math.max(0, Number(budget.total) - Number(usage.actualTotal || 0)) *
        FORCED_BUDGET_FACTOR
    );
    let forcedPlanned = 0;
    if (budget.allowForced === false) {
      forced.forEach(function (task) {
        unscheduled.push(
          unscheduledRow(
            task,
            remaining,
            '今天是休息日/考试日，已关闭强制安排',
            { forcedBlocked: true }
          )
        );
      });
    } else {
      forced.forEach(function (task) {
        const allowance = C.round1(forcedCapMinutes - forcedPlanned);
        const allocation = allocateForced(task, remaining, allowance);
        if (allocation) {
          assign(task, allocation, false);
          forcedPlanned = C.round1(forcedPlanned + allocation.total);
        } else {
          unscheduled.push(
            unscheduledRow(
              task,
              remaining,
              '强制安排已达今日上限（' + Math.round(forcedCapMinutes) + ' 分钟）',
              { forcedBlocked: true }
            )
          );
        }
      });
    }

    normal.forEach(function (task) {
      const allocation = allocate(task, remaining, false, MIN_PARTIAL_MINUTES);
      if (allocation) {
        assign(task, allocation, false);
      } else {
        unscheduled.push(
          unscheduledRow(
            task,
            remaining,
            task.dueDate === date
              ? '今日预算不足，顺延到明天'
              : '已逾期 ' + task.deferralDays + ' 天，预算仍不足'
          )
        );
      }
    });

    // 提前复习：只提前安排「困难/失败过」且间隔至少 2 天的内容，避免把正常节奏打乱
    const early = [];
    if (settings.earlyReviewEnabled !== false && !unscheduled.length) {
      const windowDays = C.clamp(
        Math.round(Number(settings.earlyReviewWindowDays) || EARLY_REVIEW_WINDOW_DEFAULT),
        1,
        3
      );
      tasks.forEach(function (task) {
        if (task.isQueuedNew || !task.dueDate || task.dueDate <= date) return;
        if (task.type !== 'review' || !task.derived || !task.derived.learned) return;
        if ((Number(task.intervalDays) || 0) < 2) return;
        const days = C.diffDays(date, task.dueDate);
        if (days < 1 || days > windowDays) return;
        const badMemory =
          Number(task.lapses) > 0 ||
          task.derived.lastRecall === 'hard' ||
          task.derived.lastRecall === 'fail';
        if (!badMemory) return;
        task.early = true;
        task.earlyDays = days;
        task.reasons = (task.reasons || []).concat([
          {
            key: 'early',
            label: '提前 ' + days + ' 天（原定 ' + C.fmtShort(task.dueDate) + '）',
            value: 0,
          },
        ]);
        early.push(task);
      });
      early.sort(BS.Priority.compareScored);
      early.forEach(function (task) {
        const allocation = allocate(task, remaining, false, MIN_PARTIAL_MINUTES);
        if (allocation) {
          assign(task, allocation, false);
        } else {
          earlyDeferred.push({
            key: task.key,
            entryId: task.entryId,
            name: task.name,
            subjectId: task.subjectId,
            reason: '剩余预算不足以提前安排',
          });
        }
      });
    }

    let newContentCount = 0;
    const newContentDeferred = [];
    if (settings.newContentEnabled !== false && queued.length) {
      const blockedSubjects = new Set(
        unscheduled.map(function (row) {
          return row.subjectId || '__none__';
        })
      );
      queued.forEach(function (task) {
        const subjectKey = task.subjectId || '__none__';
        if (blockedSubjects.has(subjectKey)) {
          newContentDeferred.push({
            key: task.key,
            entryId: task.entryId,
            name: task.name,
            subjectId: task.subjectId,
            reason: '本科目还有到期任务未安排，今天不启动这一科的新内容',
          });
          return;
        }
        if (newContentCount >= settings.newContentDailyLimit) {
          newContentDeferred.push({
            key: task.key,
            entryId: task.entryId,
            name: task.name,
            subjectId: task.subjectId,
            reason: '已达每日新内容上限（' + settings.newContentDailyLimit + ' 条）',
          });
          return;
        }
        const available = availableMinutes(remaining, task.subjectId);
        const newMinimum = Math.min(NEW_CONTENT_MIN_MINUTES, task.estimateMinutes);
        if (available < newMinimum || available < task.estimateMinutes) {
          newContentDeferred.push({
            key: task.key,
            entryId: task.entryId,
            name: task.name,
            subjectId: task.subjectId,
            reason:
              available < task.estimateMinutes
                ? '剩余预算不足以完整启动（需 ' +
                  Math.round(task.estimateMinutes) +
                  ' 分钟）'
                : '剩余预算不足最低启动时间（' +
                  Math.round(newMinimum) +
                  ' 分钟）',
          });
          return;
        }
        const allocation = allocate(
          task,
          remaining,
          false,
          NEW_CONTENT_MIN_MINUTES
        );
        if (!allocation) {
          newContentDeferred.push({
            key: task.key,
            entryId: task.entryId,
            name: task.name,
            subjectId: task.subjectId,
            reason: '剩余预算不足',
          });
          return;
        }
        newContentCount += 1;
        assign(task, allocation, true);
      });
    }

    const plannedBySubject = {};
    Object.keys(budget.subjects).forEach(function (sid) {
      plannedBySubject[sid] = 0;
    });
    let plannedGeneral = 0;
    let plannedTotal = 0;
    let partialCount = 0;
    let forcedCount = 0;
    let earlyCount = 0;
    assignments.forEach(function (row) {
      plannedBySubject[row.subjectId] = C.round1(
        (plannedBySubject[row.subjectId] || 0) + row.allocation.subject
      );
      plannedGeneral = C.round1(plannedGeneral + row.allocation.general);
      plannedTotal = C.round1(plannedTotal + row.allocation.total);
      if (row.partial) partialCount += 1;
      if (row.forced) forcedCount += 1;
      if (row.early) earlyCount += 1;
    });

    const forcedBlockedCount = unscheduled.filter(function (row) {
      return row.forcedBlocked;
    }).length;
    const deficitMinutes = unscheduled.reduce(function (sum, row) {
      return sum + row.deficit;
    }, 0);
    const overflowMinutes = Math.max(0, plannedTotal - budget.total);
    const scheduledDue = assignments.filter(function (row) {
      return !row.isNewContent && !row.early;
    }).length;

    const remainingBySubject = {};
    let subjectLockedMinutes = 0;
    Object.keys(remaining.subjects).forEach(function (sid) {
      const value = C.round1(Math.max(0, remaining.subjects[sid]));
      remainingBySubject[sid] = value;
      subjectLockedMinutes = C.round1(subjectLockedMinutes + value);
    });
    const remainingGeneral = C.round1(Math.max(0, remaining.general));

    const result = {
      date: date,
      budget: budget,
      usage: usage,
      remaining: remaining,
      exam: exam,
      assignments: assignments,
      unscheduled: unscheduled,
      newContentDeferred: newContentDeferred,
      earlyDeferred: earlyDeferred,
      plannedBySubject: plannedBySubject,
      plannedGeneral: plannedGeneral,
      plannedTotal: plannedTotal,
      summary: {
        dueCount: due.length,
        scheduledDue: scheduledDue,
        unscheduledCount: unscheduled.length,
        forcedCount: forcedCount,
        forcedBlockedCount: forcedBlockedCount,
        forcedCapMinutes: forcedCapMinutes,
        partialCount: partialCount,
        earlyCount: earlyCount,
        earlyDeferredCount: earlyDeferred.length,
        newContentCount: newContentCount,
        plannedTotal: plannedTotal,
        plannedGeneral: plannedGeneral,
        plannedBySubject: plannedBySubject,
        deficitMinutes: C.round1(deficitMinutes),
        overflowMinutes: C.round1(overflowMinutes),
        budgetTotal: budget.total,
        actualTotal: usage.actualTotal,
        remainingTotal: C.round1(Math.max(0, budget.total - usage.actualTotal - plannedTotal)),
        remainingGeneral: remainingGeneral,
        remainingBySubject: remainingBySubject,
        subjectLockedMinutes: subjectLockedMinutes,
        allowForced: budget.allowForced !== false,
      },
    };
    result.warnings = buildWarnings(state, date, budget, usage, result);
    return result;
  }

  function scheduleDay(state, date, opts) {
    const budget = BS.Budget.resolve(state, date);
    const usage = BS.Budget.dayUsage(state, date, budget);
    const tasks = collectTasks(state, date);
    return planTasks(state, date, tasks, budget, usage, opts);
  }

  BS.Scheduler = {
    MIN_PARTIAL_MINUTES: MIN_PARTIAL_MINUTES,
    NEW_CONTENT_MIN_MINUTES: NEW_CONTENT_MIN_MINUTES,
    FORCED_BUDGET_FACTOR: FORCED_BUDGET_FACTOR,
    EARLY_REVIEW_WINDOW_DEFAULT: EARLY_REVIEW_WINDOW_DEFAULT,
    waitDaysFor: waitDaysFor,
    collectTasks: collectTasks,
    planTasks: planTasks,
    scheduleDay: scheduleDay,
  };
})(typeof window !== 'undefined' ? window : globalThis);
