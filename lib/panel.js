/**
* 在 Host 的插件设置卡片里追加「豆包会话」面板。
*
* 上游已经占用了本插件在设置页的那张卡（账号/额度/模型清单）。同一条目再加一张
* 卡会被 Host 的 presentation 抢位置，所以这里走**同一张卡里的追加区块**：
* 拿到自己 `ctx.fiber` 的 presentation 句柄后，注册一个渲染函数，挂在卡片底部。
*
* 降级策略：Host 不认这个挂载点（别的 DSH 版本/别的宿主形态）就什么也不做——
* 面板本身是增强项，路由仍然可以用 curl 或前端脚本调用，不能因为渲染失败
* 把插件的 provider 也带崩。
*/
export function registerChatUi(ctx, options) {
	const mount = options?.mount ?? defaultMountPoint();
	if (mount === void 0) return () => {};

	/*
	 * 面板的数据全部走自己的路由（`/plugins/dsh-doubao-chat/*`），
	 * 渲染层只负责画：这样刷新、重试、导出都不需要 Host 参与。
	 */
	const render = (props) => {
		const host = props;
		const React = host?.React ?? globalThis.__DSH_REACT__;
		if (React === void 0) return null;
		const h = React.createElement;
		return h(ChatPanel, {
			React,
			fetchJson: options.fetchJson ?? defaultFetchJson
		});
	};
	try {
		mount(render);
	} catch (error) {
		ctx.logger?.warn?.("dsh-doubao-chat: panel mount failed", error);
		return () => {};
	}
	return () => {};
}

/** Host 暴露的挂载点：没暴露就返回 undefined，由调用方静默降级。 */
function defaultMountPoint() {
	const registry = globalThis.__DSH_SETTINGS_SLOTS__;
	if (registry === void 0 || typeof registry.register !== "function") return void 0;
	return (render) => registry.register("dsh-doubao-chat", render);
}

async function defaultFetchJson(pathAndQuery) {
	const response = await fetch(pathAndQuery, {
		headers: {
			accept: "application/json"
		}
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`HTTP ${response.status} ${text.slice(0, 120)}`);
	}
	return response.json();
}

/**
* 面板本体。
*
* 状态机很短：账号 → 会话列表 → 选中会话的正文。三个请求互相独立，任一失败
* 只影响自己那一栏（账号挂了还能看本地列表），错误信息原样显示——这类失败
* 的原因（会话过期 / 数据目录不对 / 网关打风控）用户自己就能判断。
*/
export function ChatPanel(props) {
	const { React, fetchJson } = props;
	const { useCallback, useEffect, useState } = React;
	const h = React.createElement;
	const [account, setAccount] = useState(void 0);
	const [accountError, setAccountError] = useState("");
	const [conversations, setConversations] = useState([]);
	const [listError, setListError] = useState("");
	const [listLoading, setListLoading] = useState(false);
	const [selected, setSelected] = useState(void 0);
	const [messages, setMessages] = useState([]);
	const [messageError, setMessageError] = useState("");
	const [messageLoading, setMessageLoading] = useState(false);
	const [exportNote, setExportNote] = useState("");

	const loadAccount = useCallback(async (force) => {
		setAccountError("");
		try {
			setAccount(await fetchJson(`/plugins/dsh-doubao-chat/account${force ? "?refresh=1" : ""}`));
		} catch (error) {
			setAccountError(String(error?.message ?? error));
		}
	}, [fetchJson]);

	const loadConversations = useCallback(async (force) => {
		setListLoading(true);
		setListError("");
		try {
			const view = await fetchJson(`/plugins/dsh-doubao-chat/conversations?limit=30${force ? "&refresh=1" : ""}`);
			setConversations(view.items ?? []);
		} catch (error) {
			setListError(String(error?.message ?? error));
		} finally {
			setListLoading(false);
		}
	}, [fetchJson]);

	useEffect(() => {
		void loadAccount(false);
		void loadConversations(false);
	}, [loadAccount, loadConversations]);

	const openConversation = useCallback(async (conversation) => {
		setSelected(conversation);
		setMessages([]);
		setMessageError("");
		setExportNote("");
		setMessageLoading(true);
		try {
			const view = await fetchJson(`/plugins/dsh-doubao-chat/messages?id=${encodeURIComponent(conversation.id)}&kind=${conversation.kind ?? 3}&limit=20&pages=2`);
			setMessages(view.items ?? []);
		} catch (error) {
			setMessageError(String(error?.message ?? error));
		} finally {
			setMessageLoading(false);
		}
	}, [fetchJson]);

	const exportConversation = useCallback(async () => {
		if (selected === void 0) return;
		setExportNote("导出中…");
		try {
			const result = await fetchJson(`/plugins/dsh-doubao-chat/export?id=${encodeURIComponent(selected.id)}&kind=${selected.kind ?? 3}&title=${encodeURIComponent(selected.title ?? "")}`);
			setExportNote(`已导出 ${result.messages} 条消息 → ${result.file}`);
		} catch (error) {
			setExportNote(`导出失败：${String(error?.message ?? error)}`);
		}
	}, [fetchJson, selected]);

	return h("div", { className: "dsh-doubao-chat" }, [
		h(Head, { key: "head", account, accountError, onRefresh: () => void loadAccount(true) }),
		h(Body, {
			key: "body",
			h,
			conversations,
			listError,
			listLoading,
			selected,
			onPick: (conversation) => void openConversation(conversation),
			onRefreshList: () => void loadConversations(true),
			messages,
			messageError,
			messageLoading,
			exportNote,
			onExport: () => void exportConversation()
		})
	]);
}

