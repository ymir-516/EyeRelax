import assert from "node:assert/strict";
import { test } from "node:test";
import { IPC_CHANNELS } from "../src/core/ipc.js";
import {
  ApplicationLifecycle,
  type ApplicationResources,
  type LifecycleResource
} from "../src/main/lifecycle.js";
import {
  SingleInstanceManager,
  type SingleInstanceHost
} from "../src/main/single-instance.js";
import {
  SystemEventMonitor,
  type PowerMonitorEventName,
  type PowerMonitorHost
} from "../src/platform/system-event-monitor.js";
import {
  StartupManager,
  type StartupHost
} from "../src/platform/startup-manager.js";
import {
  TrayController,
  type TrayHandle,
  type TrayHost,
  type TrayMenu,
  type TrayMenuItem,
  type TrayScheduler,
  type TrayVisualState
} from "../src/main/tray-controller.js";
import {
  calculateReminderWindowPosition,
  ReminderWindowController,
  type ReminderWindowCloseEvent,
  type ReminderWindowCreationOptions,
  type ReminderWindowHandle,
  type ReminderWindowHost,
  type ReminderPoint,
  type ReminderWorkArea
} from "../src/main/reminder-window.js";
import {
  SETTINGS_WINDOW_HEIGHT,
  SETTINGS_WINDOW_WIDTH,
  SettingsWindowController,
  type SettingsWindowCloseEvent,
  type SettingsWindowCreationOptions,
  type SettingsWindowHandle,
  type SettingsWindowHost
} from "../src/main/settings-window.js";
import {
  ReminderCommandType,
  DEFAULT_SETTINGS,
  ReminderOutputEventType,
  ReminderState,
  SystemEventType,
  type ReminderCommand,
  type ReminderOutputEvent,
  type ReminderSettings,
  type ReminderState as ReminderStateValue,
  type SystemEvent
} from "../src/core/model.js";
import {
  MILLISECONDS_PER_MINUTE,
  type MonotonicClock,
  type OneShotTimer,
  type OneShotTimerScheduler
} from "../src/core/clock.js";
import { ReminderScheduler } from "../src/core/reminder-scheduler.js";

/**
 * @brief 验证核心 IPC 定义可以脱离 Electron 主进程单独加载。
 */
function verifyCoreBoundary(): void
{
  assert.equal(IPC_CHANNELS.getRuntimeInfo, "app:get-runtime-info");
  assert.equal(IPC_CHANNELS.completeReminder, "reminder:complete");
  assert.equal(IPC_CHANNELS.snoozeReminder, "reminder:snooze");
  assert.equal(IPC_CHANNELS.loadSettings, "settings:load");
  assert.equal(IPC_CHANNELS.saveSettings, "settings:save");
}

test("core IPC boundary baseline", verifyCoreBoundary);

/**
 * @brief 为单实例管理器提供不依赖 Electron 的内存宿主。
 */
class FakeSingleInstanceHost implements SingleInstanceHost
{
  private readonly listeners = new Set<() => void>();
  private latestListener: (() => void) | undefined;
  private lockAvailable = true;
  private quitCount = 0;

  /**
   * @brief 设置下一次单实例锁请求的结果。
   */
  setLockAvailable(available: boolean): void
  {
    this.lockAvailable = available;
  }

  /**
   * @brief 返回当前宿主是否允许取得单实例锁。
   */
  requestSingleInstanceLock(): boolean
  {
    return this.lockAvailable;
  }

  /**
   * @brief 保存第二实例监听器。
   */
  addSecondInstanceListener(listener: () => void): void
  {
    this.listeners.add(listener);
    this.latestListener = listener;
  }

  /**
   * @brief 移除第二实例监听器。
   */
  removeSecondInstanceListener(listener: () => void): void
  {
    this.listeners.delete(listener);
  }

  /**
   * @brief 记录宿主退出请求。
   */
  quit(): void
  {
    this.quitCount += 1;
  }

  /**
   * @brief 模拟 Electron 通知第二实例事件。
   */
  triggerSecondInstance(): void
  {
    for (const listener of this.listeners)
      listener();
  }

  /**
   * @brief 返回退出请求次数。
   */
  getQuitCount(): number
  {
    return this.quitCount;
  }

  /**
   * @brief 返回当前注册的第二实例监听数量。
   */
  getListenerCount(): number
  {
    return this.listeners.size;
  }

  /**
   * @brief 返回最近注册的监听器，用于模拟注销后的迟到回调。
   */
  getLatestListener(): (() => void) | undefined
  {
    return this.latestListener;
  }
}

/**
 * @brief 记录生命周期资源调用并按测试要求模拟启动或停止失败。
 */
class FakeLifecycleResource implements LifecycleResource
{
  constructor(
    private readonly name: string,
    private readonly calls: string[],
    private readonly failOnStart = false,
    private readonly failOnStop = false
  )
  {
  }

  /**
   * @brief 记录资源启动，并按配置模拟启动异常。
   */
  start(): void
  {
    this.calls.push(`${this.name}:start`);
    if (this.failOnStart)
      throw new Error(`${this.name} start failure`);
  }

