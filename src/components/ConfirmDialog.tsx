import { useEffect, useSyncExternalStore } from "react";

interface ConfirmRequest {
  message: string;
  danger: boolean;
  confirmText: string;
  alert: boolean;
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
  opts?: { danger?: boolean; confirmText?: string },
): Promise<boolean> {
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = {
      message,
      danger: opts?.danger ?? false,
      confirmText: opts?.confirmText ?? "确认",
      alert: false,
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
      resolve: () => resolve(),
    };
    emit();
  });
}

/** 宿主组件：在 App 根部挂载一次；z-[70] 压过评审覆盖层内的 z-[60] 弹层 */
export function ConfirmDialogHost() {
  const req = useSyncExternalStore(subscribe, () => current);

  // Esc = 取消、Enter = 确认；捕获阶段拦截，避免触发遮罩下层的 Esc 快捷键
  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        settle(false);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        settle(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [req]);

  if (!req) return null;
  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6 ccode-fade"
      onClick={() => settle(false)}
    >
      <section
        role="alertdialog"
        aria-modal="true"
        className="w-full max-w-[26rem] rounded-lg border border-hairline ccode-float-surface p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="whitespace-pre-wrap text-sm leading-6 text-l1">
          {req.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          {!req.alert && (
            <button
              type="button"
              onClick={() => settle(false)}
              className="inline-flex h-7 items-center justify-center rounded-md border border-field bg-strip px-3 text-xs text-l2 transition-colors hover:bg-inset hover:text-l1"
            >
              取消
            </button>
          )}
          <button
            type="button"
            // 危险操作的确认钮用警示色（bg-err 系），与批量删除二次确认同口径
            className={`inline-flex h-7 items-center justify-center rounded-md px-3 text-xs transition-[filter] hover:brightness-110 ${
              req.danger
                ? "bg-err text-err-text"
                : "border border-cta-bd bg-cta font-medium text-cta-text"
            }`}
            autoFocus
            onClick={() => settle(true)}
          >
            {req.confirmText}
          </button>
        </div>
      </section>
    </div>
  );
}
