<template>
	<div>
		<a-card title="AI 助手接入（DSH）">
			<a-alert
				type="info"
				class="mb-3"
			>
				<template #title>把 OCS 接进 DSH，用飞书 / 微信里的 AI 助手操作浏览器</template>
				<div>
					点「写入 DSH 配置」会在本机 DSH 的 profile 里写一段受管配置（可重复执行、自动备份）。
					桥接脚本随软件发布，不需要手工拷贝。写完重启 DSH 生效。
				</div>
			</a-alert>

			<Description label="连接状态">
				<a-space>
					<Icon
						:type="connection.icon"
						:color="connection.color"
						:size="18"
					/>
					<a-tag :color="connection.color">{{ connection.text }}</a-tag>
					<a-button
						size="mini"
						:loading="state.connLoading"
						@click="refreshConnection(true)"
					>
						刷新
					</a-button>
				</a-space>
				<div class="hint">
					{{ connection.hint }}
					（以进程为准：DSH 成功加载 OCS 桥接才算连接成功；改完配置记得重启 DSH。）
				</div>
			</Description>

			<Description label="DSH 目录">
				<a-space>
					<a-input
						v-model="state.dshHome"
						size="small"
						style="width: 320px"
					/>
					<a-button
						size="mini"
						:loading="state.loading"
						@click="loadStatus"
					>
						重新检测
					</a-button>
				</a-space>
				<div class="hint">{{ homeHint }}</div>
				<div
					v-if="state.status?.reason === 'unreadable'"
					class="hint"
				>
					<div class="mt-1">DSH 和 OCS 不是同一个用户，有两种做法（任选其一）：</div>
					<div class="mt-1">
						<a-button
							type="primary"
							size="mini"
							:loading="state.granting"
							@click="grantAccess"
						>
							授权 OCS 访问（弹窗输入管理员密码）
						</a-button>
						<span class="ms-2">一次性授权后，这里就能像同用户一样选 profile、直接写入。</span>
					</div>
					<div class="mt-1">
						或者不改权限，直接用 root 一次性写入：
						<div class="break">
							<code>{{ rootCommand }}</code>
							<a-button
								size="mini"
								class="ms-2"
								@click="copyRootCommand"
							>
								复制
							</a-button>
						</div>
					</div>
					<a-alert
						v-if="state.grantCommand"
						type="warning"
						class="mt-2"
					>
						<template #title>未能自动授权，可复制下面这条命令到终端执行</template>
						<div class="break">
							<code>{{ state.grantCommand }}</code>
							<a-button
								size="mini"
								class="ms-2"
								@click="copyGrantCommand"
							>
								复制
							</a-button>
						</div>
					</a-alert>
					<div class="mt-1">
						撤销授权：<code>sudo setfacl -R -x u:{{ state.status.ocsUser }} "{{ state.status.home }}/profiles"</code>
						（祖先目录上的 <code>x</code> 权限可用
						<code>sudo setfacl -x u:{{ state.status.ocsUser }} "{{ state.status.home }}"</code> 去掉）
					</div>
					<div class="mt-1">
						授权后请注意：OCS 用户（{{ state.status.ocsUser }}）将能读写 DSH 的 profiles 配置目录。
					</div>
				</div>
				<div
					v-else
					class="hint"
				>
					找不到时：在终端里跑
					<code>find /root /home /opt /var -maxdepth 6 -type f -name 'cordis.patch.yml' 2>/dev/null</code>
					，它的上两级目录就是数据目录（也可以用 DSH 进程的 <code>DSH_HOME</code>/<code>HOME</code> 确认）。
				</div>
			</Description>

			<Description label="桥接脚本">
				<span
					v-if="state.status?.bridgeReady"
					class="text-secondary"
				>
					<code>{{ state.status.bridgeDir }}</code>
				</span>
				<span
					v-else
					class="text-danger"
				>
					缺少 ocs-mcp-server.mjs：{{ state.status?.bridgeDir }}
				</span>
			</Description>

			<Description label="远程 API">
				<a-space>
					<a-tag
						v-if="!state.status"
						color="gray"
					>
						读取中
					</a-tag>
					<template v-else>
						<a-tag :color="state.status.remoteApi.enabled ? 'green' : 'red'">
							{{ state.status.remoteApi.enabled ? '已开启' : '未开启' }}
						</a-tag>
						<a-tag :color="state.status.remoteApi.hasKey ? 'green' : 'red'">
							{{ state.status.remoteApi.hasKey ? '已配置密钥' : '未配置密钥' }}
						</a-tag>
						<span class="text-secondary"
							>{{ state.status.remoteApi.bindAddress }}:{{ state.status.remoteApi.port }}</span
						>
					</template>
				</a-space>
			</Description>

			<Description label="Profile">
				<a-select
					v-model="state.profile"
					size="small"
					style="width: 240px"
					:options="profileOptions"
					placeholder="选择 profile"
				/>
				<span
					v-if="state.status?.configured?.includes(state.profile)"
					class="ms-2 text-secondary"
				>
					（已写过 OCS 配置，再次写入会覆盖那一段）
				</span>
			</Description>

			<Description label="OCS 地址">
				<a-input
					v-model="state.ocsBase"
					size="small"
					style="width: 320px"
				/>
				<div class="hint">同机部署用 https://127.0.0.1:&lt;端口&gt;；DSH 在别的机器上就填本机的局域网地址。</div>
			</Description>

			<Description label="API 密钥">
				<a-space>
					<a-input-password
						v-model="state.apiKey"
						size="small"
						style="width: 320px"
						placeholder="粘贴远程 API 的密钥"
					/>
					<a-popconfirm
						content="生成新密钥会让旧的立即失效，其他调用方（网关等）需要同步更新。继续？"
						ok-text="确认"
						cancel-text="取消"
						@ok="generateKey"
					>
						<a-button
							size="small"
							:loading="state.saving"
						>
							生成新密钥
						</a-button>
					</a-popconfirm>
				</a-space>
				<div class="hint">
					OCS 只保存密钥的哈希用于鉴权；这里另外保存一份加密副本用于自动回填（随系统密钥链加密），
					重启后不再需要重新粘贴。点「生成新密钥」会顺手填入（记得同步给其他调用方）。
				</div>
			</Description>

			<Description label="证书指纹">
				<span class="text-secondary">{{ state.status?.remoteApi.certFingerprint || '（远程 API 启动后才有）' }}</span>
				<div class="hint">自签证书的 SHA-256 指纹，会一起写进配置做固定校验。</div>
			</Description>

			<Description label="工具集">
				<a-switch
					v-model="state.toolsetBasic"
					size="small"
				/>
				<span class="ms-2 text-secondary">精简（basic）</span>
				<div class="hint">
					只注册 8 个常用工具（健康检查 / 列表 / 详情 / 启动 / 关闭 / 标签页 / 截图 / 日志）， 省掉任务、脚本增删等
					schema——工具定义每轮都会随请求发送，开启后每轮少约 1k token。
				</div>
			</Description>

			<a-space class="mt-3">
				<a-button
					type="primary"
					:loading="state.saving"
					:disabled="!canWrite"
					@click="writeConfig"
				>
					写入 DSH 配置
				</a-button>
			</a-space>

			<a-alert
				v-if="state.result"
				type="success"
				class="mt-3"
			>
				<template #title>已写入</template>
				<div class="break">
					<code>{{ state.result.file }}</code>
				</div>
				<div class="break">
					备份：<code>{{ state.result.backup }}</code>
				</div>
				<div class="mt-2">
					下一步：重启 DSH（<code>systemctl restart &lt;dsh服务&gt;</code> 或重开 <code>dsh web</code>），
					然后在聊天里问「列一下 OCS 里的浏览器」。
				</div>
				<div class="mt-2">
					想让它主动通知（不花 token），在那台机器上跑：
					<code>node {{ state.status?.bridgeDir }}/ocs-watch.mjs --loop --every 60 --deliver dsh</code>
					<a-button
						size="mini"
						class="ms-2"
						@click="copyWatchCommand"
					>
						复制
					</a-button>
				</div>
			</a-alert>
		</a-card>

		<a-card
			title="主动通知（OCS → DSH）"
			class="mt-3"
		>
			<div class="hint mb-2">
				轮询 OCS 的日志与状态（脚本安装、登录成功、检测到验证码、掉线等），直接发到 DSH 绑定的聊天里； 不经过模型，零
				token。Bot ID / 目标 ID 在 DSH「设置 → IM机器人 → 复制调用参数」里获取。
			</div>

			<Description label="启用">
				<a-switch
					:model-value="notify.enabled"
					:loading="state.notifyBusy"
					@change="onToggleNotify"
				/>
				<span class="ms-2 text-secondary">{{ notifyStatusText }}</span>
			</Description>

			<Description label="实时推送">
				<a-switch
					v-model="notify.realtime"
					size="small"
				/>
				<span class="ms-2 text-secondary">脚本事件/错误秒级推送</span>
				<div class="hint">
					实时通知走渲染进程的日志事件，立即投递；下面的轮询作为兜底（默认 5
					秒）。两条链路在主进程统一去重，同一条消息不会推两次。
				</div>
			</Description>

			<Description label="Bot ID">
				<a-input
					v-model="notify.botId"
					size="small"
					style="width: 320px"
					placeholder="bot_…"
				/>
			</Description>

			<Description label="目标 ID">
				<a-input
					v-model="notify.targetId"
					size="small"
					style="width: 320px"
					placeholder="tgt_…"
				/>
			</Description>

			<Description label="投递地址">
				<a-input
					v-model="notify.deliveryUrl"
					size="small"
					style="width: 420px"
					placeholder="留空 = http://127.0.0.1:3080/api/dsh-im/delivery/messages"
				/>
				<div class="hint">DSH 的 Web 端口不是 3080 时，填完整地址。</div>
			</Description>

			<Description label="轮询间隔">
				<a-input-number
					v-model="notify.intervalSec"
					size="small"
					:min="5"
					:max="3600"
					:step="5"
					style="width: 160px"
				/>
				<span class="ms-2 text-secondary">秒</span>
			</Description>

			<a-space class="mt-2">
				<a-button
					size="small"
					:loading="state.notifyBusy"
					@click="testNotify"
				>
					发送测试通知
				</a-button>
				<a-button
					size="small"
					:loading="state.notifyBusy"
					@click="refreshNotifyStatus"
				>
					刷新状态
				</a-button>
			</a-space>

			<div class="hint mt-2">
				配置随软件设置保存（密钥加密存储）；下次启动 OCS 时自动运行，关闭上面的开关即停止。 修改 Bot ID / 目标 ID /
				间隔后，需要关闭再打开开关才会生效。
			</div>

			<a-alert
				v-if="state.notifyLog.length"
				type="info"
				class="mt-3"
			>
				<template #title>最近输出</template>
				<div class="break">
					<div
						v-for="(line, index) in state.notifyLog"
						:key="index"
					>
						{{ line }}
					</div>
				</div>
			</a-alert>
		</a-card>
	</div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive } from 'vue';
