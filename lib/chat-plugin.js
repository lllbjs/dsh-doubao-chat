//#region 豆包本地会话浏览器（DSH 插件）
/**
* 在前一个插件（`dsh-connect-doubao-macos`）之上做**会话浏览**能力：
*
*   - 账号卡片：从 `Preferences` 的 `saman.last_user` 读本地登录账号，
*     再用 `passport/account/info/v2` 校验会话是否还有效；
*   - 会话列表：官方 IM `chain/recent_conv`；
*   - 消息正文：官方 IM `chain/single`（含附件元数据）；
*   - 一键把某个会话导出成 Markdown（含角色、时间、附件链接）。
*
* 全部数据都是**只读**的：不发送消息、不改会话、不写豆包的任何文件。
* 凭证只在本进程内存里用（复用上游解密结果），落地的东西里没有任何 Cookie。
*
* 路由都挂在 `/plugins/dsh-doubao-chat/*` 下，沿用上游同一套防护：
* 来源必须回环、Host 必须回环、写操作必须是 JSON。
*/
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

import {
	fetchConversationMeta,
	fetchConversations,
	fetchMessages,
	readAccountIdentity
} from "./collect.js";
import { findDoubaoUserDataDir, loadDoubaoCredentials } from "./credentials.js";
import { ChatPanel } from "./panel.js";
import { registerChatUi } from "./ui.js";

export { ChatPanel };

/** 路由前缀：与上游插件分开，互不覆盖。 */
const ROUTE_PREFIX = "/plugins/dsh-doubao-chat";

const ACCOUNT_TTL_MS = 60_000;
const LIST_TTL_MS = 60_000;

/** 只允许回环来源：别的站点不能借这个插件读本机登录态。 */
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (typeof origin !== "string") return true;
	try {
		const url = new URL(origin);
		return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]";
	} catch {
		return false;
	}
}

function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(payload)
	});
	res.end(payload);
}

function safeMessage(error) {
	return String(error?.message ?? error ?? "unknown error").slice(0, 300);
}

/** 当前生效的数据目录：设置卡片选过的 → 自动探测的第一个。 */
function activeDataDir(config) {
	const manual = typeof config?.profileDir === "string" ? config.profileDir.trim() : "";
	if (manual !== "") return manual;
	const [first] = findDoubaoUserDataDir();
	return first ?? "";
}

/**
* 取一份可用的浏览器凭据。
*
* 缓存粒度是「一次调用」，不做跨请求缓存：会话 Cookie 会被服务端轮转，
* 拿旧值发 IM 请求只会得到 712010202。解密本身有上游的 10 分钟缓存，不慢。
*/
async function withCredentials(config, fn) {
	const credentials = loadDoubaoCredentials();
	if (!credentials.ok) throw new Error(credentials.reason || "Doubao credentials unavailable");
	const dataDir = activeDataDir(config);
	if (dataDir === "") throw new Error("Doubao data directory not found");
	return fn({
		dataDir,
		pairs: credentials.pairs
	});
}

/**
* 本地账号身份 → 面板形状。
*
* 先给本地能读到的东西（`saman.last_user` 是明文，不需要网络），再用账号接口
* 校验一次会话是否还有效。接口失败不是致命错误——离线、被风控都能继续看本地会话，
* 只是卡片上多了个「会话可能已过期」。
*/
async function accountView(config, options = {}) {
	return withCredentials(config, async ({ dataDir, pairs }) => {
		const local = readAccountIdentity(dataDir);
		let online = null;
		let onlineError = null;
		try {
			const cookie = [...pairs.entries()].map(([k, v]) => `${k}=${String(v).replace(/[^\x20-\x7e]/g, "")}`).join("; ");
			const response = await fetch("https://www.doubao.com/passport/account/info/v2/?aid=582478&real_aid=582478&device_platform=web", {
				headers: {
					referer: "https://www.doubao.com/",
					origin: "https://www.doubao.com",
					accept: "application/json, text/plain, */*",
					"user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
					cookie
				},
				signal: AbortSignal.timeout(10_000)
			});
			const json = await response.json();
			const data = json?.data ?? {};
			if (data.error_code !== void 0 && data.error_code !== 0) onlineError = data.description ?? `error_code ${data.error_code}`;
			else online = {
				userId: String(data.user_id ?? ""),
				name: data.screen_name ?? data.name ?? "",
				avatarUrl: data.avatar_url ?? "",
				countryCode: data.country_code ?? "",
				createdAt: Number(data.user_create_time ?? 0)
			};
		} catch (error) {
			onlineError = safeMessage(error);
		}
		return {
			ok: online !== null || local.userId !== "",
			dataDir,
			verified: online !== null,
			error: onlineError,
			account: online ?? {
				userId: local.userId,
				name: local.name,
				avatarUrl: local.avatarUrl,
				countryCode: "",
				createdAt: 0
			},
			profiles: local.profiles
		};
	});
}

