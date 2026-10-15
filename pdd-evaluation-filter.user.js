// ==UserScript==
// @name         PDD评价筛选助手 v2026-10-15.3
// @namespace    urn:local:pdd:evaluation-helper
// @version      2026-10-15.3
// @description  PDD自动筛选回复与差评举报，支持成功计数、一星正文不限举报、可编辑文案、台账及可拖拽折叠面板。
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
  // 定位依据：原点击清单（2026-10-12）及举报定位元素.txt（2026-10-14），非实时DOM。
  const Config = Object.freeze({
    version: '2026-10-15.3',
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
    panelKey: 'pdd-evaluation-helper:panel:v1',
    reportJournalKey: 'pdd-evaluation-helper:reports:v1',
    reportBatchKey: 'pdd-evaluation-helper:last-report-batch:v1',
    templatesKey: 'pdd-evaluation-helper:templates:v1',
    lockName: 'pdd-evaluation-helper:batch:v1',
    reportStars: Object.freeze(['1星', '2星', '3星']),
    reportContent: '该用户未填写文字评价',
    reportReason: '同行恶意差评',
    reportText: '平台审核组：\n近期店铺出现多个异常评价，经数据核查，存在以下可疑特征：\n\n1. 账号共性：头像简单或使用随机数字 ID。\n2. 行为异常：均直接购买，平均停留不足5分钟。\n3. 评价异常：差评均反映商品质量差。\n4. 物流正常：每24小时有物流更新，仍投诉物流慢。\n5. 关联特征：每逢大促集中出现中差评，请明察，还店铺清白。\n6. 我愿意退换货，但该同行拒绝，并以差评要挟，谋取不正当利益，影响公平竞争，请严查！',
    replyPattern: /^该用户觉得商品很好(?:，给出了[45]星好评)?$/,
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
      reportLink: '[data-tracking-click-viewid="report"] a',
      reportReason: '#reportType label[data-testid="beast-core-radio"]',
      reportInput: '#describesNegativeReview textarea[data-testid="beast-core-textArea-htmlInput"]',
      reportButton: 'button[data-tracking-viewid="new_confirm_report_btn"]',
      reportDetail: '.comment-content .detail',
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
          finish(new HelperError('CANCELLED', '操作已停止；已提交的回复无法撤销，已经选中的条件保留。'));
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
    let status = { busy: false, taskMode: 'reply', tone: 'info', message: '设置参数后点击“一键运行”。' };
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
      notify({ busy: true, ...(!borrowedJob ? { taskMode: 'reply' } : {}),
        tone: 'info', message: '正在确认评价页及三个筛选目标…' });
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

    async function runTask(execute, taskMode = 'reply') {
      if (active) throw new HelperError('BUSY', '已有操作正在执行。');
      const job = { controller: new AbortController(), url: location.href };
      job.options = {
        signal: job.controller.signal,
        guard: () => {
          if (job.controller.signal.aborted) throw new HelperError('CANCELLED', '批次已停止，已提交的操作无法撤销。');
          if (location.href !== job.url) throw new HelperError('PAGE_CHANGED', '页面地址已改变，批次停止。');
        },
      };
      active = job;
      notify({ busy: true, taskMode, tone: 'info', message: '正在启动批次…' });
      try {
        return await execute(job);
      } catch (error) {
        notify({ tone: error.code === 'CANCELLED' ? 'info' : 'error', message: error.message });
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

  const ReviewTime = (() => {
    const format = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/;
    const sectionLabel = /^(追评|追加评价|商家回复)[：:]?$/;
    function role(element, wrapper) {
      // 原始正文仍按交接约定取firstElementChild；正文里的样式节点不用于身份。
      const content = wrapper.firstElementChild;
      if (element === content || content?.contains(element)) return 'inside_content';
      for (let parent = element.parentElement; parent && parent !== wrapper; parent = parent.parentElement) {
        if (/(?:^|\s)logic_replyWrapper(?:_|$|\s)/.test(parent.className)) return 'merchant_reply';
        // 追评容器不一定有独立可见标签；按现场诊断中的类名归属排除其时间。
        if (/(?:^|\s)logic_appendWrapper(?:_|$|\s)/.test(parent.className)) return 'additional_review';
        const label = parent.firstElementChild;
        if (label && !label.contains(element) && DOM.visible(label)) {
          const match = sectionLabel.exec((label.innerText || '').trim());
          if (match) return match[1] === '商家回复' ? 'merchant_reply' : 'additional_review';
        }
      }
      return 'original_candidate';
    }
    function path(element, wrapper) {
      const parts = [];
      for (let node = element; node && node !== wrapper; node = node.parentElement) {
        parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${
          [...node.parentElement.children].indexOf(node) + 1})`);
      }
      return parts.join(' > ');
    }
    function read(wrapper, identity) {
      const nodes = [...wrapper.querySelectorAll(Config.selectors.time)];
      const candidates = nodes.filter(DOM.visible).map(element => {
        const rawText = element.innerText || '';
        const value = rawText.trim();
        return { text: rawText, value, valid: format.test(value), role: role(element, wrapper),
          path: path(element, wrapper), tag: element.tagName.toLowerCase(),
          className: String(element.className), parentClass: String(element.parentElement.className) };
      });
      const primary = candidates.filter(candidate => candidate.role === 'original_candidate');
      const values = [...new Set(primary.map(candidate => candidate.value))];
      const diagnostics = { stage: 'record_identity', field: 'time', ...identity,
        selector: Config.selectors.time, candidateCount: nodes.length, visibleCount: candidates.length,
        primaryCount: primary.length, ignoredCount: candidates.length - primary.length,
        candidates, values, selectedTime: null, source: null, issue: '' };
      let code, message;
      if (!primary.length) {
        code = 'RECORD_TIME_MISSING';
        message = '原始评价时间未找到；候选节点已保存到本机台账。';
        diagnostics.issue = 'no_original_time';
      } else if (primary.some(candidate => !candidate.valid)) {
        code = 'INCOMPLETE_RECORD';
        message = '原始评价时间格式不可确认；候选文本已保存到本机台账。';
        diagnostics.issue = 'invalid_time_text';
      } else if (values.length !== 1) {
        code = 'RECORD_TIME_AMBIGUOUS';
        message = `原始评价时间有${values.length}个不同值，无法确认归属；候选节点已保存到本机台账。`;
        diagnostics.issue = 'different_original_times';
      }
      if (code) throw Object.assign(new HelperError(code, message), { details: diagnostics });
      diagnostics.selectedTime = values[0];
      diagnostics.source = primary.length === 1 ? 'single_original_time' : 'same_value_duplicates';
      return { value: values[0], diagnostics };
    }
    return Object.freeze({ read });
  })();

  const ReviewPagination = (() => {
    const all = (selector, root = DOM.root() || document) => [...root.querySelectorAll(selector)];
    const text = element => (element.innerText || '').trim();
    function diagnostics(issue = '') {
      const containers = all(Config.selectors.pagination);
      return { stage: 'pagination', issue, observedAt: new Date().toISOString(),
        selector: Config.selectors.pagination, activeSelector: Config.selectors.activePage,
        candidateCount: containers.length, visibleCount: containers.filter(DOM.visible).length,
        containers: containers.slice(0, 4).map(element => ({
          visible: DOM.visible(element), className: String(element.className),
          dataStatus: element.getAttribute('data-status'),
          activeCandidates: all(Config.selectors.activePage, element).slice(0, 20).map(candidate => ({
            visible: DOM.visible(candidate), text: text(candidate), className: String(candidate.className),
            ariaCurrent: candidate.getAttribute('aria-current') })),
          outerHTML: element.outerHTML.slice(0, 16000),
        })) };
    }
    function fail(code, message, issue) {
      throw Object.assign(new HelperError(code, message), { details: diagnostics(issue) });
    }
    function read() {
      const found = all(Config.selectors.pagination).filter(DOM.visible);
      if (!found.length) return { number: 1, total: null, next: null, prev: null, source: 'no_paginator', size: null };
      if (found.length !== 1) fail('PAGE_AMBIGUOUS', '评价分页器不唯一，已停止。', 'multiple_paginators');
      const pagination = found[0];
      const active = all(Config.selectors.activePage, pagination).filter(DOM.visible);
      if (active.length > 1) fail('PAGE_AMBIGUOUS', '当前页码存在多个可见标记，已停止。', 'multiple_active_markers');
      const activeText = active.length ? text(active[0]) : '';
      const markerNumber = activeText && /^[1-9]\d*$/.test(activeText) ? Number(activeText) : null;
      if (active.length && !Number.isSafeInteger(markerNumber)) {
        fail('PAGE_UNREADABLE', '当前高亮页码不可读取，已停止。', 'invalid_active_marker');
      }
      // 交接历史分页DOM：data-status="beast-core-pagination-10-1"（每页条数-当前页）。
      // 仅接受该完整格式；有高亮页码时必须一致，不推测第一页或借用跳页输入框。
      const rawStatus = pagination.getAttribute('data-status') || '';
      const status = /^beast-core-pagination-([1-9]\d*)-([1-9]\d*)$/.exec(rawStatus);
      const size = status ? Number(status[1]) : null;
      const statusNumber = status ? Number(status[2]) : null;
      if (rawStatus.startsWith('beast-core-pagination-') &&
          (!status || !Number.isSafeInteger(size) || !Number.isSafeInteger(statusNumber))) {
        fail('PAGE_UNREADABLE', '分页组件状态中的条数或页码不可确认，已停止。', 'invalid_component_status');
      }
      if (markerNumber !== null && statusNumber !== null && markerNumber !== statusNumber) {
        fail('PAGE_AMBIGUOUS', '高亮页码与分页组件状态不一致，已停止。', 'conflicting_page_evidence');
      }
      const number = markerNumber ?? statusNumber;
      if (number === null) {
        fail('PAGE_UNREADABLE', '当前页码无可见标记且分页组件状态不可读取，已停止。', 'missing_page_evidence');
      }
      const totals = all(Config.selectors.total, pagination).filter(DOM.visible);
      if (totals.length > 1) fail('PAGE_AMBIGUOUS', '分页结果总数不唯一，已停止。', 'multiple_totals');
      const totalMatch = totals.length && /共(?:有)?\s*([\d,]+)\s*条/.exec(text(totals[0]));
      const total = totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null;
      if (total !== null && (!Number.isSafeInteger(total) || total < 0 ||
          size !== null && number > Math.max(1, Math.ceil(total / size)))) {
        fail('PAGE_UNREADABLE', '分页页码或总数超出可确认范围，已停止。', 'page_out_of_range');
      }
      const arrow = direction => {
        const elements = all(`[data-testid="beast-core-pagination-${direction}"]`, pagination).filter(DOM.visible);
        if (elements.length > 1) fail('PAGE_AMBIGUOUS', '分页方向按钮不唯一，已停止。', `multiple_${direction}_buttons`);
        return elements[0] || null;
      };
      return { number, total, next: arrow('next'), prev: arrow('prev'), size,
        source: markerNumber !== null ? statusNumber !== null ? 'active_marker_and_component_status'
          : 'active_marker' : 'component_status' };
    }
    return Object.freeze({ read, diagnostics });
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
    function shopLabel() {
      // 仅作台账备注；读不到、重名或页头结构变化都不限制运行。
      const body = document.body.innerText;
      const end = body.indexOf('后台首页');
      const lines = (end >= 0 ? body.slice(0, end) : '').split('\n').map(line => line.trim()).filter(Boolean);
      const names = [...new Set(lines.filter(line =>
        !/[：:]/.test(line) && lines.some(other => other.startsWith(`${line}：`) || other.startsWith(`${line}:`))))];
      return names.length === 1 ? names[0] : '';
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
    const recordKey = ({ order, goodsId, time }) => JSON.stringify([order, goodsId, time]);
    function identity(group, shopName = '') {
      const row = one(Config.selectors.row, '评价正文行', group);
      const wrapper = one(Config.selectors.content, '评价正文容器', row);
      const orderValues = [...new Set([...group.innerText.matchAll(/订单编号[：:]\s*([\d-]+)/g)].map(match => match[1]))];
      const goodsText = text(one('.goods-id', '评价商品ID', group));
      const goodsId = /^(?:ID|商品ID)\s*[：:]\s*(\d+)$/i.exec(goodsText)?.[1];
      const reading = ReviewTime.read(wrapper, { order: orderValues.length === 1 ? orderValues[0] : null,
        goodsId: goodsId || null });
      const time = reading.value;
      if (orderValues.length !== 1 || !goodsId) {
        throw new HelperError('INCOMPLETE_RECORD', '评价身份或全文不可读取，检查/回复停止。');
      }
      return { shop: shopName, order: orderValues[0], goodsId, time, timeDiagnostics: reading.diagnostics,
        key: recordKey({ order: orderValues[0], goodsId, time }) };
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
      const matches = groups().filter(group => identity(group, recordValue.shop).key === recordValue.key);
      if (matches.length > 1) throw new HelperError('DUPLICATE_RECORD', '当前页评价身份重复，已停止。');
      return matches[0] || null;
    }
    const page = ReviewPagination.read;
    const canTurn = (element) => Boolean(element && DOM.enabled(element) && !/PGT_disabled/.test(element.className));
    function busy() {
      const root = DOM.root();
      return !root || !table(true) || all(Config.selectors.loading, root).some(DOM.visible) ||
        /加载中|正在加载/.test(text(table()));
    }
    function tableFingerprint() {
      return JSON.stringify({ text: table().innerText, groups: groups().map(group => group.innerText) });
    }
    function listDiagnostics() {
      const values = table(true) ? groups() : [];
      return { visibleRecordCount: values.length, truncated: values.length > 20,
        identities: values.slice(0, 20).map(group => {
          try {
            const { order, goodsId, time } = identity(group);
            return { order, goodsId, time };
          } catch (error) {
            return { error: { code: error.code || error.name, message: error.message, details: error.details } };
          }
        }) };
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
        element.innerText === rec.replyText && !element.closest(Config.selectors.content));
    }
    return Object.freeze({ all, text, one, shopLabel, form, goods, queryButton, setValue,
      filterSignature, recordKey, record, eligible, table, groups, find, page, canTurn, busy,
      tableFingerprint, listDiagnostics, fingerprint, empty,
      replyLink, modals, modal, successMessages, replyEcho });
  })();

  const Ledger = (() => {
    function read(store, key, fallback) {
      try {
        const value = store.getItem(key);
        return value ? JSON.parse(value) : fallback;
      } catch {
        throw new HelperError('STORAGE_UNAVAILABLE', '本机台账无法读取；操作停止。');
      }
    }
    function write(store, key, value) {
      try {
        const text = JSON.stringify(value);
        store.setItem(key, text);
        if (store.getItem(key) !== text) throw new Error('Persistence mismatch');
      } catch {
        throw new HelperError('STORAGE_UNAVAILABLE', '本机台账无法保存；操作停止。');
      }
    }
    function remove(store, key) {
      try {
        const existed = store.getItem(key) !== null;
        if (!existed) return false;
        store.removeItem(key);
        if (store.getItem(key) !== null) throw new Error('Removal mismatch');
        return existed;
      } catch {
        throw new HelperError('STORAGE_UNAVAILABLE', '待执行任务无法清除；请关闭当前标签页并检查浏览器存储，再重新启动。');
      }
    }
    function journal() {
      const data = read(localStorage, Config.journalKey, { schema: 1, entries: {} });
      if (data.schema !== 1 || !data.entries || typeof data.entries !== 'object' || Array.isArray(data.entries)) {
        throw new HelperError('INVALID_JOURNAL', '回复台账格式异常，需人工核查。');
      }
      if (Object.entries(data.entries).some(([key, entry]) => !entry || entry.key !== key ||
          (entry.shop !== undefined && typeof entry.shop !== 'string') ||
          ![entry.order, entry.goodsId, entry.time].every(value => typeof value === 'string' && value.length) ||
          !['submitting', 'submitted_unverified', 'confirmed',
            'not_replied_user_verified'].includes(entry.status))) {
        throw new HelperError('INVALID_JOURNAL', '回复台账含未知状态或不完整身份，需人工核查。');
      }
      return data;
    }
    function previous(rec, data = journal()) {
      // 旧版key含店铺名；用原记录字段兼容读取，不删除旧条目或核验依据。
      const entries = Object.values(data.entries).filter(entry => ReviewDOM.recordKey(entry) === rec.key);
      return entries.find(entry => ['submitting', 'submitted_unverified'].includes(entry.status)) ||
        entries.find(entry => entry.status === 'confirmed') ||
        entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))[0];
    }
    function submission(rec, status, evidence = '') {
      const data = journal();
      const prior = previous(rec, data);
      const history = prior ? [...(prior.history || []),
        { status: prior.status, at: prior.at, evidence: prior.evidence,
          manualVerification: prior.manualVerification, key: prior.key }] : [];
      data.entries[rec.key] = { key: rec.key, shop: rec.shop, order: rec.order, goodsId: rec.goodsId,
        time: rec.time, status, replyText: rec.replyText, at: new Date().toISOString(), evidence, history };
      write(localStorage, Config.journalKey, data);
      rec.status = status;
      rec.evidence = evidence;
    }
    function saveBatch(batch) {
      batch.summary = {
        checked: batch.records.length,
        replied: batch.records.filter(rec => rec.status === 'confirmed').length,
        skipped: batch.records.filter(rec => rec.status?.startsWith('skipped_')).length,
      };
      write(sessionStorage, Config.batchKey, batch);
    }
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
    return Object.freeze({ read, write, remove, journal, previous, submission, saveBatch, lastBatch, resolve, exportData });
  })();

  const Templates = (() => {
    const defaults = () => ({ replyText: Config.replyText, reportText: Config.reportText });
    function validate(kind, text) {
      const min = kind === 'reply' ? 1 : 20;
      const max = kind === 'reply' ? 200 : 500;
      if (!['reply', 'report'].includes(kind) || typeof text !== 'string' ||
          !text.trim() || text.length < min || text.length > max) {
        throw new HelperError('INVALID_TEMPLATE',
          `${kind === 'reply' ? '回复' : '举报'}文案须为${min}～${max}字，不能只有空白。`);
      }
      return text; // 原样保存空白和换行；提交时不擅自改写。
    }
    function snapshot() {
      const value = Ledger.read(localStorage, Config.templatesKey, null);
      if (value === null) return defaults();
      if (value.schema !== 1) throw new HelperError('INVALID_TEMPLATE', '本机文案配置格式异常，请重新保存文案。');
      return { replyText: validate('reply', value.replyText), reportText: validate('report', value.reportText) };
    }
    function save(kind, text) {
      if (Actions.status().busy) throw new HelperError('BUSY', '任务运行中不能保存文案。');
      validate(kind, text);
      let previous;
      try { previous = snapshot(); } catch (error) {
        if (error.code !== 'INVALID_TEMPLATE') throw error;
        previous = defaults();
      }
      const value = { ...previous, [`${kind}Text`]: text };
      Ledger.write(localStorage, Config.templatesKey, { schema: 1, ...value });
      return value;
    }
    return Object.freeze({ defaults, validate, snapshot, save,
      reset: kind => save(kind, defaults()[`${kind}Text`]) });
  })();

  const Results = (() => {
    async function currentTableStable(options) {
      let last;
      return Wait.until(() => {
        if (ReviewDOM.busy()) { last = undefined; return false; }
        const signature = ReviewDOM.tableFingerprint();
        if (signature !== last) { last = signature; return false; }
        if (!ReviewDOM.groups().length &&
            !/暂无(?:数据|评价|相关记录)|没有(?:评价|数据|相关记录)|无查询结果/.test(ReviewDOM.text(ReviewDOM.table()))) return false;
        return { signature };
      }, { ...options, timeoutMs: Config.resultTimeoutMs, stableMs: Config.resultStableMs,
        description: '等待当前可见评价列表稳定以核验举报' });
    }
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
    async function transition(click, options, targetPage, currentTableOnly = false) {
      const fingerprint = currentTableOnly ? ReviewDOM.tableFingerprint : ReviewDOM.fingerprint;
      const before = fingerprint();
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
          if (ReviewDOM.busy()) { activity = true; return false; }
          if (fingerprint() !== before) activity = true;
          if (currentTableOnly) return activity;
          const page = ReviewDOM.page();
          return activity && (targetPage === undefined || page.number === targetPage);
        }, { ...options, timeoutMs: Config.resultTimeoutMs, stableMs: 0,
          description: `等待查询/翻页完成${targetPage ? `（第${targetPage}页）` : ''}` });
        return await (currentTableOnly ? currentTableStable(options) : stable(options));
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
    // 每次只读取当前页。身份用于去重及提交前核对，不预采集或跨页找固定记录。
    function nextRecord(seen, shop) {
      const records = ReviewDOM.groups().map(group => ReviewDOM.record(group, shop));
      const keys = records.map(rec => rec.key);
      if (new Set(keys).size !== keys.length) {
        throw new HelperError('DUPLICATE_RECORD', '当前页存在重复评价身份，已停止。');
      }
      return records.find(rec => !seen.has(rec.key)) || null;
    }
    return Object.freeze({ currentTableStable, stable, transition,
      transitionCurrentTable: (click, options) => transition(click, options, undefined, true),
      first, turn, nextRecord });
  })();

  const Replies = (() => {
    async function submit(rec, batch, options) {
      rec.replyText = batch.templates.replyText;
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
      if (rec.replyText.length > 200 || input.maxLength > 0 && input.maxLength < rec.replyText.length) {
        throw new HelperError('REPLY_TOO_LONG', '统一回复超过输入限制。');
      }
      ReviewDOM.setValue(input, rec.replyText);
      await Wait.until(() => {
        const modal = ReviewDOM.modal();
        const current = ReviewDOM.one(Config.selectors.replyInput, '回复输入框', modal);
        const button = ReviewDOM.one(Config.selectors.replyButton, '提交回复按钮', modal);
        return current.value === rec.replyText && DOM.enabled(button);
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
        if (current.value !== rec.replyText || !DOM.enabled(button)) {
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
        Actions.update({ message: `已检查${batch.summary.checked}条；确认回复${batch.summary.replied}条；跳过${batch.summary.skipped}条。` });
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

  const Rating = (() => {
    const iconSelector = '[data-testid="beast-core-icon-star_filled"]';
    // 图标形状并不代表分数；同一种实心SVG也可能被画成灰色，或在裁切层中隐藏。
    function fraction(icon, root) {
      const original = icon.getBoundingClientRect();
      if (!DOM.visible(icon)) return 0;
      let left = original.left, right = original.right, top = original.top, bottom = original.bottom;
      for (let node = icon; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (Number(style.opacity) < 0.95) return 0;
        if (node !== icon) {
          const box = node.getBoundingClientRect();
          if (/^(hidden|clip|auto|scroll)$/.test(style.overflowX)) {
            left = Math.max(left, box.left); right = Math.min(right, box.right);
          }
          if (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)) {
            top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom);
          }
        }
        if (node === root) break;
      }
      return Math.round(Math.max(0, right - left) * Math.max(0, bottom - top)
        / (original.width * original.height) * 1000) / 1000;
    }
    function color(value) {
      const match = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(value);
      if (!match || Number(match[4] ?? 1) < 0.95) return 'unknown';
      const [r, g, b] = match.slice(1, 4).map(Number);
      if (r >= 140 && r - g >= 45 && r - b >= 45) return 'active';
      if (Math.min(r, g, b) >= 80 && Math.max(r, g, b) - Math.min(r, g, b) <= 15) return 'inactive';
      return 'unknown';
    }
    function iconState(icon, root) {
      const visibleFraction = fraction(icon, root);
      const shapes = ReviewDOM.all('path, polygon, rect, circle, use', icon);
      const paints = (shapes.length ? shapes : [icon]).map(shape => {
        const style = getComputedStyle(shape);
        return style.fill === 'none' ? style.stroke : style.fill;
      });
      const states = paints.map(color);
      const state = visibleFraction === 0 ? 'hidden' : visibleFraction < 0.98 ? 'partial'
        : states.every(value => value === 'active') ? 'active'
        : states.every(value => value === 'inactive') ? 'inactive' : 'unknown';
      return { state, visibleFraction, paints, color: getComputedStyle(icon).color };
    }
    function read(root) {
      const rates = root.matches('[data-testid="beast-core-rate"]') ? [root]
        : ReviewDOM.all('[data-testid="beast-core-rate"]', root).filter(DOM.visible);
      const result = { value: null, source: null, issue: '', rateCount: rates.length,
        svgCount: 0, visibleSvgCount: 0, declared: [], itemClasses: [], icons: [] };
      if (rates.length > 1) return { ...result, svgCount: ReviewDOM.all(iconSelector, root).length,
        issue: 'multiple_rating_controls' };
      const area = rates[0] || root;
      const icons = ReviewDOM.all(iconSelector, area);
      const states = icons.map(icon => iconState(icon, area));
      result.svgCount = icons.length;
      result.visibleSvgCount = states.filter(icon => icon.visibleFraction > 0).length;
      result.icons = states.slice(0, 12);
      const items = ReviewDOM.all('li', area).filter(DOM.visible);
      result.itemClasses = items.slice(0, 5).map(item => String(item.className).slice(0, 200));
      const candidates = [];
      if (rates.length) {
        const values = [area, ...ReviewDOM.all('[role="slider"][aria-valuenow]', area).filter(DOM.visible)];
        for (const element of values) {
          for (const attribute of ['aria-valuenow', 'data-score', 'data-value']) {
            if (!element.hasAttribute(attribute)) continue;
            const raw = element.getAttribute(attribute);
            result.declared.push({ attribute, raw });
            if (!/^[1-5](?:\.0+)?$/.test(raw)) return { ...result, issue: 'invalid_declared_score' };
            candidates.push({ source: attribute, value: Number(raw) });
          }
        }
      }
      if (items.some(item => /(?:^|\s)Rate_iconHalf_/.test(item.className))) {
        return { ...result, issue: 'partial_star' };
      }
      const full = items.filter(item => /(?:^|\s)Rate_iconFull_/.test(item.className)).length;
      if (full && items.length <= 5) candidates.push({ source: 'full_star_classes', value: full });
      // 有双层图标时按每个li去重；完整红色层优先于下方灰色背景层。
      const slots = items.length ? items.map(item => icons.map((icon, index) =>
        item.contains(icon) ? states[index].state : null).filter(Boolean)) : states.map(icon => [icon.state]);
      const painted = slots.filter(slot => slot.some(state => state !== 'hidden'))
        .map(slot => slot.includes('partial') ? 'partial'
        : slot.includes('active') ? 'active' : slot.includes('inactive') ? 'inactive' : 'unknown');
      if (painted.includes('partial')) return { ...result, issue: 'partial_star' };
      if (painted.length && painted.length <= 5 &&
          painted.every(state => ['active', 'inactive'].includes(state))) {
        candidates.push({ source: 'painted_stars', value: painted.filter(state => state === 'active').length });
      }
      if (!candidates.length) return { ...result, issue: 'score_unreadable' };
      if (new Set(candidates.map(candidate => candidate.value)).size !== 1) {
        return { ...result, issue: 'conflicting_score_evidence', candidates };
      }
      if (!Number.isInteger(candidates[0].value) || candidates[0].value < 1 || candidates[0].value > 5) {
        return { ...result, issue: 'score_not_ready' };
      }
      return { ...result, ...candidates[0] };
    }
    return Object.freeze({ read });
  })();

  const ReportDOM = (() => {
    const starLabels = ['1星', '2星', '3星', '4星', '5星'];
    const eligible = (rec, strategy) => strategy === 'one-star-all'
      ? rec.star === 1 : rec.content === Config.reportContent;
    async function toggle(label, selected, options) {
      options.guard();
      const element = DOM.resolve(label);
      if (!element) throw new HelperError('MISSING_FILTER', `找不到“${label}”筛选。`);
      if (DOM.selected(element) !== selected) {
        if (!DOM.enabled(element)) throw new HelperError('DISABLED_TARGET', `“${label}”不可点击。`);
        element.click();
      }
      await Wait.until(() => {
        const current = DOM.resolve(label);
        return current && DOM.selected(current) === selected;
      }, { ...options, description: `核验“${label}”${selected ? '选中' : '取消'}` });
    }
    async function selectStar(label, options) {
      for (const other of starLabels.filter(value => value !== label)) {
        const element = DOM.resolve(other);
        if (element && DOM.selected(element)) await toggle(other, false, options);
      }
      // 举报不限回复状态；清除自动回复模式遗留的限制。
      for (const replyState of ['未回复', '已回复']) {
        const element = DOM.resolve(replyState);
        if (element && DOM.selected(element)) await toggle(replyState, false, options);
      }
      await toggle(label, true, options);
      if (starLabels.some(other => other !== label && DOM.resolve(other) && DOM.selected(DOM.resolve(other))) ||
          ['未回复', '已回复'].some(other => DOM.resolve(other) && DOM.selected(DOM.resolve(other)))) {
        throw new HelperError('CONFLICTING_FILTERS', '举报星级或回复状态筛选有冲突，已停止。');
      }
    }
    function stars(group) {
      const header = group.querySelector('.evaluation-item-header') || group;
      return Rating.read(header).value;
    }
    function current(rec, star) {
      const group = ReviewDOM.find(rec);
      if (!group || ReviewDOM.record(group, rec.shop).content !== rec.content ||
          !eligible(rec, rec.strategy) || stars(group) !== star) {
        throw new HelperError('REPORT_RECORD_CHANGED', '举报前评价身份、正文或星级变化，已停止。');
      }
      return group;
    }
    function inspectModal(rec, star, stage) {
      const modals = ReviewDOM.modals();
      const element = modals.length === 1 ? modals[0] : null;
      const title = element ? ReviewDOM.text(element.querySelector(Config.selectors.modalTitle)) : '';
      const details = element ? ReviewDOM.all(Config.selectors.reportDetail, element).filter(DOM.visible) : [];
      const rating = element ? Rating.read(element) : null;
      const data = { stage, expectedContent: rec.content,
        actualContent: details.length === 1 ? details[0].innerText : null,
        expectedStar: star, actualStar: rating?.value ?? null, modalCount: modals.length,
        modalTitle: title, detailCount: details.length, rating };
      rec.reportDiagnostics = { ...data, observedAt: new Date().toISOString() };
      return { element, data, matches: Boolean(element && title === '举报该评价' &&
        details.length === 1 && data.actualContent === rec.content && rating.value === star) };
    }
    function modalError(data) {
      let code, message;
      if (data.modalCount !== 1 || data.modalTitle !== '举报该评价') {
        code = 'UNEXPECTED_REPORT_MODAL'; message = '未出现唯一“举报该评价”弹框，已停止。';
      } else if (data.detailCount > 1 || data.rating?.rateCount > 1) {
        code = 'DOM_NOT_UNIQUE'; message = '举报弹框正文或评分控件不唯一。';
      } else if (data.actualContent !== null && data.actualContent !== data.expectedContent) {
        code = 'REPORT_MODAL_CONTENT_MISMATCH'; message = '举报弹框正文与列表原文不符；实际值已保存到台账。';
      } else if (data.actualStar !== null && data.actualStar !== data.expectedStar) {
        code = 'REPORT_MODAL_STAR_MISMATCH';
        message = `举报弹框星级不符：预期${data.expectedStar}星，实际${data.actualStar}星。`;
      } else if (data.actualContent === null) {
        code = 'REPORT_MODAL_NOT_READY'; message = '举报弹框正文未加载完成；读取状态已保存到台账。';
      } else {
        code = 'REPORT_MODAL_STAR_UNREADABLE'; message = '无法确认举报弹框实际星级；图标和评分状态已保存到台账。';
      }
      return Object.assign(new HelperError(code, message), { details: data });
    }
    function modal(rec, star, stage = 'form_check') {
      const reading = inspectModal(rec, star, stage);
      if (!reading.matches) throw modalError(reading.data);
      return reading.element;
    }
    async function waitModal(rec, star, options, stage, ready = () => true) {
      let signature;
      try {
        return await Wait.until(() => {
          const reading = inspectModal(rec, star, stage);
          if (reading.data.modalCount > 1 || reading.data.modalTitle &&
              reading.data.modalTitle !== '举报该评价' || reading.data.detailCount > 1 ||
              reading.data.rating?.rateCount > 1) throw modalError(reading.data);
          const current = JSON.stringify(reading.data);
          if (current !== signature) { signature = current; return false; }
          return reading.matches && ready(reading.element) && reading.element;
        }, { ...options, description: '等待举报弹框正文、星级和表单状态稳定' });
      } catch (error) {
        const data = rec.reportDiagnostics;
        if (error.code === 'TIMEOUT' && data && (data.actualContent !== data.expectedContent ||
            data.actualStar !== data.expectedStar)) throw modalError(data);
        if (data && !error.details) error.details = data;
        throw error;
      }
    }
    function reason(element) {
      const labels = ReviewDOM.all(Config.selectors.reportReason, element)
        .filter(label => DOM.visible(label) && ReviewDOM.text(label) === Config.reportReason &&
          label.querySelector('input[data-tracking-viewid="bad_peer_reviews"]'));
      if (labels.length !== 1) throw new HelperError('REPORT_REASON_UNAVAILABLE', '同行恶意差评选项不可唯一定位。');
      return labels[0];
    }
    function reasonSelected(element) {
      const label = reason(element);
      return label.dataset.checked === 'true' && label.querySelector('input').checked;
    }
    function acceptedStatus(group) {
      const headers = ReviewDOM.all('.evaluation-item-header', group).filter(DOM.visible);
      if (headers.length !== 1) return { accepted: false, text: '', headerCount: headers.length };
      const matches = ReviewDOM.all('*', headers[0]).filter(element =>
        DOM.visible(element) && /^已举报[，,]\s*待审核$/.test(ReviewDOM.text(element)));
      const texts = [...new Set(matches.map(ReviewDOM.text))];
      const linkCount = ReviewDOM.all(Config.selectors.reportLink, group).filter(DOM.visible).length;
      return { accepted: texts.length === 1 && linkCount === 0, text: texts.join(' | '),
        headerCount: headers.length, linkCount };
    }
    function submissionState(rec, freshSuccess = false) {
      const data = { stage: 'after_submit', key: rec.key, modalCount: ReviewDOM.modals().length,
        freshSuccess, rowFound: false, contentMatches: false, expectedStar: rec.star,
        actualStar: null, status: null, rowError: null,
        notices: [...new Set(ReviewDOM.all('[role="alert"], [role="status"], [data-testid*="toast"], [data-testid*="message"]')
          .filter(DOM.visible).map(ReviewDOM.text).filter(Boolean))].slice(0, 8).map(value => value.slice(0, 500)) };
      try {
        const group = ReviewDOM.find(rec);
        if (group) {
          data.rowFound = true;
          data.contentMatches = ReviewDOM.record(group, rec.shop).content === rec.content;
          data.actualStar = stars(group);
          data.status = acceptedStatus(group);
        }
      } catch (error) {
        data.rowError = { code: error.code || error.name, message: error.message, details: error.details };
      }
      if (!data.rowFound) data.list = ReviewDOM.listDiagnostics();
      data.evidence = data.modalCount === 0 && data.contentMatches &&
        data.actualStar === rec.star && data.status?.accepted ? 'record_report_accepted'
        : data.modalCount === 0 && freshSuccess ? 'fresh_report_success' : '';
      return data;
    }
    function reported(group) {
      const region = group.querySelector('[data-tracking-click-viewid="report"]');
      return acceptedStatus(group).accepted ||
        Boolean(region && /^(?:已举报|举报处理中|举报成功)$/.test(ReviewDOM.text(region)));
    }
    function successMessages() {
      return ReviewDOM.all('div, span, p, [role="status"], [role="alert"]').filter(element =>
        DOM.visible(element) && /^举报成功[！!。]?$/.test(ReviewDOM.text(element)) &&
        !element.closest(Config.selectors.table) && !element.closest(Config.selectors.modal) &&
        !element.querySelector('input, textarea'));
    }
    return Object.freeze({ eligible, toggle, selectStar, stars, current, modal, waitModal, reason,
      reasonSelected, reported, acceptedStatus, submissionState, successMessages });
  })();

  const ReportLedger = (() => {
    const statuses = ['submitting', 'submitted_unverified', 'confirmed', 'not_submitted_user_verified'];
    const day = () => {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      const get = type => parts.find(part => part.type === type).value;
      return `${get('year')}-${get('month')}-${get('day')}`;
    };
    function journal() {
      const data = Ledger.read(localStorage, Config.reportJournalKey, { schema: 1, attempts: [] });
      if (data?.schema !== 1 || !Array.isArray(data.attempts) ||
          data.attempts.some(entry => !entry || !statuses.includes(entry.status) ||
            typeof entry.id !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day) ||
            ![entry.order, entry.goodsId, entry.time].every(value => typeof value === 'string' && value.length) ||
            entry.key !== ReviewDOM.recordKey(entry)) ||
          new Set(data.attempts.map(entry => entry.id)).size !== data.attempts.length) {
        throw new HelperError('INVALID_REPORT_JOURNAL', '举报台账格式异常，未开始提交。');
      }
      return data;
    }
    function stats(data = journal()) {
      return { confirmed: data.attempts.filter(entry => entry.status === 'confirmed').length,
        uncertain: data.attempts.filter(entry => ['submitting', 'submitted_unverified'].includes(entry.status)).length };
    }
    function previous(rec) {
      const entries = journal().attempts.filter(entry => entry.key === rec.key);
      return entries.find(entry => ['submitting', 'submitted_unverified'].includes(entry.status)) ||
        entries.find(entry => entry.status === 'confirmed') || null;
    }
    function reserve(rec, batch) {
      const data = journal();
      if (data.attempts.some(entry => entry.key === rec.key && entry.status !== 'not_submitted_user_verified')) {
        throw new HelperError('REPORT_ALREADY_SUBMITTED', '当前身份已有举报提交，未重复发送。');
      }
      const entry = { id: crypto.randomUUID(), key: rec.key, shop: rec.shop, order: rec.order,
        goodsId: rec.goodsId, time: rec.time, star: rec.star, day: day(), status: 'submitting',
        content: rec.content, strategy: batch.strategy, reportText: rec.reportText,
        reason: Config.reportReason, at: new Date().toISOString(), history: [] };
      data.attempts.push(entry);
      Ledger.write(localStorage, Config.reportJournalKey, data);
      rec.attemptId = entry.id;
      rec.status = 'submitting';
      return entry.id;
    }
    function update(rec, status, evidence = '') {
      const data = journal();
      const entry = data.attempts.find(value => value.id === rec.attemptId);
      if (!entry || !['submitting', 'submitted_unverified'].includes(entry.status)) {
        throw new HelperError('REPORT_JOURNAL_CHANGED', '举报提交台账变化，需人工核验。');
      }
      entry.history.push({ status: entry.status, at: entry.at, evidence: entry.evidence });
      Object.assign(entry, { status, evidence, at: new Date().toISOString() });
      if (rec.submissionDiagnostics) entry.submissionDiagnostics = rec.submissionDiagnostics;
      Ledger.write(localStorage, Config.reportJournalKey, data);
      rec.status = status;
      rec.evidence = evidence;
    }
    function saveBatch(batch) {
      batch.summary = { checked: batch.records.length,
        reported: batch.records.filter(rec => rec.status === 'confirmed').length,
        skipped: batch.records.filter(rec => rec.status?.startsWith('skipped_')).length };
      Ledger.write(sessionStorage, Config.reportBatchKey, batch);
    }
    const lastBatch = () => Ledger.read(sessionStorage, Config.reportBatchKey, null);
    function exportData() {
      const blob = new Blob([JSON.stringify({ mode: 'report', stats: stats(), batch: lastBatch(),
        journal: journal() }, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `pdd-evaluation-reports-${Date.now()}.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function resolve(id, verdict, note) {
      if (Actions.status().busy) throw new HelperError('BUSY', '任务期间不能修改举报台账。');
      if (!['confirmed', 'not_submitted_user_verified'].includes(verdict) || !String(note || '').trim()) {
        throw new HelperError('INVALID_RESOLUTION', '人工核验必须明确结论并填写依据。');
      }
      if (!navigator.locks?.request) throw new HelperError('LOCK_UNAVAILABLE', '浏览器不支持运行锁。');
      return navigator.locks.request(Config.lockName, { ifAvailable: true }, lock => {
        if (!lock) throw new HelperError('OTHER_TAB_BUSY', '其他标签页正在运行，无法人工核验。');
        const data = journal();
        const entry = data.attempts.find(value => value.id === id);
        if (!entry || !['submitting', 'submitted_unverified'].includes(entry.status)) {
          throw new HelperError('NO_UNCERTAIN_ENTRY', '没有该提交对应的未知举报。');
        }
        entry.history.push({ status: entry.status, at: entry.at, evidence: entry.evidence });
        entry.status = verdict;
        entry.at = new Date().toISOString();
        entry.manualVerification = { note: String(note), at: entry.at };
        Ledger.write(localStorage, Config.reportJournalKey, data);
        return { ...entry };
      });
    }
    async function reconcile(options) {
      const uncertain = journal().attempts.filter(entry =>
        ['submitting', 'submitted_unverified'].includes(entry.status));
      if (!uncertain.length) return [];
      await Wait.until(() => ReviewDOM.table(true),
        { ...options, timeoutMs: Config.resultTimeoutMs, description: '等待核验待确认举报的当前列表' });
      await Results.currentTableStable(options);
      let signature;
      const observations = await Wait.until(() => {
        if (ReviewDOM.busy()) { signature = undefined; return false; }
        const values = uncertain.map(entry => ({ id: entry.id,
          reading: ReportDOM.submissionState({ ...entry, content: entry.content ?? Config.reportContent }) }));
        const current = JSON.stringify({ table: ReviewDOM.tableFingerprint(), values });
        if (current !== signature) { signature = current; return false; }
        return values;
      }, { ...options, description: '核验同一评价的已举报待审核状态' });
      options.guard();
      const data = journal();
      const recovered = [];
      for (const { id, reading } of observations) {
        const entry = data.attempts.find(value => value.id === id);
        if (!entry || !['submitting', 'submitted_unverified'].includes(entry.status)) {
          throw new HelperError('REPORT_JOURNAL_CHANGED', '核验期间举报台账变化，已停止。');
        }
        entry.submissionDiagnostics = { ...reading, stage: 'reconcile', observedAt: new Date().toISOString() };
        let validText = false;
        try { Templates.validate('report', entry.reportText); validText = true; } catch { /* 未知文案不自动恢复。 */ }
        if (reading.evidence !== 'record_report_accepted' || !validText ||
            entry.reason !== Config.reportReason || ![1, 2, 3].includes(entry.star)) continue;
        entry.history = [...(entry.history || []),
          { status: entry.status, at: entry.at, evidence: entry.evidence }];
        Object.assign(entry, { status: 'confirmed', evidence: 'record_report_accepted',
          at: new Date().toISOString(), verification: { source: 'current_record_status',
            statusText: reading.status.text } });
        recovered.push({ ...entry, attemptId: entry.id, content: entry.content ?? Config.reportContent, recovered: true });
      }
      Ledger.write(localStorage, Config.reportJournalKey, data);
      return recovered;
    }
    return Object.freeze({ day, journal, stats, previous, reserve, update, saveBatch, lastBatch,
      exportData, resolve, reconcile });
  })();

  const Reports = (() => {
    async function submit(rec, batch, options) {
      rec.reportText = batch.templates.reportText;
      options.guard();
      const group = ReportDOM.current(rec, rec.star);
      if (ReviewDOM.modals().length) throw new HelperError('EXISTING_MODAL', '页面已有弹框，举报停止。');
      const link = ReviewDOM.one(Config.selectors.reportLink, '当前评价举报入口', group);
      if (!DOM.enabled(link) || ReviewDOM.text(link) !== '举报') {
        throw new HelperError('REPORT_LINK_UNAVAILABLE', '当前评价举报入口不可点击。');
      }
      link.scrollIntoView({ block: 'center', behavior: 'instant' });
      link.click();
      await ReportDOM.waitModal(rec, rec.star, options, 'opened');
      ReportDOM.current(rec, rec.star);
      const choice = ReportDOM.reason(ReportDOM.modal(rec, rec.star));
      if (!DOM.enabled(choice) || !DOM.enabled(choice.querySelector('input'))) {
        throw new HelperError('REPORT_REASON_UNAVAILABLE', '同行恶意差评选项不可用。');
      }
      if (!ReportDOM.reasonSelected(ReportDOM.modal(rec, rec.star))) choice.click();
      await ReportDOM.waitModal(rec, rec.star, options, 'reason_selected', modal => {
        return ReportDOM.reasonSelected(modal) && modal.querySelector(Config.selectors.reportInput);
      });
      const input = ReviewDOM.one(Config.selectors.reportInput, '举报说明输入框', ReportDOM.modal(rec, rec.star));
      if (input.value) throw new HelperError('EXISTING_REPORT_TEXT', '举报框已有说明，未覆盖或提交。');
      if (rec.reportText.length < 20 || rec.reportText.length > 500 ||
          input.maxLength > 0 && input.maxLength < rec.reportText.length) {
        throw new HelperError('REPORT_TOO_LONG', '统一举报文案不符合说明输入限制。');
      }
      ReviewDOM.setValue(input, rec.reportText);
      await ReportDOM.waitModal(rec, rec.star, options, 'text_filled', modal => {
        const button = ReviewDOM.one(Config.selectors.reportButton, '提交举报按钮', modal);
        return ReviewDOM.one(Config.selectors.reportInput, '举报说明', modal).value === rec.reportText &&
          ReportDOM.reasonSelected(modal) && DOM.enabled(button) &&
          button.getAttribute('data-tracking-click-params') === 'reason_type=8';
      });
      await Wait.until(() => !ReportDOM.successMessages().length,
        { ...options, description: '等待旧举报成功提示消失' });
      let armed = false;
      let freshSuccess = false;
      let lastReading;
      let signature;
      const observer = new MutationObserver(() => {
        if (armed && ReportDOM.successMessages().length) freshSuccess = true;
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      let submitted = false;
      try {
        options.guard();
        ReportDOM.current(rec, rec.star);
        const modal = ReportDOM.modal(rec, rec.star, 'before_submit');
        const button = ReviewDOM.one(Config.selectors.reportButton, '提交举报按钮', modal);
        if (!ReportDOM.reasonSelected(modal) ||
            ReviewDOM.one(Config.selectors.reportInput, '举报说明', modal).value !== rec.reportText ||
            !DOM.enabled(button) || button.getAttribute('data-tracking-click-params') !== 'reason_type=8') {
          throw new HelperError('REPORT_NOT_READY', '举报提交前表单状态改变。');
        }
        ReportLedger.reserve(rec, batch);
        ReportLedger.saveBatch(batch);
        submitted = true;
        armed = true;
        button.click();
        const evidence = await Wait.until(() => {
          if (ReportDOM.successMessages().length) freshSuccess = true;
          lastReading = ReportDOM.submissionState(rec, freshSuccess);
          rec.submissionDiagnostics = { ...lastReading, observedAt: new Date().toISOString() };
          const current = JSON.stringify(lastReading);
          if (current !== signature) { signature = current; return false; }
          return lastReading.evidence;
        }, { ...options, timeoutMs: Config.submissionTimeoutMs,
          description: '等待本次举报受理证据及弹框关闭' });
        ReportLedger.update(rec, 'confirmed', evidence);
        ReportLedger.saveBatch(batch);
        Actions.update({ message: `本次成功举报${batch.summary.reported}/${batch.target ?? '全部'}条；已检查${batch.summary.checked}条。` });
        await Results.stable(options);
      } catch (error) {
        if (submitted && rec.status !== 'confirmed') {
          rec.submissionDiagnostics = { ...(lastReading || ReportDOM.submissionState(rec, freshSuccess)),
            observedAt: new Date().toISOString(), waitError: { code: error.code || error.name,
              message: error.message } };
          ReportLedger.update(rec, 'submitted_unverified', error.code || error.message);
          ReportLedger.saveBatch(batch);
          throw Object.assign(new HelperError('REPORT_SUBMITTED_UNVERIFIED',
            '已发出一次举报但结果不明；未计成功，保留待核验记录并停止，请核验台账。'),
          { details: rec.submissionDiagnostics });
        }
        throw error;
      } finally { observer.disconnect(); }
    }
    return Object.freeze({ submit });
  })();

  const ReportWorkflow = (() => {
    async function execute(p, job, templates) {
      const options = job.options;
      const strategy = p.strategy || 'template';
      const starLabels = strategy === 'one-star-all' ? ['1星'] : Config.reportStars;
      const target = p.n ?? Infinity;
      const batch = { id: crypto.randomUUID(), version: Config.version, taskMode: 'report',
        startedAt: new Date().toISOString(), day: ReportLedger.day(), shop: '',
        params: p, templates, strategy, target: p.n, star: 1, phase: 'reconciling', records: [] };
      ReportLedger.saveBatch(batch);
      const originalGuard = options.guard;
      let filterSignature;
      options.guard = () => {
        originalGuard();
        if (filterSignature && ReviewDOM.filterSignature() !== filterSignature) {
          throw new HelperError('FILTER_CHANGED', '举报期间查询条件改变，已停止。');
        }
      };
      try {
        let pagePrepared = false;
        let queriedStar = null;
        let queriedGoods = null;
        let turns = 0;
        const turn = async direction => {
          if (++turns > Config.maxPages) throw new HelperError('PAGE_LIMIT', '举报翻页超过保护上限。');
          return Results.turn(direction, options);
        };
        const preparePage = async () => {
          if (pagePrepared) return;
          await Wait.until(() => DOM.root() && ReviewDOM.form(true) && ReviewDOM.table(true) &&
            starLabels.every(label => DOM.resolve(label)),
          { ...options, timeoutMs: Config.resultTimeoutMs, description: '等待评价举报页面加载' });
          batch.shop = ReviewDOM.shopLabel();
          if (ReviewDOM.modals().length) throw new HelperError('EXISTING_MODAL', '页面已有弹框，举报前停止。');
          const residuals = ReviewDOM.all('input, textarea', ReviewDOM.form()).filter(element =>
            DOM.visible(element) && element !== ReviewDOM.goods() && !element.readOnly &&
            !['checkbox', 'radio', 'button', 'submit', 'hidden'].includes(element.type) && element.value.trim());
          if (residuals.length) throw new HelperError('RESIDUAL_FILTER', '存在未指定的订单号或关键词，请清空后再举报。');
          pagePrepared = true;
        };
        const queryStar = async (label, reconciling = false, goodsId = p.goodsId) => {
          await preparePage();
          options.guard();
          filterSignature = undefined;
          if (ReviewDOM.goods().value !== goodsId) ReviewDOM.setValue(ReviewDOM.goods(), goodsId);
          await Wait.until(() => ReviewDOM.goods().value === goodsId, { ...options, description: '核验举报商品ID' });
          batch.star = Number(label[0]);
          batch.phase = 'querying';
          ReportLedger.saveBatch(batch);
          await ReportDOM.selectStar(label, options);
          filterSignature = ReviewDOM.filterSignature();
          batch.filters = JSON.parse(filterSignature);
          Actions.update({ message: reconciling ? `正在查询${label}，核验已有举报；核验完成前不新增提交。`
            : `正在查询${label}；本次目标成功举报${batch.target ?? '全部'}条。` });
          const clickQuery = () => {
            const button = ReviewDOM.queryButton();
            if (!DOM.enabled(button)) throw new HelperError('QUERY_DISABLED', '查询按钮不可用。');
            button.click();
          };
          if (reconciling) await Results.transitionCurrentTable(clickQuery, options);
          else await Results.transition(clickQuery, options, 1);
          batch.phase = reconciling ? 'reconciling' : 'reporting';
          ReportLedger.saveBatch(batch);
          queriedStar = label;
          queriedGoods = goodsId;
        };
        const uncertain = ReportLedger.journal().attempts.filter(entry =>
          ['submitting', 'submitted_unverified'].includes(entry.status));
        const recovered = [];
        const saveRecovered = () => {
          batch.reconciled = recovered.map(entry => ({ id: entry.id, day: entry.day, key: entry.key }));
          const eligible = recovered.filter(entry =>
            (!p.goodsId || entry.goodsId === p.goodsId) && ReportDOM.eligible(entry, strategy));
          batch.records = eligible.slice(0, target).map((entry, index) => ({ ...entry, rank: index + 1 }));
          ReportLedger.saveBatch(batch);
        };
        if (uncertain.length) {
          const highestUncertainStar = Math.max(...uncertain.map(entry =>
            [1, 2, 3].includes(entry.star) ? entry.star : 1));
          // 核验读取已有提交；指定商品以外的未知历史也需核验，临时查询商品不限。
          // 恢复完成后，新举报查询重新使用用户本次指定的商品。
          const recoveryGoods = p.goodsId && uncertain.some(entry => entry.goodsId !== p.goodsId) ? '' : p.goodsId;
          for (const label of starLabels.slice(0, highestUncertainStar)) {
            await queryStar(label, true, recoveryGoods);
            while (true) {
              recovered.push(...await ReportLedger.reconcile(options));
              saveRecovered();
              const pending = ReportLedger.journal().attempts.filter(entry =>
                ['submitting', 'submitted_unverified'].includes(entry.status) && entry.star === Number(label[0]));
              // 已找到但证据不足不扩大查找；尚未找到的同星级记录才继续翻页核验。
              if (!pending.length || pending.some(entry => entry.submissionDiagnostics?.rowFound) ||
                  !ReviewDOM.canTurn(ReviewDOM.page().next)) break;
              await turn('next');
            }
            if (!ReportLedger.journal().attempts.some(entry =>
              ['submitting', 'submitted_unverified'].includes(entry.status))) break;
          }
        }
        saveRecovered();
        if (ReportLedger.journal().attempts.some(entry => ['submitting', 'submitted_unverified'].includes(entry.status))) {
          throw new HelperError('UNRESOLVED_REPORT_HISTORY', '存在待核验举报提交，请先核验本机举报台账。');
        }
        if (batch.summary.reported >= target) {
          batch.stopReason = 'target_reached';
        } else {
          await preparePage();
          const seen = new Set(batch.records.map(rec => rec.key));
          for (const label of starLabels) {
            if (batch.summary.reported >= target) break;
            options.guard();
            if (queriedStar !== label || queriedGoods !== p.goodsId) await queryStar(label);
            else {
              while (ReviewDOM.page().number > 1) {
                if (!await turn('prev')) throw new HelperError('CANNOT_RETURN_FIRST', '核验后无法返回第一页。');
              }
              batch.star = Number(label[0]);
              batch.phase = 'reporting';
              ReportLedger.saveBatch(batch);
            }
            while (batch.summary.reported < target) {
              options.guard();
              await Results.stable(options);
              const current = Results.nextRecord(seen, batch.shop);
              if (!current) {
                if (!ReviewDOM.canTurn(ReviewDOM.page().next)) break;
                if (!ReviewDOM.groups().length) throw new HelperError('INCONSISTENT_EMPTY_PAGE', '举报空页仍可翻页。');
                await turn('next');
                continue;
              }
              const group = ReviewDOM.find(current);
              if (!group || ReportDOM.stars(group) !== batch.star) {
                throw new HelperError('REPORT_STAR_MISMATCH', '查询结果星级与当前处理星级不一致。');
              }
              if (p.goodsId && current.goodsId !== p.goodsId) {
                throw new HelperError('GOODS_FILTER_MISMATCH', '举报查询包含其他商品。');
              }
              const rec = { ...current, strategy, star: batch.star, rank: batch.records.length + 1, status: 'pending' };
              seen.add(rec.key);
              batch.records.push(rec);
              ReportLedger.saveBatch(batch);
              Actions.update({ message: `${label}：正在检查第${rec.rank}条；成功举报${batch.summary.reported}/${batch.target ?? '全部'}条。` });
              const prior = ReportLedger.previous(rec);
              if (prior && ['submitting', 'submitted_unverified'].includes(prior.status)) {
                throw new HelperError('UNRESOLVED_REPORT_HISTORY', '该评价存在未知举报，未重复提交。');
              }
              if (prior?.status === 'confirmed') rec.status = 'skipped_previously_reported';
              else if (!ReportDOM.eligible(rec, strategy)) rec.status = 'skipped_non_template';
              else if (ReportDOM.reported(group)) rec.status = 'skipped_already_reported';
              else await Reports.submit(rec, batch, options);
              ReportLedger.saveBatch(batch);
              Actions.update({ message: `${label}：成功举报${batch.summary.reported}/${batch.target ?? '全部'}条；检查${batch.summary.checked}条，跳过${batch.summary.skipped}条。` });
              if (rec.status === 'confirmed' && batch.summary.reported < target) {
                while (ReviewDOM.page().number > 1) {
                  if (!await turn('prev')) throw new HelperError('CANNOT_RETURN_FIRST', '举报后无法返回第一页。');
                }
              }
            }
          }
          batch.stopReason = batch.summary.reported >= target ? 'target_reached' : 'stars_exhausted';
        }
        batch.phase = 'completed';
        batch.completedAt = new Date().toISOString();
        ReportLedger.saveBatch(batch);
        const descriptions = { target_reached: '已达到本次成功举报目标',
          stars_exhausted: `${strategy === 'one-star-all' ? '1星' : '1星、2星、3星'}结果已全部处理，暂无需要处理的评价` };
        Actions.update({ tone: 'success', message: `举报结束：成功${batch.summary.reported}条，检查${batch.summary.checked}条，跳过${batch.summary.skipped}条。${descriptions[batch.stopReason]}。` });
        return { ok: true, ...batch.summary, stats: ReportLedger.stats(), batch };
      } catch (error) {
        batch.phase = 'stopped';
        batch.error = { code: error.code || error.name, message: error.message };
        if (error.details) batch.error.details = error.details;
        ReportLedger.saveBatch(batch);
        throw error;
      }
    }
    return Object.freeze({ execute });
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
      return { n, goodsId };
    }
    function reportParams(value = {}) {
      let p;
      try { p = params(value); } catch (error) {
        if (error.code === 'INVALID_N') throw new HelperError('INVALID_REPORT_N',
          '举报数量必须为正整数，留空处理全部符合条件的结果。');
        throw error;
      }
      if (value?.strategy !== undefined) {
        if (!['template', 'one-star-all'].includes(value.strategy)) {
          throw new HelperError('INVALID_REPORT_STRATEGY', '未知举报处理方式。');
        }
        if (value.strategy === 'one-star-all') p.strategy = value.strategy;
      }
      return p;
    }
    async function execute(p, job, templates) {
      const options = job.options;
      await Wait.until(() => Boolean(DOM.root() && DOM.snapshot().ready && ReviewDOM.form(true) && ReviewDOM.table(true)),
        { ...options, timeoutMs: Config.resultTimeoutMs, description: '等待评价页加载' });
      const shop = ReviewDOM.shopLabel();
      const initialGuard = options.guard;
      let filterSignature;
      options.guard = () => {
        initialGuard();
        if (filterSignature && ReviewDOM.filterSignature() !== filterSignature) {
          throw new HelperError('FILTER_CHANGED', '批次期间查询条件改变，已停止。');
        }
      };
      const batch = { id: crypto.randomUUID(), version: Config.version, startedAt: new Date().toISOString(),
        shop, params: p, templates, phase: 'querying', records: [] };
      Ledger.saveBatch(batch);
      try {
        // 从举报模式回到回复模式时，清除低星筛选，回复仍只选择4星、5星、未回复。
        for (const label of Config.reportStars) {
          const element = DOM.resolve(label);
          if (element && DOM.selected(element)) await ReportDOM.toggle(label, false, options);
        }
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
        Actions.update({ message: `查询商品${p.goodsId || '全部'}；检查${p.n ?? '全部'}条。` });
        await Results.transition(() => {
          const button = ReviewDOM.queryButton();
          if (!DOM.enabled(button)) throw new HelperError('QUERY_DISABLED', '查询按钮不可点击。');
          button.click();
        }, options, 1);
        await Results.first(options);
        batch.initialTotal = ReviewDOM.page().total;
        batch.mode = 'sequential';
        batch.phase = 'replying';
        Ledger.saveBatch(batch);
        const seen = new Set();
        let turns = 0;
        const turn = async direction => {
          if (++turns > Config.maxPages) throw new HelperError('PAGE_LIMIT', '翻页次数超过保护上限，批次停止。');
          return Results.turn(direction, options);
        };
        while (batch.records.length < (p.n ?? Infinity)) {
          options.guard();
          await Results.stable(options);
          const current = Results.nextRecord(seen, shop);
          if (!current) {
            const page = ReviewDOM.page();
            if (!ReviewDOM.canTurn(page.next)) break;
            if (!ReviewDOM.groups().length) throw new HelperError('INCONSISTENT_EMPTY_PAGE', '空页仍可翻页，分页结构需核查。');
            await turn('next');
            continue;
          }
          if (p.goodsId && current.goodsId !== p.goodsId) {
            throw new HelperError('GOODS_FILTER_MISMATCH', '查询结果包含其他商品，已停止。');
          }
          const rec = { ...current, rank: batch.records.length + 1,
            checkedPage: ReviewDOM.page().number, status: 'pending' };
          seen.add(rec.key);
          batch.records.push(rec);
          Ledger.saveBatch(batch);
          Actions.update({ message: `正在检查第${rec.rank}${p.n ? `/${p.n}` : ''}条，订单${rec.order}；已确认回复${batch.summary.replied}条。` });
          const prior = Ledger.previous(rec);
          if (prior && ['submitting', 'submitted_unverified'].includes(prior.status)) {
            throw new HelperError('UNRESOLVED_HISTORY', '当前记录存在未知提交，需先人工核验，未重复发送。');
          }
          if (prior?.status === 'confirmed') {
            rec.status = 'skipped_previously_confirmed';
          } else if (!ReviewDOM.eligible(rec.content)) {
            rec.status = 'skipped_non_template';
          } else {
            await Replies.submit(rec, batch, options);
          }
          Ledger.saveBatch(batch);
          Actions.update({ message: `已检查${batch.summary.checked}${p.n ? `/${p.n}` : ''}条；确认回复${batch.summary.replied}条；跳过${batch.summary.skipped}条。` });
          // 未回复列表收缩会把后页记录移到前页；重新扫描可避免漏查，seen排除已检查身份。
          // 不寻找刚才的记录；达到N立即结束，不为回复数量继续补查。
          if (rec.status === 'confirmed' && batch.records.length < (p.n ?? Infinity)) {
            while (ReviewDOM.page().number > 1) {
              if (!await turn('prev')) throw new HelperError('CANNOT_RETURN_FIRST', '回复后不能返回第一页，已停止。');
            }
          }
        }
        batch.phase = 'completed';
        batch.completedAt = new Date().toISOString();
        Ledger.saveBatch(batch);
        Actions.update({ tone: 'success',
          message: `批次完成：检查${batch.summary.checked}条，确认回复${batch.summary.replied}条，跳过${batch.summary.skipped}条。${p.n ? `检查上限N=${p.n}。` : '已遍历当前查询结果。'}` });
        return { ok: true, ...batch.summary, batch };
      } catch (error) {
        batch.phase = 'stopped';
        batch.error = { code: error.code || error.name, message: error.message };
        if (error.details) batch.error.details = error.details;
        Ledger.saveBatch(batch);
        throw error;
      }
    }
    function navigate(p, taskMode = 'reply', templates) {
      if (navigating || Actions.status().busy) throw new HelperError('BUSY', '已有操作正在执行。');
      Ledger.write(sessionStorage, Config.pendingKey, { schema: 5,
        action: taskMode === 'report' ? 'report-batch' : 'start-batch',
        sourceUrl: location.href, params: p, templates, at: Date.now() });
      navigating = true;
      Actions.update({ busy: true, taskMode, tone: 'info', message: '正在进入评价页，随后自动执行…' });
      try {
        location.assign(Config.evaluationUrl);
      } catch (error) {
        Ledger.remove(sessionStorage, Config.pendingKey);
        navigating = false;
        Actions.update({ busy: false, tone: 'error', message: '评价页跳转失败，请重新执行。' });
        throw error;
      }
      return { navigating: true };
    }
    async function oneClickRun(value) {
      return start(value);
    }
    function cancel() {
      // 先同步中断本页等待，再清除跳转交接；即使存储失败也不继续当前批次。
      const taskMode = Actions.status().busy ? Actions.status().taskMode : Panel.taskMode();
      const stopped = Actions.cancel();
      const hadPending = Ledger.remove(sessionStorage, Config.pendingKey);
      if (navigating || hadPending) {
        // 浏览器导航可能已经发出；保留导航锁直到离开/返回，防止再次启动。
        Actions.update({ taskMode, tone: 'info',
          message: '已急停：待执行任务已清除，评价页加载后不会继续。已提交的操作无法撤销。' });
      } else if (stopped) {
        Actions.update({ taskMode, tone: 'info', message: '已请求急停，正在结束当前操作；已提交的操作无法撤销。' });
      } else {
        Actions.update({ taskMode, tone: 'info', message: '当前没有正在执行的任务。' });
      }
      return stopped || navigating || hadPending;
    }
    // 已在评价路径直接操作，保留URL参数及页面日期；其他后台页面同标签页跳转。
    async function start(value, taskMode = 'reply', savedTemplates) {
      const p = taskMode === 'report' ? reportParams(value) : params(value);
      if (navigating || Actions.status().busy) throw new HelperError('BUSY', '已有操作正在执行。');
      const templates = savedTemplates ? {
        replyText: Templates.validate('reply', savedTemplates.replyText),
        reportText: Templates.validate('report', savedTemplates.reportText),
      } : Templates.snapshot();
      Panel.setTaskMode(taskMode);
      if (!/^\/goods\/evaluation\/index\/?$/.test(location.pathname)) return navigate(p, taskMode, templates);
      return Actions.runTask(async job => {
        if (!navigator.locks?.request) throw new HelperError('LOCK_UNAVAILABLE', '当前浏览器不支持批次互斥锁，未开始提交。');
        return navigator.locks.request(Config.lockName, { ifAvailable: true }, async lock => {
          if (!lock) throw new HelperError('OTHER_TAB_BUSY', '另一个后台标签页正在执行批次，请等待完成。');
          return taskMode === 'report' ? ReportWorkflow.execute(p, job, templates) : execute(p, job, templates);
        });
      }, taskMode);
    }
    function validPending(pending) {
      // 接受前两版完整导航参数；旧店铺约束不再参与执行。
      if (![1, 2, 3, 4, 5].includes(pending.schema) || !pending.params || Array.isArray(pending.params)) return false;
      const p = pending.params;
      if (!(p.n === null || Number.isSafeInteger(p.n) && p.n > 0) ||
          typeof p.goodsId !== 'string' || !/^\d*$/.test(p.goodsId)) return false;
      if (pending.schema === 4 && pending.action !== 'report-batch') return false;
      if (pending.schema < 4 && pending.action !== 'start-batch') return false;
      if (pending.schema === 5 && (!['report-batch', 'start-batch'].includes(pending.action) ||
          !pending.templates || typeof pending.templates !== 'object')) return false;
      if (p.strategy !== undefined && (pending.action !== 'report-batch' ||
          !['template', 'one-star-all'].includes(p.strategy))) return false;
      if (pending.schema === 1) return true;
      if (typeof pending.sourceUrl !== 'string') return false;
      try {
        return new URL(pending.sourceUrl).origin === location.origin;
      } catch {
        return false;
      }
    }
    async function continueNavigation() {
      let taskMode = Panel.taskMode();
      try {
        const pending = Ledger.read(sessionStorage, Config.pendingKey, null);
        if (!pending) return;
        taskMode = pending.action === 'report-batch' ? 'report' : taskMode;
        Ledger.remove(sessionStorage, Config.pendingKey); // 验证消费成功，刷新不会重新自动提交。
        if (!validPending(pending) || !Number.isFinite(pending.at) ||
            Date.now() - pending.at < 0 || Date.now() - pending.at > 120000 ||
            !/^\/goods\/evaluation\/index\/?$/.test(location.pathname)) {
          throw new HelperError('EXPIRED_START', '跳转任务已过期或页面不符，请手动重新启动。');
        }
        taskMode = pending.action === 'report-batch' ? 'report' : 'reply';
        Panel.setParams(pending.params, taskMode);
        await start(pending.params, taskMode, pending.schema === 5 ? pending.templates : undefined);
      } catch (error) {
        Actions.update({ taskMode, tone: 'error', message: error.message });
      }
    }
    function restoreNavigation() {
      if (!navigating) return;
      navigating = false;
      Actions.update({ busy: false, tone: 'info', message: '已返回页面，点击“一键运行”可重新启动。' });
    }
    return Object.freeze({ start, oneClickRun, startReport: value => start(value, 'report'),
      startOneStarReport: value => start({ ...value, strategy: 'one-star-all' }, 'report'),
      cancel, continueNavigation, restoreNavigation });
  })();

  const Panel = (() => {
    let host;
    let shadow;
    let lastRender = '';
    let checkedAt = '';
    let reportCheckedAt = '';
    const modeStatus = { reply: { tone: 'info', message: '设置参数后点击“一键运行”。' },
      report: { tone: 'info', message: '设置成功举报数量后点击“一键运行”。' } };
    let drag;
    let layout = readLayout();
    function readLayout() {
      try {
        const value = JSON.parse(localStorage.getItem(Config.panelKey) || 'null');
        if (value?.schema === 1 && ['expanded', 'collapsed', 'minimized'].includes(value.mode) &&
            (value.x === null && value.y === null || Number.isFinite(value.x) && Number.isFinite(value.y))) {
          return { schema: 1, mode: value.mode, x: value.x, y: value.y,
            taskMode: value.taskMode === 'report' ? 'report' : 'reply' };
        }
      } catch { /* 面板偏好失效不影响业务台账。 */ }
      return { schema: 1, mode: 'expanded', x: null, y: null, taskMode: 'reply' };
    }
    function saveLayout() {
      try { localStorage.setItem(Config.panelKey, JSON.stringify(layout)); } catch { /* 使用内存中的布局。 */ }
    }
    function place() {
      if (!host?.isConnected) return;
      const rect = host.getBoundingClientRect();
      const maxX = Math.max(8, innerWidth - rect.width - 8);
      const maxY = Math.max(8, innerHeight - rect.height - 8);
      const x = Math.min(maxX, Math.max(8, layout.x ?? innerWidth - rect.width - 20));
      const y = Math.min(maxY, Math.max(8, layout.y ?? innerHeight - rect.height - 24));
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      if (layout.x !== null) { layout.x = x; layout.y = y; }
    }
    function applyLayout() {
      const section = shadow.querySelector('section');
      section.dataset.mode = layout.mode;
      shadow.querySelector('#body').hidden = layout.mode !== 'expanded' || layout.taskMode !== 'reply';
      shadow.querySelector('#report-body').hidden = layout.mode !== 'expanded' || layout.taskMode !== 'report';
      shadow.querySelector('#mode-switch').hidden = layout.mode !== 'expanded';
      shadow.querySelector('#drag-handle').hidden = layout.mode === 'minimized';
      shadow.querySelector('#minibar').hidden = layout.mode !== 'minimized';
      shadow.querySelector('#compact').hidden = layout.mode === 'expanded';
      const toggle = shadow.querySelector('#collapse');
      toggle.textContent = layout.mode === 'collapsed' ? '展开' : '收起';
      toggle.setAttribute('aria-expanded', String(layout.mode === 'expanded'));
      shadow.querySelector('#mode-reply').setAttribute('aria-pressed', String(layout.taskMode === 'reply'));
      shadow.querySelector('#mode-report').setAttribute('aria-pressed', String(layout.taskMode === 'report'));
      shadow.querySelector('#panel-title').textContent = layout.taskMode === 'report' ? 'PDD 自动举报差评' : 'PDD 自动筛选回复';
      shadow.querySelector('#minibar strong').textContent = layout.taskMode === 'report' ? 'PDD 举报差评' : 'PDD 评价助手';
      place();
    }
    function setMode(mode) {
      layout.mode = mode;
      applyLayout();
      saveLayout();
    }
    function setTaskMode(mode) {
      if (!['reply', 'report'].includes(mode)) throw new HelperError('INVALID_MODE', '未知执行模式。');
      if (Actions.status().busy && layout.taskMode !== mode) {
        throw new HelperError('BUSY', '运行中不能切换模式，请先急停或等待完成。');
      }
      layout.taskMode = mode;
      if (shadow) {
        applyLayout();
        lastRender = '';
        render();
      }
      saveLayout();
    }
    function beginDrag(event) {
      if (event.button !== 0 || !event.isPrimary ||
          event.composedPath().some(node => node instanceof Element && node.matches('button, input, summary'))) return;
      const rect = host.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
    function moveDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      layout.x = drag.left + event.clientX - drag.x;
      layout.y = drag.top + event.clientY - drag.y;
      place();
    }
    function endDrag(event) {
      if (!drag || event.pointerId !== drag.id) return;
      drag = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      saveLayout();
    }
    function resize() { place(); saveLayout(); }

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
          const phases = { querying: '筛选与查询', freezing: '旧版锁定检查范围',
            replying: '逐条检查与回复', completed: '已完成', stopped: '已停止' };
          const records = batch.records;
          const replied = records.filter(rec => rec.status === 'confirmed').length;
          const skipped = records.filter(rec => rec.status?.startsWith('skipped_')).length;
          const uncertain = records.filter(rec =>
            ['submitting', 'submitted_unverified'].includes(rec.status)).length;
          const checked = batch.mode === 'sequential' ? records.length : replied + skipped;
          const limit = batch.mode === 'sequential' ? batch.params.n ?? '全部' : records.length;
          message += `\n最近批次：${phases[batch.phase] || '未知阶段'}。`
            + `\n已检查${checked}/${limit}条；确认回复${replied}条；跳过${skipped}条。`;
          if (uncertain) message += `\n待核验提交：${uncertain}条。`;
          if (batch.error?.message) message += `\n停止原因：${batch.error.message}`;
        } else message += '\n尚无批次记录。';
        if (checkedAt) message += `\n手动检查：${checkedAt}；状态持续自动更新。`;
        return { message, tone: state.error || problems.length || state.otherSelected.length ? 'error' : 'info' };
      } catch (error) {
        return { message: `状态读取失败：${error.message}`, tone: 'error' };
      }
    }

    function reportInspection() {
      try {
        const stats = ReportLedger.stats();
        const batch = ReportLedger.lastBatch();
        let message = `累计确认举报${stats.confirmed}条；待核验${stats.uncertain}条。`;
        message += DOM.root() ? batch?.strategy === 'one-star-all'
          ? '\n仅处理1星，正文不限；成功一条计数加1。'
          : '\n一键运行按1星→2星→3星处理；仅匹配无文字评价。'
          : '\n当前页面可启动；一键运行自动进入评价页。';
        if (batch) {
          const phases = { querying: '筛选与查询', reporting: '逐条检查与举报',
            completed: '已完成', stopped: '已停止' };
          const reasons = { target_reached: '成功举报目标已达到',
            stars_exhausted: `${batch.strategy === 'one-star-all' ? '1星' : '1至3星'}结果已全部处理，暂无需要处理的评价` };
          const counts = batch.summary;
          message += `\n最近批次：${phases[batch.phase] || '未知阶段'}；当前${batch.star}星。`
            + `\n成功举报${counts.reported}/${batch.target ?? '全部'}条；检查${counts.checked}条；跳过${counts.skipped}条。`;
          if (batch.stopReason) message += `\n结束原因：${reasons[batch.stopReason] || batch.stopReason}。`;
          if (batch.error?.message) message += `\n停止原因：${batch.error.message}`;
        } else message += '\n尚无举报批次记录。';
        if (reportCheckedAt) message += `\n手动检查：${reportCheckedAt}；状态持续自动更新。`;
        return { message, tone: stats.uncertain ? 'error' : 'info' };
      } catch (error) {
        return { message: `举报状态读取失败：${error.message}`, tone: 'error' };
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
          header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 10px;
            background: #fff5f4; border-bottom: 1px solid #f2dedc; cursor: grab; touch-action: none; user-select: none; }
          header:active, #minibar:active { cursor: grabbing; }
          strong { font-size: 14px; font-weight: 700; }
          .version { display: block; font-size: 11px; color: #737c8c; }
          .window-tools { display: flex; gap: 4px; }
          .window-tools button { font-size: 11px; padding: 4px 6px; }
          section[data-mode="minimized"] { width: min(208px, calc(100vw - 24px)); }
          #minibar { display: flex; align-items: center; justify-content: space-between; padding: 8px 10px;
            background: #fff5f4; cursor: grab; touch-action: none; user-select: none; }
          #minibar strong { font-size: 12px; }
          #compact { padding: 8px 10px; }
          #compact-count { margin: 0 0 6px; font-size: 12px; overflow-wrap: anywhere; }
          #compact-count[data-tone="error"] { color: #b32c22; }
          #compact-stop { width: 100%; color: #b32c22; border-color: #c43a30; background: #fff5f4; }
          button { font: inherit; cursor: pointer; border: 1px solid #dce0e7; background: #fff;
            color: #303746; border-radius: 7px; padding: 6px 9px; }
          button:hover:enabled { border-color: #e02e24; background: #fff5f4; }
          button:focus-visible { outline: 2px solid #e02e24; outline-offset: 2px; }
          button:disabled { opacity: .45; cursor: not-allowed; }
          #mode-switch { display: flex; gap: 6px; padding: 10px 14px 0; }
          #mode-switch button { flex: 1; font-size: 12px; }
          #mode-switch [aria-pressed="true"] { color: #b32c22; border-color: #e02e24; background: #fff5f4; }
          #body, #report-body { padding: 8px 14px 14px; max-height: calc(100vh - 174px); overflow: auto; }
          [hidden] { display: none !important; }
          #status, #report-status { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; font-size: 12px; color: #626b7a; }
          #status[data-tone="success"], #report-status[data-tone="success"] { color: #207442; }
          #status[data-tone="error"], #report-status[data-tone="error"] { color: #b32c22; }
          .tools { display: flex; gap: 6px; margin-top: 9px; }
          .tools button { padding: 4px 9px; font-size: 12px; }
          #inspection, #report-inspection { white-space: pre-wrap; overflow-wrap: anywhere; margin: 6px 0 0; padding: 8px;
            border-radius: 6px; background: #f6f7fa; font-size: 12px; color: #626b7a; }
          #inspection[data-tone="error"], #report-inspection[data-tone="error"] { color: #b32c22; }
          .hint { color: #737c8c; margin: 9px 0 0; font-size: 11px; }
          label { display: block; font-size: 12px; margin-top: 6px; }
          input, textarea { width: 100%; font: inherit; padding: 6px 8px; border: 1px solid #dce0e7; border-radius: 6px; }
          textarea { resize: vertical; min-height: 110px; }
          .copy-feedback { white-space: pre-wrap; font-size: 11px; margin: 6px 0; }
          #report-one-star { width: 100%; margin-top: 6px; color: #b32c22; border-color: #e02e24; }
          #run-once, #report-run-once { width: 100%; margin-top: 12px; background: #e02e24; color: white; border-color: #e02e24; }
          #run-once:hover:enabled, #report-run-once:hover:enabled { background: #c8241b; }
          #stop, #report-stop { width: 100%; margin-top: 6px; color: #b32c22; border-color: #c43a30; background: #fff5f4; }
          #stop:hover:enabled, #report-stop:hover:enabled { color: #fff; background: #b32c22; }
          details { margin-top: 9px; font-size: 12px; color: #626b7a; }
          summary { cursor: pointer; }
          #reply-copy, #report-copy { margin: 6px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
        </style>
        <section aria-label="PDD评价助手">
          <header id="drag-handle" title="拖动标题栏移动面板">
            <div><strong id="panel-title">PDD 自动筛选回复</strong><span class="version">${Config.version}</span></div>
            <div class="window-tools">
              <button id="collapse" type="button" aria-controls="body report-body mode-switch" aria-expanded="true">收起</button>
              <button id="minimize" type="button" aria-label="最小化控制面板">最小化</button>
            </div>
          </header>
          <div id="minibar" hidden title="拖动此处移动面板"><strong>PDD 评价助手</strong>
            <button id="restore" type="button" aria-label="恢复控制面板">恢复</button></div>
          <div id="compact" hidden><p id="compact-count" role="status" aria-live="polite"></p>
            <button id="compact-stop" type="button">急停</button></div>
          <div id="mode-switch" role="group" aria-label="执行模式">
            <button id="mode-reply" type="button" aria-pressed="true">自动筛选回复</button>
            <button id="mode-report" type="button" aria-pressed="false">自动举报差评</button>
          </div>
          <div id="body">
            <label for="batch-n">检查数量 N（留空＝全部结果）</label>
            <input id="batch-n" type="text" inputmode="numeric" placeholder="例如 5；N不是回复数量">
            <label for="batch-goods">商品 ID（可选）</label>
            <input id="batch-goods" type="text" inputmode="numeric" placeholder="留空查询全部商品">
            <button id="run-once" type="button">一键运行</button>
            <button id="stop" type="button" aria-describedby="stop-help">急停</button>
            <p id="stop-help" class="hint">停止后续操作；已提交的回复无法撤销。</p>
            <p id="status" role="status" aria-live="polite"></p>
            <div class="tools">
              <button id="refresh" type="button">检查状态</button>
              <button id="export-batch" type="button">导出本机台账</button>
            </div>
            <p id="inspection" role="status" aria-live="polite"></p>
            <details id="reply-details"><summary>查看／编辑统一回复文案</summary>
              <label for="reply-copy">回复文案（1～200字）</label>
              <textarea id="reply-copy" maxlength="200"></textarea>
              <div class="tools"><button id="reply-copy-save" type="button">保存文案</button>
                <button id="reply-copy-reset" type="button">恢复默认</button></div>
              <p id="reply-copy-feedback" class="copy-feedback" role="status">保存后用于下次运行。</p></details>
            <p class="hint">评价页直接运行，其他后台页自动跳转。逐条检查，符合正文条件立即回复；N留空遍历结果。</p>
          </div>
          <div id="report-body" hidden>
            <label for="report-n">举报数量（本次成功数量）</label>
            <input id="report-n" type="text" inputmode="numeric" placeholder="例如 5；留空处理全部符合条件的结果">
            <label for="report-goods">商品 ID（可选）</label>
            <input id="report-goods" type="text" inputmode="numeric" placeholder="留空查询全部商品">
            <button id="report-run-once" type="button">一键运行</button>
            <button id="report-stop" type="button" aria-describedby="report-stop-help">急停</button>
            <p id="report-stop-help" class="hint">停止后续操作；已提交的举报无法撤销。</p>
            <button id="report-one-star" type="button">无条件举报1星</button>
            <p class="hint">此按钮使用上方举报数量和商品ID，只处理1星；包含有文字评价。</p>
            <p id="report-status" role="status" aria-live="polite"></p>
            <div class="tools">
              <button id="report-refresh" type="button">检查状态</button>
              <button id="report-export-batch" type="button">导出本机台账</button>
            </div>
            <p id="report-inspection" role="status" aria-live="polite"></p>
            <details id="report-details"><summary>查看／编辑统一举报文案</summary>
              <label for="report-copy">举报文案（20～500字）</label>
              <textarea id="report-copy" maxlength="500"></textarea>
              <div class="tools"><button id="report-copy-save" type="button">保存文案</button>
                <button id="report-copy-reset" type="button">恢复默认</button></div>
              <p id="report-copy-feedback" class="copy-feedback" role="status">保存后用于下次运行。</p></details>
            <p class="hint">一键运行按1星→2星→3星处理，仅举报正文完全等于“该用户未填写文字评价”的记录。成功一条计数加1；达到数量或全部处理完后结束。提交成功表示平台已接收。</p>
          </div>
        </section>`;
      shadow.querySelector('#run-once').addEventListener('click', () => {
        void Workflow.oneClickRun({ n: shadow.querySelector('#batch-n').value,
          goodsId: shadow.querySelector('#batch-goods').value })
          .catch(error => Actions.update({ taskMode: 'reply', tone: 'error', message: error.message }));
      });
      shadow.querySelector('#report-run-once').addEventListener('click', () => {
        void Workflow.startReport({ n: shadow.querySelector('#report-n').value,
          goodsId: shadow.querySelector('#report-goods').value })
          .catch(error => Actions.update({ taskMode: 'report', tone: 'error', message: error.message }));
      });
      shadow.querySelector('#report-one-star').addEventListener('click', () => {
        void Workflow.startOneStarReport({ n: shadow.querySelector('#report-n').value,
          goodsId: shadow.querySelector('#report-goods').value })
          .catch(error => Actions.update({ taskMode: 'report', tone: 'error', message: error.message }));
      });
      for (const taskMode of ['reply', 'report']) {
        shadow.querySelector(`#mode-${taskMode}`).addEventListener('click', () => setTaskMode(taskMode));
      }
      shadow.querySelector('#report-stop').addEventListener('click', () => {
        try { Workflow.cancel(); } catch (error) { Actions.update({ taskMode: 'report', tone: 'error', message: error.message }); }
      });
      shadow.querySelector('#stop').addEventListener('click', () => {
        try { Workflow.cancel(); } catch (error) { Actions.update({ tone: 'error', message: error.message }); }
      });
      shadow.querySelector('#compact-stop').addEventListener('click', () => {
        try { Workflow.cancel(); } catch (error) { Actions.update({ tone: 'error', message: error.message }); }
      });
      shadow.querySelector('#collapse').addEventListener('click', () =>
        setMode(layout.mode === 'collapsed' ? 'expanded' : 'collapsed'));
      shadow.querySelector('#minimize').addEventListener('click', () => {
        setMode('minimized');
        shadow.querySelector('#restore').focus();
      });
      shadow.querySelector('#restore').addEventListener('click', () => {
        setMode('expanded');
        shadow.querySelector('#minimize').focus();
      });
      for (const handle of [shadow.querySelector('#drag-handle'), shadow.querySelector('#minibar')]) {
        handle.addEventListener('pointerdown', beginDrag);
        handle.addEventListener('pointermove', moveDrag);
        handle.addEventListener('pointerup', endDrag);
        handle.addEventListener('pointercancel', endDrag);
        handle.addEventListener('lostpointercapture', endDrag);
      }
      shadow.querySelector('#reply-details').addEventListener('toggle', place);
      shadow.querySelector('#report-details').addEventListener('toggle', place);
      shadow.querySelector('#refresh').addEventListener('click', () => {
        checkedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        render();
      });
      shadow.querySelector('#export-batch').addEventListener('click', () => {
        try { Ledger.exportData(); } catch (error) { Actions.update({ taskMode: 'reply', tone: 'error', message: error.message }); }
      });
      shadow.querySelector('#report-refresh').addEventListener('click', () => {
        reportCheckedAt = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        render();
      });
      shadow.querySelector('#report-export-batch').addEventListener('click', () => {
        try { ReportLedger.exportData(); } catch (error) { Actions.update({ taskMode: 'report', tone: 'error', message: error.message }); }
      });
      let savedTemplates;
      try { savedTemplates = Templates.snapshot(); } catch (error) {
        savedTemplates = Templates.defaults();
        modeStatus.reply = modeStatus.report = { tone: 'error', message: error.message };
      }
      for (const kind of ['reply', 'report']) {
        const editor = shadow.querySelector(`#${kind}-copy`);
        const feedback = shadow.querySelector(`#${kind}-copy-feedback`);
        editor.value = savedTemplates[`${kind}Text`];
        editor.addEventListener('input', () => {
          feedback.textContent = `未保存；当前${editor.value.length}字。点击“保存文案”后用于下次运行。`;
        });
        for (const action of ['save', 'reset']) {
          shadow.querySelector(`#${kind}-copy-${action}`).addEventListener('click', () => {
            try {
              const value = action === 'reset' ? Templates.reset(kind) : Templates.save(kind, editor.value);
              editor.value = value[`${kind}Text`];
              feedback.textContent = `已${action === 'reset' ? '恢复默认并保存' : '保存'}，共${editor.value.length}字。`;
            } catch (error) { feedback.textContent = error.message; }
            place();
          });
        }
      }
      document.body.append(host);
      applyLayout();
      window.addEventListener('resize', resize);
      lastRender = '';
    }

    function render() {
      mount();
      // @match和入口已限定商家后台域名；面板不再依赖评价页地址或筛选DOM。
      const status = Actions.status();
      const reading = inspection();
      const reportReading = reportInspection();
      if (status.taskMode && status.message) modeStatus[status.taskMode] = { tone: status.tone, message: status.message };
      // 高频mutation不反复更新相同的面板内容。
      const fingerprint = JSON.stringify({ status, reading, reportReading, taskMode: layout.taskMode, modeStatus });
      if (fingerprint === lastRender) return;
      lastRender = fingerprint;
      shadow.querySelector('#run-once').disabled = status.busy;
      shadow.querySelector('#batch-n').disabled = status.busy;
      shadow.querySelector('#batch-goods').disabled = status.busy;
      for (const id of ['report-run-once', 'report-one-star', 'report-n', 'report-goods', 'mode-reply', 'mode-report',
        'reply-copy', 'reply-copy-save', 'reply-copy-reset', 'report-copy', 'report-copy-save', 'report-copy-reset']) {
        shadow.querySelector(`#${id}`).disabled = status.busy;
      }
      const feedback = shadow.querySelector('#status');
      feedback.textContent = modeStatus.reply.message;
      feedback.dataset.tone = modeStatus.reply.tone;
      const details = shadow.querySelector('#inspection');
      details.textContent = reading.message;
      details.dataset.tone = reading.tone;
      shadow.querySelector('#report-status').textContent = modeStatus.report.message;
      shadow.querySelector('#report-status').dataset.tone = modeStatus.report.tone;
      shadow.querySelector('#report-inspection').textContent = reportReading.message;
      shadow.querySelector('#report-inspection').dataset.tone = reportReading.tone;
      const batch = layout.taskMode === 'report' ? ReportLedger.lastBatch() : Ledger.lastBatch();
      const counts = batch?.summary;
      const compact = shadow.querySelector('#compact-count');
      const label = status.busy ? '运行中' : batch?.phase === 'stopped' ? '已停止'
        : batch?.phase === 'completed' ? '已完成' : '待运行';
      compact.textContent = `${label}${counts ? layout.taskMode === 'report'
        ? ` · 成功举报${counts.reported}/${batch.target ?? '全部'} · 检查${counts.checked}`
        : ` · 检查${counts.checked} · 回复${counts.replied}` : ''}`;
      compact.dataset.tone = modeStatus[layout.taskMode].tone;
      place();
    }

    function destroy() {
      host?.remove();
      window.removeEventListener('resize', resize);
      drag = null;
      host = null;
      shadow = null;
      lastRender = '';
    }

    function setParams(params, taskMode = 'reply') {
      mount();
      setTaskMode(taskMode);
      shadow.querySelector(taskMode === 'report' ? '#report-n' : '#batch-n').value = params.n === null ? '' : String(params.n);
      shadow.querySelector(taskMode === 'report' ? '#report-goods' : '#batch-goods').value = params.goodsId || '';
    }

    return Object.freeze({ render, destroy, setParams, setTaskMode, taskMode: () => layout.taskMode,
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
      // 页面离开只中断当前执行；正常一键跳转必须保留待执行任务供目标页消费。
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
      startReportBatch: Workflow.startReport,
      startOneStarReportBatch: Workflow.startOneStarReport,
      oneClickReportRun: Workflow.startReport,
      readReportBatch: ReportLedger.lastBatch,
      readReportJournal: ReportLedger.journal,
      readReportStats: ReportLedger.stats,
      readTemplates: Templates.snapshot,
      saveTemplate: Templates.save,
      exportReportLedger: ReportLedger.exportData,
      resolveReportSubmission: ReportLedger.resolve,
      exportLedger: Ledger.exportData,
      readBatch: Ledger.lastBatch,
      readSubmissionJournal: Ledger.journal,
      resolveSubmission: Ledger.resolve,
      select: Actions.select,
      selectAll: Actions.selectAll,
      cancel: Workflow.cancel,
    }),
  });

  App.start();
  void Workflow.continueNavigation();
})();
