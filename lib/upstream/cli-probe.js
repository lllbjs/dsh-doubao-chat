#!/usr/bin/env node
import { A as probeAccount, V as describeProfileLocation, i as formatDuration, it as DOUBAO_MODELS, j as streamChat, m as DoubaoUpstreamError, n as fetchQuota, o as millisUntilReset, r as findWindow, vt as findDoubaoModel, yt as findReasoningLevel, z as loadDoubaoCredentials } from "./doubao-quota-SO5U9prN.js";
//#region src/cli-probe.ts
/**
* Doubao smoke probe.
*
* Runs one real completion against the Doubao upstream with the Doubao app
* closed, then reports the reply together with both quota windows.
*
*   node lib/cli-probe.js --prompt "hi" --json
*
* This sends exactly one inference request. It never retries: a risk-control
* challenge is reported, not worked around, because retrying an automated call
* against a slider CAPTCHA makes the challenge stricter.
*
* Credentials are read into memory only and are never printed.
*/
function parseArgs(argv) {
	const options = {
		prompt: "hi",
		json: false,
		deepThink: false,
		timeoutMs: 12e4
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--prompt" || arg === "-p") options.prompt = argv[++i] ?? options.prompt;
		else if (arg === "--json") options.json = true;
		else if (arg === "--deep-think") options.deepThink = true;
		else if (arg === "--model" || arg === "-m") options.modelKey = argv[++i] ?? options.modelKey;
		else if (arg === "--thinking" || arg === "-t") {
			const value = argv[++i];
			if (value !== "low" && value !== "mid" && value !== "high") throw new Error(`--thinking expects low|mid|high, got "${value}"`);
			options.reasoningLevel = value;
		} else if (arg === "--timeout") options.timeoutMs = Number(argv[++i]) || options.timeoutMs;
		else if (arg === "--help" || arg === "-h") {
			process.stdout.write(`Usage: cli-probe [--prompt <text>] [--model <key>] [--thinking <low|mid|high>]
                 [--json] [--timeout <ms>]

  --model      one of: ${DOUBAO_MODELS.map((m) => `${m.id} (${m.name})`).join(", ")}\n  --thinking   reasoning effort; default matches the desktop app
`);
			process.exit(0);
		}
	}
	return options;
}
function fmt(value) {
	return typeof value === "string" ? value : JSON.stringify(value);
}
async function main() {
	const options = parseArgs(process.argv.slice(2));
	const out = options.json ? (v) => process.stdout.write(JSON.stringify(v, null, 2) + "\n") : (v) => process.stdout.write(fmt(v) + "\n");
	const credentials = loadDoubaoCredentials();
	if (!credentials.ok) {
		out(options.json ? {
			ok: false,
			stage: "credentials",
			error: credentials.reason
		} : `FAIL credentials: ${credentials.reason}`);
		return 2;
	}
	out(options.json ? {
		event: "credentials",
		ok: true,
		cookieCount: credentials.pairs.size,
		profile: describeProfileLocation()
	} : `credentials: ${credentials.pairs.size} cookies from ${describeProfileLocation()}`);
	const account = await probeAccount(credentials);
	out(options.json ? {
		event: "account",
		...account
	} : `account: ${account.ok ? "signed in" : account.detail}`);
	if (!account.ok) {
		out(options.json ? {
			ok: false,
			stage: "account",
			error: account.detail
		} : `FAIL account: ${account.detail}`);
		return 3;
	}
	const quota = await fetchQuota({ force: true });
	const fiveHour = findWindow(quota, "five_hour");
	const weekly = findWindow(quota, "weekly");
	out(options.json ? {
		event: "quota",
		plan: quota.plan ?? null,
		planActive: quota.planActive ?? null,
		exhausted: quota.exhausted,
		fiveHour: fiveHour ? {
			usedPercent: fiveHour.usedPercent,
			remainingPercent: fiveHour.remainingPercent,
			resetsIn: formatDuration(millisUntilReset(fiveHour))
		} : null,
		weekly: weekly ? {
			usedPercent: weekly.usedPercent,
			remainingPercent: weekly.remainingPercent,
			resetsIn: formatDuration(millisUntilReset(weekly))
		} : null,
		error: quota.error ?? null
	} : [
		`quota: ${quota.plan ?? "unknown plan"}${quota.planActive === false ? " (inactive)" : ""}`,
		`  5-hour limit : ${fiveHour ? `${fiveHour.usedPercent}% used, resets in ${formatDuration(millisUntilReset(fiveHour))}` : "n/a"}`,
		`  weekly quota : ${weekly ? `${weekly.usedPercent}% used, resets in ${formatDuration(millisUntilReset(weekly))}` : "n/a"}`
	].join("\n"));
	if (quota.exhausted) {
		out(options.json ? {
			ok: false,
			stage: "quota",
			error: "quota exhausted"
		} : "FAIL quota exhausted; no request sent");
		return 4;
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	const requestedModel = findDoubaoModel(options.modelKey);
	const requestedLevel = findReasoningLevel(options.reasoningLevel);
	out(options.json ? {
		event: "request",
		model_item_key: requestedModel.id,
		model_name: requestedModel.name,
		reasoning_effort: requestedLevel.level,
		reasoning_level: requestedLevel.id,
		reasoning_verified: requestedLevel.verified
	} : `requesting: model=${requestedModel.id} (${requestedModel.name})  thinking=${requestedLevel.name}${requestedLevel.verified ? "" : " [unverified]"}`);
	try {
		const result = await streamChat(options.prompt, {
			...options.modelKey === void 0 ? {} : { modelKey: options.modelKey },
			...options.reasoningLevel === void 0 ? {} : { reasoningLevel: options.reasoningLevel },
			signal: controller.signal,
			credentials,
			callbacks: { onEvent: (event) => {
				if (!options.json) process.stderr.write(`  event ${event}\n`);
			} }
		});
		out(options.json ? {
			event: "completion",
			ok: true,
			prompt: options.prompt,
			requested_model: requestedModel.id,
			reported_model_tag: result.model ?? null,
			reasoning_effort: requestedLevel.level,
			thinking: result.thinking,
			conversationId: result.conversationId ?? null,
			messageId: result.messageId ?? null,
			text: result.text
		} : [
			"",
			"--- completion ---",
			`requested: ${requestedModel.id} (${requestedModel.name})`,
			`server tag: ${result.model ?? "not reported"}`,
			`thinking : ${result.thinking} (effort ${requestedLevel.level}${requestedLevel.verified ? "" : ", unverified"})`,
			`reply    : ${result.text}`
		].join("\n"));
		return 0;
	} catch (error) {
		if (error instanceof DoubaoUpstreamError) {
			out(options.json ? {
				ok: false,
				stage: "completion",
				code: error.code ?? null,
				rateLimited: error.rateLimited,
				error: error.message
			} : `FAIL completion${error.code ? ` [${error.code}]` : ""}: ${error.message}`);
			return error.rateLimited ? 5 : 1;
		}
		out(options.json ? {
			ok: false,
			stage: "completion",
			error: error.message
		} : `FAIL completion: ${error.message}`);
		return 1;
	} finally {
		clearTimeout(timer);
	}
}
process.stdout.setDefaultEncoding("utf8");
if (process.argv[1] && /cli-probe\.(js|ts|mjs)$/.test(process.argv[1])) main().then((code) => {
	process.exitCode = code;
}, (error) => {
	process.stderr.write(`probe crashed: ${error.message}\n`);
	process.exitCode = 1;
});
//#endregion
export { main };
