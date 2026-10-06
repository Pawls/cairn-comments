import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./harness.js";

const SOURCE = "src/settle.py";
const SIDECAR = ".agents/comments/src/settle.py.md";
const NOTE = "retries are safe: ledger write is idempotent";
const commented = (call: string) => `def settle(order):\n    #~ ${NOTE}\n    ledger.write(order.id)\n    ${call}\n`;

describe.each([true, false])("staleness through git (autocrlf=%s)", (autocrlf) => {
  let box: Sandbox;
  let main: string;
  let wt: string;
  let id: string;

  beforeAll(() => {
    box = new Sandbox({ autocrlf });
    main = box.path("main");
    wt = box.path("wt");
    box.write(box.path("main", SOURCE), commented("notify(order)"));
    box.git(box.dir, "init", "-q", "main");
    box.cli(main, "init");
    box.git(main, "add", "-A");
    box.git(main, "commit", "-qm", "base");
    box.cli(main, "collapse");
    id = /^## ([0-9a-z]{4})$/m.exec(box.read(box.path("main", SIDECAR)))![1]!;
  });
  afterAll(() => box.dispose());

  const check = (cwd: string, ...args: string[]) => box.cliResult(cwd, "check", "--stale", ...args);

  it("records where the comment goes when the body is written", () => {
    expect(box.read(box.path("main", SOURCE))).toBe(
      "def settle(order):\n    ledger.write(order.id)\n    notify(order)\n",
    );
    expect(readFileSync(box.path("main", SIDECAR), "utf8")).toMatch(
      new RegExp(`^## ${id}\\n<!-- pos=before scope=settle body=[0-9a-f]{8} [^\\n]*-->\\n${NOTE}\\n$`),
    );
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
  });

  it("does not flag a whitespace-only change", () => {
    const file = box.path("main", SOURCE);
    box.write(file, box.read(file).replace("ledger.write(order.id)", "ledger.write( order.id )  "));
    expect(check(main)).toMatchObject({ status: 0, stdout: "" });
    box.git(main, "checkout", "--", SOURCE);
  });

  it("flags a real change to the function around the comment and exits 1", () => {
    const file = box.path("main", SOURCE);
    box.write(file, box.read(file).replace("notify(order)", "notify(order, now)"));
    // The owner's checkout shows no comments, so the line is that of the code it goes above.
    expect(check(main)).toMatchObject({ status: 1, stdout: `${SOURCE}:2: ${id} [stale?] ${NOTE}\n` });
    expect(JSON.parse(check(main, "--json").stdout)).toEqual([{ file: SOURCE, line: 2, id, text: NOTE }]);
    // The owner never had the comment in view, so nothing re-records it: the flag survives a commit.
    box.git(main, "commit", "-qam", "notify now");
    expect(box.status(main)).toBe("");
    expect(check(main).status).toBe(1);
  });

  it("an agent worktree shows the tag, and git still sees a clean tree", () => {
    box.cli(main, "worktree", "add", wt);
    expect(box.read(box.path("wt", SOURCE))).toBe(
      `def settle(order):\n    #~${id} [stale?] ${NOTE}\n    ledger.write(order.id)\n    notify(order, now)\n`,
    );
    expect(box.status(wt)).toBe("");
    expect(box.git(wt, "show", `HEAD:${SOURCE}`)).not.toContain("[stale?]");
  });

  it("confirm clears the flag, removes the tag, and changes only the sidecar", () => {
    expect(box.cli(wt, "confirm", id)).toBe(`confirmed ${id} in ${SOURCE}\n`);
    expect(box.read(box.path("wt", SOURCE))).toBe(
      `def settle(order):\n    #~${id} ${NOTE}\n    ledger.write(order.id)\n    notify(order, now)\n`,
    );
    expect(box.status(wt)).toBe(` M ${SIDECAR}\n`);
    expect(check(wt)).toMatchObject({ status: 0, stdout: "" });
    expect(box.cliResult(wt, "confirm", "zz99")).toMatchObject({ status: 1, stderr: "cairn: no comment zz99\n" });
  });
});
