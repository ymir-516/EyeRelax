import { contextBridge, ipcRenderer } from "electron";
import type { IpcChannels, RuntimeInfo } from "../core/ipc.js";
import type { ReminderSettings } from "../core/model.js";

/**
 * @brief 定义沙箱预加载脚本可以直接使用的 IPC 通道。
 *
 * 沙箱 preload 只能加载受限的内置模块，不能依赖运行时 require 加载
 * `src/core` 文件；通道类型仍由核心契约校验，避免值在两处发生漂移。
 */
const IPC_CHANNELS: IpcChannels = {
  getRuntimeInfo: "app:get-runtime-info",
  completeReminder: "reminder:complete",
  snoozeReminder: "reminder:snooze",
  loadSettings: "settings:load",
  saveSettings: "settings:save"
};

/**
 * @brief 定义渲染进程可以使用的最小安全 API。
 */
interface ElectronApi
{
  /**
   * @brief 请求主进程返回运行时信息。
   */
  getRuntimeInfo(): Promise<RuntimeInfo>;

  /**
   * @brief 通知主进程用户已完成休息。
   */
  completeReminder(): Promise<boolean>;

  /**
   * @brief 通知主进程用户要推迟休息。
   */
  snoozeReminder(): Promise<boolean>;

  /**
   * @brief 读取当前设置。
   */
  loadSettings(): Promise<ReminderSettings>;

  /**
   * @brief 提交设置保存请求。
   */
  saveSettings(settings: unknown): Promise<ReminderSettings>;
}

const electronApi: ElectronApi = {
  /**
   * @brief 通过固定 IPC 通道转发运行时信息请求。
   */
  getRuntimeInfo(): Promise<RuntimeInfo>
  {
    return ipcRenderer.invoke(IPC_CHANNELS.getRuntimeInfo);
  },

  /**
   * @brief 通过受限 IPC 提交完成休息动作。
   */
  completeReminder(): Promise<boolean>
  {
    return ipcRenderer.invoke(IPC_CHANNELS.completeReminder);
  },

  /**
   * @brief 通过受限 IPC 提交推迟休息动作。
   */
  snoozeReminder(): Promise<boolean>
  {
    return ipcRenderer.invoke(IPC_CHANNELS.snoozeReminder);
  },

  /**
   * @brief 通过固定 IPC 通道读取设置。
   */
  loadSettings(): Promise<ReminderSettings>
  {
    return ipcRenderer.invoke(IPC_CHANNELS.loadSettings);
  },

  /**
   * @brief 通过固定 IPC 通道提交设置保存请求。
   */
  saveSettings(settings: unknown): Promise<ReminderSettings>
  {
    return ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings);
  }
};

contextBridge.exposeInMainWorld("electronApi", electronApi);

declare global {
  interface Window {
    electronApi: ElectronApi;
  }
}
