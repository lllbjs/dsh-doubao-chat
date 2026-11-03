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
	listDoubaoAccounts,
	readAccountIdentity
} from "./collect.js";
import { findDoubaoUserDataDir, loadDoubaoCredentialsForProfile } from "./credentials.js";
import { ChatPanel } from "./panel.js";
import { registerChatUi } from "./ui.js";

export { ChatPanel };

/** 路由前缀：与上游插件分开，互不覆盖。 */
const ROUTE_PREFIX = "/plugins/dsh-doubao-chat";

const ACCOUNT_TTL_MS = 60_000;
const ACCOUNTS_TTL_MS = 60_000;
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
* 按名字解析一个账号。`name` 是 profile 名（`Default` / `Profile 2`）。
*
* 省略 `name` 时的回落顺序刻意保持向后兼容：
*   1. 设置卡片指定过完整 profileDir，且它就是某个账号的 profile → 用那个账号；
*   2. 否则用列表里第一个（Local State 顺序，Default 通常在首位）——与单账号时代一致。
* 给了 `name` 但枚举里没有 → 抛错，绝不静默切到别的账号（用户以为在看 A 实际看了 B
* 比直接报错糟得多）。
*/
async function resolveAccount(config, name) {
	const dataDir = activeDataDir(config);
	if (dataDir === "") throw new Error("Doubao data directory not found");
	const accounts = listDoubaoAccounts(dataDir);
	if (accounts.length === 0) throw new Error("no logged-in Doubao account in " + dataDir);
	const manual = typeof config?.profileDir === "string" ? config.profileDir.trim() : "";
	if (typeof name === "string" && name !== "") {
		const hit = accounts.find((account) => account.profile === name);
		if (hit === void 0) throw new Error("unknown account " + JSON.stringify(name) + "; available: " + accounts.map((a) => a.profile).join(", "));
		return hit;
	}
	if (manual !== "") {
		const byDir = accounts.find((account) => account.profileDir === manual);
		if (byDir !== void 0) return byDir;
	}
	return accounts[0];
}

/**
* 取一份「某个账号」的浏览器凭据，并把 profileDir 交给采集层（IM 用它的 web_id）。
*
* 缓存粒度是「一次调用」，不做跨请求缓存：会话 Cookie 会被服务端轮转，
* 拿旧值发 IM 请求只会得到 712010202。解密本身有上游的 10 分钟缓存，不慢。
* 同一把钥匙串密钥能解全部 profile，这里按 profileDir 精确解出该账号的 Cookie。
*/
async function withAccount(config, name, fn) {
	const account = await resolveAccount(config, name);
	const credentials = loadDoubaoCredentialsForProfile(account.profileDir);
	if (!credentials.ok) throw new Error(credentials.reason || "Doubao credentials unavailable");
	return fn({
		account,
		dataDir: account.profileDir.replace(/[\\/](?:Default|Profile \d+)$/, ""),
		pairs: credentials.pairs
	});
}

/**
* 单账号视图：本地身份 → 校验会话是否有效。
*
* 先给本地能读到的东西（`saman.last_user` 是明文，不需要网络），再用账号接口
* 校验一次会话是否还有效。接口失败不是致命错误——离线、被风控都能继续看本地会话，
* 只是卡片上多了个「会话可能已过期」。
*/
async function accountView(config, accountName) {
	return withAccount(config, accountName, async ({ account, pairs }) => {
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
			ok: online !== null || account.userId !== "",
			dataDir: account.profileDir.replace(/[\\/](?:Default|Profile \d+)$/, ""),
			verified: online !== null,
			error: onlineError,
			account: online ?? {
				userId: account.userId,
				name: account.name,
				avatarUrl: account.avatarUrl,
				countryCode: "",
				createdAt: 0
			},
			accountName: account.profile,
			profiles: [{ profile: account.profile, profileDir: account.profileDir, userId: account.userId, name: account.name, avatarUrl: account.avatarUrl, webId: account.webId }]
		};
	});
}

