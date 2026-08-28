import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const iconsDir = join(desktopRoot, "src-tauri", "icons");
const artifactDir = "/Users/zhangyang/.gemini/antigravity-ide/brain/1eafb654-c1a3-4842-8883-a801ab1e61de";

mkdirSync(iconsDir, { recursive: true });

const htmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      width: 660px;
      height: 440px;
      background: linear-gradient(180deg, #f8fafc 0%, #edf2f7 100%);
      position: relative;
      overflow: hidden;
      color: #1e293b;
    }

    /* Subtle background glow */
    .bg-glow-1 {
      position: absolute;
      top: -40px;
      left: 100px;
      width: 260px;
      height: 260px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.1) 0%, rgba(59, 130, 246, 0) 70%);
      pointer-events: none;
    }
    .bg-glow-2 {
      position: absolute;
      top: -40px;
      right: 100px;
      width: 260px;
      height: 260px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.1) 0%, rgba(99, 102, 241, 0) 70%);
      pointer-events: none;
    }

    /* Top Drop Zone Target Rings */
    .drop-target-left {
      position: absolute;
      left: 180px;
      top: 120px;
      transform: translate(-50%, -50%);
      width: 106px;
      height: 106px;
      border-radius: 26px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, rgba(255, 255, 255, 0) 70%);
      border: 1.5px dashed rgba(147, 197, 253, 0.7);
      pointer-events: none;
    }
    .drop-target-right {
      position: absolute;
      left: 480px;
      top: 120px;
      transform: translate(-50%, -50%);
      width: 106px;
      height: 106px;
      border-radius: 26px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, rgba(255, 255, 255, 0) 70%);
      border: 1.5px dashed rgba(199, 210, 254, 0.7);
      pointer-events: none;
    }

    /* Middle Arrow */
    .arrow-container {
      position: absolute;
      top: 96px;
      left: 330px;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      pointer-events: none;
    }
    .arrow-svg {
      width: 120px;
      height: 26px;
      filter: drop-shadow(0 2px 4px rgba(59, 130, 246, 0.25));
    }
    .drag-tag {
      font-size: 11px;
      font-weight: 600;
      color: #2563eb;
      background: rgba(239, 246, 255, 0.95);
      border: 1px solid rgba(191, 219, 254, 0.9);
      padding: 3px 12px;
      border-radius: 20px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      white-space: nowrap;
    }

    /* Bottom Info Card */
    .info-panel {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 22px;
      background: rgba(255, 255, 255, 0.9);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid rgba(226, 232, 240, 0.95);
      border-radius: 14px;
      padding: 13px 18px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05), 0 1px 3px rgba(0, 0, 0, 0.02);
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: #b45309;
      background: #fef3c7;
      border: 1px solid #fde68a;
      padding: 2px 8px;
      border-radius: 6px;
    }
    .panel-desc {
      font-size: 11.5px;
      color: #475569;
      line-height: 1.4;
      font-weight: 500;
    }

    /* Command block */
    .cmd-box {
      margin-top: 8px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cmd-code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11.5px;
      color: #38bdf8;
      word-break: break-all;
      user-select: all;
      font-weight: 500;
    }
    .cmd-tag {
      font-size: 10px;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }

    .panel-footer {
      margin-top: 7px;
      font-size: 11px;
      color: #64748b;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .panel-footer b {
      color: #334155;
    }
  </style>
