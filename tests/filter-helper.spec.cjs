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
  test('面板保留一键运行、下方急停、检查状态、导出台账和文案入口', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.locator('#body button').count(), 6);
    assert.equal(await panel.locator('#run-once').innerText(), '一键运行');
    assert.equal(await panel.locator('#stop').innerText(), '急停');
    assert.equal(await panel.locator('#stop').isDisabled(), false);
    assert.equal(await page.evaluate(() => document.getElementById('pdd-evaluation-helper-panel')
      .shadowRoot.getElementById('run-once').nextElementSibling.id), 'stop');
    assert.equal(await panel.locator('#refresh').innerText(), '检查状态');
    assert.equal(await panel.locator('#export-batch').innerText(), '导出本机台账');
    assert.equal(await panel.locator('#reply-details summary').innerText(), '查看／编辑统一回复文案');
    assert.equal(await panel.locator('.badge, [data-select], #all').count(), 0);
    assert.equal(await panel.locator('#collapse').innerText(), '收起');
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
  test('收起和展开整个面板内容，保留紧凑状态与急停，不触发业务', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#collapse').click();
    assert.equal(await panel.locator('#body').isVisible(), false);
    assert.equal(await panel.locator('#collapse').getAttribute('aria-expanded'), 'false');
    assert.equal(await panel.locator('#compact-stop').isVisible(), true);
    assert.match(await panel.locator('#compact-count').innerText(), /待运行/);
    await panel.locator('#collapse').focus();
    await page.keyboard.press('Enter');
    assert.equal(await panel.locator('#body').isVisible(), true);
    assert.equal(await panel.locator('#collapse').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('最小化后恢复面板，参数与文案展开状态保留', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('5');
    await panel.locator('#reply-details summary').click();
    await panel.locator('#minimize').click();
    assert.equal(await panel.locator('#body').isVisible(), false);
    assert.equal(await panel.locator('#drag-handle').isVisible(), false);
    assert.equal(await panel.locator('#minibar').isVisible(), true);
    assert.equal(await panel.locator('#compact-stop').isVisible(), true);
    assert.ok((await panel.boundingBox()).width < 250);
    await page.keyboard.press('Enter');
    assert.equal(await panel.locator('#body').isVisible(), true);
    assert.equal(await panel.locator('#batch-n').inputValue(), '5');
    assert.equal(await panel.locator('#reply-copy').isVisible(), true);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('拖动标题栏移动面板，屏幕边缘限制位置，刷新保存布局', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    const before = await panel.boundingBox();
    const header = await panel.locator('#drag-handle strong').boundingBox();
    await page.mouse.move(header.x + 10, header.y + 10);
    await page.mouse.down();
    await page.mouse.move(header.x - 250, header.y - 200, { steps: 8 });
    await page.mouse.up();
    const moved = await panel.boundingBox();
    assert.ok(moved.x < before.x - 150);
    assert.ok(moved.y < before.y - 100);
    await panel.locator('#collapse').click();
    const saved = await panel.boundingBox();
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal(await panel.locator('#body').isVisible(), false);
    const restored = await panel.boundingBox();
    assert.ok(Math.abs(restored.x - saved.x) < 1 && Math.abs(restored.y - saved.y) < 1);
    const restoredHeader = await panel.locator('#drag-handle strong').boundingBox();
    await page.mouse.move(restoredHeader.x + 10, restoredHeader.y + 10);
    await page.mouse.down();
    await page.mouse.move(-300, -300, { steps: 8 });
    await page.mouse.up();
    const clamped = await panel.boundingBox();
    assert.ok(clamped.x >= 8 && clamped.y >= 8);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('最小化位置可拖动，缩小窗口后恢复面板仍在可视范围', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#minimize').click();
    const handle = await panel.locator('#minibar strong').boundingBox();
    await page.mouse.move(handle.x + 10, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(1090, 770, { steps: 8 });
    await page.mouse.up();
    await page.setViewportSize({ width: 360, height: 420 });
    await panel.locator('#restore').click();
    const rect = await panel.boundingBox();
    assert.ok(rect.x >= 0 && rect.y >= 0);
    assert.ok(rect.x + rect.width <= 360 && rect.y + rect.height <= 420);
    assert.equal(await panel.locator('#stop').isVisible(), true);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('急停按钮中断筛选等待，运行期间始终可点击', 'noop', async page => {
    await page.evaluate(() => {
      window.pendingResult = window.PDDEvaluationHelper.selectAll().catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.simulation.clicks['4星'] === 1);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.locator('#run-once').isDisabled(), true);
    assert.equal(await panel.locator('#stop').isDisabled(), false);
    await panel.locator('#stop').click();
    assert.equal((await page.evaluate(() => window.pendingResult)).code, 'CANCELLED');
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    assert.deepEqual(await counts(page), expectedCounts(1, 0, 0));
  });
  test('空闲时急停不产生查询或筛选动作', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#stop').click();
    assert.match(await panel.locator('#status').innerText(), /没有正在执行的任务/);
    assert.equal(await page.evaluate(() => window.PDDEvaluationHelper.cancel()), false);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
  });
  test('后台其他路径和SPA切换后面板仍可打开，缺少评价区域不是错误', 'normal', async page => {
    await page.evaluate(() => {
      document.getElementById('mf-mms-goods-container').remove();
      history.pushState({}, '', '/orders/list');
    });
    await page.waitForFunction(() => document.getElementById('pdd-evaluation-helper-panel')
      .shadowRoot.getElementById('inspection').textContent.includes('自动进入评价页'));
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    assert.equal(await panel.locator('#inspection').getAttribute('data-tone'), 'info');
    await page.evaluate(() => history.pushState({}, '', '/finance/overview'));
    await panel.locator('#refresh').click();
    assert.equal(await panel.isVisible(), true);
    assert.deepEqual(await counts(page), expectedCounts(0, 0, 0));
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
