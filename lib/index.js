/**
* `dsh-doubao-chat` —— 在上游豆包 provider 之上加「会话浏览」。
*
* 这个文件只做装配：把上游插件原样再导出（模型 provider、额度卡片、设置项都还在），
* 然后覆盖 `apply`，在同一个 fiber 里额外挂我们的路由与面板。
*
* 为什么用「重新导出 + 覆盖 apply」而不是 fork 一份 index：
*   上游的 provider 装配、模型目录、SSE 解析全在 `apply` 里，复制一份会在上游
*   升级时无声漂移；这里只在它之前/之后加自己的钩子。
*/
import { apply as applyUpstream, Config, name as upstreamName } from "./upstream/index.js";
import { applyChat } from "./chat-plugin.js";

export * from "./upstream/index.js";

export { Config };

/** 插件在 Loader 里登记的名字。 */
export const name = "dsh-doubao-chat";

/** 与上游相同的服务依赖（`llm` 是 provider 装配的前置）。 */
export const inject = ["llm"];

/**
* 先跑上游 `apply`，再挂会话浏览。
*
* 顺序有讲究：上游 `apply` 会在失败时把 provider 撤掉，但**永远不应该**连带让
* 会话浏览不可用——读消息和发消息是两条独立链路。所以上游抛错只记日志。
*/
export function apply(ctx, config) {
	try {
		applyUpstream(ctx, config);
	} catch (error) {
		ctx.logger?.error?.(`${upstreamName}: upstream apply failed`, error);
	}
	return applyChat(ctx, config);
}

export default {
	name,
	inject,
	apply,
	Config
};
