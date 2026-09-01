import { tauriBridge } from "./tauriBridge.ts";

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
export const DEFAULT_CURRENT_VERSION = "0.1.8";

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

export const versionService = {
  async getCurrentVersion(): Promise<string> {
    try {
      const v = await tauriBridge.getAppVersion();
      if (v) return normalizeVersion(v);
    } catch {
      // fallback
    }
    return DEFAULT_CURRENT_VERSION;
  },

  async checkGithubRelease(repo: string = DEFAULT_REPO): Promise<VersionCheckResult> {
    const currentVersion = await this.getCurrentVersion();
    const cleanRepo = repo.trim() || DEFAULT_REPO;

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
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

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
