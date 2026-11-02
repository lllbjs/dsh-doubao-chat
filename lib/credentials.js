/**
* 解密入口。
*
* 两条路：
*
*   1. `loadDoubaoCredentials()` —— 上游原样转发。注意它**忽略 profileDir**：内部
*      遍历所有 profile、返回第一个解密成功的（并带 10 分钟进程缓存），所以拿它做
*      多账号会一直拿到同一个账号的 Cookie。
*   2. `loadDoubaoCredentialsForProfile(profileDir)` —— 本文件自己按 profile 精确
*      解密。多账号必须走这条：两个 profile 的 Cookie 密文是**不同**的（各自独立
*      登录），只有按 profile 读各自的库、各自解密，才能拿到真正不同的登录态。
*
* macOS 的解密算法与上游 `decryptFromProfileMac` 完全一致（AES-128-CBC + PBKDF2
* + 钥匙串），只是上游没把这条 mac 路径的解密函数导出（导出的 `decryptCookieValue`
* 是 Windows 的 AES-256-GCM），所以这里复刻一份，只用 Node 内置的 crypto / sqlite。
*/
// 上游压缩包的导出全是单字母别名。名字见包尾 export {...} 列表。
import { U as findProfiles, W as listProfilesImpl, z as loadCredentials } from "./upstream/doubao-quota-SO5U9prN.js";

// --- Chromium「Safe Storage」常量（与上游 decryptFromProfileMac 同一套值）---
// PBKDF2 口令派生参数：盐、迭代数、密钥长度 16（AES-128）。
const MAC_SALT = "saltysalt";
const MAC_ITERATIONS = 1003;
const MAC_KEY_LENGTH = 16;
// 固定 IV：16 个空格（Chromium macOS 的 Safe Storage 一直这么用）。
const MAC_IV = Buffer.alloc(16, " ");
// 钥匙串里可能的 service 名。豆包 / 豆包工作版 / 通用 Chromium 各一个。
const MAC_KEYCHAIN_SERVICES = [
	"Doubao Safe Storage",
	"Doubao Browser Safe Storage",
	"DoubaoWork Safe Storage",
	"DoubaoWork Browser Safe Storage",
	"Chromium Safe Storage"
];
// 只关心豆包的会话域；别的域解出来也用不上。
const COOKIE_HOST_SUFFIXES = ["doubao.com", "bytedance.com"];
// 这几条齐全才算「本机登录过」，否则视为未登录。
const REQUIRED_COOKIE_NAMES = [
	"sessionid",
	"sessionid_ss",
	"sid_tt",
	"sid_guard",
	"uid_tt",
	"ttwid",
	"odin_tt",
	"passport_csrf_token",
	"s_v_web_id"
];

/** 所有可用的数据目录（Best first）。 */
export function findDoubaoUserDataDir() {
	try {
		// 上游这个函数返回的是**单个**目录（找第一个可用的），不是列表
		const found = findProfiles({});
		const dir = typeof found === "string" ? found : found?.dir;
		return dir === void 0 || dir === "" ? [] : [dir];
	} catch {
		return [];
	}
}

/** 所有 profile 及其来源（manual / env / appdata / scan）。 */
export function listDoubaoProfiles() {
	try {
		return listProfilesImpl({});
	} catch {
		return [];
	}
}

/** 解密本机豆包会话（上游，忽略 profileDir）；失败不抛，返回 `{ ok:false, reason }`。 */
export function loadDoubaoCredentials(options) {
	return loadCredentials(options);
}

// --- 以下是按 profile 精确解密所需的 macOS 工具函数 ---
// 与上游 `decryptFromProfileMac` 算法一致；上游未导出，这里复刻，只多不多不少。

import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, sep } from "node:path";

