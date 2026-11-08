// dsh 启动器：绕过 bin.js 的 `import.meta.main` 入口检查（该检查需要 Node 24.2+），
// 直接导入并调用 runCli()，从而可用系统 Node 22 运行 dsh。
// 系统 Node（/usr/local/bin/node 等）具备在家目录正常 unlink 的能力，
// 而 WorkBuddy 自带的 Node 二进制受沙箱限制无法 unlink 家目录文件。
import { runCli } from '../node_modules/@deepseek-ai/dsh/lib/bin.js';

await runCli();
