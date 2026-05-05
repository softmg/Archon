git fetch upstream --tags

git switch vendor/dev
git reset --hard upstream/dev
git push --force-with-lease origin vendor/dev

git switch -c sync/upstream-$(date +%Y-%m-%d) internal/main
git merge --no-ff vendor/dev

bun install
bun run validate
