<template>
	<a-card title="软件更新">
		<Description label="更新源">
			<a-radio-group
				v-model="state.source"
				size="small"
			>
				<a-radio value="github">GitHub 官方</a-radio>
				<a-radio value="mirror">自建镜像</a-radio>
			</a-radio-group>
			<div class="hint">官方源直接请求 GitHub；自建镜像从下面的地址读取清单并下载安装包，适合国内网络。</div>
		</Description>

		<Description
			v-if="state.source === 'mirror'"
			label="镜像地址"
		>
			<a-input
				v-model="state.mirrorBase"
				size="small"
				style="width: 420px"
				placeholder="https://dl.example.com/ocs"
			/>
			<div class="hint">
				客户端会读取「镜像地址/latest.json」，并按清单里的地址下载。目录结构与清单格式见仓库里的
				<code>tools/update-mirror/README.md</code>。
			</div>
		</Description>

		<a-space class="mt-2">
			<a-button
				type="primary"
				size="small"
				:loading="state.saving"
				@click="save"
			>
				保存
			</a-button>
		</a-space>
		<div class="hint">下次检查更新时生效（重启软件或等待下一次自动检查）。</div>
	</a-card>
</template>

<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { Message } from '@arco-design/web-vue';
import Description from '../Description.vue';
import { remote } from '../../utils/remote';

const state = reactive({
	source: 'github' as 'github' | 'mirror',
	mirrorBase: '',
	saving: false
});

async function load() {
	try {
		const cfg = await remote.methods.call('updateSourceGet');
		state.source = cfg?.source === 'mirror' ? 'mirror' : 'github';
		state.mirrorBase = cfg?.mirrorBase || '';
	} catch (err) {
		Message.error('读取更新源配置失败：' + String(err));
	}
}

async function save() {
	state.saving = true;
	try {
		const cfg = await remote.methods.call('updateSourceSet', {
			source: state.source,
			mirrorBase: state.mirrorBase.trim()
		});
		state.source = cfg?.source === 'mirror' ? 'mirror' : 'github';
		state.mirrorBase = cfg?.mirrorBase || '';
		Message.success('已保存，下次检查更新生效');
	} catch (err) {
		Message.error('保存失败：' + String(err));
	} finally {
		state.saving = false;
	}
}

onMounted(load);
</script>

<style scoped lang="less">
.hint {
	font-size: 12px;
	color: var(--color-text-3);
	margin-top: 4px;
}
</style>
