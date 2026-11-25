// Turns a provider's SSE stream into the plain answer text. OpenAI-compatible providers send
// `choices[0].delta.content`; Workers AI models without that format send `response`.
export function sseToText(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let buffer = "";

  return body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(
      new TransformStream<string, string>({
        transform(chunk, controller) {
          buffer += chunk;
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) emitLine(line, controller);
        },
        flush(controller) {
          emitLine(buffer, controller);
        },
      }),
    )
    .pipeThrough(new TextEncoderStream());
}

function emitLine(line: string, controller: TransformStreamDefaultController<string>) {
  if (!line.startsWith("data:")) return;
  const data = line.slice("data:".length).trim();
  if (data === "" || data === "[DONE]") return;

  const event = JSON.parse(data);
  // OpenRouter reports failures after the stream started as an error event.
  if (event.error) throw new Error(`Stream error: ${JSON.stringify(event.error).slice(0, 200)}`);
  const text = event.choices?.[0]?.delta?.content ?? event.response;
  if (typeof text === "string" && text !== "") controller.enqueue(text);
}
