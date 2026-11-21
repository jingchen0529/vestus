import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const version = "1.23.456";
const script = new URL("./release-assets.mjs", import.meta.url);
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const platforms = [
  ["windows-x86_64", ["exe"]],
  ["macos-aarch64", ["dmg"]],
  ["macos-x86_64", ["dmg"]],
  ["linux-x86_64", ["deb", "AppImage"]],
];

// Only disposable, read-only fixture inputs are used: no builds, real bundles,
// release notes, network calls, or repository outputs are needed.
function withFixture(callback) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "vestus-release-assets-"));
  const bundle = join(root, "bundle");
  const output = join(root, "assets");
  mkdirSync(bundle);
  try {
    return callback({ root, bundle, output });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixtureFile(path, content = "abc") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o444 });
}

function runCli(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], {
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return result;
}

function assetName(label, extension, releaseVersion = version) {
  return `Vestus-${releaseVersion}-${label}.${extension}`;
}

function checksumLine(label, extension, hash = abcHash, releaseVersion = version) {
  return `${hash}  ${assetName(label, extension, releaseVersion)}\n`;
}

test("collect finds nested ordinary installers and emits versioned, sorted platform checksums", () => {
  for (const [label, extensions] of platforms) {
    withFixture(({ bundle, output }) => {
      for (const extension of extensions) fixtureFile(join(bundle, extension, `original.${extension}`));
      fixtureFile(join(bundle, "resources", "icon.png"), "not an installer");
      const result = runCli(["collect", version, label, bundle, output]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /release assets: collected/);
      const names = extensions.map((extension) => assetName(label, extension));
      assert.deepEqual(readdirSync(output).sort(), [...names, `SHA256SUMS-${label}.txt`].sort());
      for (const extension of extensions) {
        assert.equal(readFileSync(join(output, assetName(label, extension)), "utf8"), "abc");
        assert.equal(readFileSync(join(bundle, extension, `original.${extension}`), "utf8"), "abc");
      }
      assert.equal(
        readFileSync(join(output, `SHA256SUMS-${label}.txt`), "utf8"),
        [...extensions].sort().map((extension) => checksumLine(label, extension)).join(""),
      );
    });
  }
});

function releaseFixture(output, { contents = new Map(), omitted = new Set() } = {}) {
  const write = (name, content) => {
    if (!omitted.has(name)) fixtureFile(join(output, name), contents.get(name) ?? content);
  };
  for (const [label, extensions] of platforms) {
    for (const extension of extensions) write(assetName(label, extension), extension === "AppImage" ? "" : "abc");
    write(
      `SHA256SUMS-${label}.txt`,
      extensions.map((extension) => checksumLine(label, extension, extension === "AppImage" ? emptyHash : abcHash)).join(""),
    );
  }
}

const mergedChecksums = [
  checksumLine("linux-x86_64", "AppImage", emptyHash),
  checksumLine("linux-x86_64", "deb"),
  checksumLine("macos-aarch64", "dmg"),
  checksumLine("macos-x86_64", "dmg"),
  checksumLine("windows-x86_64", "exe"),
].join("");

test("verify checks all four read-only platform fixtures and safely creates a repeatable merged manifest", () => {
  withFixture(({ output }) => {
    releaseFixture(output);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runCli(["verify", version, output]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /release assets: verified/);
      assert.equal(readFileSync(join(output, "SHA256SUMS.txt"), "utf8"), mergedChecksums);
      assert.equal(readdirSync(output).length, 10);
    }
  });
});

test("verify rejects tampered installers before creating the merged manifest", () => {
  for (const [label, extensions] of platforms) {
    for (const extension of extensions) {
      withFixture(({ output }) => {
        const name = assetName(label, extension);
        releaseFixture(output, { contents: new Map([[name, "tampered"]]) });
        const result = runCli(["verify", version, output]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /SHA256 不一致/);
        assert.equal(readFileSync(join(output, name), "utf8"), "tampered");
        assert.throws(() => readFileSync(join(output, "SHA256SUMS.txt")), { code: "ENOENT" });
      });
    }
  }
});

