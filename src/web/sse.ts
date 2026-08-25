import type { IncomingMessage, ServerResponse } from "node:http";

export class SseHub {
  private readonly clients = new Set<ServerResponse>();
  private readonly heartbeat = setInterval(() => this.comment("keepalive"), 15_000);

  add(request: IncomingMessage, response: ServerResponse, initial?: unknown): void {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write("retry: 1500\n\n");
    this.clients.add(response);
    if (initial !== undefined) this.send(response, "status", initial);
    request.once("close", () => this.clients.delete(response));
  }

  publish(event: string, payload: unknown): void {
    for (const client of this.clients) this.send(client, event, payload);
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  private send(response: ServerResponse, event: string, payload: unknown): void {
    response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private comment(value: string): void {
    for (const client of this.clients) client.write(`: ${value}\n\n`);
  }
}
