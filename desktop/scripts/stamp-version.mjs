// 把发布标签里的版本号写进 tauri.conf.json，安装包文件名和「关于」里的版本
// 才会跟着标签走。桌面版本只有这一个来源；Cargo.toml 的 version 不参与打包
// 命名，故意不动它，免得连带 Cargo.lock 变更影响构建缓存。
//
//   node scripts/stamp-version.mjs 1.2.3
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
// NSIS / dmg 只接受 x.y.z 这种数字版本，先拦在这里而不是等打包到最后一步。
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  throw new Error(`版本号必须是 x.y.z，收到：${version ?? "(空)"}`);
}

const configPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  join("src-tauri", "tauri.conf.json")
);
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.version = version;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`stamped desktop version: ${version}`);
