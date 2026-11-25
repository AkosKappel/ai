// Turns an OpenAI-compatible SSE stream into the plain answer text.
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

  const text = JSON.parse(data).choices?.[0]?.delta?.content;
  if (typeof text === "string" && text !== "") controller.enqueue(text);
}
