export const NAV_CAPSULE_DELAYS = [500, 1000, 2000, 5000] as const;
export type NavCapsuleDelayMs = (typeof NAV_CAPSULE_DELAYS)[number];

export const NAV_CAPSULE_DISPLAY_MODES = ["both", "icons", "labels"] as const;
export type NavCapsuleDisplayMode = (typeof NAV_CAPSULE_DISPLAY_MODES)[number];

/** 可由用户配置的胶囊入口；恢复侧栏不在此列，始终保留。 */
export const NAV_CAPSULE_ITEM_IDS = [
  "quick-chat",
  "workbench",
  "workspaces",
  "terminal",
  "sessions",
  "profiles",
  "skills",
  "mcp",
  "stats",
  "settings",
] as const;
export type NavCapsuleItemId = (typeof NAV_CAPSULE_ITEM_IDS)[number];
export const DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS = [...NAV_CAPSULE_ITEM_IDS];

export type StartupNavMode = "expanded" | "collapsed" | "hidden";

export interface NavShellState {
  navCollapsed: boolean;
  chromeHidden: boolean;
  chromeHiddenReturnCollapsed: boolean | null;
}

export function normalizeNavCapsuleDelay(value: unknown): NavCapsuleDelayMs {
  return NAV_CAPSULE_DELAYS.includes(value as NavCapsuleDelayMs)
    ? (value as NavCapsuleDelayMs)
    : 1000;
}

export function normalizeNavCapsuleDisplayMode(
  value: unknown,
): NavCapsuleDisplayMode {
  return NAV_CAPSULE_DISPLAY_MODES.includes(value as NavCapsuleDisplayMode)
    ? (value as NavCapsuleDisplayMode)
    : "both";
}

export function normalizeNavCapsuleVisibleItems(value: unknown): NavCapsuleItemId[] {
  if (!Array.isArray(value)) return [...DEFAULT_NAV_CAPSULE_VISIBLE_ITEMS];
  const allowed = new Set<string>(NAV_CAPSULE_ITEM_IDS);
  return value.filter(
    (id): id is NavCapsuleItemId => typeof id === "string" && allowed.has(id),
  );
}

/** 当前页即使被用户隐藏，也临时保留入口，避免完全隐藏后无法回到该页。 */
export function isNavCapsuleItemVisible(
  id: string,
  page: string,
  visibleItems: readonly string[],
): boolean {
  return id === page || visibleItems.includes(id);
}

export function resolveStartupNavMode(
  value: unknown,
  legacyCollapsed: boolean,
): StartupNavMode {
  if (value === "expanded" || value === "collapsed" || value === "hidden") {
    return value;
  }
  return legacyCollapsed ? "collapsed" : "expanded";
}

export function enterChromeHidden(state: NavShellState): NavShellState {
  if (state.chromeHidden) return state;
  return {
    ...state,
    chromeHidden: true,
    chromeHiddenReturnCollapsed: state.navCollapsed,
  };
}

export function exitChromeHidden(state: NavShellState): NavShellState {
  if (!state.chromeHidden) return state;
  return {
    ...state,
    navCollapsed:
      state.chromeHiddenReturnCollapsed ?? state.navCollapsed,
    chromeHidden: false,
    chromeHiddenReturnCollapsed: null,
  };
}

export function toggleChromeHiddenState(state: NavShellState): NavShellState {
  return state.chromeHidden ? exitChromeHidden(state) : enterChromeHidden(state);
}

/** Brand button cycle: expanded ↔ icon. Fully hidden is controlled separately. */
export function cycleBrandState(state: NavShellState): NavShellState {
  if (state.chromeHidden) return exitChromeHidden(state);
  return { ...state, navCollapsed: !state.navCollapsed };
}
