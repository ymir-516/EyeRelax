import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  ReminderCommandType,
  ReminderOutputEventType,
  ReminderState,
  ReminderType,
  SystemEventType,
  type ReminderCommand,
  type ReminderOutputEvent,
  type ReminderSettings,
  type SystemEvent
} from "../src/core/model.js";
import {
  MILLISECONDS_PER_MINUTE,
  type MonotonicClock,
  type OneShotTimer,
  type OneShotTimerScheduler
} from "../src/core/clock.js";
import {
  REMINDER_INTERVAL_MILLISECONDS,
  STANDING_REMINDER_INTERVAL_MILLISECONDS,
  ReminderScheduler
} from "../src/core/reminder-scheduler.js";

/**
 * @brief 可手动推进的单调时钟。
 */
class ManualClock implements MonotonicClock
{
  private currentMilliseconds = 0;

  /**
   * @brief 返回当前单调时间。
   */
  now(): number
  {
    return this.currentMilliseconds;
  }

  /**
   * @brief 向前推进时钟。
   */
  advance(milliseconds: number): void
  {
    assert.ok(milliseconds >= 0);
    this.currentMilliseconds += milliseconds;
  }
}

/**
 * @brief 手动计时器的内部记录。
 */
interface ScheduledTimer {
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

/**
 * @brief 仅在测试显式调用时执行到期回调的计时器调度器。
 */
class ManualTimerScheduler implements OneShotTimerScheduler
{
  private readonly timers: ScheduledTimer[] = [];

  /**
   * @brief 创建手动计时器调度器。
   */
  constructor(private readonly clock: MonotonicClock)
  {
  }

  /**
   * @brief 注册一条单次计时器。
   */
  schedule(delayMilliseconds: number, callback: () => void): OneShotTimer
  {
    assert.ok(delayMilliseconds >= 0);
    const timer: ScheduledTimer = {
      dueAt: this.clock.now() + delayMilliseconds,
      callback,
      cancelled: false,
      fired: false
    };
    this.timers.push(timer);

    return {
      /**
       * @brief 取消测试计时器。
       */
      cancel(): void
      {
        timer.cancelled = true;
      }
    };
  }

  /**
   * @brief 执行当前时刻已经到期的计时器。
   */
  runDue(): void
  {
    const now = this.clock.now();
    for (const timer of this.timers) {
      if (!timer.cancelled && !timer.fired && timer.dueAt <= now) {
        timer.fired = true;
        timer.callback();
      }
    }
  }

  /**
   * @brief 返回尚未取消或执行的计时器数量。
   */
  pendingTimerCount(): number
  {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired).length;
  }
}

/**
 * @brief 核心调度器测试夹具。
 */
interface SchedulerFixture
{
  clock: ManualClock;
  timerScheduler: ManualTimerScheduler;
  scheduler: ReminderScheduler;
  settings: ReminderSettings;
  events: ReminderOutputEvent[];
}

/**
 * @brief 创建使用手动时钟的调度器测试夹具。
 */
function createSchedulerFixture(): SchedulerFixture
{
  const clock = new ManualClock();
  const timerScheduler = new ManualTimerScheduler(clock);
  const settings: ReminderSettings = { ...DEFAULT_SETTINGS };
  const events: ReminderOutputEvent[] = [];
  const scheduler = new ReminderScheduler({
    clock,
    timerScheduler,
    settings,
    emit: (event): void => {
      events.push(event);
    }
  });

  return {
    clock,
    timerScheduler,
    scheduler,
    settings,
    events
  };
}

/**
 * @brief 验证核心模型包含双轨状态和类型化操作。
 */