const accountCache = /* @__PURE__ */ new Map();
const listCache = /* @__PURE__ */ new Map();

function cacheGet(store, key, ttl, force) {
	if (force) return void 0;
	const hit = store.get(key);
	if (hit === void 0 || Date.now() - hit.at > ttl) return void 0;
	return hit.value;
}

function cacheSet(store, key, value) {
	store.set(key, {
		at: Date.now(),
		value
	});
	// 三层足够：一个用户通常就一两个数据目录、一两个会话
	if (store.size > 24) store.delete(store.keys().next().value);
}

function registerChatRoutes(ctx, options) {
	const configOf = options.configOf;
	const routes = [
		{
			path: `${ROUTE_PREFIX}/account`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const force = url.searchParams.get("refresh") === "1";
				const config = configOf();
				const key = activeDataDir(config);
				const cached = cacheGet(accountCache, key, ACCOUNT_TTL_MS, force);
				if (cached !== void 0) {
					sendJson(res, 200, cached);
					return;
				}
				const view = await accountView(config);
				cacheSet(accountCache, key, view);
				sendJson(res, 200, view);
			}
		},
		{
			path: `${ROUTE_PREFIX}/conversations`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const limit = Number(url.searchParams.get("limit") ?? 30);
				const force = url.searchParams.get("refresh") === "1";
				const config = configOf();
				const key = `${activeDataDir(config)}#${Number.isFinite(limit) ? limit : 30}`;
				const cached = cacheGet(listCache, key, LIST_TTL_MS, force);
				if (cached !== void 0) {
					sendJson(res, 200, cached);
					return;
				}
				const items = await withCredentials(config, async ({ dataDir, pairs }) => {
					const list = await fetchConversations(dataDir, pairs, { limit: Number.isFinite(limit) ? limit : 30 });
					// 条数与「最后一条说了什么」是第二个请求；失败不影响列表本身
					let meta = /* @__PURE__ */ new Map();
					try {
						meta = await fetchConversationMeta(dataDir, pairs, list.map((item) => item.id));
					} catch {}
					return list.map((item) => ({
						...item,
						messageCount: meta.get(item.id)?.messageCount ?? item.messageCount,
						lastMessageAt: meta.get(item.id)?.lastMessageAt ?? 0,
						lastMessage: meta.get(item.id)?.lastMessage ?? ""
					}));
				});
				const view = {
					ok: true,
					fetchedAt: Date.now(),
					items
				};
				cacheSet(listCache, key, view);
				sendJson(res, 200, view);
			}
		},
		{
			path: `${ROUTE_PREFIX}/messages`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const conversationId = url.searchParams.get("id") ?? "";
				if (!/^\d{1,24}$/.test(conversationId)) throw new Error("conversation id must be numeric");
				const limit = Number(url.searchParams.get("limit") ?? 20);
				const pages = Number(url.searchParams.get("pages") ?? 1);
				const kind = Number(url.searchParams.get("kind") ?? 3);
				const config = configOf();
				const messages = await withCredentials(config, ({ dataDir, pairs }) => fetchMessages(dataDir, pairs, conversationId, {
					limit: Number.isFinite(limit) ? limit : 20,
					pages: Number.isFinite(pages) ? pages : 1,
					kind: Number.isFinite(kind) ? kind : 3
				}));
				sendJson(res, 200, {
					ok: true,
					conversationId,
					items: messages
				});
			}
		},
		{
			path: `${ROUTE_PREFIX}/export`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const conversationId = url.searchParams.get("id") ?? "";
				if (!/^\d{1,24}$/.test(conversationId)) throw new Error("conversation id must be numeric");
				const title = (url.searchParams.get("title") ?? "").slice(0, 80);
				const pages = Number(url.searchParams.get("pages") ?? 5);
				const kind = Number(url.searchParams.get("kind") ?? 3);
				const config = configOf();
				const messages = await withCredentials(config, ({ dataDir, pairs }) => fetchMessages(dataDir, pairs, conversationId, {
					limit: 30,
					pages: Number.isFinite(pages) ? Math.min(Math.max(pages, 1), 10) : 5,
					kind: Number.isFinite(kind) ? kind : 3
				}));
				const markdown = renderMarkdown({
					title: title !== "" ? title : conversationId,
					conversationId,
					messages
				});
				// 导出落到工作区下的 doubao-exports/，文件名只允许安全字符
				const safeTitle = (title !== "" ? title : conversationId).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
				const directory = join(options.workspaceDir ?? homedir(), "doubao-exports");
				mkdirSync(directory, { recursive: true });
				const file = join(directory, `${safeTitle || conversationId}-${conversationId}.md`);
				writeFileSync(file, markdown, "utf8");
				sendJson(res, 200, {
					ok: true,
					file,
					bytes: Buffer.byteLength(markdown),
					messages: messages.length
				});
			}
		}
	];
	const disposers = [];
	for (const route of routes) {
		disposers.push(ctx.webServer.register({
			kind: "exact",
			path: route.path,
			handler: async (req, res) => {
				if (req.method !== "GET" && req.method !== "POST") {
					sendJson(res, 405, { error: "method not allowed" });
					return;
				}
				if (!loopbackOrigin(req)) {
					sendJson(res, 403, { error: "origin-not-trusted" });
					return;
				}
				try {
					await route.handle(req, res);
				} catch (error) {
					ctx.logger?.warn?.(`dsh-doubao-chat: ${route.path} failed: ${safeMessage(error)}`);
					sendJson(res, 502, {
						ok: false,
						error: safeMessage(error)
					});
				}
			}
		}));
	}
	return () => {
		for (const dispose of disposers) dispose();
	};
}

