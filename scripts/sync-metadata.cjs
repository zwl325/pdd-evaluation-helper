'use strict';

// .user.js是唯一元数据来源；检查模式供发布前检查和GitHub Actions使用。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'pdd-evaluation-filter.user.js');
const metadataPath = path.join(root, 'pdd-evaluation-filter.meta.js');
const source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const header = source.match(/^\/\/ ==UserScript==\n[\s\S]*?^\/\/ ==\/UserScript==\n/m)?.[0];
assert.ok(header, '主脚本必须含完整userscript元数据块');

function value(key) {
  const matches = [...header.matchAll(new RegExp(`^// @${key}\\s+(.+)$`, 'gm'))];
  assert.equal(matches.length, 1, `@${key}必须且只能出现一次`);
  return matches[0][1].trim();
}

const version = value('version');
assert.match(version, /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/, '版本使用YYYY-MM-DD或YYYY-MM-DD.N');
const runtimeVersion = source.match(/^\s+version: '([^']+)',/m)?.[1];
assert.equal(runtimeVersion, version, '@version必须与Config.version一致');
assert.equal(value('namespace'), 'urn:local:pdd:evaluation-helper', '保持既有脚本身份');
assert.equal(value('updateURL'),
  'https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js');
assert.equal(value('downloadURL'),
  'https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js');

if (process.argv.includes('--check')) {
  const metadata = fs.readFileSync(metadataPath, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(metadata, header, '.meta.js与主脚本头部不一致，请先运行node scripts/sync-metadata.cjs');
  console.log(`PASS userscript metadata and update URLs (${version})`);
} else {
  fs.writeFileSync(metadataPath, header, 'utf8');
  console.log(`Generated pdd-evaluation-filter.meta.js (${version})`);
}
