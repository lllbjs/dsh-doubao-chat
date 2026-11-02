import { $ as DOUBAO_CONTEXT_WINDOW, A as probeAccount, B as PROFILE_ENV, C as chat, D as extractModel, E as describeDoubaoFailure, F as REQUIRED_COOKIE_NAMES, G as looksLikeProfile, H as extractUserDataDir, I as decodeCookiePlaintext, J as CHAT_AGENT_MODE, K as resolveUserProvided, L as decryptCookieValue, M as taskModeEnabled, N as taskWorkspaceOf, O as invalidateRenewals, P as CREDENTIAL_TTL_MS, Q as DEFAULT_REASONING_LEVEL_ID, R as invalidateCredentialCache, S as buildQueryUrl, T as collectBlocks, U as findDoubaoUserDataDir, V as describeProfileLocation, W as listDoubaoProfiles, X as DEEP_THINK_OFF, Y as CREATION_BLOCK_TYPE, Z as DEEP_THINK_ON, _ as applyRenewals, _t as enabledModelsOf, a as invalidateQuotaCache, at as DOUBAO_PROVIDER, b as buildGeneralTaskParam, bt as inputSkillOf, c as ACCOUNT_ENDPOINT, ct as DOUBAO_SKILLS, d as DEFAULT_BOT_ID, dt as TASK_AGENT_MODE, et as DOUBAO_DEFAULT_MODEL_ID, f as DOUBAO_ERROR_HINTS, ft as TASK_RUNTIME_CLOUD_VM, g as RUNTIME_VERSION, gt as doubaoCatalogEntries, h as QUOTA_ENDPOINT, ht as discoverDoubaoModels, i as formatDuration, it as DOUBAO_MODELS, j as streamChat, k as parseFrames, l as CHAT_ENDPOINT, lt as DOUBAO_UNAVAILABLE_MODELS, m as DoubaoUpstreamError, mt as TASK_SANDBOX_AUTH_ALLOW_ALL, n as fetchQuota, nt as DOUBAO_IMAGE_MODEL_NAME, o as millisUntilReset, ot as DOUBAO_PROVIDER_DISPLAY_NAME, p as DOUBAO_VERSION, pt as TASK_RUNTIME_LOCAL_PC, q as setProfileOverride, r as findWindow, rt as DOUBAO_MAX_TOKENS, s as normalizeWindow, st as DOUBAO_REASONING_LEVELS, t as QUOTA_TTL_MS, tt as DOUBAO_IMAGE_MODEL_ID, u as CLIENT_PARAMS, ut as SKILL_CARRIER_MODEL_ID, v as assembleReplyText, vt as findDoubaoModel, w as classifyDoubaoFailure, x as buildHeaders, xt as needDeepThinkValue, y as buildChatBody, yt as findReasoningLevel, z as loadDoubaoCredentials } from "./doubao-quota-SO5U9prN.js";
import { a as registerDoubaoCatalogRoute, c as registerDoubaoSaveRoute, d as discoverModels, f as invalidateDiscovery, g as createDoubaoAdapter, h as DOUBAO_STREAM_IDLE_TIMEOUT_MS, i as doubaoQuotaView, l as DISCOVERY_TTL_MS, m as createDoubaoShim, n as DOUBAO_QUOTA_PATH, o as registerDoubaoProfileRoute, p as liveModels, r as DOUBAO_SAVE_PATH, s as registerDoubaoQuotaRoute, t as DOUBAO_CATALOG_PATH, u as discoverAllCachedModels } from "./doubao-status-BAUM_fsV.js";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import z from "@deepseek-ai/schemastery";
//#region src/doubao-config.ts
/**
* Persisted settings for the Doubao plugin.
*
* ONE field on purpose. Doubao takes no credentials, no region, no pool and no
* multipliers — the only thing a user can meaningfully configure is which catalog
* entries appear in DSH's model picker.
*
* IMPORTANT: the schema lives in its own module so the browser half can mirror
* the field name without importing anything Node-side. The Loader reads `Config`
* from the plugin entry, which re-exports this.
*
* @module dsh-connect-doubao/config
*/
/** The single settings field. Mirrored by the card as `enabledModelIds`. */
const ENABLED_MODEL_IDS_FIELD = "enabledModelIds";
/** The settings field holding the tool-emulation switch. */
const TOOL_EMULATION_FIELD = "toolEmulation";
/** The settings field holding a manually chosen profile directory. */
const PROFILE_DIR_FIELD = "profileDir";
/** Read the chosen profile directory, or `undefined` when it is not set. */
function profileDirOf(config) {
	const value = config?.profileDir;
	return typeof value === "string" && value.trim() !== "" ? value : void 0;
}
/** Read the switch out of an arbitrary config snapshot; default false. */
function toolEmulationOf(config) {
	return config?.toolEmulation === true;
}
/** Whether the user has ever saved a selection (i.e. the field is not the default). */
function isConfigured(config) {
	return enabledIdsOf(config) !== void 0;
}
/**
* The settings SCHEMA the Loader reads.
*
* It MUST be a real schemastery schema: Cordis calls `.validate()` on it while
* resolving the entry's config, so a plain object literal throws
* `TypeError: Cannot read properties of undefined (reading 'validate')` and the
* Loader reports `1 entry did not activate` — the plugin then contributes
* nothing at all (no provider, no routes), with only that one warning to show
* for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
*
* schemastery is a peer dependency resolved from the Harness at runtime and is
* never bundled (see tsdown.config.ts).
*/
/**
* Mark one schema field as volatile.
*
* This is what makes the field WRITABLE from a settings form at all. The host
* only surfaces volatile fields (`Forms expose only volatile fields from
* active, uniquely addressed profile entries`), and its write gate rejects
* everything else:
*
*   Plugin entry "<id>" has no volatile fields
*
* — which is exactly why `settings.describe()` listed 33 namespaces and this
* plugin's was the one missing: the namespace is derived from the marker, not
* from the Loader entry. The comparison plugin states the failure verbatim:
* "the scope's `set()` still resolves — so the card would look like it saved
* and silently revert", which is precisely the symptom that started this hunt.
*
* `volatile()` ships in schemastery 3.18.3+ and the peer range requires
* >=3.18.4, so the function probe is a safety net rather than the normal path;
* it degrades to the bare schema on an older resolution instead of throwing.
*/
function asVolatile(schema) {
	const candidate = schema;
	return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}
