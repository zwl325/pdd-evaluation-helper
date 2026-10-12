'use strict';

// 仅向本地夹具注入交付脚本；拦截所有网络请求，不登录或访问真实商家后台。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const directory = path.resolve(__dirname, '..');
const originalSource = fs.readFileSync(path.join(directory, 'pdd-evaluation-filter.user.js'), 'utf8');
// 保留300ms稳定窗口，只缩短失败用例的超时。
const source = originalSource.replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1200,');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');

async function main() {
  const launchOptions = { headless: true };
  if (process.env.PDD_TEST_BROWSER) launchOptions.executablePath = process.env.PDD_TEST_BROWSER;
  const browser = await chromium.launch(launchOptions);
  const cases = [];
  let failures = 0;

  const test = (name, mode, action) => cases.push({ name, mode, action });
  const counts = (page) => page.evaluate(() => ({
    ...window.simulation.clicks, outside: window.simulation.outsideClicks,
  }));
  const selectAll = (page) => page.evaluate(() =>
    window.PDDEvaluationHelper.selectAll().catch(error => ({ ok: false, code: error.code, message: error.message })));
  const expectedCounts = (four, five, unreplied) =>
    ({ '4星': four, '5星': five, '未回复': unreplied, outside: 0 });

  test('加载脚本时不自动点击；初始状态可读取', 'normal', async page => {
    const state = await page.evaluate(() => window.PDDEvaluationHelper.readState());
    assert.equal(state.ready, true);
    assert.deepEqual(state.targets.map(target => target.selected), [false, false, false]);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('一键入口选择三项；重复执行不会切换取消', 'normal', async page => {
    assert.equal((await selectAll(page)).ok, true);
    const second = await selectAll(page);
    assert.equal(second.ok, true);
    assert.ok(second.results.every(result => result.action === 'already-selected'));
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('全部已经选中时零点击', 'selected', async page => {
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('部分选中只点击剩余项目', 'partial', async page => {
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(0, 1, 1));
  });
  test('独立选择仅操作指定目标', 'normal', async page => {
    const result = await page.evaluate(() => window.PDDEvaluationHelper.select('5星'));
    assert.equal(result.ok, true);
    assert.deepEqual(await counts(page), expectedCounts(0, 1, 0));
  });
  test('按钮延迟挂载后可执行', 'delayed', async page => {
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('每次点击重建整个评价容器仍重新定位', 'rerender', async page => {
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('隐藏副本与容器外同名目标不参与定位', 'hidden', async page => {
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('可见目标重复时停止且零点击', 'duplicate', async page => {
    assert.equal((await selectAll(page)).code, 'AMBIGUOUS_TARGET');
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('可见评价容器重复时停止且零点击', 'duplicate-root', async page => {
    assert.equal((await selectAll(page)).code, 'AMBIGUOUS_ROOT');
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('禁用目标不点击', 'disabled', async page => {
    assert.equal((await selectAll(page)).code, 'DISABLED_TARGET');
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('一项禁用不阻止其他独立筛选接口', 'disabled', async page => {
    assert.equal((await page.evaluate(() => window.PDDEvaluationHelper.select('5星'))).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(0, 1, 0));
  });
  test('页面忽略click时超时且不重试或继续后续项目', 'noop', async page => {
    assert.equal((await selectAll(page)).code, 'TIMEOUT');
    assert.deepEqual(await counts(page), expectedCounts(1, 0, 0));
  });
  test('4星与5星互斥时联合核验失败', 'exclusive', async page => {
    const result = await selectAll(page);
    assert.equal(result.code, 'TIMEOUT');
    assert.match(result.message, /联合核验/);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('其他星级仍选中时明确报告冲突', 'conflict', async page => {
    const result = await selectAll(page);
    assert.equal(result.code, 'CONFLICTING_FILTERS');
    assert.match(result.message, /1星/);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('执行锁阻止并发重复点击', 'normal', async page => {
    const result = await page.evaluate(async () => {
      const first = window.PDDEvaluationHelper.selectAll();
      const second = await window.PDDEvaluationHelper.selectAll().catch(error => error.code);
      return { first: await first, second };
    });
    assert.equal(result.second, 'BUSY');
    assert.equal(result.first.ok, true);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('停止中断等待及未来点击', 'noop', async page => {
    await page.evaluate(() => {
      window.pendingResult = window.PDDEvaluationHelper.selectAll().catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.simulation.clicks['4星'] === 1);
    assert.equal(await page.evaluate(() => window.PDDEvaluationHelper.cancel()), true);
    assert.equal((await page.evaluate(() => window.pendingResult)).code, 'CANCELLED');
    assert.deepEqual(await counts(page), expectedCounts(1, 0, 0));
  });
  test('执行中页面URL变化后停止', 'noop', async page => {
    await page.evaluate(() => {
      window.pendingResult = window.PDDEvaluationHelper.selectAll().catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.simulation.clicks['4星'] === 1);
    await page.evaluate(() => history.pushState({}, '', '/home/?changed=1'));
    assert.ok(['PAGE_CHANGED', 'CANCELLED'].includes((await page.evaluate(() => window.pendingResult)).code));
    assert.deepEqual(await counts(page), expectedCounts(1, 0, 0));
  });
  test('重复注入保持唯一面板及执行实例', 'normal', async page => {
    await page.addScriptTag({ content: source });
    assert.equal(await page.locator('#pdd-evaluation-helper-panel').count(), 1);
    assert.equal((await selectAll(page)).ok, true);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
  });
  test('面板保留一键运行和只读检查状态，无星级徽标或独立按钮', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.locator('button').count(), 2);
    assert.equal(await panel.locator('#run-once').innerText(), '一键运行');
    assert.equal(await panel.locator('#refresh').innerText(), '检查状态');
    assert.equal(await panel.locator('.badge, [data-select], #all, #stop, #collapse, #export-batch').count(), 0);
    const before = await panel.locator('#status').innerText();
    await panel.locator('#refresh').click();
    assert.match(await panel.locator('#inspection').innerText(), /找到3\/3项，已选0\/3项/);
    assert.match(await panel.locator('#inspection').innerText(), /手动检查/);
    assert.equal(await panel.locator('#status').innerText(), before);
    await selectAll(page);
    await panel.locator('#refresh').click();
    assert.match(await panel.locator('#inspection').innerText(), /已选3\/3项/);
    assert.deepEqual(await counts(page), expectedCounts(1, 1, 1));
    if (process.env.PDD_TEST_SCREENSHOT) {
      await page.screenshot({ path: process.env.PDD_TEST_SCREENSHOT, fullPage: true });
    }
  });
  test('未知目标被拒绝', 'normal', async page => {
    const code = await page.evaluate(() =>
      window.PDDEvaluationHelper.select('查询').catch(error => error.code));
    assert.equal(code, 'INVALID_TARGET');
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });

  try {
    for (const item of cases) {
      const context = await browser.newContext({ viewport: { width: 1100, height: 780 } });
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await context.route('**/*', route => {
        if (route.request().isNavigationRequest()) {
          return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
        }
        return route.abort();
      });
      try {
        await page.goto(`https://mms.pinduoduo.com/goods/evaluation/index?mode=${item.mode}`);
        await page.addScriptTag({ content: source });
        await item.action(page);
        assert.deepEqual(pageErrors, [], '不应出现未处理的页面异常');
        console.log(`PASS ${item.name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${item.name}\n${error.stack}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`RESULT ${cases.length - failures}/${cases.length} passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
