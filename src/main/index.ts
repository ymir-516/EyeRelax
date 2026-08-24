import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  Tray
} from "electron";
import { join } from "node:path";
import {
  DEFAULT_SETTINGS,
  ReminderCommandType,
  ReminderState,
  type ReminderOutputEvent,
  type SystemEvent
} from "../core/model.js";
import { ReminderScheduler } from "../core/reminder-scheduler.js";
import { registerIpcHandlers, unregisterIpcHandlers } from "./ipc.js";
import { ApplicationLifecycle } from "./lifecycle.js";
import { SingleInstanceManager } from "./single-instance.js";
import {
  TrayController,
  type TrayHost,
  type TrayMenuItem,
  type TrayVisualState
} from "./tray-controller.js";
import {
  SystemEventMonitor,
  type PowerMonitorHost
} from "../platform/system-event-monitor.js";
import {
  runtimeMonotonicClock,
  runtimeTimerScheduler
} from "../platform/runtime-timer.js";
import { createSettingsStore } from "../platform/settings-store.js";
import {
  StartupManager,
  type StartupHost
} from "../platform/startup-manager.js";
import {
  ReminderWindowController,
  type ReminderWindowCloseEvent,
  type ReminderWindowHandle,
  type ReminderWindowHost,
  type ReminderWindowCreationOptions
} from "./reminder-window.js";
import {
  SettingsWindowController,
  type SettingsWindowCloseEvent,
  type SettingsWindowHandle,
  type SettingsWindowHost,
  type SettingsWindowCreationOptions
} from "./settings-window.js";
import type { SettingsStore } from "../core/settings-store.js";

const smokeFlag = "--smoke";
const clearAutostartFlag = "--clear-autostart";

/**
 * @brief 当前 smoke 验证窗口，避免第二实例激活时误显示隐藏提醒窗口。
 */
let smokeWindow: BrowserWindow | undefined;

/**
 * @brief 判断当前启动是否为仅用于图形链路验证的 smoke 模式。
 */
function isSmokeMode(): boolean
{
  return process.argv.includes(smokeFlag);
}

/**
 * @brief 判断当前启动是否为卸载器请求的开机自启清理模式。
 */
function isClearAutostartMode(): boolean
{
  return process.argv.includes(clearAutostartFlag);
}

/**
 * @brief 记录预加载脚本异常，避免页面静默失去 IPC 能力。
 *
 * 日志只输出固定英文标识，避免把用户路径或异常内容写入标准错误；具体
 * 诊断仍可通过 Electron 启动日志结合预加载文件路径完成。
 */
function monitorPreloadErrors(window: BrowserWindow): void
{
  window.webContents.on("preload-error", (): void => {
    console.error("Preload script failed");
  });
}

/**
 * @brief 创建 T00/T01 共用的最小可视化验证窗口。
 *
 * 正式后台模式不创建此窗口；显式传入 smoke 标志才显示页面，从而保证
 * 后续提醒弹窗可以独立于常驻主窗口实现。
 */
function createSmokeWindow(): void
{
  if (smokeWindow !== undefined && !smokeWindow.isDestroyed())
    return;

  const window = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.js")
    }
  });

  monitorPreloadErrors(window);
  smokeWindow = window;
  window.on("closed", (): void => {
    if (smokeWindow === window)
      smokeWindow = undefined;
  });
  void window.loadFile(join(app.getAppPath(), "src/renderer/index.html"));
}

/**
 * @brief 创建 Electron 提醒窗口适配层。
 *
 * 控制器只依赖窗口和屏幕的最小接口，Electron 事件对象在这里转换，避免核心窗口逻辑
 * 必须依赖真实 GUI 环境才能测试。
 */
