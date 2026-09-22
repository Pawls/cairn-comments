import type { Writable } from "node:stream";
import { filterContent } from "./files.js";
import { contentPackets, FLUSH, PacketReader, textPacket } from "./pktline.js";

export interface FilterProcessOptions {
  /** Worktree root; git starts the process there and sends root-relative paths. */
  root: string;
  /** Advertise smudge. Only agent worktrees set it, through their per-worktree config. */
  smudge: boolean;
  log: (message: string) => void;
  /** Most source bytes held for delayed smudges before answering synchronously again. */
  delayBudget?: number;
}

const DEFAULT_DELAY_BUDGET = 64 << 20;

function send(output: Writable, packets: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => output.write(Buffer.concat(packets), (err) => (err ? reject(err) : resolve())));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Smudges answered `status=delayed` run concurrently while git keeps writing other files,
 * which hides the per-file sidecar read (design.md § Filter process). A failed job hands
 * back the unfiltered blob, because git treats a delayed path that never arrives as
 * missing rather than falling back.
 */
class DelayedSmudges {
  private readonly jobs = new Map<string, { size: number; result: Promise<Buffer> }>();
  private readonly available: string[] = [];
  private unsettled = 0;
  private wake: (() => void) | undefined;
  held = 0;

  constructor(private readonly options: FilterProcessOptions) {}

  start(pathname: string, content: Buffer): void {
    this.held += content.length;
    this.unsettled++;
    const result = filterContent("smudge", this.options.root, pathname, content).catch((error: unknown) => {
      this.options.log(`${pathname}: ${describe(error)}; checked out unfiltered`);
      return content;
    });
    this.jobs.set(pathname, { size: content.length, result });
    void result.then(() => {
      this.unsettled--;
      this.available.push(pathname);
      this.wake?.();
    });
  }

  /** Paths ready to fetch, waiting for at least one; empty once nothing is outstanding. */
  async list(): Promise<string[]> {
    while (!this.available.length && this.unsettled) await new Promise<void>((resolve) => (this.wake = resolve));
    this.wake = undefined;
    return this.available.splice(0);
  }

  async take(pathname: string): Promise<Buffer | undefined> {
    const job = this.jobs.get(pathname);
    if (!job) return undefined;
    this.jobs.delete(pathname);
    this.held -= job.size;
    return job.result;
  }
}

/**
 * Git's long-running filter protocol, version 2 (gitattributes § Long Running Filter
 * Process). One process serves every file of a git command, so tree-sitter parsers stay
 * loaded. A failure on one file answers `status=error`, which makes git fall back to the
 * unfiltered content exactly as a failing one-shot filter does; a protocol violation ends
 * the process, and git reports the filter as failed.
 */
export async function serveFilterProcess(input: AsyncIterable<Buffer | string>, output: Writable, options: FilterProcessOptions): Promise<void> {
  const reader = new PacketReader(input);
  const welcome = await reader.readList();
  if (welcome?.[0] !== "git-filter-client" || !welcome.includes("version=2")) {
    throw new Error(`unexpected filter protocol greeting ${JSON.stringify(welcome)}`);
  }
  await send(output, [textPacket("git-filter-server"), textPacket("version=2"), FLUSH]);

  const offered = new Set(await reader.readList());
  const supported = (options.smudge ? ["clean", "smudge", "delay"] : ["clean"]).filter((c) => offered.has(`capability=${c}`));
  await send(output, [...supported.map((c) => textPacket(`capability=${c}`)), FLUSH]);
  const delayed = new DelayedSmudges(options);
  const delayBudget = options.delayBudget ?? DEFAULT_DELAY_BUDGET;

  for (;;) {
    const headers = await reader.readList();
    if (headers === undefined) return;
    const fields = new Map(headers.map((h) => [h.slice(0, h.indexOf("=")), h.slice(h.indexOf("=") + 1)]));
    const command = fields.get("command");
    if (command === "list_available_blobs" && supported.includes("delay")) {
      const paths = await delayed.list();
      await send(output, [...paths.map((p) => textPacket(`pathname=${p}`)), FLUSH, textPacket("status=success"), FLUSH]);
      continue;
    }
    const content = await reader.readContent();
    const pathname = fields.get("pathname");
    let result: Buffer;
    try {
      if (!pathname || (command !== "clean" && command !== "smudge") || !supported.includes(command)) {
        throw new Error(`unsupported request ${JSON.stringify(headers)}`);
      }
      const earlier = command === "smudge" ? await delayed.take(pathname) : undefined;
      if (earlier) {
        result = earlier;
      } else if (command === "smudge" && fields.get("can-delay") === "1" && delayed.held + content.length <= delayBudget) {
        delayed.start(pathname, content);
        await send(output, [textPacket("status=delayed"), FLUSH]);
        continue;
      } else {
        result = await filterContent(command, options.root, pathname, content);
      }
    } catch (error) {
      options.log(`${pathname ?? "?"}: ${describe(error)}`);
      await send(output, [textPacket("status=error"), FLUSH]);
      continue;
    }
    // The trailing empty list keeps status=success.
    await send(output, [textPacket("status=success"), FLUSH, ...contentPackets(result), FLUSH, FLUSH]);
  }
}
