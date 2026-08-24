import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * @brief 验证 Node.js 内置测试链路可以在当前 Linux 环境执行。
 */
function verifyNodeRuntime(): void
{
  assert.match(process.version, /^v[0-9]+\./);
}

test("node runtime baseline", verifyNodeRuntime);

/**
 * @brief 验证沙箱 preload 编译后不会运行时加载本地业务模块。
 *
 * 测试在 build 之后运行；如果后续有人恢复普通运行时 import，Electron
 * 沙箱会再次在启动时阻止 preload，提醒按钮也会失去 IPC 能力。
 */
function verifySandboxPreloadIsSelfContained(): void
{
  const preloadPath = join(process.cwd(), "dist", "src", "preload", "index.js");
  const preloadSource = readFileSync(preloadPath, "utf8");

  assert.doesNotMatch(preloadSource, /require\(["']\.\.\/core\//);
  assert.match(preloadSource, /contextBridge\.exposeInMainWorld/);
}

test("sandbox preload remains self-contained", verifySandboxPreloadIsSelfContained);
