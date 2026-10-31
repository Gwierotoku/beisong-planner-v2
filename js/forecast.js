/* 未来负担预测：逐日模拟调度，把当天没安排下的任务传递给下一天。
 * 已安排的任务视作当天完成，并按「正常回忆」继续生成后续复习。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  // 已安排的任务按「正常回忆」继续向后推演，避免预测只看到眼前一轮
  function simulatedReview(entry, round, doneDate, intervalOverride) {
    const interval = intervalOverride || BS.Review.theoryGap(round);
    if (!interval || round > BS.Review.MAX_ROUNDS) return null;
    const estimate = BS.Duration.theoryMinutes(entry, round);
    return {
      key: entry.id + ':review:' + round,
      entryId: entry.id,
      name: entry.name,
      subjectId: entry.subjectId,
      importance: entry.importance || 3,
      difficulty: entry.difficulty || 3,
      estimateMinutes: C.round1(estimate),
      theoryEstimateMinutes: C.round1(estimate),
      estimateInfo: null,
      lapses: 0,
      intervalDays: interval,
      theoryIntervalDays: interval,
      graceDays: BS.Review.graceDaysForInterval(interval),
      derived: null,
      entry: entry,
      isQueuedNew: false,
      waitDays: 0,
      type: 'review',
      round: round,
      nextRound: round,
      dueDate: C.addDays(doneDate, interval),
      theoryDueDate: C.addDays(entry.firstDate || doneDate, BS.Review.theoryOffset(round) - 1),
      deferralDays: 0,
      notDue: false,
      simulated: true,
    };
  }

  function addFollowUp(assigned, doneDate, pool, lastDate) {
    if (!assigned || !assigned.entry) return;
    let next = null;
    if (assigned.isQueuedNew || assigned.type === 'learn') {
      next = simulatedReview(assigned.entry, 2, doneDate);
    } else if (assigned.type === 'remedial') {
      // 补救成功后第二天重做同一轮
      next = simulatedReview(assigned.entry, assigned.round || 1, doneDate, 1);
    } else if (assigned.type === 'review') {
      next = simulatedReview(assigned.entry, (assigned.round || 1) + 1, doneDate);
    }
    if (next && next.dueDate <= lastDate) pool.push(next);
  }

  function run(state, startDate, days) {
    const count = Math.max(1, Math.min(60, Number(days) || 14));
    const dates = C.dateRange(startDate, count);
    const lastDate = dates[dates.length - 1];
    const pool = BS.Scheduler.collectTasks(state, startDate);
    const results = [];
    let simulatedReviewsScheduled = 0;

    dates.forEach(function (date) {
      const budget = BS.Budget.resolve(state, date);
      const usage = BS.Budget.dayUsage(state, date, budget);
      const overdueIn = pool.filter(function (task) {
        return !task.isQueuedNew && task.dueDate && task.dueDate < date;
      }).length;
      const dueIn = pool.filter(function (task) {
        return !task.isQueuedNew && task.dueDate && task.dueDate <= date;
      }).length;

      const plan = BS.Scheduler.planTasks(state, date, pool, budget, usage);

      const assignedTasks = [];
      plan.assignments.forEach(function (row) {
        const task = pool.find(function (item) {
          return item.key === row.key;
        });
        if (task) assignedTasks.push(task);
        if (row.simulated) simulatedReviewsScheduled += 1;
      });

      const done = new Set(
        plan.assignments.map(function (row) {
          return row.key;
        })
      );
      for (let i = pool.length - 1; i >= 0; i--) {
        if (done.has(pool[i].key)) pool.splice(i, 1);
      }

      // 被安排的新内容 / 模拟复习，会把后续复习重新加回负担池
      assignedTasks.forEach(function (task) {
        addFollowUp(task, date, pool, lastDate);
      });

      const carriedOut = pool.filter(function (task) {
        return !task.isQueuedNew && task.dueDate && task.dueDate <= date;
      }).length;

      results.push({
        date: date,
        budget: budget,
        usage: usage,
        assignments: plan.assignments,
        unscheduled: plan.unscheduled,
        newContentDeferred: plan.newContentDeferred,
        earlyDeferred: plan.earlyDeferred,
        warnings: plan.warnings,
        plannedBySubject: plan.plannedBySubject,
        plannedTotal: plan.plannedTotal,
        plannedGeneral: plan.plannedGeneral,
        summary: plan.summary,
        dueIn: dueIn,
        overdueIn: overdueIn,
        carriedOut: carriedOut,
        overload: plan.summary.overflowMinutes > 0 || plan.summary.unscheduledCount > 0,
      });
    });

    let totalBudget = 0;
    let totalPlanned = 0;
    let totalDeficit = 0;
    let totalForced = 0;
    let overloadedDays = 0;
    let worst = null;
    results.forEach(function (day) {
      totalBudget += day.budget.total;
      totalPlanned += day.plannedTotal;
      totalDeficit += day.summary.deficitMinutes;
      totalForced += day.summary.forcedCount;
      if (day.overload) overloadedDays += 1;
      if (!worst || day.summary.deficitMinutes > worst.summary.deficitMinutes) worst = day;
    });

    return {
      startDate: startDate,
      days: results,
      summary: {
        days: results.length,
        totalBudget: C.round1(totalBudget),
        totalPlanned: C.round1(totalPlanned),
        totalDeficit: C.round1(totalDeficit),
        totalForced: totalForced,
        overloadedDays: overloadedDays,
        worstDate: worst ? worst.date : null,
        worstDeficit: worst ? worst.summary.deficitMinutes : 0,
        simulatedReviews: simulatedReviewsScheduled,
        predictedReviews: results.reduce(function (sum, day) {
          return sum + day.summary.scheduledDue;
        }, 0),
      },
    };
  }

  BS.Forecast = {
    run: run,
  };
})(typeof window !== 'undefined' ? window : globalThis);
