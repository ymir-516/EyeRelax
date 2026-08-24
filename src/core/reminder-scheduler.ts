import {
  MILLISECONDS_PER_MINUTE,
  type MonotonicClock,
  type OneShotTimer,
  type OneShotTimerScheduler
} from "./clock.js";
import {
  ReminderCommandType,
  ReminderOutputEventType,
  ReminderState,
  type ReminderCommand,
  type ReminderOutputEvent,
  type ReminderSettings,
  type ReminderState as ReminderStateValue,
  SystemEventType,
  type SystemEvent
} from "./model.js";

/**
 * @brief 正常提醒周期的固定分钟数。
 */
export const REMINDER_INTERVAL_MINUTES = 20;

/**
 * @brief 正常提醒周期的毫秒数。
 */
export const REMINDER_INTERVAL_MILLISECONDS =
  REMINDER_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE;

/**
 * @brief 区分锁屏和睡眠两个可以同时存在的系统暂停原因。
 */
type SystemPauseReason = "locked" | "suspended";

/**
 * @brief 描述提醒调度器依赖的时钟、计时器、设置和输出边界。
 */
export interface ReminderSchedulerOptions {
  clock: MonotonicClock;
  timerScheduler: OneShotTimerScheduler;
  settings: ReminderSettings;
  emit: (event: ReminderOutputEvent) => void;
}

/**
 * @brief 管理提醒状态、单次计时器和窗口管理输出事件。
 *
 * 调度器只依赖抽象时钟、一次性计时器和输出回调，因此可以在 WSL 中
 * 独立测试。窗口、托盘和 Electron 生命周期由上层适配，不属于本模块。
 */
export class ReminderScheduler
{
  private state: ReminderStateValue = ReminderState.Waiting;
  private started = false;
  private activeTimer: OneShotTimer | undefined;
  private activeDeadlineMilliseconds: number | undefined;
  private pausedRemainingMilliseconds: number | undefined;
  private userLocked = false;
  private systemSuspended = false;
  private timerGeneration = 0;

  /**
   * @brief 创建提醒调度器。
   */
  constructor(private readonly options: ReminderSchedulerOptions)
  {
  }

  /**
   * @brief 返回当前提醒状态。
   */
  getState(): ReminderStateValue
  {
    return this.state;
  }

  /**
   * @brief 启动首次 20 分钟等待。
   *
   * 重复启动不会创建第二个计时器，避免应用入口重复初始化导致提醒加速。
   * @return 本次调用是否真正完成了启动。
   */
  start(): boolean
  {
    if (this.started)
      return false;

    this.started = true;
    if (this.state === ReminderState.Waiting && !this.isSystemPaused())
      this.scheduleNormalReminder();

    return true;
  }

  /**
   * @brief 停止调度器并取消当前计时器。
   *
   * 该方法只负责生命周期清理，不改变当前业务状态；应用重新创建调度器
   * 时会从 Waiting 状态开始，避免把旧的暂停或提醒状态带入新进程。
   */
  stop(): void
  {
    this.started = false;
    this.cancelActiveTimer();
    this.pausedRemainingMilliseconds = undefined;
    this.userLocked = false;
    this.systemSuspended = false;
  }

  /**
   * @brief 向调度器发送一个业务命令。
   *
   * 非法命令被拒绝且不会产生输出事件；这样上层无需依赖异常控制正常的
   * 用户交互流程。
   * @return 命令是否被当前状态接受。
   */
  dispatch(command: ReminderCommand): boolean
  {
    if (!this.started)
      return false;

    switch (command.type) {
      case ReminderCommandType.Complete:
        return this.completeReminder();
      case ReminderCommandType.Snooze:
        return this.snoozeReminder();
      case ReminderCommandType.RemindNow:
        return this.remindNow();
      case ReminderCommandType.Pause:
        return this.pauseReminder();
      case ReminderCommandType.Resume:
        return this.resumeReminder();
    }
  }