  /**
   * @brief 记录资源停止，并按配置模拟停止异常。
   */
  stop(): void
  {
    this.calls.push(`${this.name}:stop`);
    if (this.failOnStop)
      throw new Error(`${this.name} stop failure`);
  }
}

/**
 * @brief 创建覆盖全部生命周期阶段的测试资源集合。
 */
function createLifecycleResources(
  calls: string[],
  failOnStart?: keyof ApplicationResources,
  failOnStop?: keyof ApplicationResources
): ApplicationResources
{
  const names: readonly (keyof ApplicationResources)[] = [
    "ipc",
    "tray",
    "windows",
    "systemEvents",
    "scheduler"
  ];
  const resources: ApplicationResources = {};

  for (const name of names) {
    resources[name] = new FakeLifecycleResource(
      name,
      calls,
      name === failOnStart,
      name === failOnStop
    );
  }

  return resources;
}

/**
 * @brief 验证未取得单实例锁的进程不会注册第二实例监听。
 */
function verifySingleInstanceLockFailure(): void
{
  const host = new FakeSingleInstanceHost();
  host.setLockAvailable(false);
  const manager = new SingleInstanceManager(host, () => {
    throw new Error("activation must not happen");
  });

  assert.equal(manager.acquire(), false);
  assert.equal(host.getQuitCount(), 1);
  assert.equal(host.getListenerCount(), 0);
  assert.equal(manager.isAcquired(), false);
}

test("single instance lock failure", verifySingleInstanceLockFailure);

/**
 * @brief 验证主实例注册监听、响应第二实例并避免重复注册。
 */
function verifySingleInstanceLockSuccess(): void
{
  const host = new FakeSingleInstanceHost();
  let activationCount = 0;
  const manager = new SingleInstanceManager(host, () => {
    activationCount += 1;
  });

  assert.equal(manager.acquire(), true);
  assert.equal(manager.acquire(), true);
  assert.equal(manager.isAcquired(), true);
  assert.equal(host.getListenerCount(), 1);

  host.triggerSecondInstance();
  assert.equal(activationCount, 1);
}

test("single instance second-instance activation", verifySingleInstanceLockSuccess);

/**
 * @brief 验证释放单实例监听后，迟到事件不会再次激活窗口。
 */
function verifySingleInstanceRelease(): void
{
  const host = new FakeSingleInstanceHost();
  let activationCount = 0;
  const manager = new SingleInstanceManager(host, () => {
    activationCount += 1;
  });

  assert.equal(manager.acquire(), true);
  const lateListener = host.getLatestListener();
  manager.release();
  manager.release();
  lateListener?.();
  host.triggerSecondInstance();

  assert.equal(manager.isAcquired(), false);
  assert.equal(host.getListenerCount(), 0);
  assert.equal(activationCount, 0);
}

test("single instance release is idempotent", verifySingleInstanceRelease);

/**
 * @brief 为系统事件监视器提供可手动触发的 powerMonitor 替身。
 */
class FakePowerMonitorHost implements PowerMonitorHost
{
  private readonly listeners = new Map<
    PowerMonitorEventName,
    Set<() => void>
  >();

  /**
   * @brief 注册一个测试事件监听器。
   */
  on(eventName: PowerMonitorEventName, listener: () => void): void
  {
    let eventListeners = this.listeners.get(eventName);
    if (eventListeners === undefined) {
      eventListeners = new Set<() => void>();
      this.listeners.set(eventName, eventListeners);
    }

    eventListeners.add(listener);
  }

  /**
   * @brief 移除一个测试事件监听器。
   */
  removeListener(eventName: PowerMonitorEventName, listener: () => void): void
  {
    this.listeners.get(eventName)?.delete(listener);
  }

  /**
   * @brief 手动触发一个 powerMonitor 事件。
   */
  trigger(eventName: PowerMonitorEventName): void
  {
    for (const listener of this.listeners.get(eventName) ?? [])
      listener();
  }

  /**
   * @brief 返回所有事件当前注册的监听器数量。
   */
  listenerCount(): number
  {
    let count = 0;
    for (const eventListeners of this.listeners.values())
      count += eventListeners.size;
    return count;
  }
}

/**
 * @brief 验证系统事件映射、重复去重和顺序异常处理。
 */
function verifySystemEventMonitor(): void
{
  const host = new FakePowerMonitorHost();
  const events: SystemEvent[] = [];
  const monitor = new SystemEventMonitor(host, (event): void => {
    events.push(event);
  });

  monitor.start();
  monitor.start();
  assert.equal(host.listenerCount(), 4);

  host.trigger("unlock-screen");
  host.trigger("resume");
  host.trigger("lock-screen");
  host.trigger("lock-screen");
  host.trigger("suspend");
  host.trigger("unlock-screen");
  host.trigger("unlock-screen");
  host.trigger("resume");
  host.trigger("resume");

  assert.deepEqual(events, [
    { type: SystemEventType.UserLocked },
    { type: SystemEventType.SystemSuspended },
    { type: SystemEventType.UserUnlocked },
    { type: SystemEventType.SystemResumed }
  ]);

  monitor.stop();
  monitor.stop();
  assert.equal(monitor.isStarted(), false);
  assert.equal(host.listenerCount(), 0);
  host.trigger("lock-screen");
  assert.equal(events.length, 4);
}

