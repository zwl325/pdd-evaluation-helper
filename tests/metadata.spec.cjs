'use strict';

// 在临时目录验证真实发布命令；不修改工作区脚本或访问网络。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'scripts/sync-metadata.cjs'), 'utf8');
const baseVersion = source.match(/^\/\/ @version\s+(.+)$/m)[1].trim();
const headerOf = value => value.match(/^\/\/ ==UserScript==\n[\s\S]*?^\/\/ ==\/UserScript==\n/m)[0];
let passed = 0;

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdd-version-test-'));
  fs.mkdirSync(path.join(directory, 'scripts'));
  fs.writeFileSync(path.join(directory, 'scripts/sync-metadata.cjs'), script);
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), source);
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.meta.js'), headerOf(source));
  return directory;
}
function command(directory, args = [], success = true) {
  const result = spawnSync(process.execPath, ['scripts/sync-metadata.cjs', ...args],
    { cwd: directory, encoding: 'utf8' });
  assert.equal(result.error, undefined);
  if (success) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, '不合规发布必须拒绝');
  return result;
}
const read = directory => fs.readFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), 'utf8');
function test(name, action) {
  const directory = fixture();
  try {
    action(directory);
    passed++;
    console.log(`PASS ${name}`);
  } finally {
    const resolved = fs.realpathSync(directory);
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    assert.equal(path.dirname(resolved), temporaryRoot, '清理目标必须是系统临时目录中的测试目录');
    assert.ok(path.basename(resolved).startsWith('pdd-version-test-'), '只清理本测试创建的目录');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
function setVersion(directory, version) {
  const value = read(directory).replace(/^\/\/ @version\s+.+$/m, `// @version      ${version}`);
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), value);
  command(directory);
}

test('交付版本通过只读检查，文件无变化', directory => {
  const before = read(directory);
  command(directory, ['--check']);
  assert.equal(read(directory), before);
});
test('修复名称和运行时版本不同步，元数据从主脚本生成', directory => {
  const broken = read(directory).replace(/^\/\/ @name\s+.+$/m, '// @name         旧名称')
    .replace(/version: '[^']+',/, "version: '2000-01-01.1',");
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), broken);
  command(directory, ['--check'], false);
  assert.equal(read(directory), broken, '检查模式不能偷偷修复');
  command(directory);
  command(directory, ['--check']);
  assert.match(read(directory), new RegExp(`@name\\s+PDD评价筛选助手 v${baseVersion.replace(/\./g, '\\.')}`));
  assert.equal(headerOf(read(directory)),
    fs.readFileSync(path.join(directory, 'pdd-evaluation-filter.meta.js'), 'utf8'));
});
test('元数据陈旧时检查失败且不写入，生成后恢复一致', directory => {
  const metadataPath = path.join(directory, 'pdd-evaluation-filter.meta.js');
  const stale = fs.readFileSync(metadataPath, 'utf8').replace(baseVersion, '2000-01-01.1');
  fs.writeFileSync(metadataPath, stale);
  command(directory, ['--check'], false);
  assert.equal(fs.readFileSync(metadataPath, 'utf8'), stale);
  command(directory);
  command(directory, ['--check']);
});
test('同日序号按数字升版：9到10可发布，10到9拒绝', directory => {
  setVersion(directory, '2026-10-13.9');
  command(directory, ['--version', '2026-10-13.10']);
  command(directory, ['--check']);
  assert.ok(read(directory).includes('// @version      2026-10-13.10'));
  const before = read(directory);
  command(directory, ['--version', '2026-10-13.9'], false);
  assert.equal(read(directory), before);
});
test('跨日和跨年可以升版，重复版本及日期回退被拒绝', directory => {
  setVersion(directory, '2026-12-31.9');
  command(directory, ['--version', '2027-01-01.1']);
  const before = read(directory);
  command(directory, ['--version', '2027-01-01.1'], false);
  command(directory, ['--version', '2026-12-31.10'], false);
  assert.equal(read(directory), before);
});
test('非法日期、格式、前导零和超大序号全部拒绝，不修改文件', directory => {
  const before = read(directory);
  for (const version of ['2027-02-30.1', '2027-13-01.1', '2027-02-29.1',
    '2027-01-01', '2027-01-01.0', '2027-01-01.01', '2027-01-01.9007199254740992', '1.0.0']) {
    command(directory, ['--version', version], false);
    assert.equal(read(directory), before);
  }
});
test('历史无序号日期可升级，真实闰日可发布', directory => {
  setVersion(directory, '2024-02-28');
  command(directory, ['--version', '2024-02-29.1']);
  command(directory, ['--check']);
});
test('命名空间或更新地址被改动时拒绝生成和发布', directory => {
  const broken = read(directory).replace('urn:local:pdd:evaluation-helper', 'urn:changed');
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), broken);
  command(directory, [], false);
  assert.equal(read(directory), broken);
  fs.writeFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'),
    source.replace(/^(\/\/ @updateURL\s+).+$/m, '$1https://example.invalid/metadata.js'));
  command(directory, ['--check'], false);
});
test('错误参数及检查模式混用升版参数被拒绝', directory => {
  for (const args of [['--version'], ['--check', '--version', '2027-01-01.1'], ['--unknown']]) {
    command(directory, args, false);
  }
});
test('升版只更改名称、@version和Config.version，业务正文保持原样', directory => {
  const before = read(directory);
  command(directory, ['--version', '2099-01-01.1']);
  const clean = value => value.replace(/^\/\/ @name\s+.+$/m, '')
    .replace(/^\/\/ @version\s+.+$/m, '').replace(/version: '[^']+',/, '');
  assert.equal(clean(read(directory)), clean(before));
});

console.log(`METADATA RESULT ${passed}/10 passed`);
