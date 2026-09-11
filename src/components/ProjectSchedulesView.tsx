import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import LitWatchCard from "./LitWatchCard";
import ScheduleSection from "./ScheduleSection";
import { normalizeWorkMode } from "../work-mode";
import type { ProjectConfigDto, ProjectDto, WorkspaceDto } from "../types";

/** 项目「定时任务」页：文献雷达（科研）+ 本项目全部定时任务。 */
export default function ProjectSchedulesView({
  project,
  workspaces,
  focusToken = null,
  focusEntryId = null,
  onFocusHandled,
  onError,
}: {
  project: ProjectDto;
  workspaces: WorkspaceDto[];
  focusToken?: number | null;
  focusEntryId?: string | null;
  onFocusHandled?: () => void;
  onError?: (msg: string) => void;
}) {
  const research = normalizeWorkMode(project.workMode) === "research";
  const [cfg, setCfg] = useState<ProjectConfigDto | null>(null);
  const scheduleRef = useRef<HTMLDivElement>(null);

  function reloadCfg() {
    if (!research) {
      setCfg(null);
      return;
    }
    invoke<{ config: ProjectConfigDto }>("read_project_config", {
      path: project.path,
    })
      .then((read) => setCfg(read.config))
      .catch((reason) => {
        setCfg(null);
        onError?.(`项目配置读取失败：${String(reason)}`);
      });
  }

  useEffect(() => {
    reloadCfg();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.path, research]);

  useEffect(() => {
    if (focusToken == null) return;
    onFocusHandled?.();
  }, [focusToken, onFocusHandled]);

  return (
    <div className="space-y-6">
      {research && cfg && (
        <LitWatchCard
          projectRoot={project.path}
          cfg={cfg}
          workspaces={workspaces}
          focusToken={focusToken}
          focusEntryId={focusEntryId}
          onOpenSchedules={() =>
            scheduleRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            })
          }
          onConfigChanged={reloadCfg}
        />
      )}
      <div ref={scheduleRef}>
        <ScheduleSection
          projectRoot={project.path}
          steps={cfg?.steps ?? []}
          layout="card"
        />
      </div>
    </div>
  );
}
