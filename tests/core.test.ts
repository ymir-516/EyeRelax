import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  ReminderCommandType,
  ReminderOutputEventType,
  ReminderState,
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
  ReminderScheduler
} from "../src/core/reminder-scheduler.js";

/**
 * @brief 提供测试可以手动推进的单调时间替身。
 */
class ManualClock implements MonotonicClock
{
  private currentMilliseconds = 0;

  /**
   * @brief 返回当前测试时间。
   */
  now(): number
  {
    return this.currentMilliseconds;
  }

  /**
   * @brief 将测试时间向前推进指定毫秒数。
   */
  advance(milliseconds: number): void
  {
    assert.ok(milliseconds >= 0);
    this.currentMilliseconds += milliseconds;
  }
}

interface ScheduledTimer
{
  dueAt: number;
  callback: () => void;
  cancelled: boolean;
  fired: boolean;
}

/**
 * @brief 提供测试可以手动触发到期回调的一次性计时器替身。
 */
class ManualTimerScheduler implements OneShotTimerScheduler
{
  private readonly timers: ScheduledTimer[] = [];

  /**
   * @brief 创建一个由测试时间控制的一次性计时器。
   */
  constructor(private readonly clock: MonotonicClock)
  {
  }

  /**
   * @brief 记录计时器，实际回调由 runDue 手动触发。
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
   * @brief 触发当前测试时间已经到期的计时器。
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
   * @brief 返回当前尚未完成或取消的测试计时器数量。
   */
  pendingTimerCount(): number
  {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired).length;
  }
}

/**
 * @brief 组合调度器测试所需的可控时钟、计时器和输出事件。
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
 * @brief 创建不依赖真实时间和 Electron 的调度器测试夹具。
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
 * @brief 验证 T02 定义的状态、命令、输出事件和系统事件可以表达需求边界。
 */
function verifyCoreModel(): void
{
  assert.deepEqual(Object.values(ReminderState), [
    "waiting",
    "reminder-visible",
    "snoozed",
    "paused"
  ]);
  assert.deepEqual(DEFAULT_SETTINGS, {
    snoozeMinutes: 3,
    autoStart: true
  });

  const commands: ReminderCommand[] = [
    { type: ReminderCommandType.Complete },
    { type: ReminderCommandType.Snooze },
    { type: ReminderCommandType.RemindNow },
    { type: ReminderCommandType.Pause },
    { type: ReminderCommandType.Resume }
  ];
  const outputEvents: ReminderOutputEvent[] = [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide },
    { type: ReminderOutputEventType.BringToFront }
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
 * @brief 验证测试可以推进 20 分钟而无需真实等待，并且计时器只触发一次。
 */
function verifyManualTimeProgression(): void
{
  const clock = new ManualClock();
  const scheduler = new ManualTimerScheduler(clock);
  let firedCount = 0;

  scheduler.schedule(20 * MILLISECONDS_PER_MINUTE, () => {
    firedCount += 1;
  });

  clock.advance(20 * MILLISECONDS_PER_MINUTE - 1);
  scheduler.runDue();
  assert.equal(firedCount, 0);

  clock.advance(1);
  scheduler.runDue();
  scheduler.runDue();
  assert.equal(firedCount, 1);
}

/**
 * @brief 验证取消计时器后推进时间不会触发其回调。
 */
function verifyTimerCancellation(): void
{
  const clock = new ManualClock();
  const scheduler = new ManualTimerScheduler(clock);
  let fired = false;
  const timer = scheduler.schedule(1000, () => {
    fired = true;
  });

  timer.cancel();
  clock.advance(1000);
  scheduler.runDue();

  assert.equal(fired, false);
}

/**
 * @brief 验证首次提醒、已休息和下一个正常周期的状态转换。
 */
function verifyNormalReminderCycle(): void
{
  const fixture = createSchedulerFixture();

  assert.equal(fixture.scheduler.start(), true);
  assert.equal(fixture.scheduler.start(), false);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show }
  ]);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide }
  ]);

  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide },
    { type: ReminderOutputEventType.Show }
  ]);
}

/**
 * @brief 验证推迟、重复推迟不会被当作已休息，并按设置重新提醒。
 */
function verifySnoozeAndRepeatedSnooze(): void
{
  const fixture = createSchedulerFixture();
  const snoozeMilliseconds = DEFAULT_SETTINGS.snoozeMinutes *
    MILLISECONDS_PER_MINUTE;

  fixture.scheduler.start();
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);

  fixture.clock.advance(snoozeMilliseconds - 1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);

  fixture.clock.advance(1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);

  fixture.clock.advance(snoozeMilliseconds);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide },
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide },
    { type: ReminderOutputEventType.Show }
  ]);
}

