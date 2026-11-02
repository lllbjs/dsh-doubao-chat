import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** 单个 IM 请求的上限：够慢网络拉一页，又不至于把一轮卡死。 */
const IM_TIMEOUT_MS = 15000;

//#region 会话采集（IM chain API）
/**
* 从本机豆包客户端采集「账号 → 会话列表 → 多轮消息 → 附件」。
*
* 三条数据来源，各司其职：
*
*   1. `<profile>/Local State` 的 `profile.info_cache` —— 有哪些 profile；
*   2. `<profile>/Preferences` 的 `saman.last_user` —— 这个 profile 登的是谁
*      （`user_id` / `user_name` / `name` / `avatar_url` / `sec_user_id`），
*      不需要联网就能给出账号卡片；
*   3. `/im/chain/recent_conv`（cmd=3200）+ `/im/chain/single`（cmd=3100）
*      —— 官方 IM 通道，会话与消息的唯一可靠来源。
*
* 为什么走 IM 而不是网页接口：网页会话列表需要 `a_bogus` 签名，签名算法随前端
* 发版漂移；IM 通道只认登录态 Cookie，是客户端自己在用的那条路。
*
* 与 daddysuite 的 `doubao-lib.js` 保持同一套参数形状（`channel=2`、`version=1`、
* `doucbao_device_platform=desktop` 等），因为这些值直接决定网关是否把请求当
* 客户端流量 —— 改一个就可能被降级或打风控。
*/
const IM_CONV_PATH = "/im/chain/recent_conv";
const IM_MSG_PATH = "/im/chain/single";

/** 解密后的 Cookie 值会被塞进请求头：滤掉非可见字符，防止 ERR_INVALID_CHAR。 */
function sanitizeCookieValue(value) {
	return String(value).replace(/[^\x20-\x7e]/g, "");
}

/**
* IM 侧只要这 5 条就够认证。
*
* 整库 30 多条塞进去既超长又会带上 `LARK_SUITE_ACCESS_TOKEN` 这类无关令牌；
* 客户端自己调 IM 时也只带这几条。
*/
const IM_COOKIE_NAMES = ["sessionid", "sid_guard", "ttwid", "uid_tt", "multi_sids"];

function buildImCookie(pairs) {
	const sessionid = sanitizeCookieValue(pairs.get("sessionid") ?? pairs.get("sid_tt") ?? "");
	if (sessionid === "") throw new Error("no sessionid in the Doubao jar");
	const parts = [`sessionid=${sessionid}`];
	for (const name of IM_COOKIE_NAMES) {
		if (name === "sessionid") continue;
		const value = pairs.get(name);
		if (value === void 0 || value === "") continue;
		parts.push(`${name}=${sanitizeCookieValue(value)}`);
	}
	return parts.join("; ");
}

/** `<profile>/Preferences` 里 `saman.local_storage_for_web["frontend-request-cache"]` 是字符串化 JSON。 */
function readLocalCache(prefsPath) {
	try {
		const cache = JSON.parse(readFileSync(prefsPath, "utf8"))?.saman?.local_storage_for_web?.["frontend-request-cache"];
		return typeof cache === "string" ? cache : "";
	} catch {
		return "";
	}
}

/**
* 从字符串化 JSON 里抠一个字符串字段。
*
* 那一段是「被当成字符串塞进去的 JSON」，经常是半个对象（被截断或转义混合），
* 整段 parse 会炸；只能按标记切片。`web_id` 是纯数字，按数字边界截。
*/
function pickString(cache, key) {
	const marker = `"${key}":"`;
	const at = cache.indexOf(marker);
	if (at < 0) return "";
	const rest = cache.slice(at + marker.length);
	const end = rest.search(/[^0-9A-Za-z_-]/);
	return end < 0 ? rest : rest.slice(0, end);
}

