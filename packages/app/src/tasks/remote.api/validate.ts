import { ApiError } from './errors';

/**
 * 入参校验。刻意不引入 zod 之类的依赖——项目里没有，不值得为此加一个。
 *
 * 只做「形状与上限」校验：字段是否存在、类型对不对、长度是否越界、有没有多余字段。
 * 「语义」校验（父文件夹是否存在、自动化脚本名是否有效）交给渲染进程，
 * 因为那份数据（文件树、自动化脚本注册表）只有渲染进程有权威视图。
 */

/** 创建浏览器的允许字段。cachePath / uid / type 一律不准传，见 parseCreateBrowserInput 的说明。 */
const CREATE_ALLOWED_KEYS = ['name', 'parentUid', 'tags', 'notes', 'automationScripts', 'clientToken'];

const CLIENT_TOKEN_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const UID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TAG_COLOR_RE = /^#[0-9a-fA-F]{3,8}$/;

const NAME_MAX = 64;
const NOTES_MAX = 2000;
const TAG_NAME_MAX = 32;
const TAGS_MAX = 20;
const AUTOMATION_SCRIPTS_MAX = 50;

/**
 * 自动化程序配置项的值。
 *
 * 内部存储的形状是 Record<string, Config>（Config = {label, value, type, ...}），
 * 但那个形状对调用方太啰嗦——label/type 本来就是脚本事先声明好的展示元数据。
 * 所以 API 层只收「键 → 值」，渲染侧再与脚本 manifest 合并补齐其余字段。
 */
export type AutomationConfigValue = string | number | boolean | Array<string | number | boolean> | null;

export interface CreateBrowserInput {
	name?: string;
	parentUid?: string;
	/** clientToken 是幂等键：同一个 token 重复创建只会得到同一个浏览器 */
	clientToken?: string;
	notes?: string;
	tags?: Array<{ name: string; color: string }>;
	automationScripts?: Array<{ name: string; configs?: Record<string, AutomationConfigValue> }>;
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new ApiError('INVALID_ARGUMENT', `${field} 必须是对象`);
	}
}

/**
 * 是否包含控制字符（0x00-0x1F 或 0x7F）。
 * 用逐字符判断而不是正则字面量，避免把裸控制字符写进源码，
 * 也避开 ESLint 的 no-control-regex。
 */
function hasControlChar(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code <= 0x1f || code === 0x7f) {
			return true;
		}
	}
	return false;
}

function optionalString(value: unknown, field: string, maxLength: number, pattern?: RegExp): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string') {
		throw new ApiError('INVALID_ARGUMENT', `${field} 必须是字符串`);
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new ApiError('INVALID_ARGUMENT', `${field} 不能为空`);
	}
	if (trimmed.length > maxLength) {
		throw new ApiError('INVALID_ARGUMENT', `${field} 长度不能超过 ${maxLength}`);
	}
	if (hasControlChar(trimmed)) {
		throw new ApiError('INVALID_ARGUMENT', `${field} 不能包含控制字符`);
	}
	if (pattern && !pattern.test(trimmed)) {
		throw new ApiError('INVALID_ARGUMENT', `${field} 格式不合法`);
	}
	return trimmed;
}

/** 校验路径参数里的 uid */
export function parseUid(raw: unknown): string {
	if (typeof raw !== 'string' || !UID_RE.test(raw)) {
		throw new ApiError('INVALID_ARGUMENT', 'uid 格式不合法');
	}
	return raw;
}

/** 校验查询参数里的 clientToken 过滤条件 */
export function parseClientTokenFilter(raw: unknown): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	if (typeof raw !== 'string' || !CLIENT_TOKEN_RE.test(raw)) {
		throw new ApiError('INVALID_ARGUMENT', 'clientToken 格式不合法');
	}
	return raw;
}

function parseTags(value: unknown): Array<{ name: string; color: string }> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new ApiError('INVALID_ARGUMENT', 'tags 必须是数组');
	}
	if (value.length > TAGS_MAX) {
		throw new ApiError('INVALID_ARGUMENT', `tags 最多 ${TAGS_MAX} 个`);
	}
	return value.map((item, index) => {
		assertObject(item, `tags[${index}]`);
		const name = optionalString(item.name, `tags[${index}].name`, TAG_NAME_MAX);
		const color = optionalString(item.color, `tags[${index}].color`, 16, TAG_COLOR_RE);
		if (!name || !color) {
			throw new ApiError('INVALID_ARGUMENT', `tags[${index}] 需要 name 与 color`);
		}
		return { name, color };
	});
}

