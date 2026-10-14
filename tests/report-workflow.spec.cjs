'use strict';

// 所有订单、商品、评价均为合成数据。拦截全部网络，不连接真实PDD或提交真实举报。
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
const expectedText = '平台审核组：\n近期店铺出现多个异常评价，经数据核查，存在以下可疑特征：\n\n1. 账号共性：头像简单或使用随机数字 ID。\n2. 行为异常：均直接购买，平均停留不足5分钟。\n3. 评价异常：差评均反映商品质量差。\n4. 物流正常：每24小时有物流更新，仍投诉物流慢。\n5. 关联特征：每逢大促集中出现中差评，请明察，还店铺清白。\n6. 我愿意退换货，但该同行拒绝，并以差评要挟，谋取不正当利益，影响公平竞争，请严查！';
const template = '该用户未填写文字评价';
const evaluationUrl = 'https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav';
const run = (page, options = {}) => page.evaluate(options =>
  window.PDDEvaluationHelper.startReportBatch(options).catch(error =>
    ({ ok: false, code: error.code, message: error.message })), options);
const state = page => page.evaluate(() => ({
  ...window.sim, batch: window.PDDEvaluationHelper.readReportBatch(),
  journal: window.PDDEvaluationHelper.readReportJournal(), quota: window.PDDEvaluationHelper.readReportQuota(),
}));
const seed = (page, count, status = 'confirmed', day = null) => page.evaluate(({ count, status, day }) => {
  const date = day || window.PDDEvaluationHelper.readReportQuota().day;
  const attempts = Array.from({ length: count }, (_, i) => {
    const rec = { order: `880099-${String(i + 1).padStart(9, '0')}`, goodsId: '8099', time: '2026-10-01 00:00:00' };
    return { ...rec, id: `seed-${i}`, key: JSON.stringify([rec.order, rec.goodsId, rec.time]),
      day: date, status, star: 1, history: [] };
  });
  localStorage.setItem('pdd-evaluation-helper:reports:v1', JSON.stringify({ schema: 1, attempts }));
}, { count, status, day });
const panel = page => page.locator('#pdd-evaluation-helper-panel');
async function injectOnNavigation(page) {
  await page.addInitScript({ content:
    `document.addEventListener('DOMContentLoaded', () => {\n${source}\n}, { once: true });` });
}
async function mockDate(page, date) {
  await page.evaluate(date => {
    const RealDate = window.Date;
    window.testDateOffset = new RealDate(date).getTime() - RealDate.now();
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [RealDate.now() + window.testDateOffset])); }
      static now() { return RealDate.now() + window.testDateOffset; }
    };
  }, date);
}

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const cases = [];
  const test = (name, mode, fn) => cases.push({ name, mode, fn });
  let failures = 0;

  test('安装零动作；切换模式保留各自参数与完整工具', 'normal', async page => {
    const p = panel(page);
    await p.locator('#batch-n').fill('5');
    await p.locator('#batch-goods').fill('8002');
    await p.locator('#mode-report').click();
    assert.equal(await p.locator('#body').isVisible(), false);
    assert.equal(await p.locator('#report-body').isVisible(), true);
    assert.equal(await p.locator('#report-body button').count(), 4);
    assert.match(await p.locator('label[for="report-n"]').innerText(), /举报数量.*成功数量/);
    assert.equal(await p.locator('#report-run-once').innerText(), '一键运行');
    assert.equal(await p.locator('#report-stop').innerText(), '急停');
    assert.equal(await p.locator('#report-refresh').innerText(), '检查状态');
    assert.equal(await p.locator('#report-export-batch').innerText(), '导出本机台账');
    await p.locator('#report-n').fill('2');
    await p.locator('#report-goods').fill('8001');
    await p.locator('#report-details summary').click();
    assert.equal(await p.locator('#report-copy').innerText(), expectedText);
    await p.locator('#mode-reply').click();
    assert.equal(await p.locator('#batch-n').inputValue(), '5');
    assert.equal(await p.locator('#batch-goods').inputValue(), '8002');
    await p.locator('#mode-report').click();
    assert.equal(await p.locator('#report-n').inputValue(), '2');
    assert.equal(await p.locator('#report-goods').inputValue(), '8001');
    assert.equal(await p.locator('#report-details').getAttribute('open'), '');
    await p.locator('#report-refresh').click();
    assert.match(await p.locator('#report-inspection').innerText(), /今日成功举报0条/);
    const s = await state(page);
    assert.deepEqual([s.queries.length, s.opens.length, s.submissions.length, s.filterClicks.length], [0, 0, 0, 0]);
  });
  test('目标2为成功数量；跳过继续找；1星处理完才到2星', 'normal', async page => {
    const result = await run(page, { n: 2 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.reported, result.skipped], [4, 2, 2]);
    const s = await state(page);
    assert.deepEqual(s.submissions.map(rec => rec.order), ['880000-000000002', '880000-000000004']);
    assert.deepEqual(s.queries.map(q => q.star), [1, 2]);
    assert.equal(s.queries[1].submitted, 1);
    assert.equal(s.batch.stopReason, 'target_reached');
    assert.ok(s.submissions.every(rec => rec.value === expectedText && rec.receivedInput === expectedText &&
      rec.receivedChange === expectedText && rec.reason === 'true' && rec.reasonType === 'reason_type=8'));
    assert.deepEqual(s.goodsEvents, ['']);
    assert.ok(s.queries.every(q => !q.selected.includes('未回复') && !q.selected.includes('4星') && !q.selected.includes('5星')));
  });
  test('留空遍历1至3星；3星处理完停止；检查8成功5跳过3', 'normal', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.reported, result.skipped], [8, 5, 3]);
    const s = await state(page);
    assert.deepEqual(s.queries.map(q => q.star), [1, 2, 3]);
    assert.deepEqual(s.submissions.map(q => q.star), [1, 2, 2, 3, 3]);
    assert.equal(s.batch.stopReason, 'stars_exhausted');
  });
  test('目标1立即停在1星，不查询后续星级', 'normal', async page => {
    const result = await run(page, { n: 1 });
    assert.deepEqual([result.checked, result.reported, result.skipped], [2, 1, 1]);
    assert.deepEqual((await state(page)).queries.map(q => q.star), [1]);
  });
  test('40条符合记录每日只成功30条；不进入2星', 'large', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    const s = await state(page);
    assert.equal(result.reported, 30);
    assert.equal(s.submissions.length, 30);
    assert.equal(s.quota.remaining, 0);
    assert.equal(s.batch.stopReason, 'daily_limit');
    assert.deepEqual(s.queries.map(q => q.star), [1]);
  });
  test('今日已有29条，只再成功1条；目标自动限制为剩余额度', 'normal', async page => {
    await seed(page, 29);
    const result = await run(page, { n: 10 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.batch.target, 1);
    assert.equal(result.reported, 1);
    assert.equal(result.quota.confirmed, 30);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('今日已有30条零查询零提交；刷新不重置额度', 'normal', async page => {
    await seed(page, 30);
    assert.equal((await run(page)).reported, 0);
    assert.equal((await state(page)).queries.length, 0);
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal((await run(page, { n: 1 })).reported, 0);
    assert.equal((await state(page)).queries.length, 0);
    assert.equal((await state(page)).quota.confirmed, 30);
  });
  test('同浏览器跨店铺备注不重置每日额度', 'normal', async page => {
    await seed(page, 29);
    await page.evaluate(() => { document.body.firstElementChild.textContent = '其他测试店铺'; });
    assert.equal((await run(page, { n: 2 })).reported, 1);
    assert.equal((await state(page)).quota.confirmed, 30);
  });
  test('跨批与刷新成功累计；确认历史去重不占本次目标', 'keep', async page => {
    assert.equal((await run(page, { n: 1 })).reported, 1);
    assert.equal((await run(page, { n: 1 })).reported, 1);
    assert.equal((await state(page)).quota.confirmed, 2);
    await page.reload(); // 服务器夹具重置reported；本机journal仍去重。
    await page.addScriptTag({ content: source });
    const result = await run(page, { n: 1 });
    assert.equal(result.reported, 1);
    const s = await state(page);
    assert.equal(s.quota.confirmed, 3);
    assert.equal(s.submissions[0].order, '880000-000000005');
    assert.equal(result.batch.records.filter(rec => rec.status === 'skipped_previously_reported').length, 2);
  });
  test('北京时间午夜日切换释放前日确认额度', 'normal', async page => {
    await mockDate(page, '2026-10-14T15:59:00Z');
    await seed(page, 30);
    assert.equal((await state(page)).quota.day, '2026-10-14');
    assert.equal((await state(page)).quota.remaining, 0);
    await page.evaluate(() => { window.testDateOffset += 120000; });
    assert.equal((await state(page)).quota.day, '2026-10-15');
    assert.equal((await state(page)).quota.remaining, 30);
    assert.equal((await run(page, { n: 1 })).reported, 1);
  });
  test('运行中跨北京时间日期停止，不继续提交', 'slow-query', async page => {
    await mockDate(page, '2026-10-14T15:59:00Z');
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startReportBatch({ n: 1 }).catch(e => ({ code: e.code }));
    });
    await page.waitForFunction(() => window.sim.queries.length === 1);
    await page.evaluate(() => { window.testDateOffset += 120000; });
    assert.equal((await page.evaluate(() => window.pending)).code, 'REPORT_DAY_CHANGED');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('空结果仍按1至3星依次查询，零举报', 'empty', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.reported, 0);
    assert.deepEqual((await state(page)).queries.map(q => q.star), [1, 2, 3]);
  });
  test('正文仅全文等于模板；空白换行附加文字均跳过', 'normal', async page => {
    await page.evaluate(template => {
      const variants = [template + ' ', template + '\n', ' ' + template, template + '。',
        template + '补充', '前缀' + template, '该用户觉得商品很好', '差评'];
      window.sim.records.forEach((rec, i) => { rec.content = variants[i]; });
      window.renderFixture();
    }, template);
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.reported, result.skipped], [8, 0, 8]);
    assert.equal((await state(page)).opens.length, 0);
  });
  test('指定商品ID只查询对应记录', 'normal', async page => {
    const result = await run(page, { n: 2, goodsId: '8001' });
    assert.equal(result.ok, true, result.message);
    assert.ok(result.batch.records.every(rec => rec.goodsId === '8001'));
    assert.equal(result.reported, 2);
  });
  test('已举报页面状态跳过，不算本次成功，继续后面的记录', 'keep', async page => {
    await page.evaluate(() => { window.sim.records[1].reported = true; window.renderFixture(); });
    const result = await run(page, { n: 1 });
    assert.equal(result.reported, 1);
    assert.equal(result.batch.records[1].status, 'skipped_already_reported');
    assert.equal(result.quota.confirmed, 1);
    assert.equal((await state(page)).submissions[0].star, 2);
  });
  test('举报后保留列表与自动翻页去重，所有记录仅检查一次', 'keep', async page => {
    const result = await run(page);
    assert.equal(result.reported, 5);
    assert.equal(new Set(result.batch.records.map(rec => rec.key)).size, 8);
    assert.equal(new Set((await state(page)).submissions.map(rec => rec.order)).size, 5);
  });
  test('查询翻页卸载表格仍等待重绘', 'unmount', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.reported], [8, 5]);
  });
  test('跨页后成功删除记录，返回前页防止漏查', 'normal', async page => {
    await page.evaluate(template => {
      window.sim.records.slice(0, 3).forEach((rec, i) => { rec.content = i === 2 ? template : '不符合'; });
      window.sim.records.push({ ...window.sim.records[2], order: '880000-000000009', content: template });
      window.renderFixture();
    }, template);
    const result = await run(page, { n: 2 });
    assert.equal(result.reported, 2);
    assert.ok((await state(page)).visits.some(visit => visit.star === 1 && visit.page === 1 && visit.submitted === 1));
    assert.deepEqual((await state(page)).submissions.map(rec => rec.order), ['880000-000000003', '880000-000000009']);
  });

  for (const [mode, code] of [
    ['wrong-star', 'REPORT_STAR_MISMATCH'], ['wrong-modal', 'UNEXPECTED_REPORT_MODAL'],
    ['modal-star', 'REPORT_MODAL_STAR_MISMATCH'], ['modal-content', 'REPORT_MODAL_CONTENT_MISMATCH'],
    ['content-change', 'REPORT_MODAL_CONTENT_MISMATCH'], ['identity-change', 'REPORT_RECORD_CHANGED'],
    ['filter-change', 'FILTER_CHANGED'], ['missing-reason', 'REPORT_REASON_UNAVAILABLE'],
    ['duplicate-reason', 'REPORT_REASON_UNAVAILABLE'], ['existing-text', 'EXISTING_REPORT_TEXT'],
    ['short-max', 'REPORT_TOO_LONG'], ['wrong-reason-id', 'TIMEOUT'], ['text-rejected', 'TIMEOUT'],
    ['disabled-submit', 'TIMEOUT'], ['residual', 'RESIDUAL_FILTER'],
    ['goods-rejected', 'TIMEOUT'], ['query-noop', 'TIMEOUT'],
  ]) test(`${mode}停止且零提交`, mode, async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.code, code, result.message);
    assert.equal((await state(page)).submissions.length, 0);
    assert.equal((await state(page)).quota.used, 0);
  });
  test('固定5个SVG仅部分高亮，正确处理1至3星且不把灰星计入评分', 'normal', async page => {
    const result = await run(page, { n: 4 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.reported, 4);
    assert.deepEqual((await state(page)).submissions.map(rec => rec.star), [1, 2, 2, 3]);
    for (const rec of result.batch.records.filter(rec => rec.status === 'confirmed')) {
      assert.equal(rec.reportDiagnostics.expectedStar, rec.star);
      assert.equal(rec.reportDiagnostics.actualStar, rec.star);
      assert.equal(rec.reportDiagnostics.rating.svgCount, 5);
      assert.equal(rec.reportDiagnostics.rating.source, 'painted_stars');
    }
  });
  for (const [mode, expectedSource, svgCount] of [
    ['rating-aria', 'aria-valuenow', 5], ['rating-data', 'data-score', 5],
    ['rating-classes', 'full_star_classes', 5], ['rating-layers', 'full_star_classes', 10],
    ['rating-hidden', 'painted_stars', 10], ['table-colored', 'painted_stars', 5],
  ]) test(`${mode}评分结构正确识别并只提交一次`, mode, async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.reported, 1);
    const rec = result.batch.records.find(rec => rec.status === 'confirmed');
    assert.equal(rec.reportDiagnostics.actualStar, 1);
    assert.equal(rec.reportDiagnostics.rating.source, expectedSource);
    assert.equal(rec.reportDiagnostics.rating.svgCount, svgCount);
    assert.equal((await state(page)).submissions.length, 1);
  });
  for (const mode of ['modal-delayed', 'modal-unstable', 'reason-delayed-rating']) {
    test(`${mode}等待正文与评分稳定，加载中不选原因不填文不提交`, mode, async page => {
      const result = await run(page, { n: 1 });
      assert.equal(result.ok, true, result.message);
      const s = await state(page);
      assert.equal(s.submissions.length, 1);
      assert.deepEqual(s.earlyActions, []);
      assert.equal(s.batch.records.find(rec => rec.status === 'confirmed').reportDiagnostics.actualContent, template);
    });
  }
  for (const [mode, issue] of [
    ['rating-unknown', 'score_unreadable'], ['rating-zero', 'score_not_ready'],
    ['rating-invalid', 'invalid_declared_score'], ['rating-conflict', 'conflicting_score_evidence'],
    ['rating-half', 'partial_star'],
  ]) test(`${mode}评分无法确认则停止，错误保存实际图标和阶段`, mode, async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.code, 'REPORT_MODAL_STAR_UNREADABLE', result.message);
    const s = await state(page);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.quota.used, 0);
    const details = s.batch.error.details;
    assert.equal(details.stage, 'opened');
    assert.equal(details.expectedStar, 1);
    assert.equal(details.actualStar, null);
    assert.equal(details.expectedContent, template);
    assert.equal(details.actualContent, template);
    assert.equal(details.rating.issue, issue);
    assert.ok(details.rating.svgCount >= 5);
    assert.equal(s.batch.records[1].reportDiagnostics.rating.issue, issue);
  });
  test('弹框真实5星不伪装成1星；保存预期和实际评分', 'modal-star', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.code, 'REPORT_MODAL_STAR_MISMATCH');
    const s = await state(page);
    assert.deepEqual([s.batch.error.details.expectedStar, s.batch.error.details.actualStar], [1, 5]);
    assert.equal(s.batch.error.details.rating.svgCount, 5);
    assert.equal(s.submissions.length, 0);
  });
  test('填写后正文变化仍停止；诊断记录最新阶段及未归一化原文', 'late-modal-content', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.code, 'REPORT_MODAL_CONTENT_MISMATCH');
    const s = await state(page);
    assert.equal(s.batch.error.details.stage, 'text_filled');
    assert.equal(s.batch.error.details.expectedContent, template);
    assert.equal(s.batch.error.details.actualContent, '原文发生变化');
    assert.equal(s.submissions.length, 0);
    assert.equal(s.journal.attempts.length, 0);
  });
  test('弹框正文尾部换行不放宽匹配；导出台账包含完整错误诊断', 'modal-content', async page => {
    await page.evaluate(template => {
      const observer = new MutationObserver(() => {
        const detail = document.querySelector('.comment-content .detail');
        if (detail && detail.textContent !== template + '\n') detail.textContent = template + '\n';
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }, template);
    assert.equal((await run(page, { n: 1 })).code, 'REPORT_MODAL_CONTENT_MISMATCH');
    const [download] = await Promise.all([page.waitForEvent('download'), panel(page).locator('#report-export-batch').click()]);
    const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(exported.batch.error.details.actualContent, template + '\n');
    assert.equal(exported.batch.error.details.expectedContent, template);
    assert.equal(exported.batch.error.details.actualStar, 1);
    assert.equal(exported.batch.records[1].reportDiagnostics.actualContent, template + '\n');
    assert.equal(exported.journal.attempts.length, 0);
  });
  for (const mode of ['duplicate-detail', 'duplicate-rating']) {
    test(`${mode}歧义弹框停止而不挑选第一个目标`, mode, async page => {
      assert.equal((await run(page, { n: 1 })).code, 'DOM_NOT_UNIQUE');
      assert.equal((await state(page)).submissions.length, 0);
    });
  }
  test('等待弹框加载时急停即时结束；保留最后诊断且无提交', 'modal-delayed', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startReportBatch({ n: 1 }).catch(e => ({ code: e.code }));
    });
    await page.waitForFunction(() => Boolean(document.querySelector('.comment-content .detail')));
    await panel(page).locator('#report-stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    const s = await state(page);
    assert.equal(s.batch.error.details.stage, 'opened');
    assert.equal(s.submissions.length, 0);
    assert.equal(s.quota.used, 0);
  });
  test('无成功提示关闭弹框仍未知；不计成功且占额度；后续批阻止重发', 'unknown', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.code, 'REPORT_SUBMITTED_UNVERIFIED');
    let s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.summary.reported, 0);
    assert.equal(s.journal.attempts[0].status, 'submitted_unverified');
    assert.deepEqual([s.quota.confirmed, s.quota.uncertain, s.quota.remaining], [0, 1, 29]);
    assert.equal((await run(page)).code, 'UNRESOLVED_REPORT_HISTORY');
    s = await state(page);
    assert.equal(s.submissions.length, 1);
  });
  test('旧成功提示不算本次成功', 'stale-toast', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'REPORT_SUBMITTED_UNVERIFIED');
    assert.equal((await state(page)).quota.confirmed, 0);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('前日未知提交仍需核验，不能自动在新日重发', 'normal', async page => {
    await seed(page, 1, 'submitted_unverified', '2026-10-01');
    assert.equal((await run(page)).code, 'UNRESOLVED_REPORT_HISTORY');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('人工确认成功增加日成功数并保留核验历史', 'unknown', async page => {
    await run(page, { n: 1 });
    const s = await state(page);
    const entry = await page.evaluate(id =>
      window.PDDEvaluationHelper.resolveReportSubmission(id, 'confirmed', '平台已接收，人工核验'), s.journal.attempts[0].id);
    assert.equal(entry.status, 'confirmed');
    assert.equal(entry.history.length, 2);
    assert.equal((await state(page)).quota.confirmed, 1);
    assert.equal((await state(page)).quota.uncertain, 0);
  });
  test('人工确认未提交释放额度，重新提交使用新attempt并保留旧依据', 'unknown', async page => {
    await run(page, { n: 1 });
    const s = await state(page);
    await page.evaluate(id => window.PDDEvaluationHelper.resolveReportSubmission(
      id, 'not_submitted_user_verified', '平台记录核实未提交'), s.journal.attempts[0].id);
    assert.equal((await state(page)).quota.remaining, 30);
    await run(page, { n: 1 });
    const after = await state(page);
    assert.equal(after.submissions.length, 2);
    assert.equal(after.journal.attempts.length, 2);
    assert.notEqual(after.journal.attempts[0].id, after.journal.attempts[1].id);
  });
  test('急停在填文后提交前，保留草稿且零提交零占额度', 'cancel-before-submit', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'CANCELLED');
    const s = await state(page);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.quota.used, 0);
    assert.equal(await page.locator('#describesNegativeReview textarea').inputValue(), expectedText);
  });
  test('提交发出后急停保留未知，不算成功且不重试', 'cancel-after-submit', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startReportBatch({ n: 1 }).catch(e => ({ code: e.code }));
    });
    await page.waitForFunction(() => window.sim.submissions.length === 1);
    await panel(page).locator('#report-stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'REPORT_SUBMITTED_UNVERIFIED');
    const s = await state(page);
    assert.equal(s.batch.summary.reported, 0);
    assert.equal(s.quota.uncertain, 1);
    assert.equal(s.submissions.length, 1);
  });
  test('运行期间禁用切换；折叠最小化急停仍有效', 'query-noop', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startReportBatch({ n: 2 }).catch(e => ({ code: e.code }));
    });
    await page.waitForFunction(() => window.sim.queries.length === 1);
    const p = panel(page);
    for (const id of ['mode-reply', 'mode-report', 'report-n', 'report-goods', 'report-run-once', 'run-once']) {
      assert.equal(await p.locator(`#${id}`).isDisabled(), true);
    }
    await p.locator('#collapse').click();
    assert.match(await p.locator('#compact-count').innerText(), /运行中 · 成功举报0\/2/);
    await p.locator('#minimize').click();
    await p.locator('#compact-stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    assert.match(await p.locator('#compact-count').innerText(), /已停止 · 成功举报0\/2/);
    await p.locator('#restore').click();
    assert.equal(await p.locator('#report-body').isVisible(), true);
    assert.equal(await p.locator('#report-run-once').isDisabled(), false);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('举报面板拖拽、折叠最小化恢复及小窗口仍可用', 'normal', async page => {
    const p = panel(page);
    await p.locator('#mode-report').click();
    await p.locator('#report-n').fill('3');
    const handle = await p.locator('#panel-title').boundingBox();
    const before = await p.boundingBox();
    await page.mouse.move(handle.x + 25, handle.y + 7);
    await page.mouse.down();
    await page.mouse.move(handle.x - 200, handle.y - 70, { steps: 4 });
    await page.mouse.up();
    assert.ok((await p.boundingBox()).x < before.x - 100);
    await p.locator('#collapse').click();
    assert.equal(await p.locator('#report-body').isVisible(), false);
    await p.locator('#minimize').click();
    await page.setViewportSize({ width: 340, height: 400 });
    await p.locator('#restore').click();
    assert.equal(await p.locator('#report-n').inputValue(), '3');
    const rect = await p.boundingBox();
    assert.ok(rect.x >= 8 && rect.y >= 8 && rect.x + rect.width <= 340 && rect.y + rect.height <= 400);
    assert.equal((await state(page)).queries.length, 0);
  });
  test('独立状态与台账，不覆盖回复模式数据', 'normal', async page => {
    await page.evaluate(() => {
      sessionStorage.setItem('pdd-evaluation-helper:last-batch:v1', JSON.stringify({
        phase: 'completed', mode: 'sequential', params: { n: 3 }, records: [],
        summary: { checked: 3, replied: 2, skipped: 1 } }));
    });
    await run(page, { n: 1 });
    const p = panel(page);
    assert.match(await p.locator('#report-status').innerText(), /举报结束/);
    await p.locator('#mode-reply').click();
    assert.doesNotMatch(await p.locator('#status').innerText(), /举报结束/);
    assert.deepEqual(await page.evaluate(() => window.PDDEvaluationHelper.readBatch().summary),
      { checked: 3, replied: 2, skipped: 1 });
    await p.locator('#mode-report').click();
    const [download] = await Promise.all([page.waitForEvent('download'), p.locator('#report-export-batch').click()]);
    const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(data.mode, 'report');
    assert.equal(data.batch.summary.reported, 1);
    assert.equal(data.quota.confirmed, 1);
    assert.equal(data.journal.attempts.length, 1);
  });
  test('同页不跳转；一键按钮直接举报并保留原URL参数', 'normal', async page => {
    const originalUrl = page.url();
    await panel(page).locator('#mode-report').click();
    await panel(page).locator('#report-n').fill('1');
    await panel(page).locator('#report-run-once').click();
    await page.waitForFunction(() => window.PDDEvaluationHelper.readReportBatch()?.phase === 'completed');
    assert.equal(page.url(), originalUrl);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('其他后台页同标签导航并只执行一次；参数模式交接', 'normal', async page => {
    await injectOnNavigation(page);
    await page.route('**/home/', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><h1>其他后台页 · 合成数据</h1></body></html>' }));
    await page.goto('https://mms.pinduoduo.com/home/');
    await panel(page).locator('#mode-report').click();
    await panel(page).locator('#report-n').fill('1');
    await panel(page).locator('#report-goods').fill('8001');
    await panel(page).locator('#report-run-once').click();
    await page.waitForURL(evaluationUrl);
    await page.waitForFunction(() => window.PDDEvaluationHelper.readReportBatch()?.phase === 'completed');
    let s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.deepEqual(s.batch.params, { n: 1, goodsId: '8001' });
    assert.equal(await panel(page).locator('#report-body').isVisible(), true);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
    await page.reload();
    s = await state(page);
    assert.equal(s.queries.length, 0);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.quota.confirmed, 1);
  });
  test('坏导航数量与跨源任务不自动执行', 'normal', async page => {
    await injectOnNavigation(page);
    const valid = { schema: 4, action: 'report-batch', sourceUrl: page.url(), at: Date.now(), params: { n: 1, goodsId: '' } };
    for (const entry of [{ ...valid, params: { n: 31, goodsId: '' } }, { ...valid, params: { goodsId: '' } },
      { ...valid, action: 'start-batch' }, { ...valid, sourceUrl: 'https://example.invalid/' }]) {
      await page.evaluate(entry => sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify(entry)), entry);
      await page.reload();
      assert.equal((await state(page)).queries.length, 0);
      assert.equal((await state(page)).submissions.length, 0);
    }
  });
  test('举报数量无效时零动作并提示举报数量', 'normal', async page => {
    for (const n of [0, -1, 31, '1.5', '01', 'abc']) {
      const result = await run(page, { n });
      assert.equal(result.code, 'INVALID_REPORT_N');
      assert.match(result.message, /举报数量/);
    }
    assert.equal((await state(page)).queries.length, 0);
  });
  test('空闲急停和坏导航提示进入当前举报模式，状态与回复模式隔离', 'normal', async page => {
    const p = panel(page);
    await p.locator('#mode-report').click();
    await p.locator('#report-stop').click();
    assert.match(await p.locator('#report-status').innerText(), /没有正在执行的任务/);
    await p.locator('#mode-reply').click();
    assert.doesNotMatch(await p.locator('#status').innerText(), /没有正在执行的任务/);
    await p.locator('#mode-report').click();
    await injectOnNavigation(page);
    await page.evaluate(() => {
      sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify({
        schema: 4, action: 'report-batch', sourceUrl: location.href, at: Date.now(), params: { n: 31, goodsId: '' } }));
    });
    await page.reload();
    assert.equal(await p.locator('#report-body').isVisible(), true);
    assert.match(await p.locator('#report-status').innerText(), /跳转任务已过期或页面不符/);
    assert.equal((await state(page)).queries.length, 0);
  });
  test('举报与回复共用跨标签锁；人工核验也持有同一锁', 'normal', async (page, context) => {
    await seed(page, 1, 'submitted_unverified');
    const second = await context.newPage();
    await second.goto(evaluationUrl);
    await second.evaluate(() => {
      window.heldLock = navigator.locks.request('pdd-evaluation-helper:batch:v1', () =>
        new Promise(resolve => { window.releaseLock = resolve; }));
    });
    await second.waitForFunction(() => Boolean(window.releaseLock));
    assert.equal((await run(page)).code, 'OTHER_TAB_BUSY');
    const replyCode = await page.evaluate(() => window.PDDEvaluationHelper.startBatch({ n: 1 }).catch(e => e.code));
    assert.equal(replyCode, 'OTHER_TAB_BUSY');
    const resolveCode = await page.evaluate(() =>
      window.PDDEvaluationHelper.resolveReportSubmission('seed-0', 'confirmed', '核验').catch(e => e.code));
    assert.equal(resolveCode, 'OTHER_TAB_BUSY');
    assert.equal((await state(page)).journal.attempts[0].status, 'submitted_unverified');
    await second.evaluate(() => window.releaseLock());
    await second.close();
  });
  test('运行锁缺失、坏台账和存储失败都不提交', 'normal', async page => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
    });
    assert.equal((await run(page)).code, 'LOCK_UNAVAILABLE');
    await page.evaluate(() => {
      delete navigator.locks;
      localStorage.setItem('pdd-evaluation-helper:reports:v1', '{"schema":1,"attempts":[{}]}');
    });
    assert.equal((await run(page)).code, 'INVALID_REPORT_JOURNAL');
    await page.evaluate(() => {
      localStorage.removeItem('pdd-evaluation-helper:reports:v1');
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'pdd-evaluation-helper:reports:v1') throw new Error('offline quota storage blocked');
        return original.call(this, key, value);
      };
    });
    assert.equal((await run(page, { n: 1 })).code, 'STORAGE_UNAVAILABLE');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('从举报回到回复自动清掉低星筛选，回复条件保持原功能', 'normal', async page => {
    await run(page, { n: 1 });
    await page.evaluate(() => {
      window.sim.records = [];
      window.renderFixture();
    });
    const result = await page.evaluate(() => window.PDDEvaluationHelper.startBatch({ n: 1 }));
    assert.equal(result.ok, true);
    const selected = await page.evaluate(() =>
      [...document.querySelectorAll('.evaluation_search_btn_checked')].map(el => el.innerText));
    assert.deepEqual(selected, ['4星', '5星', '未回复', '近90天']);
    assert.equal((await state(page)).quota.confirmed, 1);
  });

  const selectedCases = process.env.PDD_TEST_CASE ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selectedCases.length);
  try {
    for (const item of selectedCases) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      try {
        await page.goto(`https://mms.pinduoduo.com/goods/evaluation/index?mode=${item.mode}`);
        await page.addScriptTag({ content: source });
        await item.fn(page, context);
        assert.deepEqual(errors, [], '不应产生未处理页面异常');
        console.log(`PASS ${item.name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${item.name}\n${error.stack}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`REPORT RESULT ${selectedCases.length - failures}/${selectedCases.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
