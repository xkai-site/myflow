import assert from "node:assert/strict";
import test from "node:test";
import extension from "../extensions/index.ts";

test("registers only the /usage-openai command and no model provider", () => {
  const commands: string[] = [];
  const api = {
    registerCommand(name: string) { commands.push(name); },
    registerProvider() { assert.fail("usage-only extension must not register a model provider"); },
  };

  extension(api as never);
  assert.deepEqual(commands, ["usage-openai"]);
});
