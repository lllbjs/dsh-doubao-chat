/**
 * 真机冒烟：账号 → 会话列表 → 消息 → 导出。
 *
 * 直接调用 lib 里的实现，不经过 HTTP，用来在改完采集逻辑后快速确认
 * 「本机豆包还能不能读」。失败会以非 0 退出码结束，便于放进 CI 或提交前钩子。
 *
 *   node scripts/smoke.mjs [dataDir]
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const lib = join(here, "..", "lib");

const { findDoubaoUserDataDir, loadDoubaoCredentials } = await import(join(lib, "credentials.js"));
const { fetchConversationMeta, fetchConversations, fetchMessages, readAccountIdentity } = await import(join(lib, "collect.js"));

function step(name) {
	process.stdout.write(`- ${name} … `);
}

function pass(note = "") {
	process.stdout.write(`ok${note === "" ? "" : ` (${note})`}\n`);
}

function fail(reason) {
	process.stdout.write(`FAIL\n  ${reason}\n`);
	process.exitCode = 1;
}

const dataDir = process.argv[2] ?? findDoubaoUserDataDir()[0];
if (dataDir === void 0) {
	console.error("未找到豆包数据目录；显式传一个：node scripts/smoke.mjs <dataDir>");
	process.exit(1);
}
console.log(`dataDir: ${dataDir}`);

step("解密登录态");
const credentials = loadDoubaoCredentials({ force: true });
if (!credentials.ok) {
	fail(credentials.reason);
	process.exit(1);
}
pass(`${credentials.pairs.size} 条 Cookie`);

step("本地账号");
const identity = readAccountIdentity(dataDir);
if (identity.userId === "") fail("Preferences 里没有 saman.last_user");
else pass(identity.name === "" ? identity.userId : `${identity.name} / ${identity.userId}`);

step("会话列表");
const conversations = await fetchConversations(dataDir, credentials.pairs, { limit: 10 });
if (conversations.length === 0) fail("没有会话（或 IM 拒绝了请求）");
else pass(`${conversations.length} 个`);

step("会话元信息");
let meta = /* @__PURE__ */ new Map();
try {
	meta = await fetchConversationMeta(dataDir, credentials.pairs, conversations.slice(0, 5).map((item) => item.id));
	pass(`${meta.size} 个`);
} catch (error) {
	// 元信息只是增强项，失败不影响结论
	pass(`跳过：${String(error?.message ?? error).slice(0, 60)}`);
}

if (conversations[0] !== undefined) {
	const first = conversations[0];
	step("消息正文");
	try {
		const messages = await fetchMessages(dataDir, credentials.pairs, first.id, {
			kind: first.kind,
			limit: 20,
			pages: 1
		});
		if (messages.length === 0) fail("会话里读不到消息");
		else pass(`${messages.length} 条，角色 ${[...new Set(messages.map((m) => m.role))].join("/")}`);
	} catch (error) {
		fail(String(error?.message ?? error));
	}
}

// 导出到临时目录，验证渲染函数能跑通后立即删掉
const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-smoke-"));
try {
	step("导出 Markdown");
	const { renderMarkdown } = await import(join(lib, "chat-plugin.js")).then((module) => ({
		renderMarkdown: module.renderMarkdown ?? module.default?.renderMarkdown
	}));
	if (typeof renderMarkdown !== "function") {
		pass("跳过：renderMarkdown 未导出");
	} else {
		const sample = conversations[0];
		const messages = await fetchMessages(dataDir, credentials.pairs, sample.id, {
			kind: sample.kind,
			limit: 20,
			pages: 1
		});
		const markdown = renderMarkdown({
			title: sample.title,
			conversationId: sample.id,
			messages
		});
		if (!markdown.startsWith("# ")) fail("Markdown 头不对");
		else pass(`${markdown.split("\n").length} 行`);
	}
} finally {
	rmSync(scratch, {
		recursive: true,
		force: true
	});
}

process.exit(process.exitCode ?? 0);