const electronReminderWindowHost: ReminderWindowHost = {
  /**
   * @brief 创建并适配 Electron BrowserWindow。
   */
  createWindow: (options: ReminderWindowCreationOptions): ReminderWindowHandle => {
    const window = new BrowserWindow({
      width: options.width,
      height: options.height,
      frame: options.frame,
      modal: options.modal,
      resizable: options.resizable,
      show: options.show,
      alwaysOnTop: options.alwaysOnTop,
      skipTaskbar: options.skipTaskbar,
      minimizable: options.minimizable,
      maximizable: options.maximizable,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "../preload/index.js")
      }
    });

    monitorPreloadErrors(window);
    return {
      /**
       * @brief 转换提醒窗口关闭事件。
       */
      onClose: (listener): void => {
        window.on("close", (event): void => {
          const closeEvent: ReminderWindowCloseEvent = {
            preventDefault: (): void => event.preventDefault()
          };
          listener(closeEvent);
        });
      },
      isDestroyed: (): boolean => window.isDestroyed(),
      isMinimized: (): boolean => window.isMinimized(),
      load: (snoozeMinutes: number): void => {
        void window.loadFile(
          join(app.getAppPath(), "src/renderer/reminder.html"),
          { query: { snoozeMinutes: String(snoozeMinutes) } }
        );
      },
      setPosition: (x: number, y: number): void => {
        window.setPosition(x, y);
      },
      show: (): void => {
        window.show();
      },
      hide: (): void => {
        window.hide();
      },
      restore: (): void => {
        window.restore();
      },
      focus: (): void => {
        window.focus();
      },
      destroy: (): void => {
        window.destroy();
      }
    };
  },
  /**
   * @brief 获取当前鼠标所在屏幕坐标。
   */
  getCursorScreenPoint: () => screen.getCursorScreenPoint(),

  /**
   * @brief 获取鼠标所在屏幕的工作区。
   */
  getDisplayNearestPoint: (point) => {
    return screen.getDisplayNearestPoint(point).workArea;
  }
};

/**
 * @brief 创建 Electron 设置窗口适配层。
 *
 * 设置窗口只加载本地 renderer 页面，并沿用提醒窗口的 preload 安全边界；
 * 设置值通过受限 IPC 读取和保存，不把文件系统能力暴露给渲染进程。
 */
const electronSettingsWindowHost: SettingsWindowHost = {
  /**
   * @brief 创建并适配 Electron BrowserWindow。
   */
  createWindow: (options: SettingsWindowCreationOptions): SettingsWindowHandle => {
    const window = new BrowserWindow({
      width: options.width,
      height: options.height,
      modal: options.modal,
      resizable: options.resizable,
      show: options.show,
      alwaysOnTop: options.alwaysOnTop,
      skipTaskbar: options.skipTaskbar,
      minimizable: options.minimizable,
      maximizable: options.maximizable,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "../preload/index.js")
      }
    });

    monitorPreloadErrors(window);
    return {
      /**
       * @brief 转换设置窗口关闭事件。
       */
      onClose: (listener): void => {
        window.on("close", (event): void => {
          const closeEvent: SettingsWindowCloseEvent = {
            preventDefault: (): void => event.preventDefault()
          };
          listener(closeEvent);
        });
      },
      /**
       * @brief 返回设置窗口销毁状态。
       */
      isDestroyed: (): boolean => window.isDestroyed(),
      /**
       * @brief 返回设置窗口最小化状态。
       */
      isMinimized: (): boolean => window.isMinimized(),
      /**
       * @brief 加载设置页面并传递启动时设置快照。
       */
      load: (settings): void => {
        void window.loadFile(
          join(app.getAppPath(), "src/renderer/settings.html"),
          {
            query: {
              snoozeMinutes: String(settings.snoozeMinutes),
              autoStart: String(settings.autoStart)
            }
          }
        );
      },
      /**
       * @brief 显示设置窗口。
       */
      show: (): void => {
        window.show();
      },
      /**
       * @brief 隐藏设置窗口。
       */
      hide: (): void => {
        window.hide();
      },
      /**
       * @brief 恢复设置窗口。
       */
      restore: (): void => {
        window.restore();
      },
      /**
       * @brief 聚焦设置窗口。
       */
      focus: (): void => {
        window.focus();
      },
      /**
       * @brief 强制销毁设置窗口。
       */
      destroy: (): void => {
        window.destroy();
      }
    };
  }
};

