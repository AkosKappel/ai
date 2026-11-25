// Turns a provider's SSE stream into the plain answer text. OpenAI-compatible providers send
// `choices[0].delta.content`; Workers AI models without that format send `response`.
//
// A complete stream ends with a `finish_reason` or `[DONE]`. Gemini's free tier sometimes closes
// the connection mid-answer without either (2 of 10 streams on 2026-11-25), so a stream that
// ends without them errors instead of passing half an answer off as the whole one.
export function sseToText(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let buffer = "";
  const state = { finished: false };

  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) emitLine(line, controller, state);
        },
        flush(controller) {
          emitLine(buffer, controller, state);
          if (!state.finished) throw new Error("Stream ended before the answer was complete");
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
}

function emitLine(
  line: string,
  controller: TransformStreamDefaultController<string>,
  state: { finished: boolean },
) {
  if (!line.startsWith("data:")) return;
  const data = line.slice("data:".length).trim();
  if (data === "") return;
  if (data === "[DONE]") {
    state.finished = true;
    return;
  }

  const event = JSON.parse(data);
  // OpenRouter reports failures after the stream started as an error event.
  if (event.error) throw new Error(`Stream error: ${JSON.stringify(event.error).slice(0, 200)}`);
  if (event.choices?.[0]?.finish_reason) state.finished = true;
  const text = event.choices?.[0]?.delta?.content ?? event.response;
  if (typeof text === "string" && text !== "") controller.enqueue(text);
}
