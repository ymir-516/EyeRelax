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
  ReminderType,
  type ReminderCommand,
  type ReminderOutputEvent,
  type ReminderSettings,
  type ReminderState as ReminderStateValue,
  type ReminderTypeValue,
  SystemEventType,
  type SystemEvent
} from "./model.js";

/**
 * @brief 护眼提醒的正常间隔。
 */
export const REMINDER_INTERVAL_MINUTES = 20;

/**
 * @brief 护眼提醒的正常间隔毫秒数。
 */
export const REMINDER_INTERVAL_MILLISECONDS =
  REMINDER_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE;

/**
 * @brief 站立提醒的正常间隔。
 */
export const STANDING_REMINDER_INTERVAL_MINUTES = 30;

/**
 * @brief 站立提醒的正常间隔毫秒数。
 */
export const STANDING_REMINDER_INTERVAL_MILLISECONDS =
  STANDING_REMINDER_INTERVAL_MINUTES * MILLISECONDS_PER_MINUTE;

/**
 * @brief 系统暂停原因。
 */
type SystemPauseReason = "locked" | "suspended";

/**
 * @brief 单条提醒轨道的运行数据。
 *
 * 每种提醒都拥有自己的计时器和截止时间，避免一条提醒的完成、延迟或
 * 系统暂停操作取消另一条提醒的计时。
 */
interface ReminderTrack {
  type: ReminderTypeValue;
  state: ReminderStateValue;
  timer: OneShotTimer | undefined;
  deadlineMilliseconds: number | undefined;
  pausedRemainingMilliseconds: number | undefined;
  timerGeneration: number;
}

/**
 * @brief 创建初始的提醒轨道。
 */
function createReminderTrack(type: ReminderTypeValue): ReminderTrack
{
  return {
    type,
    state: ReminderState.Waiting,
    timer: undefined,
    deadlineMilliseconds: undefined,
    pausedRemainingMilliseconds: undefined,
    timerGeneration: 0
  };
}

/**
 * @brief 提醒调度器依赖项。
 */
export interface ReminderSchedulerOptions {
  clock: MonotonicClock;
  timerScheduler: OneShotTimerScheduler;
  settings: ReminderSettings;
  emit: (event: ReminderOutputEvent) => void;
}

/**
 * @brief 管理护眼和站立两条独立提醒轨道。
 *
 * 到期提醒通过单个可复用弹窗展示；当弹窗正在展示另一条提醒时，新的
 * 到期提醒进入去重队列，并在当前提醒完成或延迟后依次展示。系统锁屏、
 * 睡眠只冻结计时，手动暂停则结束当前弹窗并保留队列。
 */
export class ReminderScheduler
{
  private readonly tracks = new Map<ReminderTypeValue, ReminderTrack>([
    [ReminderType.EyeRest, createReminderTrack(ReminderType.EyeRest)],
    [ReminderType.Standing, createReminderTrack(ReminderType.Standing)]
  ]);
  private readonly pendingReminderTypes: ReminderTypeValue[] = [];
  private started = false;
  private visibleReminderType: ReminderTypeValue | undefined;
  private manuallyPaused = false;
  private userLocked = false;
  private systemSuspended = false;

  /**
   * @brief 创建提醒调度器。
   */
  constructor(private readonly options: ReminderSchedulerOptions)
  {
  }

  /**
   * @brief 获取指定提醒的状态。
   *
   * 未传入类型时返回整体状态，以兼容现有护眼提醒调用方；整体状态会
   * 优先反映手动暂停或当前正在展示的提醒。
   */
  getState(reminderType?: ReminderTypeValue): ReminderStateValue
  {
    if (reminderType !== undefined)
      return this.getTrack(reminderType).state;

    if (this.manuallyPaused)
      return ReminderState.Paused;

    if (this.visibleReminderType !== undefined)
      return ReminderState.ReminderVisible;

    return this.getTrack(ReminderType.EyeRest).state;
  }

