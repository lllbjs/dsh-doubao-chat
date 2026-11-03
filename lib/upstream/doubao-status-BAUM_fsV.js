import { $ as DOUBAO_CONTEXT_WINDOW, B as PROFILE_ENV, C as chat, K as resolveUserProvided, U as findDoubaoUserDataDir, V as describeProfileLocation, _t as enabledModelsOf, a as invalidateQuotaCache, at as DOUBAO_PROVIDER, gt as doubaoCatalogEntries, it as DOUBAO_MODELS, m as DoubaoUpstreamError, n as fetchQuota, nt as DOUBAO_IMAGE_MODEL_NAME, o as millisUntilReset, ot as DOUBAO_PROVIDER_DISPLAY_NAME, r as findWindow, rt as DOUBAO_MAX_TOKENS, tt as DOUBAO_IMAGE_MODEL_ID, vt as findDoubaoModel, w as classifyDoubaoFailure, z as loadDoubaoCredentials } from "./doubao-quota-SO5U9prN.js";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
//#region src/doubao-adapter.ts
/**
* The Doubao pi-ai provider, registered into the Harness LLM seam.
*
* Assembly follows the public `dsh-llm-pi-ai` extension points, as used by
* `dsh-connect-workbuddy`:
*
*   createProvider(...)  ->  a pi-ai Provider whose models all point at the
*                           loopback shim's OpenAI-shaped surface
*   PiAiAdapter          ->  the Harness-facing adapter built from a resolved
*                           provider profile
*
* The shim (not this file) owns the Doubao dialect and all inbound hardening;
* this module only decides what the picker shows and how failures are labelled.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）
*   — pi-ai provider 的装配方式（createProvider + openAICompletionsApi +
*     inert auth plane + 用 shim 的进程内 secret 作为 apiKey）由该项目实现。
*
* @module dsh-connect-doubao/adapter
*/
/** Provider idle ceiling while one stream read is outstanding. */
const DOUBAO_STREAM_IDLE_TIMEOUT_MS = 3e5;
/**
* Inert pi-ai auth plane.
*
* The Doubao route authenticates only through the shim's per-process shared
* secret (resolved as the OpenAI apiKey) plus the cookie jar the shim reads
* from the local profile. pi-ai's own credential lifecycle and ambient
* discovery must never manufacture a credential here.
*/
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-connect-doubao: the doubao route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Image-request budgets: this route is text-only, so the caps are inert. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 0,
	requestImagePixelBudget: 0,
	requestImageMaxBytes: 0
};
/**
* Thinking level map for an entry.
*
* The map is a TRANSLATION, not a passthrough: pi-ai spells levels OpenAI's way
* (`minimal`, `low`, `medium`, `high`) while Doubao publishes only 低 / 中 / 高.
* Doubao's own ids are sent as the values so the shim can hand them straight to
* `streamChat` without a second lookup — see `toDoubaoLevel` in the shim.
*
* Doubao has no "off": the weakest published level is 低, so `off` maps to it
* rather than to nothing. A model that declares no reasoning pins every level,
* so the picker cannot request thinking from a route that will not honour it.
*/
function thinkingLevelMap(info) {
	const levels = [
		"minimal",
		"low",
		"medium",
		"high"
	];
	if (!info.reasoning) return Object.fromEntries([...levels, "off"].map((level) => [level, null]));
	return {
		minimal: "low",
		low: "low",
		medium: "mid",
		high: "high",
		off: "low"
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	const levels = thinkingLevelMap(info);
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		cost: NO_COST,
		contextWindow: DOUBAO_CONTEXT_WINDOW,
		maxTokens: DOUBAO_MAX_TOKENS,
		reasoning: info.reasoning,
		thinkingLevelMap: levels,
		compat: { supportsReasoningEffort: info.reasoning }
	};
}
/**
* Assemble the adapter.
*
* Every model's `baseUrl` is re-resolved per read so the shim's ephemeral port
* applies from the first snapshot after startup.
*/
function createDoubaoAdapter(options) {
	const { shim } = options;
	const providerId = DOUBAO_PROVIDER;
	const providerName = DOUBAO_PROVIDER_DISPLAY_NAME;
	/**
	* Which catalog ids are currently in force, or undefined for "never
	* configured" (serve everything). Updated by {@link setEnabledModelIds} when
	* the user saves a different checklist selection.
	*/
	let enabledIds = options.enabledModelIds;
	let syncBaseUrl = shim.baseUrlSync();
	if (syncBaseUrl === void 0) shim.baseUrl().then((resolved) => {
		syncBaseUrl = resolved;
	}).catch(() => {});
	const buildModels = () => {
		const address = syncBaseUrl;
		if (address === void 0) return [];
		const baseUrl = `${address}/v1`;
		return enabledModelsOf(enabledIds, (options.modelsProvider ?? (() => DOUBAO_MODELS))()).map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: providerName,
			auth: { apiKey: {
				name: "Doubao loopback shim secret",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "Doubao"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName: providerName,
		streamIdleTimeoutMs: DOUBAO_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-doubao retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new PiAiAdapter({
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token()
		}),
		invalidate: () => {
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		},
		setEnabledModelIds: (ids) => {
			enabledIds = ids;
			syncBaseUrl ??= shim.baseUrlSync();
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
//#endregion
//#region src/doubao-session.ts
/**
* Conversation continuity.
*
* WHY. Until now every turn re-flattened the whole transcript into one prompt and
* sent it as a brand-new conversation. That is stateless and honest, but it
* degrades long chats: role prefixes blur into prose, and the server's own
* context handling (memory, attachments, per-conversation state) never applies.
*
* Doubao expects the opposite: the client sends ONE new message plus the
* `conversation_id` it got back on the previous turn. This module decides when a
* request is a continuation of the previous one and what delta to send.
*
* HOW A SESSION IS RECOGNISED. The Harness is stateless — it hands over the full
* transcript every time — so continuity has to be inferred. The rule: two
* requests belong to one conversation when the FIRST message is identical and
* the transcript has GROWN. That is exactly the shape of "the same chat, one
* more turn". A fresh conversation reuses the same opening only if the user
* literally starts a new chat with the same first message, in which case the
* server-side conversation is a harmless extra (and is dropped on TTL).
*
* This is a heuristic, so it is deliberately conservative: any doubt (different
* opening, same length, shorter transcript) starts a NEW conversation, which is
* the behaviour this plugin had before and is never worse than a wrong reuse.
*
* @module dsh-connect-doubao/session
*/
/** A conversation nobody has touched for this long is dropped. */
const SESSION_TTL_MS = 18e5;
/**
* Stable key for a transcript's opening HUMAN turn.
*
* Keyed on the first `user` message rather than `messages[0]`: the Harness
* usually opens with a system prompt that is IDENTICAL across unrelated chats,
* so keying on it would collapse every conversation into one entry — and the
* next turn would be appended to a stranger's thread.
*
* Hashed rather than stored: the key outlives a single request, and user text
* has no business being held there.
*/
function sessionKeyOf(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return void 0;
	const opening = messages.find((message) => message?.role === "user") ?? messages[0];
	const text = typeof opening?.content === "string" ? opening.content : JSON.stringify(opening?.content ?? "");
	if (!text) return void 0;
	return createHash("sha256").update(`${opening?.role ?? "user"}\u0000${text}`).digest("hex").slice(0, 32);
}
/**
* Whether this request continues the remembered conversation.
*
* Requires a stored conversation id AND a strictly longer transcript. Equal
* length is a RE-RUN of the same turn (a retry, or a regeneration), which must
* not be appended to the server-side conversation as if it were new.
*/
function isContinuation(messages, state) {
	if (state === void 0) return false;
	if (!Array.isArray(messages)) return false;
	return messages.length > state.messageCount;
}
/**
* The messages a continuation must actually send.
*
* Everything before `messageCount` is already on the server. Slicing from the
* INTENDED index to the end also covers the case where the Harness resent an
* extra prior message.
*/
function continuationDelta(messages, state) {
	const from = Math.min(Math.max(state.messageCount, 0), messages.length);
	return messages.slice(from);
}
/** Bounded, TTL'd store of conversation ids. */
var ConversationStore = class {
	ttlMs;
	maxEntries;
	entries = /* @__PURE__ */ new Map();
	constructor(ttlMs = SESSION_TTL_MS, maxEntries = 64) {
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}
	get(key, now = Date.now()) {
		if (key === void 0) return void 0;
		const state = this.entries.get(key);
		if (state === void 0) return void 0;
		if (now - state.at > this.ttlMs) {
			this.entries.delete(key);
			return;
		}
		return state;
	}
	remember(key, conversationId, messageCount, now = Date.now()) {
		if (key === void 0 || conversationId === "") return;
		this.entries.set(key, {
			conversationId,
			messageCount,
			at: now
		});
		if (this.entries.size <= this.maxEntries) return;
		for (const oldest of this.entries.keys()) {
			this.entries.delete(oldest);
			if (this.entries.size <= this.maxEntries) break;
		}
	}
	forget(key) {
		if (key !== void 0) this.entries.delete(key);
	}
	get size() {
		return this.entries.size;
	}
};
const FENCE_RE = new RegExp(`^\\s*\`\`\`\\s*doubao-tool\\s*\\r?\\n([\\s\\S]*?)\\r?\\n\\s*\`\`\`\\s*`, "m");
/**
* Render the tool contract appended to the prompt.
*
* MEASURED, and the reason this reads like a rulebook rather than a suggestion
* (2026-11-02, same task, same model, only the wording changed):
*
*   polite wording  → 0/2 tool calls, and the model answered 「已完成修改：…」
*                     while touching nothing. That is the worst outcome
*                     available: the user believes the file changed.
*   hard wording    → 2/2 tool calls (read first, then edit).
*
* So the rules forbid the failure modes explicitly instead of implying them:
* "never claim completion without a [tool result]", "do not paste code for the
* user to apply themselves", and "your first reply must be a call". A simulation
* has no protocol to fall back on — the prompt is the only enforcement there is,
* and a soft prompt measurably produces the hallucination.
*/
function buildToolContract(tools) {
	if (tools.map((tool) => tool.function?.name).filter((name) => typeof name === "string" && name !== "").length === 0) return "";
	return [
		"",
		"",
		"你是执行型助手，只能通过工具改动磁盘。可用工具：",
		...tools.filter((tool) => typeof tool.function?.name === "string").map((tool) => {
			const fn = tool.function;
			const schema = fn?.parameters === void 0 ? "" : ` — 参数: ${JSON.stringify(fn.parameters)}`;
			const desc = fn?.description === void 0 ? "" : ` — ${fn.description}`;
			return `- ${fn?.name}${desc}${schema}`;
		}),
		"",
		"需要调用工具时，只输出一个代码围栏，语言标记为 doubao-tool，围栏内放恰好一个 JSON 对象：{\"name\":\"<工具名>\",\"arguments\":{...}}。",
		"执行结果会以 [tool result] 开头的消息回给你，然后你继续推进。",
		"",
		"硬性规则：",
		"- 你的第一条回复必须是一个工具调用，不能是解释、计划或代码片段。",
		"- 严禁在回复里声称「已完成」「已修改」——除非你真的执行了工具调用并收到 [tool result]。没有结果就等于没做。",
		"- 不要把修改后的代码贴给用户让他自己粘贴；直接调用工具去改。",
		"- 一次只调用一个工具；JSON 必须严格合法（双引号、无注释、无尾逗号）。",
		"- 不要重复刚刚已经做过的调用。",
		"- 每次修改文件之后，先重新读取该文件，再决定下一步；不要凭记忆连续拼接多次改动。",
		"- 全部完成后，用下列格式说明你做了什么（不要只说「已修改」）：",
		"  **改了哪个文件** → 具体改了什么（哪个函数/哪一行），为什么这么改。",
		"  如果有多处改动，逐条列出。"
	].join("\n");
}
/**
* Split a model reply into tool calls and the text the user should see.
*
* The fence is REMOVED from the visible text: a tool call is not prose, and
* leaving it in would show the user JSON they never asked to read.
*
* Malformed JSON inside a fence is dropped rather than thrown — the caller still
* has the remaining text, and a hard failure here would turn a half-good answer
* into an error.
*/
function parseToolCalls(text, makeId = (i) => `call_${Date.now()}_${i}`) {
	const calls = [];
	let rest = text;
	for (;;) {
		const match = FENCE_RE.exec(rest);
		if (match === null) break;
		const raw = (match[1] ?? "").trim();
		rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim();
		const parsed = parseCallJson(raw);
		if (parsed !== void 0) calls.push({
			id: makeId(calls.length),
			...parsed
		});
	}
	return {
		calls: dedupeCalls(calls),
		text: rest
	};
}
/** Parse one fence body into a call, or undefined when it is not usable. */
function parseCallJson(raw) {
	let value;
	try {
		value = JSON.parse(raw);
	} catch {
		return;
	}
	if (value === null || typeof value !== "object") return void 0;
	const record = value;
	const name = record.name ?? record.tool ?? record.function;
	if (typeof name !== "string" || name === "") return void 0;
	const args = record.arguments ?? record.params ?? record.input ?? {};
	const serialized = typeof args === "string" ? args : JSON.stringify(args);
	if (!isLikelyJsonObject(serialized)) return void 0;
	return {
		name,
		arguments: serialized
	};
}
function isLikelyJsonObject(value) {
	const trimmed = value.trim();
	if (trimmed === "") return true;
	return trimmed.startsWith("{") && trimmed.endsWith("}");
}
/**
* Drop calls repeated within the same reply.
*
* The model occasionally emits the same call twice in one turn; executing it
* twice is at best wasteful and at worst destructive (a second write of the
* same file with different content).
*/
function dedupeCalls(calls) {
	const seen = /* @__PURE__ */ new Set();
	const out = [];
	for (const call of calls) {
		const key = `${call.name}\u0000${call.arguments}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(call);
	}
	return out;
}
/**
* Fold a tool result into the flattened prompt.
*
* Doubao's endpoint takes one text block, so the OpenAI `role: "tool"` message
* has to become text. The `[tool result]` prefix is what the contract above
* promises, and it is what the probe measured against.
*/
function toolResultAsText(name, content) {
	const body = typeof content === "string" ? content : JSON.stringify(content ?? "");
	return `[tool result] ${name === void 0 ? "" : `${name}: `}${body}`;
}
//#endregion
//#region src/doubao-shim.ts
/**
* Loopback shim for the Doubao route.
*
* pi-ai's OpenAI-completions API object wants an OpenAI-shaped HTTP endpoint.
* Doubao speaks a private three-line streaming dialect at a different origin,
* with credentials resolved out of a Chromium profile rather than a bearer
* token. This shim is the boundary: it terminates an OpenAI-shaped request on
* an ephemeral 127.0.0.1 port and speaks Doubao upstream.
*
* SECURITY. Everything in the inbound half is upstream-independent hardening
* and is kept deliberately identical to `dsh-connect-workbuddy`'s shim:
*
*   * binds 127.0.0.1 only, on an ephemeral port;
*   * Host header must name loopback (drops DNS-rebinding pages);
*   * a browser-sent Origin must be loopback;
*   * a per-process shared secret, compared in constant time, which pi-ai
*     sends as `Authorization: Bearer`. The secret NEVER leaves this process
*     and is never forwarded upstream — Doubao authenticates on the cookie
*     jar, which the shim resolves per request;
*   * chat POSTs must be `application/json`;
*   * request bodies are size-capped.
*
* Nothing that leaves this process carries the shared secret except the
* loopback hop, and nothing that arrives is trusted without passing all of the
* above.
*
* 参考：corrinehu/dsh-workbuddy-connect（MIT，Copyright (c) 2026 Corrine Hu）；
*   入站加固层的做法（loopback 绑定、Host/Origin 校验、常量时间 bearer 比对、
*   JSON content-type 强制、body 上限）由该项目确立，本文件原样复用其安全策略。
*
* @module dsh-connect-doubao/shim
*/
/** Hostnames the inbound half will accept. */
const LOOPBACK_HOSTS$1 = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Cap on an inbound chat body. Doubao replies are short; anything larger is abuse. */
const MAX_BODY_BYTES = 4194304;
/** Strip a port and IPv6 brackets from a Host/Origin hostname. */
function hostnameOfHost(host) {
	let hostname = host.trim();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The Host header must name loopback. A DNS-rebinding page re-resolves an
* attacker domain to 127.0.0.1 but still sends its own domain in Host, so this
* drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS$1.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin must be loopback. Non-browser clients send no Origin
* at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS$1.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/** Chat-completion POSTs must carry a JSON body type (simple-request CSRF drops here). */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** HTTP status each Doubao failure class surfaces as. */
const KIND_STATUS = {
	rate_limited: 429,
	quota_exhausted: 429,
	session_dead: 401,
	network: 502,
	upstream: 502,
	task_runtime_unavailable: 409
};
function writeJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** OpenAI-shaped error envelope, which is what pi-ai parses. */
function writeOpenAIError(res, status, code, message) {
	writeJson(res, status, { error: {
		message,
		type: code,
		code
	} });
}
/**
* Translate the adapter's thinking-level spelling into a Doubao level id.
*
* pi-ai speaks OpenAI's names — including `medium` and `minimal`, which Doubao
* has no equivalent for. Doubao only publishes 低 / 中 / 高, so the nearest
* Doubao level wins: `minimal` and `low` both mean 低, `medium` means 中.
* An unrecognised or absent value leaves the default in place.
*/
function toDoubaoLevel(spelling) {
	switch (spelling) {
		case "minimal":
		case "low": return "low";
		case "medium": return "mid";
		case "high": return "high";
		default: return;
	}
}
/**
* Name the model a request ASKED for, in words a user can read.
*
* Doubao's `model_item_key` values are opaque (`0`, `3`, `5`, `seed-lite-7b`),
* so the wire key means nothing outside the client. Returning the name — and
* naming the field `requested_model` rather than `model` — keeps the statement
* inside what we actually know: this is what we sent, not what served the
* reply. An id the catalog does not know is echoed verbatim with `unknown`, so
* a typo cannot be mistaken for a valid model.
*/
function describeRequestedModel(key) {
	if (key === void 0) {
		const fallback = findDoubaoModel(void 0);
		return {
			name: fallback.name,
			item_key: fallback.id
		};
	}
	return DOUBAO_MODELS.some((model) => model.id === key) ? {
		name: findDoubaoModel(key).name,
		item_key: key
	} : {
		name: key,
		item_key: key,
		unknown: true
	};
}
/**
* Resolve the per-request upstream knobs from an inbound request.
*
* Without this the shim would silently discard the model the caller picked:
* the inbound `model` is a catalog id that IS Doubao's `model_item_key`, and
* `reasoning_effort` is the adapter's level spelling.
*/
function requestOptions(parsed) {
	const level = toDoubaoLevel(parsed.reasoning_effort);
	if (parsed.model === "image-gen") return {
		modelKey: "0",
		skill: "imageGen",
		...level === void 0 ? {} : { reasoningLevel: level }
	};
	return {
		...parsed.model === void 0 ? {} : { modelKey: parsed.model },
		...level === void 0 ? {} : { reasoningLevel: level }
	};
}
/**
* Render generated images as Markdown so they survive a text-only transport.
*
* The OpenAI surface pi-ai speaks has no image part on the assistant side, so
* the URL in text is what reaches the user — and it is also what makes the
* Harness able to download the file afterwards.
*/
function imageMarkdown(images) {
	if (images.length === 0) return "";
	return images.map((image, i) => `![豆包生图 ${i + 1}](${image.url})`).join("\n\n");
}
/**
* Flatten pi-ai's content shapes (string | block array) into plain text.
*
* Doubao's endpoint takes one `text_block`, so multimodal blocks are not
* forwarded: this provider advertises text-only input and the adapter never
* offers anything else.
*/
function flattenContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (block && typeof block === "object") {
			const record = block;
			if (typeof record.text === "string") parts.push(record.text);
			else if (typeof record.content === "string") parts.push(record.content);
		}
	}
	return parts.join("\n");
}
/**
* Assemble the final prompt from the inbound transcript.
*
* Doubao's endpoint carries one user message; a multi-turn transcript is
* flattened newest-last with role prefixes so the model still sees the
* history. The system prompt is folded in as context rather than dropped.
*
* A `role: "tool"` message becomes a `[tool result] …` line, which is the exact
* shape the tool contract promises — the model is asked to recognise that prefix,
* so the two sides must not drift apart.
*/
function buildPrompt(messages) {
	if (!Array.isArray(messages) || messages.length === 0) return "";
	const turns = [];
	for (const message of messages) {
		const text = flattenContent(message.content);
		if (!text) continue;
		const role = message.role ?? "user";
		if (role === "tool") {
			turns.push(toolResultAsText(message.name, text));
			continue;
		}
		turns.push(role === "user" ? text : `[${role}] ${text}`);
	}
	return turns.join("\n\n");
}
function createDoubaoShim(options = {}) {
	const resolveCredentials = options.resolveCredentials ?? loadDoubaoCredentials;
	/**
	* Doubao conversation ids by transcript opening.
	*
	* The Harness resends the whole transcript every turn, so continuity has to be
	* inferred; see `doubao-session.ts` for the rule and why it is conservative.
	* Kept per shim (i.e. per host process) — a restart simply starts new threads.
	*/
	const sessions = new ConversationStore();
	/** Opt-in prompt-level tool calling; off unless the setting says otherwise. */
	const emulationOn = options.toolEmulation ?? (() => false);
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check; absent or mismatched bearers are rejected. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	/** Read a size-capped request body. Rejects over-limit and wrong content types. */
	function readBody(req) {
		return new Promise((resolve) => {
			const chunks = [];
			let size = 0;
			let aborted = false;
			req.on("data", (chunk) => {
				if (aborted) return;
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					aborted = true;
					resolve(void 0);
					req.destroy();
					return;
				}
				chunks.push(chunk);
			});
			req.on("end", () => {
				if (!aborted) resolve(Buffer.concat(chunks));
			});
			req.on("error", () => {
				if (!aborted) resolve(void 0);
			});
		});
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("listening", () => resolve());
		server.once("error", reject);
	});
	server.listen(0, "127.0.0.1");
	const baseUrl = async () => {
		await ready.catch(() => {});
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("doubao shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	/** Translate one Doubao failure into the OpenAI error envelope pi-ai expects. */
	function writeFailure(res, error) {
		const kind = error instanceof DoubaoUpstreamError ? classifyDoubaoFailure(error) : "network";
		const message = error?.message ?? "Doubao upstream failed";
		const status = KIND_STATUS[kind];
		writeOpenAIError(res, status, kind === "network" ? "TIMEOUT" : kind === "quota_exhausted" ? "RATE_LIMIT" : "SERVER", message);
	}
	/** Stream a completion as OpenAI SSE chunks. */
	/**
	* Stream one completion back as OpenAI-shaped SSE chunks.
	*
	* `parsed` is needed for the model and thinking level: the prompt alone says
	* nothing about which of them the caller picked.
	*
	* `emulate` switches the reply handling: instead of forwarding text deltas as
	* they arrive, the whole turn is collected and the tool fence is parsed out.
	* Streaming a fence cannot work — the call is only knowable once its JSON is
	* complete — and an emulated turn is slow enough (~11.5s measured) that
	* losing incrementality costs nothing a user would notice.
	*/
	async function streamCompletion(res, prompt, parsed, upstreamOptions, remember, forget, emulate) {
		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive"
		});
		const send = (payload) => {
			if (!res.writableEnded) res.write(`data: ${JSON.stringify(payload)}\n\n`);
		};
		let roleSent = false;
		try {
			const result = await chat(prompt, {
				...upstreamOptions,
				callbacks: {
					onThinking: (delta) => {
						if (!roleSent) {
							send({ choices: [{
								index: 0,
								delta: { role: "assistant" },
								finish_reason: null
							}] });
							roleSent = true;
						}
						send({ choices: [{
							index: 0,
							delta: { reasoning_content: delta },
							finish_reason: null
						}] });
					},
					onText: (delta) => {
						if (emulate) return;
						if (!roleSent) {
							send({ choices: [{
								index: 0,
								delta: { role: "assistant" },
								finish_reason: null
							}] });
							roleSent = true;
						}
						send({ choices: [{
							index: 0,
							delta: { content: delta },
							finish_reason: null
						}] });
					}
				}
			});
			remember(result.conversationId);
			if (!roleSent) send({ choices: [{
				index: 0,
				delta: { role: "assistant" },
				finish_reason: null
			}] });
			let finishReason = "stop";
			if (emulate) {
				const { calls, text } = parseToolCalls(result.text);
				send({ choices: [{
					index: 0,
					delta: { content: text.trim() === "" ? " " : text },
					finish_reason: null
				}] });
				calls.forEach((call, index) => {
					send({ choices: [{
						index: 0,
						delta: { tool_calls: [{
							index,
							id: call.id,
							type: "function",
							function: {
								name: call.name,
								arguments: call.arguments
							}
						}] },
						finish_reason: null
					}] });
				});
				if (calls.length > 0) finishReason = "tool_calls";
			}
			const markdown = imageMarkdown(result.images);
			if (markdown !== "") send({ choices: [{
				index: 0,
				delta: { content: `\n\n${markdown}` },
				finish_reason: null
			}] });
			send({ choices: [{
				index: 0,
				delta: {},
				finish_reason: finishReason
			}] });
			if (!res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		} catch (error) {
			if (error instanceof DoubaoUpstreamError && classifyDoubaoFailure(error) === "session_dead") forget();
			// 上游失败要发「pi-ai 能识别」的错误，否则宿主会崩成
			// `Cannot read properties of undefined (reading 'length')`。
			//
			// 旧写法发的是裸 `data:{"error":{...}}` 帧 —— 没有 `choices` 字段。
			// pi-ai 的 openai-completions 解析器只认 `chunk.choices[0].finish_reason`
			// （`openai-completions.js`：`Array.isArray(chunk.choices) ? ... : continue`），
			// 它把这种帧静默 `continue` 跳过，流于是无 finish_reason 地结束、
			// `stopReason` 仍是 `pending` → pi-ai 报 `PI_AI_ERROR`，宿主随后在一条
			// 空 assistant 消息上读 `content.length` 就崩了 —— 真实错误码被掩盖。
			//
			// 正确做法：把真实错误文本作为 `delta.content` 发出（用户能看到豆包返回的
			// `710020202` 等），再发 `finish_reason:"error"` —— `mapStopReason` 的
			// 默认分支会把它转成 `stopReason:"error"`，pi-ai 抛出、宿主正常显示错误。
			send({ choices: [{
				index: 0,
				delta: { content: `豆包上游错误：${error?.message ?? "Doubao upstream failed"}` },
				finish_reason: null
			}] });
			send({ choices: [{
				index: 0,
				delta: {},
				finish_reason: "error"
			}] });
			if (!res.writableEnded) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		}
	}
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && url.startsWith("/quota")) {
				const quota = await fetchQuota();
				const fiveHour = findWindow(quota, "five_hour");
				const weekly = findWindow(quota, "weekly");
				writeJson(res, 200, {
					ok: true,
					plan: quota.plan ?? null,
					exhausted: quota.exhausted,
					windows: {
						fiveHour: fiveHour ? {
							usedPercent: fiveHour.usedPercent,
							remainingPercent: fiveHour.remainingPercent,
							resetsAt: fiveHour.resetsAt,
							resetsInMs: millisUntilReset(fiveHour)
						} : null,
						weekly: weekly ? {
							usedPercent: weekly.usedPercent,
							remainingPercent: weekly.remainingPercent,
							resetsAt: weekly.resetsAt,
							resetsInMs: millisUntilReset(weekly)
						} : null
					},
					error: quota.error ?? null
				});
				return;
			}
			if (!(url.startsWith("/v1/chat/completions") || url === "/v1/chat/completions") || req.method !== "POST") {
				writeOpenAIError(res, 404, "not_found", "unsupported route");
				return;
			}
			if (!isJsonContentType(req)) {
				writeOpenAIError(res, 415, "unsupported_media_type", "chat requests must be application/json");
				return;
			}
			const credentials = resolveCredentials();
			if (!credentials.ok) {
				writeOpenAIError(res, 401, "session_dead", credentials.reason ?? "Doubao is not signed in");
				return;
			}
			const raw = await readBody(req);
			if (raw === void 0) {
				writeOpenAIError(res, 413, "payload_too_large", "request body exceeds the size limit");
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(raw.toString("utf8"));
			} catch {
				writeOpenAIError(res, 400, "invalid_request", "request body is not valid JSON");
				return;
			}
			if ((await fetchQuota()).exhausted) {
				writeOpenAIError(res, 429, "quota_exhausted", "豆包额度已用尽。请等待额度窗口重置，或在豆包客户端中查看额度状态。");
				return;
			}
			const sessionKey = sessionKeyOf(parsed.messages);
			const known = sessions.get(sessionKey);
			const continuing = isContinuation(parsed.messages, known);
			/**
			* What to send.
			*
			* `+1` accounts for the ASSISTANT reply this turn will add to the thread:
			* the server stores both sides, while the inbound transcript we remember
			* ends at the user message. Without it the next turn would resend last
			* turn's answer as if it were new input.
			*/
			const delta = continuing ? continuationDelta(parsed.messages ?? [], known) : [];
			const useDelta = delta.length > 0;
			const isContinuationTurn = continuing && useDelta;
			const outgoing = useDelta ? delta : parsed.messages ?? [];
			const promptBody = buildPrompt(outgoing);
			if (!promptBody) {
				writeOpenAIError(res, 400, "invalid_request", "no usable message content");
				return;
			}
			/**
			* Tool emulation: the declared tools become part of the PROMPT, because
			* Doubao ignores the real `tools` field outright (measured — it answered
			* with its own server-side search skill instead).
			*/
			const emulate = emulationOn() && (parsed.tools?.length ?? 0) > 0;
			const prompt = emulate ? `${promptBody}${buildToolContract(parsed.tools ?? [])}` : promptBody;
			if (process.env.DSH_DOUBAO_DEBUG_PROMPT === "1") process.stderr.write(`[prompt] chars=${prompt.length} tools=${parsed.tools?.length ?? 0} emulate=${emulate}\n${prompt.slice(0, 1200)}\n---\n`);
			const upstreamOptions = {
				...requestOptions(parsed),
				...isContinuationTurn ? {
					conversationId: known.conversationId,
					continueConversation: true
				} : {}
			};
			/** Record the thread id the server handed back, for the next turn. */
			const remember = (conversationId) => {
				if (conversationId !== void 0) sessions.remember(sessionKey, conversationId, (parsed.messages?.length ?? 0) + 1);
			};
			if (process.env.DSH_DOUBAO_DEBUG_PLAN === "1") process.stderr.write(`[plan] continuation=${isContinuationTurn} messages=${parsed.messages?.length ?? 0} sending=${outgoing.length} chars=${prompt.length} conversation=${isContinuationTurn ? known.conversationId : "(new)"}\n`);
			if (parsed.stream === false) {
				const result = await chat(prompt, upstreamOptions);
				remember(result.conversationId);
				const emulated = emulate ? parseToolCalls(result.text) : {
					calls: [],
					text: result.text
				};
				const content = [emulated.text, result.images.length > 0 ? imageMarkdown(result.images) : ""].filter((part) => part !== "").join("\n\n");
				const sent = findDoubaoModel(parsed.model);
				writeJson(res, 200, {
					id: `doubao-${Date.now()}`,
					object: "chat.completion",
					created: Math.floor(Date.now() / 1e3),
					model: sent.id,
					requested_model: describeRequestedModel(parsed.model),
					choices: [{
						index: 0,
						message: {
							role: "assistant",
							content: content === "" ? " " : content,
							...emulated.calls.length > 0 ? { tool_calls: emulated.calls.map((call) => ({
								id: call.id,
								type: "function",
								function: {
									name: call.name,
									arguments: call.arguments
								}
							})) } : {}
						},
						finish_reason: emulated.calls.length > 0 ? "tool_calls" : "stop"
					}]
				});
				return;
			}
			await streamCompletion(res, prompt, parsed, upstreamOptions, remember, () => sessions.forget(sessionKey), emulate);
		} catch (error) {
			writeFailure(res, error);
		}
	}
	/** Synchronous view of the origin; undefined until the socket is bound. */
	const baseUrlSync = () => {
		const address = server.address();
		if (address === null || typeof address === "string") return void 0;
		return `http://127.0.0.1:${address.port}`;
	};
	return {
		baseUrl,
		baseUrlSync,
		token: () => SHARED_SECRET,
		async close() {
			await ready.catch(() => {});
			await new Promise((resolve) => server.close(() => resolve()));
		}
	};
}
//#endregion
//#region src/doubao-discovery.ts
/**
* Discover the model list from the Doubao client's own cache.
*
* WHY THIS EXISTS. The catalog used to be a hardcoded list, so every time
* Doubao shipped a model the plugin went stale until it was updated by hand.
* The desktop app already receives that list from the server and persists it in
* its IndexedDB (`menuConfV2`), so the honest source of truth is right there on
* disk — read it instead of guessing.
*
* WHAT THE CACHE ACTUALLY CONTAINS. Values are V8 structured clones, not JSON:
*
*   string = tag + LEB128 length + payload
*     0x22  Latin-1 payload, length is the byte count
*     0x63  UTF-16LE payload, length is the BYTE count (measured: treating it as
*           a character count reads exactly twice too far and the name swallows
*           the following field's bytes)
*
* So parsing means reading the varint and slicing — skipping "control bytes and
* hoping" produces zero hits, which is what the first two attempts did.
*
* VALIDATION. A discovered entry is only trusted when it looks like a model:
* a short key matching `[\w-]+` and a name containing CJK or letters. Anything
* else is dropped, and if nothing survives, {@link discoverModels} returns
* undefined so the caller falls back to the static catalog. A malformed cache
* must never empty the user's model picker.
*
* @module dsh-connect-doubao/discovery
*/
/** How long a discovery result is reused before re-reading the cache. */
const DISCOVERY_TTL_MS = 6e5;
/**
* Names produced by the client for models that only exist inside 「工作任务」.
*
* The app prefixes them itself (「工作任务 Pro」, 「工作任务 Auto」), which is a
* gift: the mode a model belongs to is legible straight out of the cache, so
* the plugin can hide exactly the entries that would fail with 710010702.
*/
const TASK_MODE_PREFIX = "工作任务";
/** IndexedDB store that holds the app's server-pushed config. */
const CACHE_DB_DIRS = ["chrome_doubao-launcher_0.indexeddb.leveldb"];
/** Read a LEB128 varint. Returns [value, nextOffset] or undefined. */
function readVarint(buf, at) {
	let result = 0;
	let pos = at;
	let bytes = 0;
	for (;;) {
		if (pos >= buf.length) return void 0;
		const byte = buf[pos];
		if (byte === void 0) return void 0;
		result |= (byte & 127) << 7 * bytes;
		pos += 1;
		bytes += 1;
		if ((byte & 128) === 0) break;
		if (bytes > 4) return void 0;
	}
	return [result >>> 0, pos];
}
/** Read a structured-clone string at `at`. Returns [value, nextOffset]. */
function readV8String(buf, at) {
	const tag = buf[at];
	const sized = readVarint(buf, at + 1);
	if (sized === void 0) return void 0;
	const [length, dataAt] = sized;
	const end = dataAt + length;
	if (length <= 0 || end > buf.length) return void 0;
	if (tag === 34) return [buf.subarray(dataAt, end).toString("latin1"), end];
	if (tag === 99) return [buf.subarray(dataAt, end).toString("utf16le"), end];
}
/** Find the `name` property following `from` and decode its value. */
function readNameAfter(buf, from, to) {
	for (let i = from; i < to - 6; i++) {
		if (buf[i] !== 34) continue;
		const sized = readVarint(buf, i + 1);
		if (sized === void 0) continue;
		const [length, dataAt] = sized;
		if (length !== 4 || dataAt + 4 > buf.length) continue;
		if (buf.subarray(dataAt, dataAt + 4).toString("latin1") !== "name") continue;
		const value = readV8String(buf, dataAt + 4);
		if (value === void 0) return void 0;
		const [name, next] = value;
		if (next > to) return void 0;
		return name;
	}
}
function looksLikeModelKey(value) {
	return /^[\w-]{1,24}$/.test(value);
}
function looksLikeModelName(value) {
	if (value.length < 2 || value.length > 40) return false;
	if (!/[\u4e00-\u9fa5A-Za-z]/.test(value)) return false;
	return !/^[a-z_]+$/.test(value) && !value.includes("http");
}
/**
* Parse one LevelDB value buffer for (key, name) pairs.
*
* Exported so the encoding can be unit-tested with synthetic bytes: the real
* cache belongs to another app and moves whenever it updates, and a parser that
* can only be exercised against it cannot be trusted to keep working.
*/
function parseCacheBuffer(buf) {
	const out = /* @__PURE__ */ new Map();
	const KEY = Buffer.from("model_item_key");
	let at = -1;
	while ((at = buf.indexOf(KEY, at + 1)) !== -1) {
		const keyRead = readV8String(buf, at + KEY.length);
		if (keyRead === void 0) continue;
		const [key, afterKey] = keyRead;
		if (!looksLikeModelKey(key)) continue;
		const name = readNameAfter(buf, afterKey, Math.min(buf.length, afterKey + 220));
		if (name === void 0 || !looksLikeModelName(name)) continue;
		if (!out.has(key)) out.set(key, {
			key,
			name,
			taskOnly: name.startsWith(TASK_MODE_PREFIX)
		});
	}
	return [...out.values()];
}
/** Scan one LevelDB directory for (key, name) pairs. */
function scanDir(dir) {
	const found = /* @__PURE__ */ new Map();
	let files;
	try {
		files = readdirSync(dir);
	} catch {
		return found;
	}
	for (const file of files) {
		if (!/\.(log|ldb)$/.test(file)) continue;
		let buf;
		try {
			buf = readFileSync(join(dir, file));
		} catch {
			continue;
		}
		for (const entry of parseCacheBuffer(buf)) if (!found.has(entry.key)) found.set(entry.key, entry);
	}
	return found;
}
/** Locate the launcher cache directory inside the Doubao profile. */
function discoveryCacheDirs() {
	const userData = findDoubaoUserDataDir();
	if (userData === void 0) return [];
	return CACHE_DB_DIRS.map((dir) => join(userData, "Default", "IndexedDB", dir)).filter((dir) => existsSync(dir));
}
/**
* All (key, name) pairs the client currently knows, task-only ones included.
*
* Exported for the diagnostics path — it is the raw view, useful when a model
* shows up in the app but not in DSH and the question is "did we not see it, or
* did we see it and classify it away".
*/
function discoverAllCachedModels() {
	const merged = /* @__PURE__ */ new Map();
	for (const dir of discoveryCacheDirs()) for (const [key, entry] of scanDir(dir)) if (!merged.has(key)) merged.set(key, entry);
	return [...merged.values()];
}
/**
* The models DSH may offer: everything the client lists that is NOT task-only,
* plus the image-generation alias.
*
* Returns undefined when the cache yielded nothing usable, so the caller keeps
* the static catalog. Names are taken verbatim from the client, which is the
* whole point: when Doubao renames or adds a chat model, it shows up here
* without a plugin release.
*/
function discoverModels(now = Date.now()) {
	const usable = discoverAllCachedModels().filter((entry) => !entry.taskOnly && entry.key !== "image-gen");
	if (usable.length === 0) return void 0;
	const models = usable.sort((a, b) => {
		const an = Number(a.key), bn = Number(b.key);
		const aNum = Number.isFinite(an), bNum = Number.isFinite(bn);
		if (aNum && bNum) return an - bn;
		if (aNum) return -1;
		if (bNum) return 1;
		return a.key.localeCompare(b.key);
	}).map((entry) => ({
		id: entry.key,
		name: entry.name,
		reasoning: true
	}));
	models.push({
		id: DOUBAO_IMAGE_MODEL_ID,
		name: DOUBAO_IMAGE_MODEL_NAME,
		reasoning: true
	});
	return models;
}
/** Fallback used whenever discovery is unavailable. */
function staticModels() {
	return [...DOUBAO_MODELS];
}
let memo;
/**
* The catalog to use right now: discovered models when the cache yields them,
* otherwise the static list, re-read at most once per {@link DISCOVERY_TTL_MS}.
*
* Every consumer (picker, adapter, card) goes through this one function so the
* three views can never disagree about which models exist.
*/
function liveModels(now = Date.now()) {
	if (memo !== void 0 && now - memo.at < 6e5) return memo.models;
	const models = discoverModels(now) ?? staticModels();
	memo = {
		at: now,
		models
	};
	return models;
}
/** Forget the memo — used by the card's refresh and by tests. */
function invalidateDiscovery() {
	memo = void 0;
}
//#endregion
//#region src/doubao-status.ts
/** Route path, relative to the plugin mount point. */
const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
/** Route serving the model checklist's catalog. */
const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
/** Hostnames an inbound browser request may come from. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/**
* A browser-sent Origin must be loopback. A page on an attacker origin that
* can reach the Harness server must not be able to read the user's quota.
*/
function loopbackOrigin(req) {
	const origin = req.headers.origin;
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
function json(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		"cache-control": "no-store"
	});
	res.end(body);
}
/**
* Strip anything that could carry a secret or personal data out of an error.
* Upstream messages are quoted into the payload, so they are truncated and
* only the class is preserved.
*/
function safeMessage(error) {
	return (error?.message ?? "unknown error").slice(0, 200);
}
/**
* Build the quota view.
*
* An allow-list on purpose: every field here is a number or a plan name chosen
* by this function, never a passthrough of the upstream payload.
*/
async function doubaoQuotaView(options = {}) {
	const quota = await fetchQuota(options.force === true ? { force: true } : {});
	const fiveHour = findWindow(quota, "five_hour");
	const weekly = findWindow(quota, "weekly");
	return {
		ok: quota.error === void 0,
		profile: describeProfileLocation(),
		plan: quota.plan ?? null,
		exhausted: quota.exhausted,
		windows: {
			fiveHour: fiveHour === void 0 ? null : {
				usedPercent: fiveHour.usedPercent,
				remainingPercent: fiveHour.remainingPercent,
				resetsAt: fiveHour.resetsAt,
				resetsInMs: millisUntilReset(fiveHour)
			},
			weekly: weekly === void 0 ? null : {
				usedPercent: weekly.usedPercent,
				remainingPercent: weekly.remainingPercent,
				resetsAt: weekly.resetsAt,
				resetsInMs: millisUntilReset(weekly)
			}
		},
		fetchedAt: quota.fetchedAt,
		error: quota.error ?? null
	};
}
/** Route the card writes settings through. */
const DOUBAO_SAVE_PATH = "/plugins/dsh-connect-doubao/__save";
/** Route the card asks for the detected profile candidates. */
const DOUBAO_PROFILE_PATH = "/plugins/dsh-connect-doubao/profile";
/**
* The ONLY fields this route will write.
*
* A closed allow-list, not a schema derivation: deriving it would let a future
* schema addition quietly widen what the browser can write. Both entries are
* switches the user could already set by hand in `cordis.patch.yml`.
*/
const WRITABLE_FIELDS = /* @__PURE__ */ new Set([
	"enabledModelIds",
	"toolEmulation",
	"profileDir"
]);
/** Read and parse a JSON request body, bounded. */
async function readJsonBody(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > 65536) throw new Error("body too large");
		chunks.push(buffer);
	}
	if (chunks.length === 0) return void 0;
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
/**
* Register the settings READ/WRITE route.
*
* Why this exists at all: neither `settingsScope.set()` in the card nor
* `settings.mutate` in the host can persist this plugin — its fiber never
* reaches ACTIVE (see {@link SettingsLike}), so the host reports
* `No configurable plugin entry "dsh-connect-doubao"` and drops the write.
* This route writes a JSON file the plugin owns instead, which is also the
* only copy the card can read back.
*
* Security posture matches the read routes: loopback Origin only, GET or POST
* only, a closed allow-list of two switches, no credential in the response.
*/
function registerDoubaoSaveRoute(ctx, deps) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_SAVE_PATH,
		handler: async (req, res) => {
			if (req.method !== "POST" && req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			if (req.method === "GET") {
				try {
					json(res, 200, {
						ok: true,
						value: deps.read()
					});
				} catch (error) {
					json(res, 500, {
						ok: false,
						error: safeMessage(error)
					});
				}
				return;
			}
			try {
				const body = await readJsonBody(req);
				const field = body?.field;
				if (typeof field !== "string" || !WRITABLE_FIELDS.has(field)) {
					json(res, 400, { error: `field must be one of: ${[...WRITABLE_FIELDS].join(", ")}` });
					return;
				}
				const value = body?.value;
				if (!(field === "enabledModelIds" ? Array.isArray(value) && value.every((entry) => typeof entry === "string") : field === "profileDir" ? typeof value === "string" : typeof value === "boolean")) {
					json(res, 400, { error: `invalid value for ${field}` });
					return;
				}
				if (field === "profileDir" && typeof value === "string" && value !== "" && resolveUserProvided(value) === void 0) {
					json(res, 400, { error: `no Doubao profile at ${String(value)} (expected a folder containing Default\Network\Cookies)` });
					return;
				}
				deps.write(field, value);
				deps.onApplied?.(field, value);
				json(res, 200, {
					ok: true,
					value: deps.read(),
					...deps.diagnostics === void 0 ? {} : { diagnostics: deps.diagnostics() }
				});
			} catch (error) {
				json(res, 500, {
					ok: false,
					errorName: error?.name ?? "unknown",
					error: safeMessage(error)
				});
			}
		}
	});
}
/**
* Register the profile-discovery route.
*
* The card needs two things the settings file cannot give it: what the plugin
* DETECTED (so the user can see whether automatic discovery already worked),
* and why a manual path was rejected. Both are read-only and contain paths
* only — never a cookie.
*/
function registerDoubaoProfileRoute(ctx, deps) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_PROFILE_PATH,
		handler: (req, res) => {
			if (req.method !== "GET") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			try {
				const candidates = deps.candidates();
				json(res, 200, {
					ok: true,
					detected: candidates[0]?.dir ?? null,
					candidates,
					env: PROFILE_ENV
				});
			} catch (error) {
				json(res, 500, {
					ok: false,
					error: safeMessage(error)
				});
			}
		}
	});
}
/** Register the quota route. Returns a disposer. */
function registerDoubaoQuotaRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_QUOTA_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			const force = req.method === "POST";
			if (force) {
				invalidateQuotaCache();
				deps.onRefresh?.();
			}
			try {
				json(res, 200, await doubaoQuotaView(force ? { force: true } : {}));
			} catch (error) {
				json(res, 500, { error: safeMessage(error) });
			}
		}
	});
}
/**
* Register the read-only catalog route backing the card's model checklist.
*
* Same security posture as the quota route: an allow-list (the static catalog),
* the same loopback-origin fence, no credential of any kind.
*
* `refresh=true` re-reads nothing on purpose — the Doubao catalog is STATIC and
* cannot be asked upstream which models exist (see `doubao-catalog.ts`). The
* card's Refresh button therefore re-reads this route, which is the honest
* behaviour: it refreshes the VIEW, and the card's note tells the user that
* selection controls picker entries rather than routing.
*/
function registerDoubaoCatalogRoute(ctx, deps = {}) {
	return ctx.webServer.register({
		kind: "exact",
		path: DOUBAO_CATALOG_PATH,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "POST") {
				json(res, 405, { error: "method not allowed" });
				return;
			}
			if (!loopbackOrigin(req)) {
				json(res, 403, { error: "origin-not-trusted" });
				return;
			}
			if (req.method === "POST") invalidateDiscovery();
			const models = deps.modelsProvider === void 0 ? void 0 : deps.modelsProvider();
			json(res, 200, {
				ok: true,
				models: doubaoCatalogEntries(models),
				error: null
			});
		}
	});
}
//#endregion
export { registerDoubaoCatalogRoute as a, registerDoubaoSaveRoute as c, discoverModels as d, invalidateDiscovery as f, createDoubaoAdapter as g, DOUBAO_STREAM_IDLE_TIMEOUT_MS as h, doubaoQuotaView as i, DISCOVERY_TTL_MS as l, createDoubaoShim as m, DOUBAO_QUOTA_PATH as n, registerDoubaoProfileRoute as o, liveModels as p, DOUBAO_SAVE_PATH as r, registerDoubaoQuotaRoute as s, DOUBAO_CATALOG_PATH as t, discoverAllCachedModels as u };