function isPrimitive(value: unknown): value is string | number | boolean {
	return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function parseAutomationScripts(
	value: unknown
): Array<{ name: string; configs?: Record<string, AutomationConfigValue> }> | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new ApiError('INVALID_ARGUMENT', 'automationScripts 必须是数组');
	}
	if (value.length > AUTOMATION_SCRIPTS_MAX) {
		throw new ApiError('INVALID_ARGUMENT', `automationScripts 最多 ${AUTOMATION_SCRIPTS_MAX} 个`);
	}
	return value.map((item, index) => {
		assertObject(item, `automationScripts[${index}]`);
		for (const key of Object.keys(item)) {
			if (key !== 'name' && key !== 'configs') {
				throw new ApiError('UNKNOWN_FIELD', `automationScripts[${index}] 不支持的字段: ${key}`);
			}
		}
		const name = optionalString(item.name, `automationScripts[${index}].name`, NAME_MAX);
		if (!name) {
			throw new ApiError('INVALID_ARGUMENT', `automationScripts[${index}].name 不能为空`);
		}

		let configs: Record<string, AutomationConfigValue> | undefined;
		if (item.configs !== undefined && item.configs !== null) {
			assertObject(item.configs, `automationScripts[${index}].configs`);
			configs = {};
			for (const [key, val] of Object.entries(item.configs)) {
				const field = `automationScripts[${index}].configs.${key}`;
				if (val === null || isPrimitive(val)) {
					configs[key] = val as AutomationConfigValue;
					continue;
				}
				// select 多选之类的场景允许传数组
				if (Array.isArray(val) && val.every(isPrimitive)) {
					configs[key] = val as Array<string | number | boolean>;
					continue;
				}
				throw new ApiError('INVALID_ARGUMENT', `${field} 只能是原始类型或其数组`);
			}
		}
		return { name, configs };
	});
}

/**
 * 解析创建浏览器的请求体。
 *
 * 明确拒绝 cachePath / uid / type：
 * - cachePath 会进 Chromium 的 --user-data-dir，而 Browser.remove() 会对它做递归 rmSync，
 *   允许外部指定等于给出「让用户在 UI 里删掉任意目录」的破坏链
 * - uid 允许外部指定就可能覆盖已有实体
 * - type 只有 'browser' 一种合法值
 */
export function parseCreateBrowserInput(body: unknown): CreateBrowserInput {
	assertObject(body, 'body');
	for (const key of Object.keys(body)) {
		if (!CREATE_ALLOWED_KEYS.includes(key)) {
			throw new ApiError('UNKNOWN_FIELD', `不支持的字段: ${key}`);
		}
	}

	const result: CreateBrowserInput = {};
	const name = optionalString(body.name, 'name', NAME_MAX);
	if (name) result.name = name;

	const parentUid = optionalString(body.parentUid, 'parentUid', 64);
	if (parentUid) result.parentUid = parentUid;

	const clientToken = optionalString(body.clientToken, 'clientToken', 128, CLIENT_TOKEN_RE);
	if (clientToken) result.clientToken = clientToken;

	if (body.notes !== undefined && body.notes !== null) {
		if (typeof body.notes !== 'string') {
			throw new ApiError('INVALID_ARGUMENT', 'notes 必须是字符串');
		}
		if (body.notes.length > NOTES_MAX) {
			throw new ApiError('INVALID_ARGUMENT', `notes 长度不能超过 ${NOTES_MAX}`);
		}
		result.notes = body.notes;
	}

	const tags = parseTags(body.tags);
	if (tags) result.tags = tags;

	const automationScripts = parseAutomationScripts(body.automationScripts);
	if (automationScripts) result.automationScripts = automationScripts;

	return result;
}

/** 解析截图质量参数（仅 jpeg 有效），默认 70 */
export function parseQuality(raw: unknown): number {
	if (raw === undefined) {
		return 70;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0 || value > 100) {
		throw new ApiError('INVALID_ARGUMENT', 'quality 必须是 0-100 之间的数字');
	}
	return Math.round(value);
}

/** 解析 ?wait= 长轮询秒数，上限 60 秒 */
export function parseWaitSeconds(raw: unknown): number {
	if (raw === undefined) {
		return 0;
	}
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new ApiError('INVALID_ARGUMENT', 'wait 必须是正数');
	}
	return Math.min(Math.floor(value), 60);
}
