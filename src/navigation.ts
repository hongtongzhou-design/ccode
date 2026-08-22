import type { LucideIcon } from "lucide-react";
import { NAV_ICONS } from "./navigation-icons";

export type NavItem = {
  id: string;
  label: string;
  Icon: LucideIcon;
};

export const NAV_GROUPS = [
  {
    label: "工作",
    items: [
      { id: "workbench", label: "工作台", Icon: NAV_ICONS.workbench },
      { id: "workspaces", label: "项目", Icon: NAV_ICONS.workspaces },
      { id: "terminal", label: "运行", Icon: NAV_ICONS.terminal },
      { id: "sessions", label: "对话", Icon: NAV_ICONS.sessions },
    ],
  },
  {
    label: "资源",
    items: [
      { id: "profiles", label: "连接", Icon: NAV_ICONS.profiles },
      { id: "skills", label: "技能", Icon: NAV_ICONS.skills },
      { id: "mcp", label: "MCP", Icon: NAV_ICONS.mcp },
    ],
  },
] as const satisfies readonly { label: string; items: readonly NavItem[] }[];

export const NAV_BOTTOM = [
  { id: "stats", label: "用量", Icon: NAV_ICONS.stats },
  { id: "settings", label: "设置", Icon: NAV_ICONS.settings },
] as const satisfies readonly NavItem[];

