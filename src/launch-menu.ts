/** 启动栏菜单的视口定位。只从锚点下沿往下长，空间不够就缩短高度。 */

export interface MenuAnchor {
  left: number;
  bottom: number;
  width: number;
}

export interface MenuViewport {
  width: number;
  height: number;
}

export interface DownMenuBox {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const MENU_MARGIN = 8;
const MENU_GAP = 4;
const MENU_MAX_HEIGHT = 320;

/**
 * 把菜单放在锚点正下方。
 * macOS 系统下拉会把「当前项」对齐按钮，名单末项会把整单顶到标题栏上方；
 * 这里固定 top = 锚点下沿，右侧放不下只左移，下方不够只限高。
 */
export function placeDownMenu(
  anchor: MenuAnchor,
  viewport: MenuViewport,
  preferredWidth: number,
): DownMenuBox {
  const top = Math.round(anchor.bottom + MENU_GAP);
  const width = Math.min(
    Math.max(Math.round(anchor.width), Math.round(preferredWidth)),
    Math.max(0, viewport.width - MENU_MARGIN * 2),
  );
  let left = anchor.left;
  if (left + width > viewport.width - MENU_MARGIN) {
    left = Math.max(MENU_MARGIN, viewport.width - MENU_MARGIN - width);
  }
  const spaceBelow = Math.max(
    0,
    Math.floor(viewport.height - top - MENU_MARGIN),
  );
  return {
    top,
    left: Math.round(left),
    width,
    maxHeight: Math.min(MENU_MAX_HEIGHT, spaceBelow),
  };
}
