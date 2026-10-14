'use strict';

// 分页data-status格式来自交接中的历史DOM；所有记录及页面均为合成数据。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const originalSource = fs.readFileSync(path.join(root, 'pdd-evaluation-filter.user.js'), 'utf8');
const source = process.env.PDD_PRODUCTION_TIMERS ? originalSource : originalSource
  .replace('actionTimeoutMs: 6000,', 'actionTimeoutMs: 1000,')
  .replace('resultTimeoutMs: 15000,', 'resultTimeoutMs: 1600,')
  .replace('resultStableMs: 800,', 'resultStableMs: 120,')
  .replace('submissionTimeoutMs: 15000,', 'submissionTimeoutMs: 1000,');
const cases = [];
const test = (name, mode, fn) => cases.push({ name: `${mode}: ${name}`, mode, fn });
const run = (page, mode, options = { n: 1 }) => page.evaluate(({ mode, options }) =>
  window.PDDEvaluationHelper[mode === 'report' ? 'startReportBatch' : 'startBatch'](options)
    .catch(error => ({ code: error.code, message: error.message })), { mode, options });
const state = (page, mode) => page.evaluate(mode => ({
  ...window.sim,
  batch: window.PDDEvaluationHelper[mode === 'report' ? 'readReportBatch' : 'readBatch'](),
  ...(mode === 'report' ? { journal: window.PDDEvaluationHelper.readReportJournal(),
    quota: window.PDDEvaluationHelper.readReportQuota() } : {}),
}), mode);

// 只在内存中增强原有夹具，不改写用户已有的batch-fixture.html。
function fixture(mode) {
  const original = fs.readFileSync(path.join(__dirname, `${mode === 'report' ? 'report' : 'batch'}-fixture.html`), 'utf8');
  const hook = `
    window.adjustPagination = () => {
      const paginator = document.querySelector('[data-testid="beast-core-pagination"]');
      const variant = window.sim.paginationVariant || 'status-only';
      paginator.dataset.status = \`beast-core-pagination-\${window.sim.pageSize}-\${window.sim.page}\`;
      const active = paginator.querySelector('.PGT_pagerItemActive');
      if (['status-only', 'none', 'invalid-status', 'zero-size', 'unsafe-page', 'wrong-range',
        'leading-zero', 'unrelated-status'].includes(variant)) {
        active.classList.remove('PGT_pagerItemActive');
      }
      if (variant === 'hidden-marker') active.hidden = true;
      if (variant === 'none') paginator.removeAttribute('data-status');
      if (variant === 'invalid-status') paginator.dataset.status = 'beast-core-pagination-2-x';
      if (variant === 'zero-size') paginator.dataset.status = 'beast-core-pagination-0-1';
      if (variant === 'unsafe-page') paginator.dataset.status = 'beast-core-pagination-2-9007199254740992';
      if (variant === 'conflict') paginator.dataset.status = 'beast-core-pagination-2-2';
      if (variant === 'duplicate-marker') active.after(active.cloneNode(true));
      if (variant === 'nested-marker') {
        active.innerHTML = \`<span aria-current="page">\${window.sim.page}</span>\`;
      }
      if (variant === 'wrong-range') paginator.dataset.status = 'beast-core-pagination-2-999';
      if (variant === 'invalid-marker') active.textContent = '第1页';
      if (variant === 'leading-zero') paginator.dataset.status = 'beast-core-pagination-02-1';
      if (['unrelated-status', 'unrelated-status-active'].includes(variant)) paginator.dataset.status = 'normal';
      if (variant === 'hidden-duplicate') {
        const duplicate = active.cloneNode(true);
        duplicate.hidden = true;
        active.after(duplicate);
      }
      if (variant === 'duplicate-paginator') paginator.after(paginator.cloneNode(true));
      if (variant === 'no-paginator') paginator.remove();
    };
    ${mode === 'report' ? `
      const originalRender = window.renderFixture;
      window.renderFixture = function() { originalRender(); window.adjustPagination(); };
    ` : `
      const originalRender = render;
      render = function() { originalRender(); window.adjustPagination(); };
      window.renderFixture = render;
    `}
    window.adjustPagination();
  `;
  return original.replace('</script>', `${hook}</script>`);
}

