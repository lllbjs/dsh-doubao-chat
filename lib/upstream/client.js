window.__ModuleLoader__.load({
	id: "dsh-connect-doubao",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/contract.ts
		/**
		* Shared contract between the host routes and the browser card.
		*
		* The types here are a MIRROR of what `src/doubao-status.ts` actually sends.
		* They are duplicated rather than imported so the browser bundle never pulls in
		* a Node module (`node:http`, the cookie jar) — importing the real route file
		* from client code would drag DPAPI and the filesystem into the renderer.
		*
		* SECURITY: this is a NUMBER view. No cookie, no token, no account id, no email
		* or phone ever crosses this boundary, and the card renders nothing else.
		*
		* @module dsh-connect-doubao/client-contract
		*/
		/** Route the card reads, relative to the Harness web server origin. */
		const DOUBAO_QUOTA_PATH = "/plugins/dsh-connect-doubao/quota";
		/**
		* Classify the payload into one account state.
		*
		* Classification is done from the HOST's error text plus the view's own shape,
		* because the host is the only side that can see the upstream error class. The
		* text is matched loosely on purpose: the host owns the wording, this side owns
		* the presentation, and a wording change must degrade to `network` rather than
		* crash the card.
		*/
		function classifyQuotaView(view) {
			if (view === void 0) return "unreadable";
			if (view.ok) return view.exhausted ? "exhausted" : "ok";
			const text = (view.error ?? "").toLowerCase();
			if (/credential|password data|dpapi|decrypt|profile|encrypted_key|local state/i.test(text)) return "unreadable";
			if (/session cookie|sign in|login|710012001|session_dead/i.test(text)) return "signed_out";
			if (/710022004|risk|slider|captcha|rate.?limit/i.test(text)) return "risk_challenge";
			return "network";
		}
		/** Milliseconds → a compact 「3 小时 12 分」 style countdown. */
		function formatCountdown(ms) {
			if (!Number.isFinite(ms) || ms <= 0) return "—";
			const totalMinutes = Math.floor(ms / 6e4);
			const days = Math.floor(totalMinutes / 1440);
			const hours = Math.floor(totalMinutes % 1440 / 60);
			const minutes = totalMinutes % 60;
			if (days > 0) return `${days}d ${hours}h`;
			if (hours > 0) return `${hours}h ${minutes}m`;
			if (minutes > 0) return `${minutes}m`;
			return "<1m";
		}
		/** Host-side route serving the catalog for the checklist. */
		const DOUBAO_CATALOG_PATH = "/plugins/dsh-connect-doubao/catalog";
		/**
		* The Host-side settings WRITE route.
		*
		* The card cannot persist through its injected `settingsScope`: on this host
		* line `set()` resolves successfully and stores nothing (see
		* `DoubaoQuotaCard.persistField`). This endpoint does the write in the Host
		* process with `settings.mutate` — the path `dsh-connect-workbuddy` and
		* `dsh-connect-trae` also use.
		*/
		const DOUBAO_SAVE_PATH = "/plugins/dsh-connect-doubao/__save";
		/** Settings field holding the ticked entry ids. */
		const DOUBAO_ENABLED_MODELS_FIELD = "enabledModelIds";
		/**
		* Read the ticked ids out of a settings snapshot.
		*
		* A snapshot that has never been saved carries `undefined`, which means "never
		* configured" — NOT "nothing ticked". The caller seeds the draft from the
		* catalog in that case so a first-time user sees a usable, fully-ticked list
		* rather than an empty one they might mistake for a bug.
		*/
		function enabledModelIdsOf(configured) {
			const value = configured?.enabledModelIds;
			if (!Array.isArray(value)) return void 0;
			return value.filter((entry) => typeof entry === "string");
		}
		/** Settings field holding the manually chosen profile directory. */
		const DOUBAO_PROFILE_DIR_FIELD = "profileDir";
		/** Route that reports which profiles the host detected. */
		const DOUBAO_PROFILE_PATH = "/plugins/dsh-connect-doubao/profile";
		/** Read the chosen profile directory out of a settings snapshot. */
		function profileDirOf(configured) {
			const value = configured?.profileDir;
			return typeof value === "string" ? value : "";
		}
		/**
		* Read the tool-emulation switch out of a settings snapshot.
		*
		* `undefined` (never saved) means OFF — the emulation is opt-in, so an
		* unconfigured install must not silently start letting the model touch files.
		*/
		function toolEmulationOf(configured) {
			return configured?.toolEmulation === true;
		}
		/** Clamp a percentage into the 0-100 range the bars render. */
		function clampPercent(value) {
			if (typeof value !== "number" || !Number.isFinite(value)) return 0;
			return Math.min(100, Math.max(0, value));
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Card styling, delivered as one scoped stylesheet string.
		*
		* A string (not a CSS import) because the browser bundle is injected into the
		* host page at runtime: a `import './x.css'` would need a bundler plugin the
		* client build deliberately does not use, and a `<style>` element inserted on
		* mount keeps the card self-contained.
		*
		* Every selector is namespaced under `dbq-` so nothing here can reach a host
		* element, and every rule uses explicit colours rather than host tokens — a
		* card that inherited the host's theme variables would render unreadable the
		* moment the host renames one.
		*
		* Colours are checked for contrast against their own background (all text
		* pairs are >= 4.5:1, the WCAG AA threshold for body text).
		*
		* @module dsh-connect-doubao/client-styles
		*/
		const DOUBAO_CARD_CSS = `
.dbq-card { display: flex; flex-direction: column; gap: 14px; padding: 14px;
  border: 1px solid #2b2f36; border-radius: 10px; background: #16181d; color: #e8eaed;
  font-size: 13px; line-height: 1.5; }
.dbq-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.dbq-title { font-weight: 600; font-size: 14px; }
.dbq-sub { color: #9aa0a6; font-size: 12px; }

.dbq-section { display: flex; flex-direction: column; gap: 8px; }
.dbq-section-title { font-weight: 600; font-size: 13px; display: flex;
  align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-count { color: #9aa0a6; font-size: 12px; font-weight: 400; }
.dbq-note { color: #9aa0a6; font-size: 12px; }

.dbq-row { display: flex; flex-direction: column; gap: 4px; }
.dbq-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.dbq-label { font-weight: 500; }
.dbq-meta { color: #9aa0a6; font-size: 12px; white-space: nowrap; }
/* Candidate list: one path per line, and a long path must wrap instead of
   pushing the card wider than the settings panel. */
.dbq-candidates { color: #9aa0a6; font-size: 12px; white-space: pre-wrap; word-break: break-all; }

.dbq-bar { height: 8px; border-radius: 999px; background: #2b2f36; overflow: hidden; }
.dbq-fill { height: 100%; border-radius: 999px; background: #4a9eff; transition: width .25s ease; }
.dbq-fill.dbq-warn { background: #f5a623; }
.dbq-fill.dbq-full { background: #e5534b; }

.dbq-state { display: flex; align-items: flex-start; gap: 6px; }
.dbq-dot { width: 8px; height: 8px; border-radius: 999px; margin-top: 5px; flex: none; background: #4a9eff; }
.dbq-dot.dbq-warn { background: #f5a623; }
.dbq-dot.dbq-bad { background: #e5534b; }
.dbq-state-text { color: #e8eaed; }
.dbq-profile { color: #9aa0a6; font-size: 11px; word-break: break-all; }

.dbq-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.dbq-btn { appearance: none; border: 1px solid #3a3f47; background: #22252b; color: #e8eaed;
  border-radius: 6px; padding: 5px 10px; font-size: 12px; cursor: pointer; }
.dbq-btn:hover:not(:disabled) { background: #2b2f36; }
.dbq-btn:disabled { opacity: .5; cursor: not-allowed; }
.dbq-btn.dbq-primary { border-color: #4a9eff; color: #cfe4ff; }
.dbq-btn.dbq-dirty { border-color: #f5a623; color: #ffd79a; }
.dbq-dirty-flag { color: #f5a623; font-size: 12px; }

.dbq-models { display: flex; flex-direction: column; gap: 6px; }
.dbq-model { display: flex; align-items: flex-start; gap: 8px; padding: 6px 8px;
  border: 1px solid #262a30; border-radius: 6px; }
.dbq-model input[type=checkbox] { margin-top: 3px; flex: none; }
.dbq-model-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dbq-model-name { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.dbq-badge { font-size: 11px; color: #9aa0a6; border: 1px solid #33383f;
  border-radius: 4px; padding: 0 4px; }
.dbq-model-desc { color: #9aa0a6; font-size: 11px; }
.dbq-saved { color: #7fd18a; font-size: 12px; }
.dbq-error { color: #ff9d99; font-size: 12px; }
`;
		//#endregion
		//#region src/client/DoubaoQuotaCard.tsx
		/**
		* The Doubao quota + model card, rendered into the host's Plugin
		* configuration surface.
		*
		* SCOPE (deliberately narrow): two quota bars with reset countdowns, the plan
		* name, the account status line, a refresh button with a 5-minute poll, four
		* distinct error states, and the model checklist. No account pool, no region
		* tabs, no credit multipliers, no check-in.
		*
		* THE ONE HONESTY REQUIREMENT: Doubao is content-driven. The request body
		* carries `bot_id`, never a model id — the server picks the model after reading
		* the prompt (see `../doubao-catalog.ts`). So the checklist does NOT choose a
		* model. Ticking an entry decides whether that ENTRY appears in DSH's model
		* picker. Every label in the model block says so, because a checklist that
		* looked like model selection would be a lie the user acts on.
		*
		* SECURITY: this component renders only the allow-listed fields of
		* `DoubaoQuotaView` / `DoubaoCatalogView`. It never reads, stores or displays a
		* cookie, token or account id, and it never reads a setting other than the
		* ticked model ids.
		*
		* @module dsh-connect-doubao/client-card
		*/
		/** How often the quota is re-read without the user asking. */
		const POLL_INTERVAL_MS = 3e5;
		/**
		* Fallback translator: renders the key itself.
		*
		* Better than throwing. If the locale registration failed, the card still shows
		* its structure (bars, state dot, controls) with visible key names, which is
		* diagnosable — a thrown render would blank the slot and hide the failure.
		*/
		const fallbackT = (key) => key;
		/** Inject the stylesheet once per document. */
		function useCardStyles() {
			(0, react.useEffect)(() => {
				if (typeof document === "undefined") return;
				const id = "dbq-card-styles";
				if (document.getElementById(id) !== null) return;
				const el = document.createElement("style");
				el.id = id;
				el.textContent = DOUBAO_CARD_CSS;
				document.head?.appendChild(el);
			}, []);
		}
		/**
		* GET the quota view. Never throws: every failure becomes `undefined`, which
		* classifies as `unreadable` rather than unmounting the card.
		*/
		async function fetchQuota(signal) {
			const response = await fetch(DOUBAO_QUOTA_PATH, {
				method: "GET",
				credentials: "same-origin",
				signal,
				headers: { accept: "application/json" }
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** POST forces a host-side cache bypass. Same error contract as {@link fetchQuota}. */
		async function refreshQuota() {
			const response = await fetch(DOUBAO_QUOTA_PATH, {
				method: "POST",
				credentials: "same-origin",
				headers: { accept: "application/json" }
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** Read the catalog for the checklist. Never throws. */
		async function fetchCatalog(signal) {
			const response = await fetch(DOUBAO_CATALOG_PATH, {
				method: "GET",
				credentials: "same-origin",
				signal,
				headers: { accept: "application/json" }
			});
			if (!response.ok) return void 0;
			return await response.json();
		}
		/** One quota bar: label, used percent, bar, reset countdown. */
		function QuotaBar(props) {
			const { label, usedPercent, resetsInMs, t, now } = props;
			if (usedPercent === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dbq-row",
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dbq-row-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-label",
						children: label
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-meta",
						children: t("quota.windowMissing")
					})]
				})
			});
			const percent = clampPercent(usedPercent);
			const tone = percent >= 100 ? " dbq-full" : percent >= 80 ? " dbq-warn" : "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dbq-row",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-row-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-label",
							children: label
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dbq-meta",
							children: [
								t("quota.used", { percent }),
								" · ",
								t("quota.resetsIn", { time: formatCountdown(resetsInMs ?? 0) })
							]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dbq-bar",
						role: "progressbar",
						"aria-valuenow": percent,
						"aria-valuemin": 0,
						"aria-valuemax": 100,
						"aria-label": label,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `dbq-fill${tone}`,
							style: { width: `${percent}%` }
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dbq-meta",
						hidden: true,
						children: `now=${now}`
					})
				]
			});
		}
		function DoubaoQuotaCard(props) {
			const t = props.t ?? fallbackT;
			const scope = props.settingsScope;
			useCardStyles();
			const [quota, setQuota] = (0, react.useState)(void 0);
			const [busy, setBusy] = (0, react.useState)(false);
			const [catalog, setCatalog] = (0, react.useState)(void 0);
			const [catalogBusy, setCatalogBusy] = (0, react.useState)(false);
			/** Ticking `settingsScope` bumps this so the model block re-reads the snapshot. */
			const [settingsRevision, setSettingsRevision] = (0, react.useState)(0);
			/** Only set once the settings write has been read back and confirmed. */
			const [saved, setSaved] = (0, react.useState)(false);
			const [saveError, setSaveError] = (0, react.useState)(null);
			/**
			* The settings snapshot, used ONLY as a fallback.
			*
			* The authoritative copy is now the plugin's own file, read through
			* `DOUBAO_SAVE_PATH` below: this plugin's fiber never reaches ACTIVE on DSH
			* 0.2.1, so the host neither lists nor writes its namespace (`No configurable
			* plugin entry`). A snapshot that cannot see a save is worse than no
			* snapshot, hence the file wins when both are available.
			*/
			const scopedValue = (0, react.useMemo)(() => {
				if (scope === void 0) return void 0;
				try {
					return scope.getSnapshot().value;
				} catch {
					return;
				}
			}, [scope, settingsRevision]);
			/** Settings as persisted by the plugin itself. `undefined` = not read yet. */
			const [stored, setStored] = (0, react.useState)(void 0);
			const [storeError, setStoreError] = (0, react.useState)(null);
			const loadSettings = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(DOUBAO_SAVE_PATH, { method: "GET" });
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					const body = await response.json();
					setStored(body.value);
					setStoreError(null);
				} catch (error) {
					setStoreError(error?.message ?? "unknown error");
					setStored(scope === void 0 ? void 0 : scopedValue);
				}
			}, [scope, scopedValue]);
			(0, react.useEffect)(() => {
				loadSettings();
			}, [loadSettings]);
			const configured = stored ?? scopedValue;
			/**
			* Writes go through the plugin's own endpoint, so they do NOT depend on the
			* host's `writable` flag — that flag is exactly what was false here.
			*/
			const canWrite = stored !== void 0 || storeError === null;
			(0, react.useEffect)(() => {
				if (scope === void 0) return;
				return scope.subscribe(() => setSettingsRevision((value) => value + 1));
			}, [scope]);
			(0, react.useEffect)(() => {
				let alive = true;
				const controller = new AbortController();
				const load = async () => {
					try {
						const view = await fetchQuota(controller.signal);
						if (alive) setQuota(view);
					} catch {
						if (alive) setQuota(void 0);
					}
				};
				load();
				const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
				return () => {
					alive = false;
					controller.abort();
					clearInterval(timer);
				};
			}, []);
			const onRefresh = (0, react.useCallback)(async () => {
				setBusy(true);
				try {
					setQuota(await refreshQuota());
				} catch {
					setQuota(void 0);
				} finally {
					setBusy(false);
				}
			}, []);
			const loadCatalog = (0, react.useCallback)(async () => {
				setCatalogBusy(true);
				try {
					setCatalog(await fetchCatalog(new AbortController().signal));
				} catch {
					setCatalog(void 0);
				} finally {
					setCatalogBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				loadCatalog();
			}, [loadCatalog]);
			/**
			* The draft: which entries are ticked.
			*
			* `undefined` means "no draft yet" — the card derives one from the catalog
			* (ticking everything, so a first-time user sees a usable picker) rather than
			* rendering an empty list that reads as a failure.
			*/
			const [draft, setDraft] = (0, react.useState)(void 0);
			(0, react.useEffect)(() => {
				const models = catalog?.models;
				if (models === void 0 || models.length === 0) {
					setDraft(void 0);
					return;
				}
				const savedIds = enabledModelIdsOf(configured);
				setDraft(new Set(savedIds ?? models.map((model) => model.id)));
			}, [catalog, configured]);
			const models = catalog?.models ?? [];
			const enabledCount = draft === void 0 ? 0 : draft.size;
			/**
			* Whether the draft differs from what is saved.
			*
			* Compared as SETS of ids, so reordering the catalog never marks the card
			* dirty, and a saved value that the current catalog does not contain does not
			* either. Only ids present in the catalog can be toggled, so an id that has
			* since disappeared upstream is simply ignored.
			*/
			const dirty = (0, react.useMemo)(() => {
				if (draft === void 0) return false;
				const savedIds = enabledModelIdsOf(configured);
				const base = new Set(savedIds ?? models.map((model) => model.id));
				if (base.size !== draft.size) return true;
				for (const id of base) if (!draft.has(id)) return true;
				return false;
			}, [
				draft,
				configured,
				models
			]);
			const toggle = (0, react.useCallback)((id) => {
				setDraft((current) => {
					const next = new Set(current ?? []);
					if (next.has(id)) next.delete(id);
					else next.add(id);
					return next;
				});
				setSaved(false);
				setSaveError(null);
			}, []);
			const selectAll = (0, react.useCallback)(() => {
				setDraft(new Set(models.map((model) => model.id)));
				setSaved(false);
				setSaveError(null);
			}, [models]);
			const selectNone = (0, react.useCallback)(() => {
				setDraft(/* @__PURE__ */ new Set());
				setSaved(false);
				setSaveError(null);
			}, []);
			/**
			* Persist one settings field through the plugin's OWN endpoint.
			*
			* Neither `scope.set()` NOR `settings.mutate` can persist this plugin: its
			* fiber never reaches ACTIVE on DSH 0.2.1, so the host reports
			* `No configurable plugin entry "dsh-connect-doubao"` and drops every write.
			* The endpoint writes a JSON file the plugin owns (write-temp-then-rename),
			* and returns the value it now reads back — so a successful response is
			* proof of persistence, not a claim.
			*/
			const persistField = (0, react.useCallback)(async (field, value) => {
				let response;
				try {
					response = await fetch(DOUBAO_SAVE_PATH, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							field,
							value
						})
					});
				} catch (error) {
					throw new Error(`host save endpoint unreachable: ${error?.message ?? String(error)}`);
				}
				const detail = await response.json().catch(() => ({ error: `HTTP ${String(response.status)}` }));
				if (!response.ok || detail.ok !== true) {
					const reason = `${String(detail.errorName ?? "")} ${String(detail.error ?? "")}`.trim();
					throw new Error(reason === "" ? `HTTP ${String(response.status)}` : reason);
				}
				setStored(detail.value);
				setStoreError(null);
				return detail.value;
			}, []);
			/**
			* Save the draft, then READ IT BACK.
			*
			* The endpoint reporting `ok` is the commit; the read-back only confirms the
			* page's own snapshot caught up. Here it matters more than usual because a
			* save discards the draft — so a snapshot that never refreshes is reported
			* rather than silently losing the user's edits.
			*/
			const onSave = (0, react.useCallback)(async () => {
				if (draft === void 0) return;
				setBusy(true);
				setSaveError(null);
				const ids = [...draft];
				try {
					const committed = enabledModelIdsOf(await persistField(DOUBAO_ENABLED_MODELS_FIELD, ids));
					if (!(committed !== void 0 && committed.length === ids.length && ids.every((id) => committed?.includes(id)))) {
						setSaveError(t("models.saveFailed", { reason: "已写入磁盘，但回读的值与提交的不一致" }));
						return;
					}
					setSaved(true);
				} catch (error) {
					setSaveError(t("models.saveFailed", { reason: error?.message ?? "unknown error" }));
				} finally {
					setBusy(false);
				}
			}, [
				persistField,
				draft,
				t
			]);
			/**
			* The tool-emulation switch.
			*
			* Written immediately (no Save button) because it is a single independent
			* toggle: bundling it into the checklist's draft would make a model-selection
			* edit and a privilege change share one commit, and the user cannot tell which
			* one they are confirming.
			*
			* Read back for the same reason the checklist is: the host's write can resolve
			* while the value never lands (see `onSave`), and silently failing to turn OFF
			* a capability that lets a model touch files is the worse error.
			*/
			const [profile, setProfile] = (0, react.useState)(void 0);
			const [profileBusy, setProfileBusy] = (0, react.useState)(false);
			const [profileError, setProfileError] = (0, react.useState)(null);
			const loadProfile = (0, react.useCallback)(async () => {
				try {
					const response = await fetch(DOUBAO_PROFILE_PATH, { method: "GET" });
					if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
					setProfile(await response.json());
				} catch (error) {
					setProfileError(error?.message ?? "unknown error");
				}
			}, []);
			(0, react.useEffect)(() => {
				loadProfile();
			}, [loadProfile]);
			const chosenProfile = profileDirOf(configured);
			/** What is actually in use right now: the manual pick, else auto-detection. */
			const activeProfile = chosenProfile !== "" ? chosenProfile : profile?.detected ?? "";
			/**
			* Open the host's native folder picker.
			*
			* The desktop shell exposes `__DSH_DIRECTORY_PICKER__.pick()` — an Electron
			* dialog that runs on the main thread and can therefore create a folder. A
			* browser-only host has no equivalent, and the card says so rather than
			* silently doing nothing; `DSH_DOUBAO_PROFILE` remains the escape hatch.
			*/
			const pickProfile = (0, react.useCallback)(async () => {
				setProfileError(null);
				setProfileBusy(true);
				try {
					const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
					if (typeof desktop?.pick !== "function") throw new Error("no native picker on this host");
					const picked = await desktop.pick();
					if (picked === null || picked === "") return;
					const committed = profileDirOf(await persistField(DOUBAO_PROFILE_DIR_FIELD, picked));
					setProfileError(committed === "" ? t("profile.invalid") : null);
					if (committed !== "") {
						loadProfile();
						onRefresh();
					}
				} catch (error) {
					setProfileError(t("profile.pickFailed", { reason: error?.message ?? "unknown" }));
				} finally {
					setProfileBusy(false);
				}
			}, [
				persistField,
				loadProfile,
				onRefresh,
				t
			]);
			const clearProfile = (0, react.useCallback)(async () => {
				setProfileError(null);
				try {
					await persistField(DOUBAO_PROFILE_DIR_FIELD, "");
					loadProfile();
					onRefresh();
				} catch (error) {
					setProfileError(error?.message ?? "unknown error");
				}
			}, [
				persistField,
				loadProfile,
				onRefresh
			]);
			const toolsOn = toolEmulationOf(configured);
			const [toolsError, setToolsError] = (0, react.useState)(null);
			const onToggleTools = (0, react.useCallback)(async (next) => {
				setToolsError(null);
				try {
					if (toolEmulationOf(await persistField("toolEmulation", next)) !== next) setToolsError(t("models.saveFailed", { reason: "已写入磁盘，但回读的值与提交的不一致" }));
				} catch (error) {
					setToolsError(t("models.saveFailed", { reason: error?.message ?? "unknown error" }));
				}
			}, [persistField, t]);
			const state = classifyQuotaView(quota);
			const stateText = t(`account.${state}`);
			const stateTone = state === "ok" ? "" : state === "exhausted" || state === "network" ? " dbq-bad" : " dbq-warn";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dbq-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-title",
							children: t("card.title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dbq-sub",
							children: t("card.subtitle")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("quota.plan") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: quota?.plan ?? "—"
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
								label: t("quota.fiveHour"),
								usedPercent: quota?.windows.fiveHour?.usedPercent,
								resetsInMs: quota?.windows.fiveHour?.resetsInMs,
								t,
								now: 0
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)(QuotaBar, {
								label: t("quota.weekly"),
								usedPercent: quota?.windows.weekly?.usedPercent,
								resetsInMs: quota?.windows.weekly?.resetsInMs,
								t,
								now: 0
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dbq-btn",
									onClick: () => void onRefresh(),
									disabled: busy,
									children: busy ? t("quota.refreshing") : t("quota.refresh")
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-note",
									children: t("quota.autoNote")
								})]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-section-title",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("account.title") })
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-state",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `dbq-dot${stateTone}` }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-state-text",
									children: stateText
								})]
							}),
							quota?.profile !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-profile",
								children: [
									t("account.profile"),
									": ",
									quota.profile
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("profile.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: chosenProfile !== "" ? t("profile.manual") : profile?.detected != null ? t("profile.detected") : t("profile.none")
								})]
							}),
							activeProfile !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-profile",
								children: [
									t("profile.current"),
									": ",
									activeProfile
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("profile.hint")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dbq-btn",
									onClick: () => void pickProfile(),
									disabled: profileBusy || !canWrite,
									children: profileBusy ? t("profile.picking") : t("profile.pick")
								}), chosenProfile !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: "dbq-btn",
									onClick: () => void clearProfile(),
									disabled: profileBusy,
									children: t("profile.clear")
								})]
							}),
							profile !== void 0 && profile.candidates.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-candidates",
								children: profile.candidates.map((entry) => `${entry.dir} (${entry.source})`).join("\n")
							}),
							profileError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dbq-error",
								children: profileError
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("models.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: t("models.enabledCount", { count: enabledCount })
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.routingNote")
							}),
							!canWrite && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.readOnly")
							}),
							catalog === void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.loadFailed")
							}),
							catalog?.ok === true && models.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("models.empty")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-models",
								children: models.map((model) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
									className: "dbq-model",
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "checkbox",
										checked: draft?.has(model.id) ?? false,
										disabled: !canWrite || draft === void 0,
										onChange: () => toggle(model.id)
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-model-main",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: "dbq-model-name",
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: model.name }), model.badge !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: "dbq-badge",
												children: model.badge
											})]
										})
									})]
								}, model.id))
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-actions",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: () => void loadCatalog(),
										disabled: catalogBusy,
										children: catalogBusy ? t("models.refreshing") : t("models.refresh")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: selectAll,
										disabled: !canWrite,
										children: t("models.selectAll")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: "dbq-btn",
										onClick: selectNone,
										disabled: !canWrite,
										children: t("models.selectNone")
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `dbq-btn dbq-primary${dirty ? " dbq-dirty" : ""}`,
										onClick: () => void onSave(),
										disabled: !canWrite || !dirty || busy,
										children: busy ? t("models.saving") : t("models.save")
									}),
									dirty && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-dirty-flag",
										children: t("models.dirty")
									}),
									!dirty && saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-saved",
										children: t("models.saved")
									}),
									saveError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-error",
										children: saveError
									})
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dbq-section",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: "dbq-section-title",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("tools.title") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-count",
									children: toolsOn ? t("tools.enabled") : t("tools.disabled")
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note",
								children: t("tools.note")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
								className: "dbq-model",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "checkbox",
									checked: toolsOn,
									disabled: !canWrite,
									onChange: (event) => void onToggleTools(event.currentTarget.checked)
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dbq-model-main",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: "dbq-model-name",
										children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("tools.toggle") })
									})
								})]
							}),
							toolsOn && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dbq-note dbq-warn",
								children: t("tools.warning")
							}),
							toolsError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dbq-error",
								children: toolsError
							})
						]
					})
				]
			});
		}
		//#endregion
		//#region src/client/locales.ts
		/**
		* Bilingual copy for the Doubao plugin card.
		*
		* Same key/value system the reference connector uses: one flat key map per
		* language, and a `t` bound at registration time. Keys are the contract —
		* `Translate` is typed against `zh`'s keys, so adding a key to `en` and not to
		* `zh` (or vice versa) is a type error rather than a runtime `undefined`.
		*
		* @module dsh-connect-doubao/client-locales
		*/
		/** Chinese copy. The key set that defines the contract. */
		const zh = {
			"card.title": "豆包连接",
			"card.subtitle": "复用本机豆包客户端的登录态，不额外登录。",
			"card.navLabel": "豆包",
			"quota.plan": "套餐",
			"quota.fiveHour": "5 小时限额",
			"quota.weekly": "周额度",
			"quota.used": "已用 {percent}%",
			"quota.resetsIn": "{time} 后重置",
			"quota.refresh": "刷新额度",
			"quota.refreshing": "刷新中…",
			"quota.autoNote": "每 5 分钟自动刷新",
			"quota.updatedAt": "更新于 {time}",
			"quota.windowMissing": "未返回该额度窗口",
			"account.title": "账号状态",
			"account.ok": "已登录",
			"account.signed_out": "未登录：请在豆包客户端登录后重试",
			"account.unreadable": "登录信息读不出来：本机凭据无法解密，请检查豆包客户端是否正常安装并已登录",
			"account.session_dead": "登录态已失效：请在豆包客户端重新登录",
			"account.risk_challenge": "触发了风控验证：请打开豆包客户端手动发一条消息完成滑块验证",
			"account.exhausted": "额度已用尽：等待窗口重置，或在豆包客户端查看「订阅与额度管理」",
			"account.network": "连接豆包失败：请检查网络后重试",
			"account.unknown": "状态未知",
			"account.profile": "配置目录",
			"models.title": "模型",
			"models.enabledCount": "已启用 {count} ↑",
			"models.routingNote": "清单直接读自豆包客户端的缓存，豆包上线新模型时会自动出现，不需要等插件更新。「工作任务」专属的条目（2.1 Pro / Lite / Auto）由客户端内的运行时执行，外部客户端接不进去，已自动隐藏",
			"models.refresh": "刷新",
			"models.refreshing": "刷新中…",
			"models.save": "保存",
			"models.saving": "保存中…",
			"models.discard": "放弃更改",
			"models.selectAll": "全选",
			"models.selectNone": "全不选",
			"models.dirty": "有未保存的更改",
			"models.saved": "已保存",
			"models.saveFailed": "保存失败：{reason}",
			"models.tier": "档位",
			"models.tierFast": "快速",
			"models.tierThink": "思考",
			"models.tierExpert": "专家",
			"models.readOnly": "当前宿主未提供设置写入通道，勾选不会生效",
			"models.loadFailed": "模型目录读取失败",
			"models.empty": "没有可用的模型条目",
			"profile.title": "豆包数据目录",
			"profile.detected": "自动探测到",
			"profile.none": "没找到：豆包可能还没安装，或数据放在了别的位置",
			"profile.manual": "已手动指定",
			"profile.pick": "选择目录…",
			"profile.picking": "等待选择…",
			"profile.clear": "改回自动探测",
			"profile.current": "当前使用",
			"profile.hintTitle": "该选哪个目录？",
			"profile.hint": "选豆包客户端存放数据的那个文件夹，里面应该有一个叫 Default 的子文件夹（Default/Cookies（macOS）或 Default\Network\Cookies（Windows） 就是登录信息）。常见位置：%LOCALAPPDATA%\\Doubao\\User Data。如果你在装豆包时改过「数据目录」，或后来把整个 User Data 文件夹搬到了 D 盘，就选搬过去的那个。选上层文件夹（例如 D:\\Doubao）也可以，插件会自动往下找一层 User Data。",
			"profile.invalid": "这个目录里没有豆包数据（缺少 Default/Cookies（macOS）或 Default\Network\Cookies（Windows））",
			"profile.envNote": "也可以设环境变量 {env}，它的优先级最高。",
			"profile.pickFailed": "打开目录选择器失败：{reason}",
			"tools.title": "实验性：工具调用",
			"tools.toggle": "让豆包驱动本地工具（读写文件、执行命令）",
			"tools.note": "豆包的接口没有函数调用通道（声明的 tools 会被静默忽略），此开关改用提示词模拟：把工具清单写进提示词，再把回复里的围栏解析回标准 tool_calls。实测约 11.5 秒/轮，复杂任务可能退化，故默认关闭。",
			"tools.warning": "开启后豆包可以读写这台机器上的文件。请确认你信任当前会话的权限范围。",
			"tools.enabled": "已开启",
			"tools.disabled": "已关闭"
		};
		/** English copy, typed to the Chinese key set. */
		const en = {
			"card.navLabel": "Doubao",
			"card.title": "Doubao connection",
			"card.subtitle": "Reuses the sign-in already held by the local Doubao app; no separate login.",
			"quota.plan": "Plan",
			"quota.fiveHour": "5-hour limit",
			"quota.weekly": "Weekly quota",
			"quota.used": "{percent}% used",
			"quota.resetsIn": "resets in {time}",
			"quota.refresh": "Refresh quota",
			"quota.refreshing": "Refreshing…",
			"quota.autoNote": "Refreshes automatically every 5 minutes",
			"quota.updatedAt": "updated {time}",
			"quota.windowMissing": "window not reported",
			"account.title": "Account status",
			"account.ok": "Signed in",
			"account.signed_out": "Not signed in: sign in to the Doubao app and retry",
			"account.unreadable": "Sign-in could not be read: local credentials failed to decrypt. Check that the Doubao app is installed normally and signed in",
			"account.session_dead": "Session expired: sign in again to the Doubao app",
			"account.risk_challenge": "Risk-control challenge hit: open the Doubao app and send one message to clear the slider",
			"account.exhausted": "Quota exhausted: wait for the window to reset, or check subscription management in the Doubao app",
			"account.network": "Could not reach Doubao: check the network and retry",
			"account.unknown": "Status unknown",
			"account.profile": "Profile path",
			"models.title": "Models",
			"models.enabledCount": "{count} enabled ↑",
			"models.routingNote": "Only the 对话-mode entries are offered (快速 / 专家). The 「工作任务」-only models (2.1 Pro / 2.1 Lite) are executed by the Doubao desktop app runtime, which an external client cannot join",
			"models.refresh": "Refresh",
			"models.refreshing": "Refreshing…",
			"models.save": "Save",
			"models.saving": "Saving…",
			"models.discard": "Discard changes",
			"models.selectAll": "Select all",
			"models.selectNone": "Select none",
			"models.dirty": "unsaved changes",
			"models.saved": "Saved",
			"models.saveFailed": "Save failed: {reason}",
			"models.tier": "Tier",
			"models.tierFast": "Fast",
			"models.tierThink": "Thinking",
			"models.tierExpert": "Expert",
			"models.readOnly": "This host provides no settings write path; ticking has no effect",
			"models.loadFailed": "Could not read the model catalog",
			"models.empty": "No model entries available",
			"profile.title": "Doubao data directory",
			"profile.detected": "Detected automatically",
			"profile.none": "Not found — the app may not be installed, or its data lives elsewhere",
			"profile.manual": "Set manually",
			"profile.pick": "Choose folder…",
			"profile.picking": "Waiting for the picker…",
			"profile.clear": "Back to automatic",
			"profile.current": "In use",
			"profile.hintTitle": "Which folder should I pick?",
			"profile.hint": "Pick the folder where the Doubao app keeps its data. It should contain a subfolder called Default — Default/Cookies（macOS）或 Default\Network\Cookies（Windows） is the sign-in. The usual place is %LOCALAPPDATA%\\Doubao\\User Data. If you changed the \"data directory\" during install, or moved the whole User Data folder to D:, pick where you moved it. Picking the parent (e.g. D:\\Doubao) also works: the plugin looks one level down for User Data.",
			"profile.invalid": "That folder holds no Doubao data (no Default/Cookies（macOS）或 Default\Network\Cookies（Windows）)",
			"profile.envNote": "You can also set the {env} environment variable; it takes precedence over everything.",
			"profile.pickFailed": "Could not open the folder picker: {reason}",
			"tools.title": "Experimental: tool calling",
			"tools.toggle": "Let Doubao drive local tools (read/write files, run commands)",
			"tools.note": "Doubao's endpoint has no function-calling channel — a declared `tools` array is silently ignored — so this switch simulates it: the tool list goes into the prompt and the fenced block in the reply is parsed back into standard tool_calls. Measured ~11.5s per round; can degrade on complex tasks, hence off by default.",
			"tools.warning": "When on, Doubao can read and write files on this machine. Make sure you trust the permission scope of the current session.",
			"tools.enabled": "On",
			"tools.disabled": "Off"
		};
		/** Locale namespace registered by the browser-plugin entry. */
		const NAMESPACE = "settings.doubao";
		/** Bind a language table into the `t` the card uses. */
		function translator(table) {
			return (key, vars) => {
				const template = table[key] ?? key;
				if (vars === void 0) return template;
				return template.replace(/\{(\w+)\}/g, (match, name) => {
					const value = vars[name];
					return value === void 0 ? match : String(value);
				});
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Stable browser-plugin name. */
		const name = "dsh-connect-doubao-client";
		/** Only the universally available seats; see the module note on the gate. */
		const inject = ["slots", "locale"];
		/**
		* Register the card copy and the card itself under Plugin configuration.
		*
		* Everything is inside try/catch at two levels: the whole body, and each slot
		* registration individually. A card that cannot render must never take down the
		* page — the host provider still serves models without it.
		*/
		function apply(ctx) {
			try {
				ctx.effect(() => ctx.locale.register(NAMESPACE, {
					zh,
					en
				}), "dsh-connect-doubao: card copy");
				const t = ctx.locale.bind(NAMESPACE);
				/**
				* Soft service probe.
				*
				* Reading an undeclared service property THROWS ("cannot get property X
				* without inject") — `?.` guards null/undefined, not a throwing getter — so
				* the settings seat must be reached through `ctx.get()`, which returns
				* `undefined` for an absent service instead.
				*/
				const softGet = (name) => ctx.get(name);
				let settingsScope;
				const forms = softGet("configForms");
				if (forms !== void 0) {
					let ns = "dsh-connect-doubao";
					try {
						const served = (forms.describe().getSnapshot().view?.namespaces ?? []).find((entry) => entry.ns === ns || /doubao/i.test(entry.ns));
						if (served !== void 0) ns = served.ns;
					} catch {}
					settingsScope = forms.get(ns);
				}
				const registerCard = (slotName, key) => {
					try {
						ctx.slots.inject(slotName, () => ctx.slots.register({
							name: slotName,
							key,
							priority: 30,
							inject: () => settingsScope === void 0 ? { t } : {
								t,
								settingsScope
							}
						}, DoubaoQuotaCard));
					} catch (error) {
						console.error(`[dsh-connect-doubao] card slot "${slotName}" failed to register (host provider unaffected):`, error);
					}
				};
				registerCard("plugins.bundle.config", "dsh-connect-doubao");
				registerCard("plugins.row.config", "dsh-connect-doubao#dsh-connect-doubao");
				/**
				* Top-level entry in the SETTINGS LEFT-HAND NAV — the surface the user
				* asked for.
				*
				* WHY THIS SLOT, AND WHERE THE NAME CAME FROM
				* ------------------------------------------
				* `settings.section` is the host's own settings-nav row slot, declared by
				* `@deepseek-ai/dsh-client-ui-settings-general`, whose `SettingsRoot`
				* renders exactly what the user's screenshot shows:
				*
				*   nav list : [navIcon(row.id), <span className="navLabel">{row.label}</span>]
				*   content : renderSlot("settings.section", { close: onClose }, { only: active })
				*
				* `only: active` is the important half: the host mounts ONLY the section the
				* user clicked, so our card is not rendered until its row is selected.
				*
				* The descriptor fields are `id` / `order` / `label` / `inject` — NOT the
				* `key` / `priority` pair the `plugins.*` slots use. Transcribed from two
				* plugins that provably appear in that nav:
				*
				*   - `@yangdcm/dsh-expert-team` ("专家团"):
				*       ctx.slots.inject('settings.section', () => ctx.slots.register({
				*         name: 'settings.section', id: 'expert-team', order: 50,
				*         label: () => t('专家团', 'Expert team') }, wrap(SettingsSection)))
				*   - `dsh-better-sidebar` ("侧边卡片"): same shape, `order: 100`.
				*
				* `dsh-better-sidebar` also documents the host's limits: "DSH 0.1.x projects
				* only `id`, `order`, and `label` from a `settings.section` registration"
				* — there is no icon field, so the host draws a generic gear for plugin rows.
				*
				* `ctx.slots.inject` waits for the host's DECLARATION of the slot, so on a
				* host that does not ship the settings shell this simply never attaches and
				* everything else keeps working.
				*
				* `order: 40` places 豆包 above 专家团's 50 and below the shell's own sections,
				* matching the position the user asked for in the list.
				*/
				const registerSettingsSection = () => {
					try {
						ctx.slots.inject("settings.section", () => ctx.slots.register({
							name: "settings.section",
							id: "dsh-connect-doubao",
							order: 40,
							label: () => t("card.navLabel"),
							inject: () => settingsScope === void 0 ? { t } : {
								t,
								settingsScope
							}
						}, DoubaoQuotaCard));
					} catch (error) {
						console.error("[dsh-connect-doubao] settings.section failed to register (host provider unaffected):", error);
					}
				};
				registerSettingsSection();
			} catch (error) {
				console.error("[dsh-connect-doubao] client card failed to load (host provider unaffected):", error);
			}
		}
		//#endregion
		exports.DoubaoQuotaCard = DoubaoQuotaCard;
		exports.apply = apply;
		exports.en = en;
		exports.inject = inject;
		exports.name = name;
		exports.translator = translator;
		exports.zh = zh;
		return module.exports;
	}
});
