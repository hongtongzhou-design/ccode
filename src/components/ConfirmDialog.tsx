import { useEffect, useRef, useSyncExternalStore } from "react";
import { confirmKeyAction } from "../confirm-dialog";
import { imeBlocksEnter } from "../ime-guard";

interface ConfirmRequest {
  message: string;
  danger: boolean;
  confirmText: string;
  alert: boolean;
  focusCancel: boolean;
  resolve: (ok: boolean) => void;
}

// 模块级单请求状态：宿主组件经 useSyncExternalStore 订阅，不进全局 zustand store
let current: ConfirmRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function settle(ok: boolean) {
  const req = current;
  current = null;
  emit();
  req?.resolve(ok);
}

/**
 * 全局 promise 版内联确认框。
 * macOS WKWebView 未实现 JS 对话框委托（window.confirm 恒返回 false），确认一律走这里。
 * 同一时刻只有一个请求（调用方都是用户手势触发）；重复调用时旧请求按「取消」resolve false。
 */
export function confirmDialog(
  message: string,
  opts?: { danger?: boolean; confirmText?: string; focusCancel?: boolean },
): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = {
      message,
      danger: opts?.danger ?? false,
      confirmText: opts?.confirmText ?? "确认",
      alert: false,
      focusCancel: opts?.focusCancel ?? false,
      resolve,
    };
    emit();
  });
}

/** 单按钮提示框（「知道了」）；macOS 上 window.alert 静默无效，结果/错误提示一律走这里 */
export function alertDialog(message: string): Promise<void> {
  current?.resolve(false);
  return new Promise<void>((resolve) => {
    current = {
      message,
      danger: false,
      confirmText: "知道了",
      alert: true,
      focusCancel: false,
      resolve: () => resolve(),
    };
    emit();
  });
}

/** 宿主组件：在 App 根部挂载一次；z-70 压过评审覆盖层内的 z-60 弹层 */
export function ConfirmDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Esc = 取消；Enter 激活当前焦点按钮（默认焦点在确认钮）。
  // 捕获阶段拦截，避免触发遮罩下层的 Esc 快捷键。
  useEffect(() => {
    if (!req) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      const action = confirmKeyAction({
        key: e.key,
        alert: req.alert,
        focusedIsCancel:
          Boolean(cancelRef.current) &&
          document.activeElement === cancelRef.current,
        enterBlocked: imeBlocksEnter({
          isComposing: e.isComposing,
          keyCode: e.keyCode,
          composingLock: false,
        }),
      });
      if (action === "none") return;
      e.preventDefault();
      e.stopPropagation();
      settle(action === "confirm");
    };
    window.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => {
      if (req.focusCancel) cancelRef.current?.focus();
      else confirmRef.current?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      previous?.focus();
    };
  }, [req]);

  if (!req) return null;
  return (
    <div
      className="fixed inset-0 z-70 flex items-center justify-center bg-black/40 p-6 ccode-fade"
      onClick={() => settle(false)}
    >
      <section
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="ccode-confirm-dialog-title"
        aria-describedby="ccode-confirm-dialog-message"
        className="w-full max-w-[26rem] rounded-lg border border-hairline ccode-float-surface p-4"
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <h2 id="ccode-confirm-dialog-title" className="sr-only">
          {req.alert ? "提示" : req.danger ? "危险操作确认" : "确认操作"}
        </h2>
        <p id="ccode-confirm-dialog-message" className="whitespace-pre-wrap text-sm leading-6 text-l1">
          {req.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          {!req.alert && (
            <button
              ref={cancelRef}
              type="button"
              onClick={() => settle(false)}
              className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
            >
              取消
            </button>
          )}
          <button
            ref={confirmRef}
            type="button"
            className={`inline-flex h-7 items-center justify-center rounded-md px-3 text-xs transition-[filter] hover:brightness-110 ${
              req.danger
                ? "bg-err text-err-text"
                : "border border-cta-bd bg-cta font-medium text-cta-text"
            }`}
            onClick={() => settle(true)}
          >
            {req.confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}