  /**
   * @brief 获取指定提醒距离下一次展示的剩余时间。
   *
   * 正在展示或排队的提醒没有下一次倒计时，系统暂停时返回冻结前保存
   * 的剩余时间。未传入类型时默认查询护眼提醒。
   */
  getNextReminderRemainingMilliseconds(
    reminderType: ReminderTypeValue = ReminderType.EyeRest
  ): number | undefined
  {
    const track = this.getTrack(reminderType);
    if (track.deadlineMilliseconds !== undefined) {
      return Math.max(
        0,
        track.deadlineMilliseconds - this.options.clock.now()
      );
    }

    return track.pausedRemainingMilliseconds;
  }

  /**
   * @brief 获取当前弹窗对应的提醒类型。
   */
  getCurrentReminderType(): ReminderTypeValue | undefined
  {
    return this.visibleReminderType;
  }

  /**
   * @brief 获取当前待处理队列的快照。
   *
   * 返回副本是为了防止托盘或其他调用方绕过调度器修改队列顺序。
   */
  getPendingReminderTypes(): readonly ReminderTypeValue[]
  {
    return [...this.pendingReminderTypes];
  }

  /**
   * @brief 判断是否处于手动暂停状态。
   */
  isManuallyPaused(): boolean
  {
    return this.manuallyPaused;
  }

  /**
   * @brief 启动两条提醒轨道。
   *
   * 护眼轨道先注册，保证同一时刻到期时默认由护眼提醒优先处理；真正
   * 的优先级仍在到期处理处再次校验，以免依赖底层定时器的回调顺序。
   * @return 是否从未启动状态成功切换为运行状态。
   */
  start(): boolean
  {
    if (this.started)
      return false;

    this.started = true;
    this.scheduleWaitingReminders();
    this.presentNextReminder();
    return true;
  }

  /**
   * @brief 停止并重置两条提醒轨道。
   *
   * 应用重新启动后应从两个完整周期重新计时，因此停止时不保留旧的
   * 截止时间、暂停剩余时间或待处理队列。
   */
  stop(): void
  {
    this.started = false;
    for (const track of this.tracks.values()) {
      this.cancelTrackTimer(track);
      track.state = ReminderState.Waiting;
      track.pausedRemainingMilliseconds = undefined;
    }

    this.pendingReminderTypes.length = 0;
    this.visibleReminderType = undefined;
    this.manuallyPaused = false;
    this.userLocked = false;
    this.systemSuspended = false;
  }

  /**
   * @brief 分发用户操作。
   *
   * 完成和延迟必须携带提醒类型；立即提醒保持原有语义，只作用于护眼
   * 轨道，不提供单独的立即站立提醒入口。
   * @return 操作是否被当前状态接受。
   */
  dispatch(command: ReminderCommand): boolean
  {
    if (!this.started)
      return false;

    switch (command.type) {
      case ReminderCommandType.Complete:
        return this.completeReminder(command.reminderType);
      case ReminderCommandType.Snooze:
        return this.snoozeReminder(command.reminderType);
      case ReminderCommandType.RemindNow:
        return this.remindNow();
      case ReminderCommandType.Pause:
        return this.pauseReminder();
      case ReminderCommandType.Resume:
        return this.resumeReminder();
    }
  }

  /**
   * @brief 分发锁屏、解锁、睡眠和恢复事件。
   *
   * 多个系统暂停原因同时存在时只在第一个原因出现时冻结计时，并在最
   * 后一个原因消失后恢复，避免重复保存或重建倒计时。
   * @return 系统暂停状态是否发生变化。
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
   * @brief 将到期提醒展示或放入待处理队列。
   */
  private handleReminderDue(reminderType: ReminderTypeValue): void
  {
    const track = this.getTrack(reminderType);
    if (
      track.state !== ReminderState.Waiting &&
      track.state !== ReminderState.Snoozed
    )
      return;

    if (
      this.visibleReminderType !== undefined ||
      this.manuallyPaused ||
      this.isSystemPaused()
    ) {
      this.enqueueReminder(reminderType);
      return;
    }

    this.presentReminder(reminderType);
  }

