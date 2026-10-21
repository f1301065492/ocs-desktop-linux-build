<template>
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
				跨用户读写不了。用 root 在终端执行：
				<div class="break mt-1">
					<code>{{ rootCommand }}</code>
					<a-button
						size="mini"
						class="ms-2"
						@click="copyRootCommand"
					>
						复制
					</a-button>
				</div>
				<div class="mt-1">
					或者把 DSH 改成和 OCS 同一个用户运行（用哪个用户跑 DSH，配置就写在它的 ~/.dsh 下）。
					写完重启 DSH，以聊天里是否出现 <code>mcp__ocs__*</code> 为准；OCS 读不到那份文件，卡片上不会显示"已配置"。
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
					<span class="text-secondary">{{ state.status.remoteApi.bindAddress }}:{{ state.status.remoteApi.port }}</span>
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
				OCS 只保存密钥的哈希、取不回明文，所以这里需要你填。点「生成新密钥」会顺手填进来（记得同步给其他调用方）。
			</div>
		</Description>

		<Description label="证书指纹">
			<span class="text-secondary">{{ state.status?.remoteApi.certFingerprint || '（远程 API 启动后才有）' }}</span>
			<div class="hint">自签证书的 SHA-256 指纹，会一起写进配置做固定校验。</div>
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
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { Message } from '@arco-design/web-vue';
import Description from '../Description.vue';
import { remote } from '../../utils/remote';

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
	dshHome: '',
	profile: '',
	ocsBase: '',
	apiKey: '',
	result: null as { file: string; backup: string } | null
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
			dshHome: state.dshHome.trim()
		});
		state.result = result;
		Message.success('已写入 DSH 配置');
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

onMounted(loadStatus);
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
