import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const documents = [".github/CONTRIBUTING.md", ".github/SECURITY.md", ".github/pull_request_template.md"];

test("collaboration documents exist and reference real local documentation", () => {
  for (const path of documents) {
    const source = read(path);
    assert.ok(source.trim().startsWith("#") || path.endsWith("pull_request_template.md"));
    assert.ok(source.endsWith("\n"));
    for (const match of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const link = match[1].split("#")[0];
      if (!link || /^[a-z]+:/i.test(link)) continue;
      assert.ok(existsSync(new URL(link, new URL(path, root))), `${path}: missing ${link}`);
    }
  }
  const readme = read("README.md");
  for (const path of documents.slice(0, 2)) assert.ok(readme.includes(path));
});

test("security reporting is private and does not pretend repository settings or support promises", () => {
  const security = read(".github/SECURITY.md");
  assert.match(security, /Private vulnerability reporting/);
  assert.match(security, /enabled: false/);
  assert.match(security, /2026-11-20/);
  assert.match(security, /Settings[\s\S]*Enable/);
  assert.match(security, /不要披露/);
  assert.match(security, /不承诺响应时限/);
  assert.doesNotMatch(security, /mailto:|support@|MIT License|已启用私密报告/);
});

test("contribution and PR guidance preserve verification and explicit release approval", () => {
  const contributing = read(".github/CONTRIBUTING.md");
  const template = read(".github/pull_request_template.md");
  assert.match(contributing, /--frozen-lockfile/);
  assert.match(contributing, /cargo test --locked --lib/);
  assert.match(contributing, /\.scratch/);
  assert.match(contributing, /同一提交|同提交/);
  assert.match(contributing, /明确批准|明确确认|明确审批/);
  assert.match(template, /未验证/);
  assert.match(template, /回滚/);
  assert.match(template, /不.*授权|不能.*授权/);
});
