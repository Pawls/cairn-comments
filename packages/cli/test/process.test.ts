import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentPackets, FLUSH, MAX_PACKET_DATA, PacketReader, textPacket } from "../src/pktline.js";
import { serveFilterProcess } from "../src/process.js";
import { CLI, Sandbox } from "./harness.js";

const GREETING = [textPacket("git-filter-client"), textPacket("version=2"), FLUSH];
const OFFER = [textPacket("capability=clean"), textPacket("capability=smudge"), textPacket("capability=delay"), FLUSH];

const LIST_AVAILABLE = [textPacket("command=list_available_blobs"), FLUSH];

function request(command: string, pathname: string, content: Buffer | string, extra: string[] = []): Buffer[] {
  const headers = [`command=${command}`, `pathname=${pathname}`, ...extra].map(textPacket);
  return [...headers, FLUSH, ...contentPackets(Buffer.from(content)), FLUSH];
}

/** Drives the server one exchange at a time, as git does. */
function session(options: { root: string; delayBudget?: number }) {
  const input = new PassThrough();
  const output = new PassThrough();
  const log: string[] = [];
  const done = serveFilterProcess(input, output, { ...options, smudge: true, log: (m) => log.push(m) });
  const reader = new PacketReader(output);
  return {
    log,
    reader,
    send: (packets: Buffer[]) => input.write(Buffer.concat(packets)),
    async finish() {
      input.end();
      await done;
    },
  };
}

/** A worktree root holding one sidecar, `src/a.py` → id ab12. */
function sidecarRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "tildenote-proc-"));
  mkdirSync(path.join(root, ".agents/comments/src"), { recursive: true });
  writeFileSync(path.join(root, ".agents/comments/src/a.py.md"), "## ab12\nwhy one\n");
  return root;
}

async function* chunked(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

interface Response {
  status: string;
  content?: Buffer;
}

/** Runs the server over `packets` and decodes everything it wrote. */
async function serve(packets: Buffer[], options: { smudge?: boolean; root?: string; chunk?: number } = {}) {
  const written: Buffer[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk);
      callback();
    },
  });
  const log: string[] = [];
  const input = Buffer.concat(packets);
  const done = serveFilterProcess(chunked(input, options.chunk ?? Math.max(input.length, 1)), output, {
    root: options.root ?? os.tmpdir(),
    smudge: options.smudge ?? false,
    log: (m) => log.push(m),
  });
  const error = await done.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
  const reader = new PacketReader(chunked(Buffer.concat(written), 1 << 20));
  const handshake = [await reader.readList(), await reader.readList()];
  const responses: Response[] = [];
  for (let status = await reader.readList(); status !== undefined; status = await reader.readList()) {
    const response: Response = { status: status.join() };
    if (response.status === "status=success") {
      response.content = await reader.readContent();
      expect(await reader.readList()).toEqual([]);
    }
    responses.push(response);
  }
  return { error, handshake, responses, log };
}