test("system event monitor maps and deduplicates power events", verifySystemEventMonitor);

/**
 * @brief 为开机自启管理器提供可记录写入的登录项替身。
 */
class FakeStartupHost implements StartupHost
{
  enabled = false;
  getCount = 0;
  readonly writes: Array<{ openAtLogin: boolean; enabled: boolean }> = [];

  /**
   * @brief 返回内存中的登录项状态。
   */
  getLoginItemSettings(): { openAtLogin: boolean }
  {
    this.getCount += 1;
    return { openAtLogin: this.enabled };
  }

  /**
   * @brief 记录并应用登录项写入。
   */
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    enabled: boolean;
  }): void
  {
    this.enabled = settings.openAtLogin;
    this.writes.push({ ...settings });
  }
}

/**
 * @brief 验证正式模式可以查询、启用、关闭并清理当前用户登录项。
 */
function verifyStartupManager(): void
{
  const host = new FakeStartupHost();
  const manager = new StartupManager({
    host,
    canModifyLoginItem: true
  });

  assert.equal(manager.isManaged(), true);
  assert.equal(manager.getEnabled(), false);
  assert.equal(host.getCount, 1);
  assert.equal(manager.synchronize(true), true);
  assert.equal(manager.getEnabled(), true);
  assert.equal(manager.setEnabled(false), true);
  assert.equal(manager.clearForUninstall(), true);
  assert.deepEqual(host.writes, [
    { openAtLogin: true, enabled: true },
    { openAtLogin: false, enabled: false },
    { openAtLogin: false, enabled: false }
  ]);
}

test("startup manager controls packaged login item", verifyStartupManager);

/**
 * @brief 验证开发模式不会查询或修改真实开机自启配置。
 */
function verifyStartupManagerDevelopmentIsolation(): void
{
  const host = new FakeStartupHost();
  const manager = new StartupManager({
    host,
    canModifyLoginItem: false
  });

  assert.equal(manager.isManaged(), false);
  assert.equal(manager.getEnabled(), undefined);
  assert.equal(manager.synchronize(true), false);
  assert.equal(manager.setEnabled(false), false);
  assert.equal(manager.clearForUninstall(), false);
  assert.equal(host.getCount, 0);
  assert.deepEqual(host.writes, []);
}

test("startup manager isolates development mode", verifyStartupManagerDevelopmentIsolation);

/**
 * @brief 为托盘控制器提供可记录状态的内存托盘实例。
 */
class FakeTrayHandle implements TrayHandle
{
  visualState: TrayVisualState = "running";
  toolTip = "";
  menu: TrayMenu | undefined;
  destroyCount = 0;

  /**
   * @brief 记录托盘图标状态。
   */
  setImage(state: TrayVisualState): void
  {
    this.visualState = state;
  }

  /**
   * @brief 记录托盘提示文本。
   */
  setToolTip(toolTip: string): void
  {
    this.toolTip = toolTip;
  }

  /**
   * @brief 记录托盘菜单对象。
   */
  setContextMenu(menu: TrayMenu): void
  {
    this.menu = menu;
  }

  /**
   * @brief 记录托盘销毁操作。
   */
  destroy(): void
  {
    this.destroyCount += 1;
  }
}

/**
 * @brief 为托盘控制器提供内存菜单构建宿主。
 */
class FakeTrayHost implements TrayHost
{
  readonly tray = new FakeTrayHandle();
  readonly templates: TrayMenuItem[][] = [];
  createCount = 0;

  /**
   * @brief 返回内存托盘实例。
   */
  createTray(): TrayHandle
  {
    this.createCount += 1;
    return this.tray;
  }

  /**
   * @brief 保存托盘菜单模板并返回内存菜单对象。
   */
  buildContextMenu(template: readonly TrayMenuItem[]): TrayMenu
  {
    this.templates.push([...template]);
    return {};
  }

  /**
   * @brief 返回最近一次菜单模板。
   */
  latestTemplate(): readonly TrayMenuItem[]
  {
    return this.templates[this.templates.length - 1] ?? [];
  }
}

/**
 * @brief 为托盘控制器提供只记录命令的调度器替身。
 */
class FakeTrayScheduler implements TrayScheduler
{
  state: ReminderStateValue = ReminderState.Waiting;
  remainingMilliseconds: number | undefined = 20 * MILLISECONDS_PER_MINUTE;
  systemPaused = false;
  readonly commands: ReminderCommand[] = [];

  /**
   * @brief 返回内存调度器状态。
   */
  getState(): ReminderStateValue
  {
    return this.state;
  }

  /**
   * @brief 返回内存调度器中的下次提醒剩余时间。
   */
  getNextReminderRemainingMilliseconds(): number | undefined
  {
    return this.remainingMilliseconds;
  }

  /**
   * @brief 返回内存调度器中的系统暂停状态。
   */
  isSystemPaused(): boolean
  {
    return this.systemPaused;
  }