import { Message } from '@arco-design/web-vue';
import Description from '../Description.vue';
import Icon from '../Icon.vue';
import { remote } from '../../utils/remote';
import { store } from '../../store';

interface DshBridgeStatus {
	home: string;
	exists: boolean;
	readable: boolean;
	reason: 'ok' | 'missing' | 'no-profiles' | 'unreadable';
	dshUser?: string;
	ocsUser: string;
	profiles: string[];
	configured: string[];
	bridgeDir: string;
	bridgeReady: boolean;
	remoteApi: {
		enabled: boolean;
		listening: boolean;
		port: number;
		bindAddress: string;
		hasKey: boolean;
		certFingerprint: string;
	};
}

const state = reactive({
	status: null as DshBridgeStatus | null,
	loading: false,
	saving: false,
	granting: false,
	grantCommand: '',
	notifyBusy: false,
	notifyRunning: false,
	notifyPid: 0,
	notifyLog: [] as string[],
	toolsetBasic: false,
	conn: null as { dshRunning: boolean; bridgeRunning: boolean; bridgePid: number } | null,
	connLoading: false,
	dshHome: '',
	profile: '',
	ocsBase: '',
	apiKey: '',
	result: null as { file: string; backup: string } | null
});

/** 主动通知配置（持久化在 renderer store，随软件设置加密保存） */
const notify = computed(() => store.render.setting.dshNotify);

