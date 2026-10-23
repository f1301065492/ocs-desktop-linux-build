<template>
	<Description label="每次启动前清除登录状态">
		<a-tooltip
			content="启用后每次启动会先清掉该浏览器的 cookie 与站点本地存储，等于每次全新登录，可避免「看着已登录、点进课程又要登录」。需配好登录类自动化程序；油猴脚本不受影响。"
		>
			<a-switch v-model="store.render.setting.browser.clearLoginOnLaunch" />
		</a-tooltip>
	</Description>
</template>

<script setup lang="ts">
/**
 * 扩展设置项：「每次启动前清除登录状态」。
 *
 * 上游 SettingPanel.vue 只插入本组件一行；实现见
 * packages/app/src/ext/login-state.ts（启动前清理 cookie / 站点存储）。
 */
import Description from '../../components/Description.vue';
import { store } from '../../store';
</script>
