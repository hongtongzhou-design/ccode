/** 终端 16 色调色板预设（bg/fg 仍随应用主题，ANSI 色按预设切换）。
 *  从 TerminalPage 抽出共享：设置页的调色板预览也用它（单一事实源）。 */
export const XTERM_PALETTES: Record<string, Record<string, string>> = {
  "dark-plus": {
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8db", brightWhite: "#ffffff",
  },
  solarized: {
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
    brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  "one-dark": {
    black: "#282c34", red: "#e06c75", green: "#98c379", yellow: "#d19a66",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#545862", brightRed: "#e06c75", brightGreen: "#98c379",
    brightYellow: "#d19a66", brightBlue: "#61afef", brightMagenta: "#c678dd",
    brightCyan: "#56b6c2", brightWhite: "#ffffff",
  },
  catppuccin: {
    black: "#45475a", red: "#f38ba8", green: "#a6e3a1", yellow: "#f9e2af",
    blue: "#89b4fa", magenta: "#f5c2e7", cyan: "#94e2d5", white: "#bac2de",
    brightBlack: "#585b70", brightRed: "#f38ba8", brightGreen: "#a6e3a1",
    brightYellow: "#f9e2af", brightBlue: "#89b4fa", brightMagenta: "#f5c2e7",
    brightCyan: "#94e2d5", brightWhite: "#a6adc8",
  },
};

/** 设置页预览用的代表色（前 8 个 ANSI 标准色） */
export const PALETTE_PREVIEW_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
] as const;
