/* 基础工具：日期、数值、格式化、转义。
 * 纯函数，不依赖 DOM，可在 Node 中直接加载做单元测试。
 */
(function (global) {
  'use strict';

  const BS = (global.BS = global.BS || {});
  const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  // 预设标签色（低饱和平面色），科目也可以使用任意自定义颜色
  const PRESET_COLORS = [
    '#f2e5c9',
    '#d9e7f2',
    '#ddeada',
    '#f3dde0',
    '#e5deef',
    '#f6e0cd',
    '#dce5e8',
    '#d8ecea',
    '#ede8d5',
    '#e9e4e0',
  ];

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function toUtcMs(ymd) {
    const parts = String(ymd).split('-').map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]);
  }

  function addDays(ymd, days) {
    const dt = new Date(toUtcMs(ymd) + days * 86400000);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }

  function diffDays(from, to) {
    return Math.round((toUtcMs(to) - toUtcMs(from)) / 86400000);
  }

  function isValidYmd(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parts = value.split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    const d = parts[2];
    if (y < 1970 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  // ISO 星期：周一 = 1 …… 周日 = 7
  function isoWeekday(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return day === 0 ? 7 : day;
  }

  function weekdayName(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  }

  function fmtShort(ymd) {
    return ymd ? ymd.replace(/-/g, '/') : '';
  }

  function fmtLong(ymd) {
    if (!isValidYmd(ymd)) return '';
    const parts = ymd.split('-').map(Number);
    return parts[0] + '年' + parts[1] + '月' + parts[2] + '日 ' + weekdayName(ymd);
  }

  function fmtMonthDay(ymd) {
    if (!isValidYmd(ymd)) return '';
    const parts = ymd.split('-').map(Number);
    return parts[1] + '月' + parts[2] + '日';
  }

  // 任务用时的显示：保留一位小数，例如 10.6 分钟
  function fmtMinutes(minutes) {
    const value = Math.round(Number(minutes || 0) * 10) / 10;
    return (Number.isInteger(value) ? String(value) : value.toFixed(1)) + ' 分钟';
  }

  // 预算汇总的显示：整数分钟，超过 1 小时用「x 小时 y 分」
  function fmtDuration(minutes) {
    const total = Math.max(0, Math.round(Number(minutes) || 0));
    if (total < 60) return total + ' 分钟';
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h + ' 小时' + (m ? ' ' + pad2(m) + ' 分' : '');
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round1(value) {
    return Math.round(Number(value || 0) * 10) / 10;
  }

  function round2(value) {
    return Math.round(Number(value || 0) * 100) / 100;
  }

  function uid(prefix) {
    return (
      String(prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    );
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeHex(value) {
    if (typeof value !== 'string') return null;
    let v = value.trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(v)) {
      v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    return /^#[0-9a-f]{6}$/.test(v) ? v : null;
  }

  function hexToRgb(hex) {
    const v = normalizeHex(hex);
    if (!v) return null;
    return {
      r: parseInt(v.slice(1, 3), 16),
      g: parseInt(v.slice(3, 5), 16),
      b: parseInt(v.slice(5, 7), 16),
    };
  }

  // 根据底色亮度自动选深色或白色文字
  function readableText(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return '#262626';
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance > 0.62 ? '#262626' : '#ffffff';
  }

  function sumValues(map) {
    let total = 0;
    Object.keys(map || {}).forEach(function (key) {
      const n = Number(map[key]);
      if (Number.isFinite(n)) total += n;
    });
    return total;
  }

  function toFiniteNumber(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function dateRange(start, days) {
    const out = [];
    for (let i = 0; i < days; i++) out.push(addDays(start, i));
    return out;
  }

  // 把 ISO 时间转成本地日期（用于从 createdAt 推算等待天数）
  function isoToLocalDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  BS.Core = {
    WEEKDAYS: WEEKDAYS,
    PRESET_COLORS: PRESET_COLORS,
    pad2: pad2,
    todayStr: todayStr,
    addDays: addDays,
    diffDays: diffDays,
    isValidYmd: isValidYmd,
    isoWeekday: isoWeekday,
    weekdayName: weekdayName,
    fmtShort: fmtShort,
    fmtLong: fmtLong,
    fmtMonthDay: fmtMonthDay,
    fmtMinutes: fmtMinutes,
    fmtDuration: fmtDuration,
    clamp: clamp,
    round1: round1,
    round2: round2,
    uid: uid,
    nowIso: nowIso,
    esc: esc,
    clone: clone,
    normalizeHex: normalizeHex,
    hexToRgb: hexToRgb,
    readableText: readableText,
    sumValues: sumValues,
    toFiniteNumber: toFiniteNumber,
    dateRange: dateRange,
    isoToLocalDate: isoToLocalDate,
  };
})(typeof window !== 'undefined' ? window : globalThis);