/**
 * @brief 激活当前进程已经创建的窗口。
 *
 * 第二实例只负责通知主实例，不重复创建窗口；已有窗口统一在这里恢复
 * 最小化状态并置前，后续设置窗口和提醒窗口可以复用同一入口。
 */
function activateExistingWindows(): void
{
  const currentSmokeWindow = smokeWindow;
  if (currentSmokeWindow !== undefined && !currentSmokeWindow.isDestroyed()) {
    if (currentSmokeWindow.isMinimized())
      currentSmokeWindow.restore();

    currentSmokeWindow.show();
    currentSmokeWindow.focus();
  }

  settingsWindowController.bringToFront();

  if (reminderScheduler.getState() === ReminderState.ReminderVisible)
    reminderWindowController.bringToFront();
}

/**
 * @brief 按当前模式创建应用窗口资源。
 */
function startWindows(): void
{
  reminderWindowController.start();
  settingsWindowController.start();

  if (isSmokeMode())
    createSmokeWindow();
}

/**
 * @brief 强制关闭当前进程创建的全部窗口。
 *
 * 退出阶段必须绕过普通窗口关闭拦截，否则提醒窗口未来增加关闭保护后
 * 可能阻塞应用退出。
 */
function stopWindows(): void
{
  settingsWindowController.stop();
  reminderWindowController.stop();

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed())
      window.destroy();
  }

  smokeWindow = undefined;
}

/**
 * @brief 保存 Windows 托盘使用的 PNG 图标数据。
 *
 * Windows Shell 对 SVG 托盘图标的栅格化和透明通道处理并不稳定，因此这里
 * 使用固定尺寸的 PNG 数据 URL，避免图标在安装包和不同 DPI 下变成全透明。
 */
const trayIconData: Record<TrayVisualState, string> = {
  running: [
    "data:image/png;base64,",
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR42mNgoAVQTX79HxumSDNR",
    "hhDSjNcQYjVjNYRUzRiGYJNEByQZgAvQzwCKvUCXmKB+QqJKUqZKZiIVAADFNJxQ474bVgAAAABJ",
    "RU5ErkJggg=="
  ].join(""),
  paused: [
    "data:image/png;base64,",
    "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQElEQVR42mNgoAWYs3j9f2yYIs1E",
    "GUJIM15DiNWM1RBSNWMYgk0SHZBkAC5APwMo9gJdYoL6CYkqSZkqmYlUAAAHkt2o3hTO6gAAAABJ",
    "RU5ErkJggg=="
  ].join("")
};

/**
 * @brief 返回当前运行状态对应的托盘图标。
 */
function createTrayIcon(state: TrayVisualState): Electron.NativeImage
{
  return nativeImage.createFromDataURL(trayIconData[state]);
}

/**
 * @brief 将 Electron Tray 和 Menu 适配为托盘控制器宿主。
 */
const electronTrayHost: TrayHost = {
  /**
   * @brief 创建 Electron 托盘实例及其操作适配。
   */
  createTray: () => {
    const tray = new Tray(createTrayIcon("running"));

    return {
      setImage: (state: TrayVisualState): void => {
        tray.setImage(createTrayIcon(state));
      },
      setToolTip: (toolTip: string): void => {
        tray.setToolTip(toolTip);
      },
      setContextMenu: (menu): void => {
        tray.setContextMenu(menu as Menu);
      },
      destroy: (): void => {
        tray.destroy();
      }
    };
  },
  /**
   * @brief 将平台无关菜单模板转换为 Electron Menu。
   */
  buildContextMenu: (template: readonly TrayMenuItem[]) => {
    return Menu.buildFromTemplate(template.map((item) => {
      if (item.type === "separator")
        return { type: "separator" };

      return {
        label: item.label ?? "",
        enabled: item.enabled,
        click: item.click
      };
    }));
  }
};

