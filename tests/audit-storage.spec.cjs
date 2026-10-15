'use strict';

// 独立审核回归：仅使用合成夹具；所有导航返回本地HTML，其他网络请求全部阻断。
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
const test = (name, mode, fn, before) => cases.push({ name, mode, fn, before });
const reportText = '请平台审核组认真核实本次评价与实际订单信息是否一致，谢谢。';
const invoke = (page, mode, n = 1) => page.evaluate(({ mode, n }) =>
  window.PDDEvaluationHelper[mode === 'report' ? 'startReportBatch' : 'startBatch']({ n })
    .catch(error => ({ code: error.code || error.name, message: error.message })), { mode, n });
const setMode = (page, mode) => page.locator('#pdd-evaluation-helper-panel').locator(`#mode-${mode}`).click();

for (const mode of ['reply', 'report']) {
  const key = mode === 'report' ? 'pdd-evaluation-helper:last-report-batch:v1'
    : 'pdd-evaluation-helper:last-batch:v1';
  test(`${mode}坏JSON旧批次快照不阻止新运行且会替换`, mode, async page => {
    assert.equal((await invoke(page, mode)).ok, true);
    const value = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
    assert.equal(value.phase, 'completed');
    assert.equal(value.version, await page.evaluate(() => window.PDDEvaluationHelper.version));
    assert.equal(await page.evaluate(() => window.sim.submissions.length), 1);
  }, ({ mode, key }) => {
    localStorage.setItem('pdd-evaluation-helper:panel:v1', JSON.stringify({
      schema: 1, mode: 'expanded', x: null, y: null, taskMode: mode,
    }));
    sessionStorage.setItem(key, '{broken');
  });

  test(`${mode}初始busy渲染读取失败不会泄漏运行锁`, mode, async page => {
    await setMode(page, mode);
    await page.evaluate(({ mode, key }) => {
      window.auditOriginalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function (name) {
        const panel = document.querySelector('#pdd-evaluation-helper-panel').shadowRoot;
        const run = panel.querySelector(mode === 'report' ? '#report-run-once' : '#run-once');
        if (this === sessionStorage && name === key && run.disabled) {
          throw new Error('synthetic render read failure');
        }
        return window.auditOriginalGet.call(this, name);
      };
    }, { mode, key });
    await invoke(page, mode);
    await page.evaluate(() => {
      Storage.prototype.getItem = window.auditOriginalGet;
      document.querySelectorAll('[data-testid="beast-core-modal-inner"]').forEach(node => node.remove());
    });
    const next = await invoke(page, mode);
    assert.notEqual(next.code, 'BUSY', '恢复存储后不应永久卡在busy');
    assert.equal(next.ok, true);
    assert.equal(await page.locator('#pdd-evaluation-helper-panel')
      .locator(mode === 'report' ? '#report-run-once' : '#run-once').isDisabled(), false);
  });

  test(`${mode}真正业务台账读取失败仍零提交保护`, mode, async page => {
    await page.evaluate(mode => {
      window.auditOriginalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) {
        if (this === localStorage && key === (mode === 'report'
          ? 'pdd-evaluation-helper:reports:v1' : 'pdd-evaluation-helper:submissions:v1')) {
          throw new Error('synthetic business storage denied');
        }
        return window.auditOriginalGet.call(this, key);
      };
    }, mode);
    assert.equal((await invoke(page, mode)).code, 'STORAGE_UNAVAILABLE');
    assert.equal(await page.evaluate(() => window.sim.submissions.length), 0);
    await page.evaluate(() => { Storage.prototype.getItem = window.auditOriginalGet; });
    assert.equal((await invoke(page, mode)).ok, true);
  });

  test(`${mode}真正业务台账写入失败仍零提交保护`, mode, async page => {
    await page.evaluate(mode => {
      window.auditOriginalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === (mode === 'report'
          ? 'pdd-evaluation-helper:reports:v1' : 'pdd-evaluation-helper:submissions:v1')) {
          throw new DOMException('synthetic business quota', 'QuotaExceededError');
        }
        return window.auditOriginalSet.call(this, key, value);
      };
    }, mode);
    assert.equal((await invoke(page, mode)).code, 'STORAGE_UNAVAILABLE');
    assert.equal(await page.evaluate(() => window.sim.submissions.length), 0);
    await page.evaluate(() => {
      Storage.prototype.setItem = window.auditOriginalSet;
      document.querySelectorAll('[data-testid="beast-core-modal-inner"]').forEach(node => node.remove());
    });
    assert.equal((await invoke(page, mode)).ok, true);
  });

  test(`${mode}提交前快照写失败不产生假的待核验历史`, mode, async page => {
    await page.evaluate(key => {
      window.auditOriginalSet = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (this === sessionStorage && name === key &&
            JSON.parse(value).records.some(record => record.status === 'submitting')) {
          throw new DOMException('synthetic session quota before click', 'QuotaExceededError');
        }
        return window.auditOriginalSet.call(this, name, value);
      };
    }, key);
    const first = await invoke(page, mode);
    assert.equal(first.code, 'STORAGE_UNAVAILABLE');
    assert.equal(await page.evaluate(() => window.sim.submissions.length), 0);
    await page.evaluate(() => {
      Storage.prototype.setItem = window.auditOriginalSet;
      document.querySelectorAll('[data-testid="beast-core-modal-inner"]').forEach(node => node.remove());
    });
    const unresolved = await page.evaluate(mode => {
      const h = window.PDDEvaluationHelper;
      const entries = mode === 'report' ? h.readReportJournal().attempts
        : Object.values(h.readSubmissionJournal().entries);
      return entries.filter(entry => ['submitting', 'submitted_unverified'].includes(entry.status));
    }, mode);
    assert.deepEqual(unresolved, [], '已知尚未点击提交不能留下永久待核验');
    assert.equal((await invoke(page, mode)).ok, true);
    const snapshot = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), key);
    assert.equal(snapshot.records.some(record => record.status === 'skipped_pending_history'), false);
  });
}

