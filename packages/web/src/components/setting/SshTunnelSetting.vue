<template>
	<a-card title="SSH 反向隧道">
		<a-alert
			type="info"
			class="mb-3"
		>
			<template #title>本机没有公网 IP 时用它</template>
			<div>
				由本机主动连到一台有公网 IP 的 VPS，把远程 API 的端口映射到 VPS 的回环地址上。 映射后<strong
					>只有 VPS 本机能访问</strong
				>，公网碰不到，也不需要改 VPS 的 sshd 配置。
			</div>
		</a-alert>

		<a-alert
			v-if="!remoteApiState.enabled"
			type="warning"
			class="mb-3"
		>
			远程 API 当前未开启，隧道连上也没有服务可转发。请先在上方开启。
		</a-alert>

		<Description label="运行状态">
			<a-space>
				<a-tag :color="stateColor">{{ state.status?.stateText || '-' }}</a-tag>
				<span
					v-if="state.status?.state === 'running'"
					class="text-secondary"
				>
					已运行 {{ formatUptime(state.status.uptimeMs) }}，映射 VPS 的 127.0.0.1:{{ state.status.remotePort }}
				</span>
			</a-space>
		</Description>

		<Description label="启用隧道">
			<a-switch
				:model-value="state.status?.config.enabled ?? false"
				:loading="state.saving"
				@change="onToggleEnabled"
			/>
		</Description>

		<!--
			三个输入框都用本地副本 + v-model。
			Arco 的输入组件是受控的：显示值完全由 modelValue 决定，
			只绑单向 :model-value 而不处理 update:modelValue 的话，
			每次按键后显示值会被 prop 立刻覆盖回去，表现为「打不进字」。
		-->
		<Description label="VPS 地址">
			<a-input
				v-model="state.tempHost"
				placeholder="公网 IP 或域名"
				:style="{ width: '240px' }"
				@change="onHostChange"
			/>
		</Description>

		<Description label="SSH 端口">
			<a-input-number
				v-model="state.tempPort"
				:min="1"
				:max="65535"
				:style="{ width: '160px' }"
				@change="onPortChange"
			/>
			<span class="ms-2 text-secondary">注意未必是 22</span>
		</Description>

		<Description label="SSH 用户名">
			<a-input
				v-model="state.tempUser"
				placeholder="用于登录 VPS 的用户"
				:style="{ width: '240px' }"
				@change="onUserChange"
			/>
		</Description>

		<!-- 公钥 -->
		<Description label="本机公钥">
			<div style="width: 100%">
				<div v-if="state.status?.publicKey">
					<div class="key-box">
						<code>{{ state.status.publicKey }}</code>
					</div>
					<a-space class="mt-2">
						<a-button
							size="small"
							@click="copyPublicKey"
						>
							复制公钥
						</a-button>
						<a-popconfirm
							content="重新生成后旧公钥立即失效，需要去 VPS 更新 authorized_keys。确认继续？"
							ok-text="确认"
							cancel-text="取消"
							@ok="generateKey(true)"
						>
							<a-button
								size="small"
								status="danger"
								:loading="state.saving"
							>
								重新生成
							</a-button>
						</a-popconfirm>
					</a-space>
				</div>
				<div v-else>
					<a-button
						type="primary"
						size="small"
						:loading="state.saving"
						@click="generateKey(false)"
					>
						生成密钥
					</a-button>
					<span class="ms-2 text-secondary">软件会生成一对专用密钥，不碰你已有的 ~/.ssh</span>
				</div>
			</div>
		</Description>

		<!-- 引导：把公钥装上并开公钥认证 -->
		<a-collapse
			v-if="state.status?.publicKey"
			class="mb-3"
		>
			<a-collapse-item header="在 VPS 上要做的两步（点开查看命令）">
				<div class="guide">
					<p>
						<strong>第一步：确认 VPS 允许公钥登录。</strong>很多服务器默认只开密码认证，
						这时隧道会以「认证失败」告终。在该 VPS 上执行：
					</p>
					<pre>
