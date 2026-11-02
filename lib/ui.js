/**
* 设置页挂载。
*
* DSH 的插件设置卡由 Host 渲染，加载器按 `package.json` 的 `dsh.client.inject`
* 把插件前端注入到 Web UI 的 slot 注册表里。这里不自己发明 slot 名，而是**复用
* 上游已经注册的那一段**：上游 `client.js` 里有 `profile` / `quota` 两个分区，
* 追加一个 `chat` 分区既能保证位置稳定，也不会与 Host 的卡片抢挂载点。
*
* 三个前提都不满足时静默跳过（返回 no-op），不影响 route 与 provider：
*   1. 环境里没有 React（非 Web 宿主）；
*   2. Host 没暴露 slot 注册表（`__DSH_UI_SLOTS__`）；
*   3. 上游卡片还没加载（此时先挂「等待」，卡片一出现就补挂）。
*/
import { ChatPanel } from "./panel.js";

const SLOT_ID = "dsh-connect-doubao.profile.section";

/** 等一个全局对象出现，最多等 `timeoutMs` 毫秒（轮询 50ms，不阻塞任何请求）。 */
function waitFor(getter, timeoutMs) {
	return new Promise((resolve) => {
		const started = Date.now();
		const tick = () => {
			const value = getter();
			if (value !== void 0 && value !== null) return resolve(value);
			if (Date.now() - started > timeoutMs) return resolve(void 0);
			setTimeout(tick, 50);
		};
		tick();
	});
}

function slots() {
	return globalThis.__DSH_UI_SLOTS__;
}

/** 把面板挂到上游卡片下面；返回取消函数。 */
export function registerChatUi(ctx, options = {}) {
	const timeoutMs = options.timeoutMs ?? 10_000;
	let cancelled = false;
	let dispose;
	const run = async () => {
		const registry = await waitFor(() => (typeof slots()?.register === "function" ? slots() : void 0), timeoutMs);
		if (cancelled || registry === void 0) return;
		const React = globalThis.React ?? globalThis.__DSH_REACT__;
		if (React === void 0) return;
		try {
			dispose = registry.register(SLOT_ID, (host) => {
				const h = (host?.React ?? React).createElement;
				return h("section", {
					className: "dsh-doubao-chat-section",
					style: { marginTop: "12px" }
				}, h(ChatPanel, {
					React: host?.React ?? React,
					fetchJson: options.fetchJson ?? ((path) => fetch(path).then((r) => r.json()))
				}));
			});
		} catch (error) {
			ctx.logger?.warn?.("dsh-doubao-chat: slot registration failed", error);
		}
	};
	void run();
	return () => {
		cancelled = true;
		dispose?.();
	};
}