  /**
   * @brief 记录命令并模拟托盘相关状态转换。
   */
  dispatch(command: ReminderCommand): boolean
  {
    this.commands.push(command);

    switch (command.type) {
      case ReminderCommandType.RemindNow:
        this.state = ReminderState.ReminderVisible;
        return true;
      case ReminderCommandType.Pause:
        if (this.state === ReminderState.Paused)
          return false;
        this.state = ReminderState.Paused;
        return true;
      case ReminderCommandType.Resume:
        if (this.state !== ReminderState.Paused)
          return false;
        this.state = ReminderState.Waiting;
        return true;
      default:
        return false;
    }
  }
}

/**
 * @brief 从托盘菜单模板中查找指定标签的菜单项。
 */
function findTrayMenuItem(
  template: readonly TrayMenuItem[],
  label: string
): TrayMenuItem
{
  const item = template.find((entry) => entry.label === label);
  assert.ok(item !== undefined);
  return item;
}

/**
 * @brief 验证托盘菜单命令、状态图标和退出销毁行为。
 */
function verifyTrayController(): void
{
  const host = new FakeTrayHost();
  const scheduler = new FakeTrayScheduler();
  const clock = new IntegrationClock();
  const timerScheduler = new IntegrationTimerScheduler(clock);
  let settingsOpenCount = 0;
  let quitCount = 0;
  const controller = new TrayController({
    host,
    scheduler,
    timerScheduler,
    openSettings: (): void => {
      settingsOpenCount += 1;
    },
    quit: (): void => {
      quitCount += 1;
    }
  });

  controller.start();
  controller.start();
  assert.equal(host.createCount, 1);
  assert.equal(host.tray.visualState, "running");
  assert.equal(host.tray.toolTip, "护眼提醒 - 下次提醒：20:00 后");
  assert.equal(findTrayMenuItem(host.latestTemplate(), "状态：运行中").enabled, false);

  scheduler.remainingMilliseconds = 4 * MILLISECONDS_PER_MINUTE + 1;
  clock.advance(1000);
  timerScheduler.runDue();
  assert.equal(host.tray.toolTip, "护眼提醒 - 下次提醒：04:01 后");

  scheduler.systemPaused = true;
  controller.refresh();
  assert.equal(host.tray.toolTip, "护眼提醒 - 系统暂停 - 下次提醒：04:01 后");
  scheduler.systemPaused = false;

  findTrayMenuItem(host.latestTemplate(), "立即提醒").click?.();
  assert.deepEqual(scheduler.commands, [
    { type: ReminderCommandType.RemindNow }
  ]);

  scheduler.state = ReminderState.Waiting;
  controller.refresh();
  findTrayMenuItem(host.latestTemplate(), "暂停提醒").click?.();
  assert.equal(scheduler.state, ReminderState.Paused);
  assert.equal(host.tray.visualState, "paused");
  assert.equal(host.tray.toolTip, "护眼提醒 - 已暂停");
  assert.equal(findTrayMenuItem(host.latestTemplate(), "状态：已暂停").enabled, false);

  findTrayMenuItem(host.latestTemplate(), "立即提醒").click?.();
  assert.equal(scheduler.state, ReminderState.ReminderVisible);
  assert.deepEqual(scheduler.commands.slice(-1), [
    { type: ReminderCommandType.RemindNow }
  ]);

  scheduler.state = ReminderState.Paused;
  controller.refresh();
  findTrayMenuItem(host.latestTemplate(), "恢复提醒").click?.();
  assert.equal(scheduler.state, ReminderState.Waiting);
  findTrayMenuItem(host.latestTemplate(), "设置").click?.();
  findTrayMenuItem(host.latestTemplate(), "退出").click?.();
  assert.equal(settingsOpenCount, 1);
  assert.equal(quitCount, 1);

  controller.stop();
  controller.stop();
  assert.equal(host.tray.destroyCount, 1);
  assert.equal(timerScheduler.pendingTimerCount(), 0);
  assert.equal(controller.isStarted(), false);
}

test("tray controller commands and lifecycle", verifyTrayController);

/**
 * @brief 模拟提醒窗口，用于验证控制器不依赖真实 Electron。
 */
class FakeReminderWindow implements ReminderWindowHandle
{
  private closeListener: ((event: ReminderWindowCloseEvent) => void) | undefined;
  private destroyed = false;
  readonly loadedSnoozeMinutes: number[] = [];
  readonly positions: ReminderPoint[] = [];
  showCount = 0;
  hideCount = 0;
  restoreCount = 0;
  focusCount = 0;
  destroyCount = 0;
  minimized = false;

  /**
   * @brief 注册关闭监听器。
   */
  onClose(listener: (event: ReminderWindowCloseEvent) => void): void
  {
    this.closeListener = listener;
  }

  /**
   * @brief 返回窗口是否已销毁。
   */
  isDestroyed(): boolean
  {
    return this.destroyed;
  }

  /**
   * @brief 返回窗口是否处于最小化状态。
   */
  isMinimized(): boolean
  {
    return this.minimized;
  }

  /**
   * @brief 记录页面加载时使用的设置。
   */
  load(snoozeMinutes: number): void
  {
    this.loadedSnoozeMinutes.push(snoozeMinutes);
  }

  /**
   * @brief 记录窗口位置。
   */
  setPosition(x: number, y: number): void
  {
    this.positions.push({ x, y });
  }

  /**
   * @brief 记录显示操作。
   */
  show(): void
  {
    this.showCount += 1;
  }