sudo sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
sudo systemctl restart sshd</pre
					>

					<p><strong>第二步：把上面那行公钥写进 VPS 的 authorized_keys。</strong></p>
					<pre>
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '&lt;把上面复制的公钥粘到这里&gt;' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys</pre
					>

					<p class="text-secondary">
						提示：SSH 端口如果被改过（很常见），记得把上面的端口也填对， 否则会一直卡在连接失败。
					</p>
				</div>
			</a-collapse-item>
		</a-collapse>

		<!-- 主机指纹确认 -->
		<div v-if="state.status?.state === 'need_host_key'">
			<a-alert
				type="warning"
				class="mb-3"
			>
				<template #title>首次连接需要确认 VPS 的主机指纹</template>
				<div>
					这是为了防止中间人。请先获取指纹，然后<strong
						>与 VPS 上执行 <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code> 的结果核对</strong
					>， 一致再确认。
				</div>
			</a-alert>

			<Description
				v-if="state.scannedFingerprint"
				label="获取到的指纹"
			>
				<div>
					<code>{{ state.scannedFingerprint }}</code>
				</div>
			</Description>

			<Description label="操作">
				<a-space>
					<a-button
						size="small"
						:loading="state.scanning"
						@click="scanFingerprint"
					>
						获取主机指纹
					</a-button>
					<a-popconfirm
						content="请确认已与 VPS 上的实际指纹核对一致。确认后才会建立连接。"
						ok-text="已核对，连接"
						cancel-text="取消"
						@ok="confirmFingerprint"
					>
						<a-button
							size="small"
							type="primary"
							:disabled="!state.scannedFingerprint"
							:loading="state.saving"
						>
							确认并连接
						</a-button>
					</a-popconfirm>
				</a-space>
			</Description>
		</div>

		<a-alert
			v-if="state.status?.lastError"
			type="error"
			class="mb-3"
		>
			<template #title>连接错误</template>
			<pre class="err">{{ state.status.lastError }}</pre>
		</a-alert>

		<Description label="操作">
			<a-space>
				<a-button
					size="small"
					:loading="state.saving"
					@click="restart"
				>
					重新连接
				</a-button>
				<span class="text-secondary hint"> 修改地址 / 端口 / 用户名后需点「重新连接」才会生效 </span>
			</a-space>
		</Description>

		<Description
			v-if="state.status?.keyPath"
			label="私钥位置"
		>
			<span class="text-secondary fingerprint">{{ state.status.keyPath }}</span>
		</Description>
	</a-card>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive } from 'vue';
import { Message } from '@arco-design/web-vue';
import Description from '../Description.vue';
import { remote } from '../../utils/remote';
import { remoteApiState, refreshRemoteApiState } from './remote-api.state';

interface SshTunnelConfigView {
	enabled: boolean;
	host: string;
	port: number;
	user: string;
	sshPath: string;
	keyPath: string;
	confirmedFingerprint: string;
}

interface SshTunnelStatus {
	config: SshTunnelConfigView;
	state: 'disabled' | 'incomplete' | 'need_host_key' | 'connecting' | 'running' | 'failed';
	stateText: string;
	lastError: string | null;
	publicKey: string | null;
	keyPath: string;
	remotePort: number;
	uptimeMs: number;
}

const state = reactive({
	status: null as SshTunnelStatus | null,
	/** 从 keyscan 取到、待用户确认的指纹 */
	scannedFingerprint: '',
	saving: false,
	scanning: false,
	/** 输入框的本地编辑副本，见模板里的说明 */
	tempHost: '',
	tempPort: 22 as number | undefined,
	tempUser: ''
});

const stateColor = computed(() => {
	switch (state.status?.state) {
		case 'running':
			return 'green';
		case 'failed':
			return 'red';
		case 'need_host_key':
		case 'incomplete':
			return 'orange';
		default:
			return 'gray';
	}
});

