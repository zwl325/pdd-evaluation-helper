'use strict';

// 全部为合成记录，导航和资源请求均拦截，不访问真实后台。
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
const test = (name, mode, fn) => cases.push({ name, mode, fn });
const panel = page => page.locator('#pdd-evaluation-helper-panel');
const state = page => page.evaluate(() => ({
  ...window.sim, batch: window.PDDEvaluationHelper.readReportBatch(),
  stats: window.PDDEvaluationHelper.readReportStats(),
  journal: window.PDDEvaluationHelper.readReportJournal(),
}));
const run = (page, options = { n: 2 }, special = false) => page.evaluate(({ options, special }) =>
  window.PDDEvaluationHelper[special ? 'startOneStarReportBatch' : 'startReportBatch'](options)
    .catch(error => ({ code: error.code, message: error.message })), { options, special });
const reportCopy = '平台审核组：\n请核实本次评价与实际订单情况，相关事实和凭证以订单记录为准，谢谢。';
const replyCopy = '感谢您的支持！\n我们会继续认真做好服务，欢迎再次光临。';

test('普通目标4按1→2→3累计成功，跳过不计数量', 'report', async page => {
  const result = await run(page, { n: 4 });
  assert.equal(result.reported, 4);
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1, 2, 3]);
  assert.deepEqual(s.submissions.map(q => q.star), [1, 2, 2, 3]);
  assert.equal(s.batch.stopReason, 'target_reached');
  assert.deepEqual(Object.keys(s.stats).sort(), ['confirmed', 'uncertain']);
});
test('数量不足时正常完成并显示已全部处理', 'report', async page => {
  assert.equal((await run(page, { n: 20 })).reported, 5);
  assert.equal((await state(page)).batch.stopReason, 'stars_exhausted');
  assert.match(await panel(page).locator('#report-status').innerText(), /已全部处理，暂无需要处理/);
});
test('全部已举报时不新增且显示无需处理', 'report', async page => {
  await page.evaluate(() => {
    window.sim.keepReported = true;
    window.sim.records.forEach(rec => { rec.reported = true; });
    window.renderFixture();
  });
  assert.equal((await run(page)).reported, 0);
  const s = await state(page);
  assert.equal(s.submissions.length, 0);
  assert.deepEqual(s.queries.map(q => q.star), [1, 2, 3]);
  assert.match(await panel(page).locator('#report-inspection').innerText(), /已全部处理，暂无需要处理/);
});
test('数量留空遍历三个星级而无每日额度字段', 'report', async page => {
  assert.equal((await run(page, {})).reported, 5);
  assert.equal((await state(page)).batch.target, null);
  assert.doesNotMatch(await panel(page).locator('#report-inspection').innerText(), /今日|剩余额度|30条/);
});
test('特殊按钮正文不限目标2且不进入2星', 'report', async page => {
  assert.equal((await run(page, { n: 2 }, true)).reported, 2);
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1]);
  assert.equal(s.submissions[0].order, s.records[0].order);
  assert.ok(s.batch.records.every(rec => rec.star === 1));
  assert.equal(s.journal.attempts[0].content, '商品质量有问题');
  assert.equal(s.journal.attempts[0].strategy, 'one-star-all');
});
test('特殊按钮留空只处理全部1星，包含普通正文及尾部空白', 'report', async page => {
  assert.equal((await run(page, {}, true)).reported, 3);
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1]);
  assert.equal(s.batch.stopReason, 'stars_exhausted');
  assert.ok(s.submissions.every(rec => rec.star === 1));
});
test('特殊按钮数量超过1星总数时结束而不补2星', 'report', async page => {
  assert.equal((await run(page, { n: 20 }, true)).reported, 3);
  assert.deepEqual((await state(page)).queries.map(q => q.star), [1]);
  assert.match(await panel(page).locator('#report-status').innerText(), /1星结果已全部处理/);
});
test('特殊按钮沿用指定商品并跨页遍历1星', 'report', async page => {
  await page.evaluate(() => { window.sim.pageSize = 1; window.sim.keepReported = true; });
  const result = await run(page, { n: 2, goodsId: '8002' }, true);
  assert.equal(result.reported, 2);
  const s = await state(page);
  assert.ok(s.batch.records.every(rec => rec.goodsId === '8002'));
  assert.ok(s.visits.some(visit => visit.page === 2));
  assert.deepEqual(s.queries.map(q => q.star), [1]);
});
test('普通已举报历史在特殊模式中仍跳过，不重复提交', 'report', async page => {
  await run(page, { n: 1 });
  const result = await run(page, {}, true);
  assert.equal(result.reported, 2);
  assert.equal((await state(page)).submissions.length, 3);
});
test('特殊模式有文字评价取得记录级受理证据', 'report', async page => {
  await page.evaluate(() => { window.sim.acceptanceScenario = 'header'; });
  assert.equal((await run(page, { n: 1 }, true)).reported, 1);
  const s = await state(page);
  assert.equal(s.journal.attempts[0].evidence, 'record_report_accepted');
  assert.equal(s.journal.attempts[0].content, '商品质量有问题');
});
test('特殊模式仍核验弹框全文不符时零提交', 'report', async page => {
  await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=modal-content');
  await page.addScriptTag({ content: source });
  assert.equal((await run(page, { n: 1 }, true)).code, 'REPORT_MODAL_CONTENT_MISMATCH');
  assert.equal((await state(page)).submissions.length, 0);
});
test('特殊模式待核验有文字评价恢复时保留原文且不重发', 'report', async page => {
  await page.evaluate(() => { window.sim.acceptanceScenario = 'header'; });
  await run(page, { n: 1 }, true);
  await page.evaluate(() => {
    const data = window.PDDEvaluationHelper.readReportJournal();
    data.attempts[0].status = 'submitted_unverified';
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify(data));
    window.sim.filterStar = 4;
    window.renderFixture();
  });
  await page.evaluate(text => window.PDDEvaluationHelper.saveTemplate('report', text), reportCopy);
  assert.equal((await run(page, { n: 1 }, true)).reported, 1);
  const s = await state(page);
  assert.equal(s.submissions.length, 1);
  assert.equal(s.batch.records[0].recovered, true);
  assert.equal(s.stats.uncertain, 0);
  assert.notEqual(s.journal.attempts[0].reportText, reportCopy, '旧尝试保留实际旧文案，编辑文案不阻止核验');
});
test('特殊模式遇到其他星级未知历史时不越界查询2星或新增', 'report', async page => {
  await page.evaluate(() => {
    const h = window.PDDEvaluationHelper;
    const rec = window.sim.records.find(rec => rec.star === 2);
    const day = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
    localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts: [{
      ...rec, key: JSON.stringify([rec.order, rec.goodsId, rec.time]), id: 'other-star-unknown',
      day, status: 'submitted_unverified', reportText: h.readTemplates().reportText, history: [],
    }] }));
  });
  assert.equal((await run(page, { n: 1 }, true)).code, 'UNRESOLVED_REPORT_HISTORY');
  const s = await state(page);
  assert.deepEqual(s.queries.map(q => q.star), [1]);
  assert.equal(s.submissions.length, 0);
});
for (const kind of ['reply', 'report']) {
  test(`${kind}编辑保存后完整提交并记入台账`, kind, async page => {
    const p = panel(page);
    if (kind === 'report') await p.locator('#mode-report').click();
    await p.locator(`#${kind}-details`).evaluate(el => { el.open = true; });
    const copy = kind === 'reply' ? replyCopy : reportCopy;
    await p.locator(`#${kind}-copy`).fill(copy);
    await p.locator(`#${kind}-copy-save`).click();
    assert.match(await p.locator(`#${kind}-copy-feedback`).innerText(), /已保存/);
    const s = await page.evaluate(async kind => {
      const h = window.PDDEvaluationHelper;
      const result = await h[kind === 'reply' ? 'startBatch' : 'startReportBatch']({ n: 1 });
      const journal = kind === 'reply' ? h.readSubmissionJournal() : h.readReportJournal();
      return { result, journal, submission: window.sim.submissions[0] };
    }, kind);
    assert.equal(s.result.ok, true);
    assert.equal(s.submission.value, copy);
    const entry = kind === 'reply' ? Object.values(s.journal.entries)[0] : s.journal.attempts[0];
    assert.equal(entry[`${kind}Text`], copy);
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal(await p.locator(`#${kind}-copy`).inputValue(), copy);
  });
  test(`${kind}未保存草稿不改变实际文案，恢复默认可保存`, kind, async page => {
    const p = panel(page);
    if (kind === 'report') await p.locator('#mode-report').click();
    const before = await page.evaluate(kind => window.PDDEvaluationHelper.readTemplates()[`${kind}Text`], kind);
    await p.locator(`#${kind}-details`).evaluate(el => { el.open = true; });
    await p.locator(`#${kind}-copy`).fill(kind === 'reply' ? replyCopy : reportCopy);
    await page.evaluate(kind => window.PDDEvaluationHelper[kind === 'reply'
      ? 'startBatch' : 'startReportBatch']({ n: 1 }), kind);
    assert.equal(await page.evaluate(() => window.sim.submissions[0].value), before);
    await p.locator(`#${kind}-copy-save`).click();
    await p.locator(`#${kind}-copy-reset`).click();
    assert.equal(await p.locator(`#${kind}-copy`).inputValue(), before);
    assert.equal(await page.evaluate(kind => window.PDDEvaluationHelper.readTemplates()[`${kind}Text`], kind), before);
  });
  test(`${kind}非法文案不能保存且原配置保持`, kind, async page => {
    const invalid = kind === 'reply' ? ['', ' \n', '字'.repeat(201)] : ['', '短文', '字'.repeat(501)];
    const results = await page.evaluate(({ kind, invalid }) => {
      const h = window.PDDEvaluationHelper;
      const before = h.readTemplates();
      const codes = invalid.map(text => {
        try { h.saveTemplate(kind, text); return ''; } catch (e) { return e.code; }
      });
      return { before, after: h.readTemplates(), codes };
    }, { kind, invalid });
    assert.deepEqual(results.before, results.after);
    assert.deepEqual(results.codes, invalid.map(() => 'INVALID_TEMPLATE'));
  });
  test(`${kind}运行期间文案编辑和保存禁用，跨页使用启动快照`, kind, async page => {
    const expected = kind === 'reply' ? replyCopy : reportCopy;
    await page.evaluate(({ kind, expected }) => {
      const h = window.PDDEvaluationHelper;
      h.saveTemplate(kind, expected);
      document.querySelector('#query').addEventListener('click', () => {
        const changed = { schema: 1, ...h.readTemplates(), [`${kind}Text`]: '外部新文案'.repeat(8) };
        localStorage.setItem('pdd-evaluation-helper:templates:v1', JSON.stringify(changed));
      });
      window.templatePending = h[kind === 'reply' ? 'startBatch' : 'startReportBatch']({ n: 2 });
    }, { kind, expected });
    await page.waitForFunction(() => window.sim.queries === 1 || window.sim.queries.length === 1);
    assert.equal(await panel(page).locator(`#${kind}-copy`).isDisabled(), true);
    assert.equal(await panel(page).locator(`#${kind}-copy-save`).isDisabled(), true);
    assert.equal(await page.evaluate(kind => {
      try { window.PDDEvaluationHelper.saveTemplate(kind, '新文案'.repeat(20)); }
      catch (e) { return e.code; }
    }, kind), 'BUSY');
    assert.equal((await page.evaluate(() => window.templatePending)).ok, true);
    const submissions = await page.evaluate(() => window.sim.submissions);
    assert.ok(submissions.length > 0);
    assert.ok(submissions.every(rec => rec.value === expected));
  });
}
test('特殊按钮从其他后台页导航时保留数量策略与文案快照', 'report', async page => {
  await page.goto('https://mms.pinduoduo.com/home/');
  await page.addScriptTag({ content: source });
  await page.evaluate(text => window.PDDEvaluationHelper.saveTemplate('report', text), reportCopy);
  await page.addInitScript({ content: `document.addEventListener('DOMContentLoaded', () => {
    const changed = { schema: 1, replyText: ${JSON.stringify(replyCopy)}, reportText: '跳转后另存文案'.repeat(8) };
    localStorage.setItem('pdd-evaluation-helper:templates:v1', JSON.stringify(changed));
    ${source}
  }, { once: true });` });
  await panel(page).locator('#mode-report').click();
  await panel(page).locator('#report-n').fill('2');
  await panel(page).locator('#report-one-star').click();
  await page.waitForFunction(() => window.PDDEvaluationHelper?.readReportBatch()?.phase === 'completed');
  const s = await state(page);
  assert.equal(s.batch.summary.reported, 2);
  assert.equal(s.batch.strategy, 'one-star-all');
  assert.ok(s.submissions.every(rec => rec.value === reportCopy && rec.star === 1));
  assert.equal(await page.evaluate(() => sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
});
test('普通按钮和特殊按钮分别启动各自策略，未实现悬停提示', 'report', async page => {
  const p = panel(page);
  await p.locator('#mode-report').click();
  await p.locator('#report-n').fill('1');
  assert.equal(await p.locator('#report-run-once').getAttribute('title'), null);
  await p.locator('#report-one-star').click();
  await page.waitForFunction(() => window.PDDEvaluationHelper.readReportBatch()?.phase === 'completed');
  assert.equal((await state(page)).batch.strategy, 'one-star-all');
  await p.locator('#report-run-once').click();
  await page.waitForFunction(() => {
    const b = window.PDDEvaluationHelper.readReportBatch();
    return b?.phase === 'completed' && b.strategy === 'template';
  });
  assert.equal((await state(page)).batch.strategy, 'template');
});
test('损坏的文案配置可以显式保存修复，存储失败不假报成功', 'report', async page => {
  await page.evaluate(() => {
    localStorage.setItem('pdd-evaluation-helper:templates:v1', '{"schema":999}');
  });
  assert.equal((await run(page)).code, 'INVALID_TEMPLATE');
  await page.evaluate(text => window.PDDEvaluationHelper.saveTemplate('report', text), reportCopy);
  assert.equal(await page.evaluate(() => window.PDDEvaluationHelper.readTemplates().reportText), reportCopy);
  const error = await page.evaluate(() => {
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.includes(':templates:')) throw new Error('synthetic storage blocked');
      return originalSet.call(this, key, value);
    };
    try { window.PDDEvaluationHelper.saveTemplate('report', '另一份合法文案'.repeat(6)); }
    catch (e) { return e.code; }
  });
  assert.equal(error, 'STORAGE_UNAVAILABLE');
});

async function main() {
  const selected = process.env.PDD_TEST_CASE ? cases.filter(c => c.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selected.length);
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  let failures = 0;
  try {
    for (const item of selected) {
      const fixture = fs.readFileSync(path.join(__dirname,
        `${item.mode === 'report' ? 'report' : 'batch'}-fixture.html`), 'utf8');
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
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
  console.log(`COUNTER/TEMPLATES RESULT ${selected.length - failures}/${selected.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
