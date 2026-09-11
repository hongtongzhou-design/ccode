import type { ReactNode } from "react";
import { Bot, Clock3, Files, ListChecks, MessageSquare } from "lucide-react";
import {
  projectTaskLabel,
  projectSurfaceTabsForMode,
  type ProjectSurfaceTab,
} from "../project-surface";
import type { ProjectDto } from "../types";

const TAB_ICONS = {
  chats: MessageSquare,
  tasks: ListChecks,
  schedules: Clock3,
  files: Files,
  agents: Bot,
} as const;

export default function ProjectSurfaceTabs({
  project,
  active,
  onChange,
  taskPanel,
  children,
}: {
  project: ProjectDto | null;
  active: ProjectSurfaceTab;
  onChange: (tab: ProjectSurfaceTab) => void;
  taskPanel?: ReactNode;
  children?: ReactNode;
}) {
  if (!project) return <>{children}</>;
  const labels: Record<ProjectSurfaceTab, string> = {
    chats: "对话",
    tasks: projectTaskLabel(project.workMode),
    schedules: "定时任务",
    files: "文件",
    agents: "Agents",
  };
  const tabs = projectSurfaceTabsForMode(project.workMode).map((id) => ({
    id,
    label: labels[id],
  }));
  return (
    <section aria-label="项目视图">
      <div
        className="mb-4 flex items-center gap-1 border-b border-hairline"
        role="tablist"
        aria-label="项目视图"
      >
        {tabs.map((tab) => {
          const Icon = TAB_ICONS[tab.id];
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onChange(tab.id)}
              className={`inline-flex h-8 items-center gap-1.5 border-b-2 px-2.5 text-xs transition-colors ${
                selected
                  ? "border-cta text-l1"
                  : "border-transparent text-l3 hover:text-l1"
              }`}
            >
              <Icon size={14} strokeWidth={1.8} aria-hidden="true" />
              {tab.label}
            </button>
          );
        })}
      </div>
      {active === "tasks" && taskPanel}
      {children}
    </section>
  );
}
