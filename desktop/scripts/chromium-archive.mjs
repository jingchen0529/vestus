// Small, dependency-free preflight for the pinned, non-ZIP64 CfT archives.
// Never extract a path or symlink until its directory record has been checked.
import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, readdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { inflateRawSync } from "node:zlib";

function safePath(name, root) {
  const parts = name.replace(/\/$/, "").split("/");
  if (!name || name.includes("\\") || /[\x00-\x1f:]/.test(name) || parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) || parts[0] !== root) {
    throw new Error(`Unsafe ZIP archive path/root: ${name}`);
  }
  return parts.join("/");
}

function safeLink(name, target, root) {
  if (!target || target.includes("\\") || /[\x00-\x1f:]/.test(target) || posix.isAbsolute(target)) throw new Error(`Unsafe ZIP link: ${name}`);
  const resolved = posix.normalize(posix.join(posix.dirname(name), target));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error(`ZIP link escapes archive root: ${name}`);
}

function validateExtraFields(bytes) {
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) throw new Error("Malformed ZIP extra field");
    const tag = bytes.readUInt16LE(cursor), length = bytes.readUInt16LE(cursor + 2);
    if ([0x0001, 0x7075].includes(tag) || cursor + 4 + length > bytes.length) throw new Error("Unsupported ZIP path extra field");
    cursor += 4 + length;
  }
}

export function validateZip(path, root) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const read = (offset, length) => {
      if (offset < 0 || length < 0 || offset + length > size) throw new Error("Truncated ZIP archive");
      const buffer = Buffer.alloc(length);
      if (readSync(fd, buffer, 0, length, offset) !== length) throw new Error("Truncated ZIP archive");
      return buffer;
    };
    const tailOffset = Math.max(0, size - 65_557), tail = read(tailOffset, size - tailOffset);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Missing ZIP directory");
    const count = tail.readUInt16LE(eocd + 10), directorySize = tail.readUInt32LE(eocd + 12), directoryOffset = tail.readUInt32LE(eocd + 16);
    if (tail.readUInt16LE(eocd + 4) || tail.readUInt16LE(eocd + 6) || tail.readUInt16LE(eocd + 8) !== count || !count || count === 65535 || directorySize > 32 * 1024 * 1024 || directoryOffset + directorySize !== tailOffset + eocd) throw new Error("Unsupported ZIP directory (multi-disk/ZIP64)");
    const directory = read(directoryOffset, directorySize), entries = new Map(), ranges = [];
    let cursor = 0;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > directory.length || directory.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Malformed ZIP directory record");
      const flags = directory.readUInt16LE(cursor + 8), method = directory.readUInt16LE(cursor + 10);
      const compressed = directory.readUInt32LE(cursor + 20), expanded = directory.readUInt32LE(cursor + 24);
      const nameLength = directory.readUInt16LE(cursor + 28), extraLength = directory.readUInt16LE(cursor + 30), commentLength = directory.readUInt16LE(cursor + 32);
      const mode = directory.readUInt32LE(cursor + 38) >>> 16, offset = directory.readUInt32LE(cursor + 42);
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > directory.length || flags & 1 || ![0, 8].includes(method) || directory.readUInt16LE(cursor + 34) || [compressed, expanded, offset].includes(0xffffffff)) throw new Error("Unsupported ZIP archive record");
      const nameBytes = directory.subarray(cursor + 46, cursor + 46 + nameLength);
      const name = nameBytes.toString("utf8"), normalized = safePath(name, root);
      if (!Buffer.from(name).equals(nameBytes) || entries.has(normalized.toLowerCase())) throw new Error("Invalid/duplicate ZIP path");
      // Both records must reject extras an extractor could use to override the name.
      validateExtraFields(directory.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength));
      const local = read(offset, 30);
      const localNameLength = local.readUInt16LE(26), localExtraLength = local.readUInt16LE(28);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== method || !read(offset + 30, localNameLength).equals(nameBytes)) throw new Error("ZIP local/directory path mismatch");
      const dataOffset = offset + 30 + localNameLength + localExtraLength;
      if (dataOffset + compressed > directoryOffset) throw new Error("ZIP data escapes file region");
      validateExtraFields(read(offset + 30 + localNameLength, localExtraLength));
      const type = mode & 0o170000;
      if (type && ![0o100000, 0o040000, 0o120000].includes(type)) throw new Error("Unsupported ZIP special file");
      const link = type === 0o120000;
      if (link) {
        if (expanded > 4096 || compressed > 8192) throw new Error("Oversized ZIP symlink");
        const data = read(dataOffset, compressed), target = (method === 8 ? inflateRawSync(data, { maxOutputLength: 4096 }) : data).toString("utf8");
        safeLink(normalized, target, root);
      }
      entries.set(normalized.toLowerCase(), { name: normalized, link });
      ranges.push([offset, dataOffset + compressed]);
      cursor = end;
    }
    if (cursor !== directory.length) throw new Error("Unexpected ZIP directory tail");
    ranges.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < ranges.length; i++) if (ranges[i][0] < ranges[i - 1][1]) throw new Error("Overlapping ZIP entries");
    for (const { name } of entries.values()) {
      let parent = posix.dirname(name);
      while (parent !== ".") {
        if (entries.get(parent.toLowerCase())?.link) throw new Error(`ZIP entry descends through symlink: ${name}`);
        parent = posix.dirname(parent);
      }
    }
  } finally { closeSync(fd); }
}

const inside = (root, path) => {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};

export function validateTree(directory) {
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error("Candidate root must be a real directory");
  const root = realpathSync(directory);
  const walk = (path) => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry), stat = lstatSync(child);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(child);
        if (isAbsolute(target) || !inside(root, resolve(dirname(child), target))) throw new Error(`Symlink escapes candidate: ${child}`);
        let actual;
        try { actual = realpathSync(child); } catch { throw new Error(`Broken/cyclic candidate symlink: ${child}`); }
        if (!inside(root, actual)) throw new Error(`Symlink escapes candidate: ${child}`);
      } else if (stat.isDirectory()) walk(child);
      else if (!stat.isFile()) throw new Error(`Unexpected candidate special file: ${child}`);
    }
  };
  walk(root);
}
