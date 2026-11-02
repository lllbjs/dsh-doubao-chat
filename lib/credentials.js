/**
* 解密入口的转发层。
*
* 上游把这些函数打成压缩包（`doubao-quota-*.js`）并做名字混淆，直接 import
* 会拿到 `z` / `U` 这类单字母导出；这里给它们稳定的名字，上层代码只认这套。
* 上游升级后如果映射变了，只有这一个文件需要改。
*/
// 压缩包的导出全是单字母别名：U = findDoubaoUserDataDir, W = listDoubaoProfiles,
// z = loadDoubaoCredentials。名字见包尾的 export {...} 列表。
import { U as findProfiles, W as listProfilesImpl, z as loadCredentials } from "./upstream/doubao-quota-SO5U9prN.js";

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

/** 解密本机豆包会话；失败不抛，返回 `{ ok:false, reason }`。 */
export function loadDoubaoCredentials(options) {
	return loadCredentials(options);
}
