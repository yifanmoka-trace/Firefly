import type { Live2DWidgetConfig, SpineModelConfig } from "../types/pioConfig";

// Spine 看板娘配置 — 模型文件已移除，如需使用请重新放置模型到 public/pio/models/
export const spineModelConfig: SpineModelConfig = {
	enable: false,
	model: {
		path: "",
		scale: 1.0,
		x: 0,
		y: 0,
	},
	position: {
		corner: "bottom-left",
		offsetX: 0,
		offsetY: 0,
	},
	size: {
		width: 135,
		height: 165,
	},
	interactive: {
		enabled: true,
		clickAnimations: [],
		clickMessages: [],
		messageDisplayTime: 3000,
		idleAnimations: [],
		idleInterval: 8000,
	},
	responsive: {
		hideOnMobile: true,
		mobileBreakpoint: 768,
	},
	zIndex: 1000,
	opacity: 1.0,
};

// Live2D 看板娘配置 — 本地模型已移除，如需使用可引用外部模型 URL
export const live2dWidgetConfig: Live2DWidgetConfig = {
	enable: false,
	model: [
		{
			path: "https://model.hacxy.cn/cat-black/model.json",
			volume: 0,
			scale: 1,
			x: 0,
			y: 0,
		},
	],
	position: "bottom-left" as const,
	size: { width: 200, height: 200 },
	primaryColor: "var(--l2d-msg-bg)",
	transitionDuration: 1500,
	transitionType: "slide" as const,
	menus: {
		items: [
			{
				icon: "mdi:home",
				label: "返回主页",
				action: "home",
			},
			{
				icon: "mdi:arrow-up",
				label: "返回顶部",
				action: "scrollToTop",
			},
			{
				icon: "mdi:bed",
				label: "休眠",
				action: "sleep",
			},
			{
				icon: "mdi:swap-horizontal",
				label: "切换模型",
				action: "switchModel",
			},
			{
				icon: "mdi:github",
				label: "GitHub",
				action: "github",
			},
		],
		align: "right" as const,
	},
	tips: {
		enable: true,
		welcomeMessage: ["你好呀！", "欢迎来到我的世界！"],
		messages: [
			"有什么需要帮助的吗？",
			"今天天气真不错呢！",
			"要不要一起玩游戏？",
			"记得按时休息哦！",
		],
		duration: 3000,
		interval: 6000,
		offset: {
			x: 0,
			y: 0,
		},
	},
	responsive: {
		hideOnMobile: true,
		mobileBreakpoint: 768,
	},
};