/** 设备标识：`Local State` 的 `aha.device.device_id` 与前端的 `web_id`。 */
function readDeviceIdentity(dataDir) {
	let deviceId = "";
	try {
		const state = JSON.parse(readFileSync(join(dataDir, "Local State"), "utf8"));
		// Chromium 把超过 2^53 的 int64 存成**字符串**，豆包有些版本存的是数字。
		// 数字分支要走 BigInt：直接 String(2240142649904379) 在 JS 里会长这样
		// "2240142649904380" 或科学计数法，网关当场回 712017020（序列化错误）。
		const raw = state?.aha?.device?.device_id;
		deviceId = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? BigInt(raw).toString() : "";
	} catch {}
	const profiles = listProfilesIn(dataDir);
	const first = profiles.includes("Default") ? "Default" : profiles[0];
	const cache = first === void 0 ? "" : readLocalCache(join(dataDir, first, "Preferences"));
	const webId = pickString(cache, "web_id");
	return {
		deviceId,
		webId
	};
}

/** IM 公共 query（缺 device_id/web_id 时网关会给 712010702）。 */
function buildImQuery(dataDir, platform) {
	const { deviceId, webId } = readDeviceIdentity(dataDir);
	const params = new URLSearchParams({
		version_code: "20800",
		language: "zh",
		device_platform: "web",
		doubao_device_platform: "desktop",
		aid: "582478",
		real_aid: "582478",
		pkg_type: "release_version",
		pc_version: "2.31.4",
		doubao_pc_version: "2.31.4",
		region: "CN",
		sys_region: "CN",
		samantha_web: "1",
		web_platform: "desktop",
		"use-olympus-account": "1",
		runtime: "web",
		runtime_version: "3.39.0",
		client_platform: "pc_client",
		chromium_version: "147.0.7727.149",
		channel: platform === "darwin" ? "mac_official" : "win",
		web_tab_id: randomUUID()
	});
	if (deviceId !== "") {
		params.set("device_id", deviceId);
		params.set("tea_uuid", deviceId);
		params.set("fp", `verify_${deviceId}`);
	}
	if (webId !== "") params.set("web_id", webId);
	return params.toString();
}

async function imPost(dataDir, pairs, path, body, signal) {
	const url = `https://www.doubao.com${path}?${buildImQuery(dataDir, process.platform)}`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), IM_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json; encoding=utf-8",
				cookie: buildImCookie(pairs),
				"agw-js-conv": "str",
				"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 SamanthaDoubao/2.31.4",
				accept: "application/json, text/plain, */*",
				referer: "https://www.doubao.com/"
			},
			body: JSON.stringify(body),
			signal: controller.signal
		});
		const text = await response.text();
		if (!response.ok) throw new Error(`IM ${path} HTTP ${response.status}: ${text.slice(0, 120)}`);
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`IM ${path} returned non-JSON: ${text.slice(0, 120)}`);
		}
		const code = json.status_code ?? -1;
		if (code !== 0) throw new Error(`IM ${path} code=${code} ${json.status_desc ?? ""}`);
		return json;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

/** 一条来自 /im 的会话 → 面板要的形状（字段名去下划线、只留有用的）。 */
function normalizeConversation(raw) {
	if (raw === void 0 || raw === null || typeof raw !== "object") return void 0;
	const id = raw.conversation_id;
	if (id === void 0 || id === "") return void 0;
	return {
		id: String(id),
		title: raw.name ?? raw.title ?? raw.conversation_name ?? "",
		kind: typeof raw.conversation_type === "number" ? raw.conversation_type : 0,
		updatedAt: raw.update_time ?? raw.last_message_time ?? raw.modify_time ?? 0,
		messageCount: raw.message_count ?? raw.total_message_count ?? 0,
		unread: raw.badge_count ?? raw.read_badge_count ?? 0,
		lastSectionId: raw.last_section_id ?? "",
		iconUrl: raw.icon_url ?? ""
	};
}

