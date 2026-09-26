import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Saves the test window to `$CAIRN_SCREENSHOTS/<name>.png` (Windows only), optionally
 * cropped to `crop` ("x,y,w,h" in window pixels). A no-op when the variable is unset.
 */
export function screenshot(name: string, crop?: string): void {
  const dir = process.env.CAIRN_SCREENSHOTS;
  if (!dir || process.platform !== "win32") return;
  // Bundled to dist/e2e/index.cjs, two levels below the package root.
  const script = path.join(__dirname, "../../e2e/screenshot.ps1");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Out", path.join(dir, `${name}.png`)];
  if (crop) args.push("-Crop", crop);
  console.log(`screenshot: ${execFileSync("powershell", args, { encoding: "utf8" }).trim()}`);
}
