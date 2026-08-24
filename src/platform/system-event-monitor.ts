import {
  SystemEventType,
  type SystemEvent
} from "../core/model.js";

/**
 * @brief 定义 Electron powerMonitor 支持的事件名称。
 */
export type PowerMonitorEventName =
  | "lock-screen"
  | "unlock-screen"
  | "suspend"
  | "resume";

/**
 * @brief 抽象 powerMonitor 的监听能力，便于 Linux 测试注入内存替身。
 */
export interface PowerMonitorHost {
  /**
   * @brief 注册一个 powerMonitor 事件监听器。
   */
  on(eventName: PowerMonitorEventName, listener: () => void): void;

  /**
   * @brief 移除一个 powerMonitor 事件监听器。
   */
  removeListener(eventName: PowerMonitorEventName, listener: () => void): void;
}

/**
 * @brief 表示监视器需要去重的系统状态原因。
 */
type SystemEventReason = "locked" | "suspended";

/**
 * @brief 将 Electron 电源事件转换为平台无关的系统事件。
 *
 * 监视器只负责事件注册、注销和同一原因的重复事件去重，不直接修改提醒
 * 状态。调度器通过输出回调接收转换后的事件，从而保持核心模块不依赖 Electron。
 */
export class SystemEventMonitor
{
  private started = false;
  private locked = false;
  private suspended = false;

  /**
   * @brief 将锁屏开始事件转为 UserLocked。
   */
  private readonly handleLockScreen = (): void => {
    this.emitIfChanged("locked", true, { type: SystemEventType.UserLocked });
  };

  /**
   * @brief 将锁屏结束事件转为 UserUnlocked。
   */
  private readonly handleUnlockScreen = (): void => {
    this.emitIfChanged("locked", false, { type: SystemEventType.UserUnlocked });
  };

  /**
   * @brief 将系统睡眠事件转为 SystemSuspended。
   */
  private readonly handleSuspend = (): void => {
    this.emitIfChanged(
      "suspended",
      true,
      { type: SystemEventType.SystemSuspended }
    );
  };

  /**
   * @brief 将系统恢复事件转为 SystemResumed。
   */
  private readonly handleResume = (): void => {
    this.emitIfChanged(
      "suspended",
      false,
      { type: SystemEventType.SystemResumed }
    );
  };

  /**
   * @brief 创建系统事件监视器。
   *
   * @param host Electron powerMonitor 或测试替身。
   * @param emit 向核心调度器发送平台无关事件的回调。
   */
  constructor(
    private readonly host: PowerMonitorHost,
    private readonly emit: (event: SystemEvent) => void
  )
  {
  }

  /**
   * @brief 注册四类电源和锁屏事件。
   *
   * 重复启动不会重复注册监听器。
   */
  start(): void
  {
    if (this.started)
      return;

    this.started = true;
    this.host.on("lock-screen", this.handleLockScreen);
    this.host.on("unlock-screen", this.handleUnlockScreen);
    this.host.on("suspend", this.handleSuspend);
    this.host.on("resume", this.handleResume);
  }

  /**
   * @brief 注销所有监听器并清空本次运行的系统状态。
   *
   * 先将监视器标记为停止，使注销期间迟到的回调也不会向调度器发送事件。
   * 单个监听器移除失败不能阻塞其他监听器的清理。
   */
  stop(): void
  {
    if (!this.started)
      return;

    this.started = false;
    this.removeListener("lock-screen", this.handleLockScreen);
    this.removeListener("unlock-screen", this.handleUnlockScreen);
    this.removeListener("suspend", this.handleSuspend);
    this.removeListener("resume", this.handleResume);
    this.locked = false;
    this.suspended = false;
  }

  /**
   * @brief 返回监视器是否已经注册监听器。
   */
  isStarted(): boolean
  {
    return this.started;
  }

  /**
   * @brief 仅在对应系统状态发生变化时转发事件。
   */
  private emitIfChanged(
    reason: SystemEventReason,
    active: boolean,
    event: SystemEvent
  ): void
  {
    if (!this.started)
      return;

    const current = reason === "locked" ? this.locked : this.suspended;
    if (current === active)
      return;

    if (reason === "locked")
      this.locked = active;
    else
      this.suspended = active;

    this.emit(event);
  }

  /**
   * @brief 安全移除一个监听器，确保退出清理继续处理后续监听器。
   */
  private removeListener(
    eventName: PowerMonitorEventName,
    listener: () => void
  ): void
  {
    try {
      this.host.removeListener(eventName, listener);
    } catch {
      // 单个平台监听器清理失败不能阻塞其他事件注销。
    }
  }
}
