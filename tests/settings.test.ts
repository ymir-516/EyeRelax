import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SETTINGS_FILE_NAME,
  SettingsStore,
  SettingsValidationError,
  type SettingsFileSystem
} from "../src/core/settings-store.js";

/**
 * @brief 提供设置存储测试使用的内存文件系统。
 */
class MemorySettingsFileSystem implements SettingsFileSystem
{
  readonly directories = new Set<string>();
  readonly files = new Map<string, string>();
  readonly renamedFiles: Array<{ source: string; target: string }> = [];

  /**
   * @brief 记录递归目录创建请求。
   */
  async mkdir(directoryPath: string): Promise<void>
  {
    this.directories.add(directoryPath);
  }

  /**
   * @brief 读取内存中的文件，不存在时模拟文件异常。
   */
  async readFile(filePath: string): Promise<string>
  {
    const content = this.files.get(filePath);
    if (content === undefined)
      throw new Error("file not found");

    return content;
  }

  /**
   * @brief 写入内存中的临时文件。
   */
  async writeFile(filePath: string, content: string): Promise<void>
  {
    this.files.set(filePath, content);
  }

  /**
   * @brief 模拟同一文件系统内的原子重命名。
   */
  async rename(sourcePath: string, targetPath: string): Promise<void>
  {
    const content = this.files.get(sourcePath);
    if (content === undefined)
      throw new Error("temporary file not found");

    this.files.delete(sourcePath);
    this.files.set(targetPath, content);
    this.renamedFiles.push({ source: sourcePath, target: targetPath });
  }

  /**
   * @brief 删除内存中的临时文件。
   */
  async unlink(filePath: string): Promise<void>
  {
    this.files.delete(filePath);
  }

  /**
   * @brief 预置一个文件内容以模拟损坏或非法设置文件。
   */
  seed(filePath: string, content: string): void
  {
    this.files.set(filePath, content);
  }
}

/**
 * @brief 创建使用固定 userData 路径的内存设置存储夹具。
 */
function createStore(): {
  fileSystem: MemorySettingsFileSystem;
  store: SettingsStore;
  settingsPath: string;
}
{
  const fileSystem = new MemorySettingsFileSystem();
  const settingsPath = `/test-user-data/${SETTINGS_FILE_NAME}`;

  return {
    fileSystem,
    store: new SettingsStore(settingsPath, fileSystem),
    settingsPath
  };
}

/**
 * @brief 验证首次加载会创建目录并返回默认设置。
 */
async function verifyDefaultSettings(): Promise<void>
{
  const fixture = createStore();

  assert.deepEqual(await fixture.store.load(), {
    snoozeMinutes: 3,
    autoStart: true
  });
  assert.equal(fixture.fileSystem.directories.has("/test-user-data"), true);
  assert.deepEqual(JSON.parse(fixture.fileSystem.files.get(fixture.settingsPath) ?? "{}"), {
    snoozeMinutes: 3,
    autoStart: true
  });
}

/**
 * @brief 验证合法边界可保存，非法推迟分钟数会被拒绝。
 */
async function verifySettingsValidation(): Promise<void>
{
  const fixture = createStore();

  assert.deepEqual(await fixture.store.save({ snoozeMinutes: 1, autoStart: false }), {
    snoozeMinutes: 1,
    autoStart: false
  });
  assert.deepEqual(await fixture.store.save({ snoozeMinutes: 10, autoStart: true }), {
    snoozeMinutes: 10,
    autoStart: true
  });

  const invalidValues: unknown[] = [
    { snoozeMinutes: 0, autoStart: true },
    { snoozeMinutes: 11, autoStart: true },
    { snoozeMinutes: 1.5, autoStart: true },
    { snoozeMinutes: -1, autoStart: true },
    { snoozeMinutes: "3", autoStart: true },
    { snoozeMinutes: 3, autoStart: "true" },
    null
  ];

  for (const invalidValue of invalidValues) {
    await assert.rejects(
      fixture.store.save(invalidValue),
      SettingsValidationError
    );
  }
}

/**
 * @brief 验证保存内容可被新的存储实例读取，并通过临时文件原子替换。
 */
async function verifyPersistenceAndAtomicReplace(): Promise<void>
{
  const fixture = createStore();
  const saved = await fixture.store.save({
    snoozeMinutes: 4,
    autoStart: false,
    timerState: "snoozed",
    remainingMilliseconds: 1000
  });
  const secondStore = new SettingsStore(fixture.settingsPath, fixture.fileSystem);

  assert.deepEqual(saved, {
    snoozeMinutes: 4,
    autoStart: false
  });
  assert.deepEqual(await secondStore.load(), {
    snoozeMinutes: 4,
    autoStart: false
  });
  assert.equal(fixture.fileSystem.files.has(`${fixture.settingsPath}.tmp`), false);
  assert.deepEqual(fixture.fileSystem.renamedFiles, [
    {
      source: `${fixture.settingsPath}.tmp`,
      target: fixture.settingsPath
    }
  ]);
}

/**
 * @brief 验证 JSON 损坏和字段非法时回退到默认设置并修复文件。
 */
async function verifyCorruptSettingsFallback(): Promise<void>
{
  const fixture = createStore();

  fixture.fileSystem.seed(fixture.settingsPath, "{invalid-json");
  assert.deepEqual(await fixture.store.load(), {
    snoozeMinutes: 3,
    autoStart: true
  });

  fixture.fileSystem.seed(
    fixture.settingsPath,
    JSON.stringify({ snoozeMinutes: 0, autoStart: false })
  );
  assert.deepEqual(await fixture.store.load(), {
    snoozeMinutes: 3,
    autoStart: true
  });
}

test("default settings are created on first load", verifyDefaultSettings);
test("settings validation enforces the snooze range", verifySettingsValidation);
test("settings persist through atomic replacement", verifyPersistenceAndAtomicReplace);
test("corrupt settings fall back to defaults", verifyCorruptSettingsFallback);
