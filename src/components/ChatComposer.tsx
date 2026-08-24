import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { McpServerDto, SkillDto } from "../types";
import { firstImageItem, imageExtFromMime } from "../terminal-input";
import {
  filterSlashCommands,
  slashCommandsFor,
  slashQueryOf,
} from "../slash-commands";

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
  focusWhen = true,
  agentId,
}: {
  disabled?: boolean;
  busy?: boolean;
  placeholder?: string;
  skills?: SkillDto[];
  mcps?: McpServerDto[];
  onSend: (text: string) => Promise<string | null>;
  onOpenMcp?: () => void;
  /** 聊天层常驻挂载仅隐藏后，可见性翻转时重新聚焦输入框（替代挂载期一次性 autofocus） */
  focusWhen?: boolean;
  /** 当前 agent id：斜杠命令面板按 agent 出命令清单 */
  agentId?: string | null;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 图片附件（缩略卡）：粘贴的图片经 save_clipboard_image 落盘后按路径随消息发送，
  // url 是本地 object URL 只用于输入框里的预览缩略图
  const [attachments, setAttachments] = useState<
    { path: string; url: string }[]
  >([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  // 卸载时回收所有 object URL
  useEffect(
    () => () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.url));
    },
    [],
  );

  function removeAttachment(path: string) {
    setAttachments((cur) => {
      const hit = cur.find((a) => a.path === path);
      if (hit) URL.revokeObjectURL(hit.url);
      return cur.filter((a) => a.path !== path);
    });
  }

  /** 剪贴板图片落盘（与终端粘贴同一通道 save_clipboard_image）→ 附件卡 */
  async function addImageAttachment(file: File) {
    try {
      const buf = await file.arrayBuffer();
      const path = await invoke<string>("save_clipboard_image", {
        bytes: Array.from(new Uint8Array(buf)),
        ext: imageExtFromMime(file.type),
      });
      setAttachments((cur) => [
        ...cur,
        { path, url: URL.createObjectURL(file) },
      ]);
      setError(null);
    } catch (reason) {
      setError(`粘贴图片失败：${String(reason)}`);
    }
  }

  function insertResourceText(text: string) {
    setError(null);
    setValue((current) => (current ? `${current}\n${text}` : text));
    requestAnimationFrame(() => ref.current?.focus());
  }

  useEffect(() => {
    if (!disabled && focusWhen) ref.current?.focus();
  }, [disabled, focusWhen]);

  // 发送清空后把自动增高复位（onChange 不会因 setValue("") 触发）
  useEffect(() => {
    const el = ref.current;
    if (el && value === "") el.style.height = "";
  }, [value]);

  async function submit(override?: string) {
    const text = (override ?? value).trim();
    if ((!text && attachments.length === 0) || disabled || busy) return;
    setError(null);
    // 图片附件按绝对路径追加在正文后（一行一个）：路径文本是九家 CLI 通吃的图片输入方式，
    // 会话文件记下这行路径，回放/聊天层据此渲染内嵌图片卡
    const payload = [text, ...attachments.map((a) => a.path)]
      .filter(Boolean)
      .join("\n");
    const err = await onSend(payload);
    if (err) {
      setError(err);
      return;
    }
    setValue("");
    setSlashDismissed(false);
    setAttachments((cur) => {
      cur.forEach((a) => URL.revokeObjectURL(a.url));
      return [];
    });
  }

  // 斜杠命令面板：/ 开头且无空格无换行时弹出；Enter 选中并发送，Tab 仅补全，↑/↓ 移动，Esc 收起
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashQuery = slashDismissed ? null : slashQueryOf(value);
  const slashList =
    slashQuery === null
      ? []
      : filterSlashCommands(slashCommandsFor(agentId), slashQuery);
  const slashActive = Math.min(slashIdx, Math.max(0, slashList.length - 1));

  function pickSlash(cmd: string, send: boolean) {
    setSlashDismissed(true);
    if (send) {
      void submit(cmd);
    } else {
      setValue(`${cmd} `);
      requestAnimationFrame(() => ref.current?.focus());
    }
  }

  return (
    <div className="ccode-chat-composer shrink-0 bg-canvas px-4 pb-4 pt-2.5">
      <div className="mx-auto w-full max-w-4xl">
        <div className="overflow-visible rounded-xl border border-hairline bg-raised transition-colors focus-within:border-l4">
          {/* 斜杠命令面板：/ 开头弹出（命令表是各家 CLI 的保守常用集，见 src/slash-commands.ts） */}
          {slashList.length > 0 && (
            <div className="border-b border-hairline px-1.5 py-1.5">
              {slashList.map((c, i) => (
                <button
                  key={c.cmd}
                  type="button"
                  onMouseEnter={() => setSlashIdx(i)}
                  onClick={() => pickSlash(c.cmd, false)}
                  className={`flex w-full items-baseline gap-2 rounded-sm px-2 py-1 text-left text-xs ${
                    i === slashActive ? "bg-hover text-l1" : "text-l2"
                  }`}
                >
                  <span className="shrink-0 font-mono">{c.cmd}</span>
                  <span className="min-w-0 truncate text-l4">{c.hint}</span>
                </button>
              ))}
              <p className="px-2 pt-1 text-micro text-l4">
                Enter 发送选中命令 · Tab 只补全不发送 · Esc 收起
              </p>
            </div>
          )}
          {/* 图片附件缩略卡（粘贴落盘后展示，× 移除；发送时按路径随消息发出） */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((a) => (
                <span
                  key={a.path}
                  className="relative inline-flex"
                  title={a.path}
                >
                  <img
                    src={a.url}
                    alt={a.path.split(/[\\/]/).pop() ?? "图片"}
                    className="h-14 w-auto rounded-md border border-hairline object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => removeAttachment(a.path)}
                    aria-label="移除图片"
                    className="absolute -right-1.5 -top-1.5 flex size-4 cursor-pointer items-center justify-center rounded-full border border-field bg-raised text-[10px] leading-none text-l3 hover:text-l1"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={ref}
            value={value}
            disabled={disabled || busy}
            onPaste={(e) => {
              // 剪贴板有图片条目则接管粘贴（落盘为附件卡），纯文本走默认粘贴
              const items = Array.from(e.clipboardData?.items ?? []);
              const idx = firstImageItem(items);
              if (idx < 0) return;
              e.preventDefault();
              const file = items[idx].getAsFile();
              if (file) void addImageAttachment(file);
            }}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
              if (slashDismissed) setSlashDismissed(false);
              // 随内容自动增高（max-h-40 封顶，超出内部滚动）
              const el = e.target;
              el.style.height = "0";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              // 输入法组词中按 Enter 是确认候选，不是发送
              if (e.nativeEvent.isComposing) return;
              // 斜杠面板开着时：↑/↓ 移动、Enter 选中并发送、Tab 仅补全、Esc 收起
              if (slashList.length > 0) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const delta = e.key === "ArrowDown" ? 1 : -1;
                  setSlashIdx(
                    (slashActive + delta + slashList.length) % slashList.length,
                  );
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  pickSlash(slashList[slashActive].cmd, true);
                  return;
                }
                if (e.key === "Tab") {
                  e.preventDefault();
                  pickSlash(slashList[slashActive].cmd, false);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setSlashDismissed(true);
                  return;
                }
              }
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
              disabled={
                disabled ||
                busy ||
                (!value.trim() && attachments.length === 0)
              }
              onClick={() => void submit()}
              className="inline-flex h-8 shrink-0 items-center rounded-md bg-cta px-3 text-xs text-cta-text transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "发送中…" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
