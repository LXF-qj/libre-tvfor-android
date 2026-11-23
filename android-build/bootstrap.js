'use strict';

/**
 * LibreTV Android 启动引导
 * 1. 切换工作目录到解压后的应用根目录
 * 2. 手动解析 .env（Next standalone 不会自动加载）
 * 3. 以 127.0.0.1 监听，交给 Next 的 server.js
 */

const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
try {
  process.chdir(ROOT);
} catch (e) {
  console.error('[bootstrap] chdir failed:', e && e.message);
}

// ---- 解析 .env ----
function loadEnv(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return 0;
  }
  let count = 0;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
      count++;
    }
  }
  return count;
}

const loaded = loadEnv(path.join(ROOT, '.env'));
console.log('[bootstrap] env vars loaded:', loaded);

process.env.NODE_ENV = 'production';
process.env.NEXT_TELEMETRY_DISABLED = '1';
if (!process.env.PORT) process.env.PORT = '8090';
if (!process.env.HOSTNAME) process.env.HOSTNAME = '127.0.0.1';
process.env.KEEP_ALIVE_TIMEOUT = process.env.KEEP_ALIVE_TIMEOUT || '65000';

// 缓存目录需可写
try {
  fs.mkdirSync(path.join(ROOT, '.next', 'cache'), { recursive: true });
} catch (e) {
  console.error('[bootstrap] mkdir cache failed:', e && e.message);
}

console.log('[bootstrap] node', process.version, 'root', ROOT, 'listen', process.env.HOSTNAME + ':' + process.env.PORT);

process.on('uncaughtException', (err) => {
  console.error('[bootstrap] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[bootstrap] unhandledRejection:', err && err.stack ? err.stack : err);
});

require('./server.js');
