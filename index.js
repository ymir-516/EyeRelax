"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = require("node:path");
const model_js_1 = require("../core/model.js");
const reminder_scheduler_js_1 = require("../core/reminder-scheduler.js");
const ipc_js_1 = require("./ipc.js");
const lifecycle_js_1 = require("./lifecycle.js");
const single_instance_js_1 = require("./single-instance.js");
const tray_controller_js_1 = require("./tray-controller.js");
const system_event_monitor_js_1 = require("../platform/system-event-monitor.js");
const runtime_timer_js_1 = require("../platform/runtime-timer.js");
const settings_store_js_1 = require("../platform/settings-store.js");
const startup_manager_js_1 = require("../platform/startup-manager.js");
const reminder_window_js_1 = require("./reminder-window.js");
const settings_window_js_1 = require("./settings-window.js");
const smokeFlag = "--smoke";
const clearAutostartFlag = "--clear-autostart";
/**
 * @brief 当前 smoke 验证窗口，避免第二实例激活时误显示隐藏提醒窗口。
 */
let smokeWindow;
/**
 * @brief 判断当前启动是否为仅用于图形链路验证的 smoke 模式。
 */
function isSmokeMode() {
    return process.argv.includes(smokeFlag);
}
/**
 * @brief 判断当前启动是否为卸载器请求的开机自启清理模式。
 */
function isClearAutostartMode() {
    return process.argv.includes(clearAutostartFlag);
}
/**
 * @brief 创建 T00/T01 共用的最小可视化验证窗口。
 *
 * 正式后台模式不创建此窗口；显式传入 smoke 标志才显示页面，从而保证
 * 后续提醒弹窗可以独立于常驻主窗口实现。
 */
function createSmokeWindow() {
    if (smokeWindow !== undefined && !smokeWindow.isDestroyed())
        return;
    const window = new electron_1.BrowserWindow({
        width: 420,
        height: 240,
        resizable: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            preload: (0, node_path_1.join)(__dirname, "../preload/index.js")
        }
    });
    smokeWindow = window;
    window.on("closed", () => {
        if (smokeWindow === window)
            smokeWindow = undefined;
    });
    void window.loadFile((0, node_path_1.join)(electron_1.app.getAppPath(), "src/renderer/index.html"));
}
/**
 * @brief 创建 Electron 提醒窗口适配层。
 *
 * 控制器只依赖窗口和屏幕的最小接口，Electron 事件对象在这里转换，避免核心窗口逻辑
 * 必须依赖真实 GUI 环境才能测试。
 */
const electronReminderWindowHost = {
    /**
     * @brief 创建并适配 Electron BrowserWindow。
     */
    createWindow: (options) => {
        const window = new electron_1.BrowserWindow({
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
                contextIsolation: true,
                nodeIntegration: false,
                preload: (0, node_path_1.join)(__dirname, "../preload/index.js")
            }
        });
        return {
            /**
             * @brief 转换提醒窗口关闭事件。
             */
            onClose: (listener) => {
                window.on("close", (event) => {
                    const closeEvent = {
                        preventDefault: () => event.preventDefault()
                    };
                    listener(closeEvent);
                });
            },
            isDestroyed: () => window.isDestroyed(),
            isMinimized: () => window.isMinimized(),
            load: (snoozeMinutes) => {
                void window.loadFile((0, node_path_1.join)(electron_1.app.getAppPath(), "src/renderer/reminder.html"), { query: { snoozeMinutes: String(snoozeMinutes) } });
            },
            setPosition: (x, y) => {
                window.setPosition(x, y);
            },
            show: () => {
                window.show();
            },
            hide: () => {
                window.hide();
            },
            restore: () => {
                window.restore();
            },
            focus: () => {
                window.focus();
            },
            destroy: () => {
                window.destroy();
            }
        };
    },
    /**
     * @brief 获取当前鼠标所在屏幕坐标。
     */
    getCursorScreenPoint: () => electron_1.screen.getCursorScreenPoint(),
    /**
     * @brief 获取鼠标所在屏幕的工作区。
     */
    getDisplayNearestPoint: (point) => {
        return electron_1.screen.getDisplayNearestPoint(point).workArea;
    }
};
/**
 * @brief 创建 Electron 设置窗口适配层。
 *
 * 设置窗口只加载本地 renderer 页面，并沿用提醒窗口的 preload 安全边界；
 * 设置值通过受限 IPC 读取和保存，不把文件系统能力暴露给渲染进程。
 */
