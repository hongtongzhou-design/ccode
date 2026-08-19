/** 终端标签条拖拽排序纯逻辑（tests/tab-drag.test.ts）。
 *  槽位 = 各标签拖拽开始时实测的 { left, width }（viewport 坐标，顺序 = tabs 顺序）。 */

export interface TabSlot {
  left: number;
  width: number;
}

/** 拖动位移钳制：源标签不出标签条内容范围（左缘不过首槽左缘、右缘不过末槽右缘） */
export function clampTabDragDx(
  slots: TabSlot[],
  from: number,
  rawDx: number,
): number {
  if (slots.length === 0) return 0;
  const min = slots[0].left - slots[from].left;
  const max =
    slots[slots.length - 1].left +
    slots[slots.length - 1].width -
    (slots[from].left + slots[from].width);
  return Math.min(max, Math.max(min, rawDx));
}

/** 目标槽位判定：源中心（钳制后的 dx 换算）越过谁的中线就占谁的位。
 *  必须用 >=：钳制上限恰好让源中心到达末槽中线（等宽槽位时等号成立），
 *  严格 > 会让「拖到最右」永远差一个无穷小、永远不让位 */
export function tabDragTarget(
  slots: TabSlot[],
  from: number,
  dx: number,
): number {
  const cx = slots[from].left + slots[from].width / 2 + dx;
  let target = 0;
  for (let k = 0; k < slots.length; k++) {
    if (cx >= slots[k].left + slots[k].width / 2) target = k;
  }
  return target;
}
