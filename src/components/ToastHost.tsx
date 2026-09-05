import { useEffect, useState } from "react";
import { subscribeToasts, type ToastNotice } from "../toast";

export default function ToastHost() {
  const [items, setItems] = useState<ToastNotice[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToasts((notice) => {
      setItems((current) => [...current, notice].slice(-4));
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== notice.id));
      }, notice.tone === "error" ? 6000 : 3200);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="ccode-toast-region" role="region" aria-label="通知" aria-live="polite" aria-atomic="false">
      {items.map((item) => (
        <div
          key={item.id}
          role={item.tone === "error" ? "alert" : "status"}
          className={`ccode-toast ccode-toast-${item.tone}`}
        >
          <span>{item.message}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() =>
              setItems((current) => current.filter((entry) => entry.id !== item.id))
            }
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