describe("filter process protocol", () => {
  it("answers the handshake and advertises clean only, unless smudge (and with it delay) is enabled", async () => {
    const plain = await serve([...GREETING, ...OFFER]);
    expect(plain.error).toBeUndefined();
    expect(plain.handshake).toEqual([["git-filter-server", "version=2"], ["capability=clean"]]);
    const smudging = await serve([...GREETING, ...OFFER], { smudge: true });
    expect(smudging.handshake[1]).toEqual(["capability=clean", "capability=smudge", "capability=delay"]);
  });

  it("never claims a capability git did not offer", async () => {
    const { handshake } = await serve([...GREETING, textPacket("capability=smudge"), FLUSH], { smudge: true });
    expect(handshake[1]).toEqual(["capability=smudge"]);
  });

  it("rejects a client that is not speaking version 2", async () => {
    const { error, handshake } = await serve([textPacket("git-filter-client"), textPacket("version=1"), FLUSH]);
    expect(error?.message).toMatch(/unexpected filter protocol greeting/);
    expect(handshake[0]).toBeUndefined();
  });

  it("cleans several files in one session, with CRLF and non-UTF-8 content passing through intact", async () => {
    const latin1 = Buffer.from([0x78, 0x20, 0x3d, 0x20, 0xe9, 0x0a]);
    const { responses } = await serve([
      ...GREETING,
      ...OFFER,
      ...request("clean", "a.py", "x = 1  #~ why one\r\n"),
      ...request("clean", "b.py", latin1),
      ...request("clean", "c.ts", "let y = 2; //~ why two\n"),
      ...request("clean", "empty.py", ""),
    ]);
    expect(responses.map((r) => r.status)).toEqual(Array(4).fill("status=success"));
    expect(responses[0]!.content!.toString()).toMatch(/^x = 1 {2}#~[0-9a-z]{4}\r\n$/);
    expect(responses[1]!.content).toEqual(latin1);
    expect(responses[2]!.content!.toString()).toMatch(/^let y = 2; \/\/~[0-9a-z]{4}\n$/);
    expect(responses[3]!.content).toEqual(Buffer.alloc(0));
  });

  it("reassembles content across packet and read boundaries in both directions", async () => {
    const body = "x = 1\n".repeat(Math.ceil((2.5 * MAX_PACKET_DATA) / 6));
    const source = `${body}y = 2  #~ at the end\n`;
    const { responses } = await serve([...GREETING, ...OFFER, ...request("clean", "big.py", source)], { chunk: 4099 });
    expect(responses).toHaveLength(1);
    const cleaned = responses[0]!.content!.toString();
    expect(cleaned.startsWith(body)).toBe(true);
    expect(cleaned.slice(body.length)).toMatch(/^y = 2 {2}#~[0-9a-z]{4}\n$/);
  });

  it("smudges from the sidecar under the worktree root", async () => {
    const root = sidecarRoot();
    try {
      const { responses } = await serve([...GREETING, ...OFFER, ...request("smudge", "src/a.py", "x = 1  #~ab12\n")], { smudge: true, root });
      expect(responses).toEqual([{ status: "status=success", content: Buffer.from("x = 1  #~ab12 why one\n") }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delays a smudge git allows to wait, lists it once ready, and hands it over on the re-request", async () => {
    const root = sidecarRoot();
    const s = session({ root });
    try {
      s.send([...GREETING, ...OFFER]);
      await s.reader.readList();
      expect(await s.reader.readList()).toEqual(["capability=clean", "capability=smudge", "capability=delay"]);
      s.send(request("smudge", "src/a.py", "x = 1  #~ab12\n", ["can-delay=1"]));
      expect(await s.reader.readList()).toEqual(["status=delayed"]);
      // A clean in between is answered in line.
      s.send(request("clean", "b.py", "y = 2\n"));
      expect(await s.reader.readList()).toEqual(["status=success"]);
      expect((await s.reader.readContent()).toString()).toBe("y = 2\n");
      expect(await s.reader.readList()).toEqual([]);
      s.send(LIST_AVAILABLE);
      expect(await s.reader.readList()).toEqual(["pathname=src/a.py"]);
      expect(await s.reader.readList()).toEqual(["status=success"]);
      s.send(request("smudge", "src/a.py", ""));
      expect(await s.reader.readList()).toEqual(["status=success"]);
      expect((await s.reader.readContent()).toString()).toBe("x = 1  #~ab12 why one\n");
      expect(await s.reader.readList()).toEqual([]);
      // Nothing outstanding: an empty list tells git to stop asking.
      s.send(LIST_AVAILABLE);
      expect(await s.reader.readList()).toEqual([]);
      expect(await s.reader.readList()).toEqual(["status=success"]);
      await s.finish();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers in line once delayed content would exceed the byte budget", async () => {
    const root = sidecarRoot();
    const s = session({ root, delayBudget: 0 });
    try {
      s.send([...GREETING, ...OFFER, ...request("smudge", "src/a.py", "x = 1  #~ab12\n", ["can-delay=1"])]);
      await s.reader.readList();
      await s.reader.readList();
      expect(await s.reader.readList()).toEqual(["status=success"]);
      expect((await s.reader.readContent()).toString()).toBe("x = 1  #~ab12 why one\n");
      await s.finish();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("hands back the unfiltered blob when a delayed smudge fails, since git would drop the file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "tildenote-proc-"));
    // A directory where the sidecar should be makes the read fail with something other than ENOENT.
    mkdirSync(path.join(root, ".agents/comments/a.py.md"), { recursive: true });
    const s = session({ root });
    try {
      s.send([...GREETING, ...OFFER, ...request("smudge", "a.py", "x = 1  #~ab12\n", ["can-delay=1"]), ...LIST_AVAILABLE]);
      await s.reader.readList();
      await s.reader.readList();
      expect(await s.reader.readList()).toEqual(["status=delayed"]);
      expect(await s.reader.readList()).toEqual(["pathname=a.py"]);
      expect(await s.reader.readList()).toEqual(["status=success"]);
      s.send(request("smudge", "a.py", ""));
      expect(await s.reader.readList()).toEqual(["status=success"]);
      expect((await s.reader.readContent()).toString()).toBe("x = 1  #~ab12\n");
      expect(s.log).toEqual([expect.stringMatching(/^a\.py: .*; checked out unfiltered$/)]);
      await s.finish();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("answers an unadvertised command with status=error and keeps serving", async () => {
    const { responses, log } = await serve([
      ...GREETING,
      ...OFFER,
      ...request("smudge", "a.py", "x = 1  #~ab12\n"),
      ...request("clean", "a.py", "x = 1\n"),
    ]);
    expect(responses).toEqual([{ status: "status=error" }, { status: "status=success", content: Buffer.from("x = 1\n") }]);
    expect(log).toEqual([expect.stringContaining("a.py: unsupported request")]);
  });

  it("fails without a partial answer when git's side ends inside a file", async () => {
    const whole = Buffer.concat(request("clean", "a.py", "x = 1  #~ why one\n"));
    const { error, responses } = await serve([...GREETING, ...OFFER, whole.subarray(0, whole.length - 10)]);
    expect(error?.message).toMatch(/input ended inside/);
    expect(responses).toEqual([]);
  });
});

/**
 * A filter that dies halfway through writing its answer for the second file it serves,
 * standing in for a crash mid-stream. Git starts a fresh process for the next file.
 */
function writeCrashingFilter(file: string): void {
  const process_ = pathToFileURL(path.join(path.dirname(CLI), "process.js")).href;
  writeFileSync(
    file,
    [
      'import { writeSync } from "node:fs";',
      'import { Writable } from "node:stream";',
      `import { serveFilterProcess } from ${JSON.stringify(process_)};`,
      "let writes = 0;",
      "const output = new Writable({",
      "  write(chunk, _encoding, callback) {",
      "    // Two handshake answers, then one write per file: die on the second file.",
      "    if (++writes === 4) { writeSync(1, chunk.subarray(0, chunk.length >> 1)); process.exit(3); }",
      "    writeSync(1, chunk);",
      "    callback();",
      "  },",
      "});",
      "const smudge = process.argv.includes('--smudge');",
      "await serveFilterProcess(process.stdin, output, { root: process.cwd(), smudge, log: (m) => process.stderr.write(m + '\\n') });",
      "",
    ].join("\n"),
  );
}

describe("a filter process crash mid-stream", () => {
  let box: Sandbox;
  let main: string;
  let crashing: string;
  const FILES = ["a.py", "b.py", "c.py"];

  beforeAll(() => {
    box = new Sandbox({ autocrlf: false });
    main = box.path("main");
    for (const f of FILES) box.write(box.path("main", f), `${f[0]} = 1  #~ why ${f[0]}\n`);
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    writeCrashingFilter(box.path("crash.mjs"));
    crashing = `"${process.execPath.replaceAll("\\", "/")}" "${box.path("crash.mjs").replaceAll("\\", "/")}"`;
  });
  afterAll(() => box.dispose());

  // Checkout delays smudges, and git treats a delayed path whose filter died as unfilterable:
  // the command fails and names each such path (design.md § Filter process).
  it("during checkout: git fails loudly, no file is a fragment, and rerunning the command recovers", () => {
    const wt = box.path("wt");
    box.git(main, "worktree", "add", "-q", "--no-checkout", wt);
    box.git(wt, "config", "--worktree", "filter.tildenote.smudge", "unused");
    box.git(wt, "config", "--worktree", "filter.tildenote.process", `${crashing} --smudge`);
    const result = box.gitResult(wt, "reset", "--hard", "--quiet");
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/^error: external filter '.*crash\.mjs" --smudge' failed$/m);
    expect(result.stderr).toMatch(/^error: 'a\.py' was not filtered properly$/m);
    for (const f of FILES) {
      const file = box.path("wt", f);
      if (!existsSync(file)) continue;
      const text = box.read(file);
      const whole = text === box.git(main, "show", `HEAD:${f}`) || new RegExp(`^${f[0]} = 1 {2}#~[0-9a-z]{4} why ${f[0]}\\n$`).test(text);
      expect(whole, `${f}: ${JSON.stringify(text)}`).toBe(true);
    }

    const real = box.git(main, "config", "--get", "filter.tildenote.process").trim();
    box.git(wt, "config", "--worktree", "filter.tildenote.process", `${real} --smudge`);
    box.git(wt, "reset", "--hard", "--quiet");
    for (const f of FILES) expect(box.read(box.path("wt", f))).toMatch(new RegExp(`^${f[0]} = 1 {2}#~[0-9a-z]{4} why ${f[0]}\\n$`));
    expect(box.status(wt)).toBe("");
  });

  it("during add: git names the failed filter and the index holds whole content, never a fragment", () => {
    for (const f of FILES) box.write(box.path("main", f), `${f[0]} = 2  #~ changed ${f[0]}\n`);
    box.git(main, "config", "filter.tildenote.process", crashing);
    try {
      const result = box.gitResult(main, "add", "-A");
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(/^error: external filter '.*crash\.mjs"' failed$/m);
      expect(box.git(main, "show", ":a.py")).toMatch(/^a = 2 {2}#~[0-9a-z]{4}\n$/);
      // Documented fallback (design.md § Filter process): unfiltered, whole, and caught by `check` (A9).
      expect(box.git(main, "show", ":b.py")).toBe("b = 2  #~ changed b\n");
      expect(box.git(main, "show", ":c.py")).toMatch(/^c = 2 {2}#~[0-9a-z]{4}\n$/);
    } finally {
      box.cli(main, "init");
    }
  });
});
