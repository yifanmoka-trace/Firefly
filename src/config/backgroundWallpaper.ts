import type { BackgroundWallpaperConfig } from "@/types/backgroundWallpaper";

export const backgroundWallpaper: BackgroundWallpaperConfig = {
	// 纯色背景，简洁专业
	mode: "none",
	switchable: false,
	src: {
		desktop: "assets/images/DesktopWallpaper/d1.avif",
		mobile: "assets/images/MobileWallpaper/m1.avif",
	},
	common: {
		dimOpacity: 0.15,
		homeText: {
			enable: true,
			switchable: false,
			title: "一帆摩卡",
			titleSize: "3rem",
			subtitle: [
				"记录技术成长",
				"分享项目实践",
				"沉淀学习笔记",
			],
			subtitleSize: "1.25rem",
			typewriter: {
				enable: true,
				speed: 80,
				deleteSpeed: 40,
				pauseTime: 2500,
			},
		},
		navbar: {
			transparentMode: "semi",
			enableBlur: true,
			blur: 8,
		},
		waves: {
			enable: {
				desktop: false,
				mobile: false,
			},
			switchable: false,
		},
		gradient: {
			enable: {
				desktop: false,
				mobile: false,
			},
			switchable: false,
		},
	},
	banner: {
		position: "center",
		carousel: {
			enable: false,
			interval: 5000,
			switchable: false,
		},
	},
	overlay: {
		switchable: {
			opacity: false,
			blur: false,
			cardOpacity: false,
		},
		zIndex: -1,
		opacity: 0.8,
		blur: 10,
		cardOpacity: 0.5,
	},
	fullscreen: {
		position: "center",
	},
};
