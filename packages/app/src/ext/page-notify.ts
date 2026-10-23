import type { Page } from 'playwright-core';

/**
 * 页面内通知捕获（扩展功能）。
 *
 * 用户脚本（如 OCS 网课助手）的「全部任务点已完成」「检测到验证码」这类提示画在页面 DOM 里，
 * 不经过桌面端。这里向每个页面注入监听，命中「需要人工处理」的关键词就
 * `console.log('[ocs-notify] …')`，再由 `installPageNotifier` 转发成 worker 日志，
 * 从而进入主动通知链路。
 *
 * 与上游的接点只有两处（都在 worker/index.ts）：
 *   browser.addInitScript({ content: PAGE_NOTIFY_SCRIPT })
 *   installPageNotifier(page)
 */

/**
 * 只推送需要人工处理的事件（与注入脚本里的 KEYWORDS 保持一致）。
 * 单个任务点完成、任务点数量为空等流程进度**不在**白名单里。
 */
export const PAGE_EVENT_RE =
	/全部任务点|所有任务点|全部完成|所有完成|本课任务点.*完成|本章任务点.*完成|验证码|需要人工|人工处理|人工输入|请手动|登录失败|密码错误|账号或密码|滑块|人脸|扫码/;

/** 页面说明类文案（使用提示、平台列表、交流群…）不是事件，忽略 */
export const PAGE_INFORMATIONAL_RE =
	/使用提示|兼容的网课平台|官方教程|交流群|更新日志|脚本猫|Tampermonkey|油猴|禁止|最小化|任务列表|自动阅读|积分课/;

export const PAGE_NOTIFY_SCRIPT = String.raw`
(() => {
  try {
    if (window.__ocsNotifyHook) return;
    window.__ocsNotifyHook = true;
    var KEYWORDS = /全部任务点|所有任务点|全部完成|所有完成|本课任务点.*完成|本章任务点.*完成|验证码|需要人工|人工处理|人工输入|请手动|登录失败|密码错误|账号或密码|滑块|人脸|扫码/;
    // 用户脚本的说明面板（使用提示/平台列表/交流群…）不是事件，直接忽略
    var IGNORE = /使用提示|兼容的网课平台|官方教程|交流群|更新日志|脚本猫|Tampermonkey|油猴|禁止|最小化|任务列表|自动阅读|积分课/;
    var SELECTOR = '[role="dialog"],[class*="dialog"],[class*="modal"],'
      + '[class*="message-box"],[class*="toast"],[class*="notice"],'
      + '[class*="notification"]';
    var lastText = new WeakMap();
    var observedRoots = new WeakSet();
    function textOf(el) {
      return String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    }
    // 去掉弹窗自带的 UI 前缀/后缀（“弹窗来自：OCS 5.2.1 … 确定 ×”），
    // 让同一条消息的不同组件形式归一成同一段文字
    function cleanText(text) {
      var value = String(text || '').replace(/\s+/g, ' ').trim();
      value = value.replace(new RegExp('[\\u200B-\\u200D\\uFEFF]', 'g'), '');
      value = value.replace(/^弹窗来自[:：]?\s*OCS\s*[\d.]+\s*/i, '');
      value = value.replace(/^提示\s*/, '');
      var changed = true;
      while (changed) {
        changed = false;
        var next = value.replace(/\s*(?:×|✕|确定|取消|关闭|知道了|上一节|下一节|去学习)\s*$/, '').trim();
        if (next !== value) {
          value = next;
          changed = true;
        }
      }
      return value;
    }
    function isNested(el) {
      var node = el.parentElement;
      while (node) {
        if (node.matches && node.matches(SELECTOR)) return true;
        node = node.parentElement;
      }
      return false;
    }
    function emit(el) {
      if (!el || el.nodeType !== 1 || isNested(el)) return;
      var text = cleanText(textOf(el));
      if (!text || text.length > 120 || IGNORE.test(text) || !KEYWORDS.test(text)) return;
      if (lastText.get(el) === text) return;
      lastText.set(el, text);
      try { console.log('[ocs-notify] ' + text); } catch (e) {}
    }
    function scanRoot(root) {
      if (!root || !root.querySelectorAll) return;
      var nodes = root.querySelectorAll(SELECTOR);
      for (var i = 0; i < nodes.length; i += 1) emit(nodes[i]);
    }
    function observeRoot(root) {
      if (!root || observedRoots.has(root)) return;
      observedRoots.add(root);
      try {
        observer.observe(root, { childList: true, subtree: true, characterData: true });
      } catch (e) {}
      scanRoot(root);
    }
    function inspect(el) {
      if (!el || el.nodeType !== 1) return;
      if (el.matches && el.matches(SELECTOR)) {
        emit(el);
      } else {
        // 非标准弹窗（自定义 class）：只对短文本 + 命中关键词的浮层做判断，避免扫描整页
        var text = String(el.textContent || '');
        if (text.length > 400 || !KEYWORDS.test(text)) return;
        try {
          var style = getComputedStyle(el);
          if (style.position !== 'fixed' && style.position !== 'absolute' && !style.zIndex) return;
        } catch (e) { return; }
        emit(el);
      }
      if (el.querySelectorAll) {
        var nodes = el.querySelectorAll(SELECTOR);
        for (var i = 0; i < nodes.length; i += 1) emit(nodes[i]);
      }
      if (el.shadowRoot) observeRoot(el.shadowRoot);
    }
    function handle(records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.type === 'characterData') {
          inspect(record.target.parentElement);
          continue;
        }
        for (var j = 0; j < record.addedNodes.length; j += 1) inspect(record.addedNodes[j]);
      }
    }
    var observer = new MutationObserver(handle);
    // 用户脚本的弹窗常放在 Shadow DOM（甚至 closed）里：包装 attachShadow
    // 拿到真实 root 后直接观察，closed 模式也能覆盖。
    try {
      var nativeAttach = Element.prototype.attachShadow;
      if (typeof nativeAttach === 'function') {
        Element.prototype.attachShadow = function (init) {
          var root = nativeAttach.call(this, init);
          try { observeRoot(root); } catch (e) {}
          return root;
        };
      }
    } catch (e) {}
    function start() {
      observeRoot(document.documentElement);
      inspect(document.body);
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  } catch (e) {}
})();
`;

/**
 * 把页面里的通知转发到 worker 日志。
 *
 * - 注入脚本的 `[ocs-notify]` 前缀：直接转发；
 * - 兜底：用户脚本自己打到 console 的输出，命中人工事件白名单且不是说明面板时也转发。
 */
export function installPageNotifier(page: Page): void {
	page.on('console', (message) => {
		const text = message.text();
		const marker = '[ocs-notify] ';
		if (text.startsWith(marker)) {
			console.log(`[页面通知] ${text.slice(marker.length)}`);
			return;
		}
		const eventLike = PAGE_EVENT_RE.test(text);
		if (text.length <= 120 && eventLike && !PAGE_INFORMATIONAL_RE.test(text)) {
			console.log(`[页面通知] ${text.replace(/\s+/g, ' ').trim()}`);
		}
	});
}
