import { dirname } from "node:path";
import {
  DEFAULT_SETTINGS,
  type ReminderSettings
} from "./model.js";

/**
 * @brief 设置文件的固定文件名。
 */
export const SETTINGS_FILE_NAME = "settings.json";

/**
 * @brief 推迟分钟数允许的最小值。
 */
export const MIN_SNOOZE_MINUTES = 1;

/**
 * @brief 推迟分钟数允许的最大值。
 */
export const MAX_SNOOZE_MINUTES = 10;

/**
 * @brief 提醒周期允许使用的最小分钟数
 */
export const MIN_REMINDER_INTERVAL_MINUTES = 1;

/**
 * @brief 提醒周期允许使用的最大分钟数
 */
export const MAX_REMINDER_INTERVAL_MINUTES = 120;

/**
 * @brief 描述设置存储需要的最小文件系统能力。
 *
 * 通过接口注入文件系统，设置校验和原子写入可以在 Linux 测试环境中
 * 使用替身执行，而不需要修改真实用户目录。
 */
export interface SettingsFileSystem {
  /**
   * @brief 递归创建设置目录。
   */
  mkdir(directoryPath: string): Promise<void>;

  /**
   * @brief 以 UTF-8 文本读取设置文件。
   */
  readFile(filePath: string): Promise<string>;

  /**
   * @brief 以 UTF-8 文本写入临时设置文件。
   */
  writeFile(filePath: string, content: string): Promise<void>;

  /**
   * @brief 使用重命名完成同一文件系统内的原子替换。
   */
  rename(sourcePath: string, targetPath: string): Promise<void>;

  /**
   * @brief 删除临时文件。
   */
  unlink(filePath: string): Promise<void>;
}

/**
 * @brief 表示设置输入不符合产品约束的错误。
 */
export class SettingsValidationError extends Error
{
  /**
   * @brief 创建设置校验错误。
   */
  constructor(message: string)
  {
    super(message);
    this.name = "SettingsValidationError";
  }
}

/**
 * @brief 判断未知值是否为可读取字段的普通对象。
 */
function isSettingsRecord(value: unknown): value is Record<string, unknown>
{
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @brief 读取提醒周期配置，并为旧版缺失字段补充默认值
 *
 * 只有缺少字段时才使用默认值；显式提供的值仍必须通过完整范围校验。
 */
function readReminderInterval(
  value: Record<string, unknown>,
  name: "eyeRestIntervalMinutes" | "standingIntervalMinutes",
  defaultValue: number
): number
{
  if (!Object.prototype.hasOwnProperty.call(value, name))
    return defaultValue;

  const intervalMinutes = value[name];
  if (
    typeof intervalMinutes !== "number" ||
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < MIN_REMINDER_INTERVAL_MINUTES ||
    intervalMinutes > MAX_REMINDER_INTERVAL_MINUTES
  )
    throw new SettingsValidationError(
      `${name} must be an integer from 1 to 120`
    );

  return intervalMinutes;
}

/**
 * @brief 校验并复制设置值，确保调用方不能带入运行时状态字段。
 *
 * 持久化只接受本期定义的两个字段；计时器、推迟中的剩余时间、暂停状态
 * 和历史记录不会从输入对象进入 settings.json。
 */
export function validateSettings(value: unknown): ReminderSettings
{
  if (!isSettingsRecord(value))
    throw new SettingsValidationError("Settings must be an object");

  const snoozeMinutes = value.snoozeMinutes;

  if (
    typeof snoozeMinutes !== "number" ||
    !Number.isInteger(snoozeMinutes) ||
    snoozeMinutes < MIN_SNOOZE_MINUTES ||
    snoozeMinutes > MAX_SNOOZE_MINUTES
  )
    throw new SettingsValidationError("snoozeMinutes must be an integer from 1 to 10");

  if (typeof value.autoStart !== "boolean")
    throw new SettingsValidationError("autoStart must be a boolean");

  const eyeRestIntervalMinutes = readReminderInterval(
    value,
    "eyeRestIntervalMinutes",
    DEFAULT_SETTINGS.eyeRestIntervalMinutes
  );
  const standingIntervalMinutes = readReminderInterval(
    value,
    "standingIntervalMinutes",
    DEFAULT_SETTINGS.standingIntervalMinutes
  );

  return {
    snoozeMinutes,
    autoStart: value.autoStart,
    eyeRestIntervalMinutes,
    standingIntervalMinutes
  };
}

/**
 * @brief 创建一份不会修改全局默认对象的默认设置副本。
 */
function cloneDefaultSettings(): ReminderSettings
{
  return {
    snoozeMinutes: DEFAULT_SETTINGS.snoozeMinutes,
    autoStart: DEFAULT_SETTINGS.autoStart,
    eyeRestIntervalMinutes: DEFAULT_SETTINGS.eyeRestIntervalMinutes,
    standingIntervalMinutes: DEFAULT_SETTINGS.standingIntervalMinutes
  };
}

/**
 * @brief 负责设置校验、加载、修复和原子持久化。
 */
export class SettingsStore
{
  /**
   * @brief 创建设置存储。
   *
   * @param settingsPath settings.json 的完整路径，正式环境应位于 userData 目录。
   * @param fileSystem 注入的文件系统实现。
   */
  constructor(
    private readonly settingsPath: string,
    private readonly fileSystem: SettingsFileSystem
  )
  {
  }

  /**
   * @brief 加载设置，文件缺失、损坏或字段非法时回退并尝试修复默认文件。
   */
  async load(): Promise<ReminderSettings>
  {
    try {
      const content = await this.fileSystem.readFile(this.settingsPath);
      return validateSettings(JSON.parse(content) as unknown);
    } catch {
      const defaults = cloneDefaultSettings();

      try {
        await this.persist(defaults);
      } catch {
        // 设置文件不可写时仍允许程序使用内存中的默认值启动。
      }

      return defaults;
    }
  }

  /**
   * @brief 校验并原子保存设置。
   *
   * @return 实际保存的字段副本。
   */
  async save(value: unknown): Promise<ReminderSettings>
  {
    const settings = validateSettings(value);
    await this.persist(settings);
    return { ...settings };
  }

  /**
   * @brief 通过临时文件写入并重命名替换正式设置文件。
   */
  private async persist(settings: ReminderSettings): Promise<void>
  {
    const temporaryPath = `${this.settingsPath}.tmp`;
    const content = `${JSON.stringify(settings)}\n`;

    await this.fileSystem.mkdir(dirname(this.settingsPath));

    try {
      await this.fileSystem.writeFile(temporaryPath, content);
      await this.fileSystem.rename(temporaryPath, this.settingsPath);
    } catch (error) {
      try {
        await this.fileSystem.unlink(temporaryPath);
      } catch {
        // 清理失败不能覆盖原始持久化错误。
      }

      throw error;
    }
  }
}
