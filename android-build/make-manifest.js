#!/usr/bin/env node
/**
 * 生成在线更新的 manifest.json。
 *
 * 用法：
 *   node android-build/make-manifest.js --repo <user/repo> --tag v2.26.4 \
 *        --patch apk/app/src/main/assets/libretv.zip \
 *        --apk apk/app/build/outputs/apk/release/app-release.apk \
 *        --notes "修复弹幕对齐入口" --out manifest.json
 *
 * 生成的 urls 数组可以直接指 GitHub Release；以后换到 Cloudflare R2 或对象存储，
 * 只要把 --base 换成自己的域名重跑一次，App 端不用改。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const repo = get('--repo');
const tag = get('--tag');
const base = get('--base'); // 可选：自定义下载前缀，优先于 repo
const notes = get('--notes', '');
const out = get('--out', 'manifest.json');
const patchPath = get('--patch');
const apkPath = get('--apk');

if (!patchPath && !apkPath) {
  console.error('至少给一个 --patch 或 --apk');
  process.exit(1);
}

function assetInfo(file, name) {
  const buf = fs.readFileSync(file);
  return {
    urls: base
      ? [`${base.replace(/\/$/, '')}/${name}`]
      : [`https://github.com/${repo}/releases/download/${tag}/${name}`],
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'libretv', 'package.json'), 'utf8'));
const gradle = fs.readFileSync(path.join(__dirname, '..', 'apk', 'app', 'build.gradle'), 'utf8');
const versionCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1] || 0);

const manifest = {
  version: tag ? tag.replace(/^v/, '') : pkg.version,
  apkVersionCode: versionCode,
  notes,
};

if (patchPath) manifest.patch = assetInfo(patchPath, 'patch.zip');
if (apkPath) manifest.apk = { versionCode, ...assetInfo(apkPath, 'app-release.apk') };

fs.writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`manifest 已生成：${out}`);
console.log(`  版本 ${manifest.version} / versionCode ${versionCode}`);
if (manifest.patch) console.log(`  热更包 ${(manifest.patch.size / 1024 / 1024).toFixed(1)}MB`);
if (manifest.apk) console.log(`  安装包 ${(manifest.apk.size / 1024 / 1024).toFixed(1)}MB`);
console.log('\n把 patch.zip / app-release.apk 传到 GitHub Release 后，manifest.json 也一起传上去（或用 raw 地址）。');
