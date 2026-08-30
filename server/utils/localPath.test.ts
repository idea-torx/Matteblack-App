/**
 * Self-check for the local-file path guard. Run: `npx tsx server/utils/localPath.test.ts`
 * The point of this file is the traversal case — the blocklist is only worth
 * anything if it is applied after path.resolve().
 */
import assert from "node:assert/strict";
import { resolveLocalPath } from "./localPath.js";

const HOME = "/Users/tester";
const ok = (r: ReturnType<typeof resolveLocalPath>) => {
  assert.ok("path" in r, `expected pass, got: ${"error" in r ? r.error : "?"}`);
  return r.path;
};
const denied = (r: ReturnType<typeof resolveLocalPath>) => {
  assert.ok("error" in r, "expected refusal");
};

// Ordinary reads pass.
assert.equal(ok(resolveLocalPath("/Users/tester/brief.md", HOME)), "/Users/tester/brief.md");
assert.equal(ok(resolveLocalPath("~/notes/script.txt", HOME)), "/Users/tester/notes/script.txt");

// Relative and empty are refused — no implicit cwd.
denied(resolveLocalPath("brief.md", HOME));
denied(resolveLocalPath("", HOME));
denied(resolveLocalPath(undefined, HOME));

// Secrets are refused however they're spelled.
denied(resolveLocalPath("~/.ssh/id_rsa", HOME));
denied(resolveLocalPath("/Users/tester/.env", HOME));
denied(resolveLocalPath("/srv/app/.env.production", HOME));
denied(resolveLocalPath("~/.aws/credentials", HOME));

// The one that matters: traversal must be normalised BEFORE the blocklist runs,
// or every rule above is one `../` away from useless.
denied(resolveLocalPath("/Users/tester/project/../.ssh/id_ed25519", HOME));
denied(resolveLocalPath("~/work/../.env", HOME));

// A path that merely mentions a secret-ish word in a safe place still passes.
assert.equal(
  ok(resolveLocalPath("/Users/tester/docs/environment-setup.md", HOME)),
  "/Users/tester/docs/environment-setup.md",
);

console.log("localPath: all checks passed");
