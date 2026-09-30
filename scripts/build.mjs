/**
 * 单文件工作台的「构建」步骤。
 * 本项目没有打包器（无框架、无 CDN、全内联），构建只做三件事：
 *   1. 源文件的结构性校验（坏了就 fail fast，不产出脏产物）
 *   2. 按部署目标处理平台注入脚本（外网部署时移除，页面自动降级为本地模式）
 *   3. 注入构建元信息 + 产出 dist/（含 GitHub Pages 需要的 .nojekyll）
 *
 * 用法：node scripts/build.mjs
 * 环境变量：
 *   DEPLOY_TARGET=pages|workbuddy  默认 pages
 *   BUILD_VERSION                  默认取 GITHUB_SHA 前 7 位或 dev
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const OUT = path.join(ROOT, 'dist');

const target = process.env.DEPLOY_TARGET || 'pages';
const version = process.env.BUILD_VERSION || (process.env.GITHUB_SHA || 'dev').slice(0, 7);
const builtAt = new Date().toISOString();

function fail(msg) {
  console.error(`[build] 失败：${msg}`);
  process.exit(1);
}

if (!fs.existsSync(SRC)) fail('缺少源文件 index.html');

let html = fs.readFileSync(SRC, 'utf8');

// --- 1. 结构性校验 ---
if (!/^\s*<!DOCTYPE html>/i.test(html)) fail('index.html 缺少 <!DOCTYPE html> 声明');
if (!/<\/html>\s*$/i.test(html)) fail('index.html 未以 </html> 正常收尾（可能导出/传输被截断）');
const external = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/g);
if (external) fail(`检测到外部依赖，违反「全内联零外链」规范：${external.slice(0, 3).join(', ')}`);

// --- 2. 按部署目标处理平台注入脚本 ---
// 只有「回到资料库」这种目标才需要保留平台 SDK；pages / rsync 都跑在 WorkBuddy 之外，
// 留着只会请求一个 404 的路径（页面已有降级分支，但没必要多一次失败请求）。
let stripped = false;
if (target !== 'workbuddy') {
  const before = html;
  html = html.replace(
    /\s*<script[^>]*src=["']\/page\/page_comm\/inject\.js["'][^>]*>\s*<\/script>/g,
    '\n<!-- 平台数据 SDK 注入脚本已在外网构建中移除：页面检测到 __SMART_PAGE__ 缺失后自动降级为本地存储模式 -->'
  );
  stripped = html !== before;
}

// --- 3. 注入构建元信息 ---
if (!/<head[^>]*>/i.test(html)) fail('index.html 缺少 <head> 标签');
html = html.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="build:version" content="${version}">\n<meta name="build:time" content="${builtAt}">\n<meta name="build:target" content="${target}">`);

// --- 4. 产出 dist ---
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'index.html'), html);
fs.writeFileSync(path.join(OUT, '.nojekyll'), ''); // 跳过 Jekyll 处理，避免下划线目录/文件被吞

const bytes = Buffer.byteLength(html, 'utf8');
const info = {
  name: 'personal-workbench',
  version,
  target,
  builtAt,
  bytes,
  kb: +(bytes / 1024).toFixed(1),
  injectScriptStripped: stripped
};
fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2));

console.log(`[build] 目标 ${target} · 版本 ${version} · ${info.kb} KB · 平台脚本移除=${stripped}`);
console.log(`[build] 产物已写入 ${path.relative(ROOT, OUT)}/`);
