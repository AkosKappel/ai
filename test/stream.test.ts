import { describe, expect, it } from "vitest";
import { sseToText } from "../src/stream";

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });

const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("sseToText", () => {
  it("joins content deltas and skips other events", async () => {
    const body = streamOf(
      ": keep-alive\n\n",
      delta("Hello"),
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning: "hidden" } }] })}\n\n`,
      delta(", world"),
      "data: [DONE]\n\n",
    );
    expect(await new Response(sseToText(body)).text()).toBe("Hello, world");
  });

  it("handles events split across chunks and CRLF line endings", async () => {
    const event = delta("Ahoj").replaceAll("\n", "\r\n");
    const body = streamOf(
      event.slice(0, 10),
      event.slice(10, 25),
      event.slice(25),
      "data: [DONE]\r\n",
    );
    expect(await new Response(sseToText(body)).text()).toBe("Ahoj");
  });

  it("accepts a finish_reason as the end of the answer", async () => {
    const finish = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
    expect(await new Response(sseToText(streamOf(delta("Done"), finish))).text()).toBe("Done");
  });

  it("errors when the stream stops without finishing, as Gemini's sometimes does", async () => {
    const cutOff = new Response(sseToText(streamOf(delta("Ákos built a REST"))));
    await expect(cutOff.text()).rejects.toThrow("Stream ended before the answer was complete");
  });
});
