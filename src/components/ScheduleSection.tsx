import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ContextMenu from "./ContextMenu";
import { confirmDialog } from "./ConfirmDialog";
import { Toggle, fieldClass } from "./PageFrame";
import { useAppStore } from "../store";
import { absTime, relTime } from "../rel-time";
import {
  frequencyLabel,
  schedulesForProject,
  summaryPreview,
} from "../schedule-tasks";
import {
  followSkillName,
  scheduleSkillOptions,
} from "../schedule-skill";
import { AGENTS } from "../types";
import type {
  RunRecordDto,
  ScheduleDto,
  SchedulerRunDonePayload,
  SkillDto,
} from "../types";

const actionBtn =
  "inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-l2 hover:bg-hover hover:text-l1 disabled:opacity-50";

/** 历史条目最多展开显示条数（DTO 保留最近 20 条，行内只看最近几条） */
const HISTORY_PREVIEW = 5;

/** 「＋ 定时巡检」弹层：技能可选（默认 lit-watch 文献监控），任务名默认值跟随技能（手改过不覆盖） */
function CreateScheduleModal({
  projectRoot,
  onClose,
  onCreated,
}: {
  projectRoot: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const profiles = useAppStore((s) => s.profiles);
  const [name, setName] = useState("文献雷达");
  const [skill, setSkill] = useState("lit-watch");
  const [skills, setSkills] = useState<SkillDto[]>([]);
  const [frequency, setFrequency] = useState<"daily" | "weekly">("daily");
  const [weekday, setWeekday] = useState(1);
  const [time, setTime] = useState("09:00");
  const [profileId, setProfileId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 技能库供「技能」下拉（读取失败保持空表，scheduleSkillOptions 兜底 lit-watch）
  useEffect(() => {
    let stale = false;
    invoke<SkillDto[]>("list_skills")
      .then((list) => {
        if (!stale) setSkills(list);
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, []);

  function onSkillChange(next: string) {
    setName((cur) => followSkillName(cur, skill, next, skills));
    setSkill(next);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const [hour, minute] = time.split(":").map((v) => parseInt(v, 10));
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      setError("时间格式不正确");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await invoke<ScheduleDto>("create_schedule", {
        input: {
          name: name.trim() || undefined,
          projectRoot,
          skill,
          frequency,
          weekday: frequency === "weekly" ? weekday : null,
          hour,
          minute,
          profileId: profileId || null,
        },
      });
      onCreated();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 ccode-fade"
      onClick={onClose}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="w-[26rem] rounded-md border border-field ccode-float-surface p-5"
      >
        <h2 className="mb-4 text-base font-semibold text-l1">定时巡检</h2>
        <p className="mb-3 text-xs text-l3">
          按周期在项目目录里无头跑一次所选技能；默认文献监控（lit-watch），新文献追加到
          notes/inbox.md。
        </p>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">技能</span>
          <select
            className={fieldClass}
            value={skill}
            onChange={(e) => onSkillChange(e.target.value)}
          >
            {scheduleSkillOptions(skills).map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-xs text-l3">任务名</span>
          <input
            className={fieldClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="文献雷达"
          />
        </label>
        <div className="mb-3 flex gap-2">
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">周期</span>
            <select
              className={fieldClass}
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as "daily" | "weekly")
              }
            >
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
            </select>
          </label>
          {frequency === "weekly" && (
            <label className="block flex-1 text-sm">
              <span className="mb-1 block text-xs text-l3">星期</span>
              <select
                className={fieldClass}
                value={weekday}
                onChange={(e) => setWeekday(Number(e.target.value))}
              >
                {["一", "二", "三", "四", "五", "六", "日"].map((d, i) => (
                  <option key={d} value={i + 1}>
                    周{d}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="block flex-1 text-sm">
            <span className="mb-1 block text-xs text-l3">时间</span>
            <input
              className={fieldClass}
              type="time"
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        </div>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block text-xs text-l3">运行配置（可选）</span>
          <select
            className={fieldClass}
            value={profileId}
            onChange={(e) => setProfileId(e.target.value)}
          >
            <option value="">自动（跟随默认解析）</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{AGENTS.find((a) => a.id === p.agent)?.label ??
                  p.agent}）
              </option>
            ))}
          </select>
        </label>
        {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-sm px-3 py-1.5 text-sm text-l2 hover:bg-hover"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={busy || !time}
            className="rounded-sm border border-cta-bd bg-cta px-3 py-1.5 text-sm text-cta-text hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </form>
    </div>
  );
}

function RunHistoryItem({ record }: { record: RunRecordDto }) {
  return (
    <li className="flex min-w-0 items-center gap-2 py-1">
      <span
        className={`shrink-0 ${record.status === "ok" ? "text-ok-text" : "text-err-text"}`}
      >
        {record.status === "ok" ? "✓" : "✗"}
      </span>
      <span
        className="shrink-0 text-xs text-l4"
        title={absTime(record.at)}
      >
        {relTime(record.at)}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-xs text-l3"
        title={record.summary}
      >
        {summaryPreview(record) || "（无简报）"}
      </span>
    </li>
  );
}

/**
 * 项目分组内的「◔ 定时任务」区块（scheduler.rs）：只显示 projectRoot 命中本项目的任务。
 * 列表自取自刷：挂载时拉一次，scheduler-run-done 事件（全局通知在 App.tsx 另行监听）到达时重拉。
 */
export default function ScheduleSection({
  projectRoot,
}: {
  projectRoot: string;
}) {
  const [open, setOpen] = useState(false);
  const [schedules, setSchedules] = useState<ScheduleDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 手动「立即跑」中的任务 id：靠 scheduler-run-done 事件清除并触发重拉 */
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(
    null,
  );
  const [historyOpen, setHistoryOpen] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  async function load() {
    try {
      setSchedules(
        schedulesForProject(
          await invoke<ScheduleDto[]>("list_schedules"),
          projectRoot,
        ),
      );
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  useEffect(() => {
    let stale = false;
    const reload = () => {
      if (!stale) void load();
    };
    reload();
    let unlisten: (() => void) | undefined;
    listen<SchedulerRunDonePayload>("scheduler-run-done", (e) => {
      setRunning((cur) => {
        if (!cur.has(e.payload.scheduleId)) return cur;
        const next = new Set(cur);
        next.delete(e.payload.scheduleId);
        return next;
      });
      reload();
    })
      .then((u) => (unlisten = u))
      .catch(() => {});
    return () => {
      stale = true;
      unlisten?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot]);

  async function toggleEnabled(s: ScheduleDto) {
    try {
      await invoke("update_schedule", {
        id: s.id,
        patch: { enabled: !s.enabled },
      });
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function runNow(s: ScheduleDto) {
    setRunning((cur) => new Set(cur).add(s.id));
    setError(null);
    try {
      await invoke("run_schedule_now", { id: s.id });
      // 拉起失败会立即 reject；成功拉起后结果走 scheduler-run-done 事件
    } catch (reason) {
      setRunning((cur) => {
        const next = new Set(cur);
        next.delete(s.id);
        return next;
      });
      setError(String(reason));
    }
  }

  async function removeSchedule(s: ScheduleDto) {
    if (
      !(await confirmDialog(`删除定时任务「${s.name}」？历史记录一并删除。`, {
        danger: true,
        confirmText: "删除",
      }))
    )
      return;
    try {
      await invoke("delete_schedule", { id: s.id });
      await load();
    } catch (reason) {
      setError(String(reason));
    }
  }

  const count = schedules?.length ?? 0;

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-l3 hover:text-l1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span>{open ? "▾" : "▸"}</span>
          ◔ 定时任务{count > 0 ? `（${count}）` : ""}
        </button>
        <button
          type="button"
          className={actionBtn}
          title="新建定时巡检（默认文献监控，可选其他技能）"
          onClick={() => setCreateOpen(true)}
        >
          ＋ 定时巡检
        </button>
      </div>
      {open && (
        <div className="mt-1 rounded-md bg-strip p-2">
          {error && <p className="py-1 text-xs text-err-text">{error}</p>}
          {schedules !== null && schedules.length === 0 && (
            <p className="text-xs text-l4">
              无定时任务。点「＋ 定时巡检」让 Agent
              按周期自动巡检文献，命中追加到 notes/inbox.md。
            </p>
          )}
          {schedules !== null && schedules.length > 0 && (
            <ul className="divide-y divide-hairline">
              {schedules.map((s) => (
                <li key={s.id} className="group py-1.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <Toggle
                      checked={s.enabled}
                      onChange={() => void toggleEnabled(s)}
                      label={`${s.enabled ? "停用" : "启用"}定时任务：${s.name}`}
                    />
                    <span
                      className="min-w-0 truncate text-xs text-l2"
                      title={s.name}
                    >
                      {s.name}
                    </span>
                    <span className="shrink-0 text-xs text-l3">
                      {frequencyLabel(s.frequency, s.weekday, s.hour, s.minute)}
                    </span>
                    {/* 技能名白话直显：「文献雷达 · 每天 09:00 · lit-watch」 */}
                    <span className="shrink-0 text-xs text-l4">{s.skill}</span>
                    <span className="min-w-0 flex-1" />
                    {s.lastRunAt && (
                      <span
                        className="shrink-0 text-xs text-l4"
                        title={absTime(s.lastRunAt)}
                      >
                        上次{" "}
                        <span
                          className={
                            s.lastStatus === "ok"
                              ? "text-ok-text"
                              : "text-err-text"
                          }
                        >
                          {s.lastStatus === "ok" ? "✓" : "✗"}
                        </span>{" "}
                        {relTime(s.lastRunAt)}
                      </span>
                    )}
                    {s.history.length > 0 && (
                      <button
                        type="button"
                        className={`${actionBtn} shrink-0`}
                        aria-expanded={historyOpen === s.id}
                        title="最近运行记录"
                        onClick={() =>
                          setHistoryOpen((v) => (v === s.id ? null : s.id))
                        }
                      >
                        {historyOpen === s.id ? "▾" : "▸"} 历史
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${actionBtn} shrink-0`}
                      disabled={running.has(s.id)}
                      title="立即运行一次（结果走通知）"
                      onClick={() => void runNow(s)}
                    >
                      {running.has(s.id) ? "◔ 运行中…" : "▶ 立即跑"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenu({ x: rect.right, y: rect.bottom + 4, id: s.id });
                      }}
                      title="任务操作"
                      aria-label={`任务操作：${s.name}`}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-xs text-l3 hover:bg-hover hover:text-l1"
                    >
                      ⋯
                    </button>
                  </div>
                  {historyOpen === s.id && (
                    <ul className="ml-9 mt-1 divide-y divide-hairline border-l border-white/5 pl-2">
                      {s.history.slice(0, HISTORY_PREVIEW).map((r, i) => (
                        <RunHistoryItem key={`${r.at}-${i}`} record={r} />
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {menu && schedules && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          alignRight
          onClose={() => setMenu(null)}
          items={[
            {
              label: "删除任务",
              danger: true,
              onSelect: () => {
                const s = schedules.find((t) => t.id === menu.id);
                if (s) void removeSchedule(s);
              },
            },
          ]}
        />
      )}
      {createOpen && (
        <CreateScheduleModal
          projectRoot={projectRoot}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setOpen(true);
            void load();
          }}
        />
      )}
    </div>
  );
}
