'use strict';

// 全部使用合成记录，拦截所有网络；不导入业务台账或访问真实商家后台。
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
const cases = [];
const test = (name, fn) => cases.push({ name, fn });
const panel = page => page.locator('#pdd-evaluation-helper-panel');
const run = (page, options = { n: 1 }, special = false) => page.evaluate(({ options, special }) =>
  window.PDDEvaluationHelper[special ? 'startOneStarReportBatch' : 'startReportBatch'](options)
    .catch(error => ({ code: error.code, message: error.message })), { options, special });
const state = page => page.evaluate(() => ({ ...window.sim,
  batch: window.PDDEvaluationHelper.readReportBatch(), stats: window.PDDEvaluationHelper.readReportStats(),
  journal: window.PDDEvaluationHelper.readReportJournal() }));
async function seed(page, indexes = [1], accepted = false) {
  await page.evaluate(({ indexes, accepted }) => {
    const h = window.PDDEvaluationHelper;
    const attempts = indexes.map(index => {
      const rec = window.sim.records[index];
      if (accepted) { rec.reported = true; rec.acceptedText = '已举报，待审核'; }
      return { id: `synthetic-old-${index}`, key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
        order: rec.order, goodsId: rec.goodsId, time: rec.time, star: rec.star, content: rec.content,
        day: '2026-10-01', status: 'submitted_unverified', strategy: 'template',
        reportText: h.readTemplates().reportText, reason: '同行恶意差评', history: [],
        evidence: 'TIMEOUT', submissionDiagnostics: { stage: 'after_submit', marker: 'original-preserved' } };
    });
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts }));
    window.renderFixture();
  }, { indexes, accepted });
}

