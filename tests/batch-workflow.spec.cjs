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
const evaluationUrl = 'https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav';
const otherPage = shop => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
  <title>其他后台页 · 离线夹具</title><body>
  ${shop ? `<div>${shop}<br>${shop}：测试子账号<br>退出当前账号</div><div>后台首页</div>` : ''}
  <h1>其他后台页 · 合成测试数据</h1><p>此页没有评价区域。</p></body></html>`;

async function enableNavigationInjection(page) {
  // 模拟Tampermonkey在完整页面加载后的注入；仅用于被拦截的离线夹具。
  await page.addInitScript({ content:
    `document.addEventListener('DOMContentLoaded', () => {\n${source}\n}, { once: true });` });
}

async function clickRunAndWait(page) {
  const previousBatchId = await page.evaluate(() => window.PDDEvaluationHelper?.readBatch()?.id || null);
  const alreadyHere = /^\/goods\/evaluation\/index\/?$/.test(new URL(page.url()).pathname);
  const originalUrl = page.url();
  const navigation = alreadyHere ? null :
    page.waitForEvent('framenavigated', { predicate: frame => frame === page.mainFrame() });
  await page.locator('#pdd-evaluation-helper-panel').locator('#run-once').click();
  if (navigation) await navigation;
  assert.equal(page.url(), alreadyHere ? originalUrl : evaluationUrl);
  await page.waitForFunction(previousId => {
    const batch = window.PDDEvaluationHelper?.readBatch();
    return batch?.phase === 'completed' && batch.id !== previousId;
  }, previousBatchId);
}

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
  test('N=3逐条立即回复，检查3条仅回复2条；第一条回复前不翻页', 'normal', async page => {
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 2, 1]);
    const s = await state(page);
    assert.deepEqual(s.submissions.map(rec => rec.order), ['990000-000000001', '990000-000000003']);
    assert.equal(s.batch.records.length, 3);
    assert.ok(s.submissions.every(rec => rec.value === replyText && rec.receivedInput === replyText));
    assert.equal(s.goods, '');
    assert.deepEqual(s.goodsEvents, ['']);
    assert.ok(s.visited.every(visit => !visit.beforeSubmission || visit.page === 1));
    assert.equal(s.batch.frozenAt, undefined);
    assert.equal(s.batch.mode, 'sequential');
  });
  test('N留空遍历全部6条，严格模板仅回复3条', 'normal', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [6, 3, 3]);
    const s = await state(page);
    assert.equal(s.submissions.length, 3);
    assert.ok(!s.opens.includes('990000-000000004'), '带尾部空白不应打开回复');
    assert.ok(s.visited.every(visit => !visit.beforeSubmission || visit.page === 1));
    assert.deepEqual(s.batch.records.map(rec => rec.order).sort(), Array.from({ length: 6 }, (_, i) =>
      `990000-00000000${i + 1}`));
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
  test('短句该用户觉得商品很好全文匹配可回复，成功计数加1', 'normal', async page => {
    await page.evaluate(() => { window.sim.records[0].content = '该用户觉得商品很好'; });
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.batch.summary, { checked: 1, replied: 1, skipped: 0 });
    assert.deepEqual((await state(page)).submissions.map(rec => rec.order), ['990000-000000001']);
    assert.equal(result.batch.records[0].content, '该用户觉得商品很好');
  });
  test('短句附加内容、空白、换行或其他星级均不触发回复', 'normal', async page => {
    for (const content of ['该用户觉得商品很好 ', '该用户觉得商品很好\n', '该用户觉得商品很好，值得推荐',
      '前缀该用户觉得商品很好', '该用户觉得商品很好，给出了3星好评', '该用户觉得商品较好']) {
      await page.evaluate(content => { window.sim.records[0].content = content; }, content);
      const result = await run(page, { n: 1 });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.replied, 0, content);
      assert.equal(result.checked, 1);
    }
    assert.equal((await state(page)).submissions.length, 0);
    assert.equal((await state(page)).opens.length, 0);
  });
  test('未检查记录消失后直接读取当前列表，计满N即停', 'missing-locked', async page => {
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 1, 2]);
    assert.equal(result.batch.records[2].status, 'skipped_non_template');
    assert.equal(result.batch.records[2].order, '990000-000000004');
    assert.deepEqual((await state(page)).submissions.map(rec => rec.order), ['990000-000000001']);
  });
  test('没有成功提示时对应记录的完整回复回显可确认', 'echo', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    assert.equal(result.batch.records[0].evidence, 'record_reply_echo');
  });
  test('已回复记录仍留在列表时去重继续，全量跨页不重复提交', 'echo', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [6, 3, 3]);
    const s = await state(page);
    assert.equal(s.submissions.length, 3);
    assert.equal(new Set(s.batch.records.map(rec => rec.key)).size, 6);
    assert.ok(s.batch.records.filter(rec => rec.status === 'confirmed').every(rec => rec.evidence === 'record_reply_echo'));
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
  test('N超过总数时只检查实际全部记录', 'normal', async page => {
    const result = await run(page, { n: 99 });
    assert.equal(result.checked, 6);
    assert.equal(result.replied, 3);
  });
  test('查询未完成不能使用旧结果', 'query-noop', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'TIMEOUT');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('跨页重复出现的身份按计数去重，不重复检查或发送', 'duplicate', async page => {
    const result = await run(page);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [5, 2, 3]);
    const s = await state(page);
    assert.equal(new Set(s.submissions.map(rec => rec.order)).size, s.submissions.length);
  });
  test('回复后列表重排，按当前顺序继续，不找原先固定记录', 'normal', async page => {
    await page.evaluate(() => document.body.addEventListener('click', event => {
      if (event.target.matches('[data-tracking-click-viewid="reply_btn"]') && window.sim.submissions.length === 1) {
        window.sim.records.reverse();
      }
    }));
    const result = await run(page, { n: 3 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [3, 2, 1]);
    assert.deepEqual(result.batch.records.map(rec => rec.order),
      ['990000-000000001', '990000-000000006', '990000-000000005']);
  });
  test('当前页评价身份重复时停止，不向重复目标回复', 'normal', async page => {
    await page.evaluate(() => { window.sim.records[1] = { ...window.sim.records[0] }; });
    assert.equal((await run(page)).code, 'DUPLICATE_RECORD');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('身份时间不完整时停止', 'bad-time', async page => {
    assert.equal((await run(page, { n: 1 })).code, 'INCOMPLETE_RECORD');
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('店铺页头无法识别也正常查询和回复，店铺只作可选备注', 'bad-shop', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    assert.equal(result.batch.shop, '');
    assert.equal(result.batch.records[0].shop, '');
    assert.equal(result.batch.records[0].key,
      JSON.stringify(['990000-000000001', '9001', '2026-10-12 10:00:00']));
  });
  test('旧版指定店铺参数被忽略，不限制其他店铺运行', 'normal', async page => {
    const result = await run(page, { n: 1, expectedShop: '另一个店铺' });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    assert.deepEqual(result.batch.params, { n: 1, goodsId: '' });
  });
  test('页头店铺文案改变不停止，继续核对原评价身份和正文', 'shop-change', async page => {
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('任意店铺名称及重复页头结构均可运行，不依赖固定名称', 'normal', async page => {
    const names = ['甲号测试铺', '乙号：测试铺', ''];
    for (let i = 0; i < names.length; i++) {
      if (i) {
        await page.reload();
        await page.addScriptTag({ content: source });
      }
      await page.evaluate(({ name, index }) => {
        const header = document.getElementById('shop-header');
        if (name) header.textContent = `${name}\n${name}：子账号\n退出当前账号`;
        else header.innerHTML = '甲铺<br>甲铺：子账号<br>乙铺<br>乙铺：子账号';
        window.sim.records[0].order = `991000-00000000${index}`;
      }, { name: names[i], index: i });
      const result = await run(page, { n: 1 });
      assert.equal(result.ok, true, result.message);
      assert.equal(result.replied, 1);
      assert.equal(result.batch.records[0].order, `991000-00000000${i}`);
    }
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
    assert.equal(s.queries, 2, '先查询，再逐条核验未知历史');
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
    await page.evaluate(() => document.getElementById('shop-header').remove());
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
      document.getElementById('shop-header').innerHTML = '店铺页头结构已改变';
      document.getElementById('query').click();
    });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const second = await run(page, { n: 1 });
    assert.equal(second.replied, 0);
    assert.equal(second.batch.records[0].status, 'skipped_previously_confirmed');
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('旧版含店铺名的已确认台账继续去重，缺少页头也不会重发', 'normal', async page => {
    const oldKey = await page.evaluate(() => {
      const rec = window.sim.records[0];
      const key = JSON.stringify(['旧测试店铺', rec.order, rec.goodsId, rec.time]);
      localStorage.setItem('pdd-evaluation-helper:submissions:v1', JSON.stringify({ schema: 1,
        entries: { [key]: { key, shop: '旧测试店铺', order: rec.order, goodsId: rec.goodsId,
          time: rec.time, status: 'confirmed', at: '2026-10-12T01:00:00Z', evidence: 'legacy_success' } } }));
      document.getElementById('shop-header').remove();
      return key;
    });
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.deepEqual([result.checked, result.replied, result.skipped], [1, 0, 1]);
    assert.equal(result.batch.records[0].status, 'skipped_previously_confirmed');
    assert.equal((await state(page)).submissions.length, 0);
    assert.equal(await page.evaluate(key =>
      window.PDDEvaluationHelper.readSubmissionJournal().entries[key].evidence, oldKey), 'legacy_success');
  });
  test('逐条遇到旧版未知提交时停止，保留前面已成功的回复', 'normal', async page => {
    await page.evaluate(() => {
      const rec = window.sim.records[2];
      const key = JSON.stringify(['旧测试店铺', rec.order, rec.goodsId, rec.time]);
      localStorage.setItem('pdd-evaluation-helper:submissions:v1', JSON.stringify({ schema: 1,
        entries: { [key]: { key, shop: '旧测试店铺', order: rec.order, goodsId: rec.goodsId,
          time: rec.time, status: 'submitted_unverified' } } }));
      document.getElementById('shop-header').remove();
    });
    assert.equal((await run(page, { n: 3 })).code, 'UNRESOLVED_HISTORY');
    const s = await state(page);
    assert.equal(s.queries, 1);
    assert.equal(s.batch.records.length, 3);
    assert.equal(s.opens.length, 1);
    assert.deepEqual(s.submissions.map(rec => rec.order), ['990000-000000001']);
    assert.deepEqual(s.batch.summary, { checked: 3, replied: 1, skipped: 1 });
  });
  test('其他店铺或其他订单的未知历史不阻止当前记录', 'normal', async page => {
    await page.evaluate(() => {
      const rec = { shop: '另一个测试店铺', order: '992000-000000001', goodsId: '9999',
        time: '2026-10-01 10:00:00', status: 'submitted_unverified' };
      const key = JSON.stringify([rec.shop, rec.order, rec.goodsId, rec.time]);
      localStorage.setItem('pdd-evaluation-helper:submissions:v1', JSON.stringify({ schema: 1,
        entries: { [key]: { ...rec, key } } }));
      document.getElementById('shop-header').remove();
    });
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    const entries = await page.evaluate(() => Object.values(window.PDDEvaluationHelper.readSubmissionJournal().entries));
    assert.equal(entries.filter(entry => entry.status === 'submitted_unverified').length, 1);
    assert.equal(entries.filter(entry => entry.status === 'confirmed').length, 1);
  });
  test('旧台账核验为未回复后可重新发送，保留旧条目和人工核验历史', 'normal', async page => {
    const oldKey = await page.evaluate(() => {
      const rec = window.sim.records[0];
      const key = JSON.stringify(['旧测试店铺', rec.order, rec.goodsId, rec.time]);
      localStorage.setItem('pdd-evaluation-helper:submissions:v1', JSON.stringify({ schema: 1,
        entries: { [key]: { key, shop: '旧测试店铺', order: rec.order, goodsId: rec.goodsId,
          time: rec.time, status: 'submitted_unverified', history: [] } } }));
      document.getElementById('shop-header').remove();
      window.PDDEvaluationHelper.resolveSubmission(key, 'not_replied_user_verified', '离线核验：确实未回复');
      return key;
    });
    const result = await run(page, { n: 1 });
    assert.equal(result.ok, true, result.message);
    assert.equal(result.replied, 1);
    const entries = await page.evaluate(() => window.PDDEvaluationHelper.readSubmissionJournal().entries);
    assert.equal(entries[oldKey].status, 'not_replied_user_verified');
    assert.ok(entries[result.batch.records[0].key].history.some(previous =>
      previous.status === 'not_replied_user_verified' && previous.manualVerification?.note === '离线核验：确实未回复'));
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
  test('急停查询等待立即结束批次，没有回复或提交台账', 'query-noop', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 3 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.queries === 1);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    const s = await state(page);
    assert.equal(s.batch.phase, 'stopped');
    assert.equal(s.batch.error.code, 'CANCELLED');
    assert.equal(s.queries, 1);
    assert.equal(s.opens.length, 0);
    assert.equal(s.submissions.length, 0);
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    assert.equal(await panel.locator('#status').getAttribute('data-tone'), 'info');
    assert.equal(await page.evaluate(() => Object.keys(window.PDDEvaluationHelper.readSubmissionJournal().entries).length), 0);
  });
  test('急停逐条遍历的翻页等待，停止后不继续处理', 'normal', async page => {
    await page.evaluate(() => {
      document.getElementById('results').addEventListener('click', event => {
        if (event.target.getAttribute('data-testid') !== 'beast-core-pagination-next') return;
        event.stopImmediatePropagation();
        document.querySelector('[data-testid="beast-core-table"]').setAttribute('aria-busy', 'true');
        window.freezePaused = true;
      }, true);
      window.pending = window.PDDEvaluationHelper.startBatch({}).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.freezePaused);
    await page.locator('#pdd-evaluation-helper-panel').locator('#stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    const s = await state(page);
    assert.equal(s.batch.records.length, 4);
    assert.equal(s.batch.phase, 'stopped');
    assert.equal(s.opens.length, 2);
    assert.equal(s.submissions.length, 2);
  });
  test('急停已填写但尚未提交的回复，保留草稿且零提交', 'normal', async page => {
    await page.evaluate(() => {
      document.body.addEventListener('input', event => {
        if (event.target.tagName === 'TEXTAREA') {
          document.querySelector('[data-tracking-click-viewid="reply_btn"]').disabled = true;
        }
      }, true);
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 3 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => document.querySelector('textarea')?.value.length > 100);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    assert.equal(await page.locator('textarea').inputValue(), replyText);
    const s = await state(page);
    assert.equal(s.opens.length, 1);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.batch.phase, 'stopped');
    assert.equal(await page.evaluate(() => Object.keys(window.PDDEvaluationHelper.readSubmissionJournal().entries).length), 0);
  });
  test('急停按钮在提交已发出后保留未知台账并阻止重发', 'cancel-after-submit', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 3 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.submissions.length === 1);
    await page.locator('#pdd-evaluation-helper-panel').locator('#stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'SUBMITTED_UNVERIFIED');
    const s = await state(page);
    assert.equal(s.submissions.length, 1);
    assert.equal(s.batch.phase, 'stopped');
    assert.equal(s.batch.records[0].status, 'submitted_unverified');
    const entries = await page.evaluate(() => Object.values(window.PDDEvaluationHelper.readSubmissionJournal().entries));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'submitted_unverified');
    assert.equal((await run(page, { n: 1 })).code, 'UNRESOLVED_HISTORY');
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
  test('评价路径直接筛选查询回复，保留URL和页面状态及检查入口', 'normal', async page => {
    await enableNavigationInjection(page);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.locator('#body button').count(), 4);
    await panel.locator('#batch-n').fill('2');
    await page.evaluate(() => { window.beforeReloadMarker = true; });
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(await page.evaluate(() => window.beforeReloadMarker), true);
    assert.equal(s.queries, 1);
    assert.equal(s.submissions.length, 1);
    assert.deepEqual(await page.evaluate(() => window.sim.filterClicks), ['4星', '5星', '未回复']);
    assert.equal(await panel.locator('#batch-n').inputValue(), '2');
    assert.equal(await panel.locator('#body button').count(), 4);
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    await panel.locator('#refresh').click();
    assert.match(await panel.locator('#inspection').innerText(), /已检查2\/2条；确认回复1条；跳过1条/);
    assert.equal((await state(page)).queries, 1);
    assert.equal((await state(page)).submissions.length, 1);
    if (process.env.PDD_BATCH_SCREENSHOT) await page.screenshot({ path: process.env.PDD_BATCH_SCREENSHOT, fullPage: true });
  });
  test('面板查看原文和导出实际本机台账，均不新增查询或提交', 'normal', async page => {
    const result = await run(page, { n: 2 });
    assert.equal(result.ok, true);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#reply-details summary').click();
    assert.equal(await panel.locator('#reply-copy').isVisible(), true);
    assert.equal(await panel.locator('#reply-copy').innerText(), replyText);
    assert.equal(replyText.length, 145);
    const downloadStarted = page.waitForEvent('download');
    await panel.locator('#export-batch').click();
    const download = await downloadStarted;
    assert.match(download.suggestedFilename(), /^pdd-evaluation-\d+\.json$/);
    const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
    assert.equal(data.batch.id, result.batch.id);
    assert.deepEqual(data.batch.summary, { checked: 2, replied: 1, skipped: 1 });
    assert.equal(data.batch.records.length, 2);
    assert.equal(Object.values(data.journal.entries).length, 1);
    assert.equal(Object.values(data.journal.entries)[0].status, 'confirmed');
    assert.equal(Object.values(data.journal.entries)[0].replyText, replyText);
    assert.equal((await state(page)).queries, 1);
    assert.equal((await state(page)).submissions.length, 1);
  });
  test('其他后台页没有评价DOM也能一键跳转，保留参数并执行', 'normal', async (page, context) => {
    const sourceUrl = 'https://mms.pinduoduo.com/orders/list';
    await context.route(sourceUrl, route => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: otherPage('测试店铺') }));
    await enableNavigationInjection(page);
    await page.goto(sourceUrl);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.evaluate(() => window.PDDEvaluationHelper.readState().pageFound), false);
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    await panel.locator('#batch-n').fill('1');
    await panel.locator('#batch-goods').fill('9001');
    const originalTabs = context.pages().length;
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(context.pages().length, originalTabs);
    assert.deepEqual(s.batch.summary, { checked: 1, replied: 1, skipped: 0 });
    assert.equal(s.batch.params.goodsId, '9001');
    assert.deepEqual(s.batch.params, { n: 1, goodsId: '9001' });
    assert.deepEqual(await page.evaluate(() => window.sim.filterClicks), ['4星', '5星', '未回复']);
  });
  test('其他后台页无法读取店铺也能跳转执行，评价页名称仅作台账备注', 'normal', async (page, context) => {
    const sourceUrl = 'https://mms.pinduoduo.com/goods/manage';
    await context.route(sourceUrl, route => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: otherPage(null) }));
    await enableNavigationInjection(page);
    await page.goto(sourceUrl);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    assert.equal(await panel.isVisible(), true);
    await panel.locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(s.batch.shop, '测试店铺');
    assert.equal(s.batch.records[0].shop, '测试店铺');
    assert.equal(s.queries, 1);
    assert.equal(s.submissions.length, 1);
  });
  test('跳转前后店铺名称不同也正常执行，不绑定启动店铺', 'normal', async (page, context) => {
    const sourceUrl = 'https://mms.pinduoduo.com/orders/list';
    await context.route(sourceUrl, route => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: otherPage('另一测试店铺') }));
    await enableNavigationInjection(page);
    await page.goto(sourceUrl);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(s.batch.shop, '测试店铺');
    assert.equal(s.queries, 1);
    assert.equal(s.submissions.length, 1);
  });
  test('启动页与评价页都没有可读店铺页头时仍正常执行', 'normal', async (page, context) => {
    const sourceUrl = 'https://mms.pinduoduo.com/goods/manage';
    await context.route(sourceUrl, route => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8', body: otherPage(null) }));
    await context.route(evaluationUrl, route => route.fulfill({ status: 200,
      contentType: 'text/html; charset=utf-8',
      body: fixture.replace('测试店铺<br>测试店铺：测试子账号<br>退出当前账号', '店铺不可识别') }));
    await enableNavigationInjection(page);
    await page.goto(sourceUrl);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(s.batch.shop, '');
    assert.equal(s.queries, 1);
    assert.equal(s.submissions.length, 1);
  });
  test('已在完全相同的目标地址直接运行，零导航且保留页面状态', 'normal', async (page, context) => {
    await enableNavigationInjection(page);
    await page.goto(evaluationUrl);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('1');
    await page.evaluate(() => { window.beforeReloadMarker = true; });
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    const initialTabs = context.pages().length;
    await clickRunAndWait(page);
    assert.equal(await page.evaluate(() => window.beforeReloadMarker), true);
    assert.equal(navigations, 0, '评价页不应刷新或跳转');
    assert.equal(context.pages().length, initialTabs, '必须复用当前标签页');
    assert.equal((await state(page)).submissions.length, 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
  });
  test('从首页一键跳转并一次性继续，刷新不重跑', 'normal', async (page, context) => {
    await enableNavigationInjection(page);
    await page.goto('https://mms.pinduoduo.com/home/');
    await page.locator('#pdd-evaluation-helper-panel').locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    assert.equal((await state(page)).submissions.length, 1);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.PDDEvaluationHelper));
    assert.equal((await state(page)).queries, 0);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('跳转后返回首页可再次运行，已确认的身份不会重复提交', 'normal', async page => {
    await enableNavigationInjection(page);
    await page.goto('https://mms.pinduoduo.com/home/');
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    assert.equal((await state(page)).submissions.length, 1);
    await page.goBack();
    await page.waitForFunction(() => Boolean(window.PDDEvaluationHelper));
    assert.equal(page.url(), 'https://mms.pinduoduo.com/home/');
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
    await panel.locator('#batch-n').fill('1');
    await clickRunAndWait(page);
    assert.deepEqual((await state(page)).batch.summary, { checked: 1, replied: 0, skipped: 1 });
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('一键直接运行使用N和指定商品ID，不丢失参数', 'normal', async page => {
    await enableNavigationInjection(page);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('1');
    await panel.locator('#batch-goods').fill('9001');
    await clickRunAndWait(page);
    const s = await state(page);
    assert.equal(s.goods, '9001');
    assert.equal(s.batch.params.n, 1);
    assert.equal(s.batch.params.goodsId, '9001');
    assert.equal(s.batch.records.length, 1);
    assert.equal(await panel.locator('#batch-goods').inputValue(), '9001');
  });
  test('一键运行留空N与商品时执行全部查询结果', 'normal', async page => {
    await enableNavigationInjection(page);
    await clickRunAndWait(page);
    const s = await state(page);
    assert.deepEqual(s.batch.summary, { checked: 6, replied: 3, skipped: 3 });
    assert.equal(s.goods, '');
  });
  test('一键运行参数非法时不刷新、不查询，运行按钮仍可用', 'normal', async page => {
    const before = page.url();
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#batch-n').fill('abc');
    await panel.locator('#run-once').click();
    await page.waitForFunction(() => document.getElementById('pdd-evaluation-helper-panel')
      .shadowRoot.getElementById('status').dataset.tone === 'error');
    assert.equal(page.url(), before);
    assert.equal((await state(page)).queries, 0);
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
  });
  test('急停清除跳转期间的任务，目标页加载后不自动执行', 'normal', async page => {
    await enableNavigationInjection(page);
    await page.goto('https://mms.pinduoduo.com/home/');
    await page.evaluate(() => {
      const panel = document.getElementById('pdd-evaluation-helper-panel').shadowRoot;
      panel.getElementById('batch-n').value = '1';
      // 在跳转请求已发出、源页面离开前，调用真实急停按钮的处理器。
      panel.getElementById('run-once').addEventListener('click', () => {
        const panel = document.getElementById('pdd-evaluation-helper-panel').shadowRoot;
        panel.getElementById('stop').click();
        sessionStorage.setItem('test:stop-navigation', JSON.stringify({
          pending: sessionStorage.getItem('pdd-evaluation-helper:pending:v1'),
          message: panel.getElementById('status').textContent,
          runDisabled: panel.getElementById('run-once').disabled,
          stopDisabled: panel.getElementById('stop').disabled,
        }));
      });
    });
    await page.locator('#pdd-evaluation-helper-panel').locator('#run-once').click();
    await page.waitForFunction(() => Boolean(window.PDDEvaluationHelper));
    assert.equal(page.url(), evaluationUrl);
    const stopped = await page.evaluate(() => JSON.parse(sessionStorage.getItem('test:stop-navigation')));
    assert.equal(stopped.pending, null);
    assert.match(stopped.message, /已急停/);
    assert.equal(stopped.runDisabled, true, '已发出的浏览器导航完成前仍禁止重启');
    assert.equal(stopped.stopDisabled, false);
    const s = await state(page);
    assert.equal(s.queries, 0);
    assert.equal(s.submissions.length, 0);
    assert.equal(s.batch, null);
    assert.equal(await page.locator('#pdd-evaluation-helper-panel').locator('#run-once').isDisabled(), false);
  });
  test('急停API清除未消费任务，存储清除失败明确报错', 'normal', async page => {
    const result = await page.evaluate(() => {
      const key = 'pdd-evaluation-helper:pending:v1';
      sessionStorage.setItem(key, '{"action":"start-batch"}');
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function(candidate) {
        if (candidate !== key) return original.call(this, candidate);
      };
      let error;
      try { window.PDDEvaluationHelper.cancel(); } catch (caught) { error = caught.code; }
      const preserved = sessionStorage.getItem(key);
      Storage.prototype.removeItem = original;
      const cancelled = window.PDDEvaluationHelper.cancel();
      return { error, preserved, cancelled, pending: sessionStorage.getItem(key) };
    });
    assert.equal(result.error, 'STORAGE_UNAVAILABLE');
    assert.equal(result.preserved, '{"action":"start-batch"}');
    assert.equal(result.cancelled, true);
    assert.equal(result.pending, null);
    assert.equal((await state(page)).queries, 0);
    assert.equal((await state(page)).submissions.length, 0);
  });
  test('跳转任务未能真正消费时零查询，避免刷新自动重跑', 'normal', async page => {
    await page.addInitScript(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function(key) {
        if (key !== 'pdd-evaluation-helper:pending:v1') return original.call(this, key);
      };
    });
    await page.evaluate(() => sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify({
      schema: 3, action: 'start-batch', sourceUrl: location.href, at: Date.now(), params: { n: 1, goodsId: '' },
    })));
    await page.reload();
    await page.addScriptTag({ content: source });
    assert.equal((await state(page)).queries, 0);
    assert.equal((await state(page)).submissions.length, 0);
    assert.match(await page.locator('#pdd-evaluation-helper-panel').locator('#status').innerText(), /无法清除/);
    assert.notEqual(await page.evaluate(() => sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
  });
  test('运行期间检查状态可用且不新增查询或提交，不覆盖当前进度', 'query-noop', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.startBatch({ n: 1 })
        .catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.queries === 1);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    const before = await panel.locator('#status').innerText();
    assert.equal(await panel.locator('#run-once').isDisabled(), true);
    assert.equal(await panel.locator('#refresh').isDisabled(), false);
    await panel.locator('#refresh').click();
    assert.match(await panel.locator('#inspection').innerText(), /筛选与查询/);
    assert.equal(await panel.locator('#status').innerText(), before);
    assert.equal((await state(page)).queries, 1);
    assert.equal((await state(page)).submissions.length, 0);
    assert.equal((await page.evaluate(() => window.pending)).code, 'TIMEOUT');
    await panel.locator('#refresh').click();
    assert.match(await panel.locator('#inspection').innerText(), /已停止/);
    assert.match(await panel.locator('#inspection').innerText(), /停止原因/);
  });
  test('运行中收起和最小化不影响任务，紧凑面板可急停并显示计数', 'query-noop', async page => {
    await page.evaluate(() => {
      window.pending = window.PDDEvaluationHelper.oneClickRun({ n: 1 }).catch(error => ({ code: error.code }));
    });
    await page.waitForFunction(() => window.sim.queries === 1);
    const panel = page.locator('#pdd-evaluation-helper-panel');
    await panel.locator('#collapse').click();
    assert.equal(await panel.locator('#body').isVisible(), false);
    assert.match(await panel.locator('#compact-count').innerText(), /运行中 · 检查0 · 回复0/);
    await panel.locator('#minimize').click();
    assert.equal(await panel.locator('#compact-stop').isDisabled(), false);
    await panel.locator('#compact-stop').click();
    assert.equal((await page.evaluate(() => window.pending)).code, 'CANCELLED');
    assert.match(await panel.locator('#compact-count').innerText(), /已停止 · 检查0 · 回复0/);
    assert.equal((await state(page)).submissions.length, 0);
    await panel.locator('#restore').click();
    assert.equal(await panel.locator('#run-once').isDisabled(), false);
  });
  test('损坏、过期或缺少检查范围的导航标记不启动全部回复', 'normal', async page => {
    const valid = { schema: 3, action: 'start-batch', sourceUrl: 'https://mms.pinduoduo.com/goods/manage',
      at: Date.now(), params: { n: 1, goodsId: '' } };
    for (const pending of [{ params: {} }, { ...valid, params: {} },
      { ...valid, params: { goodsId: '' } },
      { ...valid, sourceUrl: 'https://example.invalid/' }, { ...valid, at: Date.now() - 180000 }]) {
      await page.evaluate(pending => {
        sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify(pending));
      }, pending);
      await page.reload();
      await page.addScriptTag({ content: source });
      assert.equal((await state(page)).queries, 0);
      assert.equal((await state(page)).submissions.length, 0);
    }
  });
  test('旧版导航参数仍能继续一次，旧店铺限制不再生效', 'normal', async page => {
    for (const schema of [1, 2]) {
      await page.evaluate(schema => {
        sessionStorage.removeItem('pdd-evaluation-helper:last-batch:v1');
        sessionStorage.setItem('pdd-evaluation-helper:pending:v1', JSON.stringify({ schema,
          action: 'start-batch', sourceUrl: location.href, at: Date.now(),
          params: { n: 1, goodsId: '', expectedShop: '旧店铺名称' } }));
      }, schema);
      await page.reload();
      await page.addScriptTag({ content: source });
      await page.waitForFunction(() => window.PDDEvaluationHelper.readBatch()?.phase === 'completed');
      const s = await state(page);
      assert.deepEqual(s.batch.params, { n: 1, goodsId: '' });
      assert.equal(s.queries, 1);
      assert.equal(await page.evaluate(() => sessionStorage.getItem('pdd-evaluation-helper:pending:v1')), null);
    }
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
