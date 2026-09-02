import { tauriBridge, isTauri } from "./tauriBridge.ts";

export interface GithubReleaseAsset {
  name: string;
  downloadUrl: string;
  size: number;
  platform: string;
}

export interface GithubReleaseInfo {
  repo: string;
  tagName: string;
  version: string;
  name: string;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  assets: GithubReleaseAsset[];
}

export interface VersionCheckResult {
  currentVersion: string;
  latestVersion: string;
  tagName: string;
  hasUpdate: boolean;
  publishedAt: string;
  htmlUrl: string;
  body: string;
  assets: GithubReleaseAsset[];
}

const DEFAULT_REPO = "jingchen0529/vestus";
/** 拿不到本机版本时的取值。空串表示「未知」，而不是某个具体版本号——写死一个
 *  版本号只会在下次发版后变成谎报，而且会让开发会话凭空显示可升级。 */
export const UNKNOWN_VERSION = "";

export function normalizeVersion(ver: string): string {
  return ver.trim().replace(/^desktop-/, "").replace(/^v/, "");
}

/**
 * Compare two semver strings (e.g. "0.2.2" vs "0.1.8").
 * Returns:
 *   1 if v1 > v2
 *  -1 if v1 < v2
 *   0 if v1 == v2
 */
export function compareVersions(v1: string, v2: string): number {
  const clean1 = normalizeVersion(v1);
  const clean2 = normalizeVersion(v2);
  const parts1 = clean1.split(".").map((n) => parseInt(n, 10) || 0);
  const parts2 = clean2.split(".").map((n) => parseInt(n, 10) || 0);

  const len = Math.max(parts1.length, parts2.length);
  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
}

/**
 * Is `latest` newer than the version installed here?
 *
 * An unknown version on either side answers no. Without a local version there
 * is nothing to compare against, and treating that as "upgrade available"
 * would show a permanent, unfounded update prompt in every dev session.
 */
export function hasNewerVersion(latest: string, current: string): boolean {
  if (!normalizeVersion(latest || "") || !normalizeVersion(current || "")) return false;
  return compareVersions(latest, current) > 0;
}

export function classifyAssetPlatform(filename: string): string {
  const nameLower = filename.toLowerCase();
  if (nameLower.includes("macos") || nameLower.includes("darwin") || nameLower.includes(".dmg")) {
    if (nameLower.includes("aarch64") || nameLower.includes("arm64") || nameLower.includes("m1") || nameLower.includes("apple")) {
      return "macOS (Apple Silicon M系列)";
    }
    return "macOS (Intel x86_64)";
  }
  if (nameLower.includes("windows") || nameLower.includes(".exe") || nameLower.includes(".msi")) {
    return "Windows (x86_64)";
  }
  if (nameLower.includes("appimage")) {
    return "Linux (AppImage)";
  }
  if (nameLower.includes(".deb")) {
    return "Linux (Debian / Ubuntu)";
  }
  return "通用安装包";
}

export type OperatingSystem = "macos" | "windows" | "linux" | "unknown";
export type Architecture = "arm64" | "x64" | "unknown";

export interface CurrentSystemInfo {
  os: OperatingSystem;
  arch: Architecture;
  label: string;
}

export function detectCurrentSystem(): CurrentSystemInfo {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { os: "unknown", arch: "unknown", label: "未知系统" };
  }

  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();

  let os: OperatingSystem = "unknown";
  let arch: Architecture = "unknown";

  if (ua.includes("mac") || platform.includes("mac")) {
    os = "macos";
  } else if (ua.includes("win") || platform.includes("win")) {
    os = "windows";
  } else if (ua.includes("linux") || platform.includes("linux")) {
    os = "linux";
  }

  if (
    ua.includes("arm64") ||
    ua.includes("aarch64") ||
    platform.includes("arm") ||
    platform.includes("aarch64")
  ) {
    arch = "arm64";
  } else if (
    ua.includes("x86_64") ||
    ua.includes("x64") ||
    ua.includes("win64") ||
    ua.includes("wow64") ||
    platform.includes("x86_64") ||
    platform.includes("x64")
  ) {
    arch = "x64";
  }

  // Apple Silicon Mac 上浏览器 UA 常默认冻结为 Intel Mac OS X，通过 WebGL Renderer 辅助检测 Apple M 系列芯片
  if (os === "macos" && arch === "unknown") {
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
      if (gl) {
        const debugInfo = (gl as WebGLRenderingContext).getExtension("WEBGL_debug_renderer_info");
        if (debugInfo) {
          const renderer = (gl as WebGLRenderingContext).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || "";
          if (/apple m|apple gpu/i.test(renderer)) {
            arch = "arm64";
          }
        }
      }
    } catch {
      // 容错回退
    }
  }

  const label =
    os === "macos"
      ? (arch === "arm64" ? "macOS (Apple Silicon)" : arch === "x64" ? "macOS (Intel)" : "macOS")
      : os === "windows"
      ? "Windows"
      : os === "linux"
      ? "Linux"
      : "当前系统";

  return { os, arch, label };
}

/**
 * 根据当前系统环境智能过滤出匹配的原生安装包
 */
