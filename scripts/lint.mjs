/**
 * 零依赖 lint：针对「单文件 HTML 工作台」这套形态定制的静态规则。
 * 不引 ESLint / HTMLHint，因为项目没有 npm 依赖，离线也要能跑。
 *
 * 规则分两级：
 *   ERROR   —— 阻断 CI（安全、外链、语法结构、体积）
 *   WARN    —— 只提示（遗留调试代码、待办标记）
 *
 * 用法：node scripts/lint.mjs [--strict]   --strict 时 WARN 也阻断
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const strict = process.argv.includes('--strict');

const issues = [];
const add = (level, rule, msg, where = '') => issues.push({ level, rule, msg, where });

function read(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

const html = read(path.join(ROOT, 'index.html'));
if (!html) {
  add('ERROR', 'no-source', '未找到 index.html');
  report();
}

/* ---------- 1. 零外链（铁律：全内联，避免「保存了 HTML、库 404」） ---------- */
const externals = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/g) || [];
if (externals.length) add('ERROR', 'no-external-asset', `存在外部资源引用：${externals.slice(0, 3).join(', ')}`);
if (/<link[^>]+rel=["']stylesheet/i.test(html)) add('ERROR', 'no-external-css', '不应外引样式表');
for (const kw of ['cdn.', 'unpkg', 'jsdelivr', 'googleapis', 'bootcdn']) {
  if (html.includes(kw)) add('ERROR', 'no-cdn', `检测到 CDN 关键字：${kw}`);
}

/* ---------- 2. 安全 ---------- */
const secrets = [
  [/sk-[A-Za-z0-9_-]{20,}/g, '疑似 OpenAI/DeepSeek API Key'],
  [/AKIA[0-9A-Z]{16}/g, '疑似 AWS Access Key'],
  [/Bearer\s+[A-Za-z0-9._-]{24,}/g, '疑似 Bearer Token'],
  [/(?:api[_-]?key|apikey|secret)\s*[:=]\s*["'][A-Za-z0-9._-]{16,}["']/gi, '疑似硬编码密钥']
];
for (const [re, label] of secrets) {
  const hit = html.match(re);
  if (hit) add('ERROR', 'no-hardcoded-secret', `${label}：${hit[0].slice(0, 12)}…`);
}
if (/\beval\s*\(/.test(html)) add('ERROR', 'no-eval', '使用了 eval()，存在注入风险');
if (/new\s+Function\s*\(/.test(html)) add('ERROR', 'no-new-function', '使用了 new Function()，存在注入风险');

/* ---------- 3. XSS：innerHTML 赋值必须过转义 ---------- */
const inlineJs = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/\ssrc\s*=/.test(m[1]))
  .map((m) => m[2])
  .join('\n');
for (const m of inlineJs.matchAll(/\.innerHTML\s*=\s*([^;]{0,120})/g)) {
  const rhs = m[1];
  if (!/escapeHtml|sanitizeHtml|textContent|''|""|`<\/|\+=/.test(rhs)) {
    add('ERROR', 'no-raw-innerhtml', `innerHTML 赋值疑似未转义：${rhs.trim().slice(0, 60)}`);
  }
}

/* ---------- 4. 结构完整性 ---------- */
if (!/^\s*<!DOCTYPE html>/i.test(html)) add('ERROR', 'doctype', '缺少 <!DOCTYPE html>');
if (!/<\/html>\s*$/i.test(html)) add('ERROR', 'truncated', 'HTML 未正常收尾，可能被截断');
const openScript = (html.match(/<script\b/g) || []).length;
const closeScript = (html.match(/<\/script>/g) || []).length;
if (openScript !== closeScript) add('ERROR', 'unbalanced-script', `<script> 与 </script> 数量不等：${openScript} vs ${closeScript}`);
// 标签配对只在「静态 HTML」上统计：JS 模板字符串里的标签会跨行拼接，直接数必然误报
const staticHtml = html
  .replace(/<script([^>]*)>[\s\S]*?<\/script>/g, '')
  .replace(/<style([^>]*)>[\s\S]*?<\/style>/g, '');
for (const tag of ['div', 'nav', 'section', 'button', 'table']) {
  const open = (staticHtml.match(new RegExp(`<${tag}\\b`, 'g')) || []).length;
  const close = (staticHtml.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  if (open !== close) add('ERROR', 'unbalanced-tag', `<${tag}> 与 </${tag}> 数量不等：${open} vs ${close}`);
}

/* ---------- 5. 移动端规范 ---------- */
if (!/name=["']viewport["']/.test(html)) add('ERROR', 'viewport', '缺少 viewport meta');
if (!/env\(safe-area-inset-bottom\)/.test(html)) add('WARN', 'safe-area', '未适配 iPhone 底部安全区');
if (!/font-size:\s*16px/.test(html)) add('WARN', 'input-font-size', '未见 16px 输入字号，iOS 可能自动缩放页面');

/* ---------- 6. 遗留调试痕迹（WARN） ---------- */
const dbg = inlineJs.match(/\b(console\.(log|debug|info|warn)|debugger)\b/g) || [];
if (dbg.length) add('WARN', 'no-debug-leftover', `遗留调试语句 ${dbg.length} 处：${[...new Set(dbg)].slice(0, 4).join(', ')}`);
const todos = html.match(/\b(TODO|FIXME|XXX|HACK)\b/g) || [];
if (todos.length) add('WARN', 'todo-marker', `待办标记 ${todos.length} 处`);

/* ---------- 7. 体积门禁 ---------- */
const bytes = Buffer.byteLength(html, 'utf8');
if (bytes > 3 * 1024 * 1024) add('ERROR', 'size-limit', `单文件 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过 3MB，建议拆模块`);

function report() {
  const errors = issues.filter((i) => i.level === 'ERROR');
  const warns = issues.filter((i) => i.level === 'WARN');
  for (const i of issues) console.log(`${i.level.padEnd(5)} ${i.rule}${i.where ? ` (${i.where})` : ''} — ${i.msg}`);
  console.log(`\n[lint] ${errors.length} 个错误 · ${warns.length} 个警告 · 体积 ${(bytes / 1024).toFixed(1)} KB`);
  process.exit(errors.length || (strict && warns.length) ? 1 : 0);
}

report();
