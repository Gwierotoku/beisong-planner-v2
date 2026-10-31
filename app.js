/* 背诵规划表 · 时间预算驱动的复习调度（界面层）
 * 业务逻辑在 js/core.js、review.js、duration.js、priority.js、budget.js、
 * scheduler.js、forecast.js、model.js 中，本文件只负责渲染与交互。
 */
(function () {
  'use strict';

  const C = BS.Core;
  const Model = BS.Model;
  const Review = BS.Review;
  const Duration = BS.Duration;
  const Budget = BS.Budget;
  const Scheduler = BS.Scheduler;
  const Forecast = BS.Forecast;

  const PAGE_UNITS = 32;
  const GROUP_OVERHEAD = 2;
  const MIN_SPLIT = 2;

  let state = Model.load();
  const storageOk = Model.save(state);

  const ui = {
    view: 'today',
    date: C.todayStr(),
    search: '',
    subjectFilter: 'all',
    sort: 'name',
    budgetDate: C.todayStr(),
    forecastStart: C.todayStr(),
    forecastDays: (state.settings && state.settings.forecastDays) || 14,
  };

  let lastPlan = null;
  let toastTimer = null;
  let reopenDetailId = null;

  /* ---------------- 基础辅助 ---------------- */

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $$(selector, root) {
    return Array.from((root || document).querySelectorAll(selector));
  }

  function findEntry(id) {
    return state.entries.find(function (entry) {
      return entry.id === id;
    });
  }

  function subjectById(id) {
    return state.subjects.find(function (subject) {
      return subject.id === id;
    });
  }

  function subjectName(id) {
    const subject = subjectById(id);
    return subject ? subject.name : '未分类';
  }

  function activeSubjects() {
    return state.subjects.filter(function (subject) {
      return !subject.archived;
    });
  }

  function sortedSubjects() {
    return state.subjects.slice().sort(function (a, b) {
      return (
        (a.archived ? 1 : 0) - (b.archived ? 1 : 0) ||
        (a.createdAt || '').localeCompare(b.createdAt || '')
      );
    });
  }

  function subjectEntryCount(id) {
    return state.entries.filter(function (entry) {
      return entry.subjectId === id;
    }).length;
  }

  function subjectTag(subjectId) {
    const subject = subjectById(subjectId);
    if (!subject) {
      return '<span class="subject-tag" style="background:#eeeeea;color:#77776f">未分类</span>';
    }
    const color = C.normalizeHex(subject.color) || Model.DEFAULT_COLOR;
    return (
      '<span class="subject-tag" style="background:' +
      color +
      ';color:' +
      C.readableText(color) +
      '" title="科目：' +
      esc(subject.name) +
      '">' +
      esc(subject.name) +
      '</span>'
    );
  }

  function esc(value) {
    return C.esc(value);
  }

  function logsOf(entry) {
    return Review.logsOf(entry, state.logs);
  }

  function taskTypeLabel(task) {
    if (!task) return '';
    if (task.type === 'learn') return '首次学习';
    if (task.type === 'remedial') return '补救学习（第 ' + task.remedialRound + ' 次复习未通过）';
    if (task.retry) return '第 ' + task.round + ' 次复习（补救后重做）';
    return '第 ' + task.round + ' 次复习';
  }

  function logTypeLabel(log) {
    if (log.type === 'learn') return '首次学习';
    if (log.type === 'remedial') return '补救学习（第 ' + log.round + ' 次）';
    return '第 ' + log.round + ' 次复习';
  }

  function recallLabel(recall) {
    return Review.RECALL_LABELS[recall] || '—';
  }

  function minutesText(minutes) {
    return C.fmtMinutes(minutes);
  }

  function budgetText(minutes) {
    const value = Number(minutes) || 0;
    return (value < 0 ? '-' : '') + C.fmtDuration(Math.abs(value));
  }

  function toast(message) {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      element.hidden = true;
    }, 3200);
  }

  function saveState() {
    const ok = Model.save(state);
    if (!ok) toast('数据保存失败，请检查浏览器是否禁用了本地存储。');
    return ok;
  }

  /* ---------------- 颜色选择 ---------------- */

  function presetColorButtons(selected) {
    const current = C.normalizeHex(selected) || Model.DEFAULT_COLOR;
    return C.PRESET_COLORS.map(function (color) {
      return (
        '<button type="button" class="color-choice' +
        (color === current ? ' selected' : '') +
        '" data-color="' +
        color +
        '" style="background:' +
        color +
        '" title="预设颜色 ' +
        color +
        '" aria-label="预设颜色 ' +
        color +
        '"></button>'
      );
    }).join('');
  }

  function colorPickerHtml(selected) {
    const color = C.normalizeHex(selected) || Model.DEFAULT_COLOR;
    return (
      '<div class="preset-colors">' +
      presetColorButtons(color) +
      '</div>' +
      '<label class="custom-color" title="打开取色器自定义颜色">' +
      '<input type="color" name="color" value="' +
      color +
      '" aria-label="自定义标签颜色">' +
      '<span>自定义</span>' +
      '</label>' +
      '<span class="color-preview subject-tag" style="background:' +
      color +
      ';color:' +
      C.readableText(color) +
      '">科目</span>'
    );
  }

  function updateColorPicker(form) {
    if (!form) return;
    const input = form.querySelector('input[name="color"]');
    if (!input) return;
    const color = C.normalizeHex(input.value) || Model.DEFAULT_COLOR;
    form.querySelectorAll('[data-color]').forEach(function (button) {
      button.classList.toggle('selected', button.dataset.color === color);
    });
    const preview = form.querySelector('.color-preview');
    if (preview) {
      preview.style.background = color;
      preview.style.color = C.readableText(color);
    }
  }

  function pickDefaultColor() {
    const used = new Set(
      state.subjects.map(function (subject) {
        return C.normalizeHex(subject.color);
      })
    );
    for (let i = 0; i < C.PRESET_COLORS.length; i++) {
      if (!used.has(C.PRESET_COLORS[i])) return C.PRESET_COLORS[i];
    }
    return C.PRESET_COLORS[state.subjects.length % C.PRESET_COLORS.length];
  }

  /* ---------------- 弹窗 ---------------- */

  function openModal(html, options) {
    const opts = options || {};
    const root = $('#modal-root');
    root.innerHTML =
      '<div class="modal-backdrop" data-dismissible="' +
      (opts.dismissible === false ? 'false' : 'true') +
      '">' +
      html +
      '</div>';
    document.body.style.overflow = 'hidden';
    const focusable =
      root.querySelector(
        '.modal input:not([type="hidden"]):not([disabled]), .modal select, .modal textarea'
      ) || root.querySelector('.modal button');
    if (focusable) {
      setTimeout(function () {
        try {
          focusable.focus();
        } catch (err) {
          /* 忽略聚焦失败 */
        }
      }, 30);
    }
  }

  function closeModal() {
    $('#modal-root').innerHTML = '';
    document.body.style.overflow = '';
    reopenDetailId = null;
  }

  /* ---------------- 今日复习 ---------------- */

  function budgetSummaryHtml(plan) {
    const date = plan.date;
    const rows = [];
    const subjects = sortedSubjects();
    const budget = plan.budget;
    const usage = plan.usage;

    subjects.forEach(function (subject) {
      const subjectBudget = budget.subjects[subject.id] || 0;
      const usageRow = usage.bySubject[subject.id] || { actual: 0, direct: 0, general: 0 };
      const planned = plan.plannedBySubject[subject.id] || 0;
      if (
        !subjectBudget &&
        !usageRow.actual &&
        !planned &&
        !subjectEntryCount(subject.id)
      ) {
        return;
      }
      const used = usageRow.direct;
      const remaining = Math.max(0, subjectBudget - used - planned);
      const plannedPercent = subjectBudget > 0 ? Math.min(100, (planned / subjectBudget) * 100) : planned > 0 ? 100 : 0;
      const usedPercent = subjectBudget > 0 ? Math.min(100, (used / subjectBudget) * 100) : used > 0 ? 100 : 0;
      const overflow = used + planned > subjectBudget + 0.01;
      rows.push(
        '<div class="budget-row' +
          (overflow ? ' is-over' : '') +
          '">' +
          '<div class="budget-subject">' +
          subjectTag(subject.id) +
          (subject.archived ? '<span class="mini-tag">已停用</span>' : '') +
          '</div>' +
          '<div class="budget-bar" title="已用 ' +
          minutesText(used) +
          ' · 计划 ' +
          minutesText(planned) +
          '">' +
          '<span class="bar-used" style="width:' +
          usedPercent +
          '%"></span>' +
          '<span class="bar-planned" style="left:' +
          usedPercent +
          '%;width:' +
          plannedPercent +
          '%"></span>' +
          '</div>' +
          '<div class="budget-numbers">' +
          '<span>预算 <strong>' +
          budgetText(subjectBudget) +
          '</strong></span>' +
          '<span>已用 <strong>' +
          budgetText(used) +
          '</strong></span>' +
          '<span>计划 <strong>' +
          budgetText(planned) +
          '</strong></span>' +
          '<span>剩余 <strong>' +
          budgetText(remaining) +
          '</strong></span>' +
          (usageRow.general > 0
            ? '<span class="muted">借用通用 ' + budgetText(usageRow.general) + '</span>'
            : '') +
          '</div>' +
          '</div>'
      );
    });

    const generalUsed = usage.generalUsed || 0;
    const generalPercent =
      budget.general > 0 ? Math.min(100, (generalUsed / budget.general) * 100) : generalUsed > 0 ? 100 : 0;
    const generalPlannedPercent =
      budget.general > 0
        ? Math.min(100, (plan.plannedGeneral / budget.general) * 100)
        : plan.plannedGeneral > 0
        ? 100
        : 0;
    rows.push(
      '<div class="budget-row budget-general' +
        (generalUsed + plan.plannedGeneral > budget.general + 0.01 ? ' is-over' : '') +
        '">' +
        '<div class="budget-subject"><span class="subject-tag tag-general">通用预算</span></div>' +
        '<div class="budget-bar">' +
        '<span class="bar-used" style="width:' +
        generalPercent +
        '%"></span>' +
        '<span class="bar-planned" style="left:' +
        generalPercent +
        '%;width:' +
        generalPlannedPercent +
        '%"></span>' +
        '</div>' +
        '<div class="budget-numbers">' +
        '<span>预算 <strong>' +
        budgetText(budget.general) +
        '</strong></span>' +
        '<span>已用 <strong>' +
        budgetText(generalUsed) +
        '</strong></span>' +
        '<span>计划 <strong>' +
        budgetText(plan.plannedGeneral) +
        '</strong></span>' +
        '<span>剩余 <strong>' +
        budgetText(Math.max(0, budget.general - generalUsed - plan.plannedGeneral)) +
        '</strong></span>' +
        '</div>' +
        '</div>'
    );

    const remaining = budget.total - usage.actualTotal - plan.plannedTotal;
    const remainingGeneral = Math.max(
      0,
      budget.general - generalUsed - plan.plannedGeneral
    );
    const remainingSubjects = Math.max(0, remaining - remainingGeneral);
    return (
      '<section class="panel budget-summary no-print">' +
      '<div class="budget-head">' +
      '<div>' +
      '<h2>' +
      (date === C.todayStr() ? '今日时间预算' : '当日时间预算') +
      '</h2>' +
      '<div class="budget-source">来源：' +
      esc(Budget.sourceText(budget)) +
      ' · <button type="button" class="btn-link" data-action="goto-budget-date" data-date="' +
      esc(date) +
      '">调整预算</button></div>' +
      '</div>' +
      '<div class="budget-total">' +
      '<div><span class="muted">总预算</span><strong>' +
      budgetText(budget.total) +
      '</strong></div>' +
      '<div><span class="muted">已用</span><strong>' +
      budgetText(usage.actualTotal) +
      '</strong></div>' +
      '<div><span class="muted">计划</span><strong>' +
      budgetText(plan.plannedTotal) +
      '</strong></div>' +
      '<div><span class="muted">剩余</span><strong class="' +
      (remaining < 0 ? 'is-negative' : '') +
      '">' +
      budgetText(remaining) +
      '</strong></div>' +
      '</div>' +
      '</div>' +
      '<div class="budget-rows">' +
      rows.join('') +
      '</div>' +
      '<p class="budget-note">剩余中 <strong>' +
      budgetText(remainingGeneral) +
      '</strong> 是通用余额，可跨科目使用；其余 <strong>' +
      budgetText(remainingSubjects) +
      '</strong> 是分科余额，只能用于对应科目。' +
      (budget.allowForced === false ? ' 今天已关闭强制安排。' : '') +
      '</p>' +
      '<p class="budget-note">专属预算只给本科目使用；专属不够时可以借用通用预算。未执行任务的用时只算「计划」，不计入「已用」。</p>' +
      '</section>'
    );
  }

  function warningsHtml(plan) {
    if (!plan.warnings.length) return '';
    return (
      '<div class="warn-list no-print">' +
      plan.warnings
        .map(function (warning) {
          return (
            '<div class="warn-item ' +
            (warning.type === 'danger' ? 'is-danger' : 'is-warning') +
            '">' +
            esc(warning.text) +
            '</div>'
          );
        })
        .join('') +
      '</div>'
    );
  }

  function taskBadges(task) {
    const tags = [];
    if (task.type === 'remedial') tags.push('<span class="mini-tag tag-remedial">补救</span>');
    if (task.isNewContent) tags.push('<span class="mini-tag tag-new">新内容</span>');
    if (task.early) {
      tags.push(
        '<span class="mini-tag tag-early" title="原定 ' +
          esc(C.fmtShort(task.dueDate)) +
          '">提前 ' +
          task.earlyDays +
          ' 天</span>'
      );
    }
    if (task.deferralDays > 0) {
      const grace = task.graceDays || 2;
      tags.push(
        '<span class="mini-tag tag-overdue" title="可延迟 ' +
          grace +
          ' 天">' +
          (task.deferralDays >= grace ? '逾期 ' : '延期 ') +
          task.deferralDays +
          ' 天</span>'
      );
    }
    if (task.partial) tags.push('<span class="mini-tag tag-partial">压缩</span>');
    if (task.forced) tags.push('<span class="mini-tag tag-force">强制</span>');
    return tags.join('');
  }

  function allocationText(task) {
    const allocation = task.allocation || { subject: 0, general: 0 };
    const parts = [];
    if (!task.subjectId) {
      parts.push('通用 ' + minutesText(allocation.total || allocation.general));
    } else {
      parts.push('专属 ' + minutesText(allocation.subject));
      if (allocation.general > 0) parts.push('通用 ' + minutesText(allocation.general));
    }
    return parts.join(' + ');
  }

  function taskRowHtml(task) {
    return (
      '<div class="today-row">' +
      '<div class="today-name">' +
      '<span class="name-text">' +
      esc(task.name) +
      '</span>' +
      taskBadges(task) +
      '<button type="button" class="why-btn no-print" data-action="task-why" data-key="' +
      esc(task.key) +
      '" title="为什么安排在今天" aria-label="查看安排原因">?</button>' +
      '</div>' +
      '<div class="today-minutes">' +
      '<span class="minutes-main">' +
      minutesText(task.plannedMinutes) +
      '</span>' +
      '<span class="alloc-line">' +
      allocationText(task) +
      '</span>' +
      '</div>' +
      '<button type="button" class="today-check" data-action="complete-task" data-key="' +
      esc(task.key) +
      '" title="记录完成情况" aria-label="标记完成：' +
      esc(task.name) +
      '"' +
      (task.isFuture ? ' disabled' : '') +
      '>✓</button>' +
      '</div>'
    );
  }

  function groupAssignments(assignments) {
    const known = new Set(
      state.subjects.map(function (subject) {
        return subject.id;
      })
    );
    const bySubject = new Map();
    assignments.forEach(function (task) {
      const key = known.has(task.subjectId) ? task.subjectId : '__none__';
      if (!bySubject.has(key)) bySubject.set(key, []);
      bySubject.get(key).push(task);
    });
    const groups = [];
    state.subjects.forEach(function (subject) {
      if (bySubject.has(subject.id)) {
        groups.push({ subject: subject, rows: bySubject.get(subject.id) });
        bySubject.delete(subject.id);
      }
    });
    if (bySubject.has('__none__')) {
      groups.push({ subject: null, rows: bySubject.get('__none__') });
    }
    return groups;
  }

  function paginateGroups(groups) {
    const pages = [];
    let current = { groups: [], units: 0 };

    groups.forEach(function (group) {
      let remaining = group.rows.slice();
      let chunkIndex = 0;

      while (remaining.length) {
        const space = PAGE_UNITS - current.units;
        if (space < GROUP_OVERHEAD + MIN_SPLIT) {
          if (current.groups.length) {
            pages.push(current);
            current = { groups: [], units: 0 };
          }
          continue;
        }
        const capacity = Math.floor(space - GROUP_OVERHEAD);
        const take = Math.min(remaining.length, capacity);
        if (take <= 0) {
          pages.push(current);
          current = { groups: [], units: 0 };
          continue;
        }
        const chunkRows = remaining.slice(0, take);
        current.groups.push({
          subject: group.subject,
          rows: chunkRows,
          continuation: chunkIndex > 0,
          minutes: chunkRows.reduce(function (sum, row) {
            return sum + row.plannedMinutes;
          }, 0),
        });
        current.units += GROUP_OVERHEAD + take;
        remaining = remaining.slice(take);
        chunkIndex += 1;
        if (remaining.length) {
          pages.push(current);
          current = { groups: [], units: 0 };
        }
      }
    });

    if (current.groups.length) pages.push(current);
    return pages;
  }

  function subjectGroupHtml(group) {
    const subject = group.subject;
    const color = subject ? C.normalizeHex(subject.color) || Model.DEFAULT_COLOR : '#eeeeea';
    const textColor = subject ? C.readableText(color) : '#77776f';
    const name = subject ? esc(subject.name) : '未分类';
    return (
      '<section class="subject-group">' +
      '<div class="subject-group-head">' +
      '<div class="subject-group-name">' +
      '<span class="subject-group-tag" style="background:' +
      color +
      ';color:' +
      textColor +
      '">' +
      name +
      '</span>' +
      (group.continuation ? '<span class="group-cont">（续）</span>' : '') +
      '</div>' +
      '<div class="subject-group-time">计划 ' +
      minutesText(group.minutes) +
      '</div>' +
      '</div>' +
      '<div class="subject-group-rows">' +
      group.rows.map(taskRowHtml).join('') +
      '</div>' +
      '</section>'
    );
  }

  function paperHeadHtml(plan, isToday, pageIndex, pageCount) {
    const summary = plan.summary;
    const date = plan.date;
    const overdue = plan.assignments.filter(function (task) {
      return task.deferralDays > 0;
    }).length;
    return (
      '<div class="paper-head">' +
      '<div>' +
      '<div class="paper-title">' +
      esc(C.fmtLong(date)) +
      ' · ' +
      (isToday ? '今日复习' : '复习清单') +
      '</div>' +
      '<div class="paper-sub">' +
      '任务 ' +
      (summary.scheduledDue + summary.newContentCount + (summary.earlyCount || 0)) +
      ' 条（到期 ' +
      summary.scheduledDue +
      (summary.newContentCount ? ' · 新内容 ' + summary.newContentCount : '') +
      (summary.earlyCount ? ' · 提前 ' + summary.earlyCount : '') +
      '） · 计划 ' +
      Math.round(summary.plannedTotal) +
      ' 分钟 · 预算 ' +
      Math.round(summary.budgetTotal) +
      ' 分钟' +
      (overdue ? ' · 延期/逾期 ' + overdue + ' 条' : '') +
      (summary.unscheduledCount ? ' · 未安排 ' + summary.unscheduledCount + ' 条' : '') +
      '</div>' +
      '</div>' +
      '<div class="paper-page">第 ' +
      pageIndex +
      ' / ' +
      pageCount +
      ' 页</div>' +
      '</div>'
    );
  }

  function renderToday() {
    const root = $('#view-today');
    if (!root) return;
    const today = C.todayStr();
    const date = ui.date || today;
    const isToday = date === today;
    const isFuture = date > today;
    const plan = Scheduler.scheduleDay(state, date);
    lastPlan = plan;

    plan.assignments.forEach(function (task) {
      task.isFuture = isFuture;
    });

    const groups = groupAssignments(plan.assignments);
    const pages = paginateGroups(groups);
    const pageCount = Math.max(1, pages.length);
    const doneLogs = state.logs
      .filter(function (log) {
        return log.completed !== false && log.date === date;
      })
      .sort(function (a, b) {
        return String(b.at || '').localeCompare(String(a.at || ''));
      });

    let toolbar =
      '<div class="toolbar no-print">' +
      '<label class="inline-field">查看日期' +
      '<input type="date" class="date-input" id="today-date" value="' +
      esc(date) +
      '">' +
      '</label>' +
      '<button type="button" class="btn btn-small" data-action="today-reset"' +
      (isToday ? ' disabled' : '') +
      '>回到今天</button>' +
      '<span class="stat-line">任务 <strong>' +
      plan.assignments.length +
      '</strong> 条（到期 <strong>' +
      plan.summary.scheduledDue +
      '</strong>' +
      (plan.summary.newContentCount
        ? ' · 新内容 <strong>' + plan.summary.newContentCount + '</strong>'
        : '') +
      (plan.summary.earlyCount
        ? ' · 提前 <strong>' + plan.summary.earlyCount + '</strong>'
        : '') +
      '） · 计划 <strong>' +
      Math.round(plan.summary.plannedTotal) +
      '</strong> 分钟 · 预算 <strong>' +
      Math.round(plan.summary.budgetTotal) +
      '</strong> 分钟' +
      (plan.summary.unscheduledCount
        ? ' · <span class="overdue-strong">未安排 ' + plan.summary.unscheduledCount + ' 条</span>'
        : '') +
      '</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-primary" data-action="print">打印 / 导出 PDF</button>' +
      '</div>';

    let notice = '';
    const pinCount = state.entries.filter(function (entry) {
      return entry.pendingTask && entry.pendingTask.legacyPin;
    }).length;
    if (state.meta.pinPending && pinCount) {
      notice =
        '<div class="notice-banner no-print">' +
        '<div>已为 <strong>' +
        pinCount +
        '</strong> 条旧条目保留原计划日期。你可以保留旧计划，或改用新规则重新排期。</div>' +
        '<div class="notice-actions">' +
        '<button type="button" class="btn btn-small" data-action="pin-keep">保留旧计划</button>' +
        '<button type="button" class="btn btn-small" data-action="pin-reschedule">改用新规则重排</button>' +
        '</div>' +
        '</div>';
    } else if (state.meta.notice) {
      notice =
        '<div class="notice-banner no-print">' +
        '<div>' +
        esc(state.meta.notice) +
        '</div>' +
        '<button type="button" class="btn btn-small" data-action="dismiss-notice">知道了</button>' +
        '</div>';
    }

    let pagesHtml = '';
    if (!plan.assignments.length) {
      pagesHtml =
        '<div class="paper">' +
        paperHeadHtml(plan, isToday, 1, 1) +
        emptyPaperHtml(isToday, doneLogs.length, plan) +
        '</div>';
    } else {
      pages.forEach(function (page, index) {
        pagesHtml +=
          '<div class="paper">' +
          paperHeadHtml(plan, isToday, index + 1, pageCount) +
          '<div class="paper-body">' +
          page.groups.map(subjectGroupHtml).join('') +
          '</div>' +
          '</div>';
      });
    }

    const unscheduledHtml = renderUnscheduled(plan);
    const doneHtml = renderDoneLogs(doneLogs, date);
    const extraNote =
      !isToday && !isFuture
        ? '<p class="view-hint no-print">历史日期展示的是按当前数据与预算重新计算的结果；真实执行情况以下方「已完成」记录为准。</p>'
        : !isToday && isFuture
        ? '<p class="view-hint no-print">未来日期只按当前数据预演；到期前预算和记录变化都会重新计算。</p>'
        : '';

    root.innerHTML =
      notice +
      toolbar +
      warningsHtml(plan) +
      budgetSummaryHtml(plan) +
      extraNote +
      pagesHtml +
      unscheduledHtml +
      doneHtml;
  }

  function emptyPaperHtml(isToday, doneCount, plan) {
    let title;
    let desc;
    let button = '';
    if (!state.entries.length) {
      if (!activeSubjects().length) {
        title = '还没有科目';
        desc = '先在「科目设置」里建立科目，再回来添加要背的条目。';
        button =
          '<button type="button" class="btn btn-primary no-print" data-action="goto-subjects">去添加科目</button>';
      } else {
        title = '还没有条目';
        desc = '添加条目后，系统会按每天的时间预算自动安排学习与复习。';
        button =
          '<button type="button" class="btn btn-primary no-print" data-action="new-entry">添加第一个条目</button>';
      }
    } else if (plan.unscheduled.length) {
      title = '今天的预算不足以安排所有到期任务';
      desc = '有 ' + plan.unscheduled.length + ' 条任务没排进今天，可以在下方查看原因，或者提高今天的预算。';
      button =
        '<button type="button" class="btn no-print" data-action="goto-budget-date" data-date="' +
        esc(plan.date) +
        '">调整今天的预算</button>';
    } else if (doneCount) {
      title = isToday ? '今天的任务已经完成' : '这一天的任务已经完成';
      desc = '可以在下方撤销记录，或查看其他日期。';
    } else {
      title = isToday ? '今天没有需要安排的任务' : '这一天没有需要安排的任务';
      desc = '可以在「预算与标签」里调整每天可用时间，或在「条目管理」里添加新内容。';
      button =
        '<button type="button" class="btn no-print" data-action="goto-entries">查看全部条目</button>';
    }
    return (
      '<div class="paper-empty">' +
      '<div class="paper-empty-title">' +
      esc(title) +
      '</div>' +
      '<div class="paper-empty-desc">' +
      esc(desc) +
      '</div>' +
      button +
      '</div>'
    );
  }

  function renderUnscheduled(plan) {
    const rows = plan.unscheduled;
    const newRows = plan.newContentDeferred;
    if (!rows.length && !newRows.length) return '';

    let html = '<div class="unscheduled-panel no-print">';
    if (rows.length) {
      html +=
        '<details open><summary>今天没安排下的到期任务（' +
        rows.length +
        '）</summary><ul class="unscheduled-list">' +
        rows
          .map(function (task) {
            return (
              '<li>' +
              '<div class="unscheduled-name">' +
              esc(task.name) +
              subjectTag(task.subjectId) +
              '</div>' +
              '<div class="unscheduled-meta">' +
              esc(task.reason) +
              ' · 预计 ' +
              minutesText(task.estimateMinutes) +
              ' · 缺口 ' +
              minutesText(task.deficit) +
              '</div>' +
              '<div class="unscheduled-actions">' +
              '<button type="button" class="btn btn-small" data-action="task-why" data-key="' +
              esc(task.key) +
              '">为什么</button>' +
              '</div>' +
              '</li>'
            );
          })
          .join('') +
        '</ul></details>';
    }
    if (newRows.length) {
      html +=
        '<details><summary>新内容暂未启动（' +
        newRows.length +
        '）</summary><ul class="unscheduled-list">' +
        newRows
          .map(function (task) {
            return (
              '<li>' +
              '<div class="unscheduled-name">' +
              esc(task.name) +
              subjectTag(task.subjectId) +
              '</div>' +
              '<div class="unscheduled-meta">' +
              esc(task.reason) +
              '</div>' +
              '</li>'
            );
          })
          .join('') +
        '</ul></details>';
    }
    html += '</div>';
    return html;
  }

  function renderDoneLogs(logs, date) {
    if (!logs.length) return '';
    return (
      '<details class="done-panel no-print" open><summary>' +
      (date === C.todayStr() ? '今日' : '该日') +
      '已完成 ' +
      logs.length +
      ' 条</summary><ul class="done-list">' +
      logs
        .map(function (log) {
          const entry = findEntry(log.entryId);
          const name = entry ? entry.name : '（条目已删除）';
          const allocation =
            (log.subjectBudgetMinutes || 0) + (log.generalBudgetMinutes || 0);
          return (
            '<li>' +
            '<span class="done-name">' +
            esc(name) +
            (entry ? subjectTag(entry.subjectId) : '') +
            '</span>' +
            '<span class="done-meta">' +
            esc(logTypeLabel(log)) +
            ' · 实际 ' +
            minutesText(log.actualMinutes) +
            ' / 计划 ' +
            minutesText(log.plannedMinutes) +
            ' · 回忆 ' +
            recallLabel(log.recall) +
            (allocation ? ' · 计划预算 ' + minutesText(allocation) : '') +
            (log.partial ? ' · 部分完成（未推进轮次）' : '') +
            (log.note ? ' · ' + esc(log.note) : '') +
            (log.legacy ? ' · 旧数据' : '') +
            '</span>' +
            '<button type="button" class="btn btn-small" data-action="undo-log" data-id="' +
            esc(log.id) +
            '">撤销</button>' +
            '</li>'
          );
        })
        .join('') +
      '</ul></details>'
    );
  }

  /* ---------------- 完成与撤销 ---------------- */

  function findPlanTask(key) {
    if (!lastPlan) return null;
    return (
      lastPlan.assignments.find(function (task) {
        return task.key === key;
      }) ||
      lastPlan.unscheduled.find(function (task) {
        return task.key === key;
      }) ||
      null
    );
  }

  function openCompleteModal(task, options) {
    if (!task) {
      toast('找不到这个任务，可能已经被重新安排。');
      return;
    }
    const opts = options || {};
    const entry = findEntry(task.entryId);
    if (!entry) return;
    const planned = task.plannedMinutes || task.estimateMinutes || entry.firstMinutes;
    const allocation = task.allocation || { subject: 0, general: 0, total: 0 };
    const date = opts.date || ui.date || C.todayStr();
    reopenDetailId = opts.reopenDetail ? entry.id : null;

    openModal(
      '<form id="complete-form" class="modal" data-key="' +
        esc(task.key) +
        '" autocomplete="off">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">记录完成：' +
        esc(entry.name) +
        '</h2>' +
        '<div class="modal-subtitle">' +
        esc(taskTypeLabel(task)) +
        ' · 预计 ' +
        minutesText(task.estimateMinutes) +
        ' · 今日分配 ' +
        minutesText(planned) +
        '</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="complete-info">' +
        '<span>原始建议日期：<strong>' +
        (task.dueDate ? esc(C.fmtShort(task.dueDate)) : '—') +
        '</strong></span>' +
        '<span>本次预算：<strong>' +
        esc(allocationText(task)) +
        '</strong></span>' +
        '<span>完成日期：<strong>' +
        esc(C.fmtShort(date)) +
        '</strong></span>' +
        '</div>' +
        (task.partial
          ? '<div class="field"><span class="field-label">本次完成方式</span>' +
            '<label class="checkbox-line"><input type="radio" name="completionMode" value="partial" checked> <span>只完成分配的部分（只记时间，不推进复习轮次）</span></label>' +
            '<label class="checkbox-line"><input type="radio" name="completionMode" value="full"> <span>已完整复习本轮（推进轮次，按回忆结果调整间隔）</span></label>' +
            '<p class="hint">这次预算只够压缩安排；默认不会把压缩的几分钟当成完整一轮。</p></div>'
          : '<input type="hidden" name="completionMode" value="full">') +
        '<div class="field"><label for="actual-minutes">实际用时（分钟）</label>' +
        '<input type="number" class="number-input" id="actual-minutes" name="actualMinutes" min="0.1" max="600" step="0.1" required value="' +
        Math.max(0.1, Math.round(planned * 10) / 10) +
        '">' +
        '<p class="hint">只记录实际投入的时间；系统会用实际值与计划值的差异修正以后的预计用时。</p></div>' +
        '<div class="field"><label for="recall">回忆结果</label>' +
        '<select class="select-input" id="recall" name="recall">' +
        '<option value="easy">顺利 —— 很快想起来，可适当拉长间隔</option>' +
        '<option value="normal" selected>正常 —— 想起来了，维持节奏</option>' +
        '<option value="hard">困难 —— 想得很吃力，缩短间隔</option>' +
        '<option value="fail">失败 —— 基本没想起来，安排补救学习</option>' +
        '</select>' +
        '<p class="hint">回忆结果只影响复习间隔，不影响耗时估计。</p></div>' +
        '<div class="field"><label for="actual-difficulty">本次难度</label>' +
        '<select class="select-input" id="actual-difficulty" name="difficulty">' +
        [1, 2, 3, 4, 5]
          .map(function (value) {
            return (
              '<option value="' +
              value +
              '"' +
              (value === (entry.difficulty || 3) ? ' selected' : '') +
              '>' +
              value +
              ' / 5</option>'
            );
          })
          .join('') +
        '</select></div>' +
        '<div class="field"><label for="complete-note">备注（可选）</label>' +
        '<input type="text" class="text-input" id="complete-note" name="note" maxlength="120" placeholder="例如：第三段还不太熟"></div>' +
        '<p class="form-error" hidden></p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn" data-close>取消</button>' +
        '<button type="submit" class="btn btn-primary">保存记录</button>' +
        '</div>' +
        '</form>',
      { dismissible: false }
    );
  }

  function completeTask(task, values) {
    const entry = findEntry(task.entryId);
    if (!entry) return;
    const today = C.todayStr();
    const date = (ui.date || today) <= today ? ui.date || today : today;
    const derivedBefore = Review.derive(entry, state.logs);
    const advance = values.completionMode !== 'partial';
    const isPartial = !advance;
    const planned = isPartial
      ? task.plannedMinutes || task.allocation && task.allocation.total || 0
      : task.estimateMinutes || entry.firstMinutes;
    const allocation = task.allocation || { subject: 0, general: 0 };
    const reopenId = reopenDetailId;
    // 只有真正完成这一轮时才让恢复出来的临时任务失效；部分完成要保留原到期日
    if (advance) entry.pendingTask = null;

    const log = {
      id: C.uid('l'),
      entryId: entry.id,
      type: task.type,
      round: task.round,
      date: date,
      at: C.nowIso(),
      plannedMinutes: C.round1(planned),
      actualMinutes: C.round1(values.actualMinutes),
      recall: values.recall,
      difficulty: values.difficulty,
      needsRelearn: values.recall === 'fail',
      completed: true,
      note: values.note || '',
      dueDate: task.dueDate || null,
      theoryDueDate: task.theoryDueDate || null,
      intervalDays: task.intervalDays || 0,
      theoryIntervalDays: task.theoryIntervalDays || 0,
      scheduledDate: ui.date || date,
      subjectBudgetMinutes: allocation.subject || 0,
      generalBudgetMinutes: allocation.general || 0,
      firstDateBefore: null,
      partial: isPartial,
      legacy: false,
    };

    if (task.type === 'learn' && advance) {
      log.firstDateBefore = entry.firstDate || null;
      entry.firstDate = date;
      entry.prepared = false;
    }

    state.logs.push(log);
    entry.updatedAt = C.nowIso();
    saveState();
    closeModal();
    render();

    if (isPartial) {
      toast(
        '已记录 ' +
          minutesText(values.actualMinutes) +
          '；本轮未完成，任务会保留，不推进复习轮次。'
      );
      if (reopenId) openEntryDetail(reopenId);
      return;
    }

    const preview = Review.previewAfterCompletion(entry, derivedBefore, values.recall, date);
    if (reopenId) {
      openEntryDetail(reopenId);
    }

    if (values.recall === 'fail') {
      toast('已记录：回忆失败，' + C.fmtShort(preview.dueDate) + '安排补救学习。');
    } else if (preview.retry) {
      const retryRound = derivedBefore.retryRound || derivedBefore.remedialRound || task.round;
      toast('补救完成，' + C.fmtShort(preview.dueDate) + '重做第 ' + retryRound + ' 次复习。');
    } else {
      toast(
        '已记录' +
          taskTypeLabel(task) +
          '，下次建议 ' +
          C.fmtShort(preview.dueDate) +
          '（间隔 ' +
          preview.intervalDays +
          ' 天）。'
      );
    }
  }

  function undoLog(id) {
    const log = state.logs.find(function (item) {
      return item.id === id;
    });
    if (!log) return;
    const entry = findEntry(log.entryId);
    const isLearn = log.type === 'learn';
    if (log.partial) {
      if (!confirm('撤销这条部分完成记录吗？它只记录了时间，没有推进复习轮次。')) return;
      state.logs = state.logs.filter(function (item) {
        return item.id !== log.id;
      });
      saveState();
      closeModal();
      render();
      toast('部分完成记录已撤销，本轮状态没有变化。');
      return;
    }
    const entryLogs = entry ? Review.logsOf(entry, state.logs) : [];
    const index = entryLogs.findIndex(function (item) {
      return item.id === id;
    });
    const laterLogs = index >= 0 ? entryLogs.slice(index + 1) : [];

    if (isLearn) {
      if (
        entryLogs.length > 1 &&
        !confirm(
          '撤销首次学习会同时清除该条目的全部后续复习记录，并回到「首次学习未完成」状态。确定继续吗？'
        )
      ) {
        return;
      }
      state.logs = state.logs.filter(function (item) {
        return item.entryId !== log.entryId;
      });
      if (entry) {
        entry.prepared = true;
        entry.firstDate = log.firstDateBefore || log.dueDate || log.date;
        entry.pendingTask = null;
        entry.updatedAt = C.nowIso();
      }
    } else {
      if (laterLogs.length) {
        if (
          !confirm(
            '这条记录之后还有 ' +
              laterLogs.length +
              ' 条复习记录。撤销会一并回退这些记录，并把本次任务恢复到原来的到期日，确定继续吗？'
          )
        ) {
          return;
        }
      } else if (
        !confirm('撤销这条执行记录吗？任务会恢复到这次完成之前的状态，包括原来的到期日。')
      ) {
        return;
      }
      const removeIds = new Set([log.id]);
      laterLogs.forEach(function (item) {
        removeIds.add(item.id);
      });
      state.logs = state.logs.filter(function (item) {
        return !removeIds.has(item.id);
      });
      if (entry) {
        const intervalFallback = Review.theoryGap(log.round) || 0;
        entry.pendingTask = {
          type: log.type === 'remedial' ? 'remedial' : 'review',
          round: log.round || 1,
          dueDate: log.dueDate || log.date,
          theoryDueDate: log.theoryDueDate || log.dueDate || log.date,
          intervalDays: log.intervalDays || intervalFallback,
          theoryIntervalDays: log.theoryIntervalDays || intervalFallback,
          estimateMinutes: log.plannedMinutes || 0,
          scheduledDate: log.scheduledDate || log.date,
          createdAt: C.nowIso(),
        };
        entry.updatedAt = C.nowIso();
      }
    }

    saveState();
    closeModal();
    render();
    if (ui.view === 'today' && lastPlan) {
      const derivedAfter = entry ? Review.derive(entry, state.logs) : null;
      const assigned = lastPlan.assignments.some(function (task) {
        return task.entryId === log.entryId;
      });
      const pending =
        lastPlan.unscheduled.some(function (task) {
          return task.entryId === log.entryId;
        }) ||
        lastPlan.newContentDeferred.some(function (task) {
          return task.entryId === log.entryId;
        });
      if (assigned) {
        toast(
          '记录已撤销，任务已回到' +
            (ui.date === C.todayStr() ? '今日清单' : '当日清单') +
            '。'
        );
      } else if (pending) {
        toast('记录已撤销，但当日预算已不足，这条任务已转入「未安排任务」。');
      } else if (entry && entry.status !== 'active') {
        toast('记录已撤销；条目当前为暂停/归档状态，恢复后会重新安排。');
      } else if (derivedAfter && derivedAfter.dueDate && derivedAfter.dueDate > C.todayStr()) {
        toast('记录已撤销；这条内容下次安排在 ' + C.fmtShort(derivedAfter.dueDate) + '。');
      } else if (derivedAfter && !derivedAfter.learned) {
        toast('记录已撤销；这条内容回到待学习状态，有预算时会安排。');
      } else {
        toast('记录已撤销；这条内容目前没有到期任务。');
      }
    } else {
      toast('记录已撤销。');
    }
  }

  /* ---------------- 调度解释 ---------------- */

  function openWhyModal(key) {
    const task = findPlanTask(key);
    if (!task || !lastPlan) {
      toast('计划已经更新，请重新查看。');
      return;
    }
    const entry = findEntry(task.entryId);
    const reasonRows = (task.reasons || [])
      .map(function (reason) {
        return (
          '<tr><td>' +
          esc(reason.label) +
          '</td><td class="ta-right">+' +
          reason.value +
          '</td></tr>'
        );
      })
      .join('');
    const isAssigned = !!task.allocation;
    const allocation = task.allocation || { subject: 0, general: 0, total: 0 };
    const plan = lastPlan;

    openModal(
      '<div class="modal modal-wide">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">' +
        esc(task.name) +
        (entry ? subjectTag(entry.subjectId) : '') +
        '</h2>' +
        '<div class="modal-subtitle">' +
        esc(taskTypeLabel(task)) +
        (isAssigned ? ' · 已安排在 ' + esc(C.fmtShort(plan.date)) : ' · 当天未安排') +
        '</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="detail-meta">' +
        '<span>建议到期：<strong>' +
        (task.dueDate ? esc(C.fmtShort(task.dueDate)) : '—') +
        '</strong></span>' +
        '<span>理论日期：<strong>' +
        (task.theoryDueDate ? esc(C.fmtShort(task.theoryDueDate)) : '—') +
        '</strong></span>' +
        '<span>安排日期：<strong>' +
        esc(C.fmtShort(plan.date)) +
        '</strong></span>' +
        '<span>当前间隔：<strong>' +
        (task.intervalDays || 0) +
        ' 天</strong>（理论 ' +
        (task.theoryIntervalDays || 0) +
        ' 天）</span>' +
        '<span>可延迟：<strong>' +
        (task.graceDays || 2) +
        ' 天</strong></span>' +
        '<span>预计用时：<strong>' +
        minutesText(task.estimateMinutes) +
        '</strong></span>' +
        '<span>延期：<strong>' +
        (task.deferralDays ? task.deferralDays + ' 天' : '按时') +
        '</strong></span>' +
        '</div>' +
        (isAssigned
          ? '<div class="detail-meta">' +
            '<span>预算分配：<strong>' +
            esc(allocationText(task)) +
            '</strong></span>' +
            '<span>计划用时：<strong>' +
            minutesText(task.plannedMinutes) +
            '</strong></span>' +
            '<span>排序：<strong>第 ' +
            task.order +
            ' 位</strong></span>' +
            (task.partial ? '<span class="overdue-tag">预算不足，已压缩安排</span>' : '') +
            (task.forced
              ? '<span class="overdue-tag">已超过可延迟 ' +
                (task.graceDays || 2) +
                ' 天，强制安排（受预算上限约束）</span>'
              : '') +
            '</div>'
          : '<div class="detail-meta"><span>未安排原因：<strong>' +
            esc(task.reason || '预算不足') +
            '</strong></span><span>缺口：<strong>' +
            minutesText(task.deficit || 0) +
            '</strong></span></div>') +
        '<h3 class="sub-title">优先级得分：' +
        C.round1(task.score || 0) +
        '</h3>' +
        '<table class="rule-table"><thead><tr><th>因素</th><th class="ta-right">分值</th></tr></thead><tbody>' +
        reasonRows +
        '</tbody></table>' +
        '<h3 class="sub-title">当天预算</h3>' +
        '<table class="rule-table"><tbody>' +
        '<tr><td>总预算</td><td>' +
        budgetText(plan.budget.total) +
        '（专属 ' +
        budgetText(C.sumValues(plan.budget.subjects)) +
        ' + 通用 ' +
        budgetText(plan.budget.general) +
        '）</td></tr>' +
        '<tr><td>已完成实际用时</td><td>' +
        budgetText(plan.usage.actualTotal) +
        '</td></tr>' +
        '<tr><td>当天计划用时</td><td>' +
        budgetText(plan.plannedTotal) +
        '</td></tr>' +
        '<tr><td>已安排 / 到期</td><td>' +
        plan.summary.scheduledDue +
        ' / ' +
        plan.summary.dueCount +
        ' 条</td></tr>' +
        '</tbody></table>' +
        '<p class="detail-note">说明：到期任务按综合优先级排序后，先从科目专属预算扣减，不足部分再使用通用预算；预算不够全额时可能压缩安排。延迟容忍天数按间隔自动计算：间隔越长可推迟越久，1 个月约 5 天，最少 2 天、最多 14 天；超过后优先强制安排，但最多只超出当天可用预算的 25%，休息日/考试日可关闭强制。</p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn" data-close>关闭</button>' +
        '</div>' +
        '</div>',
      { dismissible: true }
    );
  }

  /* ---------------- 条目管理 ---------------- */

  function filteredEntries() {
    let list = state.entries.slice();
    const query = ui.search.trim().toLowerCase();
    if (query) {
      list = list.filter(function (entry) {
        return (
          entry.name.toLowerCase().indexOf(query) >= 0 ||
          subjectName(entry.subjectId).toLowerCase().indexOf(query) >= 0
        );
      });
    }
    if (ui.subjectFilter === '__none__') {
      list = list.filter(function (entry) {
        return !subjectById(entry.subjectId);
      });
    } else if (ui.subjectFilter !== 'all') {
      list = list.filter(function (entry) {
        return entry.subjectId === ui.subjectFilter;
      });
    }

    function nextDate(entry) {
      const derived = Review.derive(entry, state.logs);
      return derived.dueDate || entry.firstDate || '9999-99-99';
    }

    list.sort(function (a, b) {
      if (ui.sort === 'first') {
        return (b.firstDate || '').localeCompare(a.firstDate || '') || a.name.localeCompare(b.name, 'zh-CN');
      }
      if (ui.sort === 'next') {
        return nextDate(a).localeCompare(nextDate(b)) || a.name.localeCompare(b.name, 'zh-CN');
      }
      if (ui.sort === 'created') {
        return (b.createdAt || '').localeCompare(a.createdAt || '');
      }
      if (ui.sort === 'importance') {
        return (b.importance || 3) - (a.importance || 3) || a.name.localeCompare(b.name, 'zh-CN');
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return list;
  }

  function entryDueInfo(entry) {
    const today = C.todayStr();
    const derived = Review.derive(entry, state.logs);
    if (!derived.learned) {
      if (!entry.firstDate) return { text: '待安排首次学习', cls: 'muted' };
      if (entry.firstDate > today) {
        return { text: '预备诵 · ' + C.fmtShort(entry.firstDate) + ' 开始', cls: 'muted' };
      }
      const overdue = C.diffDays(entry.firstDate, today);
      return {
        text:
          '待首次学习 · ' +
          C.fmtShort(entry.firstDate) +
          (overdue ? '（逾期 ' + overdue + ' 天）' : ''),
        cls: 'danger',
      };
    }
    if (derived.finished) return { text: '全部完成', cls: 'muted' };
    const due = derived.dueDate;
    const overdue = C.diffDays(due, today);
    const prefix =
      derived.nextType === 'remedial'
        ? '补救'
        : derived.retryRound
        ? '重做第 ' + derived.nextRound + ' 次'
        : '第 ' + derived.nextRound + ' 次';
    let text = prefix + ' · ' + C.fmtShort(due);
    if (overdue > 0) text += '（逾期 ' + overdue + ' 天）';
    else if (due === today) text += '（今天）';
    return { text: text, cls: overdue > 0 ? 'danger' : '' };
  }

  function renderEntries() {
    const root = $('#view-entries');
    if (!root) return;
    if (
      ui.subjectFilter !== 'all' &&
      ui.subjectFilter !== '__none__' &&
      !subjectById(ui.subjectFilter)
    ) {
      ui.subjectFilter = 'all';
    }
    const subjectOptions = sortedSubjects()
      .map(function (subject) {
        return (
          '<option value="' +
          esc(subject.id) +
          '">' +
          esc(subject.name) +
          (subject.archived ? '（已停用）' : '') +
          '</option>'
        );
      })
      .join('');

    root.innerHTML =
      '<div class="view-head">' +
      '<div>' +
      '<h1 class="view-title">条目管理</h1>' +
      '<p class="view-desc">条目只保存稳定信息；每次完成的实际用时和回忆结果会形成执行记录，并用来调整间隔与预计耗时。修改首次学习日期会清空该条目的学习记录。</p>' +
      '</div>' +
      '<button type="button" class="btn btn-primary" data-action="new-entry">添加条目</button>' +
      '</div>' +
      '<div class="toolbar">' +
      '<input type="search" class="text-input" id="entry-search" placeholder="搜索条目名或科目…" value="' +
      esc(ui.search) +
      '" style="width:220px" aria-label="搜索条目">' +
      '<select class="select-input" id="entry-subject-filter" aria-label="按科目筛选">' +
      '<option value="all"' +
      (ui.subjectFilter === 'all' ? ' selected' : '') +
      '>全部科目</option>' +
      subjectOptions +
      (state.entries.some(function (entry) {
        return !subjectById(entry.subjectId);
      })
        ? '<option value="__none__"' +
          (ui.subjectFilter === '__none__' ? ' selected' : '') +
          '>未分类</option>'
        : '') +
      '</select>' +
      '<select class="select-input" id="entry-sort" aria-label="排序方式">' +
      '<option value="name"' +
      (ui.sort === 'name' ? ' selected' : '') +
      '>按名称</option>' +
      '<option value="importance"' +
      (ui.sort === 'importance' ? ' selected' : '') +
      '>按重要程度</option>' +
      '<option value="first"' +
      (ui.sort === 'first' ? ' selected' : '') +
      '>首次日期（新→旧）</option>' +
      '<option value="next"' +
      (ui.sort === 'next' ? ' selected' : '') +
      '>下次复习（近→远）</option>' +
      '<option value="created"' +
      (ui.sort === 'created' ? ' selected' : '') +
      '>添加时间（新→旧）</option>' +
      '</select>' +
      '<span class="spacer"></span>' +
      '<span class="table-count" id="entry-count"></span>' +
      '</div>' +
      '<div id="entry-table-wrap"></div>';

    renderEntryRows();
  }

  function renderEntryRows() {
    const wrap = $('#entry-table-wrap');
    if (!wrap) return;
    const list = filteredEntries();
    const countElement = $('#entry-count');
    if (countElement) countElement.textContent = '共 ' + list.length + ' 条';

    if (!state.entries.length) {
      wrap.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-title">还没有条目</div>' +
        '<div class="empty-state-desc">先添加科目，再添加要背诵的条目。系统会根据每天的预算自动排学习与复习。</div>' +
        '<button type="button" class="btn btn-primary" data-action="new-entry">添加第一个条目</button>' +
        '</div>';
      return;
    }
    if (!list.length) {
      wrap.innerHTML =
        '<div class="empty-state">' +
        '<div class="empty-state-title">没有匹配的条目</div>' +
        '<div class="empty-state-desc">换个关键词或科目筛选试试。</div>' +
        '</div>';
      return;
    }

    const rows = list
      .map(function (entry) {
        const derived = Review.derive(entry, state.logs);
        const estimate = Duration.estimateMinutes(entry, derived, state.logs);
        const dueInfo = entryDueInfo(entry);
        const progress = derived.learned
          ? derived.round + ' / ' + derived.totalRounds + ' 轮'
          : '0 / ' + derived.totalRounds + ' 轮';
        return (
          '<tr>' +
          '<td class="cell-name">' +
          '<button type="button" class="link-btn" data-action="entry-detail" data-id="' +
          esc(entry.id) +
          '" title="查看背诵详情">' +
          esc(entry.name) +
          '</button>' +
          subjectTag(entry.subjectId) +
          '<span class="mini-tag">重要 ' +
          (entry.importance || 3) +
          '</span>' +
          (entry.status === 'paused'
            ? '<span class="mini-tag tag-paused">已暂停</span>'
            : entry.status === 'archived'
            ? '<span class="mini-tag tag-paused">已归档</span>'
            : '') +
          '</td>' +
          '<td>' +
          progress +
          '</td>' +
          '<td class="' +
          dueInfo.cls +
          '">' +
          esc(dueInfo.text) +
          '</td>' +
          '<td>' +
          (derived.finished ? '—' : minutesText(estimate.minutes)) +
          '</td>' +
          '<td><select class="select-input status-select" data-status-id="' +
          esc(entry.id) +
          '" aria-label="条目状态">' +
          '<option value="active"' +
          (entry.status === 'active' ? ' selected' : '') +
          '>使用中</option>' +
          '<option value="paused"' +
          (entry.status === 'paused' ? ' selected' : '') +
          '>暂停</option>' +
          '<option value="archived"' +
          (entry.status === 'archived' ? ' selected' : '') +
          '>归档</option>' +
          '</select></td>' +
          '<td><div class="cell-actions">' +
          '<button type="button" class="btn btn-small" data-action="entry-detail" data-id="' +
          esc(entry.id) +
          '">详情</button>' +
          '<button type="button" class="btn btn-small" data-action="edit-entry" data-id="' +
          esc(entry.id) +
          '">编辑</button>' +
          '<button type="button" class="btn btn-small btn-danger" data-action="delete-entry" data-id="' +
          esc(entry.id) +
          '">删除</button>' +
          '</div></td>' +
          '</tr>'
        );
      })
      .join('');

    wrap.innerHTML =
      '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr><th>条目</th><th>进度</th><th>下次复习</th><th>预计用时</th><th>状态</th><th class="ta-right">操作</th></tr></thead>' +
      '<tbody>' +
      rows +
      '</tbody></table></div>';
  }

  /* ---------------- 条目表单 ---------------- */

  function subjectSelectOptions(selectedId, entry) {
    return sortedSubjects()
      .filter(function (subject) {
        return !subject.archived || (entry && subject.id === entry.subjectId);
      })
      .map(function (subject) {
        return (
          '<option value="' +
          esc(subject.id) +
          '"' +
          (subject.id === selectedId ? ' selected' : '') +
          '>' +
          esc(subject.name) +
          (subject.archived ? '（已停用）' : '') +
          '</option>'
        );
      })
      .join('');
  }

  function numberOptions(min, max, selected) {
    const out = [];
    for (let value = min; value <= max; value++) {
      out.push(
        '<option value="' +
          value +
          '"' +
          (value === selected ? ' selected' : '') +
          '>' +
          value +
          ' / 5</option>'
      );
    }
    return out.join('');
  }

  function openEntryForm(id) {
    const entry = id ? findEntry(id) : null;
    if (id && !entry) {
      toast('条目不存在，可能已被删除。');
      return;
    }
    const subjects = sortedSubjects().filter(function (subject) {
      return !subject.archived || (entry && subject.id === entry.subjectId);
    });
    if (!subjects.length) {
      toast('请先在「科目设置」中添加一个科目。');
      closeModal();
      switchView('subjects');
      return;
    }
    let selectedId = entry && subjectById(entry.subjectId) ? entry.subjectId : subjects[0].id;
    if (
      !subjects.some(function (subject) {
        return subject.id === selectedId;
      })
    ) {
      selectedId = subjects[0].id;
    }
    const queued = entry ? !entry.firstDate : false;

    openModal(
      '<form id="entry-form" class="modal" data-id="' +
        (entry ? esc(entry.id) : '') +
        '" autocomplete="off">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">' +
        (entry ? '编辑条目' : '添加条目') +
        '</h2>' +
        '<div class="modal-subtitle">' +
        (entry
          ? '修改首次学习日期会清空学习记录；只改名称、科目、用时不会。'
          : '首次学习日期可以是过去、今天或未来，也可以交给系统按预算安排。') +
        '</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="field"><label for="entry-name">条目名</label>' +
        '<input type="text" class="text-input" id="entry-name" name="name" maxlength="100" required placeholder="例如：英语单词 Unit 1" value="' +
        (entry ? esc(entry.name) : '') +
        '"></div>' +
        '<div class="field"><label for="entry-subject">科目</label>' +
        '<select class="select-input" id="entry-subject" name="subjectId" required>' +
        subjectSelectOptions(selectedId, entry) +
        '</select></div>' +
        '<div class="form-grid">' +
        '<div class="field"><label for="entry-importance">重要程度</label>' +
        '<select class="select-input" id="entry-importance" name="importance">' +
        numberOptions(1, 5, entry ? entry.importance || 3 : 3) +
        '</select></div>' +
        '<div class="field"><label for="entry-difficulty">初始难度</label>' +
        '<select class="select-input" id="entry-difficulty" name="difficulty">' +
        numberOptions(1, 5, entry ? entry.difficulty || 3 : 3) +
        '</select></div>' +
        '</div>' +
        '<div class="field"><label for="entry-minutes">首次学习用时（分钟）</label>' +
        '<input type="number" class="number-input" id="entry-minutes" name="firstMinutes" min="0.1" max="600" step="0.1" required placeholder="例如：15" value="' +
        (entry ? entry.firstMinutes : '') +
        '">' +
        '<p class="hint">作为预计用时的初始值；之后会用每次的实际用时修正。</p></div>' +
        '<div class="field">' +
        '<label class="checkbox-line"><input type="checkbox" name="queued"' +
        (queued ? ' checked' : '') +
        '> <span>首次学习日期由系统按预算安排（新内容队列）</span></label>' +
        '<p class="hint">勾选后条目不会固定日期，只有当天复习任务都安排完、还有剩余预算时才会启动。</p></div>' +
        '<div class="field"><label for="entry-date">首次学习日期</label>' +
        '<input type="date" class="date-input" id="entry-date" name="firstDate" value="' +
        (entry && entry.firstDate ? esc(entry.firstDate) : C.todayStr()) +
        '"' +
        (queued ? ' disabled' : '') +
        '>' +
        '<p class="hint">过去的日期会视为首次学习已完成，下一次复习立即进入待办；未来的日期作为预备诵。</p></div>' +
        '<p class="form-error" hidden></p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn" data-close>取消</button>' +
        '<button type="submit" class="btn btn-primary">保存</button>' +
        '</div>' +
        '</form>',
      { dismissible: false }
    );

    const form = $('#entry-form');
    const queuedBox = form.elements.queued;
    const dateInput = form.elements.firstDate;
    function syncQueued() {
      dateInput.disabled = !!queuedBox.checked;
    }
    queuedBox.addEventListener('change', syncQueued);
    syncQueued();
  }

  function makeManualLearnLog(entry, date) {
    return {
      id: C.uid('l'),
      entryId: entry.id,
      type: 'learn',
      round: 1,
      date: date,
      at: C.nowIso(),
      plannedMinutes: C.round1(entry.firstMinutes),
      actualMinutes: C.round1(entry.firstMinutes),
      recall: 'normal',
      difficulty: entry.difficulty || 3,
      needsRelearn: false,
      completed: true,
      note: '录入条目时视为已完成首次学习',
      dueDate: entry.firstDate || date,
      theoryDueDate: entry.firstDate || date,
      intervalDays: 1,
      theoryIntervalDays: 1,
      scheduledDate: date,
      subjectBudgetMinutes: 0,
      generalBudgetMinutes: 0,
      legacy: false,
      firstDateBefore: entry.firstDate || date,
    };
  }

  function handleEntrySubmit(form) {
    const id = form.dataset.id || null;
    const entry = id ? findEntry(id) : null;
    const name = form.elements.name.value.trim();
    const subjectId = form.elements.subjectId.value;
    const firstMinutes = Number(form.elements.firstMinutes.value);
    const importance = Number(form.elements.importance.value);
    const difficulty = Number(form.elements.difficulty.value);
    const queued = !!form.elements.queued.checked;
    const firstDate = queued ? null : form.elements.firstDate.value;
    const errorElement = form.querySelector('.form-error');

    function fail(message) {
      errorElement.textContent = message;
      errorElement.hidden = false;
      return false;
    }
    errorElement.hidden = true;

    if (!name) return fail('请填写条目名。');
    if (name.length > 100) return fail('条目名不能超过 100 个字符。');
    const subject = subjectById(subjectId);
    if (!subject) return fail('请选择一个科目。');
    if (subject.archived && !(entry && entry.subjectId === subject.id)) {
      return fail('这个科目已停用，请选择其他科目。');
    }
    if (!Number.isFinite(firstMinutes) || firstMinutes <= 0) {
      return fail('首次学习用时需要大于 0 分钟。');
    }
    if (firstMinutes > 600) return fail('首次学习用时不能超过 600 分钟。');
    if (!queued && !C.isValidYmd(firstDate)) return fail('请选择有效的首次学习日期。');

    const today = C.todayStr();
    let saved;

    if (entry) {
      const dateChanged = (entry.firstDate || null) !== (firstDate || null);
      const hasLogs = state.logs.some(function (log) {
        return log.entryId === entry.id;
      });
      if (
        dateChanged &&
        hasLogs &&
        !confirm('修改首次学习日期会清空该条目的全部学习记录，确定继续吗？')
      ) {
        return false;
      }
      entry.name = name;
      entry.subjectId = subject.id;
      entry.importance = importance;
      entry.difficulty = difficulty;
      entry.firstMinutes = C.round1(firstMinutes);
      entry.firstDate = firstDate;
      entry.updatedAt = C.nowIso();
      if (dateChanged) {
        state.logs = state.logs.filter(function (log) {
          return log.entryId !== entry.id;
        });
        entry.prepared = true;
        entry.pendingTask = null;
        if (firstDate && firstDate <= today) {
          state.logs.push(makeManualLearnLog(entry, firstDate));
          entry.prepared = false;
        }
      }
      saved = entry;
    } else {
      saved = {
        id: C.uid('e'),
        name: name,
        subjectId: subject.id,
        importance: importance,
        difficulty: difficulty,
        firstDate: firstDate,
        firstMinutes: C.round1(firstMinutes),
        prepared: true,
        status: 'active',
        note: '',
        createdAt: C.nowIso(),
      };
      state.entries.push(saved);
      if (firstDate && firstDate <= today) {
        state.logs.push(makeManualLearnLog(saved, firstDate));
        saved.prepared = false;
      }
    }

    saveState();
    closeModal();
    render();

    const derived = Review.derive(saved, state.logs);
    if (!derived.learned) {
      toast(
        saved.firstDate
          ? '已添加预备诵，首次学习日期：' + C.fmtShort(saved.firstDate) + '。'
          : '已加入新内容队列，会在预算允许时安排首次学习。'
      );
    } else if (derived.finished) {
      toast('已保存，这条内容的复习计划已全部完成。');
    } else {
      toast('已保存，下一次复习建议：' + C.fmtShort(derived.dueDate) + '。');
    }
    return true;
  }

  /* ---------------- 条目详情 ---------------- */

  function openEntryDetail(id) {
    const entry = findEntry(id);
    if (!entry) {
      toast('条目不存在，可能已被删除。');
      closeModal();
      return;
    }
    const derived = Review.derive(entry, state.logs);
    const estimate = Duration.estimateMinutes(entry, derived, state.logs);
    const actualTotal = Duration.totalActualMinutes(entry, state.logs);
    const logs = logsOf(entry).slice().reverse();
    const plan = Scheduler.collectTasks(state, C.todayStr()).find(function (task) {
      return task.entryId === entry.id;
    });

    const logsHtml = logs.length
      ? logs
          .map(function (log) {
            return (
              '<tr>' +
              '<td>' +
              C.fmtShort(log.date) +
              (log.legacy ? ' <span class="mini-tag">旧</span>' : '') +
              '</td>' +
              '<td>' +
              esc(logTypeLabel(log)) +
              (log.partial ? ' <span class="mini-tag tag-partial">部分完成</span>' : '') +
              '</td>' +
              '<td>' +
              minutesText(log.actualMinutes) +
              ' / ' +
              minutesText(log.plannedMinutes) +
              '</td>' +
              '<td>' +
              recallLabel(log.recall) +
              '</td>' +
              '<td>' +
              (log.note ? esc(log.note) : '—') +
              '</td>' +
              '<td class="ta-right"><button type="button" class="btn btn-small" data-action="undo-log" data-id="' +
              esc(log.id) +
              '">撤销</button></td>' +
              '</tr>'
            );
          })
          .join('')
      : '<tr><td colspan="6" class="muted">还没有执行记录。</td></tr>';

    const theoryRows = derived.learned && entry.firstDate
      ? Review.theoryPlan(entry.firstDate)
          .filter(function (item) {
            return item.round > derived.round && item.round <= derived.round + 6;
          })
          .map(function (item) {
            return (
              '<tr' +
              (item.round === derived.nextRound ? ' class="is-next"' : '') +
              '><td>第 ' +
              item.round +
              ' 次</td><td>' +
              C.fmtShort(item.date) +
              '</td><td>' +
              minutesText(entry.firstMinutes / Math.sqrt(item.round)) +
              '</td></tr>'
            );
          })
          .join('')
      : '';

    const nextLabel = derived.learned
      ? derived.finished
        ? '全部完成'
        : Review.taskLabel(derived) + ' · ' + C.fmtShort(derived.dueDate)
      : entry.firstDate
      ? '首次学习 · ' + C.fmtShort(entry.firstDate)
      : '首次学习 · 待系统安排';

    openModal(
      '<div class="modal modal-wide">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">' +
        esc(entry.name) +
        subjectTag(entry.subjectId) +
        '</h2>' +
        '<div class="modal-subtitle">背诵详情、学习记录与理论计划</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="detail-meta">' +
        '<span>科目：<strong>' +
        esc(subjectName(entry.subjectId)) +
        '</strong></span>' +
        '<span>首次学习：<strong>' +
        (entry.firstDate ? C.fmtShort(entry.firstDate) : '待安排') +
        '</strong></span>' +
        '<span>首次用时：<strong>' +
        minutesText(entry.firstMinutes) +
        '</strong></span>' +
        '<span>进度：<strong>' +
        (derived.learned ? derived.round : 0) +
        ' / ' +
        derived.totalRounds +
        ' 轮</strong></span>' +
        '<span>重要程度：<strong>' +
        (entry.importance || 3) +
        ' / 5</strong></span>' +
        '<span>状态：<strong>' +
        (entry.status === 'paused' ? '暂停' : entry.status === 'archived' ? '归档' : '使用中') +
        '</strong></span>' +
        '</div>' +
        '<div class="detail-meta">' +
        '<span>下次任务：<strong>' +
        esc(nextLabel) +
        '</strong></span>' +
        '<span>调整后间隔：<strong>' +
        (derived.intervalDays || 0) +
        ' 天</strong>（理论 ' +
        (derived.theoryIntervalDays || 0) +
        ' 天，可延迟 ' +
        Review.graceDaysForInterval(derived.intervalDays) +
        ' 天）</span>' +
        '<span>预计用时：<strong>' +
        (derived.finished ? '—' : minutesText(estimate.minutes)) +
        '</strong>' +
        (derived.finished
          ? '（已完成全部轮次）'
          : '（公式值 ' +
            minutesText(estimate.theoryMinutes) +
            '，参考 ' +
            estimate.samples +
            ' 条记录）') +
        '</span>' +
        '<span>累计实际用时：<strong>' +
        minutesText(actualTotal) +
        '</strong></span>' +
        '<span>回忆失败：<strong>' +
        derived.lapses +
        ' 次</strong></span>' +
        '</div>' +
        (plan && plan.dueDate <= C.todayStr()
          ? '<div class="btn-row"><button type="button" class="btn btn-primary btn-small" data-action="complete-entry-task" data-id="' +
            esc(entry.id) +
            '">补记下一次任务</button>' +
            '<span class="muted">按今天完成处理；如需修改完成日期，请在今日复习里切换日期后记录。</span></div>'
          : '') +
        '<h3 class="sub-title">执行记录（最新在前）</h3>' +
        '<div class="detail-scroll"><table class="detail-table">' +
        '<thead><tr><th>实际完成</th><th>类型</th><th>实际 / 计划</th><th>回忆</th><th>备注</th><th class="ta-right">操作</th></tr></thead>' +
        '<tbody>' +
        logsHtml +
        '</tbody></table></div>' +
        (theoryRows
          ? '<h3 class="sub-title">理论计划（仅作参考，实际按表现调整）</h3>' +
            '<div class="detail-scroll detail-scroll-small"><table class="detail-table">' +
            '<thead><tr><th>轮次</th><th>理论日期</th><th>公式用时</th></tr></thead><tbody>' +
            theoryRows +
            '</tbody></table></div>'
          : '') +
        '<p class="detail-note">复习间隔由回忆结果调整：顺利会拉长、困难会缩短、失败会在第二天安排补救学习，补救后第二天重做失败的那一轮；只有成功完成才进入下一轮。实际用时只用来修正预计耗时，不影响间隔。</p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn btn-small btn-danger foot-left" data-action="reset-entry-progress" data-id="' +
        esc(entry.id) +
        '">重置复习进度</button>' +
        '<button type="button" class="btn" data-action="edit-entry" data-id="' +
        esc(entry.id) +
        '">编辑条目</button>' +
        '<button type="button" class="btn btn-primary" data-close>关闭</button>' +
        '</div>' +
        '</div>',
      { dismissible: true }
    );
  }

  function resetEntryProgress(id) {
    const entry = findEntry(id);
    if (!entry) return;
    if (
      !confirm(
        '确定重置「' +
          entry.name +
          '」的复习进度吗？会删除除首次学习以外的全部执行记录，历史数据不可恢复。'
      )
    ) {
      return;
    }
    const learnLogs = state.logs.filter(function (log) {
      return log.entryId === entry.id && log.type === 'learn';
    });
    state.logs = state.logs.filter(function (log) {
      return log.entryId !== entry.id || log.type === 'learn';
    });
    entry.prepared = learnLogs.length === 0;
    entry.pendingTask = null;
    entry.updatedAt = C.nowIso();
    saveState();
    closeModal();
    render();
    openEntryDetail(id);
    toast('复习进度已重置，首次学习记录已保留。');
  }

  function deleteEntry(id) {
    const entry = findEntry(id);
    if (!entry) return;
    if (
      !confirm(
        '确定删除条目「' +
          entry.name +
          '」吗？它的全部执行记录也会一并删除，此操作不可撤销。'
      )
    ) {
      return;
    }
    state.entries = state.entries.filter(function (item) {
      return item.id !== id;
    });
    state.logs = state.logs.filter(function (log) {
      return log.entryId !== id;
    });
    saveState();
    closeModal();
    render();
    toast('条目已删除。');
  }

  /* ---------------- 预算与标签 ---------------- */

  function weeklyBudgetTableHtml() {
    const subjects = sortedSubjects();
    const header =
      '<tr><th>星期</th>' +
      subjects
        .map(function (subject) {
          return '<th class="budget-th">' + esc(subject.name) + '</th>';
        })
        .join('') +
      '<th class="budget-th">通用预算</th><th>合计</th></tr>';

    const rows = Budget.WEEKDAY_KEYS.map(function (key) {
      const day = state.budgets.weekly[key] || Budget.emptyDay();
      const total =
        C.sumValues(day.subjects) + (Number(day.general) || 0);
      return (
        '<tr><td>' +
        C.WEEKDAYS[Number(key) % 7] +
        '</td>' +
        subjects
          .map(function (subject) {
            return (
              '<td><input type="number" class="number-input budget-input" data-weekly-day="' +
              key +
              '" data-weekly-subject="' +
              esc(subject.id) +
              '" min="0" max="600" step="5" value="' +
              (day.subjects[subject.id] || 0) +
              '" aria-label="' +
              esc(subject.name + ' ' + C.WEEKDAYS[Number(key) % 7] + '预算') +
              '"></td>'
            );
          })
          .join('') +
        '<td><input type="number" class="number-input budget-input" data-weekly-general="' +
        key +
        '" min="0" max="600" step="5" value="' +
        (Number(day.general) || 0) +
        '" aria-label="通用预算"></td>' +
        '<td><span id="weekly-total-' +
        key +
        '">' +
        Math.round(total) +
        ' 分钟</span></td></tr>'
      );
    }).join('');

    return (
      '<div class="table-wrap"><table class="data-table budget-table">' +
      '<thead>' +
      header +
      '</thead><tbody>' +
      rows +
      '</tbody></table></div>'
    );
  }

  function dateBudgetPanelHtml() {
    const date = C.isValidYmd(ui.budgetDate) ? ui.budgetDate : C.todayStr();
    const budget = Budget.resolve(state, date);
    const subjects = sortedSubjects();
    const labelOptions = state.budgets.labels
      .map(function (label) {
        return (
          '<option value="' +
          esc(label.id) +
          '"' +
          (budget.labelId === label.id ? ' selected' : '') +
          '>' +
          esc(label.name) +
          '</option>'
        );
      })
      .join('');

    return (
      '<div class="panel">' +
      '<h2>具体日期预算</h2>' +
      '<div class="toolbar">' +
      '<label class="inline-field">日期<input type="date" class="date-input" id="budget-date" value="' +
      esc(date) +
      '"></label>' +
      '<span class="stat-line">当前来源：<strong>' +
      esc(Budget.sourceText(budget)) +
      '</strong> · 总预算 <strong>' +
      budgetText(budget.total) +
      '</strong></span>' +
      '</div>' +
      '<div class="date-budget-grid">' +
      subjects
        .map(function (subject) {
          return (
            '<label class="budget-field">' +
            subjectTag(subject.id) +
            '<input type="number" class="number-input budget-input" data-date-subject="' +
            esc(subject.id) +
            '" min="0" max="600" step="5" value="' +
            (budget.subjects[subject.id] || 0) +
            '" aria-label="' +
            esc(subject.name + ' 日期预算') +
            '"></label>'
          );
        })
        .join('') +
      '<label class="budget-field"><span class="subject-tag tag-general">通用</span>' +
      '<input type="number" class="number-input budget-input" data-date-general min="0" max="600" step="5" value="' +
      (budget.general || 0) +
      '" aria-label="通用预算"></label>' +
      '</div>' +
      '<label class="checkbox-line"><input type="checkbox" data-date-allow-forced' +
      (budget.allowForced !== false ? ' checked' : '') +
      '> <span>允许把逾期任务强制安排到这一天</span></label>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="save-date-budget">保存该日预算</button>' +
      '<button type="button" class="btn" data-action="reset-date-budget">恢复为每周默认</button>' +
      (state.budgets.labels.length
        ? '<span class="inline-field">应用标签<select class="select-input" id="date-label-select">' +
          '<option value="">选择标签…</option>' +
          labelOptions +
          '</select><button type="button" class="btn" data-action="apply-label">应用</button></span>'
        : '') +
      '</div>' +
      '<p class="budget-note">应用标签会把标签预算复制到这一天，之后可以单独修改；修改标签模板不会影响已经单独调整过的日期。</p>' +
      '</div>' +
      upcomingBudgetHtml(date)
    );
  }

  function upcomingBudgetHtml() {
    const days = Budget.upcoming(state, C.todayStr(), 14);
    return (
      '<div class="panel">' +
      '<h2>未来 14 天预算一览</h2>' +
      '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr><th>日期</th><th>星期</th><th>标签</th><th>专属合计</th><th>通用</th><th>总预算</th><th>来源</th><th class="ta-right">操作</th></tr></thead><tbody>' +
      days
        .map(function (item) {
          const budget = item.budget;
          return (
            '<tr><td>' +
            C.fmtShort(item.date) +
            '</td><td>' +
            C.weekdayName(item.date) +
            '</td><td>' +
            (budget.label ? esc(budget.label.name) : '<span class="muted">—</span>') +
            '</td><td>' +
            Math.round(C.sumValues(budget.subjects)) +
            ' 分钟</td><td>' +
            Math.round(budget.general) +
            ' 分钟</td><td><strong>' +
            Math.round(budget.total) +
            ' 分钟</strong></td><td>' +
            esc(item.sourceText) +
            '</td><td class="ta-right"><button type="button" class="btn btn-small" data-action="edit-budget-date" data-date="' +
            esc(item.date) +
            '">编辑</button></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div></div>'
    );
  }

  function labelsTableHtml() {
    if (!state.budgets.labels.length) {
      return (
        '<div class="empty-state compact">' +
        '<div class="empty-state-title">还没有日期标签</div>' +
        '<div class="empty-state-desc">标签用来保存一套预算模板，例如「考试日」「休息日」，然后应用到具体日期。</div>' +
        '<button type="button" class="btn btn-primary" data-action="new-label">新建标签</button>' +
        '</div>'
      );
    }
    return (
      '<div class="table-wrap"><table class="data-table">' +
      '<thead><tr><th>标签</th><th>类型</th><th>专属预算合计</th><th>通用预算</th><th>说明</th><th class="ta-right">操作</th></tr></thead><tbody>' +
      state.budgets.labels
        .map(function (label) {
          const color = C.normalizeHex(label.color) || Model.DEFAULT_COLOR;
          const summary = sortedSubjects()
            .map(function (subject) {
              return subject.name + ' ' + (label.subjects[subject.id] || 0) + ' 分';
            })
            .concat(['通用 ' + Math.round(label.general) + ' 分'])
            .join(' · ');
          return (
            '<tr><td><span class="color-dot" style="background:' +
            color +
            '"></span>' +
            esc(label.name) +
            '<div class="label-budget-summary">' +
            esc(summary) +
            '</div>' +
            '</td><td>' +
            esc(Budget.KIND_LABELS[label.kind] || '其他') +
            (label.allowForced === false
              ? ' <span class="mini-tag tag-paused">不强制</span>'
              : '') +
            '</td><td>' +
            Math.round(C.sumValues(label.subjects)) +
            ' 分钟</td><td>' +
            Math.round(label.general) +
            ' 分钟</td><td class="muted">' +
            (label.note ? esc(label.note) : '—') +
            '</td><td><div class="cell-actions">' +
            '<button type="button" class="btn btn-small" data-action="edit-label" data-id="' +
            esc(label.id) +
            '">编辑</button>' +
            '<button type="button" class="btn btn-small btn-danger" data-action="delete-label" data-id="' +
            esc(label.id) +
            '">删除</button>' +
            '</div></td></tr>'
          );
        })
        .join('') +
      '</tbody></table></div>'
    );
  }

  function settingsPanelHtml() {
    return (
      '<div class="panel">' +
      '<h2>新内容与调度设置</h2>' +
      '<div class="settings-grid">' +
      '<label class="checkbox-line"><input type="checkbox" id="setting-new-content"' +
      (state.settings.newContentEnabled !== false ? ' checked' : '') +
      '> <span>允许在复习任务安排完后，用剩余预算自动安排新内容</span></label>' +
      '<label class="inline-field">每日新内容上限<input type="number" class="number-input" id="setting-new-limit" min="0" max="20" step="1" value="' +
      state.settings.newContentDailyLimit +
      '"></label>' +
      '<label class="checkbox-line"><input type="checkbox" id="setting-early-review"' +
      (state.settings.earlyReviewEnabled !== false ? ' checked' : '') +
      '> <span>允许在预算空闲时提前复习困难/失败过的内容</span></label>' +
      '<label class="inline-field">最多提前<select class="select-input" id="setting-early-window">' +
      [1, 2, 3]
        .map(function (value) {
          return (
            '<option value="' +
            value +
            '"' +
            (Number(state.settings.earlyReviewWindowDays) === value ? ' selected' : '') +
            '>' +
            value +
            ' 天</option>'
          );
        })
        .join('') +
      '</select></label>' +
      '<label class="inline-field">预测默认天数<select class="select-input" id="setting-forecast-days">' +
      [7, 14, 21].map(function (value) {
        return (
          '<option value="' +
          value +
          '"' +
          (Number(state.settings.forecastDays) === value ? ' selected' : '') +
          '>' +
          value +
          ' 天</option>'
        );
      }).join('') +
      '</select></label>' +
      '</div>' +
      '<p class="budget-note">延迟容忍按间隔自动计算：间隔 1 个月约可推迟 5 天，最少 2 天、最多 14 天；超过后优先强制安排，但最多只超出当天可用预算的 25%，休息日/考试日可关闭强制。提前复习只对困难/失败过、间隔至少 2 天的内容生效，避免把正常节奏打乱。</p>' +
      '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="save-settings">保存设置</button></div>' +
      '</div>'
    );
  }

  function renderBudget() {
    const root = $('#view-budget');
    if (!root) return;
    root.innerHTML =
      '<div class="view-head">' +
      '<div>' +
      '<h1 class="view-title">预算与标签</h1>' +
      '<p class="view-desc">先设置每周默认预算，再给特殊日期打标签或单独调整。系统只按你给的时间安排任务，不会假设你有额外时间。</p>' +
      '</div>' +
      '</div>' +
      '<div class="panel">' +
      '<h2>每周默认预算</h2>' +
      '<p class="panel-desc">没有特殊日期覆盖时，每天自动使用对应星期的预算。修改后不会影响已经单独设置过的日期。</p>' +
      weeklyBudgetTableHtml() +
      '<div class="btn-row"><button type="button" class="btn btn-primary" data-action="save-weekly">保存每周预算</button></div>' +
      '</div>' +
      dateBudgetPanelHtml() +
      '<div class="panel">' +
      '<div class="panel-title-row"><h2>日期标签</h2><button type="button" class="btn btn-small" data-action="new-label">新建标签</button></div>' +
      '<p class="panel-desc">标签是一套可复用的预算模板，应用到日期时会复制一份；之后修改当天预算不会反向修改标签。</p>' +
      labelsTableHtml() +
      '</div>' +
      settingsPanelHtml();
  }

  function openLabelForm(id) {
    const existing = id
      ? state.budgets.labels.find(function (label) {
          return label.id === id;
        })
      : null;
    if (id && !existing) {
      toast('标签不存在。');
      return;
    }
    const subjects = sortedSubjects();
    const label = existing || {
      id: '',
      name: '',
      color: pickDefaultColor(),
      kind: 'normal',
      subjects: {},
      general: 0,
      allowForced: true,
      note: '',
    };
    const appliedCount = existing
      ? Object.keys(state.budgets.overrides).filter(function (date) {
          const override = state.budgets.overrides[date];
          return override.labelId === existing.id && override.origin === 'label';
        }).length
      : 0;

    openModal(
      '<form id="label-form" class="modal modal-wide" data-id="' +
        esc(label.id) +
        '" autocomplete="off">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">' +
        (existing ? '编辑标签' : '新建标签') +
        '</h2>' +
        '<div class="modal-subtitle">标签预算应用到日期后会复制一份，不会实时联动。</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="form-grid">' +
        '<div class="field"><label for="label-name">标签名称</label>' +
        '<input type="text" class="text-input" id="label-name" name="name" maxlength="20" required value="' +
        esc(label.name) +
        '"></div>' +
        '<div class="field"><label for="label-kind">类型</label>' +
        '<select class="select-input" id="label-kind" name="kind">' +
        Object.keys(Budget.KIND_LABELS)
          .map(function (kind) {
            return (
              '<option value="' +
              kind +
              '"' +
              (label.kind === kind ? ' selected' : '') +
              '>' +
              esc(Budget.KIND_LABELS[kind]) +
              '</option>'
            );
          })
          .join('') +
        '</select></div>' +
        '</div>' +
        '<div class="field"><span class="field-label">标签颜色</span>' +
        '<div class="color-picker">' +
        colorPickerHtml(label.color) +
        '</div></div>' +
        '<div class="field"><span class="field-label">各科目预算（分钟）</span>' +
        '<div class="date-budget-grid">' +
        subjects
          .map(function (subject) {
            return (
              '<label class="budget-field">' +
              subjectTag(subject.id) +
              '<input type="number" class="number-input budget-input" data-label-subject="' +
              esc(subject.id) +
              '" min="0" max="600" step="5" value="' +
              (label.subjects[subject.id] || 0) +
              '">' +
              '</label>'
            );
          })
          .join('') +
        '<label class="budget-field"><span class="subject-tag tag-general">通用</span>' +
        '<input type="number" class="number-input budget-input" name="general" min="0" max="600" step="5" value="' +
        (label.general || 0) +
        '"></label>' +
        '</div></div>' +
        '<label class="checkbox-line"><input type="checkbox" name="allowForced"' +
        (label.allowForced !== false ? ' checked' : '') +
        '> <span>允许把逾期任务强制安排到这一天（休息日/考试日建议关闭）</span></label>' +
        '<div class="field"><label for="label-note">说明（可选）</label>' +
        '<input type="text" class="text-input" id="label-note" name="note" maxlength="120" value="' +
        esc(label.note || '') +
        '"></div>' +
        (existing && appliedCount
          ? '<label class="checkbox-line"><input type="checkbox" name="sync"> <span>同时更新已应用该标签、且没有手动修改过的 ' +
            appliedCount +
            ' 个日期</span></label>'
          : '') +
        '<p class="form-error" hidden></p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn" data-close>取消</button>' +
        '<button type="submit" class="btn btn-primary">保存标签</button>' +
        '</div>' +
        '</form>',
      { dismissible: false }
    );
  }

  function handleLabelSubmit(form) {
    const id = form.dataset.id;
    const existing = id
      ? state.budgets.labels.find(function (label) {
          return label.id === id;
        })
      : null;
    const name = form.elements.name.value.trim();
    const kind = form.elements.kind.value;
    const colorInput = form.querySelector('input[name="color"]');
    const color = C.normalizeHex(colorInput && colorInput.value) || Model.DEFAULT_COLOR;
    const general = Number(form.elements.general.value);
    const note = form.elements.note.value.trim();
    const allowForced = !!(form.elements.allowForced && form.elements.allowForced.checked);
    const errorElement = form.querySelector('.form-error');
    const sync = !!(form.elements.sync && form.elements.sync.checked);

    function fail(message) {
      errorElement.textContent = message;
      errorElement.hidden = false;
      return false;
    }
    errorElement.hidden = true;
    if (!name) return fail('请填写标签名称。');
    if (name.length > 20) return fail('标签名称不能超过 20 个字符。');
    if (
      state.budgets.labels.some(function (label) {
        return label.id !== id && label.name.toLowerCase() === name.toLowerCase();
      })
    ) {
      return fail('已经有同名标签了。');
    }
    if (!Number.isFinite(general) || general < 0 || general > 600) {
      return fail('通用预算需要在 0–600 分钟之间。');
    }

    const subjects = {};
    $$('[data-label-subject]', form).forEach(function (input) {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 600) {
        subjects[input.dataset.labelSubject] = null;
      } else {
        subjects[input.dataset.labelSubject] = C.round1(value);
      }
    });
    if (
      Object.keys(subjects).some(function (key) {
        return subjects[key] === null;
      })
    ) {
      return fail('科目预算需要在 0–600 分钟之间。');
    }

    let label;
    if (existing) {
      label = existing;
      label.name = name;
      label.kind = kind;
      label.color = color;
      label.subjects = subjects;
      label.general = C.round1(general);
      label.allowForced = allowForced;
      label.note = note;
    } else {
      label = {
        id: C.uid('lb'),
        name: name,
        kind: kind,
        color: color,
        subjects: subjects,
        general: C.round1(general),
        allowForced: allowForced,
        note: note,
        createdAt: C.nowIso(),
      };
      state.budgets.labels.push(label);
    }
    let synced = 0;
    if (sync) synced = Budget.syncLabelToDates(state, label);
    saveState();
    closeModal();
    renderBudget();
    toast(
      existing
        ? '标签已保存' + (synced ? '，已同步 ' + synced + ' 个日期。' : '。')
        : '标签已创建。'
    );
    return true;
  }

  function deleteLabel(id) {
    const label = state.budgets.labels.find(function (item) {
      return item.id === id;
    });
    if (!label) return;
    if (
      !confirm(
        '确定删除标签「' +
          label.name +
          '」吗？已经应用到日期的预算会保留下来，不会丢失。'
      )
    ) {
      return;
    }
    const result = Budget.removeLabel(state, id);
    saveState();
    renderBudget();
    toast(
      '标签已删除' +
        (result.detached ? '，' + result.detached + ' 个日期的预算已保留。' : '。')
    );
  }

  function saveWeeklyBudget() {
    const weekly = {};
    Budget.WEEKDAY_KEYS.forEach(function (key) {
      weekly[key] = { subjects: {}, general: 0 };
    });
    let invalid = false;
    $$('[data-weekly-subject]').forEach(function (input) {
      const day = input.dataset.weeklyDay;
      const subjectId = input.dataset.weeklySubject;
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 600) {
        invalid = true;
        return;
      }
      weekly[day].subjects[subjectId] = C.round1(value);
    });
    $$('[data-weekly-general]').forEach(function (input) {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 600) {
        invalid = true;
        return;
      }
      weekly[input.dataset.weeklyGeneral].general = C.round1(value);
    });
    if (invalid) {
      toast('预算需要在 0–600 分钟之间。');
      return;
    }
    state.budgets.weekly = weekly;
    saveState();
    renderBudget();
    toast('每周预算已保存。');
  }

  function saveDateBudget() {
    const date = ui.budgetDate;
    const subjects = {};
    let invalid = false;
    $$('[data-date-subject]').forEach(function (input) {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0 || value > 600) {
        invalid = true;
        return;
      }
      subjects[input.dataset.dateSubject] = C.round1(value);
    });
    const generalInput = $('[data-date-general]');
    const general = Number(generalInput && generalInput.value);
    if (!Number.isFinite(general) || general < 0 || general > 600) invalid = true;
    if (invalid) {
      toast('预算需要在 0–600 分钟之间。');
      return;
    }
    const allowForcedInput = $('[data-date-allow-forced]');
    const allowForced = !!(allowForcedInput && allowForcedInput.checked);
    Budget.setOverride(state, date, subjects, general, 'manual', allowForced);
    saveState();
    renderBudget();
    toast(C.fmtShort(date) + ' 的预算已保存。');
  }

  /* ---------------- 负担预测 ---------------- */

  function renderForecast() {
    const root = $('#view-forecast');
    if (!root) return;
    const start = C.isValidYmd(ui.forecastStart) ? ui.forecastStart : C.todayStr();
    ui.forecastStart = start;
    const days = Math.max(7, Math.min(21, Number(ui.forecastDays) || 14));
    const forecast = Forecast.run(state, start, days);
    const summary = forecast.summary;

    const cards = forecast.days
      .map(function (day) {
        const bySubject = {};
        day.assignments.forEach(function (task) {
          const key = task.subjectId || '__none__';
          if (!bySubject[key]) bySubject[key] = { count: 0, minutes: 0 };
          bySubject[key].count += 1;
          bySubject[key].minutes += task.plannedMinutes;
        });
        const chips = Object.keys(bySubject)
          .map(function (key) {
            const name = key === '__none__' ? '未分类' : subjectName(key);
            return (
              '<span class="chip">' +
              esc(name) +
              ' ' +
              bySubject[key].count +
              ' 条 · ' +
              Math.round(bySubject[key].minutes) +
              ' 分</span>'
            );
          })
          .join('');
        const hasBudget = day.budget.total > 0;
        return (
          '<article class="day-card' +
          (day.overload ? ' is-overload' : '') +
          '">' +
          '<header class="day-card-head">' +
          '<div><strong>' +
          C.fmtShort(day.date) +
          '</strong> <span class="muted">' +
          C.weekdayName(day.date) +
          '</span>' +
          (day.budget.label
            ? ' <span class="mini-tag">' + esc(day.budget.label.name) + '</span>'
            : '') +
          '</div>' +
          '<div class="day-budget">预算 ' +
          Math.round(day.budget.total) +
          ' 分 · 通用 ' +
          Math.round(day.budget.general) +
          ' 分</div>' +
          '</header>' +
          '<div class="day-metrics">' +
          '<span>到期 <strong>' +
          day.summary.dueCount +
          '</strong> 条</span>' +
          '<span>安排 <strong>' +
          Math.round(day.plannedTotal) +
          '</strong> 分</span>' +
          '<span>未安排 <strong class="' +
          (day.summary.unscheduledCount ? 'is-negative' : '') +
          '">' +
          day.summary.unscheduledCount +
          '</strong> 条</span>' +
          '<span>延期 <strong>' +
          day.carriedOut +
          '</strong> 条</span>' +
          (day.summary.newContentCount
            ? '<span>新内容 <strong>' + day.summary.newContentCount + '</strong> 条</span>'
            : '') +
          (day.summary.earlyCount
            ? '<span>提前 <strong>' + day.summary.earlyCount + '</strong> 条</span>'
            : '') +
          '</div>' +
          (chips ? '<div class="subject-chips">' + chips + '</div>' : '<div class="subject-chips muted">没有安排任务</div>') +
          '<div class="day-footer">' +
          (day.summary.deficitMinutes
            ? '<span class="overdue-tag">缺口 ' + Math.round(day.summary.deficitMinutes) + ' 分钟</span>'
            : hasBudget
            ? '<span class="muted">预算足够</span>'
            : '<span class="overdue-tag">当天预算为 0</span>') +
          (day.summary.forcedCount
            ? '<span class="mini-tag tag-force">强制 ' + day.summary.forcedCount + ' 条</span>'
            : '') +
          '<button type="button" class="btn btn-small" data-action="forecast-open" data-date="' +
          esc(day.date) +
          '">查看当天</button>' +
          '</div>' +
          '</article>'
        );
      })
      .join('');

    root.innerHTML =
      '<div class="view-head">' +
      '<div>' +
      '<h1 class="view-title">负担预测</h1>' +
      '<p class="view-desc">按现有条目、调整后的间隔和未来预算逐日模拟。已安排的任务会按「正常回忆」继续向后推演后续复习（包括新内容）；预测只是提醒，每天会根据真实完成情况重新计算。</p>' +
      '</div>' +
      '</div>' +
      '<div class="toolbar">' +
      '<label class="inline-field">起始日期<input type="date" class="date-input" id="forecast-start" value="' +
      esc(start) +
      '"></label>' +
      '<label class="inline-field">预测范围<select class="select-input" id="forecast-days">' +
      [7, 14, 21]
        .map(function (value) {
          return (
            '<option value="' +
            value +
            '"' +
            (value === days ? ' selected' : '') +
            '>' +
            value +
            ' 天</option>'
          );
        })
        .join('') +
      '</select></label>' +
      '<span class="stat-line">预计复习 <strong>' +
      summary.predictedReviews +
      '</strong> 次 · 模拟后续复习 <strong>' +
      (summary.simulatedReviews || 0) +
      '</strong> 次 · 总预算 <strong>' +
      Math.round(summary.totalBudget) +
      '</strong> 分钟 · 预计缺口 <strong>' +
      Math.round(summary.totalDeficit) +
      '</strong> 分钟</span>' +
      '</div>' +
      '<div class="stat-cards forecast-stats">' +
      '<div class="stat-card"><div class="stat-num">' +
      summary.overloadedDays +
      '</div><div class="stat-label">超载天数 / ' +
      summary.days +
      ' 天</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      Math.round(summary.totalDeficit) +
      '</div><div class="stat-label">累计缺口（分钟）</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      summary.totalForced +
      '</div><div class="stat-label">强制安排次数</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      (summary.worstDate ? C.fmtShort(summary.worstDate) : '—') +
      '</div><div class="stat-label">最紧张的一天</div></div>' +
      '</div>' +
      '<div class="day-grid">' +
      cards +
      '</div>';
  }

  /* ---------------- 科目设置 ---------------- */

  function renderSubjects() {
    const root = $('#view-subjects');
    if (!root) return;
    const subjects = sortedSubjects();
    let tableHtml;
    if (!subjects.length) {
      tableHtml =
        '<div class="empty-state">' +
        '<div class="empty-state-title">还没有科目</div>' +
        '<div class="empty-state-desc">在上方输入科目名称并选一个标签颜色，就可以开始添加条目了。</div>' +
        '</div>';
    } else {
      tableHtml =
        '<div class="table-wrap"><table class="data-table">' +
        '<thead><tr><th>科目</th><th>条目数</th><th>每周专属预算</th><th>状态</th><th class="ta-right">操作</th></tr></thead><tbody>' +
        subjects
          .map(function (subject) {
            const color = C.normalizeHex(subject.color) || Model.DEFAULT_COLOR;
            const count = subjectEntryCount(subject.id);
            const weeklyTotal = Budget.WEEKDAY_KEYS.reduce(function (sum, key) {
              const day = state.budgets.weekly[key];
              return sum + ((day && day.subjects[subject.id]) || 0);
            }, 0);
            return (
              '<tr' +
              (subject.archived ? ' class="subject-archived"' : '') +
              '>' +
              '<td><span class="color-dot" style="background:' +
              color +
              '"></span>' +
              esc(subject.name) +
              '</td><td>' +
              count +
              ' 条</td><td>' +
              Math.round(weeklyTotal) +
              ' 分钟</td><td>' +
              (subject.archived
                ? '<span class="status-pill">已停用</span>'
                : '<span class="status-pill">使用中</span>') +
              '</td><td><div class="cell-actions">' +
              '<button type="button" class="btn btn-small" data-action="edit-subject" data-id="' +
              esc(subject.id) +
              '">编辑</button>' +
              (subject.archived
                ? '<button type="button" class="btn btn-small" data-action="restore-subject" data-id="' +
                  esc(subject.id) +
                  '">恢复</button>'
                : '<button type="button" class="btn btn-small" data-action="archive-subject" data-id="' +
                  esc(subject.id) +
                  '">停用</button>') +
              (count === 0
                ? '<button type="button" class="btn btn-small btn-danger" data-action="delete-subject" data-id="' +
                  esc(subject.id) +
                  '">删除</button>'
                : '') +
              '</div></td></tr>'
            );
          })
          .join('') +
        '</tbody></table></div>';
    }

    root.innerHTML =
      '<div class="view-head">' +
      '<div>' +
      '<h1 class="view-title">科目设置</h1>' +
      '<p class="view-desc">科目拥有独立的每日时间预算。停用科目不会影响已有条目，只是新条目不能再选择它；停用后仍可在预算表里看到并调整。</p>' +
      '</div>' +
      '</div>' +
      '<form id="subject-form" class="subject-create" autocomplete="off">' +
      '<div class="create-row">' +
      '<input type="text" class="text-input" name="name" maxlength="20" placeholder="新科目名称，例如：英语" required aria-label="新科目名称">' +
      '<button type="submit" class="btn btn-primary">添加科目</button>' +
      '</div>' +
      '<div class="color-picker">' +
      '<span class="color-picker-label">标签颜色</span>' +
      colorPickerHtml(pickDefaultColor()) +
      '</div>' +
      '</form>' +
      tableHtml;
  }

  function openSubjectEdit(id) {
    const subject = subjectById(id);
    if (!subject) {
      toast('科目不存在。');
      return;
    }
    openModal(
      '<form id="subject-edit-form" class="modal" data-id="' +
        esc(subject.id) +
        '" autocomplete="off">' +
        '<div class="modal-head">' +
        '<div><h2 class="modal-title">编辑科目</h2>' +
        '<div class="modal-subtitle">改名会同步到所有使用该科目的条目。</div></div>' +
        '<button type="button" class="icon-btn" data-close aria-label="关闭">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
        '<div class="field"><label for="subject-name-edit">科目名称</label>' +
        '<input type="text" class="text-input" id="subject-name-edit" name="name" maxlength="20" required value="' +
        esc(subject.name) +
        '"></div>' +
        '<div class="field"><span class="field-label">标签颜色</span>' +
        '<div class="color-picker">' +
        colorPickerHtml(subject.color) +
        '</div></div>' +
        '<p class="form-error" hidden></p>' +
        '</div>' +
        '<div class="modal-foot">' +
        '<button type="button" class="btn" data-close>取消</button>' +
        '<button type="submit" class="btn btn-primary">保存</button>' +
        '</div>' +
        '</form>',
      { dismissible: false }
    );
  }

  function handleSubjectEditSubmit(form) {
    const id = form.dataset.id;
    const subject = subjectById(id);
    if (!subject) {
      closeModal();
      return false;
    }
    const name = form.elements.name.value.trim();
    const colorInput = form.querySelector('input[name="color"]');
    const color = C.normalizeHex(colorInput && colorInput.value) || subject.color;
    const errorElement = form.querySelector('.form-error');

    function fail(message) {
      errorElement.textContent = message;
      errorElement.hidden = false;
      return false;
    }
    errorElement.hidden = true;
    if (!name) return fail('请填写科目名称。');
    if (name.length > 20) return fail('科目名称不能超过 20 个字符。');
    if (
      state.subjects.some(function (item) {
        return item.id !== id && item.name.toLowerCase() === name.toLowerCase();
      })
    ) {
      return fail('已经有同名科目了。');
    }
    subject.name = name;
    subject.color = color;
    saveState();
    closeModal();
    renderSubjects();
    toast('科目已更新。');
    return true;
  }

  function handleSubjectCreate(form) {
    const name = form.elements.name.value.trim();
    const colorInput = form.querySelector('input[name="color"]');
    const color = C.normalizeHex(colorInput && colorInput.value) || pickDefaultColor();
    if (!name) {
      toast('请填写科目名称。');
      return;
    }
    if (name.length > 20) {
      toast('科目名称不能超过 20 个字符。');
      return;
    }
    if (
      state.subjects.some(function (subject) {
        return subject.name.toLowerCase() === name.toLowerCase();
      })
    ) {
      toast('已经有同名科目了（可能处于停用状态）。');
      return;
    }
    const subject = {
      id: C.uid('s'),
      name: name,
      color: color,
      archived: false,
      createdAt: C.nowIso(),
    };
    state.subjects.push(subject);
    Budget.ensureWeeklySubject(state, subject.id, Budget.DEFAULT_SUBJECT_MINUTES);
    saveState();
    renderSubjects();
    toast('已添加科目「' + name + '」，每周默认 15 分钟/天，可在「预算与标签」调整。');
    const input = $('#subject-form input[name="name"]');
    if (input) input.focus();
  }

  function archiveSubject(id) {
    const subject = subjectById(id);
    if (!subject) return;
    const count = subjectEntryCount(id);
    if (
      !confirm(
        count
          ? '停用科目「' +
              subject.name +
              '」后，已有 ' +
              count +
              ' 个条目仍会保留该科目标签，但新条目不能再选择它。确定停用吗？'
          : '确定停用科目「' + subject.name + '」吗？'
      )
    ) {
      return;
    }
    subject.archived = true;
    saveState();
    renderSubjects();
    toast('科目已停用。');
  }

  function restoreSubject(id) {
    const subject = subjectById(id);
    if (!subject) return;
    subject.archived = false;
    saveState();
    renderSubjects();
    toast('科目已恢复。');
  }

  function deleteSubject(id) {
    const subject = subjectById(id);
    if (!subject) return;
    const count = subjectEntryCount(id);
    if (count > 0) {
      toast('该科目下还有 ' + count + ' 个条目，不能直接删除；可以停用它。');
      return;
    }
    if (!confirm('确定删除科目「' + subject.name + '」吗？')) return;
    state.subjects = state.subjects.filter(function (item) {
      return item.id !== id;
    });
    Budget.WEEKDAY_KEYS.forEach(function (key) {
      if (state.budgets.weekly[key]) delete state.budgets.weekly[key].subjects[id];
    });
    state.budgets.labels.forEach(function (label) {
      delete label.subjects[id];
    });
    Object.keys(state.budgets.overrides).forEach(function (date) {
      delete state.budgets.overrides[date].subjects[id];
    });
    saveState();
    renderSubjects();
    toast('科目已删除。');
  }

  /* ---------------- 数据备份 ---------------- */

  function renderData() {
    const root = $('#view-data');
    if (!root) return;
    const doneLogs = state.logs.filter(function (log) {
      return log.completed !== false;
    });
    const actualTotal = doneLogs.reduce(function (sum, log) {
      return sum + (Number(log.actualMinutes) || 0);
    }, 0);
    const todayPlan = Scheduler.scheduleDay(state, C.todayStr());
    const sampleFirst = 15;
    const sampleRows = [];
    for (let round = 1; round <= Review.MAX_ROUNDS; round++) {
      const gap = Review.theoryGap(round);
      const offset = Review.theoryOffset(round);
      sampleRows.push(
        '<tr><td>第 ' +
          round +
          ' 次</td><td>第 ' +
          (offset + 1) +
          ' 天</td><td>' +
          (round === 1 ? '—' : gap + ' 天') +
          '</td><td>' +
          minutesText(sampleFirst / Math.sqrt(round)) +
          '</td><td>' +
          (round === 1 ? '—' : Review.graceDaysForInterval(gap) + ' 天') +
          '</td></tr>'
      );
    }
    const sampleTable = sampleRows.join('');

    root.innerHTML =
      '<div class="view-head">' +
      '<div>' +
      '<h1 class="view-title">数据备份</h1>' +
      '<p class="view-desc">查看数据概况、导出备份，以及了解调度规则。数据只保存在当前浏览器。</p>' +
      '</div>' +
      '</div>' +
      '<div class="stat-cards">' +
      '<div class="stat-card"><div class="stat-num">' +
      state.entries.length +
      '</div><div class="stat-label">条目</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      activeSubjects().length +
      '</div><div class="stat-label">使用中的科目</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      doneLogs.length +
      '</div><div class="stat-label">执行记录</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      Math.round(actualTotal) +
      '</div><div class="stat-label">累计实际用时（分钟）</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      state.budgets.labels.length +
      '</div><div class="stat-label">日期标签</div></div>' +
      '<div class="stat-card"><div class="stat-num">' +
      Math.round(todayPlan.summary.remainingTotal) +
      '</div><div class="stat-label">今日剩余预算（分钟）</div></div>' +
      '</div>' +
      '<div class="panel">' +
      '<h2>备份与恢复</h2>' +
      '<p>数据保存在当前浏览器的 localStorage（新键名 <span class="formula">' +
      Model.STORE_KEY +
      '</span>）。更换浏览器、更换设备或清理浏览数据都会导致数据丢失，重要数据请定期导出备份。</p>' +
      '<p class="muted">从旧版本升级时，旧键名 <span class="formula">' +
      Model.LEGACY_KEY +
      '</span> 的数据会保留不删，并自动迁移为执行记录；旧版备份 JSON 也可以直接导入。</p>' +
      '<div class="btn-row">' +
      '<button type="button" class="btn btn-primary" data-action="export">导出备份（JSON）</button>' +
      '<button type="button" class="btn" data-action="import">导入备份…</button>' +
      '<input type="file" id="import-file" accept=".json,application/json" hidden>' +
      '<button type="button" class="btn" data-action="load-demo">载入示例数据</button>' +
      '</div>' +
      '<p class="muted small">「载入示例数据」会覆盖当前内容，包含科目、预算、标签、执行记录和新内容队列，方便快速体验。</p>' +
      '</div>' +
      '<div class="panel">' +
      '<h2>调度规则</h2>' +
      '<p>复习节奏表：第 1 天首次学习、第 2 天复习、第 4 天、第 10 天、第 20 天……前期间隔按 1、2、6、10 天展开，之后约按 1.7 倍增长，但长间隔压缩到最长 300 天。</p>' +
      '<p>下一次间隔 = <span class="formula">理论基准间隔 × 回忆倍率</span>：顺利 ×2.0、正常 ×1.0、困难 ×0.55；失败不排常规复习，改为第二天补救，补救完成后第二天重做失败的那一轮，成功后才继续。只参考上一次回忆结果，不累积历史偏差。</p>' +
      '<p>预计用时 = <span class="formula">公式值 / 实际耗时修正 × 回忆倍率</span>：顺利 ×0.8、正常 ×1.0、困难 ×1.3、失败 ×2.4；最低不少于首次用时的 1/4，最高不超过首次用时的 2 倍。压缩安排默认只记时间、不推进轮次。</p>' +
      '<p>延迟容忍按间隔自动计算：<span class="formula">间隔 ÷ 6</span>，最少 2 天、最多 14 天。例如 30 天间隔可推迟 5 天。优先级里的延期分数按「已延期 / 可延迟」比例计算；超过后优先强制安排，但最多只超出当天可用预算的 25%，休息日/考试日可关闭强制。</p>' +
      '<p>每天先解析预算，再按综合优先级（延期、重要度、遗忘风险、失误、考试临近）排序。科目任务先用专属预算，不足部分借用通用预算；预算不够全额时可以压缩，少于 3 分钟则不安排。</p>' +
      '<p>只有当天到期任务全部安排完、还有剩余预算时，才会安排提前复习和新内容；提前复习只针对困难/失败过、间隔至少 2 天的内容。某一科到期任务没排下时，只冻结这一科的新内容，其他科目仍可启动。</p>' +
      '<table class="rule-table"><thead><tr><th>轮次</th><th>距首次</th><th>本轮基准间隔</th><th>公式用时（首次 15 分钟）</th><th>最长可延迟</th></tr></thead><tbody>' +
      sampleTable +
      '</tbody></table>' +
      '<p class="muted small">注意：修改首次学习日期会清空该条目的执行记录；重置复习进度会保留首次学习记录。迁移和撤销会保留任务原来的到期日，完成这一轮后才按新间隔继续。</p>' +
      '</div>' +
      '<div class="panel danger-zone">' +
      '<h2>清空数据</h2>' +
      '<p>删除所有科目、条目、预算、标签和执行记录。此操作不可撤销，建议先导出备份。</p>' +
      '<div class="btn-row"><button type="button" class="btn btn-danger" data-action="clear-all">清空全部数据</button></div>' +
      '</div>';
  }

  function exportData() {
    const payload = Model.serialize(state);
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = '背诵规划表备份-' + C.todayStr() + '.json';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
    toast('备份已导出。');
  }

  function importData(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () {
      let imported;
      try {
        imported = Model.normalizeState(JSON.parse(String(reader.result)));
      } catch (err) {
        alert('导入失败：文件不是有效的备份 JSON。');
        input.value = '';
        return;
      }
      const ok = confirm(
        '将导入 ' +
          imported.subjects.length +
          ' 个科目、' +
          imported.entries.length +
          ' 个条目、' +
          imported.logs.length +
          ' 条执行记录，并覆盖当前所有数据。确定继续吗？'
      );
      if (!ok) {
        input.value = '';
        return;
      }
      state = imported;
      saveState();
      ui.date = C.todayStr();
      ui.budgetDate = C.todayStr();
      ui.forecastDays = state.settings.forecastDays || 14;
      closeModal();
      switchView('today');
      toast('导入成功。');
      input.value = '';
    };
    reader.onerror = function () {
      alert('读取文件失败，请重试。');
      input.value = '';
    };
    reader.readAsText(file);
  }

  function clearAllData() {
    if (!state.entries.length && !state.subjects.length) {
      toast('当前没有数据。');
      return;
    }
    if (
      !confirm('确定要清空所有科目、条目、预算、标签和执行记录吗？此操作不可撤销。')
    ) {
      return;
    }
    const word = prompt('请输入「清空」两个字确认操作：');
    if (word !== '清空') {
      toast('已取消清空。');
      return;
    }
    state = Model.defaultState();
    saveState();
    ui.date = C.todayStr();
    ui.budgetDate = C.todayStr();
    ui.forecastDays = state.settings.forecastDays || 14;
    switchView('today');
    toast('数据已清空。');
  }

  function loadDemo() {
    if (!confirm('载入示例数据会覆盖当前所有科目、条目和记录，确定继续吗？建议先导出备份。')) {
      return;
    }
    state = Model.demoState();
    saveState();
    ui.date = C.todayStr();
    ui.budgetDate = C.todayStr();
    ui.forecastStart = C.todayStr();
    ui.forecastDays = state.settings.forecastDays || 14;
    switchView('today');
    toast('已载入示例数据，可在预算页看到每周模板和标签。');
  }

  /* ---------------- 视图切换 ---------------- */

  function render() {
    if (ui.view === 'today') renderToday();
    else if (ui.view === 'budget') renderBudget();
    else if (ui.view === 'forecast') renderForecast();
    else if (ui.view === 'entries') renderEntries();
    else if (ui.view === 'subjects') renderSubjects();
    else renderData();
  }

  function switchView(view) {
    ui.view = view;
    $$('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    $$('.view').forEach(function (section) {
      section.hidden = section.id !== 'view-' + view;
    });
    render();
  }

  /* ---------------- 事件 ---------------- */

  function handleAction(action, element) {
    const id = element.dataset.id;
    switch (action) {
      case 'print':
        window.print();
        break;
      case 'today-reset':
        ui.date = C.todayStr();
        renderToday();
        break;
      case 'goto-budget-date':
        ui.budgetDate = element.dataset.date || ui.date || C.todayStr();
        switchView('budget');
        break;
      case 'goto-budget':
        switchView('budget');
        break;
      case 'goto-entries':
        switchView('entries');
        break;
      case 'goto-forecast':
        switchView('forecast');
        break;
      case 'goto-subjects':
        switchView('subjects');
        break;
      case 'new-entry':
        openEntryForm(null);
        break;
      case 'edit-entry':
        closeModal();
        openEntryForm(id);
        break;
      case 'delete-entry':
        deleteEntry(id);
        break;
      case 'entry-detail':
        openEntryDetail(id);
        break;
      case 'complete-task': {
        const task = findPlanTask(element.dataset.key);
        openCompleteModal(task, { reopenDetail: false });
        break;
      }
      case 'complete-entry-task': {
        const entry = findEntry(id);
        if (!entry) break;
        const task = Scheduler.collectTasks(state, C.todayStr()).find(function (item) {
          return item.entryId === entry.id;
        });
        if (!task || task.dueDate > C.todayStr()) {
          toast('这条内容还没有到期任务。');
          break;
        }
        task.allocation = {
          subject: 0,
          general: 0,
          total: task.estimateMinutes,
        };
        task.plannedMinutes = task.estimateMinutes;
        openCompleteModal(task, { reopenDetail: true });
        break;
      }
      case 'task-why':
        openWhyModal(element.dataset.key);
        break;
      case 'undo-log':
        undoLog(id);
        break;
      case 'dismiss-notice':
        state.meta.notice = '';
        if (state.meta.pinPending) Model.acknowledgePin(state);
        saveState();
        renderToday();
        break;
      case 'pin-keep':
        Model.acknowledgePin(state);
        state.meta.notice = '';
        saveState();
        renderToday();
        toast('已保留旧计划日期；之后完成这些任务时会按新规则继续。');
        break;
      case 'pin-reschedule': {
        const cleared = Model.clearLegacyPins(state);
        state.meta.notice = '';
        saveState();
        renderToday();
        toast(
          cleared
            ? '已改用新规则重排 ' + cleared + ' 条旧条目。'
            : '没有需要重排的旧计划日期。'
        );
        break;
      }
      case 'reset-entry-progress':
        resetEntryProgress(id);
        break;
      case 'edit-subject':
        openSubjectEdit(id);
        break;
      case 'archive-subject':
        archiveSubject(id);
        break;
      case 'restore-subject':
        restoreSubject(id);
        break;
      case 'delete-subject':
        deleteSubject(id);
        break;
      case 'save-weekly':
        saveWeeklyBudget();
        break;
      case 'save-date-budget':
        saveDateBudget();
        break;
      case 'reset-date-budget': {
        const date = C.isValidYmd(ui.budgetDate) ? ui.budgetDate : C.todayStr();
        if (Budget.clearOverride(state, date)) {
          saveState();
          renderBudget();
          toast('已恢复为每周默认预算。');
        } else {
          toast('这一天没有单独设置，已经使用每周默认预算。');
        }
        break;
      }
      case 'apply-label': {
        const select = $('#date-label-select');
        const labelId = select && select.value;
        if (!labelId) {
          toast('请选择一个标签。');
          break;
        }
        const date = C.isValidYmd(ui.budgetDate) ? ui.budgetDate : C.todayStr();
        const current = state.budgets.overrides[date];
        if (
          current &&
          current.origin === 'manual' &&
          !confirm('这一天已经单独调整过预算，应用标签会覆盖当前数值。确定继续吗？')
        ) {
          break;
        }
        Budget.applyLabel(state, date, labelId);
        saveState();
        renderBudget();
        toast('已应用标签，之后可以单独修改当天预算。');
        break;
      }
      case 'edit-budget-date':
        ui.budgetDate = element.dataset.date || C.todayStr();
        renderBudget();
        break;
      case 'new-label':
        openLabelForm(null);
        break;
      case 'edit-label':
        openLabelForm(id);
        break;
      case 'delete-label':
        deleteLabel(id);
        break;
      case 'save-settings': {
        const enabled = $('#setting-new-content');
        const limit = $('#setting-new-limit');
        const earlyEnabled = $('#setting-early-review');
        const earlyWindow = $('#setting-early-window');
        const forecastDays = $('#setting-forecast-days');
        const limitValue = Number(limit && limit.value);
        if (!Number.isFinite(limitValue) || limitValue < 0 || limitValue > 20) {
          toast('每日新内容上限需要在 0–20 之间。');
          break;
        }
        state.settings.newContentEnabled = !!(enabled && enabled.checked);
        state.settings.newContentDailyLimit = Math.round(limitValue);
        state.settings.earlyReviewEnabled = !!(earlyEnabled && earlyEnabled.checked);
        state.settings.earlyReviewWindowDays = Math.max(
          1,
          Math.min(3, Math.round(Number(earlyWindow && earlyWindow.value) || 1))
        );
        state.settings.forecastDays = Number(forecastDays && forecastDays.value) || 14;
        ui.forecastDays = state.settings.forecastDays;
        saveState();
        renderBudget();
        toast('调度设置已保存。');
        break;
      }
      case 'forecast-open':
        ui.date = element.dataset.date || C.todayStr();
        switchView('today');
        break;
      case 'export':
        exportData();
        break;
      case 'import': {
        const input = $('#import-file');
        if (input) input.click();
        break;
      }
      case 'load-demo':
        loadDemo();
        break;
      case 'clear-all':
        clearAllData();
        break;
      default:
        break;
    }
  }

  document.addEventListener('click', function (event) {
    const tab = event.target.closest('.tab');
    if (tab) {
      switchView(tab.dataset.view);
      return;
    }
    const closeButton = event.target.closest('[data-close]');
    if (closeButton) {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.target.classList.contains('modal-backdrop')) {
      if (event.target.dataset.dismissible !== 'false') closeModal();
      return;
    }
    const presetColor = event.target.closest('[data-color]');
    if (presetColor) {
      const form = presetColor.closest('form');
      if (form) {
        const input = form.querySelector('input[name="color"]');
        if (input) {
          input.value = presetColor.dataset.color;
          updateColorPicker(form);
        }
      }
      return;
    }
    const actionElement = event.target.closest('[data-action]');
    if (actionElement) {
      handleAction(actionElement.dataset.action, actionElement);
    }
  });

  document.addEventListener('change', function (event) {
    if (event.target.id === 'today-date') {
      const value = event.target.value;
      ui.date = C.isValidYmd(value) ? value : C.todayStr();
      renderToday();
      return;
    }
    if (event.target.id === 'budget-date') {
      ui.budgetDate = C.isValidYmd(event.target.value) ? event.target.value : C.todayStr();
      renderBudget();
      return;
    }
    if (event.target.id === 'forecast-start') {
      ui.forecastStart = C.isValidYmd(event.target.value) ? event.target.value : C.todayStr();
      renderForecast();
      return;
    }
    if (event.target.id === 'forecast-days') {
      ui.forecastDays = Number(event.target.value) || 14;
      renderForecast();
      return;
    }
    if (event.target.id === 'entry-subject-filter') {
      ui.subjectFilter = event.target.value;
      renderEntryRows();
      return;
    }
    if (event.target.id === 'entry-sort') {
      ui.sort = event.target.value;
      renderEntryRows();
      return;
    }
    if (event.target.id === 'import-file') {
      importData(event.target);
      return;
    }
    const statusId = event.target.dataset.statusId;
    if (statusId) {
      const entry = findEntry(statusId);
      if (entry) {
        entry.status = event.target.value;
        entry.updatedAt = C.nowIso();
        saveState();
        renderEntryRows();
        toast('条目状态已更新。');
      }
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target.id === 'entry-search') {
      ui.search = event.target.value;
      renderEntryRows();
      return;
    }
    if (event.target.matches('input[type="color"][name="color"]')) {
      updateColorPicker(event.target.closest('form'));
    }
  });

  document.addEventListener('submit', function (event) {
    if (event.target.id === 'entry-form') {
      event.preventDefault();
      handleEntrySubmit(event.target);
      return;
    }
    if (event.target.id === 'subject-form') {
      event.preventDefault();
      handleSubjectCreate(event.target);
      return;
    }
    if (event.target.id === 'subject-edit-form') {
      event.preventDefault();
      handleSubjectEditSubmit(event.target);
      return;
    }
    if (event.target.id === 'complete-form') {
      event.preventDefault();
      const task = findPlanTask(event.target.dataset.key);
      if (!task) {
        toast('任务已经更新，请重新打开。');
        closeModal();
        return;
      }
      const actual = Number(event.target.elements.actualMinutes.value);
      const recall = event.target.elements.recall.value;
      const difficulty = Number(event.target.elements.difficulty.value) || 3;
      const note = event.target.elements.note.value.trim();
      const modeElement = event.target.elements.completionMode;
      const completionMode =
        modeElement && modeElement.value === 'partial' ? 'partial' : 'full';
      const errorElement = event.target.querySelector('.form-error');
      if (!Number.isFinite(actual) || actual <= 0) {
        errorElement.textContent = '实际用时需要大于 0 分钟。';
        errorElement.hidden = false;
        return;
      }
      if (actual > 600) {
        errorElement.textContent = '实际用时不能超过 600 分钟。';
        errorElement.hidden = false;
        return;
      }
      if (['easy', 'normal', 'hard', 'fail'].indexOf(recall) < 0) {
        errorElement.textContent = '请选择回忆结果。';
        errorElement.hidden = false;
        return;
      }
      completeTask(task, {
        actualMinutes: actual,
        recall: recall,
        difficulty: difficulty,
        note: note,
        completionMode: completionMode,
      });
      return;
    }
    if (event.target.id === 'label-form') {
      event.preventDefault();
      handleLabelSubmit(event.target);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && $('.modal-backdrop')) closeModal();
  });

  window.addEventListener('beforeprint', function () {
    renderToday();
  });

  /* ---------------- 启动 ---------------- */

  function init() {
    $$('.tab').forEach(function (tab) {
      tab.classList.toggle('active', tab.dataset.view === 'today');
    });
    render();
    if (!storageOk) {
      toast('浏览器禁用了本地存储，数据将无法保存。');
    }
    const hash = (location.hash || '').replace('#', '');
    if (['entries', 'subjects', 'data', 'budget', 'forecast'].indexOf(hash) >= 0) {
      switchView(hash);
    } else if (hash === 'new-entry') {
      openEntryForm(null);
    } else if (hash.indexOf('entry=') === 0) {
      openEntryDetail(decodeURIComponent(hash.slice(6)));
    }
  }

  init();
})();