  /**
   * @brief 记录隐藏操作。
   */
  hide(): void
  {
    this.hideCount += 1;
  }

  /**
   * @brief 记录恢复操作。
   */
  restore(): void
  {
    this.minimized = false;
    this.restoreCount += 1;
  }

  /**
   * @brief 记录聚焦操作。
   */
  focus(): void
  {
    this.focusCount += 1;
  }

  /**
   * @brief 强制销毁模拟窗口。
   */
  destroy(): void
  {
    this.destroyed = true;
    this.destroyCount += 1;
  }

  /**
   * @brief 模拟用户点击关闭按钮并返回是否被拦截。
   */
  triggerClose(): boolean
  {
    let prevented = false;
    this.closeListener?.({
      preventDefault: (): void => {
        prevented = true;
      }
    });
    return prevented;
  }
}

/**
 * @brief 模拟提醒窗口平台能力。
 */
class FakeReminderWindowHost implements ReminderWindowHost
{
  cursor: ReminderPoint = { x: 20, y: 30 };
  display: ReminderWorkArea = {
    x: 100,
    y: 50,
    width: 1000,
    height: 800
  };
  readonly windows: FakeReminderWindow[] = [];
  readonly requestedPoints: ReminderPoint[] = [];
  latestOptions: ReminderWindowCreationOptions | undefined;

  /**
   * @brief 创建模拟提醒窗口。
   */
  createWindow(options: ReminderWindowCreationOptions): ReminderWindowHandle
  {
    this.latestOptions = options;
    const window = new FakeReminderWindow();
    this.windows.push(window);
    return window;
  }

  /**
   * @brief 返回模拟鼠标位置。
   */
  getCursorScreenPoint(): ReminderPoint
  {
    return this.cursor;
  }

  /**
   * @brief 返回鼠标所在的模拟屏幕工作区。
   */
  getDisplayNearestPoint(point: ReminderPoint): ReminderWorkArea
  {
    this.requestedPoints.push(point);
    return this.display;
  }
}

/**
 * @brief 验证提醒窗口位置计算和控制器生命周期。
 */
function verifyReminderWindowController(): void
{
  assert.deepEqual(
    calculateReminderWindowPosition(
      { x: 100, y: 50, width: 1000, height: 800 },
      420,
      240,
      16
    ),
    { x: 664, y: 594 }
  );

  const host = new FakeReminderWindowHost();
  let snoozeMinutes = 7;
  const controller = new ReminderWindowController({
    host,
    getSnoozeMinutes: (): number => snoozeMinutes
  });

  controller.show();
  assert.equal(host.windows.length, 0);

  controller.start();
  controller.start();
  controller.bringToFront();
  assert.equal(host.windows.length, 0);
  controller.show();
  snoozeMinutes = 9;
  controller.show();

  assert.equal(host.windows.length, 1);
  assert.deepEqual(host.latestOptions, {
    width: 420,
    height: 240,
    frame: false,
    modal: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false
  });
  assert.deepEqual(host.requestedPoints, [
    { x: 20, y: 30 },
    { x: 20, y: 30 }
  ]);

  const reminderWindow = host.windows[0];
  assert.deepEqual(reminderWindow.loadedSnoozeMinutes, [7, 9]);
  assert.deepEqual(reminderWindow.positions, [
    { x: 664, y: 594 },
    { x: 664, y: 594 }
  ]);
  assert.equal(reminderWindow.showCount, 2);
  assert.equal(reminderWindow.triggerClose(), true);

  reminderWindow.minimized = true;
  controller.bringToFront();
  assert.equal(host.windows.length, 1);
  assert.equal(reminderWindow.restoreCount, 1);
  assert.equal(reminderWindow.showCount, 3);
  assert.equal(reminderWindow.focusCount, 1);

  controller.hide();
  assert.equal(reminderWindow.hideCount, 1);

  controller.stop();
  controller.stop();
  assert.equal(reminderWindow.destroyCount, 1);
}

test("reminder window controller handles display and lifecycle", verifyReminderWindowController);

/**
 * @brief 模拟设置窗口，用于验证设置控制器的唯一实例和关闭拦截。
 */
class FakeSettingsWindow implements SettingsWindowHandle
{
  private closeListener: ((event: SettingsWindowCloseEvent) => void) | undefined;
  private destroyed = false;
  readonly loadedSettings: Array<{ snoozeMinutes: number; autoStart: boolean }> = [];
  showCount = 0;
  hideCount = 0;
  restoreCount = 0;
  focusCount = 0;
  destroyCount = 0;
  minimized = false;

  /**
   * @brief 注册关闭监听器。
   */
  onClose(listener: (event: SettingsWindowCloseEvent) => void): void
  {
    this.closeListener = listener;
  }

  /**
   * @brief 返回窗口是否已销毁。
   */
  isDestroyed(): boolean
  {
    return this.destroyed;
  }

  /**
   * @brief 返回窗口是否处于最小化状态。
   */
  isMinimized(): boolean
  {
    return this.minimized;
  }

  /**
   * @brief 记录设置页面加载内容。
   */
  load(settings: { snoozeMinutes: number; autoStart: boolean }): void
  {
    this.loadedSettings.push({ ...settings });
  }