/** 拉会话列表。`limit` 上限 50（网关硬限），翻页靠 `conv_version`。 */
async function fetchConversations(dataDir, pairs, options = {}) {
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 50);
	const signal = options.signal;
	const json = await imPost(dataDir, pairs, IM_CONV_PATH, {
		cmd: 3200,
		uplink_body: {
			pull_recent_conv_chain_uplink_body: {
				limit,
				message_count_per_conv: 0,
				api_version: 1,
				// 官方客户端永远发数字 0，不要发字符串
				conv_version: 0,
				direction: 3,
				option: {
					not_need_message: true,
					need_complete_conversation: true,
					need_coco_bot: true,
					need_pc_pin_chain: true,
					pc_pin_query_type: 0,
					exclude_archive: true,
					only_archive: false
				}
			}
		},
		sequence_id: randomUUID(),
		channel: 2,
		version: "1"
	}, signal);
	const body = json.downlink_body?.pull_recent_conv_chain_downlink_body ?? {};
	const cells = Array.isArray(body.cells) ? body.cells : [];
	const out = [];
	for (const cell of cells) {
		const conv = normalizeConversation(cell?.conversation ?? cell);
		if (conv !== void 0 && !out.some((c) => c.id === conv.id)) out.push(conv);
	}
	return out;
}

/**
* 把 IM 的 message 还原成纯文本。
*
* 消息正文有两处：`content` 是「字符串化的 JSON 数组」（content_block 的拷贝），
* `content_block` 是已经解析好的同一份。以 content_block 为准，content 只兜底。
*/
function messageText(raw) {
	const blocks = Array.isArray(raw.content_block) ? raw.content_block : [];
	const fromBlocks = [];
	for (const block of blocks) {
		const text = block?.content?.text_block?.text;
		if (typeof text === "string" && text !== "") fromBlocks.push(text);
	}
	if (fromBlocks.length > 0) return fromBlocks.join("");
	// `content` 可能是 JSON 字符串（客户端把 content_block 序列化后又放了一份），
	// 先 parse 再取；parse 不了才当纯文本用 —— 顺序反了会把整段 JSON 当正文显示。
	if (typeof raw.content === "string") try {
		const parsed = JSON.parse(raw.content);
		const fromParsed = contentToText(parsed);
		if (fromParsed !== "") return fromParsed;
	} catch {}
	return contentToText(raw.content);
}

/** 把 IM 的 content 字段还原成纯文本（字符串 / 数组 / 对象三种形状都接）。 */
function contentToText(content) {
	if (content === void 0 || content === null) return "";
	if (typeof content === "string") return content;
	// 既可能是顶层 block 数组，也可能是 block.content 数组（嵌套一层）
	if (Array.isArray(content)) return content.map((item) => contentToText(item?.content ?? item)).filter(Boolean).join("");
	if (typeof content === "object") {
		if (typeof content.text === "string") return content.text;
		// IM / content_block 的正文只在这种形状里
		const blockText = content.text_block?.text;
		if (typeof blockText === "string") return blockText;
		if (Array.isArray(content.content_block)) return contentToText(content.content_block.map((b) => b?.content));
		if (typeof content.content === "string") return content.content;
		if (Array.isArray(content.content)) return contentToText(content.content);
		if (typeof content.rich_text === "string") return content.rich_text;
	}
	return "";
}

/** 角色判定：IM 消息没有 role 字段，靠 sender 与 user_type 反推。 */
function messageRole(raw) {
	if (typeof raw.role === "string" && raw.role === "user") return "user";
	if (typeof raw.role === "string" && raw.role === "assistant") return "assistant";
	// user_type: 1 = 本机用户，2 = bot；其它值（网关/系统消息）当 assistant 侧的
	// 系统行处理，前端按 role 决定缩进，不会把它误挂到用户头上。
	const sender = String(raw.sender_id ?? "");
	if (sender !== "" && sender === String(raw.conversation_id ?? " ")) return "unknown";
	if (raw.user_type === 1) return "user";
	if (raw.user_type === 2) return "assistant";
	return "assistant";
}

