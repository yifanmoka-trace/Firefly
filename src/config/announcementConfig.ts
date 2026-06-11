import type { AnnouncementConfig } from "../types/announcementConfig";

export const announcementConfig: AnnouncementConfig = {
	title: "欢迎",

	content: "本站正在建设中，将陆续发布技术笔记、项目总结与求职相关分享。",

	closable: true,

	link: {
		enable: true,
		text: "关于我",
		url: "/about/",
		external: false,
	},
};