/**
* 枚举所有账号（多账号入口）。
*
* 返回每个账号的 userId / name / avatarUrl，以及一个 `available` 字段：尝试解密
* Cookie、成功才算 available（Cookie 失效、解密失败都标 false）。这个探测只跑
* 一轮——每个账号一次按 profile 解密（有 10 分钟缓存，成本可忽略），不发网络请求。
* 不做「当前生效」这个概念（那是面板/调用方的选择），只给一份干净的清单。
*/
async function accountsView(config) {
	const dataDir = activeDataDir(config);
	if (dataDir === "") return { ok: false, dataDir: "", accounts: [], error: "Doubao data directory not found" };
	const accounts = listDoubaoAccounts(dataDir);
	const out = [];
	for (const account of accounts) {
		const credentials = loadDoubaoCredentialsForProfile(account.profileDir);
		out.push({
			profile: account.profile,
			profileDir: account.profileDir,
			userId: account.userId,
			name: account.name,
			userName: account.userName,
			avatarUrl: account.avatarUrl,
			webId: account.webId,
			available: credentials.ok === true,
			reason: credentials.ok === true ? "" : (credentials.reason ?? "credentials unavailable")
		});
	}
	return { ok: true, dataDir, accounts: out, error: "" };
}

const accountCache = /* @__PURE__ */ new Map();
const accountsCache = /* @__PURE__ */ new Map();
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
			// 多账号清单：本机登录过的每个账号 + 凭据是否可用。
			// 调用方（面板 / curl）从这里拿到 profile 名，再拿它当 ?account= 去查别的路由。
			path: `${ROUTE_PREFIX}/accounts`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const force = url.searchParams.get("refresh") === "1";
				const config = configOf();
				const key = activeDataDir(config);
				const cached = cacheGet(accountsCache, key, ACCOUNTS_TTL_MS, force);
				if (cached !== void 0) {
					sendJson(res, 200, cached);
					return;
				}
				const view = await accountsView(config);
				cacheSet(accountsCache, key, view);
				sendJson(res, 200, view);
			}
		},
		{
			path: `${ROUTE_PREFIX}/account`,
			handle: async (req, res) => {
				const url = new URL(req.url, "http://127.0.0.1");
				const force = url.searchParams.get("refresh") === "1";
				const config = configOf();
				// ?account=<profile 名>：省略则回落到「设置卡片指定的 → 列表第一个」
				const accountName = url.searchParams.get("account") ?? "";
				const key = `${activeDataDir(config)}#${accountName}`;
				const cached = cacheGet(accountCache, key, ACCOUNT_TTL_MS, force);
				if (cached !== void 0) {
					sendJson(res, 200, cached);
					return;
				}
				const view = await accountView(config, accountName);
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
				// 会话按账号隔离：缓存键带 profile，否则 A 账号的列表会被 B 复用
				const accountName = url.searchParams.get("account") ?? "";
				const key = `${activeDataDir(config)}#${accountName}#${Number.isFinite(limit) ? limit : 30}`;
				const cached = cacheGet(listCache, key, LIST_TTL_MS, force);
				if (cached !== void 0) {
					sendJson(res, 200, cached);
					return;
				}
				const items = await withAccount(config, accountName, async ({ account, dataDir, pairs }) => {
					const list = await fetchConversations(dataDir, pairs, { limit: Number.isFinite(limit) ? limit : 30, profileDir: account.profileDir });
					// 条数与「最后一条说了什么」是第二个请求；失败不影响列表本身
					let meta = /* @__PURE__ */ new Map();
					try {
						meta = await fetchConversationMeta(dataDir, pairs, list.map((item) => item.id), { profileDir: account.profileDir });
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
					accountName,
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
				const accountName = url.searchParams.get("account") ?? "";
				const config = configOf();
				const { items, account } = await withAccount(config, accountName, async ({ account, dataDir, pairs }) => {
					const messages = await fetchMessages(dataDir, pairs, conversationId, {
						limit: Number.isFinite(limit) ? limit : 20,
						pages: Number.isFinite(pages) ? pages : 1,
						kind: Number.isFinite(kind) ? kind : 3,
						profileDir: account.profileDir
					});
					return { items: messages, account };
				});
				sendJson(res, 200, {
					ok: true,
					conversationId,
					accountName: account.profile,
					items
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
				const accountName = url.searchParams.get("account") ?? "";
				const config = configOf();
				const { items: messages, account } = await withAccount(config, accountName, async ({ account, dataDir, pairs }) => {
					const messages = await fetchMessages(dataDir, pairs, conversationId, {
						limit: 30,
						pages: Number.isFinite(pages) ? Math.min(Math.max(pages, 1), 10) : 5,
						kind: Number.isFinite(kind) ? kind : 3,
						profileDir: account.profileDir
					});
					return { items: messages, account };
				});
				// 导出的 Markdown 里带上「这是哪个账号的会话」，多账号时归因才不会错
				const markdown = renderMarkdown({
					title: title !== "" ? title : conversationId,
					conversationId,
					account,
					messages
				});
				// 导出落到工作区下的 doubao-exports/，文件名只允许安全字符；
				// 多账号时把账号名编进文件名，避免两个账号同名会话互相覆盖
				const safeAccount = account.profile.replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 30);
				const safeTitle = (title !== "" ? title : conversationId).replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 40);
				const directory = join(options.workspaceDir ?? homedir(), "doubao-exports");
				mkdirSync(directory, { recursive: true });
				const base = safeTitle || conversationId;
				const file = join(directory, accountName === "" || safeAccount === "" ? `${base}-${conversationId}.md` : `${safeAccount}-${base}-${conversationId}.md`);
				writeFileSync(file, markdown, "utf8");
				sendJson(res, 200, {
					ok: true,
					file,
					accountName: account.profile,
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
export function renderMarkdown({ title, conversationId, account, messages }) {
	// 多账号时把「这是谁的会话」写进头部，导出归因才不会错
	const accountName = account?.name ?? "";
	const accountProfile = account?.profile ?? "";
	const accountLine = accountName === ""
		? ""
		: `> 账号：${accountName}${accountProfile === "" || accountProfile === accountName ? "" : `（${accountProfile}）`}\n`;
	const lines = [`# ${title}`, "", `> 会话 ID：${conversationId}`];
	if (accountLine !== "") lines.push(accountLine.trimEnd());
	lines.push(`> 导出时间：${new Date().toISOString()}`, `> 消息数：${messages.length}`, "");
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
	// 崩溃取证兜底：`length` TypeError 被 UI 层 catch 后既不写会话也不写 stderr，
	// 手点 DevTools 也抓不到（主进程 Node + 打包版无 DevTools）。这里装进程级钩子，
	// 只要消息含 `reading 'length'` 就把完整调用栈落盘 —— 兜住宿主/任何模块的崩溃，
	// 不依赖知道崩点在哪。幂等：只装一次。
	if (!process.__doubaoLengthCrashHook) {
		process.__doubaoLengthCrashHook = true;
		process.on("uncaughtException", (error) => {
			try {
				if (!/reading 'length'/.test(String(error?.message ?? ""))) return;
				const dir = join(homedir(), ".dsh", "logs", "doubao-dump");
				mkdirSync(dir, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const file = join(dir, `length-crash-${stamp}.txt`);
				writeFileSync(file, `time: ${new Date().toISOString()}\nmessage: ${error?.message}\n\nSTACK:\n${error?.stack ?? "(no stack)"}\n`);
				process.stderr.write(`[doubao-dump] length crash captured → ${file}\n`);
			} catch {
				/* 取证失败不影响原流程 */
			}
		});
	}
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
