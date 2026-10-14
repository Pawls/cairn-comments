"""Removes the comments from Python source, keeping the ones tools read.

    strip_comments.py -        source on stdin, stripped source on stdout
    strip_comments.py <dir>    every .py file under <dir>, rewritten in place; a JSON
                               summary on stdout

A comment on its own line is deleted with its line; a trailing comment is cut off along
with the whitespace before it. Docstrings are not comments and stay. The result must parse
to the same tree as the input (compared with ast.dump), or nothing is written.
"""

import ast
import io
import json
import re
import sys
import tokenize
from pathlib import Path

# Shebang and encoding lines are checked by position in strip(); these are the rest.
# "type:" covers both "type: ignore" and PEP 484 type comments.
FUNCTIONAL = re.compile(r"#\s*(noqa\b|type:|pragma\b|fmt:|pylint:|pyright:|mypy:|isort:|ruff:|nosec\b)")
ENCODING_LINE = re.compile(r"#.*?coding[:=]\s*[-\w.]+")
SKIPPED_DIRS = {".git", ".venv", "node_modules", "__pycache__"}


def is_functional(text, row):
    if row == 1 and text.startswith("#!"):
        return True
    if row <= 2 and ENCODING_LINE.match(text):
        return True
    return FUNCTIONAL.match(text) is not None


def strip(source):
    """Returns `source` without its removable comments; raises if the tree would change."""
    # Lines with their terminators, split where tokenize splits: at "\r\n", "\n", or a lone "\r".
    lines = io.StringIO(source, newline="").readlines()
    comments = [
        token
        for token in tokenize.generate_tokens(iter(lines).__next__)
        if token.type == tokenize.COMMENT and not is_functional(token.string, token.start[0])
    ]
    deleted_rows = set()
    for token in comments:
        (row, col), (_, end) = token.start, token.end
        line = lines[row - 1]
        if line[:col].strip():
            lines[row - 1] = line[:col].rstrip(" \t") + line[end:]
        else:
            deleted_rows.add(row - 1)
    result = "".join(line for index, line in enumerate(lines) if index not in deleted_rows)
    if ast.dump(ast.parse(source)) != ast.dump(ast.parse(result)):
        raise ValueError("stripping the comments changed the syntax tree")
    return result


def strip_tree(root):
    summary = {"stripped": 0, "unchanged": 0, "skipped": {}}
    for path in sorted(Path(root).rglob("*.py")):
        if SKIPPED_DIRS.intersection(path.relative_to(root).parts):
            continue
        try:
            with open(path, encoding="utf-8", newline="") as handle:
                source = handle.read()
            result = strip(source)
        except (SyntaxError, ValueError, tokenize.TokenError, UnicodeDecodeError) as error:
            summary["skipped"][path.relative_to(root).as_posix()] = f"{type(error).__name__}: {error}"
            continue
        if result == source:
            summary["unchanged"] += 1
            continue
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(result)
        summary["stripped"] += 1
    return summary


def main(argv):
    if len(argv) != 2:
        sys.exit("usage: strip_comments.py - | <dir>")
    if argv[1] != "-":
        json.dump(strip_tree(argv[1]), sys.stdout)
        return
    source = sys.stdin.buffer.read().decode("utf-8")
    try:
        result = strip(source)
    except (SyntaxError, ValueError, tokenize.TokenError) as error:
        sys.exit(f"strip_comments: {error}")
    sys.stdout.buffer.write(result.encode("utf-8"))


if __name__ == "__main__":
    main(sys.argv)