  /**
   * @brief 向调度器发送平台无关的锁屏、电源和恢复事件。
   *
   * 锁屏和睡眠分别维护独立原因，避免先后收到两类暂停事件时，单个恢复
   * 事件错误地重新启动计时器。重复事件和顺序异常事件不会改变状态。
   * @return 事件是否改变了系统暂停状态。
   */
  dispatchSystemEvent(event: SystemEvent): boolean
  {
    switch (event.type) {
      case SystemEventType.UserLocked:
        return this.setSystemPauseReason("locked", true);
      case SystemEventType.UserUnlocked:
        return this.setSystemPauseReason("locked", false);
      case SystemEventType.SystemSuspended:
        return this.setSystemPauseReason("suspended", true);
      case SystemEventType.SystemResumed:
        return this.setSystemPauseReason("suspended", false);
    }
  }

  /**
   * @brief 处理正常 20 分钟计时到期。
   */
  private showReminder(): void
  {
    this.state = ReminderState.ReminderVisible;
    this.emit({ type: ReminderOutputEventType.Show });
  }

  /**
   * @brief 处理用户确认已休息的命令。
   */
  private completeReminder(): boolean
  {
    if (this.state !== ReminderState.ReminderVisible)
      return false;

    this.state = ReminderState.Waiting;
    this.pausedRemainingMilliseconds = undefined;
    this.scheduleNormalReminder();
    this.emit({ type: ReminderOutputEventType.Hide });
    return true;
  }

  /**
   * @brief 处理用户推迟当前提醒的命令。
   */
  private snoozeReminder(): boolean
  {
    if (this.state !== ReminderState.ReminderVisible)
      return false;

    this.state = ReminderState.Snoozed;
    this.pausedRemainingMilliseconds = undefined;
    this.scheduleSnoozedReminder();
    this.emit({ type: ReminderOutputEventType.Hide });
    return true;
  }

  /**
   * @brief 处理立即提醒命令，并避免为已有提醒创建重复显示事件。
   */
  private remindNow(): boolean
  {
    if (this.state === ReminderState.ReminderVisible) {
      this.emit({ type: ReminderOutputEventType.BringToFront });
      return true;
    }

    if (
      this.state !== ReminderState.Waiting &&
      this.state !== ReminderState.Snoozed &&
      this.state !== ReminderState.Paused
    )
      return false;

    this.cancelActiveTimer();
    this.pausedRemainingMilliseconds = undefined;
    this.showReminder();
    return true;
  }

  /**
   * @brief 处理手动暂停命令。
   */
  private pauseReminder(): boolean
  {
    if (
      this.state !== ReminderState.Waiting &&
      this.state !== ReminderState.Snoozed &&
      this.state !== ReminderState.ReminderVisible
    )
      return false;

    const wasVisible = this.state === ReminderState.ReminderVisible;
    this.state = ReminderState.Paused;
    this.pausedRemainingMilliseconds = undefined;
    this.cancelActiveTimer();

    if (wasVisible)
      this.emit({ type: ReminderOutputEventType.Hide });

    return true;
  }

  /**
   * @brief 处理手动恢复命令并重新开始 20 分钟周期。
   */
  private resumeReminder(): boolean
  {
    if (this.state !== ReminderState.Paused)
      return false;

    this.state = ReminderState.Waiting;
    if (!this.isSystemPaused())
      this.scheduleNormalReminder();
    return true;
  }

  /**
   * @brief 修改一个系统暂停原因，并在整体暂停状态切换时处理计时器。
   */
  private setSystemPauseReason(
    reason: SystemPauseReason,
    active: boolean
  ): boolean
  {
    const reasonWasActive = this.getSystemPauseReason(reason);
    if (reasonWasActive === active)
      return false;

    const wasSystemPaused = this.isSystemPaused();
    this.setSystemPauseReasonValue(reason, active);
    const isSystemPaused = this.isSystemPaused();

    if (!wasSystemPaused && isSystemPaused)
      this.pauseForSystemEvent();
    else if (wasSystemPaused && !isSystemPaused)
      this.resumeAfterSystemEvent();

    return true;
  }

  /**
   * @brief 返回指定系统暂停原因当前是否生效。
   */
  private getSystemPauseReason(reason: SystemPauseReason): boolean
  {
    return reason === "locked" ? this.userLocked : this.systemSuspended;
  }