  /**
   * @brief 记录显示操作。
   */
  show(): void
  {
    this.showCount += 1;
  }

  /**
   * @brief 记录隐藏操作。
   */
  hide(): void
  {
    this.hideCount += 1;
  }

  /**
   * @brief 记录恢复操作。
   */
  restore(): void
  {
    this.minimized = false;
    this.restoreCount += 1;
  }

  /**
   * @brief 记录聚焦操作。
   */
  focus(): void
  {
    this.focusCount += 1;
  }

  /**
   * @brief 强制销毁模拟窗口。
   */
  destroy(): void
  {
    this.destroyed = true;
    this.destroyCount += 1;
  }

  /**
   * @brief 模拟用户关闭窗口并返回是否被拦截。
   */
  triggerClose(): boolean
  {
    let prevented = false;
    this.closeListener?.({
      preventDefault: (): void => {
        prevented = true;
      }
    });
    return prevented;
  }
}

/**
 * @brief 模拟设置窗口平台宿主。
 */
class FakeSettingsWindowHost implements SettingsWindowHost
{
  readonly windows: FakeSettingsWindow[] = [];
  latestOptions: SettingsWindowCreationOptions | undefined;

  /**
   * @brief 创建模拟设置窗口。
   */
  createWindow(options: SettingsWindowCreationOptions): SettingsWindowHandle
  {
    this.latestOptions = options;
    const window = new FakeSettingsWindow();
    this.windows.push(window);
    return window;
  }
}

/**
 * @brief 验证设置窗口显示、重复打开、关闭隐藏和退出销毁。
 */
