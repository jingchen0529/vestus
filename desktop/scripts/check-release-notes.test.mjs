import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  checkReleaseNotes,
  releaseNotesPath,
  releaseVersionForEvent,
  validateReleaseNotes,
} from "./check-release-notes.mjs";

const version = "0.2.13";
const validNotes = `# Vestus desktop-v${version} 版本说明

## 发布信息
- 目标环境：dev 测试环境
- API 地址：\`https://vestus-dev.quanyuos.com\`

## 本次更新
- 修复版本说明缺失时仍启动构建的问题。

## 安装与升级
- 退出旧客户端后安装对应平台的安装包。

## 后端配套
- 无新增迁移；使用现有 dev 后端。

## 验证结果
- 已运行版本说明校验测试；实机安装未验证。

## 已知限制
- 未完成授权账号的上游平台回归，不承诺所有场景都通过。
`;
const checker = new URL("./check-release-notes.mjs", import.meta.url);

// Fixtures stay outside the repository and never create a real release file,
// run a package build, or contact GitHub.
function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "vestus-release-notes-"));
  try {
    const script = join(root, "desktop/scripts/check-release-notes.mjs");
    mkdirSync(dirname(script), { recursive: true });
    copyFileSync(checker, script);
    const notes = join(root, releaseNotesPath(version));
    mkdirSync(dirname(notes), { recursive: true });
    writeFileSync(notes, validNotes);
    return callback({ root, script, notes, output: join(root, "github-output") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runCli(fixture, args, env = {}) {
  return spawnSync(process.execPath, [fixture.script, ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
}

test("release notes use a version-derived path, not the current directory or an arbitrary filename", () => {
  assert.equal(releaseNotesPath(version), "docs/releases/desktop-v0.2.13.md");
  withFixture((fixture) => {
    assert.equal(checkReleaseNotes(version, fixture.root), releaseNotesPath(version));
    const result = runCli(fixture, [version]);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release notes: ok/);
  });
});

for (const invalid of [undefined, "", "v0.2.13", "desktop-v0.2.13", "0.2", "0.2.13-beta.1", "../secret", "0.2.13/../../secret", " 0.2.13", "0.2.13\n", "0.2.13\nnotes_path=evil"]) {
  test(`rejects invalid version ${JSON.stringify(invalid)}`, () => {
    assert.throws(() => releaseNotesPath(invalid), /版本号必须是 x.y.z/);
  });
}

test("supports LF, CRLF, BOM and explicit unverified outcomes", () => {
  for (const source of [validNotes, `\uFEFF${validNotes.replaceAll("\n", "\r\n")}`]) {
    assert.doesNotThrow(() => validateReleaseNotes(version, source));
  }
});

test("missing or empty notes stop the checker with an actionable error", () => {
  withFixture((fixture) => {
    rmSync(fixture.notes);
    const result = runCli(fixture, [version]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /缺少版本说明：docs\/releases\/desktop-v0\.2\.13\.md/);
    assert.match(result.stderr, /先编写并展示说明/);
    writeFileSync(fixture.notes, " \n\n");
    assert.throws(() => checkReleaseNotes(version, fixture.root), /不能为空/);
  });
  assert.throws(() => validateReleaseNotes(version, "<!-- only a comment -->"), /不能为空/);
});

test("directories cannot stand in for a notes file", () => {
  withFixture((fixture) => {
    rmSync(fixture.notes);
    mkdirSync(fixture.notes);
    assert.throws(() => checkReleaseNotes(version, fixture.root), /普通 Markdown 文件/);
  });
});

test("title must match the requested version and be unique", () => {
  assert.throws(() => validateReleaseNotes("0.2.14", validNotes), /与打包版本一致/);
  assert.throws(() => validateReleaseNotes(version, `${validNotes}\n# Another release\n`), /与打包版本一致/);
  assert.throws(() => validateReleaseNotes(version, validNotes.replace(/^# .*\n/, "")), /与打包版本一致/);
});

for (const section of ["发布信息", "本次更新", "安装与升级", "后端配套", "验证结果", "已知限制"]) {
  test(`requires meaningful content under ${section}`, () => {
    const sectionPattern = new RegExp(`## ${section}\\n[\\s\\S]*?(?=\\n## |$)`);
    assert.throws(
      () => validateReleaseNotes(version, validNotes.replace(sectionPattern, "")),
      /缺少章节/,
    );
    assert.throws(
      () => validateReleaseNotes(version, validNotes.replace(sectionPattern, `## ${section}\n- ** **\n<!-- comment -->\n`)),
      /章节不能为空/,
    );
  });
}

test("empty numbered lists and task checkboxes do not count as section content", () => {
  const update = "- 修复版本说明缺失时仍启动构建的问题。";
  for (const empty of ["1.", "1. ", "42) ", "- [x]", "- [ ]", "> 1.", "> - [x]"]) {
    assert.throws(
      () => validateReleaseNotes(version, validNotes.replace(update, empty)),
      /章节不能为空：本次更新/,
    );
  }
  assert.doesNotThrow(() => validateReleaseNotes(version, validNotes.replace(update, "1. 更新了版本说明校验。")));
});

test("headings in examples or comments do not count as completed sections", () => {
  const knownLimits = "## 已知限制\n- 未完成授权账号的上游平台回归，不承诺所有场景都通过。";
  for (const hidden of [`\`\`\`md\n${knownLimits}\n\`\`\``, `<!--\n${knownLimits}\n-->`]) {
    assert.throws(() => validateReleaseNotes(version, validNotes.replace(knownLimits, hidden)), /缺少章节：已知限制/);
  }
  assert.throws(() => validateReleaseNotes(version, `${validNotes}\n## 本次更新\n重复说明\n`), /章节重复/);
  assert.throws(() => validateReleaseNotes(version, `${validNotes}\n\`\`\`sh\n`), /未闭合的代码围栏/);
  assert.throws(() => validateReleaseNotes(version, `${validNotes}\n<!--`), /未闭合的 HTML 注释/);
});

for (const placeholder of ["待填写", "待补充", "请填写", "TODO", "TBD", "FIXME"]) {
  test(`rejects unfinished template marker ${placeholder}`, () => {
    assert.throws(() => validateReleaseNotes(version, `${validNotes}\n- ${placeholder}\n`), /模板占位内容/);
  });
}

test("release metadata must declare the environment and one credential-free API URL", () => {
  const apiLine = "- API 地址：`https://vestus-dev.quanyuos.com`";
  const environmentLine = "- 目标环境：dev 测试环境";
  for (const line of [apiLine, environmentLine]) {
    assert.throws(() => validateReleaseNotes(version, validNotes.replace(line, "")), /发布信息必须包含唯一的/);
    assert.throws(() => validateReleaseNotes(version, validNotes.replace(line, `${line}\n${line}`)), /发布信息必须包含唯一的/);
  }
  for (const address of ["vestus-dev.quanyuos.com", "file:///tmp/api", "https://user:password@api.example.test", "https://api.example.test?q=secret", "https://api.example.test#fragment", "https://api.example.test?", "https://api.example.test#"]) {
    assert.throws(() => validateReleaseNotes(version, validNotes.replace(apiLine, `- API 地址：${address}`)), /API 地址必须/);
  }
  // HTTPS enforcement for actual release builds remains in release.yml. A
  // deliberate manual build can still document the allowed local HTTP target.
  assert.doesNotThrow(() => validateReleaseNotes(version, validNotes.replace(apiLine, "- API 地址：http://127.0.0.1:8000")));
});

test("a tag push takes its version from the tag, not from a dispatch input", () => {
  assert.equal(releaseVersionForEvent({ eventName: "push", ref: `refs/tags/desktop-v${version}`, inputVersion: "9.9.9" }), version);
  assert.throws(() => releaseVersionForEvent({ eventName: "push", ref: "refs/heads/main" }), /只接受 desktop-v 标签推送/);
  assert.throws(() => releaseVersionForEvent({ eventName: "pull_request", ref: "refs/heads/main" }), /只接受 desktop-v 标签推送/);
});

test("manual builds require an explicit version, matching the selected tag when applicable", () => {
  assert.equal(releaseVersionForEvent({ eventName: "workflow_dispatch", ref: "refs/heads/main", inputVersion: version }), version);
  assert.equal(releaseVersionForEvent({ eventName: "workflow_dispatch", ref: `refs/tags/desktop-v${version}`, inputVersion: version }), version);
  assert.throws(() => releaseVersionForEvent({ eventName: "workflow_dispatch", ref: "refs/heads/main" }), /版本号必须是 x.y.z/);
  assert.throws(() => releaseVersionForEvent({ eventName: "workflow_dispatch", ref: "refs/tags/desktop-v0.2.12", inputVersion: version }), /与所选 desktop-v 标签一致/);
});

test("Actions exports only validated values and never outputs a path on failure", () => {
  withFixture((fixture) => {
    const env = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: `refs/tags/desktop-v${version}`,
      GITHUB_OUTPUT: fixture.output,
    };
    const result = runCli(fixture, ["--github-actions"], env);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const expected = `version=${version}\nnotes_path=${releaseNotesPath(version)}\n`;
    assert.equal(readFileSync(fixture.output, "utf8"), expected);

    writeFileSync(fixture.notes, "# Empty notes");
    const invalid = runCli(fixture, ["--github-actions"], env);
    assert.equal(invalid.status, 1);
    assert.equal(readFileSync(fixture.output, "utf8"), expected);
    assert.equal(runCli(fixture, [version, "../../unexpected.md"]).status, 1);
  });
});

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8")
  .replace(/\r\n?/g, "\n");
function workflowJob(name, source = workflow) {
  const body = source.replace(/\r\n?/g, "\n")
    .match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:|$(?![\\s\\S]))`, "m"))?.[1];
  assert.ok(body, `missing workflow job: ${name}`);
  return body;
}

test("workflow assertions accept Windows CRLF checkouts", () => {
  const crlfWorkflow = workflow.replaceAll("\n", "\r\n");
  for (const name of ["preflight", "build", "publish"]) {
    assert.equal(workflowJob(name, crlfWorkflow), workflowJob(name));
  }
});

test("Release preflight blocks all matrix builds until version notes are checked", () => {
  const preflight = workflowJob("preflight");
  assert.match(preflight, /node desktop\/scripts\/check-release-notes\.mjs --github-actions/);
  assert.match(preflight, /INPUT_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(preflight, /version: \$\{\{ steps\.notes\.outputs\.version \}\}/);
  assert.match(preflight, /notes_path: \$\{\{ steps\.notes\.outputs\.notes_path \}\}/);
  assert.doesNotMatch(preflight, /continue-on-error|if:|npm ci|cargo|prepare-chromium/);

  const build = workflowJob("build");
  assert.match(build, /^    needs: preflight$/m);
  assert.match(build, /RELEASE_VERSION: \$\{\{ needs\.preflight\.outputs\.version \}\}/);
  assert.match(build, /node scripts\/stamp-version\.mjs "\$RELEASE_VERSION"/);
  assert.match(build, /version="\$RELEASE_VERSION"/);
  assert.ok(build.indexOf("actions/setup-node@") < build.indexOf("node scripts/stamp-version.mjs"));
  for (const target of ["windows-x86_64", "macos-aarch64", "macos-x86_64", "linux-x86_64"]) {
    assert.ok(build.includes(`label: ${target}`), `matrix target missing: ${target}`);
  }
});

test("publish reads checked notes from the trigger SHA and never publishes a manual run", () => {
  const publish = workflowJob("publish");
  assert.match(publish, /^    needs: \[preflight, build\]$/m);
  assert.match(publish, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/desktop-v'\)/);
  assert.match(publish, /body_path: \$\{\{ needs\.preflight\.outputs\.notes_path \}\}/);
  assert.doesNotMatch(publish, /^          body:/m);
  assert.match(publish, /files: release-assets\/\*/);
  for (const name of ["preflight", "build", "publish"]) {
    assert.match(workflowJob(name), /uses: actions\/checkout@[^\n]+\n        with:\n          ref: \$\{\{ github\.sha \}\}/);
  }
  assert.match(workflow, /workflow_dispatch:[\s\S]*?version:\n[\s\S]*?required: true\n[\s\S]*?type: string/);
});