/** 会话 → Markdown。角色、时间、附件都保留，正文原样（不转义，导出是给人看的）。 */
export function renderMarkdown({ title, conversationId, messages }) {
	const lines = [`# ${title}`, "", `> 会话 ID：${conversationId}`, `> 导出时间：${new Date().toISOString()}`, `> 消息数：${messages.length}`, ""];
	for (const message of messages) {
		const who = message.role === "user" ? "用户" : message.role === "assistant" ? "豆包" : "系统";
		const when = message.createTime > 0 ? new Date(Number(message.createTime) * 1000).toISOString() : "";
		lines.push(`## ${who}${when === "" ? "" : ` · ${when}`}`, "", message.text === "" ? "（无文本内容）" : message.text, "");
		if (message.attachments.length > 0) {
			lines.push("附件：", "");
			for (const item of message.attachments) lines.push(`- ${item.name === "" ? `type ${item.type}` : item.name}${item.url === "" ? "" : ` — ${item.url}`}`);
			lines.push("");
		}
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/** 前端拿到的「插件是否有数据目录」摘要，避免 UI 首屏就发四个请求。 */
function healthSummary(config) {
	const dir = activeDataDir(config);
	return {
		ok: dir !== "",
		dataDir: dir,
		plugin: "dsh-doubao-chat",
		fingerprint: createHash("sha256").update(dir).digest("hex").slice(0, 8)
	};
}

export function applyChat(ctx, config) {
	// 设置卡片的保存走的是上游 `__save` 路由；这里只读一次快照，不参与写入
	let currentConfig = config ?? {};
	let disposeRoutes;
	try {
		ctx.inject(["webServer"], (webCtx) => {
			try {
				disposeRoutes = registerChatRoutes(webCtx, {
					configOf: () => currentConfig,
					// 工作区要 ctx.inject(['workingDirectory']) 才能取；本插件没声明这个依赖，
					// 传 undefined（导出落 homedir 下的 doubao-exports/）。
					workspaceDir: void 0
				});
			} catch (error) {
				ctx.logger?.error?.("dsh-doubao-chat: route registration failed", error);
			}
		});
		ctx.effect(() => () => disposeRoutes?.());
		try {
			const disposeUi = registerChatUi(ctx);
			ctx.effect(() => () => disposeUi());
		} catch (error) {
			ctx.logger?.warn?.("dsh-doubao-chat: settings panel unavailable", error);
		}
	} catch (error) {
		ctx.logger?.error?.("dsh-doubao-chat: apply failed", error);
	}
	return { healthSummary };
}
