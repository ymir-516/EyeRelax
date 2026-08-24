/**
 * @brief 描述 Electron 登录项查询结果所需的最小字段。
 */
export interface LoginItemSettings {
  openAtLogin: boolean;
}

/**
 * @brief 描述 Electron 登录项设置操作所需的最小宿主能力。
 *
 * 通过宿主接口隔离 Electron，使开发环境可以用内存替身验证开关逻辑，
 * 而不会触碰当前 Linux 或开发 Windows 用户的真实登录项。
 */
export interface StartupHost {
  /**
   * @brief 查询当前用户登录时是否启动应用。
   */
  getLoginItemSettings(): LoginItemSettings;

  /**
   * @brief 写入当前用户登录项设置。
   */
  setLoginItemSettings(settings: {
    openAtLogin: boolean;
    enabled: boolean;
  }): void;
}

/**
 * @brief 配置开机自启管理器的运行能力。
 */
export interface StartupManagerOptions {
  host: StartupHost;
  canModifyLoginItem: boolean;
}

/**
 * @brief 管理当前用户的应用开机自启登录项。
 *
 * 开发模式和非 Windows 平台会被标记为不可修改，此时所有查询和写入都
 * 直接短路。正式 Windows 程序按持久化设置同步登录项，不需要管理员权限。
 */
export class StartupManager
{
  private readonly canModifyLoginItem: boolean;

  /**
   * @brief 创建开机自启管理器。
   */
  constructor(options: StartupManagerOptions)
  {
    this.host = options.host;
    this.canModifyLoginItem = options.canModifyLoginItem;
  }

  private readonly host: StartupHost;

  /**
   * @brief 返回当前运行是否允许访问和修改真实登录项。
   */
  isManaged(): boolean
  {
    return this.canModifyLoginItem;
  }

  /**
   * @brief 查询当前用户登录项状态。
   *
   * 开发模式返回 undefined，避免把开发机真实登录项状态暴露为本程序状态。
   */
  getEnabled(): boolean | undefined
  {
    if (!this.canModifyLoginItem)
      return undefined;

    try {
      return this.host.getLoginItemSettings().openAtLogin;
    } catch {
      return undefined;
    }
  }

  /**
   * @brief 按设置同步当前用户登录项。
   *
   * `enabled` 与 `openAtLogin` 同步设置，确保 Windows 启动项既存在又处于
   * 可执行状态；登录项写入失败时返回 false，但不阻塞应用正常启动。
   */
  synchronize(desiredEnabled: boolean): boolean
  {
    if (!this.canModifyLoginItem)
      return false;

    try {
      this.host.setLoginItemSettings({
        openAtLogin: desiredEnabled,
        enabled: desiredEnabled
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @brief 修改设置窗口要求的开机自启状态。
   */
  setEnabled(enabled: boolean): boolean
  {
    return this.synchronize(enabled);
  }

  /**
   * @brief 为卸载流程清理当前用户登录项。
   *
   * 普通退出不会调用此方法，因为开机自启设置必须跨进程重启保留；卸载
   * 流程可在删除应用数据前显式调用它。
   */
  clearForUninstall(): boolean
  {
    return this.synchronize(false);
  }
}
