/**
 * 部署后健康检查：轮询目标 URL，确认「真的上线了，而且上的是这一版」。
 *
 * 只查状态码是不够的——首页返回 200 但内容还是旧版本 / 白屏，是最常见的假绿灯。
 * 因此这里同时校验：状态码 200 + 页面标题 + 构建版本号（可选）。
 *
 * 用法：
 *   node scripts/healthcheck.mjs --url https://example.com --expect a1b2c3d [--tries 12] [--interval 10] [--strict-version]
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    expect: { type: 'string', default: '' },
    title: { type: 'string', default: '个人工作台' },
    tries: { type: 'string', default: '12' },
    interval: { type: 'string', default: '10' },
    'strict-version': { type: 'boolean', default: false }
  }
});

const url = values.url;
if (!url) {
  console.error('缺少 --url');
  process.exit(2);
}
const tries = Number(values.tries);
const interval = Number(values.interval) * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let last = { code: 0, titleOk: false, version: '', err: '' };
for (let i = 1; i <= tries; i++) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const body = res.status === 200 ? await res.text() : '';
    const titleOk = new RegExp(`<title[^>]*>${values.title}</title>`).test(body);
    const vm = body.match(/name="build:version" content="([^"]+)"/);
    last = { code: res.status, titleOk, version: vm ? vm[1] : '', err: '' };

    const versionOk = !values.expect || last.version === values.expect;
    console.log(`[health] 第 ${i}/${tries} 次：HTTP ${last.code} · 标题=${last.titleOk ? 'OK' : '缺失'} · 版本=${last.version || '未知'}`);

    if (last.code === 200 && titleOk && versionOk) {
      console.log(`[health] 通过：${url}`);
      process.exit(0);
    }
  } catch (e) {
    last = { code: 0, titleOk: false, version: '', err: e.message };
    console.log(`[health] 第 ${i}/${tries} 次：请求失败 — ${e.message}`);
  }
  if (i < tries) await sleep(interval);
}

// 全部重试结束仍不达标
if (last.code === 200 && last.titleOk && values.expect && last.version !== values.expect) {
  const msg = `页面可访问，但版本不一致：期望 ${values.expect}，实际 ${last.version || '未知'}（多为 CDN 缓存未刷新）`;
  if (values['strict-version']) {
    console.error(`[health] 失败：${msg}`);
    process.exit(1);
  }
  console.warn(`[health] 警告：${msg}`);
  process.exit(0);
}

console.error(`[health] 失败：HTTP ${last.code || 'ERR'} · 标题=${last.titleOk ? 'OK' : '缺失'} · ${last.err || '内容校验未通过'}`);
process.exit(1);
