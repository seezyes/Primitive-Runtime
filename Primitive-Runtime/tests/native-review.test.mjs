import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NativeSession,
  POLICY_REVISION,
} from "../dist/runtime/src/engine/native.js";
import { hash } from "../dist/runtime/src/util.js";

test(
  "native bridge keeps a valid long conversation after more than 32 MiB of cumulative replies",
  { timeout: 20000 },
  async () => {
    const binary = fileURLToPath(
      new URL(
        "../engine/jcode/modified/primitive/target/release/jcode-primitive" +
          (process.platform === "win32" ? ".exe" : ""),
        import.meta.url,
      ),
    );
    const session = new NativeSession(
      { binary, sha256: hash(readFileSync(binary)) },
      "long-conversation",
      {
        run_id: "long-conversation-run",
        role: "primitive",
        artifact_path: "file.txt",
        allowed_dependencies: [],
        execution_generation: 1,
        policy_revision: POLICY_REVISION,
        max_tool_calls: 64,
        max_payload_bytes: 16 * 1024 * 1024,
      },
      new AbortController().signal,
    );
    const state = { artifact_hash: null, artifact_version: 0, inbox_cursor: 0 };
    let cumulative = 0;
    try {
      await session.initialize(state);
      // The same native-owned context appears in each provider request. Its
      // lifetime traffic can exceed 32 MiB while every frame and snapshot stays
      // well below its own bound. No network or model endpoint is involved.
      await session.beginTurn(
        "Restricted primitive policy.",
        "x".repeat(2 * 1024 * 1024),
      );
      for (let turn = 0; turn < 20; turn++) {
        const request = await session.requestTurn();
        const bytes = Buffer.byteLength(JSON.stringify(request));
        assert.ok(
          bytes < 3 * 1024 * 1024,
          "each request remains far below the 20 MiB frame cap",
        );
        cumulative += bytes;
        const id = "read-" + turn;
        const calls = await session.respondTurn(
          request.request_id,
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id,
                type: "function",
                function: { name: "read_self", arguments: "{}" },
              },
            ],
          },
          "tool_calls",
        );
        assert.equal(calls[0].id, id);
        await session.authorize(id, "read_self", {});
        await session.complete(
          id,
          { content: null, artifact_version: 0 },
          false,
          state,
        );
      }
      assert.ok(
        cumulative > 32 * 1024 * 1024,
        "regression must cross the previous lifetime-output cap",
      );
      const request = await session.requestTurn();
      const finish = { artifact_version: 0, inbox_cursor: 0 };
      await session.respondTurn(
        request.request_id,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "finish",
              type: "function",
              function: { name: "finish", arguments: JSON.stringify(finish) },
            },
          ],
        },
        "tool_calls",
      );
      await session.authorize("finish", "finish", finish);
      await session.complete("finish", { accepted: true }, false, state);
      const snapshot = await session.snapshot();
      assert.equal(snapshot.finished, true);
      assert.equal(snapshot.conversation.core.phase, "finished");
    } finally {
      await session.close();
    }
  },
);