function verifyCoreModel(): void
{
  assert.deepEqual(Object.values(ReminderState), [
    "waiting",
    "reminder-visible",
    "snoozed",
    "queued",
    "paused"
  ]);
  assert.deepEqual(Object.values(ReminderType), ["eye-rest", "standing"]);
  assert.deepEqual(DEFAULT_SETTINGS, {
    snoozeMinutes: 3,
    autoStart: true
  });

  const commands: ReminderCommand[] = [
    {
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    },
    {
      type: ReminderCommandType.Snooze,
      reminderType: ReminderType.Standing
    },
    { type: ReminderCommandType.RemindNow },
    { type: ReminderCommandType.Pause },
    { type: ReminderCommandType.Resume }
  ];
  const outputEvents: ReminderOutputEvent[] = [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    },
    { type: ReminderOutputEventType.Hide },
    {
      type: ReminderOutputEventType.BringToFront,
      reminderType: ReminderType.Standing
    }
  ];
  const systemEvents: SystemEvent[] = [
    { type: SystemEventType.UserLocked },
    { type: SystemEventType.UserUnlocked },
    { type: SystemEventType.SystemSuspended },
    { type: SystemEventType.SystemResumed }
  ];

  assert.equal(commands.length, 5);
  assert.equal(outputEvents.length, 3);
  assert.equal(systemEvents.length, 4);
}

/**
 * @brief 验证启动后两条轨道拥有独立的正常周期。
 */
function verifyIndependentReminderCycles(): void
{
  const fixture = createSchedulerFixture();

  assert.equal(fixture.scheduler.start(), true);
  assert.equal(fixture.scheduler.start(), false);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 2);
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.EyeRest),
    REMINDER_INTERVAL_MILLISECONDS
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    STANDING_REMINDER_INTERVAL_MILLISECONDS
  );

  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getState(ReminderType.EyeRest),
    ReminderState.ReminderVisible
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.Waiting
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    10 * MILLISECONDS_PER_MINUTE
  );
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    }
  ]);

  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    true
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.EyeRest),
    REMINDER_INTERVAL_MILLISECONDS
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 2);

  fixture.clock.advance(10 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.ReminderVisible
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.EyeRest),
    ReminderState.Waiting
  );
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    },
    { type: ReminderOutputEventType.Hide },
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.Standing
    }
  ]);
}

/**
 * @brief 验证完成和延迟只重置当前提醒类型。
 */
function verifyActionsRemainIndependent(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();

  fixture.clock.advance(30 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.EyeRest
  );
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), [
    ReminderType.Standing
  ]);

  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.Standing
    }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    true
  );
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.Standing
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.EyeRest),
    ReminderState.Waiting
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.ReminderVisible
  );

  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Snooze,
      reminderType: ReminderType.Standing
    }),
    true
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.Snoozed
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.EyeRest),
    REMINDER_INTERVAL_MILLISECONDS
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    DEFAULT_SETTINGS.snoozeMinutes * MILLISECONDS_PER_MINUTE
  );
}

/**
 * @brief 验证同一时刻到期时护眼提醒优先，且队列不会重复添加同类型。
 */
function verifyDuePriorityAndQueueDeduplication(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  fixture.clock.advance(STANDING_REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();

  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.EyeRest
  );
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), [
    ReminderType.Standing
  ]);
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.Queued
  );

  fixture.timerScheduler.runDue();
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), [
    ReminderType.Standing
  ]);
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    }
  ]);

  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    true
  );
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.Standing
  );
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), []);
}

/**
 * @brief 验证锁屏和睡眠会同时冻结两条轨道的剩余时间。
 */
function verifySystemPauseKeepsBothRemainders(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  fixture.clock.advance(5 * MILLISECONDS_PER_MINUTE);

  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked }),
    true
  );
  assert.equal(fixture.scheduler.isSystemPaused(), true);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.EyeRest),
    15 * MILLISECONDS_PER_MINUTE
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    25 * MILLISECONDS_PER_MINUTE
  );

  fixture.clock.advance(60 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.deepEqual(fixture.events, []);
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({
      type: SystemEventType.SystemSuspended
    }),
    true
  );
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserUnlocked }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemResumed }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 2);

  fixture.clock.advance(15 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.EyeRest
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.Waiting
  );
}

/**
 * @brief 验证系统暂停发生在弹窗展示期间时不会关闭当前弹窗。
 */