  /**
   * @brief 更新指定系统暂停原因的内部标记。
   */
  private setSystemPauseReasonValue(
    reason: SystemPauseReason,
    active: boolean
  ): void
  {
    if (reason === "locked")
      this.userLocked = active;
    else
      this.systemSuspended = active;
  }

  /**
   * @brief 返回是否存在任一锁屏或睡眠暂停原因。
   */
  private isSystemPaused(): boolean
  {
    return this.userLocked || this.systemSuspended;
  }

  /**
   * @brief 在系统进入暂停状态时保存活动计时器的剩余时间。
   */
  private pauseForSystemEvent(): void
  {
    if (
      this.state !== ReminderState.Waiting &&
      this.state !== ReminderState.Snoozed
    )
      return;

    if (this.activeDeadlineMilliseconds === undefined)
      return;

    this.pausedRemainingMilliseconds = Math.max(
      0,
      this.activeDeadlineMilliseconds - this.options.clock.now()
    );
    this.cancelActiveTimer();
  }

  /**
   * @brief 在所有系统暂停原因解除后恢复原有计时流程。
   */
  private resumeAfterSystemEvent(): void
  {
    if (
      this.state === ReminderState.Paused ||
      this.state === ReminderState.ReminderVisible
    )
      return;

    const remainingMilliseconds = this.pausedRemainingMilliseconds;
    this.pausedRemainingMilliseconds = undefined;

    if (remainingMilliseconds !== undefined) {
      this.scheduleTimer(remainingMilliseconds, () => {
        this.showReminder();
      });
      return;
    }

    if (this.state === ReminderState.Waiting)
      this.scheduleNormalReminder();
    else
      this.scheduleSnoozedReminder();
  }

  /**
   * @brief 安排下一次正常周期提醒。
   */
  private scheduleNormalReminder(): void
  {
    if (this.isSystemPaused())
      return;

    this.scheduleTimer(REMINDER_INTERVAL_MILLISECONDS, () => {
      this.showReminder();
    });
  }

  /**
   * @brief 按当前设置安排下一次推迟提醒。
   */
  private scheduleSnoozedReminder(): void
  {
    if (this.isSystemPaused())
      return;

    this.scheduleTimer(
      this.options.settings.snoozeMinutes * MILLISECONDS_PER_MINUTE,
      () => {
        this.showReminder();
      }
    );
  }

  /**
   * @brief 安排一个带代数校验的单次计时器。
   *
   * 取消接口是第一道防线，代数标记是第二道防线，用于忽略取消后仍被
   * 底层计时器回调的旧任务，确保任意时刻只有一个有效计时流程。
   */
  private scheduleTimer(delayMilliseconds: number, callback: () => void): void
  {
    this.cancelActiveTimer();

    const generation = this.timerGeneration;
    const deadline = this.options.clock.now() + delayMilliseconds;
    this.activeDeadlineMilliseconds = deadline;
    this.activeTimer = this.options.timerScheduler.schedule(
      delayMilliseconds,
      () => {
        this.handleTimer(generation, deadline, callback);
      }
    );
  }

  /**
   * @brief 校验计时回调是否仍然有效，并在到期后执行一次动作。
   */
  private handleTimer(
    generation: number,
    deadline: number,
    callback: () => void
  ): void
  {
    if (generation !== this.timerGeneration)
      return;

    const remainingMilliseconds = deadline - this.options.clock.now();
    if (remainingMilliseconds > 0) {
      this.scheduleTimer(remainingMilliseconds, callback);
      return;
    }

    this.activeTimer = undefined;
    this.activeDeadlineMilliseconds = undefined;
    callback();
  }

  /**
   * @brief 取消当前有效计时器并使旧回调失效。
   */
  private cancelActiveTimer(): void
  {
    this.timerGeneration += 1;
    this.activeTimer?.cancel();
    this.activeTimer = undefined;
    this.activeDeadlineMilliseconds = undefined;
  }

  /**
   * @brief 向窗口管理边界发送提醒输出事件。
   */
  private emit(event: ReminderOutputEvent): void
  {
    this.options.emit(event);
  }
}
