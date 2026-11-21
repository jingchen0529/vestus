import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as releaseApi from "./prepare-release-api.mjs";
import { releaseNotesPath } from "./check-release-notes.mjs";

const { resolveReleaseApi } = releaseApi;
const version = "0.2.13";
const configured = "https://api.example.test/v1";
const release = { eventName: "push", ref: "refs/tags/desktop-v0.2.13" };
const manual = { eventName: "workflow_dispatch", ref: "refs/heads/main" };
const preparer = new URL("./prepare-release-api.mjs", import.meta.url);
const checker = new URL("./check-release-notes.mjs", import.meta.url);

function notesForApi(api) {
  return `# Vestus desktop-v${version} 版本说明

## 发布信息
- 目标环境：fixture 测试环境
- API 地址：\`${api}\`

## 本次更新
- 验证发布 API 的安全配置。

## 安装与升级
- 退出旧版本后安装。

## 后端配套
- 无新增迁移。

## 验证结果
- 已运行脚本单元测试；打包未验证。

## 已知限制
- 未访问真实后端。
`;
}

// 真正执行 CLI，但仅复制脚本到临时仓库；不写真实说明、不构建、不联网。
function withFixture(callback, api = configured) {
  const root = mkdtempSync(join(tmpdir(), "vestus-release-api-"));
  try {
    const script = join(root, "desktop/scripts/prepare-release-api.mjs");
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(preparer, script);
    copyFileSync(checker, join(dirname(script), "check-release-notes.mjs"));
    const notes = join(root, releaseNotesPath(version));
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, notesForApi(api));
    return callback({ root, script, notes, envFile: join(root, "github-env"), output: join(root, "github-output") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(fixture, env = {}, args = ["--github-actions"]) {
  return spawnSync(process.execPath, [fixture.script, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: release.ref,
      INPUT_VERSION: "",
      INPUT_API_BASE_URL: "",
      SECRET_API_BASE_URL: configured,
      GITHUB_ENV: fixture.envFile,
      GITHUB_OUTPUT: fixture.output,
      ...env,
    },
  });
}

test("prepareReleaseApi exports a fixture-root seam and appends only checked API and 0/1 flag", () => {
  assert.equal(typeof releaseApi.prepareReleaseApi, "function");
  withFixture((fixture) => {
    writeFileSync(fixture.envFile, "EXISTING=keep\n");
    const result = releaseApi.prepareReleaseApi({ ...release, inputVersion: "9.9.9", secretApi: configured }, fixture.root, fixture.envFile);
    assert.deepEqual(result, { version, notesPath: "docs/releases/desktop-v0.2.13.md", api: configured, allowInsecureApi: false, placeholder: false });
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\nVESTUS_API_BASE_URL=https://api.example.test/v1\nVESTUS_ALLOW_INSECURE_API=0\n");
  });
});

test("CLI uses its repository root rather than cwd and does not disclose configured APIs", () => {
  withFixture((fixture) => {
    const result = runCli(fixture);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "VESTUS_API_BASE_URL=https://api.example.test/v1\nVESTUS_ALLOW_INSECURE_API=0\n");
    assert.match(result.stdout, /release API: ok/);
    assert.doesNotMatch(result.stdout + result.stderr, /api\.example\.test|https?:\/\/|::warning::/);
    assert.equal(existsSync(fixture.output), false);
  });
});

test("CLI validates version, then API, then notes, leaving existing environment untouched on every failure", () => {
  withFixture((fixture) => {
    writeFileSync(fixture.envFile, "EXISTING=keep\n");
    const invalidVersion = runCli(fixture, { GITHUB_REF: "refs/tags/desktop-vbad", SECRET_API_BASE_URL: "https://user:private-value@example.test" });
    assert.equal(invalidVersion.status, 1);
    assert.match(invalidVersion.stderr, /版本号/);
    assert.doesNotMatch(invalidVersion.stderr, /private-value/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");

    rmSync(fixture.notes);
    const invalidApi = runCli(fixture, { SECRET_API_BASE_URL: "https://user:private-value@example.test" });
    assert.equal(invalidApi.status, 1);
    assert.match(invalidApi.stderr, /API/);
    assert.doesNotMatch(invalidApi.stderr, /private-value|缺少版本说明/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");

    const missingNotes = runCli(fixture);
    assert.equal(missingNotes.status, 1);
    assert.match(missingNotes.stderr, /缺少版本说明/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");

    writeFileSync(fixture.notes, notesForApi("https://different.example.test"));
    const mismatch = runCli(fixture);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /构建 API.*不一致/);
    assert.doesNotMatch(mismatch.stdout + mismatch.stderr, /different\.example\.test|api\.example\.test/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");

    writeFileSync(fixture.notes, notesForApi(configured));
    for (const env of [{ GITHUB_EVENT_NAME: "pull_request" }, { SECRET_API_BASE_URL: "https://api.example.test\nINJECTED=1" }, { SECRET_API_BASE_URL: "https://localhost" }, { GITHUB_ENV: "" }]) {
      const result = runCli(fixture, env);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");
      assert.doesNotMatch(result.stdout + result.stderr, /INJECTED|https?:\/\//);
    }
    assert.equal(runCli(fixture, {}, ["--github-actions", "--root", fixture.root]).status, 1);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");
  });
});

test("CLI handles environment-file I/O failure without logging the path or API", () => {
  withFixture((fixture) => {
    const privatePath = join(fixture.root, "private-api.example.test");
    mkdirSync(privatePath);
    const result = runCli(fixture, { GITHUB_ENV: privatePath });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /无法写入.*环境文件/);
    assert.doesNotMatch(result.stdout + result.stderr, /private-api|api\.example\.test|https?:\/\//);
    assert.equal(existsSync(fixture.envFile), false);
  });
});

test("manual selected-tag version mismatch and malformed notes do not mutate environment", () => {
  withFixture((fixture) => {
    writeFileSync(fixture.envFile, "EXISTING=keep\n");
    const wrongVersion = runCli(fixture, { GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_VERSION: "0.2.14" });
    assert.equal(wrongVersion.status, 1);
    assert.match(wrongVersion.stderr, /与所选 desktop-v 标签一致/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");
    for (const source of ["# Incomplete notes", notesForApi(configured.replace("api", "a\tpi"))]) {
      writeFileSync(fixture.notes, source);
      const result = runCli(fixture);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(fixture.envFile, "utf8"), "EXISTING=keep\n");
    }
  });
});

test("prepareReleaseApi fixture seam never writes on version, API, or notes failures", () => {
  withFixture((fixture) => {
    assert.throws(() => releaseApi.prepareReleaseApi({ ...manual, inputVersion: "bad", inputApi: "https://user:private-value@example.test" }, fixture.root, fixture.envFile), /版本号/);
    assert.equal(existsSync(fixture.envFile), false);
    assert.throws(() => releaseApi.prepareReleaseApi({ ...release, secretApi: "http://api.example.test" }, fixture.root, fixture.envFile), /HTTPS/);
    assert.equal(existsSync(fixture.envFile), false);
    assert.throws(() => releaseApi.prepareReleaseApi({ ...release, secretApi: "https://different.example.test" }, fixture.root, fixture.envFile), /不一致/);
    assert.equal(existsSync(fixture.envFile), false);
  });
});

test("failed CLI never creates GITHUB_ENV when notes disagree", () => {
  withFixture((fixture) => {
    const result = runCli(fixture, { SECRET_API_BASE_URL: "https://different.example.test" });
    assert.equal(result.status, 1);
    assert.equal(existsSync(fixture.envFile), false);
  });
});

test("manual CLI on selected tag warns for HTTP, with no real-release state or raw API logging", () => {
  const api = "http://127.0.0.1:8000/api";
  withFixture((fixture) => {
    const result = runCli(fixture, { GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_REF: release.ref, INPUT_VERSION: version, INPUT_API_BASE_URL: api });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::.*HTTP/);
    assert.doesNotMatch(result.stdout + result.stderr, /127\.0\.0\.1|https?:\/\//);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "VESTUS_API_BASE_URL=http://127.0.0.1:8000/api\nVESTUS_ALLOW_INSECURE_API=1\n");
  }, api);
});

test("manual placeholder warns only after matching the documented API and never bypasses notes", () => {
  withFixture((fixture) => {
    const env = { GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_VERSION: version, SECRET_API_BASE_URL: "" };
    const result = runCli(fixture, env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning::.*占位/);
    assert.doesNotMatch(result.stdout + result.stderr, /vestus\.invalid|https?:\/\//);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "VESTUS_API_BASE_URL=https://vestus.invalid\nVESTUS_ALLOW_INSECURE_API=0\n");
    writeFileSync(fixture.notes, notesForApi(configured));
    const mismatch = runCli(fixture, env);
    assert.equal(mismatch.status, 1);
    assert.match(mismatch.stderr, /不一致/);
    assert.doesNotMatch(mismatch.stdout, /::warning::/);
    assert.equal(readFileSync(fixture.envFile, "utf8"), "VESTUS_API_BASE_URL=https://vestus.invalid\nVESTUS_ALLOW_INSECURE_API=0\n");
  }, "https://vestus.invalid");
});

test("desktop tag pushes resolve the configured HTTPS API without enabling insecure builds", () => {
  assert.deepEqual(resolveReleaseApi({ ...release, secretApi: "https://api.example.test/v1" }), {
    api: "https://api.example.test/v1",
    allowInsecureApi: false,
    placeholder: false,
  });
});

test("API input takes precedence, with empty input falling back to the secret", () => {
  assert.equal(resolveReleaseApi({ ...manual, inputApi: " https://input.example.test/api/ ", secretApi: "https://secret.example.test" }).api, "https://input.example.test/api/");
  for (const inputApi of [undefined, "", "   "]) {
    assert.equal(resolveReleaseApi({ ...manual, inputApi, secretApi: "https://secret.example.test" }).api, "https://secret.example.test");
  }
});

test("raw control characters cannot be normalized away in either configured API value", () => {
  const controls = ["\r", "\n", "\t", "\0", "\u000b", "\u001b", "\u007f", "\u0085", "\u200b", "\u2028", "\u2029", "\uFEFF"];
  for (const control of controls) {
    for (const field of ["inputApi", "secretApi"]) {
      for (const value of [`${control}https://private-input.example.test`, `https://private-input.example.test${control}`, `https://private-${control}input.example.test`]) {
        assert.throws(() => resolveReleaseApi({ ...manual, [field]: value }), (error) => {
          assert.match(error.message, /控制字符/);
          assert.ok(!error.message.includes(value));
          assert.doesNotMatch(error.message, /private-input/);
          return true;
        });
      }
    }
  }
  assert.throws(() => resolveReleaseApi({ ...manual, inputApi: "https://input.example.test", secretApi: "https://secret.example.test\nEVIL=1" }), /控制字符/);
});

test("only push desktop tags are releases; manual selected tags can explicitly use HTTP", () => {
  for (const ref of [manual.ref, release.ref]) {
    assert.deepEqual(resolveReleaseApi({ ...manual, ref, inputApi: "http://localhost:8000/api" }), {
      api: "http://localhost:8000/api",
      allowInsecureApi: true,
      placeholder: false,
    });
  }
  assert.throws(() => resolveReleaseApi({ ...release, inputApi: "http://api.example.test" }), /HTTPS/);
  for (const options of [{ eventName: "push", ref: "refs/heads/main" }, { eventName: "pull_request", ref: release.ref }, { eventName: "push", ref: "refs/tags/other-v0.2.13" }, { eventName: "push", ref: "refs/tags/desktop-v0.2.13\n" }]) {
    assert.throws(() => resolveReleaseApi({ ...options, secretApi: "https://api.example.test" }));
  }
});

test("manual missing API keeps the HTTPS placeholder while release missing API fails closed", () => {
  assert.deepEqual(resolveReleaseApi({ ...manual, inputApi: "", secretApi: " " }), {
    api: "https://vestus.invalid",
    allowInsecureApi: false,
    placeholder: true,
  });
  assert.deepEqual(resolveReleaseApi({ ...manual, inputApi: "https://vestus.invalid" }), {
    api: "https://vestus.invalid",
    allowInsecureApi: false,
    placeholder: true,
  });
  assert.throws(() => resolveReleaseApi(release), /正式.*API/);
});

test("release HTTPS URLs reject placeholder and local-only host spellings including canonicalized IPs", () => {
  const hosts = ["vestus.invalid", "VESTUS.INVALID.", "invalid", "localhost", "LOCALHOST.", "api.localhost", "localhost.localdomain", "0.0.0.0", "0", "127.0.0.1", "127.9.8.7", "127.1", "2130706433", "0x7f000001", "0177.0.0.1", "[::]", "[::1]", "[0:0:0:0:0:0:0:1]", "[::ffff:127.0.0.1]", "[::ffff:7f00:1]", "[::127.0.0.1]"];
  for (const host of hosts) {
    assert.throws(() => resolveReleaseApi({ ...release, secretApi: `https://${host}/api` }), /正式.*(?:占位|本机)/);
  }
  for (const api of ["https://api.example.test:8443/v1", "https://8.8.8.8/api", "https://[2606:4700:4700::1111]/api", "https://10.0.0.1", "https://172.16.0.1", "https://192.168.1.1", "https://169.254.1.1", "https://[fc00::1]", "https://[fe80::1]", "https://api.local", "https://printer", "https://router.home.arpa"]) {
    assert.equal(resolveReleaseApi({ ...release, secretApi: api }).api, api);
  }
});

test("invalid URL, missing host, credentials, query, and fragment are rejected without input disclosure", () => {
  for (const inputApi of [42, {}, "private-value", "file:///private-value", "https://", "https:///private-value", "https:/private-value", "https://private-value:bad", "https://user:private-value@api.example.test", "https://@api.example.test", "https://api.example.test?private-value", "https://api.example.test?", "https://api.example.test#private-value", "https://api.example.test#", "https://api.example.test\\private-value"]) {
    assert.throws(() => resolveReleaseApi({ ...manual, inputApi }), (error) => {
      assert.match(error.message, /API/);
      assert.doesNotMatch(error.message, /private-value|user:|api\.example\.test/);
      return true;
    });
  }
});
