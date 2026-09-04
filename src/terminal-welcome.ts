/**
 * 终端未启动空态：卡上目录文案与底栏收口纯逻辑（无 DOM）。
 * 身份（agent / 配置 / 模型）只活在启动栏；卡上只回答「在这个目录运行」。
 */
import { abbrevHome } from "./path-utils.ts";

/** 无存活 PTY = 未启动（含刚挂载、status 尚未上报）。 */
export function isTerminalIdle(
  status: { ptyId?: string | null } | null | undefined,
): boolean {
  return !status?.ptyId;
}

/** 空态卡上的目录短名：家目录折 ~；空串与裸 ~ 都显示 ~。 */
export function welcomeCwdShown(
  cwd: string,
  home: string,
  isWindows = false,
): string {
  const raw = cwd.trim() || "~";
  if (raw === "~") return "~";
  return home ? abbrevHome(raw, home, isWindows) : raw;
}

/** 「将在 {短名} {动词}」——终端空态用启动/恢复，聊天空态用开始。 */
export function welcomeCwdLine(
  cwd: string,
  home: string,
  verb: "启动" | "恢复" | "开始",
  isWindows = false,
): string {
  return `将在 ${welcomeCwdShown(cwd, home, isWindows)} ${verb}`;
}

/** 「将在 {短名} 启动/恢复」——终端空态卡目录行。 */
export function welcomeCwdActionLabel(
  cwd: string,
  home: string,
  restored: boolean,
  isWindows = false,
): string {
  return welcomeCwdLine(cwd, home, restored ? "恢复" : "启动", isWindows);
}
