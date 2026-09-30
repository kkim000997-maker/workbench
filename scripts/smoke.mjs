/**
 * 冒烟测试：把 dist/ 当静态站点起一个本地服务，按 HTTP 协议真实取一次页面。
 * 目的是拦住「构建成功但页面白屏 / 产物漏文件」这类只有运行时才暴露的问题。
 * 零依赖，只用 node:http + node:fs。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');
const PORT = Number(process.env.SMOKE_PORT || 4173);
const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

if (!fs.existsSync(DIST)) {
  check('dist 目录存在', false, '请先执行 npm run build');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;

try {
  const res = await fetch(`${base}/`);
  const body = await res.text();
  check('首页返回 200', res.status === 200, `status=${res.status}`);
  check('页面标题正确', /<title[^>]*>个人工作台<\/title>/.test(body));
  check('页面结构完整', body.includes('<!DOCTYPE html>') && body.trimEnd().endsWith('</html>'));
  check('零外链依赖', !/(?:src|href)\s*=\s*["']https?:\/\/[^"']+["']/.test(body));
  check('关键入口已渲染', body.includes('refreshAll') && body.includes('DOMContentLoaded'));

  const ver = body.match(/name="build:version" content="([^"]+)"/);
  check('构建元信息已注入', Boolean(ver), ver ? `version=${ver[1]}` : '未找到 build:version');

  const infoRes = await fetch(`${base}/build-info.json`);
  check('构建清单可访问', infoRes.status === 200);
  if (infoRes.status === 200) {
    const info = await infoRes.json();
    check('产物体积在阈值内 (<3MB)', info.bytes < 3 * 1024 * 1024, `${info.kb} KB`);
  }

  const miss = await fetch(`${base}/__not_exist__.html`);
  check('未知路径返回 404', miss.status === 404);
} finally {
  server.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n[smoke] ${checks.length - failed.length}/${checks.length} 项通过`);
process.exit(failed.length ? 1 : 0);
