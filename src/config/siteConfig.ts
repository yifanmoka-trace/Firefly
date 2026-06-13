import type { SiteConfig } from "@/types/siteConfig";

// 定义站点语言
// 语言代码，例如：'zh_CN', 'zh_TW', 'en', 'ja', 'ru'。
const SITE_LANG = "zh_CN";

export const siteConfig: SiteConfig = {
	// 站点标题
	title: "一帆摩卡",

	// 站点副标题
	subtitle: "技术博客",

	// 站点 URL
	site_url: "https://yifanmoka.com",

	// 站点描述
	description:
		"一帆摩卡的求职技术博客，专注 Qt/C++ 桌面应用开发，记录项目实践与技术笔记。",

	// 站点关键词
	keywords: [
		"一帆摩卡",
		"yifanmoka",
		"技术博客",
		"Qt开发",
		"C++",
		"桌面应用",
		"项目经验",
		"学习笔记",
	],

	// 主题色
	themeColor: {
		// 专业蓝调色相，适合技术/求职场景
		hue: 250,
		// 固定主题色，保持视觉一致
		fixed: true,
		// 默认亮色模式，阅读更清晰专业
		defaultMode: "light",
	},

	// 页面整体宽度（单位：rem）
	pageWidth: 96,

	// 网站Card样式配置
	card: {
		border: true,
		followTheme: true,
	},

	// Favicon 配置
	favicon: [
		{
			src: "/favicon/favicon.ico",
		},
	],

	// 导航栏配置
	navbar: {
		logo: {
			type: "icon",
			value: "material-symbols:terminal",
		},
		title: "一帆摩卡",
		widthFull: false,
		menuAlign: "center",
		followTheme: true,
		stickyNavbar: true,
	},

	siteStartDate: "2025-01-01",
	timezone: "Asia/Shanghai",

	// 页面开关 — 求职博客仅保留核心页面
	pages: {
		friends: false,
		sponsor: false,
		guestbook: false,
		bangumi: false,
		gallery: false,
	},

	categoryBar: true,

	postListLayout: {
		defaultMode: "list",
		mobileDefaultMode: "list",
		showTags: true,
		descriptionLines: 3,
		allowSwitch: false,
		grid: {
			masonry: false,
			columnWidth: 320,
		},
	},

	post: {
		rehypeCallouts: {
			theme: "github",
			enablePythonMarkdownAdmonitions: false,
		},
		showLastModified: true,
		outdatedThreshold: 30,
		sharePoster: false,
		generateOgImages: false,
	},

	bangumi: {
		userId: "",
		mode: "static",
		apiUrl: "https://api.bangumi.one",
		subjectBaseUrl: "https://bangumi.one/subject/",
		categoryOrder: ["anime", "book", "music", "game"],
	},

	pagination: {
		postsPerPage: 10,
	},

	imageOptimization: {
		formats: "webp",
		quality: 85,
		noReferrerDomains: [],
	},

	lang: SITE_LANG,
};