</head>
<body>
  <div class="bg-glow-1"></div>
  <div class="bg-glow-2"></div>

  <!-- Drop Targets -->
  <div class="drop-target-left"></div>
  <div class="drop-target-right"></div>

  <!-- Drag Arrow -->
  <div class="arrow-container">
    <svg class="arrow-svg" viewBox="0 0 120 26" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M4 13H106" stroke="url(#paint0_linear)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4"/>
      <path d="M98 5L114 13L98 21" stroke="#2563EB" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      <defs>
        <linearGradient id="paint0_linear" x1="4" y1="13" x2="114" y2="13" gradientUnits="userSpaceOnUse">
          <stop stop-color="#93C5FD"/>
          <stop offset="1" stop-color="#2563EB"/>
        </linearGradient>
      </defs>
    </svg>
    <div class="drag-tag">按住图标拖入 Applications 安装</div>
  </div>

  <!-- Bottom Instructions Card -->
  <div class="info-panel">
    <div class="panel-header">
      <span class="badge">⚠️ macOS 安全提示</span>
      <span class="panel-desc">由于系统 Gatekeeper 限制，首次打开若提示<b>「已损坏」</b>或<b>「无法打开」</b>：</span>
    </div>
    <div class="cmd-box">
      <span class="cmd-code">sudo xattr -rd com.apple.quarantine "/Applications/Vestus.app"</span>
      <span class="cmd-tag">终端命令</span>
    </div>
    <div class="panel-footer">
      <span>💡 打开<b>「终端 (Terminal)」</b>粘贴执行上述命令并输入开机密码，即可正常打开使用。</span>
    </div>
  </div>
</body>
</html>`;

const tempHtml = join(desktopRoot, ".cache", "dmg-template.html");
mkdirSync(dirname(tempHtml), { recursive: true });
writeFileSync(tempHtml, htmlContent, "utf8");

const chromeExec = join(
  desktopRoot,
  "src-tauri",
  "resources",
  "chromium",
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing"
);

const outputPng = join(iconsDir, "dmg-background.png");
const previewArtifact = join(artifactDir, "dmg_installer_preview.png");

// 1. Generate DMG background image at standard 660x440
execFileSync(chromeExec, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=660,440",
  `--screenshot=${outputPng}`,
  tempHtml,
]);

console.log(`Generated DMG background: ${outputPng}`);

// 2. Also generate a complete preview with mockup app icon and Applications folder
const previewHtmlContent = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    body {
      width: 688px;
      height: 488px;
      background: #e2e8f0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    /* macOS Window Shell */
    .mac-window {
      width: 660px;
      height: 440px;
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0,0,0,0.1);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      background: #f8fafc;
      position: relative;
    }
    /* Titlebar */
    .titlebar {
      height: 28px;
      background: #e2e8f0;
      border-bottom: 1px solid #cbd5e1;
      display: flex;
      align-items: center;
      padding: 0 12px;
      position: relative;
      z-index: 50;
    }
    .traffic-lights {
      display: flex;
      gap: 8px;
    }
    .dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .dot-red { background: #ff5f56; border: 1px solid #e0443e; }
    .dot-yellow { background: #ffbd2e; border: 1px solid #dea123; }
    .dot-green { background: #27c93f; border: 1px solid #1aab29; }
    .title-text {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      font-size: 13px;
      font-weight: 500;
      color: #334155;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Content */
    .window-body {
      flex: 1;
      position: relative;
      background: linear-gradient(180deg, #f8fafc 0%, #edf2f7 100%);
    }

    /* Top Drop Zone Target Rings */
    .drop-target-left {
      position: absolute;
      left: 180px;
      top: 105px;
      transform: translate(-50%, -50%);
      width: 106px;
      height: 106px;
      border-radius: 26px;
      background: radial-gradient(circle, rgba(59, 130, 246, 0.08) 0%, rgba(255, 255, 255, 0) 70%);
      border: 1.5px dashed rgba(147, 197, 253, 0.7);
      pointer-events: none;
    }
    .drop-target-right {
      position: absolute;
      left: 480px;
      top: 105px;
      transform: translate(-50%, -50%);
      width: 106px;
      height: 106px;
      border-radius: 26px;
      background: radial-gradient(circle, rgba(99, 102, 241, 0.08) 0%, rgba(255, 255, 255, 0) 70%);
      border: 1.5px dashed rgba(199, 210, 254, 0.7);
      pointer-events: none;
    }

    /* Mockup Icons */
    .icon-vestus {
      position: absolute;
      left: 180px;
      top: 105px;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      z-index: 20;
    }
    .icon-applications {
      position: absolute;
      left: 480px;
      top: 105px;
      transform: translate(-50%, -50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      z-index: 20;
    }
    .icon-img {
      width: 64px;
      height: 64px;
      border-radius: 14px;
      box-shadow: 0 8px 16px rgba(0,0,0,0.12);
    }
    .app-label {
      font-size: 12px;
      font-weight: 600;
      color: #1e293b;
      padding: 2px 8px;
      border-radius: 4px;
      background: rgba(255,255,255,0.7);
    }

    /* Arrow in the middle */
    .arrow-container {
      position: absolute;
      top: 80px;
      left: 330px;
      transform: translateX(-50%);
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      z-index: 10;
    }
    .arrow-svg {
      width: 120px;
      height: 26px;
      filter: drop-shadow(0 2px 4px rgba(59, 130, 246, 0.25));
    }
    .drag-tag {
      font-size: 11px;
      font-weight: 600;
      color: #2563eb;
      background: rgba(239, 246, 255, 0.95);
      border: 1px solid rgba(191, 219, 254, 0.9);
      padding: 3px 12px;
      border-radius: 20px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05);
      white-space: nowrap;
    }

    /* Bottom Info Card */
    .info-panel {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 20px;
      background: rgba(255, 255, 255, 0.92);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(226, 232, 240, 0.95);
      border-radius: 14px;
      padding: 13px 18px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.05);
      z-index: 10;
    }
    .panel-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 6px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      font-weight: 700;
      color: #b45309;
      background: #fef3c7;
      border: 1px solid #fde68a;
      padding: 2px 8px;
      border-radius: 6px;
    }
    .panel-desc {
      font-size: 11.5px;
      color: #475569;
      line-height: 1.4;
      font-weight: 500;
    }
    .cmd-box {
      margin-top: 8px;
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 8px;
      padding: 8px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .cmd-code {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 11.5px;
      color: #38bdf8;
      word-break: break-all;
      font-weight: 500;
    }
    .cmd-tag {
      font-size: 10px;
      color: #94a3b8;
      background: rgba(255, 255, 255, 0.1);
      padding: 2px 6px;
      border-radius: 4px;
      white-space: nowrap;
    }
    .panel-footer {
      margin-top: 7px;
      font-size: 11px;
      color: #64748b;
    }
    .panel-footer b {
      color: #334155;
    }
  </style>
</head>
<body>
  <div class="mac-window">
    <div class="titlebar">
      <div class="traffic-lights">
        <div class="dot dot-red"></div>
        <div class="dot dot-yellow"></div>
        <div class="dot dot-green"></div>
      </div>
      <div class="title-text">
        <span>Vestus</span>
      </div>
    </div>
    <div class="window-body">
      <!-- Target Rings -->
      <div class="drop-target-left"></div>
      <div class="drop-target-right"></div>

      <!-- Mockup Icons -->
      <div class="icon-vestus">
        <img class="icon-img" src="${join(desktopRoot, "src/assets/logo.png")}" alt="Vestus" />
        <span class="app-label">Vestus</span>
      </div>

      <div class="arrow-container">
        <svg class="arrow-svg" viewBox="0 0 120 26" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 13H106" stroke="url(#paint0_linear)" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 4"/>
          <path d="M98 5L114 13L98 21" stroke="#2563EB" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <defs>
            <linearGradient id="paint0_linear" x1="4" y1="13" x2="114" y2="13" gradientUnits="userSpaceOnUse">
              <stop stop-color="#93C5FD"/>
              <stop offset="1" stop-color="#2563EB"/>
            </linearGradient>
          </defs>
        </svg>
        <div class="drag-tag">按住图标拖入 Applications 安装</div>
      </div>

      <div class="icon-applications">
        <svg class="icon-img" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect width="64" height="64" rx="14" fill="#38BDF8"/>
          <path d="M16 22C16 19.7909 17.7909 18 20 18H28L32 22H44C46.2091 22 48 23.7909 48 26V44C48 46.2091 46.2091 48 44 48H20C17.7909 48 16 46.2091 16 44V22Z" fill="white" fill-opacity="0.9"/>
          <path d="M32 28L38 40H26L32 28Z" stroke="#0284C7" stroke-width="2.5" stroke-linejoin="round"/>
        </svg>
        <span class="app-label">Applications</span>
      </div>

      <!-- Bottom Instructions Card -->
      <div class="info-panel">
        <div class="panel-header">
          <span class="badge">⚠️ macOS 安全提示</span>
          <span class="panel-desc">由于系统 Gatekeeper 限制，首次打开若提示<b>「已损坏」</b>或<b>「无法打开」</b>：</span>
        </div>
        <div class="cmd-box">
          <span class="cmd-code">sudo xattr -rd com.apple.quarantine "/Applications/Vestus.app"</span>
          <span class="cmd-tag">终端命令</span>
        </div>
        <div class="panel-footer">
          <span>💡 打开<b>「终端 (Terminal)」</b>粘贴执行上述命令并输入开机密码，即可正常打开使用。</span>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;

const tempPreviewHtml = join(desktopRoot, ".cache", "dmg-preview.html");
writeFileSync(tempPreviewHtml, previewHtmlContent, "utf8");

execFileSync(chromeExec, [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--window-size=688,496",
  `--screenshot=${previewArtifact}`,
  tempPreviewHtml,
]);

console.log(`Generated DMG Preview Screenshot: ${previewArtifact}`);
