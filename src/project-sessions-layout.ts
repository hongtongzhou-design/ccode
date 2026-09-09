/**
 * 项目页右侧「这个项目的对话」：开/关持久化 + 主区不够宽时改抽屉。
 * 与 DOM 解耦，供 node --test 直接测。
 */
import { useCallback, useState } from "react";

export const PROJECT_SESSIONS_OPEN_KEY = "ccode.projectSessionsOpen";
/** 项目内容井窄于此时，对话栏改抽屉，不并排挤主区（56rem）。 */
export const PROJECT_SESSIONS_OVERLAY_MAX_PX = 896;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function liveStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function readProjectSessionsOpen(
  storage: Pick<Storage, "getItem"> | null = liveStorage(),
): boolean {
  if (!storage) return true;
  try {
    const value = storage.getItem(PROJECT_SESSIONS_OPEN_KEY);
    if (value === "0") return false;
    if (value === "1") return true;
  } catch {
    /* 读失败当默认开 */
  }
  return true;
}

export function writeProjectSessionsOpen(
  open: boolean,
  storage: Pick<Storage, "setItem"> | null = liveStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(PROJECT_SESSIONS_OPEN_KEY, open ? "1" : "0");
  } catch {
    /* 写失败不挡交互 */
  }
}

export function shouldOverlayProjectSessions(containerPx: number): boolean {
  return containerPx < PROJECT_SESSIONS_OVERLAY_MAX_PX;
}

export function useProjectSessionsOpen(): [
  boolean,
  (open: boolean) => void,
] {
  const [open, setOpen] = useState(readProjectSessionsOpen);
  const set = useCallback((next: boolean) => {
    setOpen(next);
    writeProjectSessionsOpen(next);
  }, []);
  return [open, set];
}