/** 一条 IM 消息 → 面板形状。附件只留元数据（id/类型/地址），不下载。 */
function normalizeMessage(raw) {
	if (raw === void 0 || raw === null || typeof raw !== "object") return void 0;
	const text = messageText(raw).trim();
	const blocks = Array.isArray(raw.content_block) ? raw.content_block : [];
	const attachments = [];
	if (Array.isArray(blocks)) for (const block of blocks) {
		if (block === void 0 || typeof block !== "object") continue;
		const type = block.block_type ?? 0;
		if (type === 10000) continue;
		attachments.push({
			type,
			name: block.name ?? block.file_name ?? "",
			url: block.url ?? block.image_url ?? block.file_url ?? ""
		});
	}
	return {
		id: String(raw.message_id ?? raw.msg_id ?? raw.id ?? ""),
		role: messageRole(raw),
		createTime: Number(raw.create_time ?? raw.createTime ?? 0),
		text: text.length > 8000 ? `${text.slice(0, 8000)}…` : text,
		attachments: attachments.slice(0, 8)
	};
}

/**
* 拉一轮会话的消息。
*
* IM 的 `chain/single` 按「游标」分页：首屏给 `index_in_conv` 上限，往回翻。
* 这里只要最近 N 轮，够面板展示，也避免把一次请求拖成几十秒。
*/
async function fetchMessages(dataDir, pairs, conversationId, options = {}) {
	const limit = Math.min(Math.max(options.limit ?? 20, 1), 30);
	const pages = Math.max(1, Math.min(options.pages ?? 1, 5));
	const collected = [];
	// 游标从 int64 最大值开始 = 「从最新往回翻」，回到 index 0 为止
	let anchor = Number.MAX_SAFE_INTEGER;
	for (let page = 0; page < pages; page += 1) {
		const json = await imPost(dataDir, pairs, IM_MSG_PATH, {
			cmd: 3100,
			uplink_body: {
				// 注意拼写：网关认的是 `pull_singe_chain_uplink_body`（少一个 l），
				// 写对成 "single" 会被当成缺字段，回 712010202。
				pull_singe_chain_uplink_body: {
					conversation_id: String(conversationId),
					anchor_index: anchor,
					conversation_type: options.kind ?? 3,
					direction: 1,
					limit,
					ext: {},
					filter: {
						index_list: []
					},
					evaluate_ab_params: "",
					evaluate_common_params: ""
				}
			},
			sequence_id: randomUUID(),
			channel: 2,
			version: "1"
		}, options.signal);
		const body = json.downlink_body ?? {};
		const raw = body.pull_singe_chain_downlink_body?.messages ?? body.pull_single_chain_downlink_body?.messages ?? [];
		if (!Array.isArray(raw) || raw.length === 0) break;
		const pageMessages = [];
		for (const entry of raw) {
			const message = normalizeMessage(entry?.message ?? entry);
			if (message !== void 0) pageMessages.push({
				...message,
				index: Number(entry?.index_in_conv ?? entry?.index ?? 0)
			});
		}
		for (const message of pageMessages) if (!collected.some((m) => m.id === message.id && m.id !== "")) collected.push(message);
		let oldest = Number.POSITIVE_INFINITY;
		for (const message of pageMessages) if (message.index > 0 && message.index < oldest) oldest = message.index;
		if (!Number.isFinite(oldest) || oldest <= 0) break;
		anchor = oldest;
	}
	collected.sort((a, b) => a.index - b.index || Number(a.createTime) - Number(b.createTime));
	return collected.map(({ index, ...message }) => message);
}
//#endregion

/** 一个数据目录下的 profile 名（Default / Profile N），先看 Local State，再兜底扫目录。 */
function listProfilesIn(dataDir) {
	let names = [];
	try {
		const cache = JSON.parse(readFileSync(join(dataDir, "Local State"), "utf8"))?.profile?.info_cache;
		if (cache !== null && typeof cache === "object") names = Object.keys(cache);
	} catch {}
	if (names.length === 0) try {
		names = readdirSync(dataDir).filter((name) => name === "Default" || name.startsWith("Profile "));
	} catch {}
	return names;
}

