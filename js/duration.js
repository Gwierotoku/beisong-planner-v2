/* 预计耗时模型：以公式值为先验，用真实执行数据平滑修正，再按上次回忆结果调整。
 * 实际耗时只影响本模型，回忆结果只影响间隔与本次用时倍率。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  const WINDOW = 8; // 最多参考最近 8 次执行
  const ALPHA = 0.4; // 新数据的权重
  const MIN_MINUTES = 0.5;
  const MAX_MINUTES = 240;

  // 上次回忆结果对下一次建议用时的影响：好则缩短，差则增加
  const RECALL_TIME_FACTORS = { easy: 0.8, normal: 1, hard: 1.3, fail: 2.4 };

  function theoryMinutes(entry, round) {
    const first = Number(entry.firstMinutes) || 0;
    if (!round || round <= 1) return first;
    return first / Math.sqrt(round);
  }

  function estimateMinutes(entry, derived, allLogs) {
    const Review = BS.Review;
    const round = Review.taskRound(derived) || 1;
    const theory = theoryMinutes(entry, round);
    const firstMinutes = Number(entry.firstMinutes) || 1;
    const floorMinutes = Math.max(MIN_MINUTES, firstMinutes / 4);
    const ceilingMinutes = Math.max(floorMinutes, firstMinutes * 2);

    // 撤销恢复的任务：沿用当时记录的建议用时，避免再次按历史重算
    if (entry.pendingTask && Number(entry.pendingTask.estimateMinutes) > 0) {
      const restored = C.clamp(
        C.round1(entry.pendingTask.estimateMinutes),
        floorMinutes,
        Math.min(MAX_MINUTES, ceilingMinutes)
      );
      return {
        minutes: restored,
        theoryMinutes: C.round1(theory),
        factor: 1,
        recallFactor: 1,
        samples: 0,
        averageRatio: 1,
        lastRecall: null,
        restored: true,
        floorMinutes: C.round1(floorMinutes),
      };
    }

    const logs = (allLogs || []).filter(function (log) {
      return (
        log &&
        log.entryId === entry.id &&
        log.completed !== false &&
        log.partial !== true &&
        Number(log.actualMinutes) > 0 &&
        Number(log.plannedMinutes) > 0
      );
    });

    const recent = Review.sortLogs(logs).slice(-WINDOW);
    const lastLog = recent.length ? recent[recent.length - 1] : null;
    const lastRecall = lastLog && lastLog.recall ? lastLog.recall : 'normal';
    const recallFactor = RECALL_TIME_FACTORS[lastRecall] || 1;

    let base;
    let factor = 1;
    if (!recent.length) {
      // 没有执行数据时，用初始难度做一个温和修正
      const difficulty = Number(entry.difficulty) || 3;
      factor = 1 + (difficulty - 3) * 0.1;
      base = theory * factor;
    } else {
      let ewma = 1;
      recent.forEach(function (log, index) {
        const ratio = C.clamp(Number(log.actualMinutes) / Number(log.plannedMinutes), 0.25, 4);
        ewma = index === 0 ? ratio : ewma * (1 - ALPHA) + ratio * ALPHA;
      });
      const shrink = recent.length / (recent.length + 2);
      factor = C.clamp(1 + (ewma - 1) * shrink, 0.4, 3);
      base = theory * factor;
    }

    const minutes = C.clamp(
      base * recallFactor,
      floorMinutes,
      Math.min(MAX_MINUTES, ceilingMinutes)
    );

    return {
      minutes: C.round1(minutes),
      theoryMinutes: C.round1(theory),
      factor: C.round2(factor),
      recallFactor: recallFactor,
      samples: recent.length,
      averageRatio: C.round2(base / theory),
      lastRecall: lastRecall,
      restored: false,
      floorMinutes: C.round1(floorMinutes),
    };
  }

  function totalActualMinutes(entry, allLogs) {
    return (allLogs || []).reduce(function (sum, log) {
      if (!log || log.entryId !== entry.id || log.completed === false) return sum;
      return sum + (Number(log.actualMinutes) || 0);
    }, 0);
  }

  BS.Duration = {
    WINDOW: WINDOW,
    ALPHA: ALPHA,
    MIN_MINUTES: MIN_MINUTES,
    MAX_MINUTES: MAX_MINUTES,
    RECALL_TIME_FACTORS: RECALL_TIME_FACTORS,
    theoryMinutes: theoryMinutes,
    estimateMinutes: estimateMinutes,
    totalActualMinutes: totalActualMinutes,
  };
})(typeof window !== 'undefined' ? window : globalThis);