/**
 * @brief 验证修改设置不会改变已经开始的推迟倒计时。
 */
function verifySettingsChangeDoesNotResetSnooze(): void
{
  const fixture = createSchedulerFixture();

  fixture.scheduler.start();
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );

  fixture.settings.snoozeMinutes = 10;
  fixture.clock.advance(DEFAULT_SETTINGS.snoozeMinutes * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();

  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
}

/**
 * @brief 验证锁屏和睡眠期间不消耗 Waiting 状态的剩余时间。
 */
function verifySystemPauseKeepsWaitingRemainder(): void
{
  const fixture = createSchedulerFixture();

  fixture.scheduler.start();
  fixture.clock.advance(5 * MILLISECONDS_PER_MINUTE);
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);

  fixture.clock.advance(30 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.deepEqual(fixture.events, []);

  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemSuspended }),
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
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);

  fixture.clock.advance(15 * MILLISECONDS_PER_MINUTE - 1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  fixture.clock.advance(1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
}

/**
 * @brief 验证调度器启动前收到的系统暂停事件不会启动错误计时。
 */
function verifySystemPauseBeforeSchedulerStart(): void
{
  const fixture = createSchedulerFixture();

  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked }),
    true
  );
  assert.equal(fixture.scheduler.start(), true);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);

  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);

  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserUnlocked }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
}

/**
 * @brief 验证推迟中的剩余时间在睡眠恢复后继续使用。
 */
function verifySystemPauseKeepsSnoozeRemainder(): void
{
  const fixture = createSchedulerFixture();

  fixture.scheduler.start();
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );

  fixture.clock.advance(1 * MILLISECONDS_PER_MINUTE);
  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemSuspended }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);

  fixture.clock.advance(20 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);

  assert.equal(
    fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemResumed }),
    true
  );
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
  fixture.clock.advance(2 * MILLISECONDS_PER_MINUTE - 1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);
  fixture.clock.advance(1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
}

/**
 * @brief 验证待处理提醒在锁屏和解锁后仍保持待处理状态。
 */
function verifySystemPauseKeepsVisibleReminder(): void
{
  const fixture = createSchedulerFixture();

  fixture.scheduler.start();
  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);

  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserLocked });
  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemSuspended });
  fixture.clock.advance(30 * MILLISECONDS_PER_MINUTE);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show }
  ]);

  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.UserUnlocked });
  fixture.scheduler.dispatchSystemEvent({ type: SystemEventType.SystemResumed });
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide }
  ]);
}

/**
 * @brief 验证暂停会取消等待，恢复会重新开始完整的 20 分钟周期。
 */
function verifyPauseAndResume(): void
{
  const fixture = createSchedulerFixture();

  fixture.scheduler.start();
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Pause }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Paused);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 0);

  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Paused);
  assert.deepEqual(fixture.events, []);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Resume }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.equal(fixture.timerScheduler.pendingTimerCount(), 1);

  fixture.clock.advance(REMINDER_INTERVAL_MILLISECONDS - 1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);

  fixture.clock.advance(1);
  fixture.timerScheduler.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Pause }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Paused);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide }
  ]);
}

/**
 * @brief 验证立即提醒只显示一次，重复请求只置前已有提醒。
 */
function verifyImmediateReminder(): void
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
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(fixture.events, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.BringToFront }
  ]);
}

/**
 * @brief 验证未启动或当前状态不允许的命令会被拒绝且不产生事件。
 */
function verifyInvalidCommands(): void
{
  const fixture = createSchedulerFixture();

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    false
  );
  fixture.scheduler.start();
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    false
  );
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
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

test("core model baseline", verifyCoreModel);
test("manual monotonic time progression", verifyManualTimeProgression);
test("one-shot timer cancellation", verifyTimerCancellation);
test("normal reminder cycle", verifyNormalReminderCycle);
test("snooze and repeated snooze", verifySnoozeAndRepeatedSnooze);
test("settings change does not reset active snooze", verifySettingsChangeDoesNotResetSnooze);
test("system pause keeps waiting remainder", verifySystemPauseKeepsWaitingRemainder);
test("system pause before scheduler start", verifySystemPauseBeforeSchedulerStart);
test("system pause keeps snooze remainder", verifySystemPauseKeepsSnoozeRemainder);
test("system pause keeps visible reminder", verifySystemPauseKeepsVisibleReminder);
test("pause and resume", verifyPauseAndResume);
test("immediate reminder", verifyImmediateReminder);
test("invalid scheduler commands", verifyInvalidCommands);
