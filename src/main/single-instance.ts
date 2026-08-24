/**
 * @brief 定义单实例管理所需的最小应用宿主能力。
 *
 * Electron 的 app API 通过适配器实现该接口，测试可以使用内存替身验证
 * 第二实例和释放行为，而不需要启动 Electron 或 Windows 环境。
 */
export interface SingleInstanceHost {
  /**
   * @brief 请求当前用户会话的单实例锁。
   */
  requestSingleInstanceLock(): boolean;

  /**
   * @brief 注册第二实例回调。
   */
  addSecondInstanceListener(listener: () => void): void;

  /**
   * @brief 注销第二实例回调。
   */
  removeSecondInstanceListener(listener: () => void): void;

  /**
   * @brief 退出未能取得锁的进程。
   */
  quit(): void;
}

/**
 * @brief 管理当前用户会话中的单实例锁和第二实例通知。
 */
export class SingleInstanceManager
{
  private acquired = false;

  private readonly secondInstanceListener = (): void => {
    if (this.acquired)
      this.onSecondInstance();
  };

  /**
   * @brief 创建单实例管理器。
   *
   * @param host Electron app 的抽象宿主。
   * @param onSecondInstance 第二实例触发时激活已有窗口的回调。
   */
  constructor(
    private readonly host: SingleInstanceHost,
    private readonly onSecondInstance: () => void
  )
  {
  }

  /**
   * @brief 获取单实例锁并注册第二实例监听。
   *
   * 获取失败的进程立即请求退出，不创建任何应用资源。
   * @return 当前进程是否为主实例。
   */
  acquire(): boolean
  {
    if (this.acquired)
      return true;

    if (!this.host.requestSingleInstanceLock()) {
      this.host.quit();
      return false;
    }

    this.acquired = true;
    this.host.addSecondInstanceListener(this.secondInstanceListener);
    return true;
  }

  /**
   * @brief 注销第二实例监听并释放本地管理状态。
   *
   * Electron 的锁随进程结束自动释放；这里显式移除回调，防止退出流程中
   * 已释放的窗口和资源再次响应第二实例事件。
   */
  release(): void
  {
    if (!this.acquired)
      return;

    this.acquired = false;
    this.host.removeSecondInstanceListener(this.secondInstanceListener);
  }

  /**
   * @brief 返回当前进程是否持有单实例锁。
   */
  isAcquired(): boolean
  {
    return this.acquired;
  }
}
