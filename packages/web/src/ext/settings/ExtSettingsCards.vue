<template>
	<RemoteApiSetting />
	<UpdateSourceSetting />
	<DshBridgeSetting />
	<SshTunnelSetting />
</template>

<script setup lang="ts">
/**
 * 扩展功能设置卡片（远程 API / 更新源 / DSH 接入 / SSH 隧道）。
 *
 * 上游的 SettingPanel.vue 只插入本组件一次，新增设置卡片时改这里即可，
 * 不用再动上游文件。
 */
import RemoteApiSetting from './RemoteApiSetting.vue';
import UpdateSourceSetting from './UpdateSourceSetting.vue';
import DshBridgeSetting from './DshBridgeSetting.vue';
import SshTunnelSetting from './SshTunnelSetting.vue';
</script>
