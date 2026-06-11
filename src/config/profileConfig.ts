import type { ProfileConfig } from "../types/profileConfig";

export const profileConfig: ProfileConfig = {
	avatar: "assets/images/avatar.avif",

	name: "一帆摩卡",

	bio: "前端 / 全栈方向 · 持续学习与输出",

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