/** 时间戳（秒）→ 「3 分钟前」；超过一天给日期。 */
function formatWhen(value) {
	const seconds = Number(value ?? 0);
	if (!Number.isFinite(seconds) || seconds <= 0) return "";
	const ms = seconds * 1000;
	const diff = Date.now() - ms;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return new Date(ms).toLocaleDateString();
}

function Head(props) {
	const { account, accountError, onRefresh } = props;
	const React = globalThis.__DSH_REACT__;
	const h = React?.createElement ?? ((tag, attrs, children) => ({ tag, attrs, children }));
	const accountName = account?.account?.name ?? "";
	const verified = account?.verified === true;
	return h("div", { className: "dsh-doubao-chat-head" }, [
		h("strong", { key: "title" }, "豆包会话"),
		accountName === "" ? null : h("span", { key: "who" }, ` · ${accountName}${verified ? "" : "（服务端未确认）"}`),
		account?.dataDir === void 0 ? null : h("span", { key: "dir", style: { opacity: 0.6 } }, ` · ${account.dataDir}`),
		accountError === "" ? null : h("div", { key: "err", style: { color: "#c00" } }, `账号读取失败：${accountError}`),
		h("button", { key: "refresh", type: "button", onClick: onRefresh }, "刷新")
	]);
}

function Body(props) {
	const { h, conversations, listError, listLoading, selected, onPick, onRefreshList, messages, messageError, messageLoading, exportNote, onExport } = props;
	const left = h("div", { key: "left", className: "dsh-doubao-chat-list" }, [
		h("div", { key: "bar" }, [
			h("span", { key: "count" }, `${conversations.length} 个会话`),
			h("button", { key: "reload", type: "button", onClick: onRefreshList, disabled: listLoading }, listLoading ? "读取中…" : "刷新")
		]),
		listError === "" ? null : h("div", { key: "err", style: { color: "#c00" } }, listError),
		h("ul", { key: "ul" }, conversations.map((conversation) => h("li", {
			key: conversation.id,
			onClick: () => onPick(conversation),
			style: {
				cursor: "pointer",
				padding: "4px 0",
				borderBottom: "1px solid rgba(127,127,127,0.15)",
				fontWeight: selected?.id === conversation.id ? 600 : 400
			}
		}, [
			h("div", { key: "t" }, conversation.title === "" ? conversation.id : conversation.title),
			// 条数 / 相对时间 / 最后一条摘要：列表只显示「标题」时用户没法挑会话
			h("div", { key: "m", style: { opacity: 0.55, fontSize: "0.8em" } }, [
				conversation.messageCount > 0 ? `${conversation.messageCount} 条` : "",
				formatWhen(conversation.lastMessageAt ?? conversation.updatedAt),
				conversation.lastMessage === "" ? "" : ` · ${conversation.lastMessage}`
			].filter(Boolean).join(""))
		])))
	]);
	const right = h("div", { key: "right", className: "dsh-doubao-chat-thread" }, [
		h("div", { key: "bar" }, [
			h("strong", { key: "t" }, selected?.title ?? "选择左侧会话"),
			h("button", { key: "exp", type: "button", onClick: onExport, disabled: selected === void 0 }, "导出 Markdown")
		]),
		exportNote === "" ? null : h("div", { key: "note", style: { opacity: 0.7 } }, exportNote),
		messageError === "" ? null : h("div", { key: "err", style: { color: "#c00" } }, messageError),
		messageLoading ? h("div", { key: "load" }, "读取中…") : null,
		h("ol", { key: "msgs" }, messages.map((message) => h("li", { key: message.id, className: `dsh-doubao-chat-msg ${message.role}` }, [
			h("div", { key: "who", style: { opacity: 0.6, fontSize: "0.85em" } }, `${message.role === "user" ? "用户" : message.role === "assistant" ? "豆包" : "系统"}${message.createTime > 0 ? ` · ${new Date(Number(message.createTime) * 1000).toLocaleString()}` : ""}`),
			h("div", { key: "text", style: { whiteSpace: "pre-wrap" } }, message.text)
		])))
	]);
	return h("div", { className: "dsh-doubao-chat-body", style: { display: "grid", gridTemplateColumns: "minmax(180px, 30%) 1fr", gap: "12px" } }, [left, right]);
}
