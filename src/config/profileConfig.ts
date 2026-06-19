import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.jpg",

	name: "一帆摩卡",

	bio: "Qt / C++ 开发者 · 专注桌面应用开发",

	links: [
		{
			name: "GitHub",
			icon: "fa7-brands:github",
			url: "https://github.com/",
			showName: false,
		},
		{
			name: "Email",
			icon: "fa7-solid:envelope",
			url: "mailto:hello@example.com",
			showName: false,
		},
		{
			name: "RSS",
			icon: "fa7-solid:rss",
			url: "/rss/",
			showName: false,
		},
	],
};
