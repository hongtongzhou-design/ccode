import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * macOS Overlay 标题栏左边距：窗口态给红绿灯让 78px；
 * 全屏时系统把三个按钮收起，让位取消，否则左边空一块。
 */

export const MAC_TRAFFIC_PAD = "pl-[78px]";

export function macOverlayPadClass(
  isMac: boolean,
  fullscreen: boolean,
  idlePad: string,
): string {
  if (!isMac || fullscreen) return idlePad;
  return MAC_TRAFFIC_PAD;
}

export function useMacFullscreen(isMac: boolean): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!isMac) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    const sync = () => {
      void win
        .isFullscreen()
        .then(setFullscreen)
        .catch(() => setFullscreen(false));
    };
    sync();
    void win
      .onResized(sync)
      .then((u) => {
        unlisten = u;
      })
      .catch(() => {});
    return () => unlisten?.();
  }, [isMac]);
  return fullscreen;
}
