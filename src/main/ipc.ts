import { ipcMain } from "electron";
import {
  IPC_CHANNELS,
  type RuntimeInfo
} from "../core/ipc.js";
import type { ReminderSettings } from "../core/model.js";

/**
 * @brief 提醒窗口可调用的主进程动作。
 */
export interface ReminderIpcHandlers {
  completeReminder(): boolean;
  snoozeReminder(): boolean;
}

/**
 * @brief 设置窗口可调用的主进程动作。
 */
export interface SettingsIpcHandlers {
  loadSettings(): ReminderSettings;
  saveSettings(value: unknown): Promise<ReminderSettings>;
}

/**
 * @brief 返回主进程允许公开的最小运行时信息。
 *
 * 运行时信息只用于验证 IPC 边界是否可用，不承载业务状态，避免在
 * T01 阶段让主进程和渲染进程形成不必要的耦合。
 */
function getRuntimeInfo(): RuntimeInfo
{
  return {
    platform: process.platform
  };
}

/**
 * @brief 注册正式应用使用的最小 IPC 处理器集合。
 */
export function registerIpcHandlers(
  handlers: ReminderIpcHandlers & SettingsIpcHandlers
): void
{
  ipcMain.handle(IPC_CHANNELS.getRuntimeInfo, getRuntimeInfo);
  ipcMain.handle(
    IPC_CHANNELS.completeReminder,
    (): boolean => handlers.completeReminder()
  );
  ipcMain.handle(
    IPC_CHANNELS.snoozeReminder,
    (): boolean => handlers.snoozeReminder()
  );
  ipcMain.handle(
    IPC_CHANNELS.loadSettings,
    (): ReminderSettings => handlers.loadSettings()
  );
  ipcMain.handle(
    IPC_CHANNELS.saveSettings,
    (_event, value: unknown): Promise<ReminderSettings> => {
      return handlers.saveSettings(value);
    }
  );
}

/**
 * @brief 注销应用退出时不应继续存在的 IPC 处理器。
 */
export function unregisterIpcHandlers(): void
{
  ipcMain.removeHandler(IPC_CHANNELS.getRuntimeInfo);
  ipcMain.removeHandler(IPC_CHANNELS.completeReminder);
  ipcMain.removeHandler(IPC_CHANNELS.snoozeReminder);
  ipcMain.removeHandler(IPC_CHANNELS.loadSettings);
  ipcMain.removeHandler(IPC_CHANNELS.saveSettings);
}
