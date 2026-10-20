import { createServer } from "node:http";
import { once } from "node:events";

export const PEER_MESSAGE =
  "Interface changed: value() returns {answer:number}.\nUse the .answer field; preserve this literal requirement — π.";
const NEW_PRODUCER = "exports.value=()=>({answer:42});\n";
const NEW_CONSUMER =
  "const {value}=require('./z-producer.cjs');\nexports.result=()=>value().answer;\n";

function latestContext(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    try {
      const value = JSON.parse(messages[i].content);
      if (value.task) return { value, index: i };
    } catch {
      /* protocol user text */
    }
  }
  throw new Error("Scripted role request has no structured task context");
}
function completed(messages, index) {
  const calls = new Map();
  const results = [];
  for (const message of messages.slice(index + 1)) {
    for (const call of message.tool_calls ?? [])
      calls.set(call.id, call.function.name);
    if (message.role === "tool")
      results.push({
        name: calls.get(message.tool_call_id),
        value: JSON.parse(message.content),
      });
  }
  return results;
}

export class ScriptedProvider {
  calls = [];
  errors = [];
  held = [];
  activations = new Map();
  seq = 0;
  onSnapshot;
  async start() {
    this.server = createServer(async (req, res) => {
      try {
        if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        this.calls.push(body);
        const reply = (message) => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "fixture-" + ++this.seq,
              object: "chat.completion",
              model: "resolved-" + body.model,
              choices: [
                {
                  index: 0,
                  finish_reason: message.tool_calls ? "tool_calls" : "stop",
                  message: { role: "assistant", content: null, ...message },
                },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: Math.min(10, body.max_tokens),
              },
            }),
          );
        };
        const call = (name, args) => ({
          tool_calls: [
            {
              id: "call-" + ++this.seq,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (body.tool_choice?.function?.name === "capability_probe") {
          const nonce = body.messages[0].content.match(
            /nonce: ([A-Za-z0-9_-]+)/,
          )?.[1];
          if (!nonce) throw new Error("Missing compatibility nonce");
          reply(call("capability_probe", { nonce }));
          return;
        }
        if (body.tools?.some((t) => t.function.name === "capability_probe")) {
          const observation = body.messages.findLast(
            (message) => message.role === "tool",
          );
          reply({ content: JSON.parse(observation.content).acknowledgement });
          return;
        }
        if (body.max_tokens === 1) {
          reply({ content: "OK" });
          return;
        }
        const { value: context, index } = latestContext(body.messages);
        const role = body.tools.some((t) => t.function.name === "submit_plan")
          ? "activator"
          : body.tools.some((t) => t.function.name === "submit_diagnosis")
            ? "diagnosis"
            : "primitive";
        const effects = completed(body.messages, index);
        if (
          role === "primitive" &&
          /hold-|crash-|conflict-/.test(context.task) &&
          !this.held.some((item) => item.task === context.task)
        ) {
          const pending = {
            task: context.task,
            body,
            aborted: false,
            release: () => reply(this.answer(role, context, effects, call)),
          };
          res.once("close", () => {
            if (!res.writableEnded) pending.aborted = true;
          });
          this.held.push(pending);
          return;
        }
        reply(this.answer(role, context, effects, call));
      } catch (error) {
        this.errors.push(error);
        if (!res.destroyed)
          res.writeHead(500).end(JSON.stringify({ error: error.message }));
      }
    });
    this.server.listen(0, "127.0.0.1");
    await once(this.server, "listening");
    this.url = `http://127.0.0.1:${this.server.address().port}/v1`;
  }
  answer(role, context, effects, call) {
    if (role === "activator") {
      if (!effects.some((effect) => effect.name === "read_file"))
        return call("read_file", { path: "z-producer.cjs" });
      const round = (this.activations.get(context.task) ?? 0) + 1;
      this.activations.set(context.task, round);
      const assignments = context.task.includes("cooperate")
        ? [
            {
              path: "a-consumer.cjs",
              objective: "Wait for the producer interface requirement",
              dependencies: ["z-producer.cjs"],
            },
            {
              path: "z-producer.cjs",
              objective: "Change the interface and notify the consumer",
              dependencies: ["a-consumer.cjs"],
            },
          ]
        : [
            {
              path: "z-producer.cjs",
              objective: "round-" + round,
              dependencies: [],
            },
          ];
      return call("submit_plan", {
        assignments,
        summary: "Artifact-local scripted acceptance plan",
      });
    }
    if (role === "diagnosis")
      return call("submit_diagnosis", {
        verdict: "pass",
        evidence: [
          "Fixture deliberately returns PASS; deterministic check outcomes remain authoritative.",
        ],
        causes: [],
        guidance: [],
        summary: "A model verdict cannot override execution evidence",
      });
    const own = [...effects]
      .reverse()
      .find(
        (effect) =>
          effect.name === "propose_patch" && effect.value.hash !== undefined,
      )?.value ?? {
      hash: context.artifact_hash,
      artifact_version: context.artifact_version,
    };
    const finish = () =>
      call("finish", {
        artifact_version: own.artifact_version,
        inbox_cursor: context.inbox_cursor,
      });
    if (context.task.includes("cooperate")) {
      if (context.artifact === "a-consumer.cjs" && !context.messages.length)
        return finish();
      if (!effects.some((effect) => effect.name === "read_self"))
        return call("read_self", {});
      if (
        context.artifact === "a-consumer.cjs" &&
        !effects.some((effect) => effect.name === "read_dependency")
      )
        return call("read_dependency", { path: "z-producer.cjs" });
      if (!effects.some((effect) => effect.name === "propose_patch"))
        return call("propose_patch", {
          expected_hash: own.hash,
          expected_version: own.artifact_version,
          content:
            context.artifact === "z-producer.cjs" ? NEW_PRODUCER : NEW_CONSUMER,
        });
      if (
        context.artifact === "z-producer.cjs" &&
        !effects.some((effect) => effect.name === "send_message")
      ) {
        const peer = context.peers.find(
          (peer) => peer.path === "a-consumer.cjs",
        );
        return call("send_message", {
          recipient_id: peer.primitive_id,
          type: "interface",
          payload: PEER_MESSAGE,
        });
      }
      return finish();
    }
    if (!effects.some((effect) => effect.name === "read_self"))
      return call("read_self", {});
    const shouldRepair = context.task.includes("repair-on-fourth")
      ? context.objective === "round-4"
      : context.task.includes("repair");
    if (
      shouldRepair &&
      !effects.some((effect) => effect.name === "propose_patch")
    )
      return call("propose_patch", {
        expected_hash: own.hash,
        expected_version: own.artifact_version,
        content: "exports.value=()=>42;\n",
      });
    return finish();
  }
  async close() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
