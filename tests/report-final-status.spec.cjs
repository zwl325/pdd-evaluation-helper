'use strict';

// 依据现场新增成功文字构造合成DOM；所有订单均为夹具数据，全部网络拦截。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const original = fs.readFileSync(path.join(__dirname, '..', 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? original : original
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const fixture = fs.readFileSync(path.join(__dirname, 'report-fixture.html'), 'utf8');
const finalText = '举报成功，不计入店铺考核';
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const run = (page, options = { n: 1 }, special = false) => page.evaluate(({ options, special }) =>
  window.PDDEvaluationHelper[special ? 'startOneStarReportBatch' : 'startReportBatch'](options)
    .catch(error => ({ code: error.code, message: error.message })), { options, special });
const state = page => page.evaluate(() => ({ ...window.sim,
  batch: window.PDDEvaluationHelper.readReportBatch(),
  journal: window.PDDEvaluationHelper.readReportJournal(),
  stats: window.PDDEvaluationHelper.readReportStats() }));

test('终态成功直接计数并达到目标，不增加待核验或多提交', async page => {
  await page.evaluate(() => {
    const first = window.sim.records[0];
    window.sim.records.push({ ...first, order: '880000-000000099', time: '2026-10-14 12:00:00' });
    window.renderFixture();
  });
  const result = await run(page);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.reported, result.pending, result.checked], [1, 0, 1]);
  const s = await state(page);
  assert.equal(s.batch.stopReason, 'target_reached');
  assert.equal(s.submissions.length, 1);
  assert.equal(s.journal.attempts[0].evidence, 'record_report_accepted');
  assert.equal(s.journal.attempts[0].submissionDiagnostics.status.text, finalText);
  assert.deepEqual(s.stats, { confirmed: 1, uncertain: 0 });
});
test('终态成功英文逗号兼容，仍完整识别', async page => {
  await page.evaluate(() => { window.sim.acceptanceText = '举报成功, 不计入店铺考核'; });
  assert.equal((await run(page)).reported, 1);
  assert.equal((await state(page)).submissions.length, 1);
});
test('终态成功用于无条件一星有文字评价', async page => {
  await page.evaluate(() => {
    window.sim.records[0].content = '普通手写评价，仅用于合成测试';
    window.renderFixture();
  });
  assert.equal((await run(page, { n: 1 }, true)).reported, 1);
  const s = await state(page);
  assert.equal(s.journal.attempts[0].strategy, 'one-star-all');
  assert.deepEqual(s.queries.map(q => q.star), [1]);
});
test('页面已有终态且无本机历史时跳过，继续下一条达到目标', async page => {
  await page.evaluate(text => {
    const first = window.sim.records[0];
    window.sim.records.push({ ...first, order: '880000-000000099', time: '2026-10-14 12:00:00' });
    Object.assign(first, { reported: true, acceptedText: text });
    window.renderFixture();
  }, finalText);
  const result = await run(page);
  assert.equal(result.reported, 1, result.message);
  const s = await state(page);
  assert.deepEqual([s.batch.summary.checked, s.batch.summary.skipped], [2, 1]);
  assert.equal(s.batch.records[0].status, 'skipped_already_reported');
  assert.equal(s.submissions.length, 1);
  assert.notEqual(s.submissions[0].order, s.records[0].order);
  assert.equal(s.journal.attempts.length, 1);
});
test('全部页面记录已是终态且无历史时正常遍历结束，零新提交', async page => {
  await page.evaluate(text => {
    Object.assign(window.sim.records[0], { reported: true, acceptedText: text });
    window.renderFixture();
  }, finalText);
  const result = await run(page, { n: 5 });
  assert.equal(result.ok, true, result.message);
  assert.deepEqual([result.reported, result.pending, result.skipped], [0, 0, 1]);
  assert.equal(result.batch.stopReason, 'stars_exhausted');
  assert.equal((await state(page)).submissions.length, 0);
});
test('旧未知按终态恢复，仅修正累计并保留原诊断，本次仍新增目标数量', async page => {
  await page.evaluate(text => {
    const first = window.sim.records[0];
    window.sim.records.push({ ...first, order: '880000-000000099', time: '2026-10-14 12:00:00' });
    Object.assign(first, { reported: true, acceptedText: text });
    const h = window.PDDEvaluationHelper;
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [{
      id: 'synthetic-final-status-old', key: JSON.stringify([first.order, first.goodsId, first.time]),
      order: first.order, goodsId: first.goodsId, time: first.time, star: 1, content: first.content,
      day: '2026-10-15', at: '2026-10-15T01:00:00.000Z', status: 'submitted_unverified',
      reason: '同行恶意差评', reportText: h.readTemplates().reportText, evidence: 'TIMEOUT',
      history: [], submissionDiagnostics: { stage: 'after_submit', marker: 'keep-original-timeout' },
    }] }));
    window.renderFixture();
  }, finalText);
  const result = await run(page);
  assert.equal(result.reported, 1, result.message);
  const s = await state(page);
  assert.deepEqual(s.stats, { confirmed: 2, uncertain: 0 });
  assert.equal(s.batch.reconciled.length, 1);
  assert.equal(s.submissions.length, 1);
  assert.notEqual(s.submissions[0].order, s.records[0].order);
  const old = s.journal.attempts[0];
  assert.equal(old.id, 'synthetic-final-status-old');
  assert.equal(old.day, '2026-10-15');
  assert.equal(old.history.at(-1).evidence, 'TIMEOUT');
  assert.deepEqual(old.submissionDiagnostics, { stage: 'after_submit', marker: 'keep-original-timeout' });
  assert.equal(old.verification.statusText, finalText);
  assert.equal(old.reconciliationDiagnostics.status.accepted, true);
});
for (const scenario of ['body', 'hidden', 'link-still', 'wrong-identity', 'wrong-star', 'flash', 'keep-modal']) {
  test(`终态反例 ${scenario} 仍不确认成功或重发`, async page => {
    await page.evaluate(scenario => { window.sim.acceptanceScenario = scenario; }, scenario);
    const result = await run(page);
    if (scenario === 'keep-modal') assert.equal(result.code, 'REPORT_SUBMITTED_UNVERIFIED');
    else {
      assert.equal(result.ok, true, result.message);
      assert.deepEqual([result.reported, result.pending], [0, 1]);
    }
    const s = await state(page);
    assert.deepEqual(s.stats, { confirmed: 0, uncertain: 1 });
    assert.equal(s.submissions.length, 1);
    assert.equal(s.journal.attempts[0].status, 'submitted_unverified');
  });
}
test('终态出现在其他记录时不确认当前提交', async page => {
  await page.evaluate(() => {
    const first = window.sim.records[0];
    window.sim.records.push({ ...first, order: '880000-000000099', time: '2026-10-14 12:00:00',
      content: '其他记录，非候选' });
    window.sim.acceptanceScenario = 'other-row';
    window.renderFixture();
  });
  const result = await run(page);
  assert.deepEqual([result.reported, result.pending], [0, 1]);
  assert.equal((await state(page)).submissions.length, 1);
});
for (const text of ['举报成功', '举报成功，不计入店铺考核失败', '提示：举报成功，不计入店铺考核']) {
  test(`不放宽近似终态全文：${text}`, async page => {
    await page.evaluate(text => { window.sim.acceptanceText = text; }, text);
    const result = await run(page);
    assert.deepEqual([result.reported, result.pending], [0, 1]);
    assert.equal((await state(page)).submissions.length, 1);
  });
}

