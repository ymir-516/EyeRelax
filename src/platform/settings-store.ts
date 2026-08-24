import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SETTINGS_FILE_NAME,
  SettingsStore,
  type SettingsFileSystem
} from "../core/settings-store.js";

/**
 * @brief 将 Node.js 文件系统适配为核心设置存储需要的接口。
 */
const nodeSettingsFileSystem: SettingsFileSystem = {
  /**
   * @brief 递归创建设置目录。
   */
  mkdir: async (directoryPath): Promise<void> => {
    await mkdir(directoryPath, { recursive: true });
  },

  /**
   * @brief 读取 UTF-8 设置文件。
   */
  readFile: (filePath): Promise<string> => readFile(filePath, "utf8"),

  /**
   * @brief 写入 UTF-8 临时设置文件。
   */
  writeFile: (filePath, content): Promise<void> => writeFile(filePath, content, "utf8"),

  /**
   * @brief 原子替换设置文件。
   */
  rename,

  /**
   * @brief 删除失败写入留下的临时文件。
   */
  unlink
};

/**
 * @brief 创建位于 Electron userData 目录中的设置存储。
 *
 * 调用方负责将 `app.getPath("userData")` 传入本函数；平台适配层只负责
 * 拼接固定文件名，不在核心存储中引入 Electron 依赖。
 */
export function createSettingsStore(userDataPath: string): SettingsStore
{
  return new SettingsStore(
    join(userDataPath, SETTINGS_FILE_NAME),
    nodeSettingsFileSystem
  );
}
