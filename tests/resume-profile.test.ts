import { test } from "node:test";
import assert from "node:assert/strict";
import { pickResumeProfile } from "../src/resume-profile.ts";

const api = (id: string, baseUrl = "https://relay.example.com/v1") => ({
  id,
  agent: "codex",
  baseUrl,
});
const official = (id: string) => ({ id, agent: "codex", baseUrl: null });

test("provider=ccode：跳过官方账号型，挑带 Base URL 的配置", () => {
  const profiles = [official("p-official"), api("p-api")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", null);
  assert.equal(pick?.id, "p-api");
});

test("provider=ccode：期望 id 不带 Base URL 时落到首个兼容配置", () => {
  const profiles = [official("p-official"), api("p-api")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", "p-official");
  assert.equal(pick?.id, "p-api");
});

test("provider=ccode：期望 id 兼容时优先用它", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", "p-b");
  assert.equal(pick?.id, "p-b");
});

test("provider 非 ccode（官方/无记录）：维持原顺序，不被过滤", () => {
  const profiles = [official("p-official"), api("p-api")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "openai", null)?.id,
    "p-official",
  );
  assert.equal(pickResumeProfile(profiles, "codex", null, null)?.id, "p-official");
  assert.equal(
    pickResumeProfile(profiles, "codex", undefined, "p-api")?.id,
    "p-api",
  );
});

test("兼容池为空（配置被删过）：回落全池，不拦死", () => {
  const profiles = [official("p-official")];
  const pick = pickResumeProfile(profiles, "codex", "ccode", null);
  assert.equal(pick?.id, "p-official");
});

test("该 agent 没有任何配置：null", () => {
  assert.equal(pickResumeProfile([api("p-a")], "kimi", null, null), null);
  assert.equal(pickResumeProfile([], "codex", "ccode", null), null);
});

test("软停用：自动挑选跳过停用项，wishedId 指向停用项同样跳过", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  // 首个被停用 → 落到下一个
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", null, ["p-a"])?.id,
    "p-b",
  );
  // wishedId 是「上次使用」的记忆而非当下显式选择，指向停用项也跳过
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", "p-a", ["p-a"])?.id,
    "p-b",
  );
  // 停用项与兼容过滤叠加：唯一兼容项被停用 → 回落全池（含停用项）
  assert.equal(
    pickResumeProfile([official("p-official"), api("p-api")], "codex", "ccode", null, [
      "p-api",
    ])?.id,
    "p-api",
  );
});

test("软停用：全被停用时回落含停用项的池，不拦死", () => {
  const profiles = [api("p-a"), api("p-b", "https://other.example.com")];
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", null, ["p-a", "p-b"])?.id,
    "p-a",
  );
  // 回落池里 wishedId 仍被尊重
  assert.equal(
    pickResumeProfile(profiles, "codex", "ccode", "p-b", ["p-a", "p-b"])?.id,
    "p-b",
  );
});
