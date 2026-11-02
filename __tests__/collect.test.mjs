import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeConversation, normalizeMessage, readDeviceIdentity } from "../lib/collect.js";

test("normalizeConversation 只保留面板字段，缺 id 直接丢", () => {
  assert.equal(normalizeConversation({}), undefined);
  assert.equal(normalizeConversation(null), undefined);
  const c = normalizeConversation({ conversation_id: 42, name: "A", conversation_type: 3, update_time: "1793", badge_count: 2 });
  assert.deepEqual(c, { id: "42", title: "A", kind: 3, updatedAt: "1793", messageCount: 0, unread: 2, lastSectionId: "", iconUrl: "" });
});

test("normalizeMessage 取 content_block 的文本", () => {
  const msg = normalizeMessage({ message_id: "m1", user_type: 1, create_time: "17", content_block: [{ block_type: 10000, content: { text_block: { text: "你好" } } }] });
  assert.equal(msg.text, "你好");
  assert.equal(msg.role, "user");
  assert.equal(msg.createTime, 17);
});

test("normalizeMessage：content_block 缺失时回退到字符串化 content", () => {
  const msg = normalizeMessage({ user_type: 2, content: JSON.stringify([{ block_type: 10000, content: { text_block: { text: "收到" } } }]) });
  assert.equal(msg.text, "收到");
  assert.equal(msg.role, "assistant");
});

test("normalizeMessage 把非文本块留在 attachments 里", () => {
  const msg = normalizeMessage({ user_type: 1, content_block: [{ block_type: 10000, content: { text_block: { text: "看图" } } }, { block_type: 10052, file_name: "a.png", url: "https://x/a.png" }] });
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].name, "a.png");
});

test("normalizeMessage 超长文本截断到 8000", () => {
  const msg = normalizeMessage({ content_block: [{ content: { text_block: { text: "x".repeat(9000) } } }] });
  assert.equal(msg.text.length, 8001);
});

test("readDeviceIdentity 用 BigInt 还原 int64 device_id", async () => {
  const id = await readDeviceIdentity("/Users/xinna/Library/Application Support/Doubao");
  if (id.deviceId !== "") assert.match(id.deviceId, /^\d+$/);
});
