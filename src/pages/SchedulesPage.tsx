import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Clock3, ExternalLink, Play, RotateCw } from "lucide-react";
import { useAppStore } from "../store";
import type { ProjectDto, ScheduleDto } from "../types";
import {
  frequencyLabel,
  scheduleStatusMark,
  summaryPreview,
} from "../schedule-tasks";
import {
  EmptyState,
  PageFrame,
  PageHeader,
  primaryActionClass,
  rowActionClass,
  secondaryActionClass,
} from "../components/PageFrame";
import { absTime, relTime } from "../rel-time";
import { IS_WINDOWS } from "../hotkeys";
import { samePath } from "../path-utils";

function projectName(projects: ProjectDto[], root: string): string {
  return (
    projects.find((project) => samePath(project.path, root, IS_WINDOWS))?.name ??
    root
  );
}

export default function SchedulesPage({ visible }: { visible: boolean }) {
  const setPage = useAppStore((s) => s.setPage);
  const setSelectProjectReq = useAppStore((s) => s.setSelectProjectReq);
  const [schedules, setSchedules] = useState<ScheduleDto[]>([]);
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [historyOpen, setHistoryOpen] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSchedules, nextProjects] = await Promise.all([
        invoke<ScheduleDto[]>("list_schedules"),
        invoke<ProjectDto[]>("list_projects"),
      ]);
      setSchedules(nextSchedules);
      setProjects(nextProjects);
      setError(null);
    } catch (reason) {
      setError(`定时巡检读取失败：${String(reason)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) void load();
  }, [load, visible]);

  async function toggle(schedule: ScheduleDto) {
    try {
      await invoke("update_schedule", {
        id: schedule.id,
        patch: { enabled: !schedule.enabled },
      });
      await load();
    } catch (reason) {
      setError(`更新巡检计划失败：${String(reason)}`);
    }
  }

  async function runNow(schedule: ScheduleDto) {
    setRunning((current) => new Set(current).add(schedule.id));
    setError(null);
    try {
      await invoke("run_schedule_now", { id: schedule.id });
      window.setTimeout(() => void load(), 1200);
    } catch (reason) {
      setError(`启动巡检失败：${String(reason)}`);
      setRunning((current) => {
        const next = new Set(current);
        next.delete(schedule.id);
        return next;
      });
    }
  }

  const active = useMemo(
    () => schedules.filter((schedule) => schedule.enabled),
    [schedules],
  );
  const paused = useMemo(
    () => schedules.filter((schedule) => !schedule.enabled),
    [schedules],
  );

  function renderSchedule(schedule: ScheduleDto) {
    const mark = scheduleStatusMark(schedule.lastStatus);
    const history = schedule.history ?? [];
    const open = historyOpen.has(schedule.id);
    return (
      <li
        key={schedule.id}
        className="rounded-lg border border-hairline bg-raised/40 p-3"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={`mt-1 size-2 shrink-0 rounded-full ${mark.className.replace("text-", "bg-")}`}
            title={mark.label}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-medium text-l1">
                {schedule.name}
              </h3>
              <span className="rounded-full bg-strip px-2 py-0.5 text-micro text-l3">
                {schedule.enabled ? "已启用" : "已暂停"}
              </span>
              <span className="text-micro text-l4">
                {frequencyLabel(
                  schedule.frequency,
                  schedule.weekday,
                  schedule.hour,
                  schedule.minute,
                )}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-l3">
              {projectName(projects, schedule.projectRoot)} · {schedule.skill}
            </p>
            <p className="mt-1 truncate font-mono text-micro text-l4" title={schedule.projectRoot}>
              {schedule.lastRunAt
                ? `上次运行 ${relTime(schedule.lastRunAt)}（${mark.label}）`
                : "尚未运行"}
              {schedule.lastStatus && history[0]
                ? ` · ${summaryPreview(history[0])}`
                : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={rowActionClass}
              disabled={running.has(schedule.id)}
              onClick={() => void runNow(schedule)}
            >
              <Play size={12} aria-hidden="true" />
              {running.has(schedule.id) ? "运行中…" : "立即运行"}
            </button>
            <button
              type="button"
              className={rowActionClass}
              onClick={() => void toggle(schedule)}
            >
              {schedule.enabled ? "暂停" : "启用"}
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
          <button
            type="button"
            className="text-micro text-l4 hover:text-l1"
            onClick={() => {
              setSelectProjectReq(schedule.projectRoot);
              setPage("workspaces");
            }}
          >
            去项目配置 <ExternalLink size={11} className="inline" aria-hidden="true" />
          </button>
          {history.length > 0 && (
            <button
              type="button"
              className="ml-auto text-micro text-l4 hover:text-l1"
              onClick={() =>
                setHistoryOpen((current) => {
                  const next = new Set(current);
                  if (next.has(schedule.id)) next.delete(schedule.id);
                  else next.add(schedule.id);
                  return next;
                })
              }
            >
              {open ? "收起执行历史" : `查看执行历史（${history.length}）`}
            </button>
          )}
        </div>
        {open && (
          <ol className="mt-2 space-y-1 border-t border-hairline pt-2">
            {history.map((record, index) => (
              <li
                key={`${record.at}-${index}`}
                className="flex min-w-0 items-start gap-2 rounded-md px-1 py-1 text-micro text-l3"
              >
                <span
                  className={`mt-1 size-1.5 shrink-0 rounded-full ${scheduleStatusMark(record.status).className.replace("text-", "bg-")}`}
                />
                <span className="w-32 shrink-0" title={absTime(record.at)}>
                  {relTime(record.at)}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {summaryPreview(record) || scheduleStatusMark(record.status).label}
                </span>
                {record.adopted && <span className="shrink-0 text-ok-text">已采纳</span>}
              </li>
            ))}
          </ol>
        )}
      </li>
    );
  }

  return (
    <PageFrame width="fluid" className="pb-12">
      <PageHeader
        title="定时巡检"
        meta={`${active.length} 个启用 · ${paused.length} 个暂停`}
        actions={
          <button type="button" className={secondaryActionClass} onClick={() => void load()}>
            <RotateCw size={13} aria-hidden="true" />
            刷新
          </button>
        }
      />
      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn-text">
          <span>{error}</span>
          <button type="button" className={rowActionClass} onClick={() => void load()}>
            重试
          </button>
        </div>
      )}
      {loading && schedules.length === 0 ? (
        <p className="px-1 py-4 text-xs text-l4">读取巡检计划…</p>
      ) : schedules.length === 0 ? (
        <EmptyState
          title="还没有定时巡检"
          detail="定时巡检在项目内创建；创建后会在这里统一查看计划和执行历史。"
          action={
            <button type="button" className={primaryActionClass} onClick={() => setPage("workspaces")}>
              去项目创建
            </button>
          }
        />
      ) : (
        <div className="space-y-6">
          <section>
            <div className="mb-2 flex items-center gap-2 px-1">
              <Clock3 size={14} className="text-l4" aria-hidden="true" />
              <h2 className="text-xs font-medium text-l2">巡检计划</h2>
            </div>
            <ul className="space-y-2">{active.map(renderSchedule)}</ul>
          </section>
          {paused.length > 0 && (
            <section>
              <h2 className="mb-2 px-1 text-xs font-medium text-l2">已暂停</h2>
              <ul className="space-y-2">{paused.map(renderSchedule)}</ul>
            </section>
          )}
        </div>
      )}
    </PageFrame>
  );
}