test('坏JSON文案可显式保存修复且不修改业务历史', 'report', async page => {
  const result = await page.evaluate(text => {
    const h = window.PDDEvaluationHelper;
    const history = localStorage.getItem('pdd-evaluation-helper:reports:v1');
    localStorage.setItem('pdd-evaluation-helper:templates:v1', '{broken');
    const saved = h.saveTemplate('report', text);
    return { saved, read: h.readTemplates(),
      sameHistory: history === localStorage.getItem('pdd-evaluation-helper:reports:v1') };
  }, reportText);
  assert.equal(result.saved.reportText, reportText);
  assert.equal(result.read.reportText, reportText);
  assert.equal(result.sameHistory, true);
  assert.equal((await invoke(page, 'report')).ok, true);
});

test('坏JSON文案可由面板恢复默认按钮修复', 'report', async page => {
  await page.evaluate(() => localStorage.setItem('pdd-evaluation-helper:templates:v1', '{broken'));
  await setMode(page, 'report');
  const panel = page.locator('#pdd-evaluation-helper-panel');
  await panel.locator('#report-details').evaluate(node => { node.open = true; });
  await panel.locator('#report-copy-reset').click();
  assert.match(await panel.locator('#report-copy-feedback').innerText(), /已恢复默认并保存/);
  assert.ok((await page.evaluate(() => window.PDDEvaluationHelper.readTemplates())).reportText.length >= 20);
  assert.equal((await invoke(page, 'report')).ok, true);
});

test('文案真实读取被拒时保存仍失败且不覆盖原配置', 'report', async page => {
  const result = await page.evaluate(text => {
    const key = 'pdd-evaluation-helper:templates:v1';
    const original = Storage.prototype.getItem;
    const before = localStorage.getItem(key);
    Storage.prototype.getItem = function (name) {
      if (this === localStorage && name === key) throw new Error('synthetic template read denied');
      return original.call(this, name);
    };
    let code;
    try { window.PDDEvaluationHelper.saveTemplate('report', text); } catch (error) { code = error.code; }
    finally { Storage.prototype.getItem = original; }
    return { code, unchanged: localStorage.getItem(key) === before };
  }, reportText);
  assert.deepEqual(result, { code: 'STORAGE_UNAVAILABLE', unchanged: true });
});

