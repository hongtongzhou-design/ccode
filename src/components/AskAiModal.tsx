import { useEffect, useMemo, useState } from "react";
import {
  Checkbox,
  fieldClass,
  primaryActionClass,
  secondaryActionClass,
} from "./PageFrame";
import { useAppStore } from "../store";
import { AGENTS } from "../types";
import { officialModelAllowed } from "../model-switch";
import {
  loadAskAiRemembered,
  saveAskAiRemembered,
  askAiCanSkip,
  buildAskAiPending,
  type AskAiFile,
} from "../ask-ai";
import { projectChatReuseKey } from "../work-mode";

export function beginAskAi(
  file: AskAiFile,
  opts?: { forcePick?: boolean },
): void {
  const { profiles, setAskAiReq, setPendingTerminal, setPage } =
    useAppStore.getState();
  const remembered = loadAskAiRemembered();
  if (!opts?.forcePick && askAiCanSkip(remembered, profiles)) {
    setPendingTerminal(buildAskAiPending(file, remembered!));
    setPage("terminal");
    return;
  }
  setAskAiReq(file);
}

/** 项目侧栏「＋ 新对话」：在项目根开聊，不预览文件。⌘/Ctrl 点可重选配置。 */
export function beginProjectChat(
  input: {
    cwd: string;
    name: string;
    kind: "office" | "coding" | "research";
  },
  opts?: { forcePick?: boolean },
): void {
  beginAskAi(
    {
      path: "",
      name: input.name,
      cwd: input.cwd,
      root: input.cwd,
      reuseKey: projectChatReuseKey(input.kind, input.cwd),
      prompt: "",
      preview: false,
    },
    opts,
  );
}

export default function AskAiModal() {
  const req = useAppStore((s) => s.askAiReq);
  const setAskAiReq = useAppStore((s) => s.setAskAiReq);
  const profiles = useAppStore((s) => s.profiles);
  const agents = useAppStore((s) => s.agents);
  const setPendingTerminal = useAppStore((s) => s.setPendingTerminal);
  const setPage = useAppStore((s) => s.setPage);

  const remembered = useMemo(loadAskAiRemembered, [req]);
  const installed = useMemo(
    () => new Set(agents.filter((a) => a.binaryPath).map((a) => a.id)),
    [agents],
  );
  const agentOptions = useMemo(
    () =>
      [...AGENTS].sort(
        (a, b) => Number(installed.has(b.id)) - Number(installed.has(a.id)),
      ),
    [installed],
  );

  const [agentId, setAgentId] = useState(
    () => remembered?.agentId ?? agentOptions[0]?.id ?? "claude-code",
  );
  const agentProfiles = profiles.filter((p) => p.agent === agentId);
  const [profileId, setProfileId] = useState(() => remembered?.profileId ?? "");
  const [model, setModel] = useState(() => remembered?.model ?? "");
  const [useDefault, setUseDefault] = useState(
    () => remembered?.useDefault ?? false,
  );

  useEffect(() => {
    if (!req) return;
    const r = loadAskAiRemembered();
    const nextAgent = r?.agentId ?? agentOptions[0]?.id ?? "claude-code";
    setAgentId(nextAgent);
    const list = profiles.filter((p) => p.agent === nextAgent);
    const nextProfile =
      (r?.profileId && list.some((p) => p.id === r.profileId)
        ? r.profileId
        : list[0]?.id) ?? "";
    setProfileId(nextProfile);
    setModel(r?.model ?? "");
    setUseDefault(r?.useDefault ?? false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  useEffect(() => {
    if (!agentProfiles.some((p) => p.id === profileId))
      setProfileId(agentProfiles[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, profiles]);

  const selected = agentProfiles.find((p) => p.id === profileId);
  const official = selected?.accountType === "official";

  useEffect(() => {
    if (!selected) return;
    if (official && !officialModelAllowed(agentId, model)) {
      setModel(selected.models[0] ?? "");
    } else if (
      selected.models.length > 0 &&
      model &&
      !selected.models.includes(model)
    ) {
      setModel(selected.models[0] ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId]);

  if (!req) return null;
  const file = req;

  function close() {
    setAskAiReq(null);
  }

  function start() {
    if (!profileId) return;
    const choice = { agentId, profileId, model: model.trim() };
    saveAskAiRemembered({ ...choice, useDefault });
    setPendingTerminal(buildAskAiPending(file, choice));
    setPage("terminal");
    close();
  }

  return (
    <div
      className="ccode-fade fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={close}
    >
      <div
        className="w-[26rem] rounded-lg border border-field p-4 ccode-float-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-sm font-medium text-l1">问 AI</h2>
        <p className="mb-3 text-micro text-l4">
          {file.path.trim()
            ? "选 Agent 和配置再开。默认落在终端，右边打开这份文件。"
            : "选 Agent 和配置再开。默认落在终端。"}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            start();
          }}
        >
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-l3">Agent</span>
            <select
              className={fieldClass}
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                setModel("");
              }}
            >
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                  {installed.has(a.id) ? "" : "（未检测到）"}
                </option>
              ))}
            </select>
          </label>
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-l3">配置</span>
            <select
              className={fieldClass}
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
            >
              {agentProfiles.length === 0 ? (
                <option value="">该 agent 还没有配置</option>
              ) : (
                agentProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.accountType === "official" ? "（官方账号）" : ""}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="mb-3 block">
            <span className="mb-1 block text-xs text-l3">模型</span>
            <input
              className={fieldClass}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={
                official
                  ? "官方账号可留空，用 CLI 默认"
                  : selected?.models[0] || "可选"
              }
              list="ask-ai-models"
            />
            <datalist id="ask-ai-models">
              {(selected?.models ?? []).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <Checkbox
            className="mb-3 text-xs text-l3"
            checked={useDefault}
            onChange={setUseDefault}
            label="设为默认，下次问 AI 直接用这套"
          />
          <p className="mb-3 text-micro text-l4">
            以后要重选，按 ⌘ / Ctrl 再点「问 AI」。
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              className={secondaryActionClass}
              onClick={close}
            >
              取消
            </button>
            <button
              type="submit"
              className={primaryActionClass}
              disabled={!profileId}
              autoFocus
            >
              开始
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
