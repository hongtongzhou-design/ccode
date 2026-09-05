interface PreviewErrorStateProps {
  error: string;
  onRetry: () => void;
  kind: string;
}

/** 所有文件预览统一的失败态：原因、重试入口和可复制的文件类型信息。 */
export default function PreviewErrorState({
  error,
  onRetry,
  kind,
}: PreviewErrorStateProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
      <p className="text-sm text-err-text">无法预览此 {kind} 文件</p>
      <p className="max-w-xl break-words text-xs text-l4">{error}</p>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-sm border border-line px-2 py-1 text-xs text-l2 hover:bg-hover"
      >
        重试
      </button>
    </div>
  );
}
