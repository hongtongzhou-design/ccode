import { memo, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

function basename(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 图片只读预览：png/jpg/gif/webp/svg 经 read_image_bytes（与 md 内嵌图同一通道）。
 */
function ImagePreview({
  path,
  cwdHint,
}: {
  path: string;
  cwdHint: string | null;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUrl(null);
    setError(null);
    void (async () => {
      try {
        const dto = await invoke<{ mime: string; data: string }>(
          "read_image_bytes",
          { path, cwdHint },
        );
        if (!cancelled) setUrl(`data:${dto.mime};base64,${dto.data}`);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path, cwdHint]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 bg-strip px-3 py-1.5 text-xs">
        <span className="truncate text-l3" title={path}>
          {basename(path)}
        </span>
      </div>
      {error ? (
        <div className="p-3">
          <p className="text-sm text-err-text">{error}</p>
        </div>
      ) : url === null ? (
        <div className="p-3">
          <p className="text-sm text-l4">正在加载图片…</p>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3"
          style={{
            backgroundImage:
              "repeating-conic-gradient(var(--color-inset) 0% 25%, transparent 0% 50%)",
            backgroundSize: "16px 16px",
          }}
        >
          <img
            src={url}
            alt={basename(path)}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </div>
  );
}

export default memo(ImagePreview);
