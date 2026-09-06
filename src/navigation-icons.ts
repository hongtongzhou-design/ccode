import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Blocks,
  Cable,
  Clock3,
  Folder,
  LayoutDashboard,
  MessageCirclePlus,
  MessagesSquare,
  Settings2,
  Sparkles,
  SquareTerminal,
} from "lucide-react";

export const NAV_ICONS = {
  workbench: LayoutDashboard,
  workspaces: Folder,
  terminal: SquareTerminal,
  sessions: MessagesSquare,
  profiles: Cable,
  skills: Sparkles,
  mcp: Blocks,
  schedules: Clock3,
  stats: BarChart3,
  settings: Settings2,
  quickChat: MessageCirclePlus,
} satisfies Record<string, LucideIcon>;

export type NavIconId = keyof typeof NAV_ICONS;
