/**
 * @brief 定义主进程与预加载脚本共用的 IPC 通道名称。
 *
 * 通道常量集中在不依赖 Electron 的核心目录中，避免渲染层直接拼接
 * 通道字符串，也让后续业务模块可以在不加载 Electron 的情况下测试。
 */
export const IPC_CHANNELS = {
  getRuntimeInfo: "app:get-runtime-info",
  completeReminder: "reminder:complete",
  snoozeReminder: "reminder:snooze",
  loadSettings: "settings:load",
  saveSettings: "settings:save"
} as const;

/**
 * @brief 描述 IPC 通道对象的编译期结构。
 *
 * 预加载脚本在 Electron 沙箱中不能运行时加载本地业务模块，因此会保留一份
 * 自包含的通道值；该类型让两份定义在编译期保持字段和值完全一致。
 */
export type IpcChannels = typeof IPC_CHANNELS;

/**
 * @brief 描述可通过安全 IPC 边界公开给渲染进程的最小运行时信息。
 */
export interface RuntimeInfo {
  platform: string;
}
