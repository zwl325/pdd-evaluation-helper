// ==UserScript==
// @name         PDD评价筛选助手（4星、5星、未回复）
// @namespace    urn:local:pdd:evaluation-helper
// @version      2026-10-12.4
// @description  PDD评价筛选、查询、锁定前N条或全部结果，仅对完全匹配的4/5星模板评价提交统一回复。
// @author       zwl325
// @homepageURL  https://github.com/zwl325/pdd-evaluation-helper
// @supportURL   https://github.com/zwl325/pdd-evaluation-helper/issues
// @updateURL    https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.meta.js
// @downloadURL  https://raw.githubusercontent.com/zwl325/pdd-evaluation-helper/main/pdd-evaluation-filter.user.js
// @match        https://mms.pinduoduo.com/*
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23e02e24'/%3E%3Cpath d='m16 5 3.4 7 7.6 1.1-5.5 5.4 1.3 7.5-6.8-3.6L9.2 26l1.3-7.5L5 13.1l7.6-1.1z' fill='white'/%3E%3C/svg%3E
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // 单文件便于安装；模块只通过明确接口协作。后续业务模块可复用 DOM / Wait。
  // 定位依据：Tampermonkey-点击动作DOM定位清单.md（2026-10-12，非实时DOM）。
  const Config = Object.freeze({
    version: '2026-10-12.4',
    host: 'mms.pinduoduo.com',
    rootSelector: '#mf-mms-goods-container',
    filterSelector: 'div[class*="evaluation_search_btn"]',
    checkedClassFragment: 'btn_checked',
    targets: Object.freeze(['4星', '5星', '未回复']),
    conflictingLabels: Object.freeze(['1星', '2星', '3星', '已回复']),
    actionTimeoutMs: 6000,
    stableMs: 300,
    pollMs: 100,
    refreshMs: 1000,
    debounceMs: 150,
    panelId: 'pdd-evaluation-helper-panel',
    apiName: 'PDDEvaluationHelper',
    evaluationUrl: 'https://mms.pinduoduo.com/goods/evaluation/index?msfrom=mms_sidenav',
    resultTimeoutMs: 15000,
    resultStableMs: 800,
    submissionTimeoutMs: 15000,
    maxPages: 10000,
    pendingKey: 'pdd-evaluation-helper:pending:v1',
    journalKey: 'pdd-evaluation-helper:submissions:v1',
    batchKey: 'pdd-evaluation-helper:last-batch:v1',
    lockName: 'pdd-evaluation-helper:batch:v1',
    replyPattern: /^该用户觉得商品很好，给出了[45]星好评$/,
    replyText: '小店每天最开心的事莫过于看到亲的好评，亲的好评就像是清泉一样滋润我们的心田，小店会更加的珍惜亲的好评，不断的改进自己，完善自己，力求让小店的服务做得更好，店铺做得更大，也是为了让亲能够更好的买到自己的喜欢的宝贝。你的好评就是对我们最大的肯定和鼓励，希望亲再次关顾我们的店铺，检验小店的进步。',
    selectors: Object.freeze({
      form: '#evaluationSearchId form',
      goods: '#goodsId input',
      table: '[data-testid="beast-core-table"]',
      group: '[data-testid="beast-core-table-middle-tbody"]',
      row: '[data-testid="beast-core-table-body-tr"]',
      content: '[class*="logic_reviewWrapper"]',
      time: '[class*="logic_replyTime"]',
      pagination: '[data-testid="beast-core-pagination"]',
      activePage: '[class*="PGT_pagerItemActive"], [aria-current="page"]',
      total: '[class*="PGT_totalText"]',
      modal: '[data-testid="beast-core-modal-inner"]',
      modalTitle: '[class*="MDL_header"]',
      replyInput: 'textarea[data-testid="beast-core-textArea-htmlInput"]',
      replyButton: 'button[data-tracking-click-viewid="reply_btn"]',
      loading: '[aria-busy="true"], [data-testid="beast-core-loading"], [class*="LOA_loading"]',
    }),
  });

  if (location.hostname !== Config.host || window.top !== window.self) return;
  // 重复注入只保留一个面板、一组监听和一个执行锁。
  if (Object.prototype.hasOwnProperty.call(window, Config.apiName)) return;

  class HelperError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'PDDEvaluationHelperError';
      this.code = code;
    }
  }

  const DOM = (() => {
    const all = (selector, root = document) => Array.from(root.querySelectorAll(selector));
    const text = (element) => (element.innerText || '').trim();

    function visible(element) {
      if (!element?.isConnected) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || style.display === 'none' ||
            style.visibility === 'hidden' || style.visibility === 'collapse' ||
            style.opacity === '0') return false;
      }
      return true;
    }

    function enabled(element) {
      return !element.disabled &&
        !element.closest('[disabled], [aria-disabled="true"], [inert]') &&
        !/disabled/i.test(element.getAttribute('class') || '') &&
        getComputedStyle(element).pointerEvents !== 'none';
    }

    const selected = (element) =>
      (element.getAttribute('class') || '').includes(Config.checkedClassFragment);

    function root() {
      const roots = all(Config.rootSelector).filter(visible);
      if (roots.length > 1) {
        throw new HelperError('AMBIGUOUS_ROOT', `评价容器不唯一：找到 ${roots.length} 个可见容器。`);
      }
      return roots[0] || null;
    }

    function resolve(label, container = root()) {
      if (!container) return null;
      const matches = all(Config.filterSelector, container)
        .filter((element) => visible(element) && text(element) === label);
      if (matches.length > 1) {
        throw new HelperError('AMBIGUOUS_TARGET', `“${label}”不唯一：找到 ${matches.length} 个可见目标，已停止。`);
      }
      return matches[0] || null;
    }

    // 返回普通数据，不把DOM引用暴露给调用者，也不缓存页面重绘前的元素。
    function snapshot() {
      let container;
      try {
        container = root();
      } catch (error) {
        return { ready: false, pageFound: false, error: error.message, targets: [], otherSelected: [] };
      }
      const targets = Config.targets.map((label) => {
        try {
          const element = resolve(label, container);
          return {
            label,
            found: Boolean(element),
            selected: Boolean(element && selected(element)),
            enabled: Boolean(element && enabled(element)),
            error: element ? '' : '未找到可见目标',
          };
        } catch (error) {
          return { label, found: false, selected: false, enabled: false, error: error.message };
        }
      });
      const otherSelected = container
        ? [...new Set(all(Config.filterSelector, container)
          .filter((element) => visible(element) && selected(element))
          .map(text).filter((label) => Config.conflictingLabels.includes(label)))]
        : [];
      return {
        pageFound: Boolean(container),
        ready: targets.every((target) => target.found && (target.enabled || target.selected)),
        error: '',
        targets,
        otherSelected,
      };
    }

    return Object.freeze({ visible, enabled, selected, root, resolve, snapshot });
  })();

  const Wait = (() => {
    // Observer负责DOM变化，轮询补足祖先样式、URL等没有直接mutation的状态。
    // 每次等待都有超时；结束、异常、取消都会清理observer和timer。
    function until(probe, { signal, guard, description, timeoutMs = Config.actionTimeoutMs,
      stableMs = Config.stableMs }) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let stableSince = null;
        let intervalId;
        let timeoutId;
        const observer = new MutationObserver(check);

        function finish(error, value) {
          if (settled) return;
          settled = true;
          observer.disconnect();
          clearInterval(intervalId);
          clearTimeout(timeoutId);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(value);
        }

        function onAbort() {
          finish(new HelperError('CANCELLED', '操作已停止；已经选中的条件保留。'));
        }

        function check() {
          if (settled) return;
          try {
            if (signal?.aborted) return onAbort();
            guard?.();
            const value = probe();
            if (!value) {
              stableSince = null;
              return;
            }
            stableSince ??= performance.now();
            if (performance.now() - stableSince >= stableMs) finish(null, value);
          } catch (error) {
            finish(error);
          }
        }

        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'inert'],
        });
        intervalId = setInterval(check, Config.pollMs);
        timeoutId = setTimeout(() => {
          finish(new HelperError('TIMEOUT', `${description}超时。请检查页面状态及DOM定位，当前操作不会自动重试点击。`));
        }, timeoutMs);
        check();
      });
    }
    return Object.freeze({ until });
  })();

  const Actions = (() => {
    let active = null;
    let status = { busy: false, tone: 'info', message: '设置参数后点击“一键运行”。' };
    const listeners = new Set();

    function notify(next) {
      status = { ...status, ...next };
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    async function run(labels, checkConflicts = false, borrowedJob = null) {
      if (active && active !== borrowedJob) throw new HelperError('BUSY', '已有操作正在执行，请等待完成。');
      if (!Array.isArray(labels) || !labels.length ||
          labels.some((label) => !Config.targets.includes(label))) {
        throw new HelperError('INVALID_TARGET', '仅支持4星、5星、未回复。');
      }

      const job = borrowedJob || { controller: new AbortController(), url: location.href };
      const options = job.options || {
        signal: job.controller.signal,
        guard: () => {
          if (location.href !== job.url) {
            throw new HelperError('PAGE_CHANGED', '页面地址已变化，操作停止；请在当前评价页重新执行。');
          }
        },
      };
      active = job;
      notify({ busy: true, tone: 'info', message: '正在确认评价页及三个筛选目标…' });
      const results = [];

      try {
        await Wait.until(() => {
          const container = DOM.root();
          if (!container) return false;
          // 三项构成评价页特征；不在只有相似单个文字的其他页面上点击。
          return Config.targets.every((label) => Boolean(DOM.resolve(label, container)));
        }, { ...options, description: '等待评价筛选区域' });

        for (const label of [...new Set(labels)]) {
          notify({ message: `正在选择“${label}”…` });
          await Wait.until(() => Boolean(DOM.resolve(label)),
            { ...options, stableMs: 0, description: `定位“${label}”` });

          // await之后再次定位；不使用Wait返回的旧元素。
          options.guard();
          const element = DOM.resolve(label);
          if (!element) throw new HelperError('TARGET_DISAPPEARED', `“${label}”在点击前消失，已停止。`);
          const wasSelected = DOM.selected(element);
          if (!wasSelected) {
            if (!DOM.enabled(element)) {
              throw new HelperError('DISABLED_TARGET', `“${label}”当前不可点击，已停止。`);
            }
            // 单次click；没有鼠标事件连发、盲目重试或CDP降级调用。
            element.click();
          }

          await Wait.until(() => {
            const current = DOM.resolve(label);
            return current && DOM.selected(current);
          }, { ...options, description: `核验“${label}”已选中` });
          results.push({ label, action: wasSelected ? 'already-selected' : 'clicked' });
        }

        // 后续点击可能改变前面的筛选；因此最终需要联合核验。
        await Wait.until(() => {
          const container = DOM.root();
          if (!container) return false;
          return labels.every((label) => {
            const element = DOM.resolve(label, container);
            return element && DOM.selected(element);
          });
        }, { ...options, description: `最终联合核验（${labels.join('、')}）；条件可能互斥或被重置` });

        const finalState = DOM.snapshot();
        if (checkConflicts && finalState.otherSelected.length) {
          throw new HelperError('CONFLICTING_FILTERS',
            `三项已选中，但同时存在其他筛选：${finalState.otherSelected.join('、')}。请手动核查并清除冲突条件。`);
        }
        const clicked = results.filter((result) => result.action === 'clicked').length;
        const message = `${labels.join('、')}已核验选中。点击 ${clicked} 项，跳过已选 ${results.length - clicked} 项。`;
        notify({ tone: 'success', message });
        return { ok: true, results, state: finalState };
      } catch (error) {
        notify({ tone: error.code === 'CANCELLED' ? 'info' : 'error', message: error.message });
        console.warn('[PDD评价筛选助手]', error.code || error.name, error.message);
        throw error;
      } finally {
        // 用户暂停只停止未来动作；不撤销已成功完成的筛选。
        if (!borrowedJob) {
          active = null;
          notify({ busy: false });
        }
      }
    }

    async function runTask(execute) {
      if (active) throw new HelperError('BUSY', '已有操作正在执行。');
      const job = { controller: new AbortController(), url: location.href };
      job.options = {
        signal: job.controller.signal,
        guard: () => {
          if (job.controller.signal.aborted) throw new HelperError('CANCELLED', '批次已停止，已提交的回复无法撤销。');
          if (location.href !== job.url) throw new HelperError('PAGE_CHANGED', '页面地址已改变，批次停止。');
        },
      };
      active = job;
      notify({ busy: true, tone: 'info', message: '正在启动批次…' });
      try {
        return await execute(job);
      } catch (error) {
        notify({ tone: 'error', message: error.message });
        throw error;
      } finally {
        active = null;
        notify({ busy: false });
      }
    }

    function cancel() {
      if (!active) return false;
      active.controller.abort();
      return true;
    }

    return Object.freeze({
      select: (label) => run([label]),
      selectAll: () => run(Config.targets, true),
      selectForBatch: (job) => run(Config.targets, true, job),
      runTask,
      update: notify,
      cancel,
      cancelIfPageChanged: () => {
        if (active && location.href !== active.url) cancel();
      },
      subscribe,
      status: () => ({ ...status }),
    });
  })();

  const ReviewDOM = (() => {
    const all = (selector, root = document) => [...root.querySelectorAll(selector)];
    const text = (element) => (element?.innerText || '').trim();
    function one(selector, label, root = document, optional = false) {
      const found = all(selector, root).filter(DOM.visible);
      if (found.length === 0 && optional) return null;
      if (found.length !== 1) throw new HelperError('DOM_NOT_UNIQUE', `${label}：找到${found.length}个可见目标。`);
      return found[0];
    }
    function shop(optional = false) {
      // 沿用交接文件的页头身份结构；自动推断，不硬编码历史店铺。
      const body = document.body.innerText;
      const end = body.indexOf('后台首页');
      const lines = (end >= 0 ? body.slice(0, end) : '').split('\n').map(line => line.trim()).filter(Boolean);
      const names = [...new Set(lines.filter(line =>
        !/[：:]/.test(line) && lines.some(other => other.startsWith(`${line}：`) || other.startsWith(`${line}:`))))];
      if (!lines.includes('退出当前账号') || names.length !== 1) {
        if (optional) return null;
        throw new HelperError('SHOP_UNVERIFIED', '无法唯一识别当前店铺。需核查页头店铺行、子账号行及登录状态后调整定位。');
      }
      return names[0];
    }
    function assertShop(expected) {
      if (shop() !== expected) throw new HelperError('SHOP_CHANGED', '当前店铺已变化，批次停止。');
    }
    const form = (optional = false) => one(Config.selectors.form, '评价查询表单', DOM.root() || document, optional);
    const goods = () => one(Config.selectors.goods, '商品ID输入框', form());
    function queryButton() {
      const matches = all('button', form()).filter(element => DOM.visible(element) && text(element) === '查询');
      if (matches.length !== 1) throw new HelperError('DOM_NOT_UNIQUE', '查询按钮不唯一。');
      return matches[0];
    }
    function setValue(element, value) {
      if (!DOM.enabled(element) || element.readOnly) throw new HelperError('INPUT_DISABLED', '目标输入框当前不可编辑。');
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function filterSignature() {
      return JSON.stringify({
        fields: all('input, textarea, select', form()).map(element => ({
          name: element.name || element.id || element.getAttribute('data-testid') || '',
          type: element.type,
          value: element.value,
          checked: /checkbox|radio/.test(element.type) ? element.checked : undefined,
        })),
        selected: all(Config.filterSelector, DOM.root()).filter(DOM.selected).map(text).sort(),
      });
    }
    function identity(group, shopName) {
      const row = one(Config.selectors.row, '评价正文行', group);
      const wrapper = one(Config.selectors.content, '评价正文容器', row);
      const orderValues = [...new Set([...group.innerText.matchAll(/订单编号[：:]\s*([\d-]+)/g)].map(match => match[1]))];
      const goodsText = text(one('.goods-id', '评价商品ID', group));
      const goodsId = /^(?:ID|商品ID)\s*[：:]\s*(\d+)$/i.exec(goodsText)?.[1];
      const time = text(one(Config.selectors.time, '评价时间', wrapper));
      if (orderValues.length !== 1 || !goodsId || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(time)) {
        throw new HelperError('INCOMPLETE_RECORD', '评价身份或全文不可读取，锁定/回复停止。');
      }
      return { shop: shopName, order: orderValues[0], goodsId, time,
        key: JSON.stringify([shopName, orderValues[0], goodsId, time]) };
    }
    function record(group, shopName) {
      const value = identity(group, shopName);
      const wrapper = one(Config.selectors.content, '评价正文容器', one(Config.selectors.row, '评价正文行', group));
      const content = wrapper.firstElementChild?.innerText;
      if (typeof content !== 'string' || !content.length) throw new HelperError('INCOMPLETE_RECORD', '评价全文不可读取。');
      return { ...value, content };
    }
    function eligible(content) {
      const match = Config.replyPattern.exec(content);
      return Boolean(match && match[0] === content); // JS的$也能匹配末尾换行之前；显式检查全文长度。
    }
    const table = (optional = false) => one(Config.selectors.table, '评价结果表', DOM.root() || document, optional);
    const groups = () => all(Config.selectors.group, table()).filter(DOM.visible);
    function find(recordValue) {
      assertShop(recordValue.shop);
      const matches = groups().filter(group => identity(group, recordValue.shop).key === recordValue.key);
      if (matches.length > 1) throw new HelperError('DUPLICATE_RECORD', '当前页评价身份重复，已停止。');
      return matches[0] || null;
    }
    function page() {
      const pagination = one(Config.selectors.pagination, '评价分页器', DOM.root() || document, true);
      if (!pagination) return { number: 1, total: null, next: null, prev: null };
      const current = one(Config.selectors.activePage, '当前页码', pagination);
      const number = Number(text(current));
      const totalText = one(Config.selectors.total, '结果总数', pagination, true);
      const totalMatch = totalText && /共(?:有)?\s*([\d,]+)\s*条/.exec(text(totalText));
      const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      if (!Number.isSafeInteger(number) || number < 1) throw new HelperError('PAGE_UNREADABLE', '当前页码不可读取。');
      const arrow = direction => one(`[data-testid="beast-core-pagination-${direction}"]`,
        `${direction}分页按钮`, pagination, true);
      return { number, total, next: arrow('next'), prev: arrow('prev') };
    }
    const canTurn = (element) => Boolean(element && DOM.enabled(element) && !/PGT_disabled/.test(element.className));
    function busy() {
      const root = DOM.root();
      return !root || !table(true) || all(Config.selectors.loading, root).some(DOM.visible) ||
        /加载中|正在加载/.test(text(table()));
    }
    function fingerprint() {
      const p = page();
      return JSON.stringify({ text: table().innerText, page: p.number, total: p.total,
        next: canTurn(p.next), prev: canTurn(p.prev) });
    }
    function empty() {
      return /暂无(?:数据|评价|相关记录)|没有(?:评价|数据|相关记录)|无查询结果/.test(text(table())) || page().total === 0;
    }
    function replyLink(group) {
      const matches = all('a, button', group).filter(element =>
        DOM.visible(element) && /^回复[\/／]互动$/.test(text(element)));
      if (matches.length !== 1 || !DOM.enabled(matches[0])) throw new HelperError('REPLY_LINK_UNAVAILABLE', '对应评价的回复/互动入口不可唯一点击。');
      return matches[0];
    }
    const modals = () => all(Config.selectors.modal).filter(DOM.visible);
    function modal() {
      const visible = modals();
      if (visible.length !== 1 || text(visible[0].querySelector(Config.selectors.modalTitle)) !== '快捷回复') {
        throw new HelperError('UNEXPECTED_MODAL', '未出现唯一“快捷回复”弹框，可能进入了互动详情，已停止。');
      }
      return visible[0];
    }
    // 只认独立的精确成功文本，不把包含历史提示的整页/表格当作证据。
    function successMessages() {
      return all('div, span, p, [role="status"], [role="alert"]').filter(element =>
        DOM.visible(element) && /^回复成功[！!。]?$/.test(text(element)) &&
        !element.closest(Config.selectors.table) && !element.querySelector('input, textarea'));
    }
    function replyEcho(rec) {
      if (!table(true)) return false;
      const group = find(rec);
      return group && all('*', group).some(element => DOM.visible(element) &&
        element.innerText === Config.replyText && !element.closest(Config.selectors.content));
    }
    return Object.freeze({ all, text, one, shop, assertShop, form, goods, queryButton, setValue,
      filterSignature, record, eligible, table, groups, find, page, canTurn, busy, fingerprint, empty,
      replyLink, modals, modal, successMessages, replyEcho });
  })();

  const Ledger = (() => {
    function read(store, key, fallback) {
      try {
        const value = store.getItem(key);
        return value ? JSON.parse(value) : fallback;
      } catch {
        throw new HelperError('STORAGE_UNAVAILABLE', '本机台账无法读取；回复操作停止。');
      }
    }
    function write(store, key, value) {
      try {
        const text = JSON.stringify(value);
        store.setItem(key, text);
        if (store.getItem(key) !== text) throw new Error('Persistence mismatch');
      } catch {
        throw new HelperError('STORAGE_UNAVAILABLE', '本机台账无法保存；回复操作停止。');
      }
    }
    function journal() {
      const data = read(localStorage, Config.journalKey, { schema: 1, entries: {} });
      if (data.schema !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new HelperError('INVALID_JOURNAL', '回复台账格式异常，需人工核查。');
      }
      if (Object.entries(data.entries).some(([key, entry]) => !entry || entry.key !== key ||
          typeof entry.shop !== 'string' || !['submitting', 'submitted_unverified', 'confirmed',
            'not_replied_user_verified'].includes(entry.status))) {
        throw new HelperError('INVALID_JOURNAL', '回复台账含未知状态或不完整身份，需人工核查。');
      }
      return data;
    }
    function unresolved(shop) {
      return Object.values(journal().entries).filter(entry => entry.shop === shop &&
        ['submitting', 'submitted_unverified'].includes(entry.status));
    }
    function submission(rec, status, evidence = '') {
      const data = journal();
      const previous = data.entries[rec.key];
      const history = previous ? [...(previous.history || []),
        { status: previous.status, at: previous.at, evidence: previous.evidence,
          manualVerification: previous.manualVerification }] : [];
      data.entries[rec.key] = { key: rec.key, shop: rec.shop, order: rec.order, goodsId: rec.goodsId,
        time: rec.time, status, replyText: Config.replyText, at: new Date().toISOString(), evidence, history };
      write(localStorage, Config.journalKey, data);
      rec.status = status;
      rec.evidence = evidence;
    }
    const saveBatch = batch => write(sessionStorage, Config.batchKey, batch);
    const lastBatch = () => read(sessionStorage, Config.batchKey, null);
    function resolve(key, verdict, note) {
      if (Actions.status().busy) throw new HelperError('BUSY', '批次执行期间不能修改台账。');
      if (!['confirmed', 'not_replied_user_verified'].includes(verdict) || !String(note || '').trim()) {
        throw new HelperError('INVALID_RESOLUTION', '人工核验必须明确结论并填写依据。');
      }
      const data = journal();
      const entry = data.entries[key];
      if (!entry || !['submitting', 'submitted_unverified'].includes(entry.status)) {
        throw new HelperError('NO_UNCERTAIN_ENTRY', '没有该身份对应的未知提交。');
      }
      ReviewDOM.assertShop(entry.shop);
      entry.history = [...(entry.history || []),
        { status: entry.status, at: entry.at, evidence: entry.evidence }];
      entry.status = verdict;
      entry.manualVerification = { note: String(note), at: new Date().toISOString() };
      entry.at = entry.manualVerification.at;
      write(localStorage, Config.journalKey, data);
      return { ...entry };
    }
    function exportData() {
      const blob = new Blob([JSON.stringify({ batch: lastBatch(), journal: journal() }, null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `pdd-evaluation-${Date.now()}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return Object.freeze({ read, write, journal, unresolved, submission, saveBatch, lastBatch, resolve, exportData });
  })();

  const Results = (() => {
    async function stable(options, description = '等待评价结果稳定') {
      let last;
      return Wait.until(() => {
        if (ReviewDOM.busy()) { last = undefined; return false; }
        const signature = ReviewDOM.fingerprint();
        if (signature !== last) { last = signature; return false; }
        if (!ReviewDOM.groups().length && !ReviewDOM.empty()) return false;
        return { signature, page: ReviewDOM.page() };
      }, { ...options, timeoutMs: Config.resultTimeoutMs, stableMs: Config.resultStableMs, description });
    }
    async function transition(click, options, targetPage) {
      const before = ReviewDOM.fingerprint();
      let activity = false;
      const table = ReviewDOM.table();
      const observer = new MutationObserver(records => {
        if (records.some(record => table.contains(record.target) || record.target === table ||
            [...record.addedNodes, ...record.removedNodes].some(node =>
              node.nodeType === 1 && (node.matches?.(Config.selectors.table) || node.contains(table))) ||
            record.target.closest?.(Config.selectors.pagination) ||
            record.target.closest?.(Config.selectors.loading))) activity = true;
      });
      observer.observe(DOM.root(), { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['class', 'aria-busy', 'style'] });
      try {
        options.guard();
        click();
        await Wait.until(() => {
          if (ReviewDOM.busy() || ReviewDOM.fingerprint() !== before) activity = true;
          const page = ReviewDOM.page();
          return activity && !ReviewDOM.busy() && (targetPage === undefined || page.number === targetPage);
        }, { ...options, timeoutMs: Config.resultTimeoutMs, stableMs: 0,
          description: `等待查询/翻页完成${targetPage ? `（第${targetPage}页）` : ''}` });
        return await stable(options);
      } finally {
        observer.disconnect();
      }
    }
    async function turn(direction, options) {
      const page = ReviewDOM.page();
      const element = page[direction];
      if (!ReviewDOM.canTurn(element)) return false;
      const expected = page.number + (direction === 'next' ? 1 : -1);
      await transition(() => {
        const current = ReviewDOM.page();
        if (current.number !== page.number || !ReviewDOM.canTurn(current[direction])) {
          throw new HelperError('PAGE_CHANGED', '翻页前分页状态变化，已停止。');
        }
        current[direction].click();
      }, options, expected);
      return true;
    }
    async function first(options) {
      let count = 0;
      while (ReviewDOM.page().number > 1) {
        if (++count > Config.maxPages || !await turn('prev', options)) {
          throw new HelperError('CANNOT_RETURN_FIRST', '不能返回查询第一页，已停止。');
        }
      }
    }
    async function freeze(batch, options) {
      await first(options);
      const keys = new Set();
      const initialTotal = ReviewDOM.page().total;
      const limit = batch.params.n ?? Infinity;
      batch.initialTotal = initialTotal;
      batch.maxCapturedPage = 1;
      while (batch.records.length < limit) {
        options.guard();
        const page = ReviewDOM.page();
        if (page.number > Config.maxPages || page.total !== initialTotal) {
          throw new HelperError('RESULTS_CHANGED', '收集期间总数变化或分页超出保护上限，未开始回复。');
        }
        const groups = ReviewDOM.groups();
        const take = Math.min(groups.length, limit - batch.records.length);
        for (const group of groups.slice(0, take)) {
          const rec = ReviewDOM.record(group, batch.shop);
          if (keys.has(rec.key)) throw new HelperError('DUPLICATE_RECORD', '锁定范围内存在重复评价身份，未开始回复。');
          if (batch.params.goodsId && rec.goodsId !== batch.params.goodsId) {
            throw new HelperError('GOODS_FILTER_MISMATCH', '查询结果包含其他商品，未开始回复。');
          }
          keys.add(rec.key);
          batch.records.push({ ...rec, rank: batch.records.length + 1, capturedPage: page.number, status: 'pending' });
        }
        batch.maxCapturedPage = page.number;
        Ledger.saveBatch(batch);
        Actions.update({ message: `正在锁定查询结果：${batch.records.length}条，第${page.number}页。` });
        if (batch.records.length >= limit || !ReviewDOM.canTurn(page.next)) break;
        if (!groups.length) throw new HelperError('INCONSISTENT_EMPTY_PAGE', '空页仍可翻页，分页结构需核查。');
        await turn('next', options);
      }
      const expected = initialTotal === null ? null : Math.min(limit, initialTotal);
      if (expected !== null && batch.records.length !== expected) {
        throw new HelperError('INCOMPLETE_SCOPE', `应锁定${expected}条，实际${batch.records.length}条；未开始回复。`);
      }
      batch.frozenAt = new Date().toISOString();
      Ledger.saveBatch(batch);
      await first(options);
      // 冻结是跨页读取；提交前再校验原始前缀，发现采集期间重排则不执行回复。
      for (let number = 1; number <= batch.maxCapturedPage; number++) {
        options.guard();
        if (ReviewDOM.page().total !== initialTotal) {
          throw new HelperError('RESULTS_CHANGED', '冻结核查时结果总数变化，未开始回复。');
        }
        const expectedPage = batch.records.filter(rec => rec.capturedPage === number);
        const currentGroups = ReviewDOM.groups().slice(0, expectedPage.length);
        const current = currentGroups.map(group => ReviewDOM.record(group, batch.shop));
        if (current.length !== expectedPage.length || current.some((rec, index) =>
          rec.key !== expectedPage[index].key || rec.content !== expectedPage[index].content)) {
          throw new HelperError('RESULTS_REORDERED', '锁定过程中原始前缀变化，未开始回复；请重新查询。');
        }
        if (number < batch.maxCapturedPage && !await turn('next', options)) {
          throw new HelperError('INCOMPLETE_SCOPE', '冻结核查不能到达原始页。');
        }
      }
      await first(options);
    }
    async function locate(rec, batch, options) {
      // 只在最初捕获的页范围内核对身份，绝不扩展N或改拿当前第N条。
      await stable(options);
      await first(options);
      while (true) {
        options.guard();
        const group = ReviewDOM.find(rec);
        if (group) return group;
        const page = ReviewDOM.page();
        if (page.number >= batch.maxCapturedPage || !ReviewDOM.canTurn(page.next)) return null;
        await turn('next', options);
      }
    }
    return Object.freeze({ stable, transition, freeze, locate });
  })();

  const Replies = (() => {
    async function submit(rec, batch, options) {
      options.guard();
      let group = ReviewDOM.find(rec);
      if (!group || ReviewDOM.record(group, batch.shop).content !== rec.content) {
        throw new HelperError('RECORD_CHANGED', '回复前身份或正文变化，已停止。');
      }
      if (ReviewDOM.modals().length) throw new HelperError('EXISTING_MODAL', '页面已有弹框，请先人工核查。');
      const link = ReviewDOM.replyLink(group);
      link.scrollIntoView({ block: 'center', behavior: 'instant' });
      link.click();
      await Wait.until(() => {
        if (!ReviewDOM.modals().length) return false;
        return ReviewDOM.modal();
      }, { ...options, description: '等待快捷回复弹框' });
      const input = ReviewDOM.one(Config.selectors.replyInput, '回复输入框', ReviewDOM.modal());
      if (input.value) throw new HelperError('EXISTING_REPLY_TEXT', '弹框已有文字，可能存在历史互动；未覆盖或提交。');
      if (Config.replyText.length > 200 || input.maxLength > 0 && input.maxLength < Config.replyText.length) {
        throw new HelperError('REPLY_TOO_LONG', '统一回复超过输入限制。');
      }
      ReviewDOM.setValue(input, Config.replyText);
      await Wait.until(() => {
        const modal = ReviewDOM.modal();
        const current = ReviewDOM.one(Config.selectors.replyInput, '回复输入框', modal);
        const button = ReviewDOM.one(Config.selectors.replyButton, '提交回复按钮', modal);
        return current.value === Config.replyText && DOM.enabled(button);
      }, { ...options, description: '核验完整回复文案及提交按钮' });
      await Wait.until(() => !ReviewDOM.successMessages().length,
        { ...options, description: '等待上一条成功提示消失' });

      // 观察文本变化和新节点。仅在本次click之后读取证据，排除上一条提示。
      let armed = false;
      let successEvidence = '';
      const evidenceObserver = new MutationObserver(() => {
        if (armed && ReviewDOM.successMessages().length) successEvidence = 'fresh_reply_success';
      });
      evidenceObserver.observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
      let submitted = false;
      try {
        options.guard();
        group = ReviewDOM.find(rec);
        if (!group || ReviewDOM.record(group, batch.shop).content !== rec.content ||
            !ReviewDOM.eligible(rec.content)) throw new HelperError('RECORD_CHANGED', '提交前评价身份或全文不一致。');
        const modal = ReviewDOM.modal();
        const current = ReviewDOM.one(Config.selectors.replyInput, '回复输入框', modal);
        const button = ReviewDOM.one(Config.selectors.replyButton, '提交回复按钮', modal);
        if (current.value !== Config.replyText || !DOM.enabled(button)) {
          throw new HelperError('REPLY_NOT_READY', '提交前文案或按钮状态改变。');
        }
        Ledger.submission(rec, 'submitting');
        Ledger.saveBatch(batch);
        submitted = true;
        armed = true;
        button.click(); // 持久化状态后仅提交一次；未知结果禁止自动重发。
        await Wait.until(() => {
          if (ReviewDOM.successMessages().length) successEvidence = 'fresh_reply_success';
          if (ReviewDOM.replyEcho(rec)) successEvidence = 'record_reply_echo';
          return (successEvidence === 'record_reply_echo' ||
            successEvidence && !ReviewDOM.modals().length) ? successEvidence : false;
        }, { ...options, timeoutMs: Config.submissionTimeoutMs, stableMs: 0,
          description: '等待本次回复成功证据' });
        Ledger.submission(rec, 'confirmed', successEvidence);
        Ledger.saveBatch(batch);
        await Wait.until(() => !ReviewDOM.modals().length,
          { ...options, description: '等待已成功回复的弹框关闭' });
        await Results.stable(options);
      } catch (error) {
        if (submitted && rec.status !== 'confirmed') {
          Ledger.submission(rec, 'submitted_unverified', error.code || error.message);
          Ledger.saveBatch(batch);
          throw new HelperError('SUBMITTED_UNVERIFIED', `订单${rec.order}已发出一次提交，但结果不明。批次停止，禁止自动重试；请人工核查，可通过接口导出台账。`);
        }
        throw error;
      } finally {
        evidenceObserver.disconnect();
      }
    }
    return Object.freeze({ submit });
  })();

  const Workflow = (() => {
    let navigating = false;
    function params(value = {}) {
      const rawN = value.n;
      const absentN = rawN === undefined || rawN === null || rawN === '';
      const n = absentN ? null : Number(rawN);
      if (!absentN && (!/^[1-9]\d*$/.test(String(rawN)) || !Number.isSafeInteger(n))) {
        throw new HelperError('INVALID_N', 'N必须是正整数，留空表示全部查询结果。');
      }
      const goodsId = value.goodsId === undefined || value.goodsId === null ? '' : String(value.goodsId).trim();
      if (goodsId && !/^\d+$/.test(goodsId)) throw new HelperError('INVALID_GOODS_ID', '商品ID必须是完整数字，或留空。');
      return { n, goodsId, expectedShop: String(value.expectedShop || '').trim() };
    }
    async function execute(p, job) {
      const options = job.options;
      await Wait.until(() => Boolean(DOM.root() && DOM.snapshot().ready && ReviewDOM.form(true) && ReviewDOM.table(true)),
        { ...options, timeoutMs: Config.resultTimeoutMs, description: '等待评价页加载' });
      const shop = ReviewDOM.shop();
      if (p.expectedShop && shop !== p.expectedShop) throw new HelperError('SHOP_CHANGED', '当前店铺与启动时指定的店铺不同。');
      const unresolved = Ledger.unresolved(shop);
      if (unresolved.length) throw new HelperError('UNRESOLVED_HISTORY', '该店铺存在未知提交，需先人工核验历史记录，不能启动新批次。');
      const initialGuard = options.guard;
      let filterSignature;
      options.guard = () => {
        initialGuard();
        ReviewDOM.assertShop(shop);
        if (filterSignature && ReviewDOM.filterSignature() !== filterSignature) {
          throw new HelperError('FILTER_CHANGED', '批次期间查询条件改变，已停止。');
        }
      };
      const batch = { id: crypto.randomUUID(), version: Config.version, startedAt: new Date().toISOString(),
        shop, params: p, phase: 'querying', records: [] };
      Ledger.saveBatch(batch);
      try {
        await Actions.selectForBatch(job);
        options.guard();
        // 未指定也写入空值，清除页面残留ID；绝不静默继承旧查询条件。
        if (ReviewDOM.goods().value !== p.goodsId) ReviewDOM.setValue(ReviewDOM.goods(), p.goodsId);
        await Wait.until(() => ReviewDOM.goods().value === p.goodsId,
          { ...options, description: '核验商品ID输入条件' });
        const residuals = ReviewDOM.all('input, textarea', ReviewDOM.form()).filter(element =>
          DOM.visible(element) && element !== ReviewDOM.goods() && !element.readOnly &&
          !['checkbox', 'radio', 'button', 'submit', 'hidden'].includes(element.type) && element.value.trim());
        if (residuals.length) throw new HelperError('RESIDUAL_FILTER', '存在未指定的订单号/关键词等输入，请清空后再启动。');
        if (ReviewDOM.modals().length) throw new HelperError('EXISTING_MODAL', '页面已有弹框，查询前停止。');
        filterSignature = ReviewDOM.filterSignature();
        batch.filters = JSON.parse(filterSignature);
        Actions.update({ message: `店铺：${shop}。查询商品${p.goodsId || '全部'}；检查${p.n ?? '全部'}条。` });
        await Results.transition(() => {
          const button = ReviewDOM.queryButton();
          if (!DOM.enabled(button)) throw new HelperError('QUERY_DISABLED', '查询按钮不可点击。');
          button.click();
        }, options, 1);
        batch.phase = 'freezing';
        await Results.freeze(batch, options);
        batch.phase = 'replying';
        Ledger.saveBatch(batch);
        for (const rec of batch.records) {
          options.guard();
          Actions.update({ message: `锁定${batch.records.length}条；正在检查第${rec.rank}条，订单${rec.order}。` });
          const prior = Ledger.journal().entries[rec.key];
          if (prior?.status === 'confirmed') {
            rec.status = 'skipped_previously_confirmed';
          } else {
            const group = await Results.locate(rec, batch, options);
            if (!group) rec.status = 'skipped_missing_locked_record';
            else {
              const current = ReviewDOM.record(group, shop);
              if (current.content !== rec.content) throw new HelperError('RECORD_CHANGED', '锁定记录正文已变化，停止而不替换记录。');
              // 完全匹配：不trim、不提取局部、不将手写评价视为模板。
              if (!ReviewDOM.eligible(current.content)) rec.status = 'skipped_non_template';
              else await Replies.submit(rec, batch, options);
            }
          }
          Ledger.saveBatch(batch);
        }
        const replied = batch.records.filter(rec => rec.status === 'confirmed').length;
        const skipped = batch.records.filter(rec => rec.status.startsWith('skipped_')).length;
        batch.phase = 'completed';
        batch.completedAt = new Date().toISOString();
        batch.summary = { checked: batch.records.length, replied, skipped };
        Ledger.saveBatch(batch);
        Actions.update({ tone: 'success',
          message: `批次完成：锁定检查${batch.records.length}条，确认回复${replied}条，跳过${skipped}条。${p.n ? `N=${p.n}，未补位。` : '已遍历全部查询结果。'}` });
        return { ok: true, ...batch.summary, batch };
      } catch (error) {
        batch.phase = 'stopped';
        batch.error = { code: error.code || error.name, message: error.message };
        Ledger.saveBatch(batch);
        throw error;
      }
    }
    function navigate(p) {
      if (navigating || Actions.status().busy) throw new HelperError('BUSY', '已有操作正在执行。');
      // 其他后台页可能没有评价页的店铺结构；先导航，目标页仍严格识别店铺。
      const shop = ReviewDOM.shop(true);
      if (shop && p.expectedShop && p.expectedShop !== shop) throw new HelperError('SHOP_CHANGED', '启动店铺不符。');
      Ledger.write(sessionStorage, Config.pendingKey, { schema: 2, action: 'start-batch',
        sourceUrl: location.href, params: { ...p, expectedShop: shop || p.expectedShop }, at: Date.now() });
      navigating = true;
      Actions.update({ busy: true, tone: 'info', message: '正在重新加载评价页，随后自动执行…' });
      try {
        // 当前就是目标地址时也必须重新加载；同标签页，不创建新窗口。
        if (location.href === Config.evaluationUrl) location.reload();
        else location.assign(Config.evaluationUrl);
      } catch (error) {
        sessionStorage.removeItem(Config.pendingKey);
        navigating = false;
        Actions.update({ busy: false, tone: 'error', message: '评价页跳转失败，请重新执行。' });
        throw error;
      }
      return { navigating: true };
    }
    async function oneClickRun(value) {
      return navigate(params(value));
    }
    // 本页编排兼容接口；由消费后的导航任务调用，避免再次刷新形成循环。
    async function start(value) {
      const p = params(value);
      if (navigating || Actions.status().busy) throw new HelperError('BUSY', '已有操作正在执行。');
      if (!/^\/goods\/evaluation\/index\/?$/.test(location.pathname)) return navigate(p);
      return Actions.runTask(async job => {
        if (!navigator.locks?.request) throw new HelperError('LOCK_UNAVAILABLE', '当前浏览器不支持批次互斥锁，未开始提交。');
        return navigator.locks.request(Config.lockName, { ifAvailable: true }, async lock => {
          if (!lock) throw new HelperError('OTHER_TAB_BUSY', '另一个后台标签页正在执行批次，请等待完成。');
          return execute(p, job);
        });
      });
    }
    function validPending(pending) {
      if (pending.schema === 1) return typeof pending.params?.expectedShop === 'string' &&
        Boolean(pending.params.expectedShop.trim());
      if (pending.schema !== 2 || !pending.params || Array.isArray(pending.params)) return false;
      const p = pending.params;
      if (!(p.n === null || Number.isSafeInteger(p.n) && p.n > 0) ||
          typeof p.goodsId !== 'string' || !/^\d*$/.test(p.goodsId) ||
          typeof p.expectedShop !== 'string' || typeof pending.sourceUrl !== 'string') return false;
      try {
        return new URL(pending.sourceUrl).origin === location.origin;
      } catch {
        return false;
      }
    }
    async function continueNavigation() {
      try {
        const pending = Ledger.read(sessionStorage, Config.pendingKey, null);
        if (!pending) return;
        sessionStorage.removeItem(Config.pendingKey); // 消费一次，刷新不会重新自动提交。
        if (!validPending(pending) || pending.action !== 'start-batch' || !Number.isFinite(pending.at) ||
            Date.now() - pending.at < 0 || Date.now() - pending.at > 120000 ||
            !/^\/goods\/evaluation\/index\/?$/.test(location.pathname)) {
          throw new HelperError('EXPIRED_START', '跳转任务已过期或页面不符，请手动重新启动。');
        }
        Panel.setParams(pending.params);
        await start(pending.params);
      } catch (error) {
        Actions.update({ tone: 'error', message: error.message });
      }
    }
    function restoreNavigation() {
      if (!navigating) return;
      navigating = false;
      Actions.update({ busy: false, tone: 'info', message: '已返回页面，点击“一键运行”可重新启动。' });
    }
    return Object.freeze({ start, oneClickRun, continueNavigation, restoreNavigation });
  })();

  const Panel = (() => {
    let host;
    let shadow;
    let lastRender = '';
    let checkedAt = '';

    // 观察入口只读取筛选和本机批次快照，不触发点击、查询或提交。
    function inspection() {
      try {
        const state = DOM.snapshot();
        const found = state.targets.filter(target => target.found).length;
        const selected = state.targets.filter(target => target.selected).length;
        let message = state.error || (state.pageFound
          ? `筛选${state.ready ? '就绪' : '未就绪'}：找到${found}/3项，已选${selected}/3项。`
          : '当前页面可启动；点击“一键运行”自动进入评价页。');
        const problems = state.pageFound ? state.targets.filter(target => target.error ||
          (target.found && !target.enabled && !target.selected)) : [];
        if (problems.length) message += `\n${problems.map(target =>
          `${target.label}：${target.error || '不可点击'}`).join('；')}。`;
        if (state.otherSelected.length) message += `\n冲突条件：${state.otherSelected.join('、')}。`;
        const batch = Ledger.lastBatch();
        if (batch && Array.isArray(batch.records)) {
          const phases = { querying: '筛选与查询', freezing: '锁定检查范围',
            replying: '逐条检查与回复', completed: '已完成', stopped: '已停止' };
          const records = batch.records;
          const replied = records.filter(rec => rec.status === 'confirmed').length;
          const skipped = records.filter(rec => rec.status?.startsWith('skipped_')).length;
          const uncertain = records.filter(rec =>
            ['submitting', 'submitted_unverified'].includes(rec.status)).length;
          message += `\n最近批次：${phases[batch.phase] || '未知阶段'}。`
            + `\n已检查${replied + skipped}/${records.length}条；确认回复${replied}条；跳过${skipped}条。`;
          if (uncertain) message += `\n待核验提交：${uncertain}条。`;
          if (batch.error?.message) message += `\n停止原因：${batch.error.message}`;
        } else message += '\n尚无批次记录。';
        if (checkedAt) message += `\n手动检查：${checkedAt}；状态持续自动更新。`;
        return { message, tone: state.error || problems.length || state.otherSelected.length ? 'error' : 'info' };
      } catch (error) {
        return { message: `状态读取失败：${error.message}`, tone: 'error' };
      }
    }

    function mount() {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = Config.panelId;
      // 布局在宿主上设置，样式在Shadow DOM内隔离，不修改站点样式。
      host.style.cssText = 'position:fixed;right:20px;bottom:24px;z-index:2147483000;display:block;';
      shadow = host.attachShadow({ mode: 'open' });
      shadow.innerHTML = `
        <style>
          :host { all: initial; color-scheme: light; font: 13px/1.6 system-ui, "Microsoft YaHei", sans-serif; }
          * { box-sizing: border-box; }
          section { width: min(312px, calc(100vw - 24px)); color: #202534; background: #fff;
            border: 1px solid #e3e5eb; border-radius: 12px; box-shadow: 0 8px 28px #19233d26; overflow: hidden; }
          header { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
            background: #fff5f4; border-bottom: 1px solid #f2dedc; }
          strong { font-size: 14px; font-weight: 700; }
          .version { font-size: 11px; color: #737c8c; }
          button { font: inherit; cursor: pointer; border: 1px solid #dce0e7; background: #fff;
            color: #303746; border-radius: 7px; padding: 6px 9px; }
          button:hover:enabled { border-color: #e02e24; background: #fff5f4; }
          button:focus-visible { outline: 2px solid #e02e24; outline-offset: 2px; }
          button:disabled { opacity: .45; cursor: not-allowed; }
          #body { padding: 12px 14px 14px; max-height: calc(100vh - 120px); overflow: auto; }
          [hidden] { display: none !important; }
          #status { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; font-size: 12px; color: #626b7a; }
          #status[data-tone="success"] { color: #207442; }
          #status[data-tone="error"] { color: #b32c22; }
          .tools { display: flex; gap: 6px; margin-top: 9px; }
          .tools button { padding: 4px 9px; font-size: 12px; }
          #inspection { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; padding: 8px;
            border-radius: 6px; background: #f6f7fa; font-size: 12px; color: #626b7a; }
          #inspection[data-tone="error"] { color: #b32c22; }
          .hint { color: #737c8c; margin: 9px 0 0; font-size: 11px; }
          label { display: block; font-size: 12px; margin-top: 6px; }
          input { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #dce0e7; border-radius: 6px; }
          #run-once { width: 100%; margin-top: 12px; background: #e02e24; color: white; border-color: #e02e24; }
          #run-once:hover:enabled { background: #c8241b; }
          details { margin-top: 9px; font-size: 12px; color: #626b7a; }
          summary { cursor: pointer; }
          #reply-copy { margin: 6px 0 0; overflow-wrap: anywhere; }
        </style>
        <section aria-label="PDD评价自动回复">
          <header><strong>PDD 评价自动回复</strong><span class="version">${Config.version}</span></header>
          <div id="body">
            <label for="batch-n">检查数量 N（留空＝全部结果）</label>
            <input id="batch-n" type="text" inputmode="numeric" placeholder="例如 5；N不是回复数量">
            <label for="batch-goods">商品 ID（可选）</label>
            <input id="batch-goods" type="text" inputmode="numeric" placeholder="留空查询全部商品">
            <button id="run-once" type="button">一键运行</button>
            <p id="status" role="status" aria-live="polite"></p>
            <div class="tools">
              <button id="refresh" type="button">检查状态</button>
              <button id="export-batch" type="button">导出本机台账</button>
            </div>
            <p id="inspection" role="status" aria-live="polite"></p>
            <details id="reply-details"><summary>查看统一回复文案</summary><p id="reply-copy"></p></details>
            <p class="hint">可从后台任意页面启动，自动进入评价页查询并回复。N留空处理全部结果。</p>
          </div>
        </section>`;
      shadow.querySelector('#run-once').addEventListener('click', () => {
        void Workflow.oneClickRun({ n: shadow.querySelector('#batch-n').value,
          goodsId: shadow.querySelector('#batch-goods').value })
          .catch(error => Actions.update({ tone: 'error', message: error.message }));
      });
      shadow.querySelector('#refresh').addEventListener('click', () => {
        checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        render();
      });
      shadow.querySelector('#export-batch').addEventListener('click', () => {
        try { Ledger.exportData(); } catch (error) { Actions.update({ tone: 'error', message: error.message }); }
      });
      shadow.querySelector('#reply-copy').textContent = Config.replyText;
      document.body.append(host);
      lastRender = '';
    }

    function render() {
      mount();
      // @match和入口已限定商家后台域名；面板不再依赖评价页地址或筛选DOM。
      const status = Actions.status();
      const reading = inspection();
      // 高频mutation不反复更新相同的面板内容。
      const fingerprint = JSON.stringify({ status, reading });
      if (fingerprint === lastRender) return;
      lastRender = fingerprint;
      shadow.querySelector('#run-once').disabled = status.busy;
      shadow.querySelector('#batch-n').disabled = status.busy;
      shadow.querySelector('#batch-goods').disabled = status.busy;
      const feedback = shadow.querySelector('#status');
      feedback.textContent = status.message;
      feedback.dataset.tone = status.tone;
      const details = shadow.querySelector('#inspection');
      details.textContent = reading.message;
      details.dataset.tone = reading.tone;
    }

    function destroy() {
      host?.remove();
      host = null;
      shadow = null;
      lastRender = '';
    }

    function setParams(params) {
      mount();
      shadow.querySelector('#batch-n').value = params.n === null ? '' : String(params.n);
      shadow.querySelector('#batch-goods').value = params.goodsId || '';
    }

    return Object.freeze({ render, destroy, setParams,
      contains: (node) => Boolean(host && (node === host || host.contains(node))) });
  })();

  const App = (() => {
    let observer;
    let intervalId;
    let debounceId;
    let unsubscribe;
    let started = false;
    let lastUrl = location.href;

    function refresh() {
      if (location.href !== lastUrl) {
        Actions.cancelIfPageChanged();
        lastUrl = location.href;
      }
      Panel.render();
    }

    function schedule() {
      // 一个窗口只排一个刷新任务，避免持续DOM变化让debounce永远延后。
      if (debounceId !== undefined) return;
      debounceId = setTimeout(() => {
        debounceId = undefined;
        refresh();
      }, Config.debounceMs);
    }

    function start() {
      if (started || !document.body) return;
      started = true;
      lastUrl = location.href;
      unsubscribe = Actions.subscribe(Panel.render);
      observer = new MutationObserver((records) => {
        if (records.some((record) => !Panel.contains(record.target))) schedule();
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'disabled', 'aria-disabled', 'inert'],
      });
      intervalId = setInterval(refresh, Config.refreshMs);
      window.addEventListener('popstate', refresh);
      window.addEventListener('hashchange', refresh);
      refresh();
    }

    function stop() {
      if (!started) return;
      started = false;
      Actions.cancel();
      observer.disconnect();
      clearInterval(intervalId);
      clearTimeout(debounceId);
      debounceId = undefined;
      unsubscribe();
      window.removeEventListener('popstate', refresh);
      window.removeEventListener('hashchange', refresh);
      Panel.destroy();
    }

    // BFCache恢复时重新挂载，避免返回页面后监听失效。
    window.addEventListener('pagehide', stop);
    window.addEventListener('pageshow', event => {
      if (event.persisted) Workflow.restoreNavigation();
      start();
    });
    return Object.freeze({ start });
  })();

  // 可选的本页编排接口：控制台、后续同页模块均可调用；不接入CDP、网络请求或消息桥。
  Object.defineProperty(window, Config.apiName, {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: Config.version,
      readState: DOM.snapshot,
      startBatch: Workflow.start,
      oneClickRun: Workflow.oneClickRun,
      exportLedger: Ledger.exportData,
      readBatch: Ledger.lastBatch,
      readSubmissionJournal: Ledger.journal,
      resolveSubmission: Ledger.resolve,
      select: Actions.select,
      selectAll: Actions.selectAll,
      cancel: Actions.cancel,
    }),
  });

  App.start();
  void Workflow.continueNavigation();
})();