function verifySettingsWindowController(): void
{
  const host = new FakeSettingsWindowHost();
  let settings = { snoozeMinutes: 3, autoStart: true };
  const controller = new SettingsWindowController({
    host,
    getSettings: (): { snoozeMinutes: number; autoStart: boolean } => ({ ...settings })
  });

  controller.show();
  assert.equal(host.windows.length, 0);

  controller.start();
  controller.start();
  controller.show();
  settings = { snoozeMinutes: 10, autoStart: false };
  controller.show();

  assert.equal(host.windows.length, 1);
  assert.deepEqual(host.latestOptions, {
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

  const settingsWindow = host.windows[0];
  assert.deepEqual(settingsWindow.loadedSettings, [
    { snoozeMinutes: 3, autoStart: true }
  ]);
  assert.equal(settingsWindow.showCount, 2);
  assert.equal(settingsWindow.focusCount, 2);
  assert.equal(settingsWindow.triggerClose(), true);
  assert.equal(settingsWindow.hideCount, 1);

  settingsWindow.minimized = true;
  controller.bringToFront();
  assert.equal(settingsWindow.restoreCount, 1);
  assert.equal(settingsWindow.showCount, 3);
  assert.equal(settingsWindow.focusCount, 3);

  controller.hide();
  assert.equal(settingsWindow.hideCount, 2);
  controller.stop();
  controller.stop();
  assert.equal(settingsWindow.destroyCount, 1);
  assert.equal(controller.isStarted(), false);
}

test("settings window controller handles display and lifecycle", verifySettingsWindowController);

/**
 * @brief 为应用集成测试提供可手动推进的单调时间。
 */
class IntegrationClock implements MonotonicClock
{
  private currentMilliseconds = 0;

  /**
   * @brief 返回当前集成测试时间。
   */
  now(): number
  {
    return this.currentMilliseconds;
  }

  /**
   * @brief 推进集成测试时间。
   */
  advance(milliseconds: number): void
  {
    assert.ok(milliseconds >= 0);
    this.currentMilliseconds += milliseconds;
  }
}

/**
 * @brief 为应用集成测试提供可控的一次性计时器。
 */
class IntegrationTimerScheduler implements OneShotTimerScheduler
{
  private readonly timers: Array<{
    dueAt: number;
    callback: () => void;
    cancelled: boolean;
    fired: boolean;
  }> = [];

  /**
   * @brief 创建并记录一个集成测试计时器。
   */
  constructor(private readonly clock: MonotonicClock)
  {
  }

  /**
   * @brief 安排一个由 runDue 触发的测试计时器。
   */
  schedule(delayMilliseconds: number, callback: () => void): OneShotTimer
  {
    assert.ok(delayMilliseconds >= 0);
    const timer = {
      dueAt: this.clock.now() + delayMilliseconds,
      callback,
      cancelled: false,
      fired: false
    };
    this.timers.push(timer);

    return {
      /**
       * @brief 取消集成测试计时器。
       */
      cancel: (): void => {
        timer.cancelled = true;
      }
    };
  }

  /**
   * @brief 触发当前时间已经到期的测试计时器。
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
   * @brief 返回当前有效计时器数量。
   */
  pendingTimerCount(): number
  {
    return this.timers.filter((timer) => !timer.cancelled && !timer.fired).length;
  }
}

/**
 * @brief 描述由真实业务模块组成的应用集成测试夹具。
 */
interface ApplicationIntegrationFixture
{
  clock: IntegrationClock;
  timers: IntegrationTimerScheduler;
  trayTimers: IntegrationTimerScheduler;
  settings: ReminderSettings;
  scheduler: ReminderScheduler;
  reminderHost: FakeReminderWindowHost;
  reminderController: ReminderWindowController;
  trayHost: FakeTrayHost;
  trayController: TrayController;
  settingsHost: FakeSettingsWindowHost;
  settingsController: SettingsWindowController;
  powerHost: FakePowerMonitorHost;
  systemMonitor: SystemEventMonitor;
}

/**
 * @brief 创建将调度器、窗口、托盘、设置和系统事件接通的集成夹具。
 */
function createApplicationIntegrationFixture(): ApplicationIntegrationFixture
{
  const clock = new IntegrationClock();
  const timers = new IntegrationTimerScheduler(clock);
  const trayTimers = new IntegrationTimerScheduler(clock);
  const settings: ReminderSettings = { ...DEFAULT_SETTINGS };
  const reminderHost = new FakeReminderWindowHost();
  const trayHost = new FakeTrayHost();
  const settingsHost = new FakeSettingsWindowHost();
  const powerHost = new FakePowerMonitorHost();
  let reminderController: ReminderWindowController;
  let trayController: TrayController;

  const scheduler = new ReminderScheduler({
    clock,
    timerScheduler: timers,
    settings,
    emit: (event: ReminderOutputEvent): void => {
      switch (event.type) {
        case ReminderOutputEventType.Show:
          reminderController.show();
          break;
        case ReminderOutputEventType.Hide:
          reminderController.hide();
          break;
        case ReminderOutputEventType.BringToFront:
          reminderController.bringToFront();
          break;
      }

      trayController?.refresh();
    }
  });

  reminderController = new ReminderWindowController({
    host: reminderHost,
    getSnoozeMinutes: (): number => settings.snoozeMinutes
  });

  const settingsController = new SettingsWindowController({
    host: settingsHost,
    getSettings: (): ReminderSettings => ({ ...settings })
  });

  trayController = new TrayController({
    host: trayHost,
    scheduler,
    timerScheduler: trayTimers,
    openSettings: (): void => settingsController.show(),
    quit: (): void => undefined
  });

  const systemMonitor = new SystemEventMonitor(
    powerHost,
    (event): void => {
      scheduler.dispatchSystemEvent(event);
      trayController.refresh();
    }
  );

  return {
    clock,
    timers,
    trayTimers,
    settings,
    scheduler,
    reminderHost,
    reminderController,
    trayHost,
    trayController,
    settingsHost,
    settingsController,
    powerHost,
    systemMonitor
  };
}

/**
 * @brief 验证完整应用流程只创建一个托盘、窗口和计时流程。
 *
 * 测试通过真实调度器和各窗口/平台控制器的内存宿主推进时间，覆盖正常周期、
 * 已休息、重复推迟、设置变更、暂停恢复、立即提醒、锁屏恢复和统一退出清理。
 */
function verifyApplicationIntegrationFlow(): void
{
  const fixture = createApplicationIntegrationFixture();

  fixture.reminderController.start();
  fixture.reminderController.start();
  fixture.settingsController.start();
  fixture.settingsController.start();
  fixture.trayController.start();
  fixture.trayController.start();
  fixture.systemMonitor.start();
  fixture.systemMonitor.start();
  fixture.scheduler.start();
  fixture.scheduler.start();

  assert.equal(fixture.trayHost.createCount, 1);
  assert.equal(fixture.timers.pendingTimerCount(), 1);
  assert.equal(fixture.powerHost.listenerCount(), 4);

  fixture.clock.advance(20 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(fixture.reminderHost.windows.length, 1);
  assert.equal(fixture.reminderHost.windows[0].showCount, 1);

  findTrayMenuItem(fixture.trayHost.latestTemplate(), "立即提醒").click?.();
  assert.equal(fixture.reminderHost.windows.length, 1);
  assert.equal(fixture.reminderHost.windows[0].focusCount, 1);

  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.equal(fixture.reminderHost.windows[0].hideCount, 1);
  assert.equal(fixture.timers.pendingTimerCount(), 1);

  fixture.clock.advance(20 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );
  assert.equal(fixture.scheduler.getState(), ReminderState.Snoozed);
  fixture.settings.snoozeMinutes = 1;

  fixture.clock.advance(3 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );
  fixture.clock.advance(1 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);

  findTrayMenuItem(fixture.trayHost.latestTemplate(), "暂停提醒").click?.();
  assert.equal(fixture.scheduler.getState(), ReminderState.Paused);
  assert.equal(fixture.reminderHost.windows[0].hideCount, 4);
  findTrayMenuItem(fixture.trayHost.latestTemplate(), "恢复提醒").click?.();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  assert.equal(fixture.timers.pendingTimerCount(), 1);

  findTrayMenuItem(fixture.trayHost.latestTemplate(), "暂停提醒").click?.();
  findTrayMenuItem(fixture.trayHost.latestTemplate(), "立即提醒").click?.();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);
  assert.equal(
    fixture.scheduler.dispatch({ type: ReminderCommandType.Complete }),
    true
  );

  fixture.clock.advance(5 * MILLISECONDS_PER_MINUTE);
  fixture.powerHost.trigger("lock-screen");
  assert.equal(fixture.timers.pendingTimerCount(), 0);
  fixture.clock.advance(30 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.Waiting);
  fixture.powerHost.trigger("unlock-screen");
  assert.equal(fixture.timers.pendingTimerCount(), 1);
  fixture.clock.advance(15 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(fixture.scheduler.getState(), ReminderState.ReminderVisible);

  findTrayMenuItem(fixture.trayHost.latestTemplate(), "设置").click?.();
  assert.equal(fixture.settingsHost.windows.length, 1);
  assert.equal(fixture.settingsHost.windows[0].showCount, 1);

  fixture.settingsController.stop();
  fixture.systemMonitor.stop();
  fixture.scheduler.stop();
  fixture.reminderController.stop();
  fixture.trayController.stop();
  assert.equal(fixture.powerHost.listenerCount(), 0);
  assert.equal(fixture.trayHost.tray.destroyCount, 1);
  assert.equal(fixture.trayTimers.pendingTimerCount(), 0);
  assert.equal(fixture.reminderHost.windows[0].destroyCount, 1);
  assert.equal(fixture.settingsHost.windows[0].destroyCount, 1);
}

test("application integration routes end-to-end reminder flow", verifyApplicationIntegrationFlow);

/**
 * @brief 验证重新创建调度器时只保留设置，不恢复上一进程的计时状态。
 */
function verifyApplicationRestartFlow(): void
{
  const fixture = createApplicationIntegrationFixture();
  const firstScheduler = fixture.scheduler;

  firstScheduler.start();
  fixture.settings.snoozeMinutes = 7;
  fixture.clock.advance(5 * MILLISECONDS_PER_MINUTE);
  firstScheduler.stop();
  assert.equal(fixture.timers.pendingTimerCount(), 0);

  const outputEvents: ReminderOutputEvent[] = [];
  const restartedScheduler = new ReminderScheduler({
    clock: fixture.clock,
    timerScheduler: fixture.timers,
    settings: fixture.settings,
    emit: (event): void => {
      outputEvents.push(event);
    }
  });

  assert.equal(restartedScheduler.getState(), ReminderState.Waiting);
  restartedScheduler.start();
  fixture.clock.advance(20 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(restartedScheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(outputEvents, [{ type: ReminderOutputEventType.Show }]);

  assert.equal(
    restartedScheduler.dispatch({ type: ReminderCommandType.Snooze }),
    true
  );
  fixture.clock.advance(7 * MILLISECONDS_PER_MINUTE);
  fixture.timers.runDue();
  assert.equal(restartedScheduler.getState(), ReminderState.ReminderVisible);
  assert.deepEqual(outputEvents, [
    { type: ReminderOutputEventType.Show },
    { type: ReminderOutputEventType.Hide },
    { type: ReminderOutputEventType.Show }
  ]);

  restartedScheduler.stop();
  assert.equal(fixture.timers.pendingTimerCount(), 0);
}

test("application restart starts a fresh schedule with persisted settings", verifyApplicationRestartFlow);

/**
 * @brief 验证生命周期资源按固定顺序启动并按逆序停止。
 */
function verifyLifecycleOrder(): void
{
  const calls: string[] = [];
  const lifecycle = new ApplicationLifecycle(createLifecycleResources(calls));

  assert.equal(lifecycle.start(), true);
  assert.equal(lifecycle.start(), false);
  lifecycle.stop();
  lifecycle.stop();

  assert.deepEqual(calls, [
    "ipc:start",
    "tray:start",
    "windows:start",
    "systemEvents:start",
    "scheduler:start",
    "scheduler:stop",
    "systemEvents:stop",
    "windows:stop",
    "tray:stop",
    "ipc:stop"
  ]);
  assert.equal(lifecycle.isStarted(), false);
}

test("application lifecycle order and idempotence", verifyLifecycleOrder);

/**
 * @brief 验证停止异常不会阻塞其他资源的退出清理。
 */
function verifyLifecycleStopContinuesAfterFailure(): void
{
  const calls: string[] = [];
  const lifecycle = new ApplicationLifecycle(
    createLifecycleResources(calls, undefined, "systemEvents")
  );

  lifecycle.start();
  assert.doesNotThrow(() => lifecycle.stop());
  assert.deepEqual(calls.slice(-5), [
    "scheduler:stop",
    "systemEvents:stop",
    "windows:stop",
    "tray:stop",
    "ipc:stop"
  ]);
}

test("application lifecycle continues cleanup after stop failure", verifyLifecycleStopContinuesAfterFailure);

/**
 * @brief 验证启动失败会回滚已经成功启动的资源。
 */
function verifyLifecycleStartRollback(): void
{
  const calls: string[] = [];
  const lifecycle = new ApplicationLifecycle(
    createLifecycleResources(calls, "systemEvents")
  );

  assert.throws(() => lifecycle.start(), /systemEvents start failure/);
  assert.deepEqual(calls, [
    "ipc:start",
    "tray:start",
    "windows:start",
    "systemEvents:start",
    "windows:stop",
    "tray:stop",
    "ipc:stop"
  ]);
  assert.equal(lifecycle.isStarted(), false);
  assert.equal(lifecycle.start(), false);
}

test("application lifecycle rolls back failed startup", verifyLifecycleStartRollback);
