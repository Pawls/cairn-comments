// `npm run test:native`: drives a real VS Code window with Playwright, so keystrokes reach
// the editor as they do for the owner. The e2e suite runs in a window without focus, where
// Ctrl+X/Ctrl+V never fire a clipboard event and Ctrl+Z's "undo across files" prompt
// cannot be answered; these tests cover those paths. Each test gets a fresh window and a
// scratch copy of e2e/fixture-markerless, with native/competitor installed beside the
// extension as a stand-in for Pylance's paste provider. Set CAIRN_E2E_EXTENSION=<dir> to
// test an unpacked .vsix instead of this package. Windows only so far.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { scratchRepo, type ScratchRepo } from "../e2e/scratch.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extension = process.env.CAIRN_E2E_EXTENSION ? path.resolve(process.env.CAIRN_E2E_EXTENSION) : packageRoot;
const competitor = path.join(packageRoot, "native/competitor");
const failures = path.join(packageRoot, ".vscode-test/native-failures");

// Terminals inside VS Code export this; inherited, it makes the test build of VS Code run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const SETTINGS = {
  // A custom dialog is part of the page, so a test can answer the undo-across-files prompt.
  "window.dialogStyle": "custom",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "chat.disableAIFeatures": true,
  "update.mode": "none",
  "extensions.autoCheckUpdates": false,
  "git.enabled": false,
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, condition: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await settle(100);
  }
}

class Window {
  constructor(
    readonly app: ElectronApplication,
    readonly page: Page,
    readonly repo: string,
  ) {}

  read(file: string): string {
    return readFileSync(path.join(this.repo, file), "utf8");
  }

  sidecar(): string {
    return this.read(".agents/comments/sample.py.md");
  }

  async keys(...keys: string[]): Promise<void> {
    for (const key of keys) await this.page.keyboard.press(key);
  }

  /** Runs a command palette entry by its title. */
  async command(title: string): Promise<void> {
    await this.keys("F1");
    const input = this.page.locator(".quick-input-widget input");
    await input.waitFor();
    await input.fill(`>${title}`);
    await this.page.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor();
    await this.keys("Enter");
  }

  /** Puts the cursor at the start of `line` (1-based). */
  async goto(line: number): Promise<void> {
    await this.keys("Control+G");
    await this.page.locator(".quick-input-widget input").waitFor();
    await this.page.keyboard.type(String(line));
    await this.keys("Enter");
    await this.page.locator(".quick-input-widget").waitFor({ state: "hidden" });
  }

  /** Waits for the overlay to show `text` in the editor. */
  async shows(text: string): Promise<void> {
    await this.page.locator(".monaco-editor", { hasText: text }).first().waitFor();
  }
}

async function launch(scratch: ScratchRepo): Promise<Window> {
  const userData = path.join(scratch.dir, "user-data");
  mkdirSync(path.join(userData, "User"), { recursive: true });
  writeFileSync(path.join(userData, "User/settings.json"), JSON.stringify(SETTINGS));
  const app = await _electron.launch({
    executablePath: await downloadAndUnzipVSCode(),
    env: { ...(process.env as Record<string, string>), ...scratch.env },
    args: [
      scratch.repo,
      path.join(scratch.repo, "sample.py"),
      `--extensionDevelopmentPath=${extension}`,
      `--extensionDevelopmentPath=${competitor}`,
      `--user-data-dir=${userData}`,
      `--extensions-dir=${path.join(scratch.dir, "extensions")}`,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--new-window",
    ],
  });
  const page = await app.firstWindow();
  const window = new Window(app, page, scratch.repo);
  await page.locator(".monaco-editor .view-lines").first().waitFor({ timeout: 60_000 });
  await page.locator(".monaco-editor .view-lines").first().click({ position: { x: 40, y: 8 } });
  await window.command("Toggle AI Comment Overlay");
  await window.shows("retries are safe: ledger write is idempotent");
  return window;
}

const TESTS: Record<string, (w: Window) => Promise<void>> = {
  "a line highlighted without its indentation, cut and pasted, moves its comments past another paste provider": async (w) => {
    const before = w.sidecar();
    // `ledger.write(order.id)` carries an own-line and a trailing comment.
    await w.goto(5);
    await w.keys("Home", "Shift+End", "Control+X");
    await w.goto(18);
    await w.keys("Home", "Control+V");
    await waitFor("the sidecar to change", () => w.sidecar() !== before);
    await w.keys("Control+S");
    await waitFor("the file to be saved", () => w.read("sample.py").includes("def audit(order):\n    ledger.write(order.id)\n"));
    const sidecar = w.sidecar();
    assert.doesNotMatch(sidecar, /copied-from/);
    assert.match(sidecar, /## 1kjy\n<!-- [^\n]*scope=audit /);
    assert.match(sidecar, /## f7eo\n<!-- [^\n]*pos=trail scope=audit /);
  },

  "Ctrl+Z in the source file undoes a comment edited in its thread": async (w) => {
    const original = "retries are safe: ledger write is idempotent";
    await w.page.locator(".codelens-decoration a", { hasText: original }).click();
    const thread = w.page.locator(".review-widget", { hasText: original });
    await thread.locator(".action-label.codicon-edit").click();
    await thread.locator(".edit-container .monaco-editor .view-lines").click();
    await w.keys("Control+A");
    await w.page.keyboard.type("an edited body");
    await thread.locator(".monaco-button", { hasText: "Save AI Comment" }).click();
    await waitFor("the edit in the sidecar", () => w.sidecar().includes("an edited body"));

    await w.page.locator(".monaco-editor .view-lines").first().click({ position: { x: 40, y: 8 } });
    await w.keys("Control+Z");
    await w.page.locator(".monaco-dialog-box .monaco-button", { hasText: /Undo in \d+ Files/ }).click({ timeout: 5_000 });
    await w.command("File: Save All");
    await waitFor("the original body back in the sidecar", () => w.sidecar().includes(original) && !w.sidecar().includes("an edited body"));
  },
};

const only = process.argv[2];
let failed = 0;
for (const [name, test] of Object.entries(TESTS)) {
  if (only && !name.includes(only)) continue;
  const scratch = scratchRepo((repo) => cpSync(path.join(packageRoot, "e2e/fixture-markerless"), repo, { recursive: true }), ["--markerless"]);
  let window: Window | undefined;
  try {
    window = await launch(scratch);
    await test(window);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : String(error)}`);
    if (window) {
      mkdirSync(failures, { recursive: true });
      const shot = path.join(failures, `${Object.keys(TESTS).indexOf(name)}.png`);
      await window.page.screenshot({ path: shot }).catch(() => undefined);
      console.log(`    screenshot: ${shot}`);
    }
  } finally {
    await window?.app.close().catch(() => undefined);
    rmSync(scratch.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
console.log(failed ? `${failed} native test(s) failed` : "native tests passed");
process.exitCode = failed ? 1 : 0;
