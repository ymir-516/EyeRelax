/**
 * @brief 表示以毫秒为单位的单调时间源。
 *
 * 实现不得依赖墙上时钟，避免用户修改系统时间或时区变化影响持续计时。
 */
export interface MonotonicClock {
  /**
   * @brief 返回当前单调时间戳，单位为毫秒。
   */
  now(): number;
}

/**
 * @brief 表示可以取消的一次性计时器。
 */
export interface OneShotTimer {
  /**
   * @brief 取消尚未触发的计时器。
   */
  cancel(): void;
}

/**
 * @brief 定义一次性计时器创建接口。
 *
 * 生产环境可以使用 setTimeout 实现，测试则可以注入手动推进时间的替身，
 * 从而不需要真实等待 20 分钟即可覆盖到期和取消逻辑。
 */
export interface OneShotTimerScheduler {
  /**
   * @brief 在指定毫秒数后执行一次回调。
   *
   * @param delayMilliseconds 非负延迟毫秒数。
   * @param callback 到期后只应执行一次的回调。
   * @return 可用于取消该计时器的句柄。
   */
  schedule(delayMilliseconds: number, callback: () => void): OneShotTimer;
}

/**
 * @brief 提供分钟到毫秒的统一换算常量。
 */
export const MILLISECONDS_PER_MINUTE = 60 * 1000;
