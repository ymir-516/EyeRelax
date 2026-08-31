/**
 * @brief 定义提醒业务可以处于的状态集合。
 *
 * 状态值使用稳定的小写字符串，便于后续通过 IPC 或测试记录状态，且不
 * 让核心模型依赖 Electron、DOM 或具体窗口实现。
 */
export const ReminderState = {
  Waiting: "waiting",
  ReminderVisible: "reminder-visible",
  Snoozed: "snoozed",
  Queued: "queued",
  Paused: "paused"
} as const;

/**
 * @brief 提醒状态类型。
 */
export type ReminderState = typeof ReminderState[keyof typeof ReminderState];

/**
 * @brief 提醒类型。
 *
 * 护眼和站立提醒使用独立的计时周期，但共用同一个提醒窗口。
 */
export const ReminderType = {
  EyeRest: "eye-rest",
  Standing: "standing"
} as const;

/**
 * @brief 提醒类型值。
 */
export type ReminderTypeValue = typeof ReminderType[keyof typeof ReminderType];

/**
 * @brief 判断未知值是否为合法的提醒类型。
 *
 * IPC 参数来自渲染进程，必须在主进程边界重新校验，避免把任意字符串
 * 传入调度器。
 */
export function isReminderType(value: unknown): value is ReminderTypeValue
{
  return value === ReminderType.EyeRest || value === ReminderType.Standing;
}

/**
 * @brief 定义调度器可以接收的业务命令类型。
 */
export const ReminderCommandType = {
  Complete: "complete",
  Snooze: "snooze",
  RemindNow: "remind-now",
  Pause: "pause",
  Resume: "resume"
} as const;

/**
 * @brief 提醒命令的联合类型。
 */
export type ReminderCommand =
  | {
      type: typeof ReminderCommandType.Complete;
      reminderType: ReminderTypeValue;
    }
  | {
      type: typeof ReminderCommandType.Snooze;
      reminderType: ReminderTypeValue;
    }
  | { type: typeof ReminderCommandType.RemindNow }
  | { type: typeof ReminderCommandType.Pause }
  | { type: typeof ReminderCommandType.Resume };

/**
 * @brief 定义调度器向窗口管理边界发出的输出事件类型。
 */
export const ReminderOutputEventType = {
  Show: "show",
  Hide: "hide",
  BringToFront: "bring-to-front"
} as const;

/**
 * @brief 提醒输出事件的联合类型。
 */
export type ReminderOutputEvent =
  | {
      type: typeof ReminderOutputEventType.Show;
      reminderType: ReminderTypeValue;
    }
  | { type: typeof ReminderOutputEventType.Hide }
  | {
      type: typeof ReminderOutputEventType.BringToFront;
      reminderType: ReminderTypeValue;
    };

/**
 * @brief 定义平台层转换后供核心模块消费的系统事件类型。
 */
export const SystemEventType = {
  UserLocked: "user-locked",
  UserUnlocked: "user-unlocked",
  SystemSuspended: "system-suspended",
  SystemResumed: "system-resumed"
} as const;

/**
 * @brief 平台无关系统事件的联合类型。
 */
export type SystemEvent =
  | { type: typeof SystemEventType.UserLocked }
  | { type: typeof SystemEventType.UserUnlocked }
  | { type: typeof SystemEventType.SystemSuspended }
  | { type: typeof SystemEventType.SystemResumed };

/**
 * @brief 定义本期设置模型的字段边界。
 *
 * 字段校验和持久化由 T04 的 SettingsStore 实现；本模型只提供供调度器和
 * 设置服务共同使用的数据契约，避免把文件系统行为耦合到核心模型。
 */
export interface ReminderSettings {
  snoozeMinutes: number;
  autoStart: boolean;
  eyeRestIntervalMinutes: number;
  standingIntervalMinutes: number;
}

/**
 * @brief 提供需求规定的默认设置。
 */
export const DEFAULT_SETTINGS: Readonly<ReminderSettings> = Object.freeze({
  snoozeMinutes: 3,
  autoStart: true,
  eyeRestIntervalMinutes: 20,
  standingIntervalMinutes: 30
});