/**
* 直接问 IM「这个会话有几条消息、最后更新在什么时候」。
*
* 会话列表只给 `badge_count`（未读数）和 `update_time`，没有总条数与最后一条
* 的时间——面板上显示「23 条 · 3 分钟前」比「未读 23」有用得多。这里按
* `conversation_id` 再调一次 `recent_conv`，让网关用「已知会话」的方式回填。
*/
async function fetchConversationMeta(dataDir, pairs, conversationIds, options = {}) {
	const ids = [...new Set(conversationIds.map(String).filter((id) => /^\d{1,24}$/.test(id)))];
	if (ids.length === 0) return new Map();
	const json = await imPost(dataDir, pairs, IM_CONV_PATH, {
		cmd: 3200,
		uplink_body: {
			pull_recent_conv_chain_uplink_body: {
				limit: ids.length,
				message_count_per_conv: 1,
				api_version: 1,
				conv_version: 0,
				direction: 3,
				// 已知会话：网关按 id 精确返回，而不是「最近 N 个」
				conversation_ids: ids,
				option: {
					not_need_message: false,
					need_complete_conversation: true,
					need_coco_bot: true,
					need_pc_pin_chain: true,
					pc_pin_query_type: 0,
					exclude_archive: true,
					only_archive: false
				}
			}
		},
		sequence_id: randomUUID(),
		channel: 2,
		version: "1"
	}, options.signal);
	const body = json.downlink_body?.pull_recent_conv_chain_downlink_body ?? {};
	const cells = Array.isArray(body.cells) ? body.cells : [];
	const out = new Map();
	for (const cell of cells) {
		const raw = cell?.conversation;
		if (raw === void 0) continue;
		const messages = Array.isArray(raw.messages) ? raw.messages : [];
		const last = messages[messages.length - 1];
		out.set(String(raw.conversation_id), {
			messageCount: Number(raw.message_count ?? raw.total_message_count ?? 0) || messages.length,
			lastMessageAt: Number(last?.create_time ?? raw.update_time ?? 0),
			lastMessage: last === void 0 ? "" : messageText(last).slice(0, 80)
		});
	}
	return out;
}

export {
	contentToText,
	fetchConversationMeta,
	fetchConversations,
	fetchMessages,
	normalizeConversation,
	normalizeMessage,
	readDeviceIdentity
};

/**
* 本机登录的账号身份（不联网）。
*
* 数据全在 `<dataDir>/<profile>/Preferences` 的 `saman.last_user` 里：
* `user_id` / `user_name` / `name` / `avatar_url` / `sec_user_id`。这是客户端自己
* 写的明文，读它不需要钥匙串，也不需要账号接口——所以离线也能显示「现在登的是谁」。
*
* 一个数据目录可能有多个 profile（Default / Profile 2），按顺序取第一个带
* `user_id` 的；偶尔两个 profile 登的是同一个号（豆包的「多开」就是复制目录）。
*/
function readAccountIdentity(dataDir) {
	const profiles = listProfilesIn(dataDir);
	let first;
	const out = [];
	for (const profile of profiles) {
		let prefs;
		try {
			prefs = JSON.parse(readFileSync(join(dataDir, profile, "Preferences"), "utf8"));
		} catch {
			continue;
		}
		const lastUser = prefs?.saman?.last_user;
		if (lastUser === void 0 || lastUser === null || typeof lastUser !== "object") continue;
		const userId = String(lastUser.user_id ?? "");
		const entry = {
			profile,
			userId,
			name: String(lastUser.name ?? lastUser.user_name ?? ""),
			userName: String(lastUser.user_name ?? ""),
			avatarUrl: String(lastUser.avatar_url ?? ""),
			secUserId: String(lastUser.sec_user_id ?? "")
		};
		out.push(entry);
		if (userId !== "" && first === void 0) first = entry;
	}
	const chosen = first ?? out[0];
	return {
		userId: chosen?.userId ?? "",
		name: chosen?.name ?? "",
		avatarUrl: chosen?.avatarUrl ?? "",
		profiles: out
	};
}

export { readAccountIdentity };