function verifySystemPauseKeepsVisibleReminder(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked });

  fixture.clock.advance(30 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.EyeRest
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    10 * MILLISECONDS_PER_MINUTE
  );
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    }
  ]);

  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserUnlocked });
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    true
  );
  assert.equal(fixture.scheduler.getState(ReminderType.EyeRest), ReminderState.Waiting);
}

/**
 * @brief 验证手动暂停会隐藏当前弹窗，但保留待处理队列。
 */
function verifyManualPauseKeepsQueue(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  fixture.clock.advance(STANDING_REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Pause }),
    true
  );
  assert.equal(fixture.scheduler.isManuallyPaused(), true);
  assert.equal(fixture.scheduler.getState(ReminderType.EyeRest), ReminderState.Paused);
  assert.equal(
    fixture.scheduler.getState(ReminderType.Standing),
    ReminderState.Queued
  );
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), [
    ReminderType.Standing
  ]);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    },
    { type: ReminderOutputEventType.Hide }
  ]);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Resume }),
    true
  );
  assert.equal(fixture.scheduler.isManuallyPaused(), false);
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.Standing
  );
  assert.equal(
    fixture.scheduler.getState(ReminderType.EyeRest),
    ReminderState.Waiting
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
}

/**
 * @brief 验证立即提醒始终作用于护眼轨道。
 */
function verifyImmediateEyeReminder(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.RemindNow }),
    true
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.RemindNow }),
    true
  );
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.EyeRest
  );
  assert.deepEqual(fixture.events, [
    {
      type: ReminderOutputEventType.Show,
      reminderType: ReminderType.EyeRest
    },
    {
      type: ReminderOutputEventType.BringToFront,
      reminderType: ReminderType.EyeRest
    }
  ]);

  fixture.scheduler.dispatch({
    type: ReminderCommandType.Complete,
    reminderType: ReminderType.EyeRest
  });
  fixture.clock.advance(20 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  fixture.scheduler.dispatch({
    type: ReminderCommandType.Complete,
    reminderType: ReminderType.EyeRest
  });
  fixture.clock.advance(10 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.getCurrentReminderType(),
    ReminderType.Standing
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.RemindNow }),
    true
  );
  assert.deepEqual(fixture.scheduler.getPendingReminderTypes(), [
    ReminderType.EyeRest
  ]);
}

/**
 * @brief 验证停止后再次启动会为两条轨道重新开始完整周期。
 */
function verifyRestartStartsFreshCycles(): void
{
  const fixture = createSchedulerFixture();
  fixture.scheduler.start();
  fixture.clock.advance(5 * MILLISECONDS_PER_MINUTE);
  fixture.scheduler.stop();
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);

  assert.equal(fixture.scheduler.start(), true);
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.EyeRest),
    REMINDER_INTERVAL_MILLISECONDS
  );
  assert.equal(
    fixture.scheduler.getNextReminderRemainingMilliseconds(ReminderType.Standing),
    STANDING_REMINDER_INTERVAL_MILLISECONDS
  );
}

/**
 * @brief 验证无效操作不会改变提醒状态。
 */
function verifyInvalidCommands(): void
{
  const fixture = createSchedulerFixture();
  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    false
  );
  fixture.scheduler.start();
  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Complete,
      reminderType: ReminderType.EyeRest
    }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatch({
      type: ReminderCommandType.Snooze,
      reminderType: ReminderType.Standing
    }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Resume }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Pause }),
    true
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Pause }),
    false
  );
  assert.deepEqual(fixture.events, []);
}

test("core model supports typed reminders", verifyCoreModel);
test("independent reminder cycles", verifyIndependentReminderCycles);
test("typed actions remain independent", verifyActionsRemainIndependent);
test("due priority and queue deduplication", verifyDuePriorityAndQueueDeduplication);
test("system pause keeps both remainders", verifySystemPauseKeepsBothRemainders);
test("system pause keeps visible reminder", verifySystemPauseKeepsVisibleReminder);
test("manual pause keeps pending queue", verifyManualPauseKeepsQueue);
test("immediate reminder targets eye rest", verifyImmediateEyeReminder);
test("restart starts fresh cycles", verifyRestartStartsFreshCycles);
test("invalid scheduler commands", verifyInvalidCommands);
