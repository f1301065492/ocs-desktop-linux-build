import { BrowserWindow, app, dialog } from 'electron';
import path from 'path';
import AdmZip from 'adm-zip';
import { Logger } from '../logger';
import xlsx from 'xlsx';
import unzipper from 'unzipper';

const taskLogger = Logger('task');

export async function task(name: string, func: any) {
	const time = Date.now();
	const res = await func();
	taskLogger.info(name, ' 耗时:', Date.now() - time);
	return res;
}

/**
 * 下载文件。
 *
 * 实现搬到了 ./download.ts，改用并行分片：GitHub Releases 在国内单连接
 * 只有约 0.5 MB/s，实测 8 线程能到约 3.8 MB/s。服务端不支持 Range 时
 * 会自动回退到原来的单流下载。签名保持不变，调用方无需改动。
 */
export { downloadFile } from './download';

/**
 * 压缩文件
 */

export function zip(input: string, output: string) {
	return new Promise<void>((resolve, reject) => {
		const zip = new AdmZip();
		zip.addLocalFile(input, './');
		zip.writeZip(output, (err: any) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

/**
 * 解压文件
 */

export async function unzip(input: string, output: string) {
	const directory = await unzipper.Open.file(input);
	await directory.extract({ path: output });
}

export function getProjectPath() {
	/** 这里多退出一层是因为打包后是运行在 ./lib 下面的 */
	return app.isPackaged ? app.getAppPath() : path.resolve('./');
}

/**
 * 导出excel
 */
export function exportExcel(excel: { sheetName: string; list: any[] }[], filename: string) {
	dialog
		.showSaveDialog({
			title: '导出Excel',
			defaultPath: filename
		})
		.then(({ canceled, filePath }) => {
			if (!canceled && filePath) {
				const book = xlsx.utils.book_new();
				for (const item of excel) {
					xlsx.utils.book_append_sheet(book, xlsx.utils.json_to_sheet(item.list), item.sheetName);
				}
				xlsx.writeFile(book, filePath);
			}
		});
}

export function moveWindowToTop() {
	const win = BrowserWindow.getAllWindows()[0];
	// 置顶应用
	const onTop = win.isAlwaysOnTop();
	win.setAlwaysOnTop(true);
	win.setAlwaysOnTop(onTop);
	return win;
}

export function getCurrentWebContents() {
	return BrowserWindow.getAllWindows()[0].webContents;
}

export function sleep(ms: number) {
	return new Promise((resolve) => {
		setTimeout(() => {
			resolve(true);
		}, ms);
	});
}
