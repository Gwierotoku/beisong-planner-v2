/* 任务优先级：在有限预算下决定先做哪些任务。
 * 所有分值都可解释，界面会展示每个分项。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const C = BS.Core;

  function examInfo(state, date) {
    const overrides = (state.budgets && state.budgets.overrides) || {};
    const labels = {};
    ((state.budgets && state.budgets.labels) || []).forEach(function (label) {
      labels[label.id] = label;
    });
    let best = null;
    Object.keys(overrides).forEach(function (ymd) {
      if (!C.isValidYmd(ymd) || ymd < date) return;
      const override = overrides[ymd];
      const label = override && labels[override.labelId];
      if (!label || (label.kind !== 'exam' && label.kind !== 'preExam')) return;
      const days = C.diffDays(date, ymd);
      if (!best || days < best.days) best = { days: days, date: ymd, label: label };
    });
    return best;
  }

  function examScore(exam) {
    if (!exam) return 0;
    if (exam.days <= 2) return 18;
    if (exam.days <= 7) return 12;
    if (exam.days <= 14) return 6;
    return 0;
  }

  function scoreTask(task, ctx) {
    const reasons = [];
    const deferral = Math.max(0, task.deferralDays || 0);
    const grace = Math.max(1, Number(task.graceDays) || 2);
    const urgency = Math.round(Math.min(1, deferral / grace) * 30) + (deferral >= grace ? 10 : 0);
    if (urgency) {
      reasons.push({
        key: 'urgency',
        label: '延期 ' + deferral + ' 天 / 可延迟 ' + grace + ' 天',
        value: urgency,
      });
    }

    const importance = Math.max(0, (Number(task.importance) || 3) - 1) * 5;
    reasons.push({
      key: 'importance',
      label: '重要程度 ' + (task.importance || 3) + '/5',
      value: importance,
    });

    const interval = Math.max(1, task.intervalDays || 1);
    const risk = Math.min(1, (deferral + 0.5) / interval) * 12;
    reasons.push({
      key: 'risk',
      label: '遗忘风险（间隔 ' + interval + ' 天）',
      value: C.round1(risk),
    });

    const lapses = Math.min(3, Number(task.lapses) || 0) * 4;
    if (lapses) {
      reasons.push({ key: 'lapses', label: '历史回忆失败 ' + task.lapses + ' 次', value: lapses });
    }

    const remedial = task.type === 'remedial' ? 15 : 0;
    if (remedial) {
      reasons.push({ key: 'remedial', label: '需要补救学习', value: remedial });
    }

    const learnBase = task.type === 'learn' ? 8 : 0;
    if (learnBase) {
      reasons.push({ key: 'learn', label: '首次学习任务', value: learnBase });
    }

    const exam = examScore(ctx && ctx.exam);
    if (exam) {
      reasons.push({
        key: 'exam',
        label:
          (ctx.exam.days === 0 ? '今天是' : '距') +
          (ctx.exam.days === 0 ? '' : '考试 ' + ctx.exam.days + ' 天') +
          (ctx.exam.label && ctx.exam.label.name ? '（' + ctx.exam.label.name + '）' : ''),
        value: exam,
      });
    }

    const score = reasons.reduce(function (sum, r) {
      return sum + r.value;
    }, 0);
    return { score: C.round1(score), reasons: reasons };
  }

  function scoreNewContent(task, ctx) {
    const waitDays = Math.max(0, Number(task.waitDays) || 0);
    const reasons = [];
    const importance = Math.max(0, (Number(task.importance) || 3) - 1) * 6;
    reasons.push({
      key: 'importance',
      label: '重要程度 ' + (task.importance || 3) + '/5',
      value: importance,
    });
    const waiting = Math.min(14, waitDays) * 1.5;
    if (waiting) {
      reasons.push({ key: 'wait', label: '等待安排 ' + waitDays + ' 天', value: C.round1(waiting) });
    }
    const base = 5;
    reasons.push({ key: 'base', label: '新内容基础分', value: base });
    const score = reasons.reduce(function (sum, r) {
      return sum + r.value;
    }, 0);
    return { score: C.round1(score), reasons: reasons };
  }

  function compareScored(a, b) {
    const taskA = a && a.task ? a.task : a;
    const taskB = b && b.task ? b.task : b;
    return (
      (b.score || 0) - (a.score || 0) ||
      String(taskA.dueDate || '').localeCompare(String(taskB.dueDate || '')) ||
      taskA.name.localeCompare(taskB.name, 'zh-CN')
    );
  }

  BS.Priority = {
    examInfo: examInfo,
    examScore: examScore,
    scoreTask: scoreTask,
    scoreNewContent: scoreNewContent,
    compareScored: compareScored,
  };
})(typeof window !== 'undefined' ? window : globalThis);
