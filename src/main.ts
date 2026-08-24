import { app, BrowserWindow } from "electron";
import { join } from "node:path";

/**
 * @brief 创建用于验证 Linux Electron 图形链路的最小窗口。
 *
 * 该窗口只验证主进程、预加载脚本、渲染页面和 WSLg 之间的基本连接，
 * 不承载正式产品逻辑，避免在 T00 阶段提前引入业务状态。
 */
function createSmokeWindow(): void
{
  const window = new BrowserWindow({
    width: 420,
    height: 240,
    resizable: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.js")
    }
  });

  void window.loadFile(join(app.getAppPath(), "src/renderer/index.html"));
}

/**
 * @brief 在非 macOS 平台关闭最后一个窗口时结束基线程序。
 */
function handleAllWindowsClosed(): void
{
  if (process.platform !== "darwin")
    app.quit();
}

/**
 * @brief 响应桌面应用重新激活事件，确保至少存在一个基线窗口。
 */
function activateApplication(): void
{
  if (BrowserWindow.getAllWindows().length === 0)
    createSmokeWindow();
}

app.whenReady().then(createSmokeWindow);
app.on("window-all-closed", handleAllWindowsClosed);
app.on("activate", activateApplication);
