'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'batch-fixture.html'), 'utf8');
const originalSource = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? originalSource : originalSource
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const replyText = '小店每天最开心的事莫过于看到亲的好评，亲的好评就像是清泉一样滋润我们的心田，小店会更加的珍惜亲的好评，不断的改进自己，完善自己，力求让小店的服务做得更好，店铺做得更大，也是为了让亲能够更好的买到自己的喜欢的宝贝。你的好评就是对我们最大的肯定和鼓励，希望亲再次关顾我们的店铺，检验小店的进步。';
const run = (page, options = {}) => page.evaluate(options =>
  window.PDDEvaluationHelper.startBatch(options).catch(error => ({ ok: false, code: error.code, message: error.message })), options);
const state = page => page.evaluate(() => ({ submissions: window.sim.submissions,
  opens: window.sim.opens, queries: window.sim.queries, page: window.sim.page,
  goods: document.querySelector('#goodsId input').value, goodsEvents: window.sim.goodsEvents,
  visited: window.sim.visited, batch: window.PDDEvaluationHelper.readBatch() }));

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const cases = [];
  const test = (name, mode, fn) => cases.push({ name, mode, fn });
  let failures = 0;

  test('安装加载不执行查询或回复', 'normal', async page => {
    const s = await state(page);
    assert.equal(s.queries, 0);
    assert.equal(s.submissions.length, 0);
  });
  test('N=3先跨页锁定3条，检查3条仅回复2条；收缩不补位', 'normal', async page => {
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 2, 1]);
    const s = await state(page);
    assert.deepEqual(s.submissions.map(rec => rec.order), ['990000-000000001', '990000-000000003']);
    assert.equal(s.batch.records.length, 3);
    assert.ok(s.submissions.every(rec => rec.value === replyText && rec.receivedInput === replyText));
    assert.equal(s.goods, '');
    assert.deepEqual(s.goodsEvents, ['']);
    assert.ok(s.visited.some(visit => visit.page === 2 && visit.beforeSubmission));
  });
  test('N留空遍历全部6条，严格模板仅回复3条', 'normal', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [6, 3, 3]);
    const s = await state(page);
    assert.equal(s.submissions.length, 3);
    assert.ok(!s.opens.includes('990000-000000004'), '带尾部空白不应打开回复');
    assert.ok(s.visited.some(visit => visit.page === 3 && visit.beforeSubmission));
  });
  test('N不是回复配额，N=2不会向后补找', 'normal', async page => {
    const result = await run(page, { n: 2 });
    assert.deepEqual([result.checked, result.replied, result.skipped], [2, 1, 1]);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.ok(s.visited.every(visit => visit.page === 1));
  });
  test('查询与翻页期间结果表暂时卸载时等待重绘', 'unmount', async page => {
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 2, 1]);
  });
  test('正文末尾换行也不放宽全文匹配', 'newline', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 0);
    assert.equal(result.batch.records[0].status, 'skipped_non_template');
    assert.equal((await state(page)).opens.length, 0);
  });
  test('锁定记录消失时标记缺失，不补入后面的模板记录', 'missing-locked', async page => {
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 1, 2]);
    assert.equal(result.batch.records[2].status, 'skipped_missing_locked_record');
    assert.deepEqual((await state(page)).submissions.map(rec => rec.order), ['990000-000000001']);
  });
  test('没有成功提示时对应记录的完整回复回显可确认', 'echo', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    assert.equal(result.batch.records[0].evidence, 'record_reply_echo');
  });
  test('指定商品ID通过input事件填写并限制结果', 'normal', async page => {
    const result = await run(page, { goodsId: '9001' });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.checked, 2);
    const s = await state(page);
    assert.equal(s.goods, '9001');
    assert.deepEqual(s.goodsEvents, ['9001']);
    assert.ok(s.batch.records.every(rec => rec.goodsId === '9001'));
  });
  test('空结果正常结束', 'empty', async page => {
    const result = await run(page, { n: 5 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [0, 0, 0]);
  });
  test('N超过总数时只锁定实际全部记录', 'normal', async page => {
    const result = await run(page, { n: 99 });
    assert.equal(result.checked, 6);
    assert.equal(result.replied, 3);
  });
  test('查询未完成不能使用旧结果', 'query-noop', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'TIMEOUT');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('冻结跨页身份重复，提交前停止', 'duplicate', async page => {
    assert.equal((await run(page)).code, 'DUPLICATE_RECORD');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('锁定期间前缀重排，复核失败不提交', 'reorder-freeze', async page => {
    assert.equal((await run(page, { n: 3 })).code, 'RESULTS_REORDERED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('身份时间不完整时停止', 'bad-time', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'INCOMPLETE_RECORD');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('店铺身份不可识别，零查询零提交', 'bad-shop', async page => {
    assert.equal((await run(page)).code, 'SHOP_UNVERIFIED');
    assert.equal((await state(page)).queries, 0);
  });
  test('显式店铺不匹配时停止', 'normal', async page => {
    assert.equal((await run(page, { expectedShop: '另一个店铺' })).code, 'SHOP_CHANGED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('提交前店铺切换，零提交', 'shop-change', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'SHOP_CHANGED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('未指定的残留订单条件阻止查询', 'residual', async page => {
    assert.equal((await run(page)).code, 'RESIDUAL_FILTER');
    assert.equal((await state(page)).queries, 0);
  });
  test('查询条件被改变时停止', 'filter-change', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'FILTER_CHANGED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('打开详情后正文改变，零提交', 'content-change', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'RECORD_CHANGED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('意外互动详情弹框不填不提交', 'wrong-modal', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'UNEXPECTED_MODAL');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('弹框已有内容不覆盖不提交', 'existing-text', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'EXISTING_REPLY_TEXT');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('受控文本框拒绝输入时不提交', 'text-rejected', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'TIMEOUT');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('商品ID组件拒绝输入时不查询', 'goods-rejected', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'TIMEOUT');
    assert.equal((await state(page)).queries, 0);
  });
  test('弹框关闭不算成功；未知提交锁住后续批次', 'unknown', async page => {
    const first = await run(page, { n: 3 });
    assert.equal(first.code, 'SUBMITTED_UNVERIFIED');
    let s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.records[0].status, 'submitted_unverified');
    assert.equal((await run(page, { n: 1 })).code, 'UNRESOLVED_HISTORY');
    s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.queries, 1);
  });
  test('旧成功提示不能确认本次未验证提交', 'stale-toast', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'SUBMITTED_UNVERIFIED');
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('未知提交刷新后继续阻塞，安装不自动重跑', 'unknown', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'SUBMITTED_UNVERIFIED');
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal((await state(page)).queries, 0);
    assert.equal((await run(page, { n: 1 })).code, 'UNRESOLVED_HISTORY');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('人工明确核验后解除阻塞并保留历史证据', 'unknown', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'SUBMITTED_UNVERIFIED');
    const entry = await page.evaluate(() => {
      const journal = window.PDDEvaluationHelper.readSubmissionJournal();
      const key = Object.keys(journal.entries)[0];
      return window.PDDEvaluationHelper.resolveSubmission(key, 'confirmed', '离线夹具人工核验：已回复');
    });
    assert.equal(entry.status, 'confirmed');
    assert.ok(entry.history.some(previous => previous.status === 'submitted_unverified'));
    const second = await run(page, { n: 1 });
    assert.equal(second.ok, true, second.message);
    assert.equal(second.replied, 0);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('已确认历史不会重复发送', 'normal', async page => {
    assert.equal((await run(page, { n: 1 })).replied, 1);
    await page.evaluate(() => {
      window.sim.records[0].replied = false;
      document.getElementById('query').click();
    });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const second = await run(page, { n: 1 });
    assert.equal(second.replied, 0);
    assert.equal(second.batch.records[0].status, 'skipped_previously_confirmed');
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('持久化失败时不发出提交', 'normal', async page => {
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.includes(':submissions:')) throw new Error('quota test');
        return original.call(this, key, value);
      };
    });
    assert.equal((await run(page, { n: 1 })).code, 'STORAGE_UNAVAILABLE');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('发出提交后取消记为未知，不能重试', 'cancel-after-submit', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 3 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.submissions.length === 1);
    await page.evaluate(() => window.PDDEvaluationHelper.cancel());
    assert.equal((await page.evaluate(() => window.pending)).code, 'SUBMITTED_UNVERIFIED');
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('批次执行锁阻止独立筛选并发', 'normal', async page => {
    const result = await page.evaluate(async () => {
      const pending = window.PDDEvaluationHelper.startBatch({ n: 1 });
      const manual = await window.PDDEvaluationHelper.selectAll().catch(error => error.code);
      return { batch: await pending, manual };
    });
    assert.equal(result.manual, 'BUSY');
    assert.equal(result.batch.ok, true);
  });
  test('跨标签页锁阻止同源并行批次', 'normal', async (page, context) => {
    const second = await context.newPage();
    await second.goto('https://mms.pinduoduo.com/goods/evaluation/index');
    await second.addScriptTag({ content: source });
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 3 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.queries === 1);
    assert.equal((await run(second, { n: 1 })).code, 'OTHER_TAB_BUSY');
    assert.equal((await page.evaluate(() => window.pending)).ok, true);
  });
  test('N与商品参数非法时不执行', 'normal', async page => {
    for (const n of [0, -1, 1.5, 'abc', '1e2']) assert.equal((await run(page, { n })).code, 'INVALID_N');
    assert.equal((await run(page, { goodsId: 'ID: 9001' })).code, 'INVALID_GOODS_ID');
    assert.equal((await state(page)).queries, 0);
  });
  test('面板启动功能可执行并导出状态', 'normal', async page => {
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('2');
    await panel.locator('#start-batch').click();
    await page.waitForFunction(() => window.PDDEvaluationHelper.readBatch()?.phase === 'completed');
    assert.equal((await state(page)).submissions.length, 1);
    if (process.env.PDD_BATCH_SCREENSHOT) await page.screenshot({ path: process.env.PDD_BATCH_SCREENSHOT, fullPage: true });
  });
  test('从首页自动跳转并一次性继续，刷新不重跑', 'normal', async (page, context) => {
    await page.goto('https://mms.pinduoduo.com/home/');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => { void window.PDDEvaluationHelper.startBatch({ n: 1 }); });
    await page.waitForURL('**/goods/evaluation/index?msfrom=mms_sidenav');
    await page.addScriptTag({ content: source });
    await page.waitForFunction(() => window.PDDEvaluationHelper.readBatch()?.phase === 'completed');
    assert.equal((await state(page)).submissions.length, 1);
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal((await state(page)).queries, 0);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('损坏或过期导航标记不启动全部回复', 'normal', async page => {
    await page.evaluate(() => {
      sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify({ params: {} }));
    });
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal((await state(page)).queries, 0);
    assert.equal((await state(page)).submissions.length, 0);
  });

  const selectedCases = process.env.PDD_TEST_CASE
    ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selectedCases.length, '测试筛选必须至少匹配一个用例');
  try {
    for (const item of selectedCases) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture })
        : route.abort());
      try {
        await page.goto(`https://mms.pinduoduo.com/goods/evaluation/index?mode=${item.mode}`);
        await page.addScriptTag({ content: source });
        await item.fn(page, context);
        assert.deepEqual(errors, [], '不应产生未处理页面异常');
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
  console.log(`BATCH RESULT ${selectedCases.length - failures}/${selectedCases.length} passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