const notifyStatusText = computed(() => {
	if (state.notifyRunning) {
		return `运行中（pid ${state.notifyPid}）`;
	}
	return state.notifyBusy ? '处理中…' : '未运行';
});

/** 连接状态：以进程为准，配置写了但没重启 DSH 时不误报成功 */
const connection = computed(() => {
	const conn = state.conn;
	if (conn?.dshRunning && conn?.bridgeRunning) {
		return {
			color: 'green',
			icon: 'check_circle',
			text: '已连接',
			hint: `DSH 已加载 OCS 桥接（pid ${conn.bridgePid}）。`
		};
	}
	if (conn?.dshRunning) {
		return {
			color: 'orange',
			icon: 'warning',
			text: 'DSH 运行中，桥接未加载',
			hint: '配置可能还没生效：重启 DSH 后再看。'
		};
	}
	if (conn?.bridgeRunning) {
		return {
			color: 'orange',
			icon: 'warning',
			text: '桥接在运行，未检测到 DSH',
			hint: 'DSH 可能刚退出或换成了别的用户运行。'
		};
	}
	return {
		color: 'red',
		icon: 'error',
		text: '未连接',
		hint: '没有检测到 DSH 进程，确认它正在运行。'
	};
});

const profileOptions = computed(() => (state.status?.profiles || []).map((name) => ({ label: name, value: name })));