export function filterCurrentSystemAssets(
  assets: GithubReleaseAsset[],
  sys: CurrentSystemInfo = detectCurrentSystem()
): GithubReleaseAsset[] {
  if (sys.os === "unknown" || !assets.length) {
    return assets;
  }

  let osAssets: GithubReleaseAsset[] = [];

  if (sys.os === "macos") {
    osAssets = assets.filter(
      (a) =>
        a.platform.startsWith("macOS") ||
        a.name.toLowerCase().includes("macos") ||
        a.name.toLowerCase().includes(".dmg") ||
        a.name.toLowerCase().includes("darwin")
    );

    if (sys.arch === "arm64") {
      const exact = osAssets.filter(
        (a) =>
          a.platform.includes("Apple Silicon") ||
          a.name.toLowerCase().includes("aarch64") ||
          a.name.toLowerCase().includes("arm64")
      );
      if (exact.length > 0) return exact;
    } else if (sys.arch === "x64") {
      const exact = osAssets.filter(
        (a) =>
          a.platform.includes("Intel") ||
          a.name.toLowerCase().includes("x86_64") ||
          a.name.toLowerCase().includes("x64")
      );
      if (exact.length > 0) return exact;
    }
  } else if (sys.os === "windows") {
    osAssets = assets.filter(
      (a) =>
        a.platform.startsWith("Windows") ||
        a.name.toLowerCase().includes("windows") ||
        a.name.toLowerCase().includes(".exe") ||
        a.name.toLowerCase().includes(".msi")
    );
  } else if (sys.os === "linux") {
    osAssets = assets.filter(
      (a) =>
        a.platform.startsWith("Linux") ||
        a.name.toLowerCase().includes("linux") ||
        a.name.toLowerCase().includes(".appimage") ||
        a.name.toLowerCase().includes(".deb")
    );
  }

  return osAssets.length > 0 ? osAssets : assets;
}

export const versionService = {
  /** 本机安装的版本号；不在 Tauri 窗口里（浏览器开发会话）就返回空串。 */
  async getCurrentVersion(): Promise<string> {
    try {
      const v = await tauriBridge.getAppVersion();
      if (v) return normalizeVersion(v);
    } catch {
      // 当作未知处理，不猜一个版本号。
    }
    return UNKNOWN_VERSION;
  },

  async checkGithubRelease(repo: string = DEFAULT_REPO): Promise<VersionCheckResult> {
    const currentVersion = await this.getCurrentVersion();
    const cleanRepo = repo.trim() || DEFAULT_REPO;

    // 在桌面客户端中通过 Rust 原生端拉取 GitHub Release，彻底规避 WebKit CSP 拦截
    if (isTauri()) {
      try {
        const raw = await tauriBridge.checkGithubRelease(cleanRepo);
        const hasUpdate = hasNewerVersion(raw.latestVersion, currentVersion);
        return {
          currentVersion,
          latestVersion: raw.latestVersion,
          tagName: raw.tagName,
          hasUpdate,
          publishedAt: raw.publishedAt,
          htmlUrl: raw.htmlUrl,
          body: raw.body,
          assets: (raw.assets || []).map((a) => ({
            name: a.name,
            downloadUrl: a.downloadUrl,
            size: a.size,
            platform: a.platform || classifyAssetPlatform(a.name),
          })),
        };
      } catch (err: any) {
        throw new Error(err?.message || "连接 GitHub 失败，请检查网络");
      }
    }

    let data: any = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${cleanRepo}/releases/latest`, {
        headers: {
          Accept: "application/vnd.github.v3+json",
        },
      });

      if (res.ok) {
        data = await res.json();
      } else if (res.status === 404) {
        // Fallback to all releases if latest is not marked
        const listRes = await fetch(`https://api.github.com/repos/${cleanRepo}/releases`, {
          headers: {
            Accept: "application/vnd.github.v3+json",
          },
        });
        if (listRes.ok) {
          const list = await listRes.json();
          if (Array.isArray(list) && list.length > 0) {
            data = list[0];
          }
        }
      } else if (res.status === 403) {
        throw new Error("GitHub API 访问速率受限，请稍后重试");
      } else {
        throw new Error(`获取 GitHub Release 失败 (HTTP ${res.status})`);
      }
    } catch (err: any) {
      throw new Error(err?.message || "连接 GitHub 失败，请检查网络");
    }

    if (!data) {
      throw new Error("未在 GitHub 仓库中找到已发布的版本信息");
    }

    const tagName = data.tag_name || "";
    const latestVersion = normalizeVersion(tagName || data.name || "0.0.0");
    const hasUpdate = hasNewerVersion(latestVersion, currentVersion);

    const assets: GithubReleaseAsset[] = (data.assets || []).map((asset: any) => ({
      name: asset.name || "",
      downloadUrl: asset.browser_download_url || "",
      size: typeof asset.size === "number" ? asset.size : 0,
      platform: classifyAssetPlatform(asset.name || ""),
    }));

    return {
      currentVersion,
      latestVersion,
      tagName,
      hasUpdate,
      publishedAt: data.published_at || "",
      htmlUrl: data.html_url || `https://github.com/${cleanRepo}/releases`,
      body: data.body || "",
      assets,
    };
  },
};