  /**
   * @brief 展示指定提醒，并从待处理队列中移除它。
   */
  private presentReminder(reminderType: ReminderTypeValue): void
  {
    this.removePendingReminder(reminderType);
    const track = this.getTrack(reminderType);
    track.state = ReminderState.ReminderVisible;
    track.pausedRemainingMilliseconds = undefined;
    this.visibleReminderType = reminderType;
    this.emit({
      type: ReminderOutputEventType.Show,
      reminderType
    });
  }

  /**
   * @brief 展示队列中的下一条提醒。
   */
  private presentNextReminder(): void
  {
    if (
      !this.started ||
      this.visibleReminderType !== undefined ||
      this.manuallyPaused ||
      this.isSystemPaused()
    )
      return;

    const reminderType = this.pendingReminderTypes.shift();
    if (reminderType === undefined)
      return;

    this.presentReminder(reminderType);
  }

  /**
   * @brief 完成当前指定类型的提醒。
   */
  private completeReminder(reminderType: ReminderTypeValue): boolean
  {
    if (this.visibleReminderType !== reminderType)
      return false;

    const track = this.getTrack(reminderType);
    if (track.state !== ReminderState.ReminderVisible)
      return false;

    this.visibleReminderType = undefined;
    track.state = ReminderState.Waiting;
    track.pausedRemainingMilliseconds = undefined;
    this.scheduleNormalReminder(track);
    this.emit({ type: ReminderOutputEventType.Hide });
    this.presentNextReminder();
    return true;
  }

  /**
   * @brief 延迟当前指定类型的提醒。
   */
  private snoozeReminder(reminderType: ReminderTypeValue): boolean
  {
    if (this.visibleReminderType !== reminderType)
      return false;

    const track = this.getTrack(reminderType);
    if (track.state !== ReminderState.ReminderVisible)
      return false;

    this.visibleReminderType = undefined;
    track.state = ReminderState.Snoozed;
    track.pausedRemainingMilliseconds = undefined;
    this.scheduleSnoozedReminder(track);
    this.emit({ type: ReminderOutputEventType.Hide });
    this.presentNextReminder();
    return true;
  }

  /**
   * @brief 立即触发护眼提醒。
   *
   * 若站立弹窗正在展示，护眼提醒排到队首，避免两个提醒争用同一个
   * 窗口；若护眼弹窗已展示，则只将它置于前台。
   */
  private remindNow(): boolean
  {
    const eyeTrack = this.getTrack(ReminderType.EyeRest);
    if (this.visibleReminderType === ReminderType.EyeRest) {
      this.emit({
        type: ReminderOutputEventType.BringToFront,
        reminderType: ReminderType.EyeRest
      });
      return true;
    }

    if (this.visibleReminderType !== undefined) {
      this.enqueueReminder(ReminderType.EyeRest);
      this.movePendingReminderToFront(ReminderType.EyeRest);
      return true;
    }

    if (
      eyeTrack.state !== ReminderState.Waiting &&
      eyeTrack.state !== ReminderState.Snoozed &&
      eyeTrack.state !== ReminderState.Paused &&
      eyeTrack.state !== ReminderState.Queued
    )
      return false;

    this.cancelTrackTimer(eyeTrack);
    eyeTrack.pausedRemainingMilliseconds = undefined;
    this.presentReminder(ReminderType.EyeRest);
    return true;
  }

  /**
   * @brief 手动暂停两条提醒轨道。
   *
   * 手动暂停不保存当前周期剩余时间，而是让恢复后的轨道重新开始完整
   * 周期；已经排队的提醒不受影响，并会在恢复后优先展示。
   */
  private pauseReminder(): boolean
  {
    if (this.manuallyPaused)
      return false;

    const hadActiveReminder = this.visibleReminderType !== undefined ||
      [...this.tracks.values()].some((track) => {
        return track.state === ReminderState.Waiting ||
          track.state === ReminderState.Snoozed;
      });
    if (!hadActiveReminder)
      return false;

    const visibleReminderType = this.visibleReminderType;
    this.manuallyPaused = true;
    this.visibleReminderType = undefined;

    for (const track of this.tracks.values()) {
      if (
        track.state !== ReminderState.Waiting &&
        track.state !== ReminderState.Snoozed &&
        track.state !== ReminderState.ReminderVisible
      )
        continue;

      this.cancelTrackTimer(track);
      track.pausedRemainingMilliseconds = undefined;
      track.state = ReminderState.Paused;
    }

    if (visibleReminderType !== undefined)
      this.emit({ type: ReminderOutputEventType.Hide });

    return true;
  }

