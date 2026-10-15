'use strict';

// 独立审核复现：全部为合成记录，拦截所有网络，不访问真实商家后台。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const original = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? original : original
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const cases = [];
const test = (name, mode, fn, url) => cases.push({ name, mode, fn, url });
const deferredDataMs = process.env.PDD_PRODUCTION_TIMERS ? 3500 : 900;
const resultTimeoutMs = process.env.PDD_PRODUCTION_TIMERS ? 15000 : 1600;
const run = (page, method, params) => page.evaluate(({ method, params }) =>
  window.PDDEvaluationHelper[method](params)
    .catch(error => ({ code: error.code, message: error.message })), { method, params });
const reportState = page => page.evaluate(() => ({
  submissions: window.sim.submissions.length,
  queries: window.sim.queries.length,
  batch: window.PDDEvaluationHelper.readReportBatch(),
}));

test('普通举报跳过正文含“加载中”的非模板评价后继续处理', 'report', async page => {
  await page.evaluate(() => {
    window.sim.records[0].content = '图片一直显示正在加载，体验很差';
    window.renderFixture();
  });
  assert.equal(await page.locator('[aria-busy="true"]').count(), 0);
  const result = await run(page, 'startReportBatch', { n: 1 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.checked, result.reported, result.skipped], [2, 1, 1]);
  assert.equal((await reportState(page)).submissions, 1);
});

test('无条件举报1星允许评价正文包含“正在加载”', 'report', async page => {
  await page.evaluate(() => {
    window.sim.records[0].content = '商品一直显示正在加载，体验很差';
    window.renderFixture();
  });
  const result = await run(page, 'startOneStarReportBatch', { n: 1 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.checked, result.reported, result.skipped], [1, 1, 0]);
  assert.equal((await reportState(page)).submissions, 1);
});

test('回复模式不把客户正文的“加载中”当作列表加载状态', 'reply', async page => {
  await page.evaluate(() => {
    window.sim.records[0].content = '页面加载中，评价正文仍可正常读取';
    window.sim.records[1].content = '该用户觉得商品很好';
    window.renderFixture();
  });
  const result = await run(page, 'startBatch', { n: 2 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.checked, result.replied, result.skipped], [2, 1, 1]);
  assert.equal(await page.evaluate(() => window.sim.submissions.length), 1);
});

test('真实aria-busy持续存在时保持等待且不提交', 'report', async page => {
  await page.evaluate(() => {
    const originalRender = window.renderFixture;
    window.renderFixture = () => {
      originalRender();
      document.querySelector('[data-testid="beast-core-table"]').setAttribute('aria-busy', 'true');
    };
    window.renderFixture();
  });
  const result = await run(page, 'startOneStarReportBatch', { n: 1 });
  assert.equal(result.code, 'TIMEOUT', result.message);
  const state = await reportState(page);
  assert.deepEqual([state.batch.summary.checked, state.submissions], [0, 0]);
});

test('无记录且仅有真实“正在加载”占位时不误报处理完成', 'report', async page => {
  await page.evaluate(() => {
    const originalRender = window.renderFixture;
    window.renderFixture = () => {
      originalRender();
      document.querySelector('[data-testid="beast-core-table"]').innerHTML =
        '<div class="synthetic-loading-placeholder">正在加载</div>';
    };
    window.renderFixture();
  });
  const result = await run(page, 'startOneStarReportBatch', { n: 1 });
  assert.equal(result.code, 'TIMEOUT', result.message);
  const state = await reportState(page);
  assert.deepEqual([state.batch.summary.checked, state.submissions], [0, 0]);
  assert.equal(state.batch.phase, 'stopped');
});