/**
 * @brief 将调度器输出路由到提醒窗口并刷新托盘状态。
 *
 * 调度器拥有唯一业务状态，主入口只负责把显示、隐藏和置前事件交给窗口控制器，
 * 再让托盘读取最新状态重建菜单，避免各 UI 组件自行维护计时状态。
 */
function handleReminderOutput(event: ReminderOutputEvent): void
{
  switch (event.type) {
    case "show":
      reminderWindowController.show();
      break;
    case "hide":
      reminderWindowController.hide();
      break;
    case "bring-to-front":
      reminderWindowController.bringToFront();
      break;
  }

  trayController.refresh();
}

/**
 * @brief 将平台无关系统事件转发给提醒调度器。
 */
function handleSystemEvent(event: SystemEvent): void
{
  reminderScheduler.dispatchSystemEvent(event);
  trayController.refresh();
}

/**
 * @brief 启动系统托盘资源。
 */
function startTray(): void
{
  trayController.start();
}

/**
 * @brief 停止系统托盘资源并销毁图标。
 */
function stopTray(): void
{
  trayController.stop();
}

/**
 * @brief 打开或激活设置窗口的回调边界。
 *
 * 重复打开请求只激活已有窗口，不创建第二个设置窗口。
 */
function openSettingsWindow(): void
{
  if (settingsWindowController.isStarted()) {
    settingsWindowController.show();
    return;
  }

  if (isSmokeMode())
    activateExistingWindows();
}

/**
 * @brief 启动系统事件监视器资源。
 */
function startSystemEvents(): void
{
  systemEventMonitor.start();
}

/**
 * @brief 停止系统事件监视器资源。
 */
function stopSystemEvents(): void
{
  systemEventMonitor.stop();
}

/**
 * @brief 启动提醒调度器资源。
 */
function startScheduler(): void
{
  reminderScheduler.start();
}

/**
 * @brief 停止提醒调度器资源。
 */
function stopScheduler(): void
{
  reminderScheduler.stop();
}

/**
 * @brief 处理提醒窗口的“已休息”动作。
 */
function completeReminder(): boolean
{
  return reminderScheduler.dispatch({ type: ReminderCommandType.Complete });
}

/**
 * @brief 处理提醒窗口的“推迟”动作。
 */
function snoozeReminder(): boolean
{
  return reminderScheduler.dispatch({ type: ReminderCommandType.Snooze });
}

/**
 * @brief 处理窗口全部关闭事件，保留正式模式的后台生命周期。
 */
function handleAllWindowsClosed(): void
{
  if (isSmokeMode() && !isCleaningUp)
    app.quit();
}

/**
 * @brief 在 smoke 模式重新激活时恢复验证窗口。
 */
function handleActivate(): void
{
  if (!isCleaningUp && isSmokeMode() &&
      (smokeWindow === undefined || smokeWindow.isDestroyed()))
    createSmokeWindow();
}

/**
 * @brief 注销本进程注册的 Electron 应用事件。
 */
function unregisterApplicationEvents(): void
{
  app.removeListener("before-quit", handleBeforeQuit);
  app.removeListener("window-all-closed", handleAllWindowsClosed);
  app.removeListener("activate", handleActivate);
}

/**
 * @brief 移除 Electron 默认应用菜单。
 *
 * 程序只通过系统托盘和设置窗口提供操作；清空全局菜单可以避免 Windows
 * 窗口显示无用的 File、Edit、View 和 Window 菜单栏，同时不影响托盘菜单。
 */
function removeDefaultApplicationMenu(): void
{
  Menu.setApplicationMenu(null);
}

