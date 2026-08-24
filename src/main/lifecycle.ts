/**
 * @brief 描述一个需要随应用启动和退出管理的资源。
 */
export interface LifecycleResource {
  /**
   * @brief 创建或注册资源。
   */
  start(): void;

  /**
   * @brief 注销或释放资源。
   */
  stop(): void;
}

/**
 * @brief 按应用依赖关系组织主进程资源的集合。
 *
 * Tray、窗口、系统事件和调度器虽然由不同任务实现，但必须共享同一个
 * 生命周期边界。显式字段保留它们的启动顺序，避免未来模块各自监听退出
 * 事件而造成重复释放或释放顺序错误。
 */
export interface ApplicationResources {
  ipc?: LifecycleResource;
  tray?: LifecycleResource;
  windows?: LifecycleResource;
  systemEvents?: LifecycleResource;
  scheduler?: LifecycleResource;
}

type ResourceName = keyof ApplicationResources;

const resourceStartOrder: readonly ResourceName[] = [
  "ipc",
  "tray",
  "windows",
  "systemEvents",
  "scheduler"
];

/**
 * @brief 管理应用资源的单次启动和可重复调用的退出清理。
 *
 * 启动按固定顺序执行，退出按相反顺序执行，使调度器先于系统监听器、
 * 窗口和托盘释放。退出清理会继续释放后续资源，避免单个资源异常阻塞
 * 其他资源的注销。
 */
export class ApplicationLifecycle
{
  private started = false;
  private stopped = false;
  private startedResources: LifecycleResource[] = [];

  /**
   * @brief 创建应用生命周期管理器。
   */
  constructor(private readonly resources: ApplicationResources)
  {
  }

  /**
   * @brief 按既定顺序启动所有已提供的资源。
   *
   * 启动失败时会回滚已经启动的资源，避免半初始化应用继续运行。
   * @return 本次调用是否真正启动了资源。
   */
  start(): boolean
  {
    if (this.started || this.stopped)
      return false;

    try {
      for (const resourceName of resourceStartOrder) {
        const resource = this.resources[resourceName];
        if (resource === undefined)
          continue;

        resource.start();
        this.startedResources.push(resource);
      }
    } catch (error) {
      this.stopped = true;
      this.started = false;
      this.stopStartedResources();
      throw error;
    }

    this.started = true;
    return true;
  }

  /**
   * @brief 按依赖逆序释放已启动资源。
   *
   * stop 是幂等的；这样 Electron 的 before-quit、启动失败和测试清理可以
   * 共用同一入口，不会重复注销 IPC 或销毁托盘。
   */
  stop(): void
  {
    if (this.stopped)
      return;

    this.stopped = true;
    this.started = false;
    this.stopStartedResources();
  }

  /**
   * @brief 返回生命周期是否已经完成启动。
   */
  isStarted(): boolean
  {
    return this.started;
  }

  /**
   * @brief 释放已启动资源，并继续处理其他资源的清理。
   */
  private stopStartedResources(): void
  {
    for (let index = this.startedResources.length - 1; index >= 0; index -= 1) {
      try {
        this.startedResources[index].stop();
      } catch {
        // 单个资源清理失败不能阻塞后续资源释放，退出路径由调用方统一结束。
      }
    }

    this.startedResources = [];
  }
}
