import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, copyFileSync, symlinkSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const appPath = join(
  desktopRoot,
  "src-tauri",
  "target",
  "aarch64-apple-darwin",
  "release",
  "bundle",
  "macos",
  "Vestus.app"
);

const bgTiffPath = join(desktopRoot, "src-tauri", "icons", "dmg-background.tiff");
const bgPngPath = join(desktopRoot, "src-tauri", "icons", "dmg-background.png");
const bgPath = existsSync(bgTiffPath) ? bgTiffPath : bgPngPath;
const bgFileName = existsSync(bgTiffPath) ? "dmg-background.tiff" : "dmg-background.png";
const iconPath = join(desktopRoot, "src-tauri", "icons", "icon.icns");
const outputDmg = join(desktopRoot, "Vestus_Preview.dmg");
const tempDir = join(desktopRoot, ".cache", "dmg_temp");

console.log("Building DMG preview with Retina background...");

// 1. Clean old artifacts
try {
  execSync(`hdiutil detach "/Volumes/Vestus" 2>/dev/null || true`);
} catch {}
rmSync(tempDir, { recursive: true, force: true });
rmSync(outputDmg, { force: true });
rmSync(join(desktopRoot, ".cache", "temp.dmg"), { force: true });

mkdirSync(tempDir, { recursive: true });
mkdirSync(join(tempDir, ".background"), { recursive: true });

// 2. Copy App and Assets
console.log("Copying files...");
execSync(`cp -R "${appPath}" "${tempDir}/Vestus.app"`);
symlinkSync("/Applications", join(tempDir, "Applications"));
copyFileSync(bgPath, join(tempDir, ".background", bgFileName));
if (existsSync(iconPath)) {
  copyFileSync(iconPath, join(tempDir, ".VolumeIcon.icns"));
}

// 3. Create writable DMG
console.log("Creating writable disk image...");
const rawDmg = join(desktopRoot, ".cache", "temp.dmg");
execSync(`hdiutil create -srcfolder "${tempDir}" -volname "Vestus" -fs HFS+ -fsargs "-c c=64,a=16,e=16" -format UDRW -size 400m "${rawDmg}"`);

// 4. Mount image
console.log("Mounting temporary image...");
const attachOutput = execSync(`hdiutil attach -readwrite -noverify -noautoopen "${rawDmg}"`).toString();
const mountMatch = attachOutput.match(/\/Volumes\/Vestus/);
if (!mountMatch) {
  throw new Error("Failed to mount volume: " + attachOutput);
}

// 5. Run AppleScript to layout Finder window
console.log("Configuring Finder layout...");
const appleScript = `
tell application "Finder"
  tell disk "Vestus"
    open
    tell container window
      set current view to icon view
      set toolbar visible to false
      set statusbar visible to false
      set the bounds to {400, 200, 1060, 640}
    end tell
    set opts to the icon view options of container window
    tell opts
      set icon size to 100
      set text size to 12
      set arrangement to not arranged
      set background picture to (POSIX file "/Volumes/Vestus/.background/${bgFileName}" as alias)
    end tell
    set position of item "Vestus.app" of container window to {180, 120}
    set position of item "Applications" of container window to {480, 120}
    update without registering applications
    delay 2
    close
  end tell
end tell
`;

try {
  execSync(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`);
} catch (e) {
  console.warn("AppleScript styling notice:", e.message);
}

execSync("sleep 2");

// Set Volume Icon attribute if present
if (existsSync(iconPath)) {
  try {
    execSync(`SetFile -a C "/Volumes/Vestus" 2>/dev/null || true`);
  } catch {}
}

// 6. Detach
console.log("Unmounting...");
execSync(`hdiutil detach "/Volumes/Vestus" -force`);

// 7. Convert to compressed read-only DMG
console.log("Compressing final DMG...");
execSync(`hdiutil convert "${rawDmg}" -format UDZO -imagekey zlib-level=9 -o "${outputDmg}"`);
rmSync(rawDmg, { force: true });
rmSync(tempDir, { recursive: true, force: true });

console.log(`DMG successfully created: ${outputDmg}`);

// 8. Open the DMG in Finder!
console.log("Opening DMG in Finder on your desktop...");
execSync(`open "${outputDmg}"`);
