/**
 * 获取模型的下拉面板按厂商分组折叠的纯逻辑（大网关 400+ 模型平铺没法选）。
 *
 * 纯逻辑、无 DOM，node --test 直接测（tests/model-vendors.test.ts）。
 */

export interface VendorGroup {
  vendor: string;
  models: string[];
}

/**
 * 从模型 id 推断厂商名（仅用于展示分组，宁粗勿错）：
 * openrouter 风格 "vendor/model" 取斜杠前段；否则取开头「字母+数字」段
 * （gpt-5.6-sol → gpt、o3-pro → o3、Qwen3-32B → qwen3）；完全不匹配归「其他」。
 */
export function vendorOf(model: string): string {
  const m = model.trim();
  if (!m) return "其他";
  const slash = m.indexOf("/");
  if (slash > 0) return m.slice(0, slash).toLowerCase();
  const match = /^[a-zA-Z]+\d*/.exec(m);
  return match ? match[0].toLowerCase() : "其他";
}

/** 分组 + 可选筛选（子串、大小写不敏感）；组内按名称排序，组按厂商名排序，「其他」恒末 */
export function groupModelsByVendor(
  models: readonly string[],
  filter = "",
): VendorGroup[] {
  const kw = filter.trim().toLowerCase();
  const map = new Map<string, string[]>();
  for (const m of models) {
    if (kw && !m.toLowerCase().includes(kw)) continue;
    const v = vendorOf(m);
    const arr = map.get(v);
    if (arr) arr.push(m);
    else map.set(v, [m]);
  }
  return [...map.entries()]
    .map(([vendor, ms]) => ({
      vendor,
      models: ms.sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) =>
      a.vendor === "其他"
        ? 1
        : b.vendor === "其他"
          ? -1
          : a.vendor.localeCompare(b.vendor),
    );
}