test('其他商品旧未知不扩大查询、不阻断目标，原历史不改写', async page => {
  await seed(page);
  const before = await page.evaluate(() => localStorage.getItem('pdd-evaluation-helper:reports:v1'));
  const result = await run(page, { n: 2, goodsId: '8002' });
  assert.equal(result.reported, 2, result.message);
  const s = await state(page);
  assert.ok(s.queryGoods.every(goods => goods === '8002'));
  assert.ok(s.submissions.every(q => !JSON.parse(before).attempts.some(old => old.order === q.order)));
  assert.deepEqual(s.journal.attempts[0], JSON.parse(before).attempts[0]);
  assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [2, 1]);
  assert.deepEqual([s.batch.summary.reported, s.batch.summary.skippedPending], [2, 0]);
});
test('同一旧未知只跳过该条，继续跨星级直到本次成功目标', async page => {
  await seed(page);
  const result = await run(page, { n: 2 });
  assert.equal(result.reported, 2, result.message);
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1, 2]);
  assert.equal(s.batch.summary.skippedPending, 1);
  assert.equal(s.batch.summary.pending, 0);
  assert.equal(s.batch.records.find(r => r.historyAttemptId).status, 'skipped_pending_history');
  assert.ok(s.submissions.every(r => r.order !== s.records[1].order));
  assert.equal(s.stats.uncertain, 1);
});
test('本次未知停止后再次运行重置批次并处理其他评价，不重发旧条', async page => {
  await page.evaluate(() => { window.sim.acceptanceScenario = 'body'; });
  assert.equal((await run(page, { n: 5 })).code, 'REPORT_SUBMITTED_UNVERIFIED');
  const old = await state(page);
  assert.equal(old.batch.summary.pending, 1);
  assert.equal(old.batch.summary.reported, 0);
  await page.evaluate(() => { window.sim.acceptanceScenario = 'header'; });
  assert.equal((await run(page, { n: 1 })).reported, 1);
  const s = await state(page);
  assert.notEqual(s.batch.id, old.batch.id);
  assert.equal(s.batch.error, undefined);
  assert.equal(s.batch.phase, 'completed');
  assert.deepEqual([s.batch.summary.reported, s.batch.summary.pending, s.batch.summary.skippedPending], [1, 0, 1]);
  assert.equal(s.submissions.length, 2);
  assert.equal(new Set(s.submissions.map(r => r.order)).size, 2);
  assert.deepEqual(s.journal.attempts[0].submissionDiagnostics, old.journal.attempts[0].submissionDiagnostics);
  assert.equal(s.journal.attempts[0].reconciliationDiagnostics.stage, 'reconcile');
  const text = await panel(page).locator('#report-inspection').innerText();
  assert.match(text, /本次待核验0条；跳过历史待核验1条/);
  assert.doesNotMatch(text, /停止原因/);
  assert.equal(await panel(page).locator('#report-inspection').getAttribute('data-tone'), 'info');
});
test('新批查询等待中计数归零且旧错误、结束原因、记录清空', async page => {
  await run(page);
  const old = await state(page);
  await page.evaluate(() => {
    const key = 'pdd-evaluation-helper:last-report-batch:v1';
    const previous = JSON.parse(sessionStorage.getItem(key));
    Object.assign(previous, { phase: 'stopped', error: { code: 'OLD', message: 'synthetic-old-error' } });
    sessionStorage.setItem(key, JSON.stringify(previous));
    window.sim.delay = 900;
    window.pendingRun = window.PDDEvaluationHelper.startReportBatch({ n: 2 }).catch(e => ({ code: e.code }));
  });
  await page.waitForFunction(id => {
    const b = window.PDDEvaluationHelper.readReportBatch();
    return b?.id !== id && b?.phase === 'querying';
  }, old.batch.id);
  const b = (await state(page)).batch;
  assert.deepEqual(b.summary, { checked: 0, reported: 0, skipped: 0, pending: 0, skippedPending: 0 });
  assert.deepEqual(b.records, []);
  assert.deepEqual(b.reconciled, []);
  assert.equal(b.error, undefined);
  assert.equal(b.stopReason, undefined);
  assert.equal(b.target, 2);
  assert.doesNotMatch(await panel(page).locator('#report-inspection').innerText(), /synthetic-old-error/);
  await page.evaluate(() => window.PDDEvaluationHelper.cancel());
  await page.evaluate(() => window.pendingRun);
});
test('连续成功批次分别按本次数量计数，历史成功只跳过', async page => {
  assert.equal((await run(page)).reported, 1);
  const old = await state(page);
  assert.equal((await run(page, { n: 2 })).reported, 2);
  const s = await state(page);
  assert.notEqual(s.batch.id, old.batch.id);
  assert.equal(s.submissions.length, 3);
  assert.equal(s.stats.confirmed, 3);
  assert.equal(s.batch.summary.reported, 2);
  assert.ok(s.batch.records.some(r => r.status === 'skipped_previously_reported'));
});
test('遍历全为待核验历史时正常完成，零成功零新提交且明确显示跳过数', async page => {
  await seed(page, [0, 1, 2, 3, 4, 5, 6, 7]);
  const result = await run(page, { n: 5 });
  assert.equal(result.ok, true, result.message);
  const s = await state(page);
  assert.equal(s.submissions.length, 0);
  assert.deepEqual([s.batch.summary.reported, s.batch.summary.skippedPending, s.stats.uncertain], [0, 8, 8]);
  assert.equal(s.batch.stopReason, 'stars_exhausted');
  assert.match(await panel(page).locator('#report-status').innerText(), /已全部处理.*8条为历史待核验/);
});
test('旧受理历史仅修正累计数，不抵扣本次2条目标', async page => {
  await seed(page, [1], true);
  assert.equal((await run(page, { n: 2 })).reported, 2);
  const s = await state(page);
  assert.deepEqual([s.stats.confirmed, s.stats.uncertain], [3, 0]);
  assert.equal(s.submissions.length, 2);
  assert.equal(s.batch.reconciled.length, 1);
  assert.equal(s.batch.records.filter(r => r.status === 'confirmed').length, 2);
  assert.deepEqual(s.journal.attempts[0].submissionDiagnostics, { stage: 'after_submit', marker: 'original-preserved' });
});
test('其他星级旧未知不影响无条件一星入口且不越界查询', async page => {
  await seed(page, [3, 6]);
  assert.equal((await run(page, { n: 1 }, true)).reported, 1);
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1]);
  assert.equal(s.submissions.length, 1);
  assert.equal(s.stats.uncertain, 2);
  assert.equal(s.batch.strategy, 'one-star-all');
});
test('旧未知不存在于当前日期结果时不追查、不改写原诊断', async page => {
  await seed(page);
  const old = (await state(page)).journal.attempts[0];
  await page.evaluate(() => { window.sim.records.splice(1, 1); window.renderFixture(); });
  assert.equal((await run(page, { n: 1 })).reported, 1);
  const s = await state(page);
  assert.deepEqual(s.journal.attempts[0], old);
  assert.equal(s.stats.uncertain, 1);
});
test('无成功证据的新提交仍不计成功，导出有限DOM诊断且保留等待错误', async page => {
  await page.evaluate(() => { window.sim.acceptanceScenario = 'body'; });
  assert.equal((await run(page)).code, 'REPORT_SUBMITTED_UNVERIFIED');
  const s = await state(page);
  assert.equal(s.batch.summary.pending, 1);
  const d = s.journal.attempts[0].submissionDiagnostics;
  assert.equal(d.status.accepted, false);
  assert.equal(d.status.linkCount, 0);
  assert.equal(d.waitError.code, 'TIMEOUT');
  assert.equal(d.stage, 'after_submit');
  assert.equal(d.rowDOM.headers.length, 1);
  assert.equal(d.rowDOM.reportRegions[0].text, '已举报');
  assert.match(d.rowDOM.outerHTML, /已举报，待审核/);
  assert.ok(d.rowDOM.outerHTML.length <= 24000);
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.evaluate(() => window.PDDEvaluationHelper.exportReportLedger())]);
  const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.deepEqual(exported.journal.attempts[0].submissionDiagnostics, d);
});
test('无条件一星遇到同一旧未知也只跳过该条，完成其他一星', async page => {
  await seed(page, [0]);
  assert.equal((await run(page, { n: 2 }, true)).reported, 2);
  const s = await state(page);
  assert.equal(s.batch.summary.skippedPending, 1);
  assert.ok(s.submissions.every(r => r.star === 1 && r.order !== s.records[0].order));
  assert.deepEqual(s.queries.map(q => q.star), [1]);
});
test('从其他后台页跳转后也按本次商品运行，不继承旧停止状态', async page => {
  await seed(page);
  await page.goto('https://mms.pinduoduo.com/home/');
  await page.addInitScript({ content: `document.addEventListener('DOMContentLoaded', () => {\n${source}\n}, {once:true});` });
  await page.addScriptTag({ content: source });
  await panel(page).locator('#mode-report').click();
  await panel(page).locator('#report-n').fill('1');
  await panel(page).locator('#report-goods').fill('8002');
  await panel(page).locator('#report-run-once').click();
  await page.waitForFunction(() => window.PDDEvaluationHelper?.readReportBatch()?.phase === 'completed');
  const s = await state(page);
  assert.equal(s.batch.summary.reported, 1);
  assert.deepEqual(s.goodsEvents, ['8002']);
  assert.equal(s.filterGoods, '8002');
  assert.equal(s.stats.uncertain, 1);
});

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
        await page.evaluate(() => {
          window.sim.keepReported = true;
          window.sim.queryGoods = [];
          document.querySelector('#query').addEventListener('click', () => {
            window.sim.queryGoods.push(document.querySelector('#goodsId input').value);
          }, true);
          window.renderFixture();
        });
        await page.addScriptTag({ content: source });
        await item.fn(page);
        assert.deepEqual(errors, []);
        console.log(`PASS ${item.name}`);
      } catch (error) { failures++; console.error(`FAIL ${item.name}\n${error.stack}`); }
      finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`BATCH RESET RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
