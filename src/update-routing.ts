/**
 * 交互式 TUI 自更新的更新路由（check_agent_updates 的 interactiveTui / interactiveUpdateCommand）：
 * kimi upgrade 这类自更新是方向键选择界面，配置页更新的行输入（updater_write，只能应答
 * [y/n]）无法操作；命中时返回预填进完整终端的自更新命令（与官方账号登录同款开终端机制），
 * 未命中返回 null——普通渠道（brew/npm/非交互自更新）行为不变，走原 run_streaming_pty 实时终端。
 */
export function interactiveUpdatePrefill(
  info:
    | {
        interactiveTui?: boolean;
        interactiveUpdateCommand?: string | null;
      }
    | undefined,
): string | null {
  if (!info?.interactiveTui) return null;
  const cmd = info.interactiveUpdateCommand?.trim();
  return cmd ? cmd : null;
}
