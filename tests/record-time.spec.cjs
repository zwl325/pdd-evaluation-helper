'use strict';

// 双模式共用的身份读取回归；全部使用合成记录，所有网络请求被拦截。
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
const timeMarkup = '<span class="logic_replyTime_x">${rec.time}</span>';
const otherTime = '2026-10-14 23:59:59';
const followup = `<section><div>追加评价</div><div>另一次评价的内容</div>
  <span class="logic_replyTime_followup">${otherTime}</span></section>`;
const reply = `<section class="logic_replyWrapper_x"><div>店铺回复内容</div>
  <span class="logic_replyTime_reply">${otherTime}</span></section>`;
const scenarios = [
  { name: '同值兄弟节点合并且身份key与历史去重保持', markup: timeMarkup + timeMarkup, repeat: true },
  { name: '整页重复时间仍按原数量语义处理', markup: timeMarkup + timeMarkup, full: true },
  { name: '父子节点同值合并且不重复提交',
    markup: '<div class="logic_replyTime_parent">' + timeMarkup + '</div>' },
  { name: '重复时间仅裁剪既有首尾空白',
    markup: timeMarkup + '<span class="logic_replyTime_copy"> \n${rec.time} \n</span>' },
  { name: '独立标注的追评时间不混入原始身份', markup: timeMarkup + followup },
  { name: '商家回复容器的时间不混入原始身份', markup: timeMarkup + reply },
  { name: '独立标注的商家回复时间不混入原始身份',
    markup: timeMarkup + reply.replace(' class="logic_replyWrapper_x"', '').replace('店铺回复内容', '商家回复') },
  { name: '嵌套元数据中的原始时间兼容且排除追评', markup: '<div>' + timeMarkup + '</div>' + followup },
  { name: '隐藏时间副本不参与身份', markup: timeMarkup +
    `<span class="logic_replyTime_hidden" style="display:none">${otherTime}</span>` },
  { name: '原始正文恰为追评二字不改变时间归属', markup: timeMarkup + timeMarkup, content: '追评', skip: true },
  { name: '两个不同原始时间停止并保存诊断',
    markup: timeMarkup + `<span class="logic_replyTime_other">${otherTime}</span>`, error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '不同时间反向排列也不按首个或最早时间猜测',
    markup: `<span class="logic_replyTime_other">${otherTime}</span>` + timeMarkup, error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '无明确归属的嵌套不同时间停止',
    markup: timeMarkup + `<section><div>其他信息</div><span class="logic_replyTime_other">${otherTime}</span></section>`,
    error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '原始时间无效不借用追评时间',
    markup: '<span class="logic_replyTime_x">日期未知</span>' + followup, error: 'INCOMPLETE_RECORD' },
  { name: '只有追评时间时停止而不反推原始时间', markup: followup, error: 'RECORD_TIME_MISSING' },
  { name: '隐藏原始时间不借用可见追评时间',
    markup: '<span class="logic_replyTime_x" hidden>${rec.time}</span>' + followup, error: 'RECORD_TIME_MISSING' },
  { name: '不完整的追评标签不作为排除证据',
    markup: timeMarkup + followup.replace('追加评价', '追加评价说明'), error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '近似商家回复类名不作为排除证据',
    markup: timeMarkup + reply.replace('logic_replyWrapper_x', 'logic_replyWrapperFake'),
    error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '没有时间时保存缺失诊断', markup: '', error: 'RECORD_TIME_MISSING' },
  { name: '不同格式的分钟与秒时间不擅自视为同值',
    markup: timeMarkup + '<span class="logic_replyTime_other">${rec.time.slice(0, 16)}</span>',
    error: 'RECORD_TIME_AMBIGUOUS' },
  { name: '同值但格式非法也不接受',
    markup: '<span class="logic_replyTime_x">未知日期</span><span class="logic_replyTime_copy">未知日期</span>',
    error: 'INCOMPLETE_RECORD' },
];

