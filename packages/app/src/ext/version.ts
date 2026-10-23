/**
 * 版本号展示转换。
 *
 * 内部 package.json 必须是合法 semver（否则 electron-updater 会抛
 * ERR_UPDATER_INVALID_VERSION），第四段扩展号因此写成预发布位 `3.1.0-1`；
 * 对用户展示与 Release tag 使用四段格式 `3.1.0.1`。
 */
export function displayVersion(version: string): string {
	return String(version || '').replace(/-(\d+)$/, '.$1');
}
