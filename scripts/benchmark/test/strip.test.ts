import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { findPython, STRIP_SCRIPT } from "../prepare.ts";

const python = findPython();

function strip(source: string): { status: number | null; stdout: string } {
  const result = spawnSync(python!, [STRIP_SCRIPT, "-"], { input: source, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout };
}

describe.skipIf(!python)("strip_comments.py", () => {
  it("deletes own-line comments whole and trims trailing ones", () => {
    const source = "# header\nx = 1  # why\n    \ndef f():\n    # note\n    return x # tail\n";

    expect(strip(source).stdout).toBe("x = 1\n    \ndef f():\n    return x\n");
  });

  it("keeps the functional comments", () => {
    const source = [
      "#!/usr/bin/env python",
      "# -*- coding: utf-8 -*-",
      "import a  # noqa: F401",
      "b: int = f()  # type: ignore[assignment]",
      "if x:  # pragma: no cover",
      "    pass",
      "# fmt: off",
      "y = [1,2]",
      "# fmt: on",
      "import c  # pylint: disable=unused-import",
      "d = g()  # pyright: ignore[reportGeneralTypeIssues]",
      "# mypy: ignore-errors",
      "import e  # isort: skip",
      "# ruff: noqa: E501",
      "h = run(cmd)  # nosec",
      "z = []  # type: List[int]",
      "import f  # NOQA: F401",
      "k = h()  # pyre-ignore[16]",
      "# yapf: disable",
      "# autopep8: off",
      "",
    ].join("\n");

    expect(strip(source).stdout).toBe(source);
  });

  it("keeps a byte-order mark and strips the source after it", () => {
    expect(strip("\ufeff# c\nx = 1  # d\n").stdout).toBe("\ufeffx = 1\n");
  });

  it("reads a lone carriage return as a line end, as Python does", () => {
    expect(strip("x = 1\r# c\ny = 2  # d\n").stdout).toBe("x = 1\ry = 2\n");
  });

  it("leaves a # inside strings and docstrings alone", () => {
    const source = 'def f():\n    """# not a comment"""\n    return "a # b"  # real\n';

    expect(strip(source).stdout).toBe('def f():\n    """# not a comment"""\n    return "a # b"\n');
  });

  it("keeps each line's terminator", () => {
    expect(strip("# c\r\nx = 1  # d\r\ny = 2\r\n").stdout).toBe("x = 1\r\ny = 2\r\n");
  });

  it("removes a comment line inside a bracketed expression", () => {
    const source = "x = [\n    1,  # one\n    # two\n    2,\n]\n";

    expect(strip(source).stdout).toBe("x = [\n    1,\n    2,\n]\n");
  });

  it("fails on source it cannot parse, writing nothing", () => {
    const result = strip("def (:\n  # c\n");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
