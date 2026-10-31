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
 *
 * ⚠️ 注入脚本必须「只读」：不改写任何原生方法/原型、不新增可枚举的 window 全局。
 * 智慧树等平台会校验原生函数 toString，2026-10-31 就是因为我们包装了
 * Element.prototype.attachShadow 被判「检测到异常脚本」，已彻底回退（见 FORK.md）。
 * 想关掉整个注入：设置 → 浏览器设置 → 页面内通知（worker 配置项 page_notify）。
 */

/**
 * 只推送需要人工处理的事件（注入脚本与主进程兜底共用这一份）。
 *
 * 以下三类**不推送**（用户 2026-10-29 定）：
 *   - 需要手动操作类：请手动进入页面、请点击章节、请切换任务、手动进入任意章节…
 *   - 设置类提醒：题库未配置、图片题优化未开启、自动答题被关闭…
 *   - 作业/考试收尾：请自行检查后提交、未保存答案确认、剩余题目检查…
 * 流程进度（单个任务点完成等）同样不在白名单里。
 *
 * 词条来自 ocsjs 源码（packages/scripts/src）里所有 $message / $modal / $gm 通知，
 * 按「需要人操作」筛选；新增脚本版本时对照补充。
 */
export const PAGE_EVENT_KEYWORDS = [
	'(全部|所有)任务点?.*完成',
	'(全部|所有)章节.*完成',
	'全部任务已完成',
	'所有完成',
	'本课任务点.*完成',
	'本章任务点.*完成',
	'验证码',
	'人脸识别',
	'滑块',
	'扫码',
	'需要人工',
	'人工处理',
	'人工输入',
	'请刷新重试',
	'请刷新页面重试',
	'刷新界面重试',
	'视频加载失败',
	'脚本暂停',
	'习惯分弹窗',
	'全部播放完毕',
	'获取课程数据失败',
	'课程列表获取失败',
	'元素加载失败',
	'答题程序发生错误',
	'作业/考试失败',
	'登录失败',
	'密码错误',
	'账号或密码'
];

export const PAGE_EVENT_RE = new RegExp(PAGE_EVENT_KEYWORDS.join('|'));

/** 页面说明类文案（使用提示、平台列表、交流群…）不是事件，忽略 */
export const PAGE_INFORMATIONAL_KEYWORDS = [
	'使用提示',
	'兼容的网课平台',
	'官方教程',
	'交流群',
	'更新日志',
	'脚本猫',
	'Tampermonkey',
	'油猴',
	'禁止',
	'最小化',
	'任务列表',
	'自动阅读',
	'积分课',
	'即将跳过',
	'验证码已完成',
	'已进入学习页面'
];

export const PAGE_INFORMATIONAL_RE = new RegExp(PAGE_INFORMATIONAL_KEYWORDS.join('|'));

export const PAGE_NOTIFY_SCRIPT = String.raw`
(() => {
  try {
    // 幂等标记用 Symbol：不出现在 window 的字符串键枚举里，
    // 也不留下带产品名的字符串全局变量（那种名字最容易被平台规则点名）
    var GUARD = Symbol.for('page.events.capture');
    if (Object.prototype.hasOwnProperty.call(window, GUARD)) return;
    Object.defineProperty(window, GUARD, { value: true, enumerable: false, configurable: false });
    // 需人工介入的事件（与 PAGE_EVENT_KEYWORDS 保持一致）
    var KEYWORDS = new RegExp(${JSON.stringify(PAGE_EVENT_KEYWORDS.join('|'))});
    // 说明面板与「已恢复」类回执不是需要处理的事件
    var IGNORE = new RegExp(${JSON.stringify(PAGE_INFORMATIONAL_KEYWORDS.join('|'))});
    // message-element / modal-element 是 ocsjs 的 easy-us 组件自定义标签：
    // 提示气泡没有 message-* 类名，只匹配 class 会整类漏掉。
    var SELECTOR = 'message-element,modal-element,[role="dialog"],[class*="dialog"],[class*="modal"],'
      + '[class*="message-box"],[class*="message-content"],[class*="toast"],[class*="notice"],'
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
        var next = value.replace(/\s*(?:×|✕|x|确定|取消|关闭|知道了|上一节|下一节|去学习)\s*$/, '').trim();
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
    // ⚠️ 这里**不做任何原型篡改**（2026-10-31 修复智慧树「检测到异常脚本」）。
    // 曾经包装过 Element.prototype.attachShadow 以覆盖 closed shadow root，
    // 但智慧树等平台会校验原生函数（attachShadow.toString() 必须含 [native code]），
    // 一旦发现自己被改写就直接判「检测到异常脚本」，答题/考试页直接不可用。
    // 现在只观察 light DOM 与已开放的 shadowRoot（下面 inspect 里的 el.shadowRoot），
    // closed shadow root 里的弹窗不再覆盖：宁可少收一条通知，也不能让整站判为异常脚本。
    // 同理，注入脚本不得新增任何可枚举的 window 全局、不得改写任何原生方法。
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
