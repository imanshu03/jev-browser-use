import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CdpError, connectPipe } from "../../src/fast/cdp.js";

/** A fake Chrome child: fd 3 is what we write, fd 4 is what Chrome writes. */
function fakeChild() {
  const input = new PassThrough();
  const output = new PassThrough();
  const emitter = new EventEmitter();
  const sent: Record<string, unknown>[] = [];
  let pending = Buffer.alloc(0);
  input.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(0)) >= 0) {
      sent.push(JSON.parse(pending.subarray(0, end).toString("utf8")) as Record<string, unknown>);
      pending = pending.subarray(end + 1);
    }
  });
  const child = Object.assign(emitter, { stdio: [null, null, null, input, output], pid: 4242 }) as unknown as ChildProcess;
  const reply = (msg: unknown) => output.write(Buffer.concat([Buffer.from(JSON.stringify(msg), "utf8"), Buffer.from([0])]));
  const tick = () => new Promise<void>((r) => setImmediate(r));
  return { child, input, output, sent, reply, tick, emitter };
}

describe("connectPipe", () => {
  it("frames NUL-terminated JSON and matches ids out of order", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const a = client.send("A.one", { x: 1 });
    const b = client.send("B.two", {}, "sess-1");
    await f.tick();
    expect(f.sent).toEqual([
      { id: 1, method: "A.one", params: { x: 1 } },
      { id: 2, method: "B.two", params: {}, sessionId: "sess-1" },
    ]);
    f.reply({ id: 2, result: { two: true } });
    f.reply({ id: 1, result: { one: true } });
    expect(await b).toEqual({ two: true });
    expect(await a).toEqual({ one: true });
    await client.close();
  });

  it("survives a frame split across chunks, including inside a multi-byte character", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const p1 = client.send("X.y");
    const p2 = client.send("X.z");
    const frame = Buffer.concat([Buffer.from(JSON.stringify({ id: 1, result: { v: "café \u{1F600}" } }), "utf8"), Buffer.from([0])]);
    const cut = frame.indexOf(Buffer.from("é", "utf8")) + 1; // inside the two bytes of é
    f.output.write(frame.subarray(0, cut));
    await f.tick();
    f.output.write(Buffer.concat([frame.subarray(cut), Buffer.from('{"id":2,"res', "utf8")]));
    await f.tick();
    f.output.write(Buffer.concat([Buffer.from('ult":{"ok":1}}', "utf8"), Buffer.from([0])]));
    expect(await p1).toEqual({ v: "café \u{1F600}" });
    expect(await p2).toEqual({ ok: 1 });
    await client.close();
  });

  it("rejects a response with error as CdpError", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const p = client.send("Page.navigate", { url: "x" });
    await f.tick();
    f.reply({ id: 1, error: { code: -32000, message: "Cannot navigate" } });
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).method).toBe("Page.navigate");
    expect((err as CdpError).code).toBe(-32000);
    expect((err as CdpError).message).toBe("Cannot navigate");
    await client.close();
  });

  it("dispatches messages without id as events with the session id", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const got: { params: Record<string, unknown>; sessionId: string | undefined }[] = [];
    const off = client.on("Page.frameNavigated", (params, sessionId) => got.push({ params, sessionId }));
    f.reply({ method: "Page.frameNavigated", params: { frame: { id: "f1" } }, sessionId: "s9" });
    f.reply({ method: "Other.event", params: {} });
    await f.tick();
    expect(got).toEqual([{ params: { frame: { id: "f1" } }, sessionId: "s9" }]);
    off();
    f.reply({ method: "Page.frameNavigated", params: {} });
    await f.tick();
    expect(got).toHaveLength(1);
    await client.close();
  });

  it("times out a send that gets no reply", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child, { timeoutMs: 20 });
    const err = await client.send("Slow.call").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect((err as CdpError).message).toMatch(/^timeout/);
    expect((err as CdpError).method).toBe("Slow.call");
    expect(client.closed).toBe(false);
    await client.close();
  });

  it("rejects pending sends and marks closed when the read stream ends", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const p = client.send("Never.answered");
    await f.tick();
    f.output.end();
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpError);
    expect(client.closed).toBe(true);
    const again = await client.send("After.close").catch((e: unknown) => e);
    expect(again).toBeInstanceOf(CdpError);
    await client.close();
  });

  it("rejects pending sends when the child exits", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    const p = client.send("Never.answered");
    await f.tick();
    f.emitter.emit("exit", 1, null);
    const err = await p.catch((e: unknown) => e);
    expect((err as CdpError).message).toMatch(/chrome exited/);
    expect(client.closed).toBe(true);
  });

  it("close ends the write stream and is idempotent", async () => {
    const f = fakeChild();
    const client = connectPipe(f.child);
    await client.close();
    await client.close();
    expect(f.input.writableEnded).toBe(true);
    expect(client.closed).toBe(true);
  });
});
