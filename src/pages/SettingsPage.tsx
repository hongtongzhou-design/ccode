import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";

/** 四款深色主题：色板双格预览（左=侧栏色，右=内容底色）+ 名称 */
const THEMES = [
  { id: "midnight", name: "沉浸黑", rail: "#08090d", canvas: "#11131a" },
  { id: "warm", name: "暖夜", rail: "#120d0b", canvas: "#150f0c" },
  { id: "forest", name: "墨绿", rail: "#070c0a", canvas: "#0e1511" },
  { id: "violet", name: "深紫", rail: "#0b0912", canvas: "#130f1f" },
] as const;

const field =
  "rounded border border-field bg-canvas px-2 py-1 text-sm text-l2 outline-none focus:border-l4";

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-hairline py-3">
      <span className="w-32 shrink-0 text-sm text-l2">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
      {hint && <span className="text-xs text-l4">{hint}</span>}
    </div>
  );
}

export default function SettingsPage({ visible }: { visible: boolean }) {
  const settings = useAppStore((s) => s.settings);
  const loadSettings = useAppStore((s) => s.loadSettings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 数值输入的本地草稿（失焦/回车才提交，避免每击键一次 IPC）
  const [fontSize, setFontSize] = useState("");
  const [scrollback, setScrollback] = useState("");
  const [rate, setRate] = useState("");
  const [pricing, setPricing] = useState("");
  const [pricingDirty, setPricingDirty] = useState(false);
  const [savingPricing, setSavingPricing] = useState(false);

  useEffect(() => {
    if (visible) {
      loadSettings().catch((e) => setError(String(e)));
      invoke<string>("read_pricing_file")
        .then((t) => {
          setPricing(t);
          setPricingDirty(false);
        })
        .catch((e) => setError(String(e)));
    }
  }, [visible, loadSettings]);

  // settings 到达后同步草稿
  useEffect(() => {
    if (settings) {
      setFontSize(String(settings.terminalFontSize));
      setScrollback(String(settings.scrollback));
      setRate(String(settings.rateUsdCny));
    }
  }, [settings]);

  async function patch(p: Parameters<typeof updateSettings>[0]) {
    setError(null);
    try {
      await updateSettings(p);
    } catch (e) {
      setError(String(e));
    }
  }

  function commitNumber(
    raw: string,
    min: number,
    max: number,
    apply: (n: number) => void,
  ) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    apply(Math.min(max, Math.max(min, Math.round(n * 100) / 100)));
  }

  async function savePricing() {
    setSavingPricing(true);
    setError(null);
    try {
      await invoke("write_pricing_file", { text: pricing });
      setPricingDirty(false);
      setNotice("已保存，下一次统计查询生效");
      setTimeout(() => setNotice(null), 3000);
    } catch (e) {
      setError(String(e));
    } finally {
      setSavingPricing(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="mb-5 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold text-l1">设置</h1>
      </div>
      {error && <p className="mb-3 text-sm text-err-text">{error}</p>}
      {notice && <p className="mb-3 text-xs text-ok-text">{notice}</p>}

      {/* 主题 */}
      <div className="border-b border-hairline py-3">
        <div className="mb-2 text-sm text-l2">主题</div>
        <div className="flex gap-2">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => patch({ theme: t.id })}
              title={`切换到${t.name}`}
              className={`w-20 rounded-md border p-1.5 text-center text-xs ${
                settings?.theme === t.id
                  ? "border-cta-bd text-l1"
                  : "border-field text-l3 hover:text-l1"
              }`}
            >
              <span className="mb-1 flex h-8 overflow-hidden rounded">
                <span className="h-full w-1/2" style={{ background: t.rail }} />
                <span className="h-full w-1/2" style={{ background: t.canvas }} />
              </span>
              {t.name}
              {settings?.theme === t.id && <span className="ml-0.5 text-ok-text">✓</span>}
            </button>
          ))}
        </div>
      </div>

      <Row label="终端字号" hint="立即生效（11–18）">
        <input
          type="number"
          min={11}
          max={18}
          className={`${field} w-20`}
          value={fontSize}
          onChange={(e) => setFontSize(e.target.value)}
          onBlur={() =>
            commitNumber(fontSize, 11, 18, (n) => patch({ terminalFontSize: n }))
          }
          onKeyDown={(e) =>
            e.key === "Enter" &&
            commitNumber(fontSize, 11, 18, (n) => patch({ terminalFontSize: n }))
          }
        />
      </Row>

      <Row label="滚动缓冲行数" hint="新开标签生效（1000–20000）">
        <input
          type="number"
          min={1000}
          max={20000}
          step={1000}
          className={`${field} w-24`}
          value={scrollback}
          onChange={(e) => setScrollback(e.target.value)}
          onBlur={() => commitNumber(scrollback, 1000, 20000, (n) => patch({ scrollback: n }))}
          onKeyDown={(e) =>
            e.key === "Enter" && commitNumber(scrollback, 1000, 20000, (n) => patch({ scrollback: n }))
          }
        />
      </Row>

      <Row label="汇率（USD→CNY）" hint="统计页下次查询生效">
        <input
          type="number"
          step={0.01}
          min={0}
          className={`${field} w-24`}
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          onBlur={() => commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }))}
          onKeyDown={(e) =>
            e.key === "Enter" && commitNumber(rate, 0, 100, (n) => patch({ rateUsdCny: n }))
          }
        />
      </Row>

      <Row label="brew 镜像" hint="安装/更新走清华 TUNA 镜像">
        <input
          type="checkbox"
          checked={settings?.brewMirror ?? false}
          onChange={(e) => patch({ brewMirror: e.target.checked })}
        />
      </Row>

      {/* 自定义定价 */}
      <div className="py-3">
        <div className="mb-1 flex items-center gap-3">
          <span className="w-32 shrink-0 text-sm text-l2">自定义定价</span>
          <span className="text-xs text-l4">pricing.json，保存时校验 JSON</span>
          <button
            onClick={savePricing}
            disabled={!pricingDirty || savingPricing}
            className="ml-auto rounded px-2 py-0.5 text-xs text-l2 hover:bg-white/5 disabled:opacity-50"
          >
            {savingPricing ? "保存中…" : "保存"}
          </button>
        </div>
        <textarea
          className={`${field} h-40 w-full font-mono text-xs`}
          placeholder='{"model-id": {"input": 2.5, "output": 10}}'
          value={pricing}
          onChange={(e) => {
            setPricing(e.target.value);
            setPricingDirty(true);
          }}
        />
      </div>
    </div>
  );
}
