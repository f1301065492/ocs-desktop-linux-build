/**
 * 更新逻辑的整体实现由扩展提供（见 `src/ext/update/updater.ts`）。
 *
 * 上游原实现是「下载 zip → 删掉 app 目录 → 解压覆盖」，只在 Windows 成立：
 * AppImage 的 appPath 在只读挂载里，deb 装到 /opt 普通用户写不了。
 * 扩展版按平台分流（AppImage 自替换 / deb 下载后给出命令 / Windows·macOS 打开安装包），
 * 并支持自建更新源。保留本文件是为了让上游的 import 路径不变。
 */
export { updater, updateApp } from '../ext/update/updater';
