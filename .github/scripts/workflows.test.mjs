import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8").replaceAll("\r\n", "\n");
const ci = read(".github/workflows/ci.yml");
const release = read(".github/workflows/release.yml");

function job(source, name) {
  const body = source.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z-]*:|$(?![\\s\\S]))`, "m"));
  assert.ok(body, `missing job: ${name}`);
  return body[1];
}

test("third-party Actions use immutable commits and checkout never retains credentials", () => {
  for (const source of [ci, release]) {
    const uses = [...source.matchAll(/^\s*-?\s*uses: ([^\n]+)/gm)].map((match) => match[1]);
    assert.ok(uses.length > 0);
    for (const action of uses) {
      assert.match(action, /^[\w-]+\/[\w-]+(?:\/[\w-]+)*@[0-9a-f]{40}(?:\s+#.*)?$/);
    }
    const checkouts = [...source.matchAll(/uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=\n\s*- |$(?![\s\S]))/g)];
    assert.ok(checkouts.length > 0);
    for (const checkout of checkouts) assert.match(checkout[1], /persist-credentials: false/);
    assert.match(source, /^permissions:\n  contents: read$/m);
    for (const body of source.slice(source.indexOf("jobs:\n")).split(/^  [a-z][a-z-]*:\n/m).slice(1)) {
      assert.match(body, /^    timeout-minutes: \d+$/m);
    }
  }
});

test("configuration changes have their own CI gate without weakening existing gates", () => {
  const configuration = job(ci, "workflows");
  assert.match(configuration, /actionlint/);
  assert.match(configuration, /v1\.\d+\.\d+/);
  assert.match(configuration, /node --test \.github\/scripts\/\*\.test\.mjs/);
  for (const gate of ["backend", "web", "desktop-shell", "desktop-rust"]) job(ci, gate);
  assert.match(ci, /branches: \[master\]/);
  assert.doesNotMatch(ci, /pull_request_target/);
});

test("package managers and Rust toolchains agree with their checked-in declarations", () => {
  const web = JSON.parse(read("web/package.json"));
  assert.match(web.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  assert.doesNotMatch(ci, /pnpm@\^|rustup default|rustup toolchain install/);
  assert.match(ci, /cache-dependency-path: web\/pnpm-lock.yaml/);
  assert.match(ci, /cache-dependency-path: desktop\/package-lock.json/);
  const toolchain = read("desktop/src-tauri/rust-toolchain.toml");
  assert.match(toolchain, /channel = "1\.97\.1"/);
  for (const source of [job(ci, "desktop-rust"), job(release, "build")]) {
    assert.match(source, /working-directory: desktop\/src-tauri/);
    assert.match(source, /rustup show active-toolchain/);
    assert.doesNotMatch(source, /rust-toolchain@stable/);
    assert.match(source, /cargo test[^\n]*--locked/);
  }
});

test("API validation precedes environment export and matrix build", () => {
  const preflight = job(release, "preflight");
  assert.match(preflight, /node desktop\/scripts\/prepare-release-api\.mjs --github-actions/);
  const build = job(release, "build");
  const validateAt = build.indexOf("node desktop/scripts/prepare-release-api.mjs --github-actions");
  assert.ok(validateAt > build.indexOf("actions/setup-node@"));
  assert.ok(validateAt < build.indexOf("Stamp validated version"));
  assert.doesNotMatch(release, /echo.*\$api|\$GITHUB_ENV/);
  assert.match(release, /cancel-in-progress: false/);
});

test("publish requires a complete verified asset set and manual builds never publish", () => {
  const build = job(release, "build");
  assert.match(build, /node desktop\/scripts\/release-assets\.mjs collect/);
  const publish = job(release, "publish");
  const verifyAt = publish.indexOf("node desktop/scripts/release-assets.mjs verify");
  assert.ok(verifyAt > publish.indexOf("actions/download-artifact@"));
  assert.ok(verifyAt < publish.indexOf("softprops/action-gh-release@"));
  assert.match(publish, /github\.event_name == 'push'/);
  assert.match(publish, /contents: write/);
  for (const name of ["preflight", "build"]) assert.doesNotMatch(job(release, name), /contents: write/);
  assert.match(build, /continue-on-error: \$\{\{ runner\.os == 'Windows' \}\}/);
});

test("desktop CI tests the shell and Rust core on three native operating systems", () => {
  const desktop = job(ci, "desktop-rust");
  for (const runner of ["ubuntu-22.04", "windows-latest", "macos-15"]) {
    assert.ok(desktop.includes(`os: ${runner}`), `missing native runner ${runner}`);
  }
  assert.match(desktop, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(desktop, /fail-fast: false/);
  assert.match(desktop, /npm ci && npm test && npm run build && npm run check:surfaces/);
  const format = desktop.match(/- name: Format check[^\n]*\n([\s\S]*?)(?=\n      -|$)/)?.[1];
  assert.match(format, /if: runner\.os == 'Linux'/);
  assert.doesNotMatch(ci, /prepare-chromium|desktop:build|--ignored/);
});

test("final installers must pass native acceptance before upload and failure reports remain separate", () => {
  const build = job(release, "build");
  const acceptanceAt = build.indexOf("node desktop/scripts/verify-installers.mjs");
  assert.ok(acceptanceAt > build.indexOf("release-assets.mjs collect"));
  assert.ok(acceptanceAt < build.indexOf("- name: Upload artifacts"));
  const acceptance = build.match(/- name: Verify final installers\n([\s\S]*?)(?=\n      -|$)/)?.[1];
  assert.ok(acceptance);
  assert.doesNotMatch(acceptance, /continue-on-error|\|\| true/);
  assert.match(acceptance, /VESTUS_INSTALLER_TEST_DISPOSABLE: "1"/);
  const report = build.match(/- name: Upload installer acceptance results\n([\s\S]*?)(?=\n      -|$)/)?.[1];
  assert.ok(report);
  assert.match(report, /if: always\(\)/);
  assert.match(report, /name: package-acceptance-\$\{\{ matrix\.label \}\}/);
  assert.match(report, /path: desktop\/test-results\/package-acceptance\//);
  assert.doesNotMatch(report, /path: release-assets/);
});

test("browser regression is manual, isolated, and cannot package or publish", () => {
  const browser = read(".github/workflows/browser-regression.yml");
  assert.match(browser, /workflow_dispatch:/);
  assert.doesNotMatch(browser, /^  (?:push|pull_request|schedule):/m);
  assert.match(browser, /type: choice/);
  for (const runner of ["ubuntu-22.04", "windows-latest", "macos-15"]) assert.ok(browser.includes(runner));
  assert.match(browser, /runs-on: \$\{\{ inputs\.runner \}\}/);
  assert.match(browser, /^permissions:\n  contents: read$/m);
  assert.doesNotMatch(browser, /secrets\.|contents: write|desktop:build|stamp-version|action-gh-release/);
  assert.match(browser, /ref: \$\{\{ github\.sha \}\}/);
  for (const command of ["test:control", "test:persistence", "test:material-smoke"]) assert.ok(browser.includes(command));
  assert.match(browser, /if: always\(\)/);
  assert.doesNotMatch(browser, /path: desktop\/src-tauri\/resources|path: .*profile/);
  assert.match(browser, /cancel-in-progress: false/);
});

test("dependency maintenance matches existing manifests and deploy uses the Web lockfile", () => {
  const dependabot = read(".github/dependabot.yml");
  assert.match(dependabot, /package-ecosystem: github-actions/);
  for (const directory of ["/web", "/desktop"]) assert.ok(dependabot.includes(`directory: "${directory}"`));
  const deployment = read("docs/deploy-linux.md");
  assert.doesNotMatch(deployment, /npm --prefix web ci/);
  assert.match(deployment, /pnpm --dir web install --frozen-lockfile/);
});
