import type {
  MonotonicClock,
  OneShotTimer,
  OneShotTimerScheduler
} from "../core/clock.js";

/**
 * @brief 提供生产环境使用的单调时间源。
 */
export const runtimeMonotonicClock: MonotonicClock = {
  /**
   * @brief 返回进程启动以来的单调毫秒时间。
   */
  now: (): number => performance.now()
};

/**
 * @brief 将 Node.js 一次性 setTimeout 适配为核心计时器接口。
 */
export const runtimeTimerScheduler: OneShotTimerScheduler = {
  /**
   * @brief 创建一个可取消的生产计时器。
   */
  schedule(delayMilliseconds: number, callback: () => void): OneShotTimer
  {
    const timeout = setTimeout(callback, delayMilliseconds);

    return {
      /**
       * @brief 取消尚未执行的生产计时器。
       */
      cancel(): void
      {
        clearTimeout(timeout);
      }
    };
  }
};
