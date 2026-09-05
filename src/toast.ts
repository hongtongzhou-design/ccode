export type ToastTone = "info" | "success" | "warning" | "error";

export type ToastNotice = {
  id: number;
  message: string;
  tone: ToastTone;
};

type ToastListener = (notice: ToastNotice) => void;

let nextId = 1;
const listeners = new Set<ToastListener>();

export function toast(message: string, tone: ToastTone = "info") {
  const notice = { id: nextId++, message, tone };
  listeners.forEach((listener) => listener(notice));
}

export function subscribeToasts(listener: ToastListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