/** 从登录钥匙串里取出 Safe Storage 口令（`security find-generic-password`）。 */
function macSafeStoragePasswords(env, dataDir) {
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (pw) => {
		if (typeof pw !== "string") return;
		const trimmed = pw.trim();
		if (trimmed === "" || seen.has(trimmed)) return;
		seen.add(trimmed);
		out.push(trimmed);
	};
	// 环境变量显式给过口令时优先用它（调试 / 测试方便）
	const explicit = env.DSH_DOUBAO_SAFE_STORAGE_PASSWORD;
	if (typeof explicit === "string" && explicit !== "") push(explicit);
	const services = [...MAC_KEYCHAIN_SERVICES];
	// 数据目录名（如 `Doubao`）可能带自己的 service，排在前面优先试
	if (dataDir !== void 0) {
		const bundle = dataDir.split(/[\\/]/).pop() ?? "";
		if (bundle !== "") {
			services.unshift(`${bundle} Browser Safe Storage`);
			services.unshift(`${bundle} Safe Storage`);
		}
	}
	for (const service of services) {
		try {
			const result = spawnSync("security", [
				"find-generic-password",
				"-w",
				"-s",
				service
			], {
				encoding: "utf8",
				timeout: 5000
			});
			if (result.status === 0) push(result.stdout);
		} catch {}
	}
	return out;
}

/** PBKDF2 口令派生（与上游 macDeriveKey 完全一致）。 */
function macDeriveKey(password) {
	return pbkdf2Sync(
		Buffer.from(password, "utf8"),
		Buffer.from(MAC_SALT, "utf8"),
		MAC_ITERATIONS,
		MAC_KEY_LENGTH,
		"sha1"
	);
}

/** 明文里的脏字节数（越少越像真 Cookie 值）。 */
function dirtyByteCount(buf) {
	let n = 0;
	for (const byte of buf) if (byte < 32 || byte > 126) n += 1;
	return n;
}

/** 全是可见 ASCII 才算完全干净。 */
function isPrintableAscii(buf) {
	if (buf.length === 0) return true;
	for (const byte of buf) if (byte < 32 || byte > 126) return false;
	return true;
}

/** 去掉 PKCS7 填充（有的 Chromium 变体会把填充和值一起吐出来）。 */
function stripPkcs7(buf) {
	if (buf.length === 0) return buf;
	const pad = buf[buf.length - 1];
	return pad > 0 && pad <= 16 && pad <= buf.length ? buf.subarray(0, buf.length - pad) : buf;
}

