import type { BackgroundWallpaperConfig } from "@/types/backgroundWallpaper";

export const backgroundWallpaper: BackgroundWallpaperConfig = {
	// 壁纸背景，深色科技感
	mode: "wallpaper",
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
				"Qt / C++ 开发者",
				"专注桌面应用开发",
				"记录技术成长与项目实践",
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