test('文案真实写入被拒时不假报成功且原文案保留', 'report', async page => {
  const result = await page.evaluate(text => {
    const key = 'pdd-evaluation-helper:templates:v1';
    const h = window.PDDEvaluationHelper;
    const before = h.readTemplates();
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === localStorage && name === key) throw new Error('synthetic template write denied');
      return original.call(this, name, value);
    };
    let code;
    try { h.saveTemplate('report', text); } catch (error) { code = error.code; }
    finally { Storage.prototype.setItem = original; }
    return { code, before, after: h.readTemplates() };
  }, reportText);
  assert.equal(result.code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(result.before, result.after);
});

for (const invalidHistory of [{}, 'invalid']) {
  test(`举报历史history为${typeof invalidHistory}时前置校验并零提交`, 'report', async page => {
    const result = await page.evaluate(async history => {
      const h = window.PDDEvaluationHelper;
      const rec = window.sim.records[1];
      const entry = { ...rec, id: 'invalid-history',
        key: JSON.stringify([rec.order, rec.goodsId, rec.time]), day: '2026-10-15',
        status: 'submitted_unverified', reason: '同行恶意差评',
        reportText: h.readTemplates().reportText, history };
      localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [entry] }));
      let readCode;
      try { h.readReportJournal(); } catch (error) { readCode = error.code; }
      const start = await h.startReportBatch({ n: 1 })
        .catch(error => ({ code: error.code || error.name, message: error.message }));
      return { readCode, start, submits: window.sim.submissions.length, queries: window.sim.queries.length };
    }, invalidHistory);
    assert.equal(result.readCode, 'INVALID_REPORT_JOURNAL');
    assert.equal(result.start.code, 'INVALID_REPORT_JOURNAL');
    assert.equal(result.submits, 0);
    assert.equal(result.queries, 0);
  });
}

test('缺省history旧举报可人工核验与当前记录恢复，不阻止新提交', 'report', async page => {
  const result = await page.evaluate(async () => {
    const h = window.PDDEvaluationHelper;
    const records = window.sim.records.slice(0, 2);
    window.sim.keepReported = true;
    records[0].reported = true;
    records[0].acceptedText = '已举报，待审核';
    window.renderFixture();
    const entries = records.map((rec, index) => ({ ...rec, id: `legacy-no-history-${index}`,
      key: JSON.stringify([rec.order, rec.goodsId, rec.time]), day: '2026-10-15',
      status: 'submitted_unverified', reason: '同行恶意差评',
      reportText: h.readTemplates().reportText }));
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: entries }));
    const before = h.readReportJournal();
    const resolved = await h.resolveReportSubmission(entries[1].id,
      'not_submitted_user_verified', '合成核验：该条尚未提交');
    const start = await h.startReportBatch({ n: 1 });
    return { beforeCount: before.attempts.length, resolved, reported: start.reported,
      stats: h.readReportStats(), journal: h.readReportJournal(), submissions: window.sim.submissions };
  });
  assert.equal(result.beforeCount, 2);
  assert.equal(result.resolved.status, 'not_submitted_user_verified');
  assert.ok(Array.isArray(result.resolved.history));
  assert.equal(result.reported, 1);
  assert.deepEqual(result.stats, { confirmed: 2, uncertain: 0 });
  assert.equal(result.journal.attempts[0].status, 'confirmed');
  assert.ok(Array.isArray(result.journal.attempts[0].history));
  assert.equal(result.submissions.length, 1);
  assert.equal(result.submissions[0].order, result.journal.attempts[1].order);
});

async function main() {
  const selected = process.env.PDD_TEST_CASE ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length, 'No matching audit cases');
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  let failed = 0;
  try {
    for (const item of selected) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      const fixture = fs.readFileSync(path.join(root, 'tests',
        `${item.mode === 'report' ? 'report' : 'batch'}-fixture.html`), 'utf8');
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
        if (item.before) {
          await page.evaluate(item.before, { mode: item.mode,
            key: item.mode === 'report' ? 'pdd-evaluation-helper:last-report-batch:v1'
              : 'pdd-evaluation-helper:last-batch:v1' });
        }
        await page.addScriptTag({ content: source });
        await item.fn(page, context);
        assert.deepEqual(errors, [], '面板及生命周期不应泄漏未捕获异常');
        console.log(`PASS ${item.name}`);
      } catch (error) {
        failed++;
        console.error(`FAIL ${item.name}\n${error.stack}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`AUDIT STORAGE RESULT ${selected.length - failed}/${selected.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
