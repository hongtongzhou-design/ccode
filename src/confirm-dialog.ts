/** 确认框键盘语义（tests/confirm-dialog.test.ts）。
 *  焦点在「取消」时 Enter 必须取消；默认焦点是确认钮。 */

export type ConfirmKeyAction = "confirm" | "cancel" | "none";

export function confirmKeyAction(input: {
  key: string;
  alert: boolean;
  focusedIsCancel: boolean;
  enterBlocked: boolean;
}): ConfirmKeyAction {
  if (input.key === "Escape") return "cancel";
  if (input.key !== "Enter" || input.enterBlocked) return "none";
  if (input.alert) return "confirm";
  if (input.focusedIsCancel) return "cancel";
  return "confirm";
}
