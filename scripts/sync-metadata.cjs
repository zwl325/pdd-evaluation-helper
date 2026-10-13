'use strict';

// @version是版本的唯一来源；同步名称、运行时版本和更新元数据。
// --version YYYY-MM-DD.N负责升版；--check只读，供发布前和CI使用。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourcePath = path.join(root, 'pdd-evaluation-filter.user.js');
const metadataPath = path.join(root, 'pdd-evaluation-filter.meta.js');
let source = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
const header = source.match(/^\/\/ ==UserScript==\n[\s\S]*?^\/\/ ==\/UserScript==\n/m)?.[0];
assert.ok(header, '主脚本必须含完整userscript元数据块');

function value(key) {
  const matches = [...header.matchAll(new RegExp(`^// @${key}\\s+(.+)$`, 'gm'))];
  assert.equal(matches.length, 1, `@${key}必须且只能出现一次`);
  return matches[0][1].trim();
}

function parseVersion(version) {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})(?:\.([1-9]\d*))?$/.exec(version);
  assert.ok(match, '版本使用YYYY-MM-DD.N（N为无前导零的正整数），兼容历史YYYY-MM-DD');
  const [, year, month, day, sequence = '0'] = match;
  const dateText = `${year}-${month}-${day}`;
  const date = new Date(`${dateText}T00:00:00Z`);
  assert.ok(Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dateText,
    '版本日期必须是真实日历日期');
  const parts = [Number(year), Number(month), Number(day), Number(sequence)];
  assert.ok(Number.isSafeInteger(parts[3]), '当日发布序号超出安全整数范围');
  return parts;
}

function higherVersion(candidate, current) {
  const next = parseVersion(candidate);
  const prior = parseVersion(current);
  for (let index = 0; index < next.length; index++) {
    if (next[index] !== prior[index]) return next[index] > prior[index];
  }
  return false;
}

const args = process.argv.slice(2);
const check = args.length === 1 && args[0] === '--check';
const requested = args.length === 2 && args[0] === '--version' ? args[1] : null;
assert.ok(args.length === 0 || check || requested,
  '用法：node scripts/sync-metadata.cjs [--check | --version YYYY-MM-DD.N]');

const currentVersion = value('version');
parseVersion(currentVersion);
const version = requested || currentVersion;
if (requested) {
  assert.match(requested, /\.[1-9]\d*$/, '新版本必须带当日发布序号：YYYY-MM-DD.N');
  assert.ok(higherVersion(requested, currentVersion), '新版本必须严格大于当前@version，禁止同版重发或降版');
}
value('name'); // 同样拒绝重复或缺失@name。
assert.equal(value('namespace'), 'urn:local:pdd:evaluation-helper', '保持既有命名空间');
assert.equal(value('updateURL'),
  'https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js');
assert.equal(value('downloadURL'),
  'https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js');

const name = `PDD评价筛选助手 v${version}`;
const nextHeader = header
  .replace(/^\/\/ @name\s+.+$/m, `// @name         ${name}`)
  .replace(/^\/\/ @version\s+.+$/m, `// @version      ${version}`);
source = source.replace(header, nextHeader);
const runtimePattern = /^(\s+version: ')[^']+(',)$/gm;
assert.equal([...source.matchAll(runtimePattern)].length, 1, 'Config.version必须且只能出现一次');
source = source.replace(runtimePattern, (_, prefix, suffix) => `${prefix}${version}${suffix}`);

if (check) {
  const actualSource = fs.readFileSync(sourcePath, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(actualSource, source, '@name或Config.version与@version不同步，请运行node scripts/sync-metadata.cjs');
  const metadata = fs.readFileSync(metadataPath, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(metadata, nextHeader, '.meta.js与主脚本头部不一致，请运行node scripts/sync-metadata.cjs');
  console.log(`PASS name, version, runtime, metadata and update URLs (${version})`);
} else {
  fs.writeFileSync(sourcePath, source, 'utf8');
  fs.writeFileSync(metadataPath, nextHeader, 'utf8');
  console.log(`Synchronized ${name}, Config.version and pdd-evaluation-filter.meta.js`);
}