/**
* 解一条 macOS 上的 v10/v11 Cookie，返回已去掉前缀的值。
*
* 豆包 macOS 版解密出来的头 16 字节是**每个应用固定的随机前缀**（不是 host 的
* SHA-256 摘要，也不是可读文本），后面才是真正的 Cookie 值。三种布局都试，取脏字节
* 最少的那一版：固定 IV 从头解 / 老版把前 16 字节当 IV / 明文就是值本身。
*/
function macDecryptCookieValue(key, encryptedValue) {
	if (encryptedValue.length < 3) return "";
	const scheme = encryptedValue.subarray(0, 3).toString("latin1");
	// v20 是 App-Bound 方案，只有豆包 App 进程自己能解，外部读不出来
	if (scheme === "v20") throw new Error("cookie uses the v20 App-Bound scheme, which only the Doubao app process can decrypt");
	// 既不是 v10 也不是 v11，说明这行存的就是明文（少见但存在）
	if (scheme !== "v10" && scheme !== "v11") return encryptedValue.toString("latin1");
	const body = encryptedValue.subarray(3);
	const heads = [];
	// 老版 Chromium：前 16 字节是 IV，真正的 ciphertext 在后面
	if (body.length > 16) heads.push(body.subarray(16));
	// 豆包当前版本：IV 固定为 16 个空格，整个 body 都是 ciphertext
	heads.push(body);
	let best;
	for (const ciphertext of heads) {
		let plain;
		try {
			const decipher = createDecipheriv("aes-128-cbc", key, MAC_IV);
			plain = stripPkcs7(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
		} catch {
			continue;
		}
		if (isPrintableAscii(plain)) return plain.toString("utf8");
		// 去掉开头的 16 字节随机前缀再看
		const candidate = plain.length > 16 ? plain.subarray(16) : plain;
		const score = dirtyByteCount(candidate);
		if (best === void 0 || score < best.score) best = { score, candidate };
		if (score === 0) break;
	}
	if (best === void 0) return "";
	// 仍有脏字节 ⇒ 这一把 Keychain 口令是错的，返回空让调用方换下一把
	return best.score === 0 ? best.candidate.toString("utf8") : "";
}

/**
* 读某个 profile 的 Cookie 库。
*
* 签名要和上游保持一致（profileDir / userDataDir / Cookies 路径三种都能接），所以
* 调用前先 normalize 一次，保证进来的就是「装 Cookies 的那个目录」。
*/
function readCookieRows(profileDir) {
	const requireSqlite = createRequire(import.meta.url);
	const { DatabaseSync } = requireSqlite("node:sqlite");
	const source = profileDir.toLowerCase().endsWith("cookies") ? profileDir : join(profileDir, "Cookies");
	// 先直接只读打开（SQLite 共享锁，客户端在跑时通常也能读）
	for (let attempt = 0; attempt < 4; attempt += 1) try {
		const db = new DatabaseSync(source, { readOnly: true });
		try {
			return selectCookieRows(db);
		} finally {
			db.close();
		}
	} catch {
		// 库被独占锁时 sleepSync 是阻塞的，这里改成短暂同步等待再试
		sleepSync(150);
	}
	// 直接打开不行（文件被独占）就复制一份出来读
	const scratch = mkdtempSync(join(tmpdir(), "dsh-doubao-cookie-mac-"));
	const copy = join(scratch, "Cookies.db");
	try {
		let copied = false;
		let lastError;
		for (let attempt = 0; attempt < 6 && !copied; attempt += 1) try {
			copyFileSync(source, copy);
			copied = true;
		} catch (error) {
			lastError = error;
			sleepSync(120);
		}
		if (!copied) throw new Error("the Doubao client holds its Cookies database with an EXCLUSIVE lock; retry in a moment.", { cause: lastError });
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			return selectCookieRows(db);
		} finally {
			db.close();
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** 选中所有有密文的行。 */
function selectCookieRows(db) {
	return db.prepare("SELECT host_key, name, encrypted_value FROM cookies WHERE encrypted_value IS NOT NULL").all().map((row) => ({
		host: String(row.host_key),
		name: String(row.name),
		encrypted: Buffer.from(row.encrypted_value)
	}));
}

/** 阻塞 `ms` 毫秒（读库的同步路径里没有异步管道可用）。 */
function sleepSync(ms) {
	const view = new Int32Array(new SharedArrayBuffer(4));
	Atomics.wait(view, 0, 0, ms);
}

/** `userDataDir` → 真正装 Cookie 的那个 profile 目录。三种写法都接住。 */
function macProfileDirOf(userDataDir) {
	let dir = userDataDir;
	// 用户可能填 `.../Doubao`、`.../Doubao/Default`，也可能填 `.../Default/Cookies`
	if (/(^|[\\/])Cookies$/.test(dir)) {
		dir = dir.replace(/[\\/][^\\/]*$/, "");
		if (/(^|[\\/])(Default|Profile \d+)$/.test(dir)) dir = dir.replace(/[\\/][^\\/]*$/, "");
	}
	if (dir === "" || !/(^|[\\/])(Default|Profile \d+)$/.test(dir)) {
		// 只给了数据目录根，就找第一个像 profile 的子目录
		const names = readdirSync(dir).filter((name) => name === "Default" || /^Profile \d+$/.test(name));
		if (names.length === 0) return void 0;
		dir = join(dir, names.includes("Default") ? "Default" : names[0]);
	}
	return dir;
}

/**
* 按 profile 精确解密豆包 Cookie（macOS）。
*
* 上游 `loadDoubaoCredentials` 遍历所有 profile 并取第一个成功结果，多账号时
* 两个 profile 的 Cookie 密文不同、但都合法，它永远只返回第一个。这里按
* profileDir 精确读库、精确解密，多账号才能各自拿到自己的登录态。
*
* 返回 `{ ok, pairs, reason }`，与上游 loadDoubaoCredentials 的形状一致。
* 每个 profile 单独缓存（Map key = profileDir），不与上游的进程级单条缓存
* 混淆。TTL 同样 10 分钟（豆包自己会轮换 Cookie，过期就重新解密）。
*/
const profileCredentialCache = /* @__PURE__ */ new Map();
const PROFILE_CRED_TTL_MS = 600_000;

export function loadDoubaoCredentialsForProfile(profileDir, options = {}) {
	const normalized = macProfileDirOf(profileDir);
	if (normalized === void 0) return { ok: false, reason: `cannot find a Doubao profile under ${profileDir}`, pairs: /* @__PURE__ */ new Map() };

	const now = Date.now();
	const cacheKey = normalized;
	const hit = profileCredentialCache.get(cacheKey);
	if (!options.force && hit !== void 0 && now - hit.at < PROFILE_CRED_TTL_MS) return hit.credentials;

	// owner = profile 的数据目录根（`.../Doubao`），用于钥匙串 service 名推断
	const owner = normalized.replace(/[\\/](Default|Profile \d+)$/, "");
	const passwords = macSafeStoragePasswords(process.env, owner);
	if (passwords.length === 0) {
		const result = { ok: false, reason: `Doubao Safe Storage password not found in the login Keychain (tried: ${MAC_KEYCHAIN_SERVICES.join(", ")}). Open the Doubao app once and sign in, then retry.`, pairs: /* @__PURE__ */ new Map() };
		profileCredentialCache.set(cacheKey, { at: now, credentials: result });
		return result;
	}

	let rows;
	try {
		rows = readCookieRows(normalized);
	} catch (error) {
		const result = { ok: false, reason: `cannot read ${join(normalized, "Cookies")}: ${error?.message ?? error}`, pairs: /* @__PURE__ */ new Map() };
		profileCredentialCache.set(cacheKey, { at: now, credentials: result });
		return result;
	}

	let best;
	for (const password of passwords) {
		const key = macDeriveKey(password);
		const pairs = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const host = row.host.toLowerCase();
			if (!COOKIE_HOST_SUFFIXES.some((suffix) => host === `.${suffix}` || host.endsWith(`.${suffix}`))) continue;
			try {
				const value = macDecryptCookieValue(key, row.encrypted).replace(/[^\x20-\x7e]/g, "");
				if (value !== "") pairs.set(row.name, value);
			} catch {}
		}
		const missing = REQUIRED_COOKIE_NAMES.filter((name) => !pairs.get(name));
		const attempt = {
			ok: missing.length === 0,
			reason: missing.length === 0 ? "" : `Doubao session cookies missing (${missing.join(", ")}). Sign in to the Doubao app and retry.`,
			pairs
		};
		if (attempt.ok) {
			profileCredentialCache.set(cacheKey, { at: now, credentials: attempt });
			return attempt;
		}
		if (best === void 0 || attempt.pairs.size > best.pairs.size) best = attempt;
	}

	const result = best ?? { ok: false, reason: `could not decrypt Cookies for profile ${normalized}`, pairs: /* @__PURE__ */ new Map() };
	profileCredentialCache.set(cacheKey, { at: now, credentials: result });
	return result;
}

/** 丢弃按 profile 的解密缓存（测试 / 手动刷新时用）。 */
export function invalidateProfileCredentialCache() {
	profileCredentialCache.clear();
}
