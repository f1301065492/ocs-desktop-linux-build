/**
 * 计算日志尾部相对上一轮的**新增行**。
 *
 * 为什么不用「整行哈希去重」：如果同一行文本重复出现（比如每次登录失败都是
 * 一模一样的 `自动化程序错误：手机号/超星号或密码错误`），哈希去重会把第二次
 * 及以后的出现当成"已播报"而永远吞掉；首次见到时的基线也会把它吃掉。
 *
 * 这里改为比较两轮日志尾部：在 `currTail` 中从右往左找 `prevTail` 的后缀块，
 * 找到后，块之后的部分就是新增行。
 * - 日志没变化 → 块正好落在末尾 → 返回空；
 * - 追加了 1 行（即使文本与上一行完全相同）→ 块在原位置结束 → 返回新增的那行；
 * - 日志被清空/重置、完全对不上 → 返回全部 curr（调用方需限制播报条数）。
 *
 * @param {string[]} prevTail 上一轮保存的尾部行
 * @param {string[]} currTail 本轮拉到的尾部行
 * @returns {string[]}
 */
export function diffTail(prevTail, currTail) {
	const prev = Array.isArray(prevTail) ? prevTail : [];
	const curr = Array.isArray(currTail) ? currTail : [];
	const maxK = Math.min(prev.length, curr.length);

	for (let k = maxK; k >= 1; k -= 1) {
		const block = prev.slice(prev.length - k);
		// 从左往右找第一次出现：追加内容时，上一轮的尾部块仍落在原来的位置，
		// 块之后就是新增。宁可多报一次重复（左匹配），也不能把重复出现的错误行漏掉。
		for (let i = 0; i <= curr.length - k; i += 1) {
			let matched = true;
			for (let j = 0; j < k; j += 1) {
				if (curr[i + j] !== block[j]) {
					matched = false;
					break;
				}
			}
			if (matched) {
				return curr.slice(i + k);
			}
		}
	}
	return curr.slice();
}
