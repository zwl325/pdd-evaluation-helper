// ==UserScript==
// @name         PDD评价筛选助手（4星、5星、未回复）
// @namespace    urn:local:pdd:evaluation-helper
// @version      2026-10-12.1
// @description  在拼多多商家评价页选择4星、5星、未回复，逐项核验状态，提供独立按钮和一键入口。
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
    version: '2026-10-12.1',
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

    function supportedPage() {
      const path = location.pathname.replace(/\/+$/, '');
      if (path === '/home' || path === '/goods/evaluation/index' ||
          /(?:^|\/)goods\/evaluation\/index(?:[/?]|$)/.test(location.hash.replace(/^#/, ''))) return true;
      const state = snapshot();
      return state.targets.length === Config.targets.length && state.targets.every((target) => target.found);
    }

    return Object.freeze({ visible, enabled, selected, root, resolve, snapshot, supportedPage });
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
    let status = { busy: false, tone: 'info', message: '等待评价页加载；选择操作需点击面板按钮。' };
    const listeners = new Set();

    function notify(next) {
      status = { ...status, ...next };
      for (const listener of listeners) listener();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    async function run(labels, checkConflicts = false) {
      if (active) throw new HelperError('BUSY', '已有操作正在执行，请等待完成或点击停止。');
      if (!Array.isArray(labels) || !labels.length ||
          labels.some((label) => !Config.targets.includes(label))) {
        throw new HelperError('INVALID_TARGET', '仅支持4星、5星、未回复。');
      }

      const job = { controller: new AbortController(), url: location.href };
      const options = {
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
      cancel,
      cancelIfPageChanged: () => {
        if (active && location.href !== active.url) cancel();
      },
      subscribe,
      status: () => ({ ...status }),
    });
  })();

  const Panel = (() => {
    let host;
    let shadow;
    let lastRender = '';

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
          button { font: inherit; cursor: pointer; border: 1px solid #dce0e7; background: #fff;
            color: #303746; border-radius: 7px; padding: 6px 9px; }
          button:hover:enabled { border-color: #e02e24; background: #fff5f4; }
          button:focus-visible { outline: 2px solid #e02e24; outline-offset: 2px; }
          button:disabled { opacity: .45; cursor: not-allowed; }
          #collapse { border: 0; background: transparent; padding: 0 4px; }
          #body { padding: 12px 14px 14px; }
          [hidden] { display: none !important; }
          #state { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
          .badge { text-align: center; background: #f1f3f7; color: #5f6878; border-radius: 6px; padding: 5px 2px; }
          .badge[data-selected="true"] { background: #eaf6ef; color: #207442; }
          .choices { display: flex; gap: 6px; }
          .choices button { flex: 1; }
          #all { width: 100%; margin-top: 8px; background: #e02e24; color: #fff; border-color: #e02e24; }
          #all:hover:enabled { background: #c8241b; }
          .utility { display: flex; gap: 6px; margin-top: 8px; }
          #status { white-space: pre-wrap; overflow-wrap: anywhere; margin: 10px 0 0; font-size: 12px; color: #626b7a; }
          #status[data-tone="success"] { color: #207442; }
          #status[data-tone="error"] { color: #b32c22; }
          #others { margin-top: 8px; color: #a96510; font-size: 12px; }
          .hint { color: #737c8c; margin: 9px 0 0; font-size: 11px; }
        </style>
        <section aria-label="PDD评价筛选助手">
          <header><strong>PDD 评价筛选助手</strong>
            <button id="collapse" type="button" aria-expanded="true" title="收起面板">收起</button></header>
          <div id="body">
            <div id="state">
              <span class="badge" data-label="4星"></span>
              <span class="badge" data-label="5星"></span>
              <span class="badge" data-label="未回复"></span>
            </div>
            <div class="choices">
              <button type="button" data-select="4星">选择4星</button>
              <button type="button" data-select="5星">选择5星</button>
              <button type="button" data-select="未回复">选择未回复</button>
            </div>
            <button id="all" type="button">一键选择 4星 + 5星 + 未回复</button>
            <div class="utility">
              <button id="refresh" type="button">检查状态</button>
              <button id="stop" type="button" disabled>停止</button>
            </div>
            <p id="status" role="status" aria-live="polite"></p>
            <div id="others" hidden></div>
            <p class="hint">选择后可手动点击页面“查询”。再次执行会跳过已选项。</p>
          </div>
        </section>`;
      for (const button of shadow.querySelectorAll('[data-select]')) {
        button.addEventListener('click', () => {
          // Actions已经将失败反馈到面板；吞掉UI入口的Promise拒绝，避免未处理异常。
          void Actions.select(button.dataset.select).catch(() => {});
        });
      }
      shadow.querySelector('#all').addEventListener('click', () => {
        void Actions.selectAll().catch(() => {});
      });
      shadow.querySelector('#refresh').addEventListener('click', render);
      shadow.querySelector('#stop').addEventListener('click', Actions.cancel);
      shadow.querySelector('#collapse').addEventListener('click', () => {
        const body = shadow.querySelector('#body');
        const button = shadow.querySelector('#collapse');
        body.hidden = !body.hidden;
        button.textContent = body.hidden ? '展开' : '收起';
        button.setAttribute('aria-expanded', String(!body.hidden));
        button.title = body.hidden ? '展开面板' : '收起面板';
      });
      document.body.append(host);
      lastRender = '';
    }

    function render() {
      mount();
      const supported = DOM.supportedPage();
      host.hidden = !supported;
      host.style.display = supported ? 'block' : 'none';
      if (!supported) return;
      const state = DOM.snapshot();
      const status = Actions.status();
      // 高频mutation不反复更新相同的面板内容。
      const fingerprint = JSON.stringify({ state, status });
      if (fingerprint === lastRender) return;
      lastRender = fingerprint;
      const pageIdentified = state.targets.length === Config.targets.length &&
        state.targets.every((target) => target.found);
      for (const label of Config.targets) {
        const target = state.targets.find((item) => item.label === label);
        const badge = [...shadow.querySelectorAll('.badge')].find((item) => item.dataset.label === label);
        const button = [...shadow.querySelectorAll('[data-select]')].find((item) => item.dataset.select === label);
        const value = !target?.found ? '未就绪' : target.selected ? '已选' : target.enabled ? '未选' : '禁用';
        badge.textContent = `${label} · ${value}`;
        badge.dataset.selected = String(Boolean(target?.selected));
        badge.title = target?.error || '';
        button.disabled = status.busy || !pageIdentified || !(target?.enabled || target?.selected);
      }
      shadow.querySelector('#all').disabled = status.busy || !state.ready;
      shadow.querySelector('#stop').disabled = !status.busy;
      const feedback = shadow.querySelector('#status');
      const unavailable = state.error || state.targets
        .filter((target) => !target.found || !target.enabled && !target.selected)
        .map((target) => `${target.label}：${target.error || '当前禁用'}`).join('；');
      feedback.textContent = !status.busy && status.tone === 'info' && !state.ready
        ? `请打开商品评价页并等待筛选区域加载。${unavailable ? `\n${unavailable}` : ''}`
        : status.message;
      feedback.dataset.tone = status.tone;
      const others = shadow.querySelector('#others');
      others.hidden = !state.otherSelected.length;
      others.textContent = `其他已选条件：${state.otherSelected.join('、')}。请核查。`;
    }

    function destroy() {
      host?.remove();
      host = null;
      shadow = null;
      lastRender = '';
    }

    return Object.freeze({ render, destroy, contains: (node) => Boolean(host && (node === host || host.contains(node))) });
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
    window.addEventListener('pageshow', start);
    return Object.freeze({ start });
  })();

  // 可选的本页编排接口：控制台、后续同页模块均可调用；不接入CDP、网络请求或消息桥。
  Object.defineProperty(window, Config.apiName, {
    configurable: false,
    writable: false,
    value: Object.freeze({
      version: Config.version,
      readState: DOM.snapshot,
      select: Actions.select,
      selectAll: Actions.selectAll,
      cancel: Actions.cancel,
    }),
  });

  App.start();
})();
