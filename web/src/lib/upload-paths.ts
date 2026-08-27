const STORED_UPLOAD_PATH =
  /^\/uploads\/\d{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{32}(?:\.[a-z0-9]{1,16})?$/;

const BRAND_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

export const BRAND_IMAGE_ACCEPT =
  ".png,.jpg,.jpeg,.gif,.webp,.ico,image/png,image/jpeg,image/gif,image/webp,image/x-icon,image/vnd.microsoft.icon";

export function requireStoredUploadPath(response: unknown): string {
  if (typeof response !== "object" || response === null) {
    throw new Error("上传接口未返回有效文件路径");
  }
  const path = (response as { path?: unknown }).path;
  if (typeof path !== "string" || !STORED_UPLOAD_PATH.test(path)) {
    throw new Error("上传接口返回的文件半路径无效");
  }
  return path;
}

export function validateBrandImage(file: {
  type: string;
  size: number;
}): string | null {
  if (!BRAND_IMAGE_TYPES.has(file.type.toLowerCase())) {
    return "请选择 PNG、JPG、GIF、WebP 或 ICO 图片";
  }
  if (file.size > 2 * 1024 * 1024) {
    return "图片文件大小不能超过 2MB";
  }
  return null;
}