async function seedUnknown(page) {
  await page.evaluate(() => {
    window.sim.keepReported = true;
    const rec = window.sim.records[0];
    rec.content = '该用户未填写文字评价';
    rec.reported = true;
    rec.acceptedText = '已举报，待审核';
    const reportText = document.querySelector('#pdd-evaluation-helper-panel').shadowRoot
      .querySelector('#report-copy').textContent;
    const entry = { id: 'synthetic-pagination-unknown',
      key: JSON.stringify([rec.order, rec.goodsId, rec.time]), shop: '',
      order: rec.order, goodsId: rec.goodsId, time: rec.time, star: rec.star,
      day: window.PDDEvaluationHelper.readReportQuota().day, status: 'submitted_unverified',
      reportText, reason: '同行恶意差评', evidence: 'TIMEOUT', at: new Date().toISOString(),
      history: [{ status: 'submitting', at: new Date().toISOString() }] };
    localStorage.setItem('pdd-evaluation-helper:reports:v1',
      JSON.stringify({ schema: 1, attempts: [entry] }));
    window.renderFixture();
  });
}

for (const mode of ['reply', 'report']) {
  test('没有高亮页码时依据组件status继续查询和处理', mode, async page => {
    const result = await run(page, mode);
    assert.equal(result[mode === 'report' ? 'reported' : 'replied'], 1, result.message);
    const s = await state(page, mode);
    assert.equal(s.submissions.length, 1);
  });
  test('高亮页码隐藏时可用组件status', mode, async page => {
    await page.evaluate(() => { window.sim.paginationVariant = 'hidden-marker'; window.renderFixture(); });
    const result = await run(page, mode);
    assert.equal(result[mode === 'report' ? 'reported' : 'replied'], 1, result.message);
  });
  test('高亮页码与组件status一致时按原流程运行', mode, async page => {
    await page.evaluate(() => { window.sim.paginationVariant = 'both'; window.renderFixture(); });
    assert.equal((await run(page, mode))[mode === 'report' ? 'reported' : 'replied'], 1);
  });
  for (const variant of ['hidden-duplicate', 'unrelated-status-active']) {
    test(`${variant}保留唯一可见高亮页码原有支持`, mode, async page => {
      await page.evaluate(variant => { window.sim.paginationVariant = variant; window.renderFixture(); }, variant);
      assert.equal((await run(page, mode))[mode === 'report' ? 'reported' : 'replied'], 1);
    });
  }
  test('仅status分页仍跨页遍历并处理列表收缩', mode, async page => {
    if (mode === 'report') await page.evaluate(() => { window.sim.pageSize = 1; window.renderFixture(); });
    const result = await run(page, mode, {});
    const s = await state(page, mode);
    assert.equal(result.ok, true, result.message);
    assert.equal(s.submissions.length, mode === 'report' ? 5 : 3);
    const visits = mode === 'report' ? s.visits : s.visited;
    assert.ok(visits.some(visit => visit.page > 1));
    assert.equal(new Set(s.submissions.map(entry => entry.order)).size, s.submissions.length);
  });
  test('没有分页器的单页查询保持原行为', mode, async page => {
    await page.evaluate(() => { window.sim.paginationVariant = 'no-paginator'; window.renderFixture(); });
    const result = await run(page, mode);
    assert.equal(result[mode === 'report' ? 'reported' : 'replied'], 1, result.message);
  });
  for (const variant of ['none', 'invalid-status', 'zero-size', 'unsafe-page', 'conflict',
    'duplicate-marker', 'nested-marker', 'wrong-range', 'invalid-marker', 'leading-zero',
    'unrelated-status', 'duplicate-paginator']) {
    test(`${variant}页码不可确认时零提交并导出分页诊断`, mode, async page => {
      await page.evaluate(variant => { window.sim.paginationVariant = variant; window.renderFixture(); }, variant);
      const result = await run(page, mode);
      assert.ok(['PAGE_UNREADABLE', 'PAGE_AMBIGUOUS'].includes(result.code), result.message);
      const s = await state(page, mode);
      assert.equal(s.submissions.length, 0);
      const details = s.batch.error.details;
      assert.equal(details.stage, 'pagination');
      assert.equal(details.visibleCount, variant === 'duplicate-paginator' ? 2 : 1);
      assert.equal(details.containers[0].dataStatus,
        await page.locator('[data-testid="beast-core-pagination"]').first().getAttribute('data-status'));
      assert.ok(details.containers[0].outerHTML.includes('beast-core-pagination'));
      assert.ok(details.observedAt);
      const [download] = await Promise.all([page.waitForEvent('download'),
        page.evaluate(mode => window.PDDEvaluationHelper[mode === 'report' ? 'exportReportLedger' : 'exportLedger'](), mode)]);
      const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
      assert.deepEqual(exported.batch.error.details, details);
    });
  }
}
test('没有任何页码证据仍能核验当前记录，目标1零查询零提交', 'report', async page => {
  await seedUnknown(page);
  await page.evaluate(() => { window.sim.paginationVariant = 'none'; window.renderFixture(); });
  const result = await run(page, 'report');
  assert.equal(result.reported, 1, result.message);
  const s = await state(page, 'report');
  assert.equal(s.queries.length, 0);
  assert.equal(s.submissions.length, 0);
  assert.deepEqual([s.quota.confirmed, s.quota.uncertain, s.quota.remaining], [1, 0, 29]);
});
test('旧未知恢复1条后用status继续目标2，仅新增1条', 'report', async page => {
  await seedUnknown(page);
  const result = await run(page, 'report', { n: 2 });
  assert.equal(result.reported, 2, result.message);
  const s = await state(page, 'report');
  assert.equal(s.submissions.length, 1);
  assert.equal(s.quota.confirmed, 2);
  assert.equal(s.quota.uncertain, 0);
});
test('核验不依赖页码仍等待加载完成，随后恢复而不新增提交', 'report', async page => {
  await seedUnknown(page);
  await page.evaluate(() => {
    window.sim.paginationVariant = 'none'; window.renderFixture();
    document.querySelector('[data-testid="beast-core-table"]').setAttribute('aria-busy', 'true');
    setTimeout(() => document.querySelector('[data-testid="beast-core-table"]').removeAttribute('aria-busy'), 450);
  });
  const result = await run(page, 'report');
  assert.equal(result.reported, 1, result.message);
  const s = await state(page, 'report');
  assert.equal(s.queries.length, 0);
  assert.equal(s.submissions.length, 0);
});
test('核验不依赖页码但短暂受理状态仍不能恢复', 'report', async page => {
  await seedUnknown(page);
  await page.evaluate(() => {
    window.sim.paginationVariant = 'none'; window.renderFixture();
    setTimeout(() => { window.sim.records[0].acceptedText = ''; window.renderFixture(); }, 120);
  });
  assert.equal((await run(page, 'report')).code, 'UNRESOLVED_REPORT_HISTORY');
  const s = await state(page, 'report');
  assert.equal(s.quota.uncertain, 1);
  assert.equal(s.queries.length, 0);
  assert.equal(s.submissions.length, 0);
});
test('恢复后仍无页码且目标2时保留恢复1条，停止而不提交', 'report', async page => {
  await seedUnknown(page);
  await page.evaluate(() => { window.sim.paginationVariant = 'none'; window.renderFixture(); });
  assert.equal((await run(page, 'report', { n: 2 })).code, 'PAGE_UNREADABLE');
  const s = await state(page, 'report');
  assert.equal(s.batch.summary.reported, 1);
  assert.equal(s.quota.confirmed, 1);
  assert.equal(s.quota.uncertain, 0);
  assert.equal(s.submissions.length, 0);
  assert.equal(s.batch.error.details.stage, 'pagination');
});
test('不可见旧未知保存当前页候选身份，不借用旧诊断', 'report', async page => {
  await seedUnknown(page);
  await page.evaluate(() => {
    const journal = window.PDDEvaluationHelper.readReportJournal();
    journal.attempts[0].submissionDiagnostics = { stage: 'old-diagnostic', observedAt: '2026-10-01T00:00:00Z' };
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(journal));
    window.sim.records.shift();
    window.sim.paginationVariant = 'none';
    window.renderFixture();
  });
  assert.equal((await run(page, 'report')).code, 'UNRESOLVED_REPORT_HISTORY');
  const s = await state(page, 'report');
  const d = s.journal.attempts[0].submissionDiagnostics;
  assert.equal(d.stage, 'reconcile');
  assert.equal(d.rowFound, false);
  assert.ok(d.list.visibleRecordCount > 0);
  assert.ok(d.list.identities.some(identity => identity.order === s.records[0].order));
  assert.ok(Date.parse(d.observedAt) >= Date.parse(s.batch.startedAt));
  assert.equal(s.queries.length, 0);
  assert.equal(s.submissions.length, 0);
  assert.equal(s.quota.uncertain, 1);
});

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const selected = process.env.PDD_TEST_CASE ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length);
  let failures = 0;
  try {
    for (const item of selected) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture(item.mode) }) : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
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
  console.log(`PAGINATION RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