async function main() {
  const selected = process.env.PDD_TEST_CASE ? cases.filter(c => c.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
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
        await page.evaluate(text => {
          const s = window.sim;
          s.records = [s.records[1]];
          s.keepReported = true;
          s.acceptanceScenario = 'header';
          s.acceptanceText = text;
          const originalRender = window.renderFixture;
          window.renderFixture = () => {
            originalRender();
            for (const group of document.querySelectorAll('[data-testid="beast-core-table-middle-tbody"]')) {
              const header = group.querySelector('.evaluation-item-header');
              const label = header?.querySelector('span');
              if (label) {
                const status = document.createElement('div');
                status.hidden = label.hidden;
                status.style.color = 'rgb(68, 187, 0)';
                const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                icon.dataset.testid = 'beast-core-icon-check-circle_filled';
                icon.style.cssText = 'width:12px;height:12px';
                status.append(icon, label.textContent);
                label.replaceWith(status);
              }
              // 现场状态是头部直接文本+图标；对应举报区域为空，不借用区域中的旧“已举报”。
              const reportRegion = group.querySelector('[data-tracking-click-viewid="report"]');
              if (reportRegion && !reportRegion.querySelector('a')) reportRegion.replaceChildren();
            }
          };
          window.renderFixture();
        }, finalText);
        await page.addScriptTag({ content: source });
        await item.fn(page);
        assert.deepEqual(errors, []);
        console.log(`PASS ${item.name}`);
      } catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`FINAL STATUS RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
