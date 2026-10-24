/**
 * 构建前准备内置浏览器压缩包（Chrome for Testing，严格锁定 137.0.7151.55）。
 *
 * 背景：Chrome 137 之后不允许通过命令行加载扩展，系统浏览器版本过高时无法安装
 * 油猴/脚本猫。因此安装包重新内置一份 137 的 Chrome，运行时由 init.chrome.ts 解压到
 * userData 并作为「软件内置浏览器」使用。
 *
 * 产物：bin/chrome/<platform>-<arch>/chrome.zip（bin/ 已被 .gitignore 忽略，不进仓库）
 * electron.builder.json 会把对应目录复制到 resources/bin/chrome/。
 *
 * 用法：
 *   node scripts/prepare-builtin-chrome.js
 *   环境变量：
 *     OCS_CHROME_PLATFORM=win64|mac-x64|mac-arm64|linux64   交叉构建时指定目标平台
 *     OCS_CHROME_SKIP=1                                     跳过（仅调试构建链时使用）
 *
 * 下载源与 packages/common/src/utils/chrome.source.ts 保持一致：国内镜像 → 谷歌官方。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSION = '137.0.7151.55';
/** 与 packages/common/src/utils/chrome.source.ts 的 BUILTIN_CHROME_SHA256 保持一致 */
const SHA256 = {
	win64: '186efa65df60a8062ff4e7f8430c860b8ef0d298db160d973b68dfe430e9e48a',
	'mac-x64': '1342558af92f8d8f9cb26c4504f9d49b63c0b1d6fe06485c2e01c763a67deb44',
	'mac-arm64': '582745f2cc1f61c77323c07c156ae7a991b8033eaaf6f7ab21b7f127ff9ffd00',
	linux64: 'ffedd41a261f26e2e60e5d1692e0955c292caffafd15865344d21b845554a3d4'
};
/** CfT 平台标识 -> bin/ 目录名（electron-builder 的 ${arch} 宏值） */
const DIR_NAME = {
	win64: 'win-x64',
	'mac-x64': 'mac-x64',
	'mac-arm64': 'mac-arm64',
	linux64: 'linux-x64'
};

function detectPlatform() {
	if (process.env.OCS_CHROME_PLATFORM) {
		const value = process.env.OCS_CHROME_PLATFORM;
		if (!SHA256[value]) {
			throw new Error(`OCS_CHROME_PLATFORM 不支持: ${value}（可选 ${Object.keys(SHA256).join(' / ')}）`);
		}
		return value;
	}
	if (process.platform === 'win32' && process.arch === 'x64') return 'win64';
	if (process.platform === 'darwin' && process.arch === 'x64') return 'mac-x64';
	if (process.platform === 'darwin' && process.arch === 'arm64') return 'mac-arm64';
	if (process.platform === 'linux' && process.arch === 'x64') return 'linux64';
	throw new Error(`当前平台没有内置浏览器包: ${process.platform}-${process.arch}（可用 OCS_CHROME_PLATFORM 指定）`);
}

function sha256File(file) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(file);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolve(hash.digest('hex')));
		stream.on('error', reject);
	});
}

function download(url, dest) {
	return new Promise((resolve, reject) => {
		const request = (currentUrl, redirects) => {
			https
				.get(currentUrl, (res) => {
					if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
						res.resume();
						if (redirects > 5) return reject(new Error('重定向次数过多'));
						return request(new URL(res.headers.location, currentUrl).toString(), redirects + 1);
					}
					if (res.statusCode !== 200) {
						res.resume();
						return reject(new Error(`HTTP ${res.statusCode}`));
					}
					const total = Number(res.headers['content-length'] || 0);
					let received = 0;
					let nextLog = 10 * 1024 * 1024;
					const hash = crypto.createHash('sha256');
					const writer = fs.createWriteStream(dest);
					res.on('data', (chunk) => {
						hash.update(chunk);
						received += chunk.length;
						if (received >= nextLog) {
							const percent = total ? ` ${((received / total) * 100).toFixed(1)}%` : '';
							console.log(`    已下载 ${(received / 1024 / 1024).toFixed(1)} MB${percent}`);
							nextLog += 10 * 1024 * 1024;
						}
					});
					res.pipe(writer);
					writer.on('finish', () => resolve(hash.digest('hex')));
					writer.on('error', reject);
					res.on('error', reject);
				})
				.on('error', reject);
		};
		request(url, 0);
	});
}

async function main() {
	if (process.env.OCS_CHROME_SKIP === '1') {
		console.log('[chrome] OCS_CHROME_SKIP=1，跳过内置浏览器准备');
		return;
	}

	const cft = detectPlatform();
	const dir = path.join('bin', 'chrome', DIR_NAME[cft]);
	const dest = path.join(dir, 'chrome.zip');
	const expected = SHA256[cft];

	if (fs.existsSync(dest)) {
		const actual = await sha256File(dest);
		if (actual === expected) {
			console.log(`[chrome] 已存在且校验通过：${dest}（${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB）`);
			return;
		}
		console.log(`[chrome] 现有文件哈希不匹配，重新下载：${dest}`);
		fs.rmSync(dest, { force: true });
	}

	fs.mkdirSync(dir, { recursive: true });
	const tmp = dest + '.tmp';
	const file = `chrome-${cft}.zip`;
	const sources = [
		`https://registry.npmmirror.com/-/binary/chrome-for-testing/${VERSION}/${cft}/${file}`,
		`https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${cft}/${file}`
	];

	let lastError;
	for (const url of sources) {
		try {
			console.log(`[chrome] 下载 ${url}`);
			const actual = await download(url, tmp);
			if (actual !== expected) {
				throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${actual}`);
			}
			fs.renameSync(tmp, dest);
			console.log(`[chrome] 完成：${dest}（${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB）`);
			return;
		} catch (err) {
			lastError = err;
			console.warn(`[chrome] 下载失败：${err.message}`);
			fs.rmSync(tmp, { force: true });
		}
	}

	throw new Error(`内置浏览器下载失败（所有源均不可用）：${lastError && lastError.message}`);
}

main().catch((err) => {
	console.error('[chrome] ' + err.message);
	process.exit(1);
});
