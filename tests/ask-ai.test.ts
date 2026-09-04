import assert from "node:assert/strict";
import test from "node:test";
import {
  askAiCanSkip,
  buildAskAiPending,
  type AskAiRemembered,
} from "../src/ask-ai.ts";

const file = {
  path: "/p/papers/a.pdf",
  name: "a.pdf",
  cwd: "/p",
  root: "/p",
  reuseKey: "lit:/p:papers/a.pdf",
};

test("问 AI 记住且勾了默认、配置还在才跳过选择", () => {
  const r: AskAiRemembered = {
    agentId: "codex",
    profileId: "p1",
    model: "gpt-5.1",
    useDefault: true,
  };
  assert.equal(askAiCanSkip(r, [{ id: "p1" }]), true);
  assert.equal(askAiCanSkip(r, [{ id: "other" }]), false);
  assert.equal(askAiCanSkip({ ...r, useDefault: false }, [{ id: "p1" }]), false);
  assert.equal(askAiCanSkip(null, [{ id: "p1" }]), false);
});

test("问 AI 交接：带上选择、不进聊天层、打开预览", () => {
  const pt = buildAskAiPending(file, {
    agentId: "codex",
    profileId: "official-1",
    model: "",
  });
  assert.equal(pt.agentId, "codex");
  assert.equal(pt.profileId, "official-1");
  assert.equal(pt.model, "");
  assert.equal(pt.autoStart, true);
  assert.equal(pt.surface, undefined);
  assert.equal(pt.previewPath, "/p/papers/a.pdf");
  assert.equal(pt.previewRoot, "/p");
  assert.match(pt.initialPrompt ?? "", /请看这份文件/);
});

test("问 AI 可覆盖 prompt，项目级新对话不预览、不预填", () => {
  const custom = buildAskAiPending(
    { ...file, prompt: "请分析这份表格" },
    { agentId: "codex", profileId: "p1", model: "" },
  );
  assert.equal(custom.initialPrompt, "请分析这份表格");
  assert.equal(custom.previewPath, "/p/papers/a.pdf");
  const fresh = buildAskAiPending(
    {
      path: "",
      name: "AI模型",
      cwd: "/p",
      root: "/p",
      reuseKey: "office:/p:project",
      prompt: "",
      preview: false,
    },
    { agentId: "codex", profileId: "p1", model: "" },
  );
  assert.equal(fresh.initialPrompt, undefined);
  assert.equal(fresh.previewPath, undefined);
  assert.equal(fresh.previewRoot, undefined);
  assert.equal(fresh.title, "AI模型");
});