/**
 * @brief 在应用准备完成后加载设置并启动统一生命周期资源。
 */
async function startApplication(): Promise<void>
{
  if (isCleaningUp)
    return;

  removeDefaultApplicationMenu();

  const settingsStore = createSettingsStore(app.getPath("userData"));
  runtimeSettingsStore = settingsStore;
  const settings = await settingsStore.load();

  if (isCleaningUp)
    return;

  runtimeSettings.snoozeMinutes = settings.snoozeMinutes;
  runtimeSettings.autoStart = settings.autoStart;
  startupManager.synchronize(settings.autoStart);
  applicationLifecycle.start();
}

/**
 * @brief 返回当前运行中的设置副本。
 */
function loadSettings(): typeof runtimeSettings
{
  return { ...runtimeSettings };
}

/**
 * @brief 保存设置并立即同步运行时设置及开机自启。
 *
 * 推迟计时器由调度器自身持有剩余时间；这里只更新共享设置对象，因此
 * 已经开始的推迟倒计时不会被重新计算，下一次推迟才使用新值。
 */
async function saveSettings(value: unknown): Promise<typeof runtimeSettings>
{
  if (runtimeSettingsStore === undefined)
    throw new Error("Settings store is not ready");

  const previousSettings = { ...runtimeSettings };
  const savedSettings = await runtimeSettingsStore.save(value);

  if (
    startupManager.isManaged() &&
    !startupManager.setEnabled(savedSettings.autoStart)
  ) {
    await runtimeSettingsStore.save(previousSettings);
    throw new Error("Unable to update startup setting");
  }

  runtimeSettings.snoozeMinutes = savedSettings.snoozeMinutes;
  runtimeSettings.autoStart = savedSettings.autoStart;
  return { ...runtimeSettings };
}

/**
 * @brief 处理应用启动失败，确保失败路径也释放单实例监听。
 */
function handleStartupFailure(_error: unknown): void
{
  handleBeforeQuit();
  app.quit();
}

/**
 * @brief 清理卸载前的当前用户开机自启项并结束辅助进程。
 *
 * NSIS 在删除安装目录前调用同一个 Electron 可执行文件；辅助进程不取得
 * 单实例锁，也不启动托盘、窗口或计时器，只在 app ready 后执行平台清理。
 */
function clearAutostartForUninstall(): void
{
  startupManager.clearForUninstall();
  app.quit();
}

/**
 * @brief 在退出前按统一顺序释放所有应用资源并释放单实例状态。
 */
function handleBeforeQuit(): void
{
  if (isCleaningUp)
    return;

  isCleaningUp = true;
  unregisterApplicationEvents();

  try {
    applicationLifecycle.stop();
  } finally {
    singleInstanceManager.release();
  }
}

/**
 * @brief 将 Electron powerMonitor 适配为平台层最小宿主接口。
 */
const electronPowerMonitor: PowerMonitorHost = {
  /**
   * @brief 注册 Electron powerMonitor 事件监听器。
   */
  on: (eventName, listener): void => {
    switch (eventName) {
      case "lock-screen":
        powerMonitor.on("lock-screen", listener);
        break;
      case "unlock-screen":
        powerMonitor.on("unlock-screen", listener);
        break;
      case "suspend":
        powerMonitor.on("suspend", listener);
        break;
      case "resume":
        powerMonitor.on("resume", listener);
        break;
    }
  },
  /**
   * @brief 注销 Electron powerMonitor 事件监听器。
   */
  removeListener: (eventName, listener): void => {
    switch (eventName) {
      case "lock-screen":
        powerMonitor.removeListener("lock-screen", listener);
        break;
      case "unlock-screen":
        powerMonitor.removeListener("unlock-screen", listener);
        break;
      case "suspend":
        powerMonitor.removeListener("suspend", listener);
        break;
      case "resume":
        powerMonitor.removeListener("resume", listener);
        break;
    }
  }
};