const windowsName = assetName("windows-x86_64", "exe");
const windowsLine = checksumLine("windows-x86_64", "exe");
const manifestCases = [
  ["duplicate", windowsLine + windowsLine],
  ["unknown entry", `${windowsLine}${abcHash}  unexpected.txt\n`],
  ["missing coverage", ""],
  ["wrong version", checksumLine("windows-x86_64", "exe", abcHash, "1.23.457")],
  ["parent traversal", `${windowsLine}${abcHash}  ../outside.exe\n`],
  ["nested traversal", `${windowsLine}${abcHash}  nested/../../outside.exe\n`],
  ["backslash traversal", `${windowsLine}${abcHash}  ..\\outside.exe\n`],
  ["absolute path", `${windowsLine}${abcHash}  /outside.exe\n`],
  ["Windows drive path", `${windowsLine}${abcHash}  C:\\outside.exe\n`],
  ["wrong platform", `${windowsLine}${checksumLine("macos-aarch64", "dmg")}`],
  ["invalid hash", `${"g".repeat(64)}  ${windowsName}\n`],
  ["short hash", `${abcHash.slice(1)}  ${windowsName}\n`],
  ["one-space separator", `${abcHash} ${windowsName}\n`],
  ["binary separator", `${abcHash} *${windowsName}\n`],
  ["extra blank line", `${windowsLine}\n`],
];
for (const [name, contents] of manifestCases) {
  test(`verify rejects platform manifest ${name} without writing outputs`, () => {
    withFixture(({ output }) => {
      const manifest = "SHA256SUMS-windows-x86_64.txt";
      releaseFixture(output, { contents: new Map([[manifest, contents]]) });
      const result = runCli(["verify", version, output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /清单|SHA256/);
      assert.equal(readFileSync(join(output, manifest), "utf8"), contents);
      assert.throws(() => readFileSync(join(output, "SHA256SUMS.txt")), { code: "ENOENT" });
    });
  });
}

for (const extra of ["extra.log", "other.exe", "other.dmg", "other.deb", "other.AppImage", "other.msi", "other.rpm", "other.pkg", "SHA256SUMS-other.txt", assetName("windows-x86_64", "exe", "1.23.457")]) {
  test(`verify rejects extra release file ${extra} anywhere in the assets tree`, () => {
    for (const nested of [false, true]) {
      withFixture(({ output }) => {
        releaseFixture(output);
        fixtureFile(join(output, ...(nested ? ["nested", extra] : [extra])));
        const result = runCli(["verify", version, output]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /额外|未知|根目录/);
        assert.throws(() => readFileSync(join(output, "SHA256SUMS.txt")), { code: "ENOENT" });
      });
    }
  });
}

for (const location of [windowsName, "SHA256SUMS-windows-x86_64.txt", "SHA256SUMS.txt", "unused-link", "linked-dir"]) {
  test(`verify rejects symlink ${location} instead of following it`, () => {
    withFixture(({ root, output }) => {
      const omitted = new Set([location]);
      releaseFixture(output, { omitted });
      const external = join(root, "external");
      if (location === "linked-dir") mkdirSync(external);
      else fixtureFile(external, location === windowsName ? "abc" : location === "SHA256SUMS.txt" ? mergedChecksums : windowsLine);
      symlinkSync(external, join(output, location), location === "linked-dir" ? "dir" : "file");
      const result = runCli(["verify", version, output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /符号链接/);
      if (location !== "linked-dir") assert.equal(readFileSync(external, "utf8"), location === windowsName ? "abc" : location === "SHA256SUMS.txt" ? mergedChecksums : windowsLine);
    });
  });
}

for (const [label, extensions] of platforms) {
  for (const missing of [...extensions.map((extension) => assetName(label, extension)), `SHA256SUMS-${label}.txt`]) {
    test(`verify requires ordinary release file ${missing}`, () => {
      withFixture(({ output }) => {
        releaseFixture(output, { omitted: new Set([missing]) });
        const result = runCli(["verify", version, output]);
        assert.equal(result.status, 1);
        assert.throws(() => readFileSync(join(output, "SHA256SUMS.txt")), { code: "ENOENT" });
        assert.equal(readdirSync(output).length, 8);
      });
    });
  }
}

test("verify rejects a different requested release version", () => {
  withFixture(({ output }) => {
    releaseFixture(output);
    const result = runCli(["verify", "9.8.7", output]);
    assert.equal(result.status, 1);
    assert.throws(() => readFileSync(join(output, "SHA256SUMS.txt")), { code: "ENOENT" });
  });
});

for (const contents of ["must not be overwritten", mergedChecksums.replace(abcHash, emptyHash), mergedChecksums + windowsLine, mergedChecksums.replace(windowsName, "../outside.exe")]) {
  test(`verify preserves an inconsistent existing merged manifest ${JSON.stringify(contents.slice(0, 30))}`, () => {
    withFixture(({ output }) => {
      releaseFixture(output);
      fixtureFile(join(output, "SHA256SUMS.txt"), contents);
      const result = runCli(["verify", version, output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /已有合并清单.*不一致/);
      assert.equal(readFileSync(join(output, "SHA256SUMS.txt"), "utf8"), contents);
      assert.equal(readdirSync(output).length, 10);
    });
  });
}

test("verify still checks platform hashes when a matching merged manifest already exists", () => {
  withFixture(({ output }) => {
    releaseFixture(output, { contents: new Map([[windowsName, "tampered"]]) });
    fixtureFile(join(output, "SHA256SUMS.txt"), mergedChecksums);
    const result = runCli(["verify", version, output]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA256 不一致/);
    assert.equal(readFileSync(join(output, "SHA256SUMS.txt"), "utf8"), mergedChecksums);
  });
});

test("verify accepts CRLF platform manifests and emits canonical LF checksums", () => {
  withFixture(({ output }) => {
    releaseFixture(output, { contents: new Map([["SHA256SUMS-windows-x86_64.txt", windowsLine.replaceAll("\n", "\r\n")]]) });
    assert.equal(runCli(["verify", version, output]).status, 0);
    assert.equal(readFileSync(join(output, "SHA256SUMS.txt"), "utf8"), mergedChecksums);
  });
});

test("collect requires exactly one file for each expected extension before writing", () => {
  for (const [label, extensions] of platforms) {
    for (const extension of extensions) {
      for (const count of [0, 2]) {
        withFixture(({ bundle, output }) => {
          for (const other of extensions.filter((value) => value !== extension)) fixtureFile(join(bundle, `original.${other}`));
          for (let i = 0; i < count; i += 1) fixtureFile(join(bundle, `nested-${i}`, `original.${extension}`));
          fixtureFile(join(output, "sentinel.txt"), "keep");
          const result = runCli(["collect", version, label, bundle, output]);
          assert.equal(result.status, 1);
          assert.match(result.stderr, /必须恰好有一个/);
          assert.deepEqual(readdirSync(output), ["sentinel.txt"]);
          assert.equal(readFileSync(join(output, "sentinel.txt"), "utf8"), "keep");
        });
      }
    }
  }
});

test("collect skips symlink files and directories, including broken installer links", () => {
  withFixture(({ root, bundle, output }) => {
    fixtureFile(join(bundle, "original.exe"));
    fixtureFile(join(root, "external", "duplicate.exe"), "not collected");
    symlinkSync(join(root, "external"), join(bundle, "linked-dir"), "dir");
    symlinkSync(join(root, "external", "duplicate.exe"), join(bundle, "linked.exe"), "file");
    symlinkSync(join(root, "missing.dmg"), join(bundle, "broken.dmg"), "file");
    const result = runCli(["collect", version, "windows-x86_64", bundle, output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(output, windowsName), "utf8"), "abc");
    assert.equal(readFileSync(join(root, "external", "duplicate.exe"), "utf8"), "not collected");
  });
});

test("collect treats a symlink-only installer as missing, not as a source", () => {
  withFixture(({ root, bundle, output }) => {
    fixtureFile(join(root, "external.exe"));
    symlinkSync(join(root, "external.exe"), join(bundle, "linked.exe"), "file");
    const result = runCli(["collect", version, "windows-x86_64", bundle, output]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /必须恰好有一个/);
    assert.throws(() => readdirSync(output), { code: "ENOENT" });
  });
});

test("collect refuses symlink, broken symlink and directory destinations without partial output", () => {
  for (const kind of ["symlink", "broken", "directory"]) {
    withFixture(({ root, bundle, output }) => {
      fixtureFile(join(bundle, "original.exe"));
      mkdirSync(output);
      const conflict = join(output, "SHA256SUMS-windows-x86_64.txt");
      const external = join(root, "external.txt");
      if (kind === "directory") mkdirSync(conflict);
      else {
        if (kind === "symlink") fixtureFile(external, "keep");
        symlinkSync(external, conflict, "file");
      }
      const result = runCli(["collect", version, "windows-x86_64", bundle, output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /已存在/);
      assert.deepEqual(readdirSync(output), ["SHA256SUMS-windows-x86_64.txt"]);
      if (kind === "symlink") assert.equal(readFileSync(external, "utf8"), "keep");
    });
  }
});

for (const invalidVersion of ["", "v1.23.456", "1.23", "1.23.456-beta", "../escape", "1.23.456\n", " 1.23.456"]) {
  test(`both commands reuse release notes version validation for ${JSON.stringify(invalidVersion)}`, () => {
    withFixture(({ bundle, output }) => {
      fixtureFile(join(bundle, "original.exe"));
      for (const args of [["collect", invalidVersion, "windows-x86_64", bundle, output], ["verify", invalidVersion, output]]) {
        const result = runCli(args);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /版本号必须是 x.y.z/);
        assert.equal(result.stdout, "");
      }
      assert.throws(() => readdirSync(output), { code: "ENOENT" });
    });
  });
}

test("CLI rejects unknown labels, commands and wrong arity without creating output", () => {
  withFixture(({ bundle, output }) => {
    fixtureFile(join(bundle, "original.exe"));
    const unknownLabel = runCli(["collect", version, "windows-arm64", bundle, output]);
    assert.equal(unknownLabel.status, 1);
    assert.match(unknownLabel.stderr, /不支持的平台/);
    for (const args of [[], ["unknown"], ["collect", version, "windows-x86_64", bundle], ["collect", version, "windows-x86_64", bundle, output, "extra"], ["verify", version], ["verify", version, output, "extra"]]) {
      const result = runCli(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /用法/);
      assert.equal(result.stdout, "");
    }
    assert.throws(() => readdirSync(output), { code: "ENOENT" });
  });
});

test("collect never follows symlink input roots or output directories", () => {
  for (const location of ["input", "input-parent", "output", "output-parent"]) {
    withFixture(({ root, bundle, output }) => {
      fixtureFile(join(bundle, "original.exe"));
      const external = join(root, "external");
      mkdirSync(external);
      const link = join(root, "linked");
      let input = bundle;
      let destination = output;
      if (location.startsWith("input")) {
        symlinkSync(location === "input" ? bundle : root, link, "dir");
        input = location === "input" ? link : join(link, "bundle");
      } else {
        symlinkSync(external, link, "dir");
        destination = location === "output" ? link : join(link, "assets");
      }
      const result = runCli(["collect", version, "windows-x86_64", input, destination]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /符号链接/);
      assert.deepEqual(readdirSync(external), []);
      assert.throws(() => readdirSync(output), { code: "ENOENT" });
    });
  }
});

test("collect refuses every existing destination before writing any other file", () => {
  for (const conflict of [assetName("linux-x86_64", "deb"), assetName("linux-x86_64", "AppImage"), "SHA256SUMS-linux-x86_64.txt"]) {
    withFixture(({ bundle, output }) => {
      fixtureFile(join(bundle, "original.deb"));
      fixtureFile(join(bundle, "original.AppImage"), "");
      fixtureFile(join(output, conflict), "must not be overwritten");
      const result = runCli(["collect", version, "linux-x86_64", bundle, output]);
      assert.equal(result.status, 1);
      assert.deepEqual(readdirSync(output), [conflict]);
      assert.match(result.stderr, /已存在/);
      assert.equal(readFileSync(join(output, conflict), "utf8"), "must not be overwritten");
    });
  }
});

test("collect rejects any extra installer before creating or changing outputs", () => {
  for (const extension of ["dmg", "deb", "AppImage", "msi", "rpm", "pkg", "EXE"]) {
    withFixture(({ bundle, output }) => {
      fixtureFile(join(bundle, "original.exe"));
      fixtureFile(join(bundle, "unexpected", `extra.${extension}`));
      const result = runCli(["collect", version, "windows-x86_64", bundle, output]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /额外安装包/);
      assert.throws(() => readdirSync(output), { code: "ENOENT" });
    });
  }
});
