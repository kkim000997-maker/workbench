/**
 * 类型 / 契约检查（零依赖）。
 *
 * 说明：本项目是浏览器端 ES5 单文件应用，没有 TypeScript，跑不了 tsc --noEmit。
 * 这里做的是「静态可判定的引用与契约检查」，等价于把最容易白屏的那类类型错误提前拦住：
 *   1. 调用了不存在的函数（拼写错、漏定义）——运行期才炸的典型
 *   2. 同名函数重复定义——后者静默覆盖前者
 *   3. getElementById 的 id 在页面里不存在——经典 null 引用
 *   4. state 上读取了未初始化的字段——undefined 传播
 *   5. JSON.parse 未包 try/catch——脏数据直接抛异常打断渲染
 *   6. 渲染函数互相调用成环——栈溢出
 *
 * 将来引入 TypeScript 后，本脚本可整体替换为 `tsc --noEmit`，CI 步骤不用改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let js = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
  .filter((m) => !/\ssrc\s*=/.test(m[1]))
  .map((m) => m[2])
  .join('\n');

// 去掉注释：契约说明里写的 recognize()/lookup() 是文档，不是真实调用
// 注意 (?<!:) 用于跳过 http:// 、https:// 这类字符串里的双斜杠
js = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/[^\n]*/g, '');

const errors = [];
const warns = [];
const err = (m) => errors.push(m);
const warn = (m) => warns.push(m);

/* ---------- 1. 函数调用引用完整性 ---------- */
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'delete', 'void', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'case', 'var', 'let', 'const', 'class', 'extends', 'super', 'yield', 'await', 'async', 'instanceof', 'break', 'continue', 'with', 'debugger']);
const GLOBALS = new Set(['document', 'window', 'localStorage', 'sessionStorage', 'alert', 'confirm', 'prompt', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'console', 'JSON', 'Math', 'Date', 'Object', 'Array', 'String', 'Number', 'Boolean', 'RegExp', 'Error', 'TypeError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'FileReader', 'FormData', 'XMLHttpRequest', 'Blob', 'File', 'URL', 'Image', 'Event', 'CustomEvent', 'requestAnimationFrame', 'cancelAnimationFrame', 'indexedDB', 'navigator', 'location', 'history', 'screen', 'atob', 'btoa', 'structuredClone', 'performance', 'crypto', 'TextDecoder', 'TextEncoder', 'Uint8Array', 'ArrayBuffer', 'DataView', 'Infinity', 'NaN', 'undefined', 'null', 'true', 'false', 'this', 'arguments', 'eval', 'Function', 'Boolean', 'Symbol', 'Proxy', 'Reflect']);

const defined = new Set();
for (const m of js.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of js.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*function/g)) defined.add(m[1]);
for (const m of js.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*function/g)) defined.add(m[1]); // 对象字面量上的方法
// 形参也是合法的可调用名（cb、makeCall、resolve、reject 这类回调）
for (const m of js.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
  for (const p of m[1].split(',')) {
    const name = p.trim().split(/\s*=/)[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
  }
}

// 重复定义只看顶层：嵌套在不同函数里的同名 step() 属正常写法
const defCounts = new Map();
for (const m of js.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) defCounts.set(m[1], (defCounts.get(m[1]) || 0) + 1);
for (const [name, n] of defCounts) if (n > 1) err(`顶层函数重复定义 ${n} 次：${name}()`);

const calls = new Set();
for (const m of js.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(m[1]);
const unknown = [...calls].filter((c) => !defined.has(c) && !KEYWORDS.has(c) && !GLOBALS.has(c));
if (unknown.length) err(`调用了未定义的函数（${unknown.length}）：${unknown.slice(0, 12).join(', ')}`);

/* ---------- 2. DOM id 契约 ---------- */
const staticHtml = html.replace(/<script([^>]*)>[\s\S]*?<\/script>/g, '');
const htmlIds = new Set([...staticHtml.matchAll(/\bid\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]));
const jsStringIds = new Set([...js.matchAll(/["']([A-Za-z][\w-]{2,40})["']/g)].map((m) => m[1]));
const missingIds = [];
for (const m of js.matchAll(/getElementById\(\s*["']([^"']+)["']/g)) {
  const id = m[1];
  if (!htmlIds.has(id) && !jsStringIds.has(id)) missingIds.push(id);
}
if (missingIds.length) {
  const uniq = [...new Set(missingIds)];
  (uniq.length > 6 ? warn : err)(`getElementById 取不到对应元素（${uniq.length}）：${uniq.slice(0, 8).join(', ')}`);
}

/* ---------- 3. state 字段契约 ---------- */
const stateInit = js.match(/var\s+state\s*=\s*\{([\s\S]*?)\n\s*\};/);
if (stateInit) {
  const keys = new Set([...stateInit[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\bstate\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const notInit = [...used].filter((k) => !keys.has(k));
  if (notInit.length) warn(`state 上读取了未在初始化中声明的字段：${notInit.join(', ')}`);
}

/* ---------- 4. JSON.parse 未包 try ---------- */
const risky = [];
for (const m of js.matchAll(/JSON\.parse\(/g)) {
  const before = js.slice(Math.max(0, m.index - 200), m.index);
  if (!/\btry\s*\{/.test(before)) risky.push(m.index);
}
if (risky.length) warn(`JSON.parse 未包在 try 中（${risky.length} 处），脏数据会抛异常打断渲染`);

/* ---------- 5. 渲染函数调用图无环 ---------- */
const graph = new Map();
for (const seg of js.split(/\nfunction /).slice(1)) {
  const name = seg.slice(0, seg.indexOf('('));
  const deps = [...seg.matchAll(/\brender[A-Z][\w$]*\s*\(/g)].map((m) => m[0].replace(/\s*\($/, ''));
  graph.set(name, deps.filter((d) => d !== name));
}
const renderNodes = [...graph.keys()].filter((n) => /^render[A-Z]/.test(n));
const color = new Map();
const cycles = [];
const dfs = (n, stack) => {
  color.set(n, 1);
  stack.push(n);
  for (const d of graph.get(n) || []) {
    if (!graph.has(d)) continue;
    if (color.get(d) === 1) cycles.push([...stack.slice(stack.indexOf(d)), d].join(' → '));
    else if (!color.get(d)) dfs(d, stack);
  }
  stack.pop();
  color.set(n, 2);
};
for (const n of renderNodes) if (!color.get(n)) dfs(n, []);
if (cycles.length) err(`渲染函数存在调用环（会栈溢出）：${cycles.join('；')}`);

/* ---------- 输出 ---------- */
for (const m of errors) console.log(`ERROR ${m}`);
for (const m of warns) console.log(`WARN  ${m}`);
console.log(`\n[typecheck] 函数 ${defined.size} 个 · 调用点 ${calls.size} 个 · ${errors.length} 个错误 · ${warns.length} 个警告`);
process.exit(errors.length ? 1 : 0);