  /**
   * @brief 恢复手动暂停的提醒轨道。
   */
  private resumeReminder(): boolean
  {
    if (!this.manuallyPaused)
      return false;

    this.manuallyPaused = false;
    for (const track of this.tracks.values()) {
      if (track.state === ReminderState.Paused)
        track.state = ReminderState.Waiting;
    }

    this.scheduleWaitingReminders();
    this.presentNextReminder();
    return true;
  }

  /**
   * @brief 更新一个系统暂停原因。
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
   * @brief 获取指定系统暂停原因的当前值。
   */
  private getSystemPauseReason(reason: SystemPauseReason): boolean
  {
    return reason === "locked" ? this.userLocked : this.systemSuspended;
  }

  /**
   * @brief 设置指定系统暂停原因的当前值。
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
   * @brief 判断是否存在锁屏或睡眠暂停原因。
   */
  isSystemPaused(): boolean
  {
    return this.userLocked || this.systemSuspended;
  }

  /**
   * @brief 冻结系统事件发生时两条轨道的剩余时间。
   */
  private pauseForSystemEvent(): void
  {
    if (!this.started)
      return;

    for (const track of this.tracks.values()) {
      if (
        track.state !== ReminderState.Waiting &&
        track.state !== ReminderState.Snoozed
      )
        continue;

      if (track.deadlineMilliseconds === undefined)
        continue;

      track.pausedRemainingMilliseconds = Math.max(
        0,
        track.deadlineMilliseconds - this.options.clock.now()
      );
      this.cancelTrackTimer(track);
    }
  }

  /**
   * @brief 在系统暂停结束后恢复两条轨道。
   */
  private resumeAfterSystemEvent(): void
  {
    if (!this.started || this.manuallyPaused)
      return;

    for (const track of this.tracks.values()) {
      if (
        track.state !== ReminderState.Waiting &&
        track.state !== ReminderState.Snoozed
      )
        continue;

      const remainingMilliseconds = track.pausedRemainingMilliseconds;
      track.pausedRemainingMilliseconds = undefined;
      if (remainingMilliseconds !== undefined) {
        this.scheduleTimer(
          track,
          remainingMilliseconds,
          (): void => this.handleReminderDue(track.type)
        );
      } else if (track.state === ReminderState.Waiting) {
        this.scheduleNormalReminder(track);
      } else {
        this.scheduleSnoozedReminder(track);
      }
    }

    this.presentNextReminder();
  }

  /**
   * @brief 为所有等待中的提醒注册正常周期。
   */
  private scheduleWaitingReminders(): void
  {
    if (this.isSchedulingPaused())
      return;

    for (const track of this.tracks.values()) {
      if (track.state === ReminderState.Waiting)
        this.scheduleNormalReminder(track);
      else if (track.state === ReminderState.Snoozed)
        this.scheduleSnoozedReminder(track);
    }
  }

  /**
   * @brief 为指定提醒注册正常周期。
   */
  private scheduleNormalReminder(track: ReminderTrack): void
  {
    if (this.isSchedulingPaused())
      return;

    const delayMilliseconds = track.type === ReminderType.EyeRest
      ? REMINDER_INTERVAL_MILLISECONDS
      : STANDING_REMINDER_INTERVAL_MILLISECONDS;
    this.scheduleTimer(
      track,
      delayMilliseconds,
      (): void => this.handleReminderDue(track.type)
    );
  }

  /**
   * @brief 为指定提醒注册延迟周期。
   */
  private scheduleSnoozedReminder(track: ReminderTrack): void
  {
    if (this.isSchedulingPaused())
      return;

    this.scheduleTimer(
      track,
      this.options.settings.snoozeMinutes * MILLISECONDS_PER_MINUTE,
      (): void => this.handleReminderDue(track.type)
    );
  }

