'use strict';

// 从截图确认的文案构造合成状态；不使用用户真实订单或访问真实后台。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const fixture = fs.readFileSync(path.join(__dirname, 'report-fixture.html'), 'utf8');
const originalSource = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? originalSource : originalSource
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const template = '该用户未填写文字评价';
const run = (page, options = { n: 1 }) => page.evaluate(options =>
  window.PDDEvaluationHelper.startReportBatch(options).catch(error => ({
    code: error.code, message: error.message,
  })), options);
const state = page => page.evaluate(() => ({
  ...window.sim, journal: window.PDDEvaluationHelper.readReportJournal(),
  quota: window.PDDEvaluationHelper.readReportQuota(), batch: window.PDDEvaluationHelper.readReportBatch(),
}));
async function seedUnknown(page, changes = {}) {
  await page.evaluate(changes => {
    const rec = window.sim.records[0];
    rec.acceptedText = '已举报，待审核'; rec.reported = true;
    const reportText = document.querySelector('#pdd-evaluation-helper-panel').shadowRoot
      .querySelector('#report-copy').textContent;
    const entry = { id: 'synthetic-unknown', key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
      shop: '', order: rec.order, goodsId: rec.goodsId, time: rec.time, star: rec.star,
      day: window.PDDEvaluationHelper.readReportQuota().day, status: 'submitted_unverified',
      reportText, reason: '同行恶意差评', evidence: 'TIMEOUT', at: new Date().toISOString(),
      history: [{ status: 'submitting', at: new Date().toISOString() }], ...changes };
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [entry] }));
    window.renderFixture();
  }, changes);
}

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  test('记录头部已举报待审核，无成功提示仍确认且目标2只提交2次', async page => {
    assert.equal((await run(page, { n: 2 })).reported, 2);
    const s = await state(page);
    assert.equal(s.submissions.length, 2);
    assert.deepEqual(s.journal.attempts.map(entry => entry.evidence),
      ['record_report_accepted', 'record_report_accepted']);
    assert.deepEqual([s.quota.confirmed, s.quota.uncertain, s.quota.remaining], [2, 0, 28]);
    assert.equal(s.batch.records[0].submissionDiagnostics.status.text, '已举报，待审核');
  });
  test('受理状态延迟加载仍等待稳定后只提交一次', async page => {
    await page.evaluate(() => { window.sim.acceptanceScenario = 'delayed'; });
    assert.equal((await run(page)).reported, 1);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('实际文案中英文逗号兼容但仍完整匹配', async page => {
    await page.evaluate(() => { window.sim.acceptanceText = '已举报, 待审核'; });
    assert.equal((await run(page)).reported, 1);
    assert.equal((await state(page)).journal.attempts[0].evidence, 'record_report_accepted');
  });
  for (const scenario of ['other-row', 'body', 'hidden', 'link-still', 'wrong-identity',
    'wrong-star', 'keep-modal', 'flash', 'failed']) {
    test(`${scenario}不构成同一记录的稳定受理证据，保留未知且不重试`, async page => {
      await page.evaluate(scenario => { window.sim.acceptanceScenario = scenario; }, scenario);
      assert.equal((await run(page)).code, 'REPORT_SUBMITTED_UNVERIFIED');
      const s = await state(page);
      assert.deepEqual([s.quota.confirmed, s.quota.uncertain, s.quota.remaining], [0, 1, 29]);
      assert.equal(s.submissions.length, 1);
      assert.equal(s.batch.error.details.stage, 'after_submit');
      assert.equal(s.batch.error.details.waitError.code, 'TIMEOUT');
      assert.deepEqual(s.journal.attempts[0].submissionDiagnostics, s.batch.error.details);
      if (scenario === 'failed') assert.ok(s.batch.error.details.notices.includes('举报未受理，请稍后核实'));
      if (scenario === 'keep-modal') assert.equal(s.batch.error.details.modalCount, 1);
      const [download] = await Promise.all([page.waitForEvent('download'),
        page.evaluate(() => window.PDDEvaluationHelper.exportReportLedger())]);
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.deepEqual(exported.batch.error.details, s.batch.error.details);
    });
  }
  test('原已举报待审核记录跳过且不计新成功，继续下一条', async page => {
    await page.evaluate(() => {
      window.sim.records[0].acceptedText = '已举报，待审核';
      window.sim.records[0].reported = true;
      window.renderFixture();
    });
    assert.equal((await run(page)).reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.summary.skipped, 1);
    assert.notEqual(s.submissions[0].order, s.records[0].order);
  });
  test('核验恢复1条计入目标2，仅新增1次提交且保留旧TIMEOUT历史', async page => {
    await seedUnknown(page);
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 2, result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.reconciled.length, 1);
    assert.equal(s.batch.records[0].recovered, true);
    assert.equal(s.journal.attempts[0].history.at(-1).evidence, 'TIMEOUT');
    assert.equal(s.journal.attempts[0].verification.source, 'current_record_status');
    assert.equal(s.quota.confirmed, 2);
    assert.equal(s.quota.uncertain, 0);
  });
  test('核验恢复已经达到目标1时零查询零新增提交', async page => {
    await seedUnknown(page);
    const result = await run(page);
    assert.equal(result.reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.queries.length, 0);
    assert.equal(s.batch.stopReason, 'target_reached');
  });
  test('日额度已占30条时仍可核验，零新增提交且不增加占额', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      const data = window.PDDEvaluationHelper.readReportJournal();
      for (let i = 0; i < 29; i++) {
        const rec = { order: `880999-${i}`, goodsId: '8999', time: '2026-10-01 00:00:00' };
        data.attempts.push({ ...rec, id: `confirmed-${i}`, key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
          day: data.attempts[0].day, status: 'confirmed', history: [] });
      }
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(data));
    });
    assert.equal((await run(page, { n: 2 })).reported, 1);
    const s = await state(page);
    assert.equal(s.quota.confirmed, 30);
    assert.equal(s.quota.uncertain, 0);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.queries.length, 0);
  });
  test('历史日期的核验成功不计入今日目标，当前目标继续处理', async page => {
    await seedUnknown(page, { day: '2026-10-01' });
    assert.equal((await run(page)).reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.quota.confirmed, 1);
    assert.equal(s.batch.reconciled[0].day, '2026-10-01');
    assert.equal(s.batch.records[0].recovered, undefined);
  });
  test('指定其他商品时核验旧未知但不计入商品目标', async page => {
    await seedUnknown(page);
    const otherGoods = await page.evaluate(() => window.sim.records[1].goodsId);
    assert.equal((await run(page, { n: 1, goodsId: otherGoods })).reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.quota.confirmed, 2);
    assert.equal(s.batch.records[0].goodsId, otherGoods);
  });
  test('部分未知恢复、另一条仍未知时保留已确认计数并阻止新提交', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      const data = window.PDDEvaluationHelper.readReportJournal();
      const rec = { order: '880998-000001', goodsId: '8998', time: '2026-10-01 00:00:00' };
      data.attempts.push({ ...data.attempts[0], ...rec, id: 'not-visible-unknown',
        key: JSON.stringify([rec.order, rec.goodsId, rec.time]) });
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(data));
    });
    assert.equal((await run(page, { n: 2 })).code, 'UNRESOLVED_REPORT_HISTORY');
    const s = await state(page);
    assert.deepEqual([s.quota.confirmed, s.quota.uncertain], [1, 1]);
    assert.equal(s.batch.summary.reported, 1);
    assert.equal(s.queries.length, 0);
    assert.equal(s.submissions.length, 0);
  });
  test('重复身份的记录即使有受理文字也不能恢复', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      window.sim.records[1] = { ...window.sim.records[0] };
      window.renderFixture();
    });
    assert.equal((await run(page)).code, 'UNRESOLVED_REPORT_HISTORY');
    const s = await state(page);
    assert.equal(s.quota.uncertain, 1);
    assert.equal(s.journal.attempts[0].submissionDiagnostics.rowError.code, 'DUPLICATE_RECORD');
  });
  test('恢复台账持久化失败时仍不查询不提交', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'pdd-evaluation-helper:reports:v1') throw new Error('synthetic storage failure');
        return original.call(this, key, value);
      };
    });
    assert.equal((await run(page)).code, 'STORAGE_UNAVAILABLE');
    const s = await state(page);
    assert.equal(s.quota.uncertain, 1);
    assert.equal(s.queries.length, 0);
    assert.equal(s.submissions.length, 0);
  });
  for (const invalid of ['not-visible', 'different-time', 'different-body', 'different-star',
    'different-report-text', 'different-reason', 'still-link', 'outside-status']) {
    test(`旧未知${invalid}不能自动核验，零查询零提交`, async page => {
      await seedUnknown(page, invalid === 'different-report-text' ? { reportText: '其他文案' }
        : invalid === 'different-reason' ? { reason: '其他原因' } : {});
      await page.evaluate(invalid => {
        const rec = window.sim.records[0];
        if (invalid === 'not-visible') window.sim.records.shift();
        if (invalid === 'different-time') rec.time = '2026-10-14 23:59:59';
        if (invalid === 'different-body') rec.content = '其他评价';
        if (invalid === 'different-star') rec.star = 2;
        if (invalid === 'still-link') rec.reported = false;
        if (invalid === 'outside-status') {
          rec.acceptedText = '';
          document.querySelector('#toast').textContent = '已举报，待审核';
        }
        window.renderFixture();
      }, invalid);
      assert.equal((await run(page)).code, 'UNRESOLVED_REPORT_HISTORY');
      const s = await state(page);
      assert.equal(s.submissions.length, 0);
      assert.equal(s.queries.length, 0);
      assert.equal(s.quota.uncertain, 1);
    });
  }
  test('安装与检查状态保持只读，不自动修改待核验台账', async page => {
    await seedUnknown(page);
    const before = await page.evaluate(() => localStorage.getItem('pdd-evaluation-helper:reports:v1'));
    await page.addScriptTag({ content: source });
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#mode-report').click();
    await panel.locator('#report-refresh').click();
    assert.equal(await page.evaluate(() => localStorage.getItem('pdd-evaluation-helper:reports:v1')), before);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('其他标签页持锁时不能核验或提交', async (page, context) => {
    await seedUnknown(page);
    const second = await context.newPage();
    await second.goto('https://mms.pinduoduo.com/goods/evaluation/index');
    await second.evaluate(() => {
      navigator.locks.request('pdd-evaluation-helper:batch:v1', () =>
        new Promise(resolve => { window.releaseTestLock = resolve; }));
    });
    await second.waitForFunction(() => Boolean(window.releaseTestLock));
    assert.equal((await run(page)).code, 'OTHER_TAB_BUSY');
    assert.equal((await state(page)).quota.uncertain, 1);
    await second.evaluate(() => window.releaseTestLock());
  });
  test('核验等待期间急停不修改台账也不新增提交', async page => {
    await seedUnknown(page);
    const code = await page.evaluate(async () => {
      const pending = window.PDDEvaluationHelper.startReportBatch({ n: 2 }).catch(error => error.code);
      window.PDDEvaluationHelper.cancel();
      return pending;
    });
    assert.equal(code, 'CANCELLED');
    assert.equal((await state(page)).quota.uncertain, 1);
    assert.equal((await state(page)).submissions.length, 0);
  });

  const selected = process.env.PDD_TEST_CASE ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length);
  let failures = 0;
  try {
    for (const item of selected) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
        await page.evaluate(() => {
          window.sim.keepReported = true;
          window.sim.acceptanceScenario = 'header';
          window.sim.records[0].content = '该用户未填写文字评价';
          window.sim.records = window.sim.records.slice(0, 2);
          window.renderFixture();
        });
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
  console.log(`ACCEPTANCE RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
