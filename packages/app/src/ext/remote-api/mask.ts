/**
 * 日志脱敏。
 *
 * `GET /browsers/:uid/logs` 是唯一会把**运行期文本原文**交给外部调用方的接口，
 * 而浏览器日志里可能出现登录账号、密码、Cookie。所以替换刻意放在**主进程的响应边界**上：
 * 渲染进程只负责把「原文 + 需要屏蔽的取值」回传，渲染侧漏改一处也不至于把凭据漏出去。
 */

/**
 * 短于这个长度的取值不参与替换。
 *
 * 手机号 / 学号 / 密码都远长于此；而像 "1"、"-" 这种配置值一旦参与替换，
 * 会把整篇日志替换得没法读——误伤日志比漏替换更糟，因为调用方会以为日志本身就长这样。
 */
const MIN_SECRET_LENGTH = 3;

const PLACEHOLDER = '***';

export interface MaskResult {
	text: string;
	/** 被替换掉的次数，调用方可据此判断这段日志里是否真的出现过敏感内容 */
	masked: number;
}

/**
 * 把文本里出现的敏感取值替换成 `***`。
 *
 * 用「按长度从长到短 + split/join」而不是正则：取值里可能有 `.` `+` `\` 这类正则元字符，
 * 拼正则要先转义；而先替换长值可以避免短值是长值子串时留下无法辨认的残片
 * （例如同时存在密码 `abc123` 与账号 `abc`，先替换 `abc123` 才不会剩下 `***123`）。
 */
export function maskSecrets(text: string, secrets: Array<string | null | undefined>): MaskResult {
	const list = Array.from(
		new Set(
			secrets
				.filter((secret): secret is string => typeof secret === 'string')
				.map((secret) => secret.trim())
				.filter((secret) => secret.length >= MIN_SECRET_LENGTH)
		)
	).sort((a, b) => b.length - a.length);

	let result = text;
	let masked = 0;
	for (const secret of list) {
		const parts = result.split(secret);
		if (parts.length > 1) {
			masked += parts.length - 1;
			result = parts.join(PLACEHOLDER);
		}
	}

	return { text: result, masked };
}