  /**
   * @brief 注册一条带截止时间和代次校验的单次计时器。
   */
  private scheduleTimer(
    track: ReminderTrack,
    delayMilliseconds: number,
    callback: () => void
  ): void
  {
    this.cancelTrackTimer(track);
    const generation = track.timerGeneration;
    const deadline = this.options.clock.now() + delayMilliseconds;
    track.deadlineMilliseconds = deadline;
    track.timer = this.options.timerScheduler.schedule(
      delayMilliseconds,
      (): void => {
        this.handleTimer(track, generation, deadline, callback);
      }
    );
  }

  /**
   * @brief 处理可能早到或晚到的底层计时器回调。
   */
  private handleTimer(
    track: ReminderTrack,
    generation: number,
    deadline: number,
    callback: () => void
  ): void
  {
    if (generation !== track.timerGeneration)
      return;

    const remainingMilliseconds = deadline - this.options.clock.now();
    if (remainingMilliseconds > 0) {
      this.scheduleTimer(track, remainingMilliseconds, callback);
      return;
    }

    track.timer = undefined;
    track.deadlineMilliseconds = undefined;

    if (track.type === ReminderType.Standing)
      this.presentDueEyeReminderFirst();

    callback();
  }

  /**
   * @brief 在站立提醒回调先到时补偿护眼优先级。
   */
  private presentDueEyeReminderFirst(): void
  {
    const eyeTrack = this.getTrack(ReminderType.EyeRest);
    if (
      eyeTrack.deadlineMilliseconds === undefined ||
      eyeTrack.deadlineMilliseconds > this.options.clock.now() ||
      (eyeTrack.state !== ReminderState.Waiting &&
        eyeTrack.state !== ReminderState.Snoozed)
    )
      return;

    this.cancelTrackTimer(eyeTrack);
    this.handleReminderDue(ReminderType.EyeRest);
  }

  /**
   * @brief 将提醒加入去重队列。
   */
  private enqueueReminder(reminderType: ReminderTypeValue): void
  {
    if (
      this.visibleReminderType === reminderType ||
      this.pendingReminderTypes.includes(reminderType)
    )
      return;

    const track = this.getTrack(reminderType);
    this.cancelTrackTimer(track);
    track.pausedRemainingMilliseconds = undefined;
    track.state = ReminderState.Queued;
    this.pendingReminderTypes.push(reminderType);
  }

  /**
   * @brief 将指定提醒移动到待处理队列首位。
   */
  private movePendingReminderToFront(reminderType: ReminderTypeValue): void
  {
    const index = this.pendingReminderTypes.indexOf(reminderType);
    if (index <= 0)
      return;

    this.pendingReminderTypes.splice(index, 1);
    this.pendingReminderTypes.unshift(reminderType);
  }

  /**
   * @brief 从待处理队列中移除指定提醒。
   */
  private removePendingReminder(reminderType: ReminderTypeValue): void
  {
    const index = this.pendingReminderTypes.indexOf(reminderType);
    if (index >= 0)
      this.pendingReminderTypes.splice(index, 1);
  }

  /**
   * @brief 获取指定提醒轨道。
   */
  private getTrack(reminderType: ReminderTypeValue): ReminderTrack
  {
    const track = this.tracks.get(reminderType);
    if (track === undefined)
      throw new Error("Unknown reminder type");

    return track;
  }

  /**
   * @brief 判断是否暂时禁止注册新的提醒计时器。
   */
  private isSchedulingPaused(): boolean
  {
    return !this.started || this.manuallyPaused || this.isSystemPaused();
  }

  /**
   * @brief 取消指定轨道的计时器并使旧回调失效。
   */
  private cancelTrackTimer(track: ReminderTrack): void
  {
    track.timerGeneration += 1;
    track.timer?.cancel();
    track.timer = undefined;
    track.deadlineMilliseconds = undefined;
  }

  /**
   * @brief 向应用层发送提醒输出事件。
   */
  private emit(event: ReminderOutputEvent): void
  {
    this.options.emit(event);
  }
}