/**
 * @brief 将 Electron app API 适配为当前用户登录项宿主。
 */
const electronStartupHost: StartupHost = {
  /**
   * @brief 查询 Electron 当前登录项状态。
   */
  getLoginItemSettings: () => app.getLoginItemSettings(),
  /**
   * @brief 更新 Electron 当前登录项状态。
   */
  setLoginItemSettings: (settings): void => {
    app.setLoginItemSettings(settings);
  }
};

/**
 * @brief 运行时加载的设置，供调度器使用。
 */
const runtimeSettings = { ...DEFAULT_SETTINGS };

/**
 * @brief 当前主进程使用的设置存储，在 app ready 后初始化。
 */
let runtimeSettingsStore: SettingsStore | undefined;

/**
 * @brief 当前主进程使用的开机自启管理器。
 */
const startupManager = new StartupManager({
  host: electronStartupHost,
  canModifyLoginItem: app.isPackaged && process.platform === "win32"
});

/**
 * @brief 当前主进程使用的提醒调度器实例。
 */
const reminderScheduler = new ReminderScheduler({
  clock: runtimeMonotonicClock,
  timerScheduler: runtimeTimerScheduler,
  settings: runtimeSettings,
  emit: handleReminderOutput
});

/**
 * @brief 提醒窗口控制器。
 */
const reminderWindowController = new ReminderWindowController({
  host: electronReminderWindowHost,
  getSnoozeMinutes: (): number => runtimeSettings.snoozeMinutes
});

/**
 * @brief 当前主进程使用的设置窗口控制器。
 */
const settingsWindowController = new SettingsWindowController({
  host: electronSettingsWindowHost,
  getSettings: loadSettings
});

/**
 * @brief 当前主进程使用的锁屏和电源事件监视器实例。
 */
const systemEventMonitor = new SystemEventMonitor(
  electronPowerMonitor,
  handleSystemEvent
);

/**
 * @brief 当前主进程使用的系统托盘控制器。
 */
const trayController = new TrayController({
  host: electronTrayHost,
  scheduler: reminderScheduler,
  openSettings: openSettingsWindow,
  quit: (): void => app.quit()
});

/**
 * @brief 当前入口使用的应用资源生命周期边界。
 */
const applicationLifecycle = new ApplicationLifecycle({
  ipc: {
    start: (): void => {
      registerIpcHandlers({
        completeReminder,
        snoozeReminder,
        loadSettings,
        saveSettings
      });
    },
    stop: unregisterIpcHandlers
  },
  tray: {
    start: startTray,
    stop: stopTray
  },
  windows: {
    start: startWindows,
    stop: stopWindows
  },
  systemEvents: {
    start: startSystemEvents,
    stop: stopSystemEvents
  },
  scheduler: {
    start: startScheduler,
    stop: stopScheduler
  }
});

/**
 * @brief 将 Electron app API 适配到可测试的单实例管理器。
 */
const singleInstanceManager = new SingleInstanceManager({
  requestSingleInstanceLock: (): boolean => app.requestSingleInstanceLock(),
  addSecondInstanceListener: (listener: () => void): void => {
    app.on("second-instance", listener);
  },
  removeSecondInstanceListener: (listener: () => void): void => {
    app.removeListener("second-instance", listener);
  },
  quit: (): void => app.quit()
}, activateExistingWindows);

let isCleaningUp = false;

/**
 * @brief 只有主实例才能注册 Electron 生命周期并启动应用。
 */
if (isClearAutostartMode()) {
  void app.whenReady().then(clearAutostartForUninstall).catch(() => {
    app.quit();
  });
} else if (singleInstanceManager.acquire()) {
  app.on("before-quit", handleBeforeQuit);
  app.on("window-all-closed", handleAllWindowsClosed);
  app.on("activate", handleActivate);
  void app.whenReady().then(startApplication).catch(handleStartupFailure);
}
