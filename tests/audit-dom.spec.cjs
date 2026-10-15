'use strict';

// Independent DOM audit: all records and events are synthetic, and every network request is intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const replyFixture = fs.readFileSync(path.join(__dirname, 'batch-fixture.html'), 'utf8');
const reportFixture = fs.readFileSync(path.join(__dirname, 'report-fixture.html'), 'utf8');
const originalSource = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? originalSource : originalSource
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const url = 'https://mms.pinduoduo.com/goods/evaluation/index';
const run = (page, mode = 'report', params = { n: 1 }) => page.evaluate(async ({ mode, params }) => {
  try {
    return await (mode === 'reply'
      ? window.PDDEvaluationHelper.startBatch(params)
      : window.PDDEvaluationHelper.startReportBatch(params));
  } catch (error) {
    return { code: error.code, message: error.message };
  }
}, { mode, params });
const state = page => page.evaluate(() => ({
  submissions: window.sim.submissions,
  replyBatch: window.PDDEvaluationHelper.readBatch(),
  reportBatch: window.PDDEvaluationHelper.readReportBatch(),
  reportJournal: window.PDDEvaluationHelper.readReportJournal(),
}));
async function movingNotice(page) {
  await page.evaluate(() => {
    const notice = document.createElement('span');
    notice.setAttribute('role', 'status');
    document.body.append(notice);
    let tick = 0;
    window.auditNoticeTimer = setInterval(() => { notice.textContent = `无关通知 ${++tick}`; }, 30);
  });
}

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const cases = [];
  const test = (name, mode, fixture, fn) => cases.push({ name, mode, fixture, fn });
  const delayedTitle = replyFixture.replace('document.body.append(modal);',
    `document.body.append(modal);
    const title = modal.querySelector('.MDL_header_x');
    title.textContent = '';
    setTimeout(() => { title.textContent = '快捷回复'; }, 150);`);
  test('回复弹框标题分阶段挂载150ms后就绪，不误报进入互动详情', 'reply', delayedTitle, async page => {
    const result = await run(page, 'reply');
    assert.equal(result.replied, 1, result.message);
    assert.equal((await state(page)).submissions.length, 1);
  });
  for (const [control, label] of [['input', '输入框'], ['submit', '提交按钮']]) {
    const fixture = replyFixture.replace("if (mode === 'stale-toast') setTimeout",
      `const delayed = ${control === 'input' ? 'input' : "modal.querySelector('[data-tracking-click-viewid=\"reply_btn\"]')"};
      delayed.hidden = true;
      setTimeout(() => { delayed.hidden = false; }, 550);
      if (mode === 'stale-toast') setTimeout`);
    test(`回复弹框${label}550ms后加载，等待就绪后只提交一次`, 'reply', fixture, async page => {
      const result = await run(page, 'reply');
      assert.equal(result.replied, 1, result.message);
      assert.equal((await state(page)).submissions.length, 1);
    });
  }
  test('回复弹框明确显示其他标题仍保护停止且不提交', 'reply',
    replyFixture.replace("${mode === 'wrong-modal' ? '互动详情' : '快捷回复'}", '互动详情'), async page => {
      assert.equal((await run(page, 'reply')).code, 'UNEXPECTED_MODAL');
      assert.equal((await state(page)).submissions.length, 0);
    });
  const delayedReason = reportFixture.replace('document.body.append(modal);',
    `document.body.append(modal);
    const delayedReason = modal.querySelector('#reportType label');
    delayedReason.hidden = true;
    setTimeout(() => { delayedReason.hidden = false; }, 550);`);
  test('举报原因选项分阶段挂载550ms后就绪，等待后只提交一次', 'report', delayedReason, async page => {
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    assert.equal((await state(page)).submissions.length, 1);
  });
  const delayedReportInput = reportFixture.replace("modal.querySelector('#describesNegativeReview').hidden = false;",
    `modal.querySelector('#describesNegativeReview').hidden = false;
    input.hidden = true;
    setTimeout(() => { input.hidden = false; }, 550);`);
  test('举报说明输入框选择原因后550ms加载，等待后只提交一次', 'report', delayedReportInput, async page => {
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    assert.equal((await state(page)).submissions.length, 1);
  });
  const delayedReportSubmit = reportFixture.replace("input.addEventListener('input', event => {",
    `input.addEventListener('input', event => {
    submit.hidden = true;
    setTimeout(() => { submit.hidden = false; }, 550);`);
  test('举报填文后提交按钮550ms加载，等待后只提交一次', 'report', delayedReportSubmit, async page => {
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('隐藏旧举报状态不遮蔽真实可用举报入口', 'report', reportFixture, async page => {
    await page.evaluate(() => {
      const original = window.renderFixture;
      window.renderFixture = () => {
        original();
        for (const group of document.querySelectorAll('[data-testid="beast-core-table-middle-tbody"]')) {
          const hidden = document.createElement('div');
          hidden.hidden = true;
          hidden.setAttribute('data-tracking-click-viewid', 'report');
          hidden.textContent = '已举报';
          group.prepend(hidden);
        }
      };
      window.renderFixture();
    });
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('可见已举报状态仍跳过，不计为本次新成功', 'report', reportFixture, async page => {
    await page.evaluate(() => {
      window.sim.records[0].reported = true;
      window.renderFixture();
    });
    const result = await run(page);
    assert.equal(result.reported, 0, result.message);
    assert.equal(result.skipped, 1);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('无关通知持续变化不阻断同一记录稳定受理证据', 'report', reportFixture, async page => {
    await movingNotice(page);
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.reportJournal.attempts[0].evidence, 'record_report_accepted');
  });
  test('无关通知变化且无受理证据仍保留未知，不伪造成功', 'report', reportFixture, async page => {
    await page.evaluate(() => { window.sim.acceptanceScenario = 'failed'; });
    await movingNotice(page);
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.reported, result.pending], [0, 1]);
    const s = await state(page);
    assert.equal(s.reportBatch.phase, 'completed');
    assert.equal(s.submissions.length, 1);
    assert.equal(s.reportBatch.summary.reported, 0);
    assert.equal(s.reportJournal.attempts[0].status, 'submitted_unverified');
  });
  test('无关通知持续变化不阻断当前页旧未知只读核验及下一条新增', 'report', reportFixture, async page => {
    await page.evaluate(() => {
      const rec = window.sim.records[0];
      rec.reported = true;
      rec.acceptedText = '已举报，待审核';
      const next = { ...rec, order: '880000-000000099', time: '2026-10-14 10:09:09',
        reported: false, acceptedText: '' };
      window.sim.records.push(next);
      const reportText = document.querySelector('#pdd-evaluation-helper-panel').shadowRoot
        .querySelector('#report-copy').value;
      const entry = { id: 'synthetic-dom-audit-pending',
        key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
        shop: '', order: rec.order, goodsId: rec.goodsId, time: rec.time, star: 1,
        content: rec.content, reportText, reason: '同行恶意差评',
        day: '2026-10-14', status: 'submitted_unverified', evidence: 'TIMEOUT',
        at: new Date().toISOString(), history: [] };
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [entry] }));
      window.renderFixture();
    });
    await movingNotice(page);
    const result = await run(page);
    assert.equal(result.reported, 1, result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.reportBatch.reconciled.length, 1);
    assert.equal(s.reportJournal.attempts[0].status, 'confirmed');
  });
  test('目标记录受理状态仅短暂出现120ms仍不确认成功', 'report', reportFixture, async page => {
    await page.evaluate(() => { window.sim.acceptanceScenario = 'flash'; });
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.reported, result.pending], [0, 1]);
    const s = await state(page);
    assert.equal(s.reportBatch.phase, 'completed');
    assert.equal(s.submissions.length, 1);
    assert.equal(s.reportBatch.summary.reported, 0);
  });

  const selected = process.env.PDD_TEST_CASE ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length);
  let failures = 0;
  try {
    for (const item of selected) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: item.fixture })
        : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto(url);
        if (item.mode === 'report') await page.evaluate(() => {
          window.sim.records = [window.sim.records[1]];
          window.sim.keepReported = true;
          window.sim.acceptanceScenario = 'header';
          window.renderFixture();
        });
        await page.addScriptTag({ content: source });
        await item.fn(page);
        assert.deepEqual(errors, []);
        console.log(`PASS ${item.name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${item.name}\n${error.stack}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`DOM AUDIT RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
