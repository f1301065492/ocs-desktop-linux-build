<template>
	<a-card title="远程 API">
		<a-alert
			type="warning"
			class="mb-3"
		>
			开启后，局域网内的其他机器可以用 API 密钥调用本机接口来创建、启动、关闭浏览器实例。
			<template #title>仅在可信内网中开启</template>
			<div>
				请求通过自签证书加密，但密钥本身仍是 bearer token 形式：能拿到密钥的人就能在本机拉起浏览器进程。
				不要把端口暴露到公网。
			</div>
		</a-alert>

		<Description label="启用远程 API">
			<a-switch
				:model-value="state.status?.enabled ?? false"
				:loading="state.saving"
				@change="onToggleEnabled"
			/>
			<span class="ms-2 text-secondary">
				{{ state.status?.listening ? '服务运行中' : '服务未运行' }}
			</span>
		</Description>

		<Description label="监听端口">
			<a-input-number
				:model-value="state.status?.port"
				:min="1024"
				:max="65535"
				:disabled="!state.status?.enabled"
				style="width: 160px"
				@change="onPortChange"
			/>
		</Description>

		<Description label="监听地址">
			<a-select
				:model-value="state.status?.bindAddress"
				:disabled="!state.status?.enabled"
				style="width: 240px"
				@change="onBindAddressChange"
			>
				<a-option value="0.0.0.0"> 0.0.0.0（允许局域网访问） </a-option>
				<a-option value="127.0.0.1"> 127.0.0.1（仅本机） </a-option>
			</a-select>
		</Description>

		<Description label="API 密钥">
			<a-space>
				<a-tag :color="state.status?.hasKey ? 'green' : 'red'">
					{{ state.status?.hasKey ? '已配置' : '未配置' }}
				</a-tag>
				<a-popconfirm
					v-if="state.status?.hasKey"
					content="重新生成后旧密钥立即失效，调用方需要同步更新。确认继续？"
					ok-text="确认"
					cancel-text="取消"
					@ok="generateKey"
				>
					<a-button
						size="small"
						:loading="state.saving"
					>
						重新生成
					</a-button>
				</a-popconfirm>
				<a-button
					v-else
					size="small"
					type="primary"
					:loading="state.saving"
					@click="generateKey"
				>
					生成密钥
				</a-button>
				<a-popconfirm
					v-if="state.status?.hasKey"
					content="清除后远程 API 将无法启动。确认继续？"
					ok-text="确认"
					cancel-text="取消"
					@ok="clearKey"
				>
					<a-button
						size="small"
						status="danger"
						:loading="state.saving"
					>
						清除
					</a-button>
				</a-popconfirm>
			</a-space>
		</Description>

		<a-alert
			v-if="state.freshKey"
			type="success"
			class="mb-3"
		>
			<template #title>请立即保存下面的密钥</template>
			<div class="fresh-key">
				<code>{{ state.freshKey }}</code>
				<a-button
					size="mini"
					class="ms-2"
					@click="copyFreshKey"
				>
					复制
				</a-button>
			</div>
			<div class="mt-2">密钥只以 scrypt 哈希形式保存，明文仅在此处显示这一次，关闭后无法再查看，只能重新生成。</div>
		</a-alert>

		<Description
			v-if="state.status?.lastError"
			label="启动错误"
		>
			<span class="text-danger">{{ state.status.lastError }}</span>
		</Description>

		<Description
			v-if="state.status?.addresses?.length"
			label="可用访问地址"
		>
			<div>
				<div
					v-for="ip in state.status.addresses"
					:key="ip"
				>
					<code>https://{{ ip }}:{{ state.status.port }}/api/v1/health</code>
				</div>
			</div>
		</Description>

		<Description
			v-if="state.status?.certFingerprint"
			label="证书指纹"
		>
			<div class="fingerprint">
				<code>{{ state.status.certFingerprint }}</code>
				<a-popover>
					<template #content>
						<div>自签证书的 SHA-256 指纹。</div>
						<div>调用方应固定此指纹做校验，而不是直接关闭证书验证。</div>
					</template>
					<Icon
						class="ms-2"
						type="help_outline"
					/>
				</a-popover>
			</div>
		</Description>

		<Description label="调用示例">
			<div class="example">
				<code>
					curl -k -H "X-API-Key: &lt;密钥&gt;" https://{{ state.status?.addresses?.[0] || '127.0.0.1' }}:{{
						state.status?.port || 15320
					}}/api/v1/browsers
				</code>
			</div>
		</Description>
	</a-card>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { Message } from '@arco-design/web-vue';
import Description from '../Description.vue';
import Icon from '../Icon.vue';
import { remote } from '../../utils/remote';

interface RemoteApiStatus {
	enabled: boolean;
	port: number;
	bindAddress: string;
	hasKey: boolean;
	keyCreatedAt: number;
	listening: boolean;
	lastError: string | null;
	certFingerprint: string;
	rendererReady: boolean;
	addresses: string[];
}

const state = reactive({
	status: null as RemoteApiStatus | null,
	/** 新生成的密钥明文，只在本次会话里短暂保留 */
	freshKey: '',
	/** 配置变更进行中（重启服务可能要 1~3 秒，首次生成证书更久） */
	saving: false
});

function applyStatus(next: RemoteApiStatus) {
	state.status = next;
}

async function loadStatus() {
	try {
		applyStatus(await remote.methods.call('remoteApiGetStatus'));
	} catch (err) {
		Message.error('读取远程 API 状态失败：' + String(err));
	}
}

/** 统一的配置变更入口，成功后刷新状态 */
async function apply(patch: Record<string, unknown>) {
	state.saving = true;
	try {
		applyStatus(await remote.methods.call('remoteApiUpdateConfig', patch));
	} catch (err) {
		Message.error('应用配置失败：' + String(err));
		// 失败时回读真实状态，避免界面停留在用户期望而非实际的值上
		await loadStatus();
	} finally {
		state.saving = false;
	}
}

function onToggleEnabled(value: string | number | boolean) {
	apply({ enabled: Boolean(value) });
}

function onPortChange(value: number | undefined) {
	if (typeof value === 'number' && Number.isInteger(value)) {
		apply({ port: value });
	}
}

function onBindAddressChange(value: unknown) {
	if (value === '0.0.0.0' || value === '127.0.0.1') {
		apply({ bindAddress: value });
	}
}

async function generateKey() {
	state.saving = true;
	try {
		const result = await remote.methods.call('remoteApiGenerateKey');
		state.freshKey = result.apiKey;
		applyStatus(result.status);
		Message.success('密钥已生成，请立即复制保存');
	} catch (err) {
		Message.error('生成密钥失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

async function clearKey() {
	state.saving = true;
	try {
		applyStatus(await remote.methods.call('remoteApiClearKey'));
		state.freshKey = '';
		Message.success('密钥已清除');
	} catch (err) {
		Message.error('清除密钥失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

async function copyFreshKey() {
	try {
		await navigator.clipboard.writeText(state.freshKey);
		Message.success('已复制到剪贴板');
	} catch {
		Message.warning('复制失败，请手动选中复制');
	}
}

onMounted(loadStatus);
</script>

<style scoped lang="less">
.fresh-key {
	word-break: break-all;
}

.fingerprint,
.example {
	word-break: break-all;
	font-size: 12px;
}
</style>