const homeHint = computed(() => {
	const status = state.status;
	if (!status) {
		return '正在检测…';
	}
	switch (status.reason) {
		case 'ok':
			return `已检测到 DSH 数据目录（${status.home}）`;
		case 'unreadable':
			return `检测到 DSH 数据目录 ${status.home}，但当前 OCS 用户${
				status.ocsUser ? `（${status.ocsUser}）` : ''
			}无权读取${status.dshUser ? `——DSH 由 ${status.dshUser} 运行` : ''}`;
		case 'no-profiles':
			return `${status.home} 里没有 profiles/——可能不是 DSH 数据目录，试试它下面的 .dsh/`;
		default:
			return `没检测到 DSH（最后尝试：${status.home || '常见位置'}）——可以手工填数据目录的绝对路径`;
	}
});

/** 权限不够时给用户一条能在终端直接执行的 root 命令 */
const rootCommand = computed(() => {
	const status = state.status;
	if (!status?.home) {
		return '';
	}
	const bridgeDir = status.bridgeDir;
	return [
		`sudo bash "${bridgeDir}/setup-same-host.sh"`,
		`--dsh-home "${status.home}"`,
		`--bridge-dir "${bridgeDir}"`
	].join(' ');
});

const canWrite = computed(
	() =>
		Boolean(state.status?.profiles?.includes(state.profile)) &&
		state.ocsBase.trim().length > 0 &&
		state.apiKey.trim().length > 0
);

async function loadStatus() {
	state.loading = true;
	try {
		// 带上用户填的目录：填了就按它检测（兼容 `<dir>/profiles` 与 `<dir>/.dsh/profiles` 两种布局）
		const status: DshBridgeStatus = await remote.methods.call('dshBridgeStatus', {
			dshHome: state.dshHome.trim() || undefined
		});
		state.status = status;
		// 首次进入时给出合理的默认值
		state.dshHome = status.home || state.dshHome;
		if (!state.profile) {
			state.profile = status.profiles[0] || '';
		}
		if (!status.profiles.includes(state.profile)) {
			state.profile = status.profiles[0] || '';
		}
		if (!state.ocsBase) {
			state.ocsBase = `https://127.0.0.1:${status.remoteApi?.port || 15320}`;
		}
	} catch (err) {
		Message.error('检测 DSH 失败：' + String(err));
	} finally {
		state.loading = false;
	}
}

