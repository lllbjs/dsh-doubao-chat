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
	const [accounts, setAccounts] = useState([]);
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

	/** 当前选中的账号 profile 名（"" = 让后端走默认账号）。 */
	const [currentAccount, setCurrentAccount] = useState("");

	const loadAccounts = useCallback(async (force) => {
		setAccountError("");
		try {
			const view = await fetchJson(`/plugins/dsh-doubao-chat/accounts${force ? "?refresh=1" : ""}`);
			setAccounts(view.accounts ?? []);
		} catch (error) {
			setAccountError(String(error?.message ?? error));
		}
	}, [fetchJson]);

	const loadAccount = useCallback(async (force, name) => {
		setAccountError("");
		try {
			const q = new URLSearchParams();
			if (force) q.set("refresh", "1");
			if (name) q.set("account", name);
			const suffix = q.toString() === "" ? "" : `?${q.toString()}`;
			setAccount(await fetchJson(`/plugins/dsh-doubao-chat/account${suffix}`));
		} catch (error) {
			setAccountError(String(error?.message ?? error));
		}
	}, [fetchJson]);

	const loadConversations = useCallback(async (force, name) => {
		setListLoading(true);
		setListError("");
		try {
			const q = new URLSearchParams({ limit: "30" });
			if (force) q.set("refresh", "1");
			if (name) q.set("account", name);
			const view = await fetchJson(`/plugins/dsh-doubao-chat/conversations?${q.toString()}`);
			setConversations(view.items ?? []);
		} catch (error) {
			setListError(String(error?.message ?? error));
		} finally {
			setListLoading(false);
		}
	}, [fetchJson]);

	useEffect(() => {
		void loadAccounts(false);
	}, [loadAccounts]);

	// 账号切换：重置选中的会话与正文，再拉新账号的列表
	const switchAccount = useCallback((name) => {
		setCurrentAccount(name);
		setSelected(void 0);
		setMessages([]);
		setExportNote("");
		void loadAccount(false, name);
		void loadConversations(false, name);
	}, [loadAccount, loadConversations]);

	useEffect(() => {
		void loadAccount(false, currentAccount);
		void loadConversations(false, currentAccount);
	}, [loadAccount, loadConversations, currentAccount]);

	const openConversation = useCallback(async (conversation) => {
		setSelected(conversation);
		setMessages([]);
		setMessageError("");
		setExportNote("");
		setMessageLoading(true);
		try {
			const q = new URLSearchParams({
				id: String(conversation.id),
				kind: String(conversation.kind ?? 3),
				limit: "20",
				pages: "2"
			});
			if (currentAccount !== "") q.set("account", currentAccount);
			const view = await fetchJson(`/plugins/dsh-doubao-chat/messages?${q.toString()}`);
			setMessages(view.items ?? []);
		} catch (error) {
			setMessageError(String(error?.message ?? error));
		} finally {
			setMessageLoading(false);
		}
	}, [fetchJson, currentAccount]);

	const exportConversation = useCallback(async () => {
		if (selected === void 0) return;
		setExportNote("导出中…");
		try {
			const q = new URLSearchParams({
				id: String(selected.id),
				kind: String(selected.kind ?? 3),
				title: String(selected.title ?? "")
			});
			if (currentAccount !== "") q.set("account", currentAccount);
			const result = await fetchJson(`/plugins/dsh-doubao-chat/export?${q.toString()}`);
			setExportNote(`已导出 ${result.messages} 条消息 → ${result.file}`);
		} catch (error) {
			setExportNote(`导出失败：${String(error?.message ?? error)}`);
		}
	}, [fetchJson, selected, currentAccount]);

	return h("div", { className: "dsh-doubao-chat" }, [
		h(Head, {
			key: "head",
			account,
			accounts,
			currentAccount,
			onSwitchAccount: switchAccount,
			accountError,
			onRefresh: () => void loadAccount(true, currentAccount)
		}),
		h(Body, {
			key: "body",
			h,
			conversations,
			listError,
			listLoading,
			selected,
			onPick: (conversation) => void openConversation(conversation),
			onRefreshList: () => void loadConversations(true, currentAccount),
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
	const { account, accounts, currentAccount, onSwitchAccount, accountError, onRefresh } = props;
	const React = globalThis.__DSH_REACT__;
	const h = React?.createElement ?? ((tag, attrs, children) => ({ tag, attrs, children }));
	const accountName = account?.account?.name ?? "";
	const accountUserId = String(account?.account?.userId ?? "");
	const verified = account?.verified === true;
	const list = Array.isArray(accounts) ? accounts : [];
	return h("div", { className: "dsh-doubao-chat-head" }, [
		h("strong", { key: "title" }, "豆包会话"),
		// 多账号切换：本机登录过的每个账号一行，当前选中的高亮；凭据不可用的置灰
		list.length > 0 ? h("select", {
			key: "switch",
			value: currentAccount,
			onChange: (event) => onSwitchAccount?.(event.target.value),
			style: { marginLeft: "8px" },
			"aria-label": "切换账号"
		}, [
			// 「默认账号」是后端的回落语义（未指定时用列表第一个），这里把实际是谁回显出来
			h("option", { key: "__default", value: "" }, accountUserId === "" ? "默认账号" : `默认账号 · ${accountName || accountUserId}`),
			...list.map((item) => h("option", {
				key: item.profile,
				value: item.profile,
				disabled: item.available === false
			}, `${item.available === false ? "（不可用）" : ""}${item.name === "" ? item.profile : item.name}`))
		]) : null,
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
