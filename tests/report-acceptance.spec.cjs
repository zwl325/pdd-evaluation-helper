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
  stats: window.PDDEvaluationHelper.readReportStats(), batch: window.PDDEvaluationHelper.readReportBatch(),
}));
async function seedUnknown(page, changes = {}) {
  await page.evaluate(changes => {
    const rec = window.sim.records[0];
    rec.acceptedText = '已举报，待审核'; rec.reported = true;
    const reportText = document.querySelector('#pdd-evaluation-helper-panel').shadowRoot
      .querySelector('#report-copy').value;
    const entry = { id: 'synthetic-unknown', key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
      shop: '', order: rec.order, goodsId: rec.goodsId, time: rec.time, star: rec.star,
      day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }), status: 'submitted_unverified',
      reportText, reason: '同行恶意差评', evidence: 'TIMEOUT', at: new Date().toISOString(),
      history: [{ status: 'submitting', at: new Date().toISOString() }], ...changes };
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [entry] }));
    window.sim.filterStar = 4; // 模拟后台默认结果，不预先展示待核验的低星记录。
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
    assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [2, 0]);
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
      await page.evaluate(scenario => {
        window.sim.acceptanceScenario = scenario;
        // 保留另一行供other-row伪证据使用，但不把它作为第二个可举报候选。
        window.sim.records[1].content = '其他评价';
        window.renderFixture();
      }, scenario);
      const result = await run(page);
      if (scenario === 'keep-modal') assert.equal(result.code, 'REPORT_SUBMITTED_UNVERIFIED');
      else {
        assert.equal(result.ok, true, result.message);
        assert.deepEqual([result.reported, result.pending], [0, 1]);
        assert.equal(result.batch.phase, 'completed');
        assert.equal(result.batch.error, undefined);
      }
      const s = await state(page);
      assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [0, 1]);
      assert.equal(s.submissions.length, 1);
      const diagnostics = s.journal.attempts[0].submissionDiagnostics;
      assert.equal(diagnostics.stage, 'after_submit');
      assert.equal(diagnostics.waitError.code, 'TIMEOUT');
      assert.deepEqual(s.batch.records[0].submissionDiagnostics, diagnostics);
      if (scenario === 'failed') assert.ok(diagnostics.notices.includes('举报未受理，请稍后核实'));
      if (scenario === 'keep-modal') {
        assert.equal(s.batch.error.details.modalCount, 1);
        assert.deepEqual(s.batch.error.details, diagnostics);
      }
      const [download] = await Promise.all([page.waitForEvent('download'),
        page.evaluate(() => window.PDDEvaluationHelper.exportReportLedger())]);
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.deepEqual(exported.journal.attempts[0].submissionDiagnostics, diagnostics);
      assert.deepEqual(exported.batch.records[0].submissionDiagnostics, diagnostics);
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
  test('历史恢复不计本次目标，新增1条后结果不足正常结束并保留旧TIMEOUT历史', async page => {
    await seedUnknown(page);
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.reconciled.length, 1);
    assert.equal(s.batch.records[0].status, 'skipped_previously_reported');
    assert.equal(s.journal.attempts[0].history.at(-1).evidence, 'TIMEOUT');
    assert.equal(s.journal.attempts[0].verification.source, 'current_record_status');
    assert.equal(s.stats.confirmed, 2);
    assert.equal(s.stats.uncertain, 0);
  });
  test('带追评时间旧记录恢复只修正历史，目标2实际新增1条', async page => {
    await page.evaluate(() => {
      const originalRender = window.renderFixture;
      window.renderFixture = () => {
        originalRender();
        for (const wrapper of document.querySelectorAll('[class*="logic_reviewWrapper"]')) {
          const appendix = document.createElement('div');
          appendix.className = 'logic_appendWrapper__14p_G';
          appendix.innerHTML = '<div>补充使用感受</div><div class="logic_replyTime__32PeR">2026-10-15 01:02:03</div>';
          wrapper.append(appendix);
        }
      };
    });
    await seedUnknown(page);
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.batch.reconciled.length, 1);
    assert.equal(s.batch.records[0].status, 'skipped_previously_reported');
    assert.equal(s.submissions.length, 1);
    assert.notEqual(s.submissions[0].order, s.records[0].order);
    assert.equal(s.journal.attempts[0].id, 'synthetic-unknown');
    assert.equal(s.journal.attempts[0].key,
      JSON.stringify([s.records[0].order, s.records[0].goodsId, s.records[0].time]));
    assert.equal(s.journal.attempts[0].history.at(-1).evidence, 'TIMEOUT');
    assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [2, 0]);
    const submittedRecord = s.batch.records.find(record => record.status === 'confirmed');
    assert.equal(submittedRecord.timeDiagnostics.ignoredCount, 1);
  });
  test('旧1星记录先正常查询再核验，随后新增1条满足本次目标', async page => {
    await seedUnknown(page);
    await page.evaluate(() => { window.sim.filterStar = 4; window.renderFixture(); });
    const result = await run(page, { n: 1 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.queries[0].star, 1);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.reconciled.length, 1);
    assert.ok(s.filterClicks.includes('1星'));
  });
  for (const star of [2, 3]) {
    test(`旧${star}星记录只在正常遍历遇到时恢复，不预先追查且不计本次成功`, async page => {
      await page.evaluate(star => { window.sim.records[0].star = star; }, star);
      await seedUnknown(page);
      assert.equal((await run(page, { n: 3 })).reported, 1);
      const s = await state(page);
      assert.deepEqual(s.queries.map(entry => entry.star), [1, 2, 3]);
      assert.ok(s.queries.slice(1).every(entry => entry.submitted === 1));
      assert.equal(s.submissions.length, 1);
      assert.equal(s.stats.uncertain, 0);
    });
  }
  test('旧1星订单在第二页时随正常遍历核验，新增举报与历史分开', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      window.sim.records.reverse();
      window.sim.pageSize = 1;
      window.renderFixture();
    });
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.deepEqual(s.queries.map(entry => entry.star), [1, 2, 3]);
    assert.ok(s.visits.some(entry => entry.star === 1 && entry.page === 2));
    assert.equal(s.submissions.length, 1);
  });
  test('正常翻页恢复只修正历史，目标2不足时实际新增1条', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      window.sim.records.reverse();
      window.sim.pageSize = 1;
      window.renderFixture();
    });
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.stats.confirmed, 2);
    assert.equal(s.stats.uncertain, 0);
  });
  test('1星历史恢复后2星查询被禁用，历史保留且本次成功仍为0', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      const data = window.PDDEvaluationHelper.readReportJournal();
      const rec = window.sim.records[1];
      rec.star = 2;
      data.attempts.push({ ...data.attempts[0], id: 'synthetic-second-unknown',
        star: 2, order: rec.order, goodsId: rec.goodsId, time: rec.time,
        key: JSON.stringify([rec.order, rec.goodsId, rec.time]) });
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(data));
      [...document.querySelectorAll('.evaluation_search_btn')].find(el => el.innerText === '2星')
        .addEventListener('click', () => { document.querySelector('#query').disabled = true; });
      window.renderFixture();
    });
    assert.equal((await run(page, { n: 2 })).code, 'QUERY_DISABLED');
    const s = await state(page);
    assert.equal(s.batch.summary.reported, 0);
    assert.equal(s.batch.reconciled.length, 1);
    assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [1, 1]);
    assert.equal(s.submissions.length, 0);
  });
  test('旧2星历史不提前查询；1星先新增，再顺序遇到2星时修正历史', async page => {
    await page.evaluate(() => { window.sim.records[0].star = 2; });
    await seedUnknown(page);
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.deepEqual(s.queries.map(entry => entry.star), [1, 2, 3]);
    assert.equal(s.queries[0].submitted, 0);
    assert.ok(s.queries.slice(1).every(entry => entry.submitted === 1));
    assert.equal(s.submissions.length, 1);
    assert.equal(s.submissions[0].star, 1);
    assert.equal(s.stats.confirmed, 2);
  });
  test('旧历史核验查询无完成证据时停止，原未知历史不改写且零提交', async page => {
    await seedUnknown(page);
    const before = await page.evaluate(() => localStorage.getItem('pdd-evaluation-helper:reports:v1'));
    await page.evaluate(() => {
      document.querySelector('#query').addEventListener('click', event => event.stopImmediatePropagation(), true);
    });
    assert.equal((await run(page)).code, 'TIMEOUT');
    const s = await state(page);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.stats.uncertain, 1);
    assert.equal(await page.evaluate(() => localStorage.getItem('pdd-evaluation-helper:reports:v1')), before);
    assert.ok(s.filterClicks.includes('1星'));
  });
  test('历史恢复不抵扣目标1，继续新增1次提交', async page => {
    await seedUnknown(page);
    const result = await run(page);
    assert.equal(result.reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.queries.length, 1);
    assert.equal(s.batch.stopReason, 'target_reached');
  });
  test('已有29条确认不影响本次目标，恢复1条和新增1条分别记录', async page => {
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
    assert.equal(s.stats.confirmed, 31);
    assert.equal(s.stats.uncertain, 0);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.queries.length, 3);
  });
  test('历史日期未知恢复保留原日期，本次目标只计新增且不重发', async page => {
    await seedUnknown(page, { day: '2026-10-01' });
    assert.equal((await run(page)).reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.stats.confirmed, 2);
    assert.equal(s.batch.reconciled[0].day, '2026-10-01');
    assert.equal(s.batch.records[0].status, 'skipped_previously_reported');
  });
  test('指定其他商品时不查询旧商品，历史待核验不影响本次目标', async page => {
    await seedUnknown(page);
    const otherGoods = await page.evaluate(() => window.sim.records[1].goodsId);
    assert.equal((await run(page, { n: 1, goodsId: otherGoods })).reported, 1);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.stats.confirmed, 1);
    assert.equal(s.stats.uncertain, 1);
    assert.equal(s.batch.records[0].goodsId, otherGoods);
    assert.deepEqual(s.goodsEvents, [otherGoods]);
    assert.deepEqual(s.queries.map(entry => entry.submitted), [0]);
  });
  test('部分历史恢复、另一条不可见未知时继续新提交，本次计数独立', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      const data = window.PDDEvaluationHelper.readReportJournal();
      const rec = { order: '880998-000001', goodsId: '8998', time: '2026-10-01 00:00:00' };
      data.attempts.push({ ...data.attempts[0], ...rec, id: 'not-visible-unknown',
        key: JSON.stringify([rec.order, rec.goodsId, rec.time]) });
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(data));
    });
    assert.equal((await run(page, { n: 2 })).reported, 1);
    const s = await state(page);
    assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [2, 1]);
    assert.equal(s.batch.summary.reported, 1);
    assert.equal(s.queries.length, 3);
    assert.equal(s.submissions.length, 1);
  });
  test('重复身份的记录即使有受理文字也不能恢复', async page => {
    await seedUnknown(page);
    await page.evaluate(() => {
      window.sim.records[1] = { ...window.sim.records[0] };
      window.renderFixture();
    });
    assert.equal((await run(page)).code, 'DUPLICATE_RECORD');
    const s = await state(page);
    assert.equal(s.stats.uncertain, 1);
    assert.equal(s.batch.error.code, 'DUPLICATE_RECORD');
  });
  test('恢复台账持久化失败时查询1星后仍不提交', async page => {
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
    assert.equal(s.stats.uncertain, 1);
    assert.equal(s.queries.length, 1);
    assert.equal(s.submissions.length, 0);
  });
  for (const invalid of ['not-visible', 'different-time', 'different-body', 'different-star',
    'different-report-text', 'different-reason', 'still-link', 'outside-status']) {
    test(`旧未知${invalid}不能自动核验，只处理其他评价且不重发旧身份`, async page => {
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
      const oldOrder = (await state(page)).journal.attempts[0].order;
      assert.equal((await run(page)).reported, 1);
      const s = await state(page);
      assert.equal(s.submissions.length, 1);
      assert.notEqual(s.submissions[0].order, oldOrder);
      assert.equal(s.queries.length, 1);
      assert.equal(s.stats.uncertain, 1);
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
    assert.equal((await state(page)).stats.uncertain, 1);
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
    assert.equal((await state(page)).stats.uncertain, 1);
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
