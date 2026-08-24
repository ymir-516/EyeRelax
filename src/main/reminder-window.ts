/**
 * @brief 提醒窗口的固定尺寸。
 */
export const REMINDER_WINDOW_WIDTH = 420;
export const REMINDER_WINDOW_HEIGHT = 240;
export const REMINDER_WINDOW_MARGIN = 16;

/**
 * @brief 屏幕坐标点。
 */
export interface ReminderPoint {
  x: number;
  y: number;
}

/**
 * @brief 提醒窗口需要使用的工作区。
 */
export interface ReminderWorkArea extends ReminderPoint {
  width: number;
  height: number;
}

/**
 * @brief 提醒窗口创建参数。
 */
export interface ReminderWindowCreationOptions {
  width: number;
  height: number;
  frame: boolean;
  modal: boolean;
  resizable: boolean;
  show: boolean;
  alwaysOnTop: boolean;
  skipTaskbar: boolean;
  minimizable: boolean;
  maximizable: boolean;
}

/**
 * @brief 提醒窗口关闭事件的最小抽象。
 */
export interface ReminderWindowCloseEvent {
  preventDefault(): void;
}

/**
 * @brief Electron BrowserWindow 的可测试最小接口。
 */
export interface ReminderWindowHandle {
  onClose(listener: (event: ReminderWindowCloseEvent) => void): void;
  isDestroyed(): boolean;
  isMinimized(): boolean;
  load(snoozeMinutes: number): void;
  setPosition(x: number, y: number): void;
  show(): void;
  hide(): void;
  restore(): void;
  focus(): void;
  destroy(): void;
}

/**
 * @brief 提醒窗口所需的平台能力。
 */
export interface ReminderWindowHost {
  createWindow(options: ReminderWindowCreationOptions): ReminderWindowHandle;
  getCursorScreenPoint(): ReminderPoint;
  getDisplayNearestPoint(point: ReminderPoint): ReminderWorkArea;
}

/**
 * @brief 计算提醒窗口在目标屏幕工作区右下角的位置。
 *
 * 使用工作区而不是完整屏幕尺寸，确保窗口不会覆盖任务栏；同时对异常小工作区做边界
 * 夹取，避免多显示器或缩放环境下出现负方向坐标偏移。
 */
export function calculateReminderWindowPosition(
  workArea: ReminderWorkArea,
  width = REMINDER_WINDOW_WIDTH,
  height = REMINDER_WINDOW_HEIGHT,
  margin = REMINDER_WINDOW_MARGIN
): ReminderPoint
{
  const horizontalOffset = Math.max(0, workArea.width - width - margin);
  const verticalOffset = Math.max(0, workArea.height - height - margin);

  return {
    x: workArea.x + horizontalOffset,
    y: workArea.y + verticalOffset
  };
}

/**
 * @brief 提醒窗口控制器的依赖。
 */
export interface ReminderWindowControllerOptions {
  host: ReminderWindowHost;
  getSnoozeMinutes(): number;
}

/**
 * @brief 管理唯一的提醒 BrowserWindow，并屏蔽非业务关闭路径。
 *
 * 窗口由调度器的输出事件驱动。关闭事件在控制器中统一拦截，退出流程通过 destroy
 * 绕过拦截，从而保证“已休息”和“推迟”是提醒窗口唯一的业务消失路径。
 */
export class ReminderWindowController
{
  private started = false;
  private reminderWindow: ReminderWindowHandle | undefined;
  private allowClose = false;

  /**
   * @brief 创建提醒窗口控制器。
   */
  constructor(private readonly options: ReminderWindowControllerOptions)
  {
  }

  /**
   * @brief 启用窗口控制器。
   */
  start(): void
  {
    if (this.started)
      return;

    this.started = true;
  }

  /**
   * @brief 显示提醒窗口并定位到鼠标所在屏幕右下角。
   */
  show(): void
  {
    if (!this.started)
      return;

    const reminderWindow = this.getOrCreateWindow();
    const cursorPoint = this.options.host.getCursorScreenPoint();
    const workArea = this.options.host.getDisplayNearestPoint(cursorPoint);
    const position = calculateReminderWindowPosition(workArea);

    reminderWindow.setPosition(position.x, position.y);
    reminderWindow.load(this.options.getSnoozeMinutes());
    reminderWindow.show();
  }

  /**
   * @brief 隐藏提醒窗口。
   */
  hide(): void
  {
    const reminderWindow = this.getExistingWindow();
    reminderWindow?.hide();
  }

  /**
   * @brief 将已有提醒窗口恢复、显示并聚焦。
   */
  bringToFront(): void
  {
    const reminderWindow = this.getExistingWindow();
    if (reminderWindow === undefined)
      return;

    if (reminderWindow.isMinimized())
      reminderWindow.restore();

    reminderWindow.show();
    reminderWindow.focus();
  }

  /**
   * @brief 停止控制器并强制销毁提醒窗口。
   */
  stop(): void
  {
    this.started = false;
    this.allowClose = true;

    const reminderWindow = this.reminderWindow;
    this.reminderWindow = undefined;
    if (reminderWindow !== undefined && !reminderWindow.isDestroyed())
      reminderWindow.destroy();

    this.allowClose = false;
  }

  /**
   * @brief 获取或创建唯一提醒窗口。
   */
  private getOrCreateWindow(): ReminderWindowHandle
  {
    const existingWindow = this.getExistingWindow();
    if (existingWindow !== undefined)
      return existingWindow;

    const reminderWindow = this.options.host.createWindow({
      width: REMINDER_WINDOW_WIDTH,
      height: REMINDER_WINDOW_HEIGHT,
      frame: false,
      modal: false,
      resizable: false,
      show: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false
    });

    reminderWindow.onClose((event): void => {
      if (!this.allowClose)
        event.preventDefault();
    });
    this.reminderWindow = reminderWindow;
    return reminderWindow;
  }

  /**
   * @brief 返回仍然可用的提醒窗口。
   */
  private getExistingWindow(): ReminderWindowHandle | undefined
  {
    if (this.reminderWindow?.isDestroyed() === true)
      this.reminderWindow = undefined;

    return this.reminderWindow;
  }
}