async function main() {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.PDD_TEST_BROWSER ? { executablePath: process.env.PDD_TEST_BROWSER } : {}) });
  const cases = ['reply', 'report'].flatMap(mode => scenarios.map(scenario => ({
    mode, scenario, name: `${mode}：${scenario.name}`,
  })));
  const selectedCases = process.env.PDD_TEST_CASE
    ? cases.filter(item => item.name.includes(process.env.PDD_TEST_CASE)) : cases;
  assert.ok(selectedCases.length);
  let failures = 0;
  try {
    for (const { mode, scenario, name } of selectedCases) {
      const fixturePath = path.join(root, 'tests', mode === 'report' ? 'report-fixture.html' : 'batch-fixture.html');
      const originalFixture = fs.readFileSync(fixturePath, 'utf8');
      assert.equal(originalFixture.split(timeMarkup).length, 2, '夹具时间模板必须唯一');
      const fixture = originalFixture.replace(timeMarkup, scenario.markup);
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route('**/*', route => route.request().isNavigationRequest()
        ? route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }) : route.abort());
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      try {
        await page.goto('https://mms.pinduoduo.com/goods/evaluation/index?mode=normal');
        await page.evaluate(({ mode, content, full }) => {
          if (!full) window.sim.records = [window.sim.records[mode === 'report' ? 1 : 0]];
          if (content) window.sim.records[0].content = content;
        }, { mode, content: scenario.content, full: scenario.full });
        await page.addScriptTag({ content: source });
        const limit = scenario.full ? 2 : 1;
        const result = await page.evaluate(({ mode, limit }) => {
          const action = mode === 'report' ? 'startReportBatch' : 'startBatch';
          return window.PDDEvaluationHelper[action]({ n: limit }).catch(error => ({
            ok: false, code: error.code, message: error.message,
          }));
        }, { mode, limit });
        const state = await page.evaluate(mode => {
          const helper = window.PDDEvaluationHelper;
          return { batch: mode === 'report' ? helper.readReportBatch() : helper.readBatch(),
            journal: mode === 'report' ? helper.readReportJournal() : helper.readSubmissionJournal(),
            quota: mode === 'report' ? helper.readReportQuota() : null,
            submissions: window.sim.submissions, original: window.sim.records[0] };
        }, mode);
        if (scenario.error) {
          assert.equal(result.code, scenario.error, result.message);
          assert.equal(state.submissions.length, 0);
          assert.equal(state.batch.summary.checked, 0);
          assert.equal(state.batch.error.details.stage, 'record_identity');
          assert.equal(state.batch.error.details.field, 'time');
          assert.equal(state.batch.error.details.order, state.original.order);
          assert.equal(state.batch.error.details.goodsId, state.original.goodsId);
          assert.equal(state.batch.error.details.selectedTime, null);
          if (scenario.error === 'RECORD_TIME_AMBIGUOUS') {
            assert.equal(state.batch.error.details.values.length, 2);
            assert.ok(state.batch.error.details.candidates.every(candidate => candidate.path && candidate.tag));
          }
          if (mode === 'report') {
            assert.equal(state.quota.used, 0);
            assert.deepEqual(state.journal.attempts, []);
          } else assert.deepEqual(state.journal.entries, {});
          // 错误发生在建记录之前，也必须能从两种模式的导出台账读取候选节点。
          const [download] = await Promise.all([page.waitForEvent('download'),
            page.evaluate(mode => window.PDDEvaluationHelper[
              mode === 'report' ? 'exportReportLedger' : 'exportLedger'](), mode)]);
          const exported = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
          assert.deepEqual(exported.batch.error.details, state.batch.error.details);
        } else {
          assert.equal(result.ok, true, result.message);
          const successes = scenario.skip ? 0 : scenario.full && mode === 'report' ? 2 : 1;
          assert.equal(state.submissions.length, successes);
          assert.equal(state.batch.summary.checked, scenario.full ? mode === 'report' ? 4 : 2 : 1);
          const record = state.batch.records[0];
          assert.equal(record.time, state.original.time);
          assert.equal(record.key, JSON.stringify([record.order, record.goodsId, state.original.time]));
          assert.equal(record.timeDiagnostics.selectedTime, state.original.time);
          assert.ok(record.timeDiagnostics.primaryCount >= 1);
          if (scenario.name.startsWith('同值') || scenario.name.startsWith('父子')) {
            assert.equal(record.timeDiagnostics.source, 'same_value_duplicates');
          }
          if (mode === 'report') assert.equal(state.quota.confirmed, successes);
          if (scenario.repeat) {
            const repeated = await page.evaluate(async mode => {
              const rec = window.sim.records[0];
              rec.reported = false; rec.replied = false;
              const helper = window.PDDEvaluationHelper;
              const result = await helper[mode === 'report' ? 'startReportBatch' : 'startBatch']({ n: 1 });
              return { result, submissions: window.sim.submissions.length };
            }, mode);
            assert.equal(repeated.result.ok, true);
            assert.equal(repeated.submissions, 1, '历史确认记录不能因重复时间节点再次提交');
            assert.equal(repeated.result.skipped, 1);
            assert.equal(mode === 'report' ? repeated.result.reported : repeated.result.replied, 0);
          }
        }
        assert.deepEqual(pageErrors, []);
        console.log(`PASS ${name}`);
      } catch (error) {
        failures++;
        console.error(`FAIL ${name}\n${error.stack}`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
  console.log(`TIME RESULT ${selectedCases.length - failures}/${selectedCases.length} passed`);
  process.exitCode = failures ? 1 : 0;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
