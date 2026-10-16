// @ts-check

const { ScriptWorker } = require('./lib/src/worker/index');

/**
 * 兜底：绝不让一个没接住的 Promise rejection 弄死这个子进程。
 *
 * 这个进程的职责是**守住一个已经跑起来的浏览器**——用户可能正拿它上网课，一跑就是几小时。
 * 任何一个漏 catch 的异步错误（页面被关、扩展行为变化、网络抖动）都不该让浏览器突然消失。
 * 已经真出过一次事故：等扩展首页超时后 reject、调用处又没 await，浏览器跑到一分钟左右
 * 整个进程被杀，报错只有一句「浏览器拓展加载超时」。
 *
 * 错误照旧打到 stderr（父进程会收进日志、弹提示并允许复制），但进程继续活着。
 * 注意这里**只兜 rejection**：同步的 uncaughtException 仍然让它崩——那类错误往往意味着
 * 进程状态已经不可信，硬撑着比退出更危险。
 */
process.on('unhandledRejection', (reason) => {
	console.error(
		'[worker] 未处理的 Promise rejection（已忽略，进程继续运行）：',
		reason instanceof Error ? reason.stack : String(reason)
	);
});

const worker = new ScriptWorker();

// 监听消息
process.on(
	'message',
	(
		/** @type {{event: any, args: any}} */
		message
	) => {
		/** 根据 event 名直接调用方法 */
		worker[message.event](...message.args);
	}
);
