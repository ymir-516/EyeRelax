import {
  ReminderCommandType,
  ReminderState,
  type ReminderCommand,
  type ReminderState as ReminderStateValue
} from "../core/model.js";
import {
  type OneShotTimer,
  type OneShotTimerScheduler
} from "../core/clock.js";

/**
 * @brief 托盘倒计时的显示刷新周期。
 */
const COUNTDOWN_REFRESH_MILLISECONDS = 1000;

/**
 * @brief 将剩余毫秒数格式化为用户可读的分钟和秒数。
 */
function formatCountdown(remainingMilliseconds: number): string
{
  const totalSeconds = Math.max(0, Math.ceil(remainingMilliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * @brief 表示托盘图标应该呈现的运行状态。
 */
export type TrayVisualState = "running" | "paused";

/**
 * @brief 表示可交给平台菜单构建器的托盘菜单项。
 */
export interface TrayMenuItem {
  type?: "normal" | "separator";
  label?: string;
  enabled?: boolean;
  click?: () => void;
}

/**
 * @brief 表示平台菜单对象的最小不透明类型。
 */
export type TrayMenu = object;

/**
 * @brief 抽象系统托盘实例需要的操作。
 */
export interface TrayHandle {
  /**
   * @brief 更新托盘图标。
   */
  setImage(state: TrayVisualState): void;

  /**
   * @brief 更新托盘提示文本。
   */
  setToolTip(toolTip: string): void;

  /**
   * @brief 更新托盘右键菜单。
   */
  setContextMenu(menu: TrayMenu): void;

  /**
   * @brief 销毁托盘图标。
   */
  destroy(): void;
}

/**
 * @brief 抽象 Electron Tray 和 Menu 的创建能力。
 */
export interface TrayHost {
  /**
   * @brief 创建一个平台托盘实例。
   */
  createTray(): TrayHandle;

  /**
   * @brief 根据菜单模板创建平台菜单对象。
   */
  buildContextMenu(template: readonly TrayMenuItem[]): TrayMenu;
}

/**
 * @brief 抽象托盘可以调用的提醒调度器能力。
 */
export interface TrayScheduler {
  /**
   * @brief 返回当前提醒状态。
   */
  getState(): ReminderStateValue;

  /**
   * @brief 获取下次提醒的剩余毫秒数。
   */
  getNextReminderRemainingMilliseconds(): number | undefined;

  /**
   * @brief 判断系统是否因锁屏或睡眠处于暂停状态。
   */
  isSystemPaused(): boolean;

  /**
   * @brief 向提醒调度器发送托盘命令。
   */
  dispatch(command: ReminderCommand): boolean;
}

/**
 * @brief 托盘控制器的外部动作回调。
 */
export interface TrayControllerOptions {
  host: TrayHost;
  scheduler: TrayScheduler;
  timerScheduler: OneShotTimerScheduler;
  openSettings: () => void;
  quit: () => void;
}

/**
 * @brief 管理系统托盘图标、菜单和托盘命令。
 *
 * 控制器不实现计时和提醒状态转换，只把用户操作转发给调度器，并根据
 * 调度器状态重建菜单和更新图标。这样设置窗口和提醒窗口可以复用同一托盘入口，
 * 而不需要托盘直接保存业务状态。
 */
export class TrayController
{
  private started = false;
  private tray: TrayHandle | undefined;
  private countdownTimer: OneShotTimer | undefined;

  /**
   * @brief 创建托盘控制器。
   */
  constructor(private readonly options: TrayControllerOptions)
  {
  }

  /**
   * @brief 创建托盘并安装初始菜单。
   *
   * 重复启动不会创建第二个托盘图标。
   */
  start(): void
  {
    if (this.started)
      return;

    this.started = true;

    try {
      this.tray = this.options.host.createTray();
      this.refresh();
      this.scheduleCountdownRefresh();
    } catch (error) {
      this.cancelCountdownRefresh();
      this.tray?.destroy();
      this.started = false;
      this.tray = undefined;
      throw error;
    }
  }

  /**
   * @brief 更新托盘图标、提示文本和菜单状态。
   *
   * 调度器状态由其他入口改变时，主进程可以显式调用此方法同步托盘。
   */
  refresh(): void
  {
    if (!this.started || this.tray === undefined)
      return;

    const state = this.options.scheduler.getState();
    const paused = state === ReminderState.Paused;
    const visualState: TrayVisualState = paused ? "paused" : "running";

    this.tray.setImage(visualState);
    this.tray.setToolTip(this.createToolTip(state));
    this.tray.setContextMenu(
      this.options.host.buildContextMenu(this.createMenuTemplate(paused))
    );
  }

  /**
   * @brief 销毁托盘并清理控制器状态。
   *
   * 普通退出只销毁当前托盘图标，不修改开机自启或其他持久化设置。
   */
  stop(): void
  {
    if (!this.started)
      return;

    this.started = false;
    this.cancelCountdownRefresh();
    const tray = this.tray;
    this.tray = undefined;
    tray?.destroy();
  }

  /**
   * @brief 返回托盘控制器是否已经启动。
   */
  isStarted(): boolean
  {
    return this.started;
  }

  /**
   * @brief 根据调度器状态生成托盘提示文本。
   *
   * 提示文本只读取调度器状态和剩余时间，避免托盘自行维护另一份倒计时状态。
   */
  private createToolTip(state: ReminderStateValue): string
  {
    if (state === ReminderState.Paused)
      return "护眼提醒 - 已暂停";

    if (state === ReminderState.ReminderVisible)
      return "护眼提醒 - 提醒进行中";

    const remainingMilliseconds =
      this.options.scheduler.getNextReminderRemainingMilliseconds();
    if (remainingMilliseconds === undefined) {
      if (this.options.scheduler.isSystemPaused())
        return "护眼提醒 - 系统暂停";

      return "护眼提醒 - 等待中";
    }

    const pausePrefix = this.options.scheduler.isSystemPaused() ? "系统暂停 - " : "";
    return `护眼提醒 - ${pausePrefix}下次提醒：${formatCountdown(remainingMilliseconds)} 后`;
  }

  /**
   * @brief 启动托盘倒计时的周期性刷新。
   */
  private scheduleCountdownRefresh(): void
  {
    if (!this.started || this.countdownTimer !== undefined)
      return;

    this.countdownTimer = this.options.timerScheduler.schedule(
      COUNTDOWN_REFRESH_MILLISECONDS,
      (): void => {
        this.countdownTimer = undefined;
        if (!this.started || this.tray === undefined)
          return;

        this.tray.setToolTip(
          this.createToolTip(this.options.scheduler.getState())
        );
        this.scheduleCountdownRefresh();
      }
    );
  }

  /**
   * @brief 取消托盘倒计时刷新，避免托盘销毁后仍保留定时器。
   */
  private cancelCountdownRefresh(): void
  {
    this.countdownTimer?.cancel();
    this.countdownTimer = undefined;
  }

  /**
   * @brief 创建当前状态对应的中文托盘菜单。
   */
  private createMenuTemplate(paused: boolean): readonly TrayMenuItem[]
  {
    return [
      {
        label: `状态：${paused ? "已暂停" : "运行中"}`,
        enabled: false
      },
      { type: "separator" },
      {
        label: "立即提醒",
        click: (): void => {
          this.dispatch({ type: ReminderCommandType.RemindNow });
        }
      },
      {
        label: paused ? "恢复提醒" : "暂停提醒",
        click: (): void => {
          this.dispatch({
            type: paused ? ReminderCommandType.Resume : ReminderCommandType.Pause
          });
        }
      },
      {
        label: "设置",
        click: (): void => {
          this.options.openSettings();
        }
      },
      { type: "separator" },
      {
        label: "退出",
        click: (): void => {
          this.options.quit();
        }
      }
    ];
  }

  /**
   * @brief 向调度器发送命令并在状态变化后刷新托盘。
   */
  private dispatch(command: ReminderCommand): void
  {
    this.options.scheduler.dispatch(command);
    this.refresh();
  }
}