const Config = z.object({
	enabledModelIds: asVolatile(z.array(z.string()).default([])).description("Catalog ids enabled in the DSH model picker. Doubao routes upstream by content, so this selects which entries are offered, never which model answers. Empty means \"not yet configured\" and serves the whole catalog."),
	toolEmulation: asVolatile(z.boolean().default(false)).description("实验性：豆包没有函数调用通道（tools 字段会被静默忽略），此项改用提示词模拟工具调用，让豆包能驱动 Harness 的本地工具。约 11.5 秒/轮，且可能随上游模型变化而退化，故默认关闭。"),
	profileDir: asVolatile(z.string().default("")).description("豆包客户端 User Data 目录。留空表示自动探测：Windows 走 %LOCALAPPDATA%/%APPDATA%/运行中客户端的 --user-data-dir/限时扫盘；macOS 走 ~/Library/Application Support/Doubao(/DoubaoWork) + 登录钥匙串里的 Safe Storage 口令。只有当豆包把数据放在自动探测找不到的位置时才需要填。")
});
/**
* The ticked ids, or `undefined` when the field is ABSENT.
*
* The absent case is what `enabledModelsOf` keys off to mean "never
* configured"; a present-but-empty array is a real (empty) selection.
*/
function enabledIdsOf(config) {
	const value = config?.enabledModelIds;
	if (!Array.isArray(value)) return void 0;
	return value.filter((entry) => typeof entry === "string");
}
/**
* The ids the adapter should filter by, or `undefined` for "serve everything".
*
* Normalises the schemastery default (`[]`, meaning not-yet-configured) into
* the `undefined` that `enabledModelsOf` reads as "serve the whole catalog".
* Without this the default would read as a user who ticked nothing, and a
* first-run install would show an empty model picker.
*/
function effectiveIds(config) {
	const ids = enabledIdsOf(config);
	if (ids === void 0 || ids.length === 0) return void 0;
	return ids;
}
//#endregion
//#region src/doubao-store.ts
/**
* The plugin's OWN settings file.
*
* Why this exists instead of the host settings service.
*
* The Loader hands `apply` a config object and the host can write it back with
* `settings.mutate`, but on DSH 0.2.1 that whole path is closed to THIS plugin
* for a reason we could not fix from the outside: the plugin's fiber never
* reaches ACTIVE (it sits at state 1 = LOADING, next to `hmr`, `credentials` and
* `skill-mcp-manager`), so `entry.fiber.runtime.Config` is never populated.
* `ConfigEditor.entries()` keeps the row, `describe()` filters it out, and
* `mutate()` fails with
*
*   No configurable plugin entry "dsh-connect-doubao"
*
* which the card surfaced as `保存失败：namespace … missing from describe()`.
* The observable consequence is that EVERY settings write for this plugin has
* always been dropped — including the ones a user made by hand — so the switch
* could never persist, whatever the schema said.
*
* Rather than fight a lifecycle we do not control, the two switches live in a
* file this plugin owns. That is strictly more reliable than the host path:
* the write is synchronous, atomic (write-temp-then-rename), and the read does
* not depend on any host service being up.
*
* Precedence: the file WINS over the config the Loader passes in, because the
* file is the only place a write can land. A host config that disagrees is
* ignored on purpose — trusting it would resurrect the silent-revert bug.
*
* @module dsh-connect-doubao/store
*/
/** Absolute path of the settings file. Mirrors where the credential cache lives. */
function settingsFilePath() {
	return join(homedir(), ".dsh", "dsh-connect-doubao.settings.json");
}
/** The subset of a config blob this plugin can persist. */
function normalise(raw) {
	const out = {};
	const ids = enabledIdsOf(raw);
	if (ids !== void 0) out.enabledModelIds = ids;
	const tools = raw?.toolEmulation;
	if (typeof tools === "boolean") out.toolEmulation = tools;
	const profile = raw?.profileDir;
	if (typeof profile === "string") out.profileDir = profile;
	return out;
}
/**
* Read the persisted settings, or `{}` when the file is missing or unusable.
*
* Never throws: a corrupt file must not stop the provider from registering, and
* the caller treats "no file" and "bad file" identically — fall back to what
* the Loader supplied.
*/
function readStoredSettings(path = settingsFilePath()) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	try {
		return normalise(JSON.parse(text));
	} catch {
		return {};
	}
}
/**
* Merge persisted settings over the Loader-supplied config.
*
* Only recognised keys are carried, so a hand-edited file cannot inject an
* unknown field into the live config object.
*/
function withStoredSettings(config, path = settingsFilePath()) {
	const base = {
		enabledModelIds: enabledIdsOf(config) ?? [],
		toolEmulation: config?.toolEmulation === true,
		profileDir: profileDirOf(config) ?? ""
	};
	const stored = readStoredSettings(path);
	return {
		enabledModelIds: stored.enabledModelIds ?? base.enabledModelIds,
		toolEmulation: stored.toolEmulation ?? base.toolEmulation,
		profileDir: stored.profileDir ?? base.profileDir
	};
}
/**
* Persist one field, atomically.
*
* Write-temp-then-rename rather than a direct write: a crash mid-write would
* otherwise leave a truncated JSON file, and `readStoredSettings` would then
* silently fall back to the Loader config — the exact "my setting vanished"
* symptom this module exists to remove.
*/
function writeStoredSetting(field, value, path = settingsFilePath()) {
	if (field !== "enabledModelIds" && field !== "toolEmulation" && field !== "profileDir") throw new Error(`field ${field} is not persistable`);
	const next = { ...readStoredSettings(path) };
	if (field === "enabledModelIds") {
		if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`invalid value for ${field}`);
		next.enabledModelIds = value.filter((entry) => typeof entry === "string");
	} else if (field === "toolEmulation") {
		if (typeof value !== "boolean") throw new Error(`invalid value for ${field}`);
		next.toolEmulation = value;
	} else {
		if (typeof value !== "string") throw new Error(`invalid value for ${field}`);
		next.profileDir = value;
	}
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid.toString()}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
		renameSync(temp, path);
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {}
		throw error;
	}
}
//#endregion
//#region src/index.ts
/**
* DSH Connect Doubao — plugin entrypoint.
*
* Assembles three pieces and hands them to the Harness LLM seam:
*
*   createDoubaoShim()         loopback HTTP surface + Doubao dialect
*   createDoubaoAdapter()      pi-ai provider registered into ctx.llm
*   registerDoubaoQuotaRoute   read-only quota view for the settings card
*
* The model catalog is STATIC and REAL: Doubao accepts an explicit
* `model_item_key`, so selecting an entry genuinely selects that model. See
* `doubao-catalog.ts` for the four verified keys and the reasoning-effort axis.
*
* 参考：dsh-connect-workbuddy 的 provider 注册链路（adapter + 可配置 provider +
*   模型发现 + webServer 只读路由），结构参照其做法。
*
* @module dsh-connect-doubao
*/
const PLUGIN_ID = "dsh-connect-doubao";
const PLUGIN_NAME = "DSH Connect Doubao";
/**
* Diagnostic trail for the settings-presentation registration.
*
* `settings.configure()` is what makes this plugin a settings namespace, and it
* can fail in four completely different places without raising: the inject
* child never runs (no `settings` service), `ctx.effect` never runs, the call
* itself throws, or it succeeds and the host still does not list us. Those look
* identical from the outside — a missing namespace — so each step records
* whether it was reached and the save route reports the trail.
*/
const presentationDiag = {};
/**
* The plugin's Cordis name — the value the Loader and the Settings service key
* on. It must be the ENTRY ID, not a human-readable title.
*
* Two working siblings prove the rule: `dsh-connect-trae` and
* `dsh-connect-workbuddy` both export `name === their entry id`, and both have
* a namespace in `settings.describe()`. This plugin exported
* `'DSH Connect Doubao'`, and its namespace was the ONE absent from a 28-entry
* `describe()` list even though it calls `settings.configure()` exactly like
* they do. A display title is not an identifier; the settings row never existed
* because nothing registered under that name.
*/
const name = PLUGIN_ID;
/**
* Settings namespace for this provider's configurable entry.
*
* DEPRECATED as a name to use: the Host resolves a provider's namespace by
* EXACT match against the Loader entry id, which a profile chooses. Use
* {@link settingsNamespaceOf}, which reads the entry the Loader actually made.
* Kept as a documented fallback for hosts that expose no entry id.
*/
const DOUBAO_SETTINGS_NS = "llm:doubao";
/**
* A bare `apply` export (not a `plugin = { ... }` object): the Loader reads
* `name` / `inject` / `Config` / `apply` as named exports of the entry module.
* `name` is exported above, next to PLUGIN_ID, which is what it must equal.
*/
/**
* Services required before the provider may register.
*
* `inject: ['llm']` is REQUIRED, not decorative. Cordis only exposes a service
* to a plugin that declared it, and touching `ctx.llm` without the declaration
* throws `cannot get property "llm" without inject` from inside `apply()` — which
* takes the whole plugin down silently: no provider, no quota route, and only a
* log line to show for it. Verified against a real DSH 0.2.0-rc.2 host (M5-B).
*
* `webServer` is deliberately NOT listed: it mounts later, and on Desktop it may
* never appear, so listing it would hold the entire plugin back forever. The
* quota route waits on a NESTED `ctx.inject(['webServer'], ...)` instead.
*
* `settings` is a soft probe (`ctx.get`), not an inject entry: the settings
* surface differs by host line, and Cordis' gate is hard enough that naming a
* service this host does not provide stops `apply` from ever running.
*/
const inject = ["llm"];
/**
* The namespace the HOST actually serves this plugin's config under.
*
* The Host resolves a provider's namespace by EXACT match, and the namespace it
* serves is the Loader entry id — which a profile may mount as
* `dsh-connect-doubao` or, as the live Desktop host does, as an include. A
* guessed name that misses makes the config entry read as unconfigured and the
* model's settings disappear. So ask the Loader entry, with the declared id as
* the documented fallback.
*/
function settingsNamespaceOf(ctx) {
	return (ctx.fiber?.entry)?.options?.id ?? "dsh-connect-doubao";
}
/**
* Wire the provider and the read-only routes.
*
* `apply` wires every disposer into one `ctx.effect`, so unloading the plugin
* releases the shim's port, the adapter, the directory entry, the discovery
* callback and the HTTP routes — nothing outlives the plugin.
*/
function apply(ctx, config = {
	enabledModelIds: [],
	toolEmulation: false,
	profileDir: ""
}) {
	let shim;
	let adapterRelease;
	let directoryRelease;
	let discoveryRelease;
	const settingsNs = settingsNamespaceOf(ctx);
	/**
	* Live config, replaced on every settings write.
	*
	* Seeded from the plugin's OWN file, which wins over the Loader config: on
	* this host line the fiber never reaches ACTIVE, so the Loader can neither
	* expose nor accept a settings write for this plugin (`No configurable plugin
	* entry "dsh-connect-doubao"`, measured 2026-11-02). The file is the only
	* place a save can land, which is why it takes precedence — trusting the
	* Loader value would resurrect the silent-revert bug for any user who ever
	* saved a switch.
	*/
	let current = withStoredSettings(config);
	setProfileOverride(profileDirOf(current));
	try {
		shim = createDoubaoShim({ toolEmulation: () => toolEmulationOf(current) });
		const { adapter, invalidate, setEnabledModelIds } = createDoubaoAdapter({
			shim,
			enabledModelIds: effectiveIds(config),
			modelsProvider: liveModels
		});
		adapterRelease = ctx.llm.registerAdapter([DOUBAO_PROVIDER], adapter);
		directoryRelease = ctx.llm.registerConfigurableProviders([{
			provider: DOUBAO_PROVIDER,
			displayName: DOUBAO_PROVIDER_DISPLAY_NAME,
			settingsNs,
			settingsPath: [],
			declared: false
		}]);
		ctx.effect(() => () => {
			adapterRelease?.();
			directoryRelease?.();
			discoveryRelease?.();
			shim?.close();
			shim = void 0;
		});
		invalidate();
		try {
			discoveryRelease = ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
				if (request.provider !== void 0 && request.provider !== "doubao") return [];
				return enabledModelsOf(effectiveIds(current), liveModels()).map((model) => ({
					id: model.id,
					name: model.name,
					contextWindow: DOUBAO_CONTEXT_WINDOW,
					maxTokens: DOUBAO_MAX_TOKENS,
					inputModalities: ["text"]
				}));
			});
		} catch (error) {
			ctx.logger.error("dsh-connect-doubao: model discovery registration failed", error);
		}
		/**
		* Settings presentation, via a NESTED `ctx.inject(['settings'], ...)`.
		*
		* This used to be a soft `ctx.get('settings')` probe at apply time, and that
		* is why this plugin's settings row never existed: `apply` can run BEFORE
		* the settings service is mounted, so the probe returned `undefined` and
		* `configure()` was simply never called — no error, no retry, and the
		* namespace stayed absent from `settings.describe()` while
		* `dsh-connect-trae` and `dsh-connect-workbuddy` were both listed.
		*
		* Both working siblings use an inject child for exactly this reason: the
		* child is held back until the service exists, and re-runs if it is replaced.
		* The soft probe stays only as the fallback for hosts that never provide
		* `settings` at all (that is also why `settings` is not in the top-level
		* `inject`, which would stop `apply` from running entirely).
		*/
		const presentationOwner = ctx.fiber;
		try {
			if (typeof ctx.inject === "function") {
				ctx.inject(["settings"], (settingsCtx) => {
					const child = settingsCtx;
					presentationDiag.injectRan = true;
					presentationDiag.hasSettings = child.settings !== void 0;
					presentationDiag.hasFiber = presentationOwner !== void 0;
					presentationDiag.fiberEntryId = String(presentationOwner?.entry?.options?.id);
					presentationDiag.settingsNs = settingsNs;
					const settings = child.settings;
					if (settings === void 0 || typeof settings.configure !== "function") return;
					const claim = () => {
						presentationDiag.effectRan = true;
						const dispose = settings.configure({ auto: false }, presentationOwner);
						presentationDiag.configureRan = true;
						return dispose;
					};
					if (typeof child.effect === "function") child.effect.call(settingsCtx, claim);
					else claim();
				});
				ctx.inject(["configEditor"], (editorCtx) => {
					try {
						const editor = editorCtx;
						const rows = typeof editor.configEditor?.entries === "function" ? editor.configEditor.entries() : void 0;
						if (rows === void 0) {
							presentationDiag.editorError = "configEditor present but no entries()";
							return;
						}
						presentationDiag.editorEntries = rows.map((row) => {
							const config = (row.fiber?.runtime)?.Config;
							const ours = String(row.options?.id) === "dsh-connect-doubao" ? ":ours" : "";
							return `${String(row.options?.id)}@${String(row.fiber?.state)}${config === void 0 ? ":noschema" : ":schema"}${ours}`;
						});
					} catch (error) {
						presentationDiag.editorError = error?.message ?? String(error);
					}
				});
			}
		} catch (error) {
			presentationDiag.error = error?.message ?? String(error);
			ctx.logger.error("dsh-connect-doubao: settings presentation registration failed", error);
		}
		const onSettingsChanged = (next) => {
			if (next !== void 0) current = next;
			setEnabledModelIds(effectiveIds(current));
			invalidate();
		};
		try {
			ctx.on("loader/volatile-update", onSettingsChanged);
		} catch {}
		ctx.inject(["webServer"], (webCtx) => {
			try {
				const disposeQuota = registerDoubaoQuotaRoute(webCtx);
				const disposeCatalog = registerDoubaoCatalogRoute(webCtx, { modelsProvider: liveModels });
				const disposeProfile = registerDoubaoProfileRoute(webCtx, { candidates: () => listDoubaoProfiles().map((entry) => ({
					dir: entry.dir,
					source: entry.source
				})) });
				const disposeSave = registerDoubaoSaveRoute({ webServer: webCtx.webServer }, {
					write: (field, value) => {
						writeStoredSetting(field, value);
					},
					read: () => readStoredSettings(),
					diagnostics: () => ({
						...presentationDiag,
						pluginName: name
					}),
					onApplied: (field, value) => {
						const next = { ...current };
						if (field === "enabledModelIds" && Array.isArray(value)) next.enabledModelIds = value.filter((id) => typeof id === "string");
						else if (field === "toolEmulation" && typeof value === "boolean") next.toolEmulation = value;
						else if (field === "profileDir" && typeof value === "string") {
							next.profileDir = value;
							setProfileOverride(value);
							invalidateCredentialCache();
							invalidateQuotaCache();
						}
						onSettingsChanged(next);
					}
				});
				ctx.effect(() => () => {
					disposeQuota();
					disposeCatalog();
					disposeProfile();
					disposeSave();
				});
			} catch (error) {
				ctx.logger.error("dsh-connect-doubao: web route registration failed", error);
			}
		});
	} catch (error) {
		ctx.logger.error("dsh-connect-doubao: provider registration failed", error);
		adapterRelease?.();
		directoryRelease?.();
		discoveryRelease?.();
		shim?.close();
		shim = void 0;
	}
}
var src_default = {
	name,
	inject,
	apply
};
//#endregion
export { ACCOUNT_ENDPOINT, CHAT_AGENT_MODE, CHAT_ENDPOINT, CLIENT_PARAMS, CREATION_BLOCK_TYPE, CREDENTIAL_TTL_MS, Config, DEEP_THINK_OFF, DEEP_THINK_ON, DEFAULT_BOT_ID, DEFAULT_REASONING_LEVEL_ID, DISCOVERY_TTL_MS, DOUBAO_CATALOG_PATH, DOUBAO_CONTEXT_WINDOW, DOUBAO_DEFAULT_MODEL_ID, DOUBAO_ERROR_HINTS, DOUBAO_IMAGE_MODEL_ID, DOUBAO_IMAGE_MODEL_NAME, DOUBAO_MAX_TOKENS, DOUBAO_MODELS, DOUBAO_PROVIDER, DOUBAO_PROVIDER_DISPLAY_NAME, DOUBAO_QUOTA_PATH, DOUBAO_REASONING_LEVELS, DOUBAO_SAVE_PATH, DOUBAO_SETTINGS_NS, DOUBAO_SKILLS, DOUBAO_STREAM_IDLE_TIMEOUT_MS, DOUBAO_UNAVAILABLE_MODELS, DOUBAO_VERSION, DoubaoUpstreamError, ENABLED_MODEL_IDS_FIELD, PLUGIN_ID, PLUGIN_NAME, PROFILE_DIR_FIELD, PROFILE_ENV, QUOTA_ENDPOINT, QUOTA_TTL_MS, REQUIRED_COOKIE_NAMES, RUNTIME_VERSION, SKILL_CARRIER_MODEL_ID, TASK_AGENT_MODE, TASK_RUNTIME_CLOUD_VM, TASK_RUNTIME_LOCAL_PC, TASK_SANDBOX_AUTH_ALLOW_ALL, TOOL_EMULATION_FIELD, apply, applyRenewals, assembleReplyText, buildChatBody, buildGeneralTaskParam, buildHeaders, buildQueryUrl, chat, classifyDoubaoFailure, collectBlocks, createDoubaoAdapter, createDoubaoShim, decodeCookiePlaintext, decryptCookieValue, src_default as default, describeDoubaoFailure, describeProfileLocation, discoverAllCachedModels, discoverDoubaoModels, discoverModels, doubaoCatalogEntries, doubaoQuotaView, effectiveIds, enabledIdsOf, enabledModelsOf, extractModel, extractUserDataDir, fetchQuota, findDoubaoModel, findDoubaoUserDataDir, findReasoningLevel, findWindow, formatDuration, inject, inputSkillOf, invalidateCredentialCache, invalidateDiscovery, invalidateQuotaCache, invalidateRenewals, isConfigured, listDoubaoProfiles, liveModels, loadDoubaoCredentials, looksLikeProfile, millisUntilReset, name, needDeepThinkValue, normalizeWindow, parseFrames, presentationDiag, probeAccount, profileDirOf, registerDoubaoCatalogRoute, registerDoubaoQuotaRoute, registerDoubaoSaveRoute, resolveUserProvided, setProfileOverride, settingsNamespaceOf, streamChat, taskModeEnabled, taskWorkspaceOf, toolEmulationOf };