for (const mode of ['report', 'reply']) {
  test(`${mode}分页标记短暂不可读时等待恢复后完成`, mode, async page => {
    await page.evaluate(() => {
      const original = window.renderFixture;
      window.renderFixture = () => {
        original();
        const marker = document.querySelector('.PGT_pagerItemActive');
        const value = marker.textContent;
        marker.textContent = '正在绘制页码';
        setTimeout(() => { marker.textContent = value; }, 450);
      };
      window.renderFixture();
    });
    const result = await run(page, mode === 'report' ? 'startReportBatch' : 'startBatch', { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result[mode === 'report' ? 'reported' : 'replied'], 1);
  });
  for (const region of ['form', 'root']) {
    test(`${mode}查询期间${region}暂时卸载后恢复仍完成，查询不重发`, mode, async page => {
      await page.evaluate(region => {
        window.sim.delay = 650;
        document.querySelector('#query').addEventListener('click', () => {
          const node = document.querySelector(region === 'form' ? '#evaluationSearchId' : '#mf-mms-goods-container');
          const marker = document.createComment('synthetic-remount');
          node.replaceWith(marker);
          setTimeout(() => marker.replaceWith(node), 300);
        });
      }, region);
      const result = await run(page, mode === 'report' ? 'startReportBatch' : 'startBatch', { n: 1 });
      assert.equal(result.ok, true, result.message);
      assert.equal(result[mode === 'report' ? 'reported' : 'replied'], 1);
      assert.equal(await page.evaluate(() => Array.isArray(window.sim.queries)
        ? window.sim.queries.length : window.sim.queries), 1);
      assert.equal(await page.evaluate(() => window.sim.submissions.length), 1);
    });
  }
}
test('表单恢复时筛选实际改变仍拒绝使用错误结果', 'report', async page => {
  await page.evaluate(() => {
    window.sim.delay = 650;
    document.querySelector('#query').addEventListener('click', () => {
      const node = document.querySelector('#evaluationSearchId');
      const marker = document.createComment('synthetic-remount');
      node.replaceWith(marker);
      setTimeout(() => {
        node.querySelector('#order-input').value = 'synthetic-user-change';
        marker.replaceWith(node);
      }, 300);
    });
  });
  assert.equal((await run(page, 'startReportBatch', { n: 1 })).code, 'FILTER_CHANGED');
  assert.equal((await reportState(page)).submissions, 0);
});

test('查询先变class后返回新星级数据时不提前读取旧结果', 'report', async page => {
  await page.evaluate(delay => {
    const s = window.sim;
    s.filterStar = 2;
    window.renderFixture();
    const original = document.querySelector('#query');
    const button = original.cloneNode(true);
    original.replaceWith(button);
    button.addEventListener('click', () => {
      const selected = [...document.querySelectorAll('.evaluation_search_btn_checked')]
        .map(element => element.innerText);
      const star = Number(selected.find(label => /^[1-5]星$/.test(label))?.[0]);
      s.queries.push({ star, selected, submitted: s.submissions.length });
      document.querySelector('[data-testid="beast-core-table"]').classList.add('query-started');
      s.auditQueryStartedAt = Date.now();
      setTimeout(() => {
        s.page = 1;
        s.filterStar = star;
        s.filterGoods = document.querySelector('#goodsId input').value;
        window.renderFixture();
        s.auditQueryDataAt = Date.now();
      }, delay);
    });
    const originalPush = s.opens.push.bind(s.opens);
    s.opens.push = (...items) => {
      s.auditFirstOpenAt ??= Date.now();
      return originalPush(...items);
    };
  }, deferredDataMs);
  const result = await run(page, 'startReportBatch', { n: 1 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.checked, result.reported], [2, 1]);
  const evidence = await page.evaluate(() => ({
    queryStars: window.sim.queries.map(query => query.star),
    dataAt: window.sim.auditQueryDataAt,
    firstOpenAt: window.sim.auditFirstOpenAt,
    submissions: window.sim.submissions.length,
  }));
  assert.deepEqual(evidence.queryStars, [1]);
  assert.ok(evidence.dataAt > 0);
  assert.ok(evidence.firstOpenAt >= evidence.dataAt, '新数据到达之前不能打开旧结果');
  assert.equal(evidence.submissions, 1);
});

test('分页先更新页码后返回数据时等待第二页并处理第三条', 'report', async page => {
  await page.evaluate(delay => {
    const s = window.sim;
    s.keepReported = true;
    window.renderFixture();
    document.querySelector('#results').addEventListener('click', event => {
      if (event.target.getAttribute('data-testid') !== 'beast-core-pagination-next') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      s.page++;
      const pagination = document.querySelector('[data-testid="beast-core-pagination"]');
      pagination.querySelector('.PGT_pagerItemActive').classList.remove('PGT_pagerItemActive');
      [...pagination.querySelectorAll('li')].find(element => element.innerText === String(s.page))
        .classList.add('PGT_pagerItemActive');
      pagination.querySelector('[data-testid="beast-core-pagination-prev"]').classList.remove('PGT_disabled');
      pagination.querySelector('[data-testid="beast-core-pagination-next"]').classList.add('PGT_disabled');
      s.auditPageChangedAt = Date.now();
      setTimeout(() => {
        window.renderFixture();
        s.auditPageDataAt = Date.now();
      }, delay);
    }, true);
    const originalPush = s.opens.push.bind(s.opens);
    s.opens.push = (...items) => {
      if (items.includes('880000-000000003')) s.auditThirdOpenAt = Date.now();
      return originalPush(...items);
    };
  }, deferredDataMs);
  const result = await run(page, 'startOneStarReportBatch', { n: 3 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.checked, result.reported], [3, 3]);
  assert.equal(result.batch.stopReason, 'target_reached');
  const evidence = await page.evaluate(() => ({
    orders: window.sim.submissions.map(submission => submission.order),
    dataAt: window.sim.auditPageDataAt,
    thirdOpenAt: window.sim.auditThirdOpenAt,
    remaining: window.sim.records.filter(record => record.star === 1 && !record.reported).length,
  }));
  assert.deepEqual(evidence.orders, ['880000-000000001', '880000-000000002', '880000-000000003']);
  assert.ok(evidence.dataAt > 0);
  assert.ok(evidence.thirdOpenAt >= evidence.dataAt);
  assert.equal(evidence.remaining, 0);
});

test('取消浏览器离页确认后导航有界回收且可重新启动', 'report', async page => {
  // 一次真实鼠标动作授予浏览器显示beforeunload确认框所需的用户激活。
  await page.locator('#goodsId input').click();
  await page.evaluate(() => {
    window.auditBeforeUnload = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', window.auditBeforeUnload);
  });
  const dialogPromise = page.waitForEvent('dialog');
  const starting = run(page, 'startOneStarReportBatch', { n: 1 });
  const dialog = await dialogPromise;
  assert.equal(dialog.type(), 'beforeunload');
  await dialog.dismiss();
  assert.equal((await starting).navigating, true);
  assert.equal(new URL(page.url()).pathname, '/home/');
  assert.equal(await page.evaluate(() => window.PDDEvaluationHelper.cancel()), true);
  assert.equal(await page.evaluate(() =>
    sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
  await page.waitForFunction(() =>
    !document.querySelector('#pdd-evaluation-helper-panel').shadowRoot
      .querySelector('#report-one-star').disabled, null, { timeout: resultTimeoutMs + 4000 });
  assert.equal(await page.evaluate(() =>
    sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
  await page.evaluate(() =>
    window.removeEventListener('beforeunload', window.auditBeforeUnload));
  const navigation = page.waitForURL(url => url.pathname === '/goods/evaluation/index');
  const restarted = await run(page, 'startOneStarReportBatch', { n: 1 });
  assert.equal(restarted.navigating, true, restarted.message);
  await navigation;
}, 'https://mms.pinduoduo.com/home/');

async function main() {
  const selected = process.env.PDD_TEST_CASE
    ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length, 'PDD_TEST_CASE没有匹配用例');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  let failures = 0;
  try {
    for (const item of selected) {
      const filename = `${item.mode === 'report' ? 'report' : 'batch'}-fixture.html`;
      let fixture = fs.readFileSync(path.join(__dirname, filename), 'utf8');
      if (item.mode === 'reply') fixture = fixture
        .replace('}, 30);', '}, window.sim.delay || 30);')
        .replace('</script>', 'window.renderFixture = render;</script>');
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture })
        : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(item.url || 'https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
        await page.addScriptTag({ content: source });
        await item.fn(page, context);
        assert.deepEqual(errors, []);
        console.log(`PASS ${item.name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${item.name}\n${error.stack}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`AUDIT LOADING RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
