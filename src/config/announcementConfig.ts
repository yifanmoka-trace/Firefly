import type { AnnouncementConfig } from "../types/announcementConfig";

export const announcementConfig: AnnouncementConfig = {
	title: "欢迎",

	content: "这是一个技术项目记录的博客，记录了我在学习和工作中遇到的各种技术问题和解决方案，希望能对大家有所帮助！如有不足，敬请斧正。",

	closable: true,

	link: {
		enable: true,
		text: "关于我",
		url: "/about/",
		external: false,
	},
};
