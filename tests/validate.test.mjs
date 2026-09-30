/**
 * 源码质量测试（零依赖，node:test 原生跑）。
 * 覆盖：单文件完整性、零外链、JS 语法可编译、移动端规范、架构单向调用、密钥泄漏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** 取出内联脚本正文（排除带 src 的外引脚本） */
function inlineScripts(src) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) {
    if (/\ssrc\s*=/.test(m[1])) continue;
    out.push(m[2]);
  }
  return out;
}

const scripts = inlineScripts(html);
const js = scripts.join('\n;\n');

test('项目是完整的单文件 HTML', () => {
  assert.match(html, /^\s*<!DOCTYPE html>/i, '缺少 DOCTYPE');
  assert.match(html, /<\/html>\s*$/i, 'HTML 未正常收尾，可能被截断');
  assert.ok(scripts.length >= 1, '未找到内联脚本');
  assert.equal((html.match(/<link[^>]+rel=["']stylesheet/i) || []).length, 0, '不应外引样式表');
});

test('零外部依赖：不引用任何 CDN / 外部资源', () => {
  const hits = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/g) || [];
  assert.deepEqual(hits, [], `发现外链：${hits.join(', ')}`);
  assert.equal((html.match(/cdn\.|unpkg|jsdelivr|googleapis/gi) || []).length, 0);
});

test('内联 JS 语法可编译（不执行）', () => {
  for (const [i, code] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: `inline-${i}.js` }), `第 ${i + 1} 段脚本语法错误`);
  }
});

test('移动端规范：viewport / 安全区 / 点击区 / 输入字号', () => {
  assert.match(html, /name=["']viewport["']/, '缺少 viewport');
  assert.match(html, /width=device-width/, 'viewport 未设置 width=device-width');
  assert.match(html, /env\(safe-area-inset-bottom\)/, '未适配 iPhone 底部安全区');
  assert.match(html, /min-height:\s*(?:44|48|50|56)px/, '按钮点击区应 ≥44px');
  assert.match(html, /font-size:\s*16px/, '输入框字号应 ≥16px，否则 iOS 会缩放页面');
});

test('架构铁律：渲染函数调用图无环（不得互相调用）', () => {
  const bodies = new Map();
  for (const seg of js.split(/\nfunction /).slice(1)) {
    const name = seg.slice(0, seg.indexOf('('));
    if (/^render[A-Z]/.test(name)) bodies.set(name, seg);
  }
  assert.ok(bodies.size >= 3, `未识别到足够多的渲染函数（找到 ${bodies.size} 个）`);

  // 建图：renderA -> renderB
  const graph = new Map([...bodies.keys()].map((k) => [k, []]));
  for (const [name, body] of bodies) {
    for (const m of body.matchAll(/\brender[A-Z][A-Za-z0-9]*\s*\(/g)) {
      const callee = m[0].replace(/\s*\($/, '');
      if (callee !== name && bodies.has(callee)) graph.get(name).push(callee);
    }
  }

  // 硬失败：存在环（A→B→A 会导致栈溢出，静态检查拦不住，只能靠这层）
  const state = new Map(); // 0 未访问 / 1 访问中 / 2 已完成
  const cycles = [];
  const stack = [];
  const dfs = (n) => {
    state.set(n, 1);
    stack.push(n);
    for (const next of graph.get(n)) {
      if (state.get(next) === 1) cycles.push([...stack.slice(stack.indexOf(next)), next].join(' → '));
      else if (!state.get(next)) dfs(next);
    }
    stack.pop();
    state.set(n, 2);
  };
  for (const n of graph.keys()) if (!state.get(n)) dfs(n);
  assert.deepEqual(cycles, [], `渲染函数存在调用环：${cycles.join('；')}`);

  // 软提示：单向跨调用不算环，但属于待解耦的耦合点
  const coupling = [...graph].filter(([, v]) => v.length).map(([k, v]) => `${k} → ${v.join(', ')}`);
  if (coupling.length) console.warn(`[warn] 渲染函数之间仍有单向耦合，建议收敛到 refreshAll：${coupling.join('；')}`);

  assert.match(js, /function refreshAll\s*\(/, '缺少统一刷新入口 refreshAll');
});

test('无硬编码密钥 / 凭据', () => {
  const patterns = [/sk-[A-Za-z0-9_-]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{20,}/g, /AKIA[0-9A-Z]{16}/g];
  for (const p of patterns) {
    const hits = html.match(p) || [];
    assert.deepEqual(hits, [], `疑似明文凭据：${hits[0] || ''}`);
  }
});

test('单文件体积在阈值内', () => {
  const bytes = Buffer.byteLength(html, 'utf8');
  assert.ok(bytes < 3 * 1024 * 1024, `体积 ${(bytes / 1024 / 1024).toFixed(2)}MB 超过 3MB 阈值，建议拆分模块`);
});
