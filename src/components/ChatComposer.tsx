import { useEffect, useRef, useState } from "react";
import type { McpServerDto, SkillDto } from "../types";

function ResourceMenu({
  kind,
  skills,
  mcps,
  disabled,
  onInsert,
  onOpenMcp,
}: {
  kind: "skill" | "mcp";
  skills: SkillDto[];
  mcps: McpServerDto[];
  disabled: boolean;
  onInsert: (text: string) => void;
  onOpenMcp?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isSkill = kind === "skill";
  const items = isSkill ? skills : mcps;
  const label = isSkill
    ? `◈ 技能${skills.length ? ` · ${skills.length}` : ""}`
    : `⌗ MCP${mcps.length ? ` · ${mcps.length}` : ""}`;

  return (
    <span className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-micro text-l3 transition-colors hover:bg-hover hover:text-l1 disabled:cursor-not-allowed disabled:opacity-40"
        title={isSkill ? "插入一个已启用技能提示" : "插入一个已分发 MCP 提示"}
      >
        {label}
        <span className="text-micro text-l4">⌄</span>
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-label="关闭资源菜单"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border border-field ccode-float-surface">
            <div className="border-b border-hairline px-3 py-2 text-micro text-l3">
              {isSkill ? "插入一个技能提示" : "插入一个 MCP 提示"}
            </div>
            <div className="max-h-56 overflow-auto p-1">
              {items.length === 0 ? (
                <div className="px-2 py-3 text-xs text-l4">
                  {isSkill ? "当前 Agent 没有已启用技能" : "当前 Agent 没有已分发 MCP"}
                </div>
              ) : isSkill ? (
                skills.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onInsert(`使用 ${skill.name} 技能：`);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{skill.name}</span>
                    {skill.description && <span className="truncate text-micro text-l4">{skill.description}</span>}
                  </button>
                ))
              ) : (
                mcps.map((mcp) => (
                  <button
                    key={mcp.id}
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onInsert(`使用 ${mcp.name} 这个 MCP server 提供的工具：`);
                    }}
                    className="flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left hover:bg-hover"
                  >
                    <span className="text-xs text-l1">{mcp.name}</span>
                    <span className="truncate font-mono text-micro text-l4">
                      {mcp.kind === "stdio" ? `${mcp.command} ${mcp.args.join(" ")}` : mcp.url}
                    </span>
                  </button>
                ))
              )}
            </div>
            {!isSkill && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  onOpenMcp?.();
                }}
                className="w-full border-t border-hairline px-3 py-2 text-left text-micro text-l3 hover:bg-hover hover:text-l1"
              >
                管理 MCP 分发 →
              </button>
            )}
          </div>
        </>
      )}
    </span>
  );
}

export default function ChatComposer({
  disabled,
  busy,
  placeholder,
  skills = [],
  mcps = [],
  onSend,
  onOpenMcp,
}: {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  skills?: SkillDto[];
  mcps?: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  onOpenMcp?: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  function insertResourceText(text: string) {
    setError(null);
    setValue((current) => (current ? `${current}\n${text}` : text));
    requestAnimationFrame(() => ref.current?.focus());
  }

  useEffect(() => {
    if (!disabled) ref.current?.focus();
  }, [disabled]);

  async function submit() {
    const text = value.trim();
    if (!text || disabled || busy) return;
    setError(null);
    const err = await onSend(text);
    if (err) {
      setError(err);
      return;
    }
    setValue("");
  }

  return (
    <div className="ccode-chat-composer shrink-0 bg-canvas px-4 pb-4 pt-2.5">
      <div className="mx-auto w-full max-w-3xl">
        <div className="overflow-visible rounded-xl border border-hairline bg-raised transition-colors focus-within:border-l4">
          <textarea
            ref={ref}
            value={value}
            disabled={disabled || busy}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder={placeholder ?? "输入消息…"}
            className="block max-h-40 min-h-16 w-full resize-none bg-transparent px-4 pb-2 pt-3 text-sm leading-6 text-l1 outline-none focus:outline-none focus-visible:outline-none focus-visible:outline-offset-0 placeholder:text-l4 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <div className="flex min-h-10 items-center justify-between gap-2 px-3 pb-1.5">
            <div className="flex min-w-0 items-center gap-0.5">
              <ResourceMenu
                kind="skill"
                skills={skills}
                mcps={mcps}
                disabled={Boolean(disabled || busy || skills.length === 0)}
                onInsert={insertResourceText}
              />
              <ResourceMenu
                kind="mcp"
                skills={skills}
                mcps={mcps}
                disabled={Boolean(disabled || busy)}
                onInsert={insertResourceText}
                onOpenMcp={onOpenMcp}
              />
              <span className="ml-2 truncate text-micro text-l4">
                {error ?? (busy ? "正在发送…" : "Enter 发送 · Shift+Enter 换行")}
              </span>
            </div>
            <button
              type="button"
              disabled={disabled || busy || !value.trim()}
              onClick={() => void submit()}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-cta px-3 text-xs text-cta-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
        <div className="mt-1.5 text-center text-micro text-l4/70">
          当前会话 · 同一上下文
        </div>
      </div>
    </div>
  );
}
