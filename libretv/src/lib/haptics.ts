/**
 * 轻触反馈：卡片、剧集这类高频点击上给一个极短的震动，
 * 让「点到了」在手指上也有回应（触屏的等效物是按压态，但震动更直接）。
 *
 * 约束：
 * - Android WebView 需要 VIBRATE 权限才会真的震（已在 AndroidManifest 声明）；
 * - iOS Safari 直接不支持 navigator.vibrate，桌面浏览器同样没有；
 * - 任何异常都必须吞掉——震动是锦上添花，绝不能因为它打断点击主流程。
 */
export function tapFeedback(durationMs = 8): void {
  try {
    navigator.vibrate?.(durationMs);
  } catch {
    /* 忽略：不支持或无权限 */
  }
}