function formatUptime(ms: number) {
	const total = Math.floor(ms / 1000);
	if (total < 60) return `${total} 秒`;
	const minutes = Math.floor(total / 60);
	if (minutes < 60) return `${minutes} 分钟`;
	return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function applyStatus(next: SshTunnelStatus) {
	state.status = next;
	// 用服务端的最新值刷新编辑副本。保存失败时 apply() 会回读状态，
	// 于是输入框会自动退回真实值，不会停留在用户以为改成功的内容上
	state.tempHost = next.config.host;
	state.tempPort = next.config.port;
	state.tempUser = next.config.user;
	state.scannedFingerprint = '';
}

async function loadStatus() {
	try {
		applyStatus(await remote.methods.call('sshTunnelGetStatus'));
	} catch (err) {
		Message.error('读取隧道状态失败：' + String(err));
	}
}

/**
 * 统一的配置变更入口。
 *
 * 只有重启（enabled 变化、或用户点重新连接）才动隧道进程；
 * 改地址/端口/用户名只保存不重启——那些字段是逐个填的，
 * 每敲完一格就重连一次不仅浪费，还会在填写途中刷出一堆连接错误。
 */
async function apply(patch: Record<string, unknown>) {
	state.saving = true;
	try {
		applyStatus(await remote.methods.call('sshTunnelUpdateConfig', patch));
	} catch (err) {
		Message.error('应用配置失败：' + String(err));
		// 失败时回读真实状态，避免界面停在你期望而非实际的值上
		await loadStatus();
	} finally {
		state.saving = false;
	}
}

/** 切换开关要立即生效，所以这里带重启 */
async function onToggleEnabled(value: string | number | boolean) {
	await apply({ enabled: Boolean(value) });
	await restart();
}

function onHostChange(value: string) {
	apply({ host: value });
}

function onPortChange(value: number | undefined) {
	if (typeof value === 'number' && Number.isInteger(value)) {
		apply({ port: value });
	}
}

function onUserChange(value: string) {
	apply({ user: value });
}

async function generateKey(force: boolean) {
	state.saving = true;
	try {
		await remote.methods.call('sshTunnelGenerateKey', force);
		await loadStatus();
		Message.success(force ? '已重新生成密钥，请去 VPS 更新 authorized_keys' : '密钥已生成');
	} catch (err) {
		Message.error('生成密钥失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

async function copyPublicKey() {
	try {
		await navigator.clipboard.writeText(state.status?.publicKey ?? '');
		Message.success('公钥已复制');
	} catch {
		Message.warning('复制失败，请手动选中复制');
	}
}

async function scanFingerprint() {
	state.scanning = true;
	try {
		const info = await remote.methods.call('sshTunnelScanHostKey');
		state.scannedFingerprint = info.fingerprint;
	} catch (err) {
		state.scannedFingerprint = '';
		Message.error('获取主机指纹失败：' + String(err));
	} finally {
		state.scanning = false;
	}
}

async function confirmFingerprint() {
	state.saving = true;
	try {
		applyStatus(await remote.methods.call('sshTunnelConfirmHostKey'));
		Message.success('已确认，正在连接');
	} catch (err) {
		Message.error('确认失败：' + String(err));
		await loadStatus();
	} finally {
		state.saving = false;
	}
}

async function restart() {
	state.saving = true;
	try {
		applyStatus(await remote.methods.call('sshTunnelRestart'));
	} catch (err) {
		Message.error('重连失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

onMounted(async () => {
	// 两张卡片的挂载顺序不保证，这里主动刷一次 API 状态兜底；
	// 之后由「远程 API」卡片在每次状态变化时同步过来
	await refreshRemoteApiState();
	await loadStatus();
});
</script>

<style scoped lang="less">
.key-box {
	word-break: break-all;
	background: var(--color-fill-1);
	border-radius: 4px;
	padding: 8px;
	font-size: 12px;
}

.guide {
	font-size: 13px;

	pre {
		background: var(--color-fill-1);
		padding: 8px;
		border-radius: 4px;
		font-size: 12px;
		white-space: pre-wrap;
		word-break: break-all;
	}
}

.err {
	white-space: pre-wrap;
	word-break: break-all;
	font-size: 12px;
	margin: 0;
}

.fingerprint,
.hint {
	font-size: 12px;
}
</style>
