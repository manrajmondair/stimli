import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Python entrypoints compile", () => {
  const result = spawnSync(
    "python3",
    ["-m", "py_compile", "inference/tribe_modal.py", "backend/app/main.py", "backend/app/brain.py", "backend/app/extractor.py", "backend/app/storage.py"],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