async function generateKey() {
	state.saving = true;
	try {
		const result = await remote.methods.call('remoteApiGenerateKey');
		state.apiKey = result.apiKey;
		await loadStatus();
		Message.success('已生成新密钥并填入；请同步更新其他调用方');
	} catch (err) {
		Message.error('生成密钥失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

async function writeConfig() {
	state.saving = true;
	state.result = null;
	try {
		const result = await remote.methods.call('dshBridgeWrite', {
			profile: state.profile,
			ocsBase: state.ocsBase.trim(),
			apiKey: state.apiKey.trim(),
			certFingerprint: state.status?.remoteApi?.certFingerprint || '',
			dshHome: state.dshHome.trim(),
			toolset: state.toolsetBasic ? 'basic' : 'full'
		});
		state.result = result;
		Message.success('已写入 DSH 配置');
		// 手工粘贴的密钥：校验通过后补一份加密副本，下次打开自动回填
		remote.methods.call('remoteApiRememberKey', state.apiKey.trim()).catch(() => {});
		await loadStatus();
	} catch (err) {
		Message.error('写入失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

async function copyWatchCommand() {
	const command = `node ${state.status?.bridgeDir}/ocs-watch.mjs --loop --every 60 --deliver dsh`;
	try {
		await navigator.clipboard.writeText(command);
		Message.success('已复制');
	} catch {
		Message.warning('复制失败，请手动选中复制');
	}
}

async function copyRootCommand() {
	try {
		await navigator.clipboard.writeText(rootCommand.value);
		Message.success('已复制');
	} catch {
		Message.warning('复制失败，请手动选中复制');
	}
}

/** 跨用户授权：主进程用 pkexec 执行 setfacl，成功后会重新检测 */
async function grantAccess() {
	state.granting = true;
	state.grantCommand = '';
	try {
		const result: { ok: boolean; command?: string; message?: string } = await remote.methods.call(
			'dshBridgeGrantAccess',
			{ dshHome: state.dshHome.trim() || undefined }
		);
		if (result?.ok) {
			Message.success('已授权，正在重新检测');
			await loadStatus();
		} else {
			state.grantCommand = result?.command || '';
			Message.error(result?.message || '授权失败');
		}
	} catch (err) {
		Message.error('授权失败：' + String(err));
	} finally {
		state.granting = false;
	}
}

async function copyGrantCommand() {
	try {
		await navigator.clipboard.writeText(state.grantCommand);
		Message.success('已复制');
	} catch {
		Message.warning('复制失败，请手动选中复制');
	}
}

/** 手动/定时刷新连接状态；轮询时不要闪 loading */
async function refreshConnection(manual = false) {
	if (manual) {
		state.connLoading = true;
	}
	try {
		state.conn = await remote.methods.call('dshConnectionStatus');
	} catch {
		// 轮询失败保持上一次状态
	} finally {
		if (manual) {
			state.connLoading = false;
		}
	}
}

let connTimer: ReturnType<typeof setInterval> | null = null;
onUnmounted(() => {
	if (connTimer) {
		clearInterval(connTimer);
		connTimer = null;
	}
});

/** 组装通知进程需要的参数：优先用当前输入，其次用已保存的 */
function buildNotifyInput() {
	return {
		ocsBase: state.ocsBase.trim() || `https://127.0.0.1:${state.status?.remoteApi?.port || 15320}`,
		apiKey: state.apiKey.trim() || notify.value.apiKey,
		botId: notify.value.botId.trim(),
		targetId: notify.value.targetId.trim(),
		deliveryUrl: notify.value.deliveryUrl.trim() || undefined,
		intervalSec: notify.value.intervalSec
	};
}

async function onToggleNotify(value: string | number | boolean) {
	const enabled = Boolean(value);
	state.notifyBusy = true;
	try {
		if (enabled) {
			const input = buildNotifyInput();
			const result = await remote.methods.call('dshNotifyStart', input);
			// 记住密钥：下次启动 OCS 时自动运行需要它
			notify.value.apiKey = input.apiKey;
			notify.value.enabled = true;
			state.notifyRunning = Boolean(result?.running);
			state.notifyPid = result?.pid || 0;
			state.notifyLog = result?.log || [];
			Message.success('已启动通知监听');
		} else {
			const result = await remote.methods.call('dshNotifyStop');
			notify.value.enabled = false;
			state.notifyRunning = Boolean(result?.running);
			state.notifyPid = 0;
			state.notifyLog = result?.log || [];
			Message.success('已停止通知监听');
		}
	} catch (err) {
		notify.value.enabled = false;
		Message.error('通知启动失败：' + String(err));
	} finally {
		state.notifyBusy = false;
	}
}

async function testNotify() {
	state.notifyBusy = true;
	try {
		const result = await remote.methods.call('dshNotifyTest', buildNotifyInput());
		if (result?.ok) {
			Message.success('测试消息已发送，看看聊天里是否收到');
		} else {
			Message.error('发送失败：' + (result?.message || '未知错误'));
		}
	} catch (err) {
		Message.error('发送失败：' + String(err));
	} finally {
		state.notifyBusy = false;
	}
}

async function refreshNotifyStatus() {
	try {
		const result = await remote.methods.call('dshNotifyStatus');
		state.notifyRunning = Boolean(result?.running);
		state.notifyPid = result?.pid || 0;
		state.notifyLog = result?.log || [];
	} catch (err) {
		Message.error('读取通知状态失败：' + String(err));
	}
}

onMounted(async () => {
	await loadStatus();
	// 优先用主进程加密保存的密钥回填：重启后不需要重新粘贴
	try {
		const revealed = await remote.methods.call('remoteApiRevealKey');
		if (revealed) {
			state.apiKey = revealed;
		}
	} catch {
		// 没有加密副本：保持为空，下面回退到通知配置里的密钥
	}
	if (!state.apiKey) {
		state.apiKey = notify.value.apiKey;
	}
	refreshNotifyStatus();
	refreshConnection();
	connTimer = setInterval(() => refreshConnection(), 5000);
});
</script>

<style scoped lang="less">
.hint {
	font-size: 12px;
	color: var(--color-text-3);
	margin-top: 4px;
}

.break {
	word-break: break-all;
	font-size: 12px;
}
</style>