const electronSettingsWindowHost = {
    /**
     * @brief 创建并适配 Electron BrowserWindow。
     */
    createWindow: (options) => {
        const window = new electron_1.BrowserWindow({
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
                contextIsolation: true,
                nodeIntegration: false,
                preload: (0, node_path_1.join)(__dirname, "../preload/index.js")
            }
        });
        return {
            /**
             * @brief 转换设置窗口关闭事件。
             */
            onClose: (listener) => {
                window.on("close", (event) => {
                    const closeEvent = {
                        preventDefault: () => event.preventDefault()
                    };
                    listener(closeEvent);
                });
            },
            /**
             * @brief 返回设置窗口销毁状态。
             */
            isDestroyed: () => window.isDestroyed(),
            /**
             * @brief 返回设置窗口最小化状态。
             */
            isMinimized: () => window.isMinimized(),
            /**
             * @brief 加载设置页面并传递启动时设置快照。
             */
            load: (settings) => {
                void window.loadFile((0, node_path_1.join)(electron_1.app.getAppPath(), "src/renderer/settings.html"), {
                    query: {
                        snoozeMinutes: String(settings.snoozeMinutes),
                        autoStart: String(settings.autoStart)
                    }
                });
            },
            /**
             * @brief 显示设置窗口。
             */
            show: () => {
                window.show();
            },
            /**
             * @brief 隐藏设置窗口。
             */
            hide: () => {
                window.hide();
            },
            /**
             * @brief 恢复设置窗口。
             */
            restore: () => {
                window.restore();
            },
            /**
             * @brief 聚焦设置窗口。
             */
            focus: () => {
                window.focus();
            },
            /**
             * @brief 强制销毁设置窗口。
             */
            destroy: () => {
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
function activateExistingWindows() {
    const currentSmokeWindow = smokeWindow;
    if (currentSmokeWindow !== undefined && !currentSmokeWindow.isDestroyed()) {
        if (currentSmokeWindow.isMinimized())
            currentSmokeWindow.restore();
        currentSmokeWindow.show();
        currentSmokeWindow.focus();
    }
    settingsWindowController.bringToFront();
    if (reminderScheduler.getState() === model_js_1.ReminderState.ReminderVisible)
        reminderWindowController.bringToFront();
}
/**
 * @brief 按当前模式创建应用窗口资源。
 */
function startWindows() {
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
function stopWindows() {
    settingsWindowController.stop();
    reminderWindowController.stop();
    for (const window of electron_1.BrowserWindow.getAllWindows()) {
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
const trayIconData = {
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
function createTrayIcon(state) {
    return electron_1.nativeImage.createFromDataURL(trayIconData[state]);
}
/**
 * @brief 将 Electron Tray 和 Menu 适配为托盘控制器宿主。
 */
const electronTrayHost = {
    /**
     * @brief 创建 Electron 托盘实例及其操作适配。
     */
    createTray: () => {
        const tray = new electron_1.Tray(createTrayIcon("running"));
        return {
            setImage: (state) => {
                tray.setImage(createTrayIcon(state));
            },
            setToolTip: (toolTip) => {
                tray.setToolTip(toolTip);
            },
            setContextMenu: (menu) => {
                tray.setContextMenu(menu);
            },
            destroy: () => {
                tray.destroy();
            }
        };
    },
    /**
     * @brief 将平台无关菜单模板转换为 Electron Menu。
     */
    buildContextMenu: (template) => {
        return electron_1.Menu.buildFromTemplate(template.map((item) => {
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
function handleReminderOutput(event) {
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
function handleSystemEvent(event) {
    reminderScheduler.dispatchSystemEvent(event);
    trayController.refresh();
}
/**
 * @brief 启动系统托盘资源。
 */
function startTray() {
    trayController.start();
}
/**
 * @brief 停止系统托盘资源并销毁图标。
 */
function stopTray() {
    trayController.stop();
}
/**
 * @brief 打开或激活设置窗口的回调边界。
 *
 * 重复打开请求只激活已有窗口，不创建第二个设置窗口。
 */
function openSettingsWindow() {
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
function startSystemEvents() {
    systemEventMonitor.start();
}
/**
 * @brief 停止系统事件监视器资源。
 */
function stopSystemEvents() {
    systemEventMonitor.stop();
}
/**
 * @brief 启动提醒调度器资源。
 */
function startScheduler() {
    reminderScheduler.start();
}
/**
 * @brief 停止提醒调度器资源。
 */
function stopScheduler() {
    reminderScheduler.stop();
}
/**
 * @brief 处理提醒窗口的“已休息”动作。
 */
function completeReminder() {
    return reminderScheduler.dispatch({ type: model_js_1.ReminderCommandType.Complete });
}
/**
 * @brief 处理提醒窗口的“推迟”动作。
 */
function snoozeReminder() {
    return reminderScheduler.dispatch({ type: model_js_1.ReminderCommandType.Snooze });
}
/**
 * @brief 处理窗口全部关闭事件，保留正式模式的后台生命周期。
 */
function handleAllWindowsClosed() {
    if (isSmokeMode() && !isCleaningUp)
        electron_1.app.quit();
}
/**
 * @brief 在 smoke 模式重新激活时恢复验证窗口。
 */
function handleActivate() {
    if (!isCleaningUp && isSmokeMode() &&
        (smokeWindow === undefined || smokeWindow.isDestroyed()))
        createSmokeWindow();
}
/**
 * @brief 注销本进程注册的 Electron 应用事件。
 */
function unregisterApplicationEvents() {
    electron_1.app.removeListener("before-quit", handleBeforeQuit);
    electron_1.app.removeListener("window-all-closed", handleAllWindowsClosed);
    electron_1.app.removeListener("activate", handleActivate);
}
/**
 * @brief 移除 Electron 默认应用菜单。
 *
 * 程序只通过系统托盘和设置窗口提供操作；清空全局菜单可以避免 Windows
 * 窗口显示无用的 File、Edit、View 和 Window 菜单栏，同时不影响托盘菜单。
 */
function removeDefaultApplicationMenu() {
    electron_1.Menu.setApplicationMenu(null);
}
/**
 * @brief 在应用准备完成后加载设置并启动统一生命周期资源。
 */
async function startApplication() {
    if (isCleaningUp)
        return;
    removeDefaultApplicationMenu();
    const settingsStore = (0, settings_store_js_1.createSettingsStore)(electron_1.app.getPath("userData"));
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
function loadSettings() {
    return { ...runtimeSettings };
}
/**
 * @brief 保存设置并立即同步运行时设置及开机自启。
 *
 * 推迟计时器由调度器自身持有剩余时间；这里只更新共享设置对象，因此
 * 已经开始的推迟倒计时不会被重新计算，下一次推迟才使用新值。
 */
async function saveSettings(value) {
    if (runtimeSettingsStore === undefined)
        throw new Error("Settings store is not ready");
    const previousSettings = { ...runtimeSettings };
    const savedSettings = await runtimeSettingsStore.save(value);
    if (startupManager.isManaged() &&
        !startupManager.setEnabled(savedSettings.autoStart)) {
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
function handleStartupFailure(_error) {
    handleBeforeQuit();
    electron_1.app.quit();
}
/**
 * @brief 清理卸载前的当前用户开机自启项并结束辅助进程。
 *
 * NSIS 在删除安装目录前调用同一个 Electron 可执行文件；辅助进程不取得
 * 单实例锁，也不启动托盘、窗口或计时器，只在 app ready 后执行平台清理。
 */
function clearAutostartForUninstall() {
    startupManager.clearForUninstall();
    electron_1.app.quit();
}
/**
 * @brief 在退出前按统一顺序释放所有应用资源并释放单实例状态。
 */
function handleBeforeQuit() {
    if (isCleaningUp)
        return;
    isCleaningUp = true;
    unregisterApplicationEvents();
    try {
        applicationLifecycle.stop();
    }
    finally {
        singleInstanceManager.release();
    }
}
/**
 * @brief 将 Electron powerMonitor 适配为平台层最小宿主接口。
 */
const electronPowerMonitor = {
    /**
     * @brief 注册 Electron powerMonitor 事件监听器。
     */
    on: (eventName, listener) => {
        switch (eventName) {
            case "lock-screen":
                electron_1.powerMonitor.on("lock-screen", listener);
                break;
            case "unlock-screen":
                electron_1.powerMonitor.on("unlock-screen", listener);
                break;
            case "suspend":
                electron_1.powerMonitor.on("suspend", listener);
                break;
            case "resume":
                electron_1.powerMonitor.on("resume", listener);
                break;
        }
    },
    /**
     * @brief 注销 Electron powerMonitor 事件监听器。
     */
    removeListener: (eventName, listener) => {
        switch (eventName) {
            case "lock-screen":
                electron_1.powerMonitor.removeListener("lock-screen", listener);
                break;
            case "unlock-screen":
                electron_1.powerMonitor.removeListener("unlock-screen", listener);
                break;
            case "suspend":
                electron_1.powerMonitor.removeListener("suspend", listener);
                break;
            case "resume":
                electron_1.powerMonitor.removeListener("resume", listener);
                break;
        }
    }
};
/**
 * @brief 将 Electron app API 适配为当前用户登录项宿主。
 */
const electronStartupHost = {
    /**
     * @brief 查询 Electron 当前登录项状态。
     */
    getLoginItemSettings: () => electron_1.app.getLoginItemSettings(),
    /**
     * @brief 更新 Electron 当前登录项状态。
     */
    setLoginItemSettings: (settings) => {
        electron_1.app.setLoginItemSettings(settings);
    }
};
/**
 * @brief 运行时加载的设置，供调度器使用。
 */
const runtimeSettings = { ...model_js_1.DEFAULT_SETTINGS };
/**
 * @brief 当前主进程使用的设置存储，在 app ready 后初始化。
 */
let runtimeSettingsStore;
/**
 * @brief 当前主进程使用的开机自启管理器。
 */
const startupManager = new startup_manager_js_1.StartupManager({
    host: electronStartupHost,
    canModifyLoginItem: electron_1.app.isPackaged && process.platform === "win32"
});
/**
 * @brief 当前主进程使用的提醒调度器实例。
 */
const reminderScheduler = new reminder_scheduler_js_1.ReminderScheduler({
    clock: runtime_timer_js_1.runtimeMonotonicClock,
    timerScheduler: runtime_timer_js_1.runtimeTimerScheduler,
    settings: runtimeSettings,
    emit: handleReminderOutput
});
/**
 * @brief 提醒窗口控制器。
 */
const reminderWindowController = new reminder_window_js_1.ReminderWindowController({
    host: electronReminderWindowHost,
    getSnoozeMinutes: () => runtimeSettings.snoozeMinutes
});
/**
 * @brief 当前主进程使用的设置窗口控制器。
 */
const settingsWindowController = new settings_window_js_1.SettingsWindowController({
    host: electronSettingsWindowHost,
    getSettings: loadSettings
});
/**
 * @brief 当前主进程使用的锁屏和电源事件监视器实例。
 */
const systemEventMonitor = new system_event_monitor_js_1.SystemEventMonitor(electronPowerMonitor, handleSystemEvent);
/**
 * @brief 当前主进程使用的系统托盘控制器。
 */
const trayController = new tray_controller_js_1.TrayController({
    host: electronTrayHost,
    scheduler: reminderScheduler,
    openSettings: openSettingsWindow,
    quit: () => electron_1.app.quit()
});
/**
 * @brief 当前入口使用的应用资源生命周期边界。
 */
const applicationLifecycle = new lifecycle_js_1.ApplicationLifecycle({
    ipc: {
        start: () => {
            (0, ipc_js_1.registerIpcHandlers)({
                completeReminder,
                snoozeReminder,
                loadSettings,
                saveSettings
            });
        },
        stop: ipc_js_1.unregisterIpcHandlers
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
const singleInstanceManager = new single_instance_js_1.SingleInstanceManager({
    requestSingleInstanceLock: () => electron_1.app.requestSingleInstanceLock(),
    addSecondInstanceListener: (listener) => {
        electron_1.app.on("second-instance", listener);
    },
    removeSecondInstanceListener: (listener) => {
        electron_1.app.removeListener("second-instance", listener);
    },
    quit: () => electron_1.app.quit()
}, activateExistingWindows);
let isCleaningUp = false;
/**
 * @brief 只有主实例才能注册 Electron 生命周期并启动应用。
 */
if (isClearAutostartMode()) {
    void electron_1.app.whenReady().then(clearAutostartForUninstall).catch(() => {
        electron_1.app.quit();
    });
}
else if (singleInstanceManager.acquire()) {
    electron_1.app.on("before-quit", handleBeforeQuit);
    electron_1.app.on("window-all-closed", handleAllWindowsClosed);
    electron_1.app.on("activate", handleActivate);
    void electron_1.app.whenReady().then(startApplication).catch(handleStartupFailure);
}
//# sourceMappingURL=index.js.map