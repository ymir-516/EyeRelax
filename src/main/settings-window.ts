import type { ReminderSettings } from "../core/model.js";

/**
 * @brief 设置窗口的固定初始尺寸。
 */
export const SETTINGS_WINDOW_WIDTH = 460;
export const SETTINGS_WINDOW_HEIGHT = 360;

/**
 * @brief 设置窗口创建所需的最小平台参数。
 */
export interface SettingsWindowCreationOptions {
  width: number;
  height: number;
  modal: boolean;
  resizable: boolean;
  show: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  minimizable: boolean;
  maximizable: boolean;
}

/**
 * @brief 设置窗口关闭事件的最小抽象。
 */
export interface SettingsWindowCloseEvent {
  preventDefault(): void;
}

/**
 * @brief Electron BrowserWindow 的可测试最小接口。
 */
export interface SettingsWindowHandle {
  onClose(listener: (event: SettingsWindowCloseEvent) => void): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  load(settings: ReminderSettings): void;
  show(): void;
  hide(): void;
  restore(): void;
  focus(): void;
  destroy(): void;
}

/**
 * @brief 设置窗口需要的平台能力。
 */
export interface SettingsWindowHost {
  createWindow(options: SettingsWindowCreationOptions): SettingsWindowHandle;
}

/**
 * @brief 设置窗口控制器依赖。
 */
export interface SettingsWindowControllerOptions {
  host: SettingsWindowHost;
  getSettings(): ReminderSettings;
}

/**
 * @brief 管理唯一的设置窗口并将关闭动作转换为隐藏动作。
 *
 * 设置窗口不是后台应用的生命周期开关。拦截用户关闭事件并隐藏现有窗口，
 * 可以让托盘重复打开时复用同一窗口，同时避免窗口关闭触发 Electron 退出。
 */
export class SettingsWindowController
{
  private started = false;
  private settingsWindow: SettingsWindowHandle | undefined;
  private allowClose = false;

  /**
   * @brief 创建设置窗口控制器。
   */
  constructor(private readonly options: SettingsWindowControllerOptions)
  {
  }

  /**
   * @brief 启用设置窗口控制器。
   */
  start(): void
  {
    if (this.started)
      return;

    this.started = true;
  }

  /**
   * @brief 显示设置窗口并加载当前设置。
   */
  show(settings?: ReminderSettings): void
  {
    if (!this.started)
      return;

    const existingWindow = this.getExistingWindow();
    if (existingWindow !== undefined) {
      this.bringToFront();
      return;
    }

    const settingsWindow = this.getOrCreateWindow();
    settingsWindow.load({ ...(settings ?? this.options.getSettings()) });
    settingsWindow.show();
    settingsWindow.focus();
  }

  /**
   * @brief 隐藏设置窗口但保留窗口实例。
   */
  hide(): void
  {
    this.getExistingWindow()?.hide();
  }

  /**
   * @brief 将已有设置窗口恢复、显示并置前。
   */
  bringToFront(): void
  {
    const settingsWindow = this.getExistingWindow();
    if (settingsWindow === undefined)
      return;

    if (settingsWindow.isMinimized())
      settingsWindow.restore();

    settingsWindow.show();
    settingsWindow.focus();
  }

  /**
   * @brief 停止控制器并强制销毁设置窗口。
   */
  stop(): void
  {
    this.started = false;
    this.allowClose = true;

    const settingsWindow = this.settingsWindow;
    this.settingsWindow = undefined;
    if (settingsWindow !== undefined && !settingsWindow.isDestroyed())
      settingsWindow.destroy();

    this.allowClose = false;
  }

  /**
   * @brief 返回控制器是否已经启动。
   */
  isStarted(): boolean
  {
    return this.started;
  }

  /**
   * @brief 获取或创建唯一设置窗口。
   */
  private getOrCreateWindow(): SettingsWindowHandle
  {
    const existingWindow = this.getExistingWindow();
    if (existingWindow !== undefined)
      return existingWindow;

    const settingsWindow = this.options.host.createWindow({
      width: SETTINGS_WINDOW_WIDTH,
      height: SETTINGS_WINDOW_HEIGHT,
      modal: false,
      resizable: false,
      show: false,
      alwaysOnTop: false,
      skipTaskbar: false,
      minimizable: true,
      maximizable: false
    });

    settingsWindow.onClose((event): void => {
      if (this.allowClose)
        return;

      event.preventDefault();
      settingsWindow.hide();
    });
    this.settingsWindow = settingsWindow;
    return settingsWindow;
  }

  /**
   * @brief 返回仍然可用的设置窗口。
   */
  private getExistingWindow(): SettingsWindowHandle | undefined
  {
    if (this.settingsWindow?.isDestroyed() === true)
      this.settingsWindow = undefined;

    return this.settingsWindow;
  }
}
