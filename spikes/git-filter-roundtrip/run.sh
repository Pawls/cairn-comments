#!/usr/bin/env bash
# Spike: prove marker + clean/smudge + sidecar round trip with per-worktree smudge.
set -u
HERE="$(cd "$(dirname "$0")" && pwd -W 2>/dev/null || pwd)"
FILTER="$HERE/filter.js"
ROOT="$HERE/work"
rm -rf "$ROOT"; mkdir -p "$ROOT/main"; cd "$ROOT/main"

say() { echo; echo "##### $*"; }

git init -q -b main .
git config user.email spike@example.com; git config user.name spike
git config extensions.worktreeConfig true
# This machine sets a global core.hooksPath; point back at the repo hooks for the spike.
git config core.hooksPath "$ROOT/main/.git/hooks"
git config filter.tn.clean "node \"$FILTER\" clean %f"
echo "*.py filter=tn" > .gitattributes
mkdir -p src
printf 'def settle(order):\n    ledger.write(order.id)\n    notify(order)\n' > src/settle.py

cat > .git/hooks/pre-commit <<EOF
#!/usr/bin/env bash
for f in \$(git diff --cached --name-only --diff-filter=ACM -- '*.py'); do
  node "$FILTER" sync "\$f" && git add ".agents/comments/\$f.md"
done
EOF
chmod +x .git/hooks/pre-commit
git add -A; git commit -qm "base"; echo "autocrlf=$(git config core.autocrlf)"

say "1. agent worktree with smudge enabled only there"
git worktree add -q ../wt1 -b agent
git -C ../wt1 config --worktree filter.tn.smudge "node \"$FILTER\" smudge %f"
cd ../wt1
printf 'def settle(order):\n    #~ retries are safe: ledger write is idempotent\n    ledger.write(order.id)  #~ keyed on order.id\n    notify(order)\n' > src/settle.py

say "2. git diff in agent worktree (expect bare markers only)"
git diff --no-color | grep '^[+-]' | grep -v '^+++\|^---'

say "3. commit -am through pre-commit sync"
git commit -qam "agent adds comments"; git status --short; echo "status-exit-clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
echo "--- blob:"; git show HEAD:src/settle.py
echo "--- working file:"; cat src/settle.py
echo "--- sidecar in commit:"; git show HEAD:.agents/comments/src/settle.py.md
echo "--- files in commit:"; git show --stat --format= HEAD

say "4. merge into main (no smudge): expect bare markers on disk"
cd ../main; git merge -q agent; cat src/settle.py; git ls-files --eol src/settle.py

say "5. fresh worktree: --no-checkout, set smudge, then checkout"
git worktree add -q --no-checkout ../wt2 -b agent2
git -C ../wt2 config --worktree filter.tn.smudge "node \"$FILTER\" smudge %f"
cd ../wt2; git checkout -q -f HEAD -- . 2>&1; git reset -q --hard 2>&1
cat src/settle.py; git ls-files --eol src/settle.py
echo "status-clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"

say "6. body-only edit: does git notice?"
node -e '
const fs=require("fs");const p="src/settle.py";const s=fs.readFileSync(p,"utf8");
fs.writeFileSync(p,s.replace("retries are safe","RETRIES ARE SAFE"));'
echo "porcelain=[$(git status --porcelain)]"
node "$FILTER" sync src/settle.py
echo "after sync porcelain=[$(git status --porcelain)]"

say "7. branch switch in smudged worktree pulls bodies that arrive in the same checkout"
git stash -q 2>/dev/null; git checkout -q --detach main~1 2>&1; echo "at base:"; cat src/settle.py
git checkout -q agent2 2>&1; echo "back on agent2:"; cat src/settle.py

say "8. rebase/cherry-pick sanity: cherry-pick agent commit onto base in a new smudged worktree"
cd ../main
git worktree add -q --no-checkout ../wt3 -b agent3 main~1
git -C ../wt3 config --worktree filter.tn.smudge "node \"$FILTER\" smudge %f"
cd ../wt3; git reset -q --hard; git cherry-pick agent >/dev/null 2>&1; echo "cherry-pick exit=$?"
cat src/settle.py; echo "status-clean=$([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
