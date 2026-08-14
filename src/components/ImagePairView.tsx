import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LoadingRows } from "./PageFrame";

interface GitImagePairDto {
  base: string | null;
  current: string | null;
  baseLabel: string;
  currentLabel: string;
}

/** 与后端 git_info::is_image_path 同一清单 */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return path.slice(dot + 1).toLowerCase() in IMAGE_MIME;
}

function dataUrl(path: string, base64: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return `data:${IMAGE_MIME[ext] ?? "image/png"};base64,${base64}`;
}

/** 透明图可辨的棋盘格底（只用主题令牌，不散落 hex） */
const CHECKERBOARD: CSSProperties = {
  backgroundImage:
    "repeating-conic-gradient(var(--color-inset) 0% 25%, transparent 0% 50%)",
  backgroundSize: "16px 16px",
};

function ImageSide({
  label,
  data,
  path,
  empty,
}: {
  label: string;
  data: string | null;
  path: string;
  empty: string;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="border-b border-hairline px-2 py-1 text-micro text-l3">
        {label}
      </div>
      <div
        className="flex items-center justify-center p-2"
        style={CHECKERBOARD}
      >
        {data ? (
          <img
            src={dataUrl(path, data)}
            alt={label}
            className="max-h-96 max-w-full object-contain"
          />
        ) : (
          <span className="py-6 text-xs text-l4">{empty}</span>
        )}
      </div>
    </div>
  );
}

/** 图片改动双栏对比：左基准版、右当前版（改动面板与任务审阅共用） */
export default function ImagePairView({
  cwd,
  path,
  revision = 0,
}: {
  /** 普通仓库传 cwd；工作区传 worktree 根（后端自行判定白名单与基准） */
  cwd: string;
  path: string;
  /** 外部刷新信号（审阅视图 revision），变化时重新读取 */
  revision?: number;
}) {
  const [pair, setPair] = useState<GitImagePairDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPair(null);
    setError(null);
    invoke<GitImagePairDto>("git_image_pair", { cwd, path })
      .then((value) => {
        if (!cancelled) setPair(value);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, path, revision]);

  if (error) return <p className="p-2 text-xs text-err-text">{error}</p>;
  if (!pair)
    return (
      <div className="p-2">
        <LoadingRows compact />
      </div>
    );
  return (
    <div className="grid grid-cols-2 divide-x divide-hairline">
      <ImageSide
        label={pair.baseLabel}
        data={pair.base}
        path={path}
        empty="基准中不存在（新增图片）"
      />
      <ImageSide
        label={pair.currentLabel}
        data={pair.current}
        path={path}
        empty="当前已删除"
      />
    </div>
  );
}
