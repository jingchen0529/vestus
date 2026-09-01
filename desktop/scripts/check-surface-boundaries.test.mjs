import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const checkerSource = readFileSync(
  new URL("./check-surface-boundaries.mjs", import.meta.url),
  "utf8",
);

function writeFixture(root, relativePath, contents) {
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test("surface checker isolates chromium_arguments in a Windows CRLF checkout", () => {
  const fixture = mkdtempSync(join(tmpdir(), "vestus-surface-crlf-"));
  try {
    writeFixture(fixture, "desktop/scripts/check-surface-boundaries.mjs", checkerSource);
    writeFixture(fixture, "web/admin.html", "/api/admin/auth/login");
    writeFixture(
      fixture,
      "desktop/src-tauri/src/auth.rs",
      [
        "pub struct DesktopUser {}",
        "impl DesktopUser {}",
        '"/api/user/auth/login"',
        '"/api/user/auth/me"',
        '"/api/user/auth/logout"',
      ].join("\r\n"),
    );
    writeFixture(fixture, "desktop/src-tauri/src/lib.rs", "");
    writeFixture(fixture, "desktop/src-tauri/src/cdp.rs", "");
    writeFixture(
      fixture,
      "desktop/src-tauri/src/browser.rs",
      [
        "fn chromium_arguments() {",
        '  let args = ["--remote-debugging-port=0"];',
        "}",
        "",
        "#[cfg(test)]",
        'const DOCUMENTED_FORBIDDEN: &str = "--remote-debugging-address";',
      ].join("\r\n"),
    );

    for (const path of [
      "desktop/src/App.tsx",
      "desktop/src/components/auth/LoginCard.tsx",
      "desktop/src/components/auth/ChangePasswordCard.tsx",
      "desktop/src/components/browser/PlatformLauncher.tsx",
      "desktop/src/components/layout/Header.tsx",
      "desktop/src/services/authService.ts",
      "desktop/src/services/tauriBridge.ts",
    ]) {
      writeFixture(fixture, path, "");
    }
    writeFixture(
      fixture,
      "desktop/dist/assets/index.js",
      [
        "desktop_login",
        "desktop_restore_session",
        "desktop_logout",
        "desktop_product_name",
        "desktop_product_info",
        "desktop_change_password",
        "sync_desktop_config",
        "open_browser",
        "get_status",
      ].join(" "),
    );

    const result = spawnSync(
      process.execPath,
      [join(fixture, "desktop/scripts/check-surface-boundaries.mjs")],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
