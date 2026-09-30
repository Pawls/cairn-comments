/** Git's pkt-line framing (gitprotocol-common): a 4-hex-digit length that counts itself. */
export const MAX_PACKET_DATA = 65516;
export const FLUSH = Buffer.from("0000");

function packet(data: Buffer): Buffer {
  return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, "0")), data]);
}

export function textPacket(line: string): Buffer {
  return packet(Buffer.from(line + "\n", "utf8"));
}

/** Content split into maximal packets; empty content is zero packets. */
export function contentPackets(content: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  for (let i = 0; i < content.length; i += MAX_PACKET_DATA) packets.push(packet(content.subarray(i, i + MAX_PACKET_DATA)));
  return packets;
}

export class PacketReader {
  private buffered: Buffer = Buffer.alloc(0);
  private readonly source: AsyncIterator<Buffer | string>;

  constructor(input: AsyncIterable<Buffer | string>) {
    this.source = input[Symbol.asyncIterator]();
  }

  private async fill(n: number): Promise<boolean> {
    while (this.buffered.length < n) {
      const next = await this.source.next();
      if (next.done) return false;
      const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
      this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    }
    return true;
  }

  private take(n: number): Buffer {
    const out = this.buffered.subarray(0, n);
    this.buffered = this.buffered.subarray(n);
    return out;
  }

  /** A packet's payload, `null` for a flush, or `undefined` when input ends between packets. */
  async read(): Promise<Buffer | null | undefined> {
    if (!(await this.fill(4))) {
      if (!this.buffered.length) return undefined;
      throw new Error("input ended inside a packet header");
    }
    const header = this.take(4).toString("latin1");
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`malformed packet header ${JSON.stringify(header)}`);
    const size = parseInt(header, 16);
    if (size === 0) return null;
    if (size < 4) throw new Error(`unexpected special packet ${header}`);
    if (!(await this.fill(size - 4))) throw new Error("input ended inside a packet");
    return this.take(size - 4);
  }

  /** Text packets up to a flush, trailing newline removed; `undefined` at a clean end of input. */
  async readList(): Promise<string[] | undefined> {
    const lines: string[] = [];
    for (;;) {
      const data = await this.read();
      if (data === undefined) {
        if (lines.length) throw new Error("input ended inside a packet list");
        return undefined;
      }
      if (data === null) return lines;
      const text = data.toString("utf8");
      lines.push(text.endsWith("\n") ? text.slice(0, -1) : text);
    }
  }

  /** Binary packets up to a flush, concatenated. */
  async readContent(): Promise<Buffer> {
    const parts: Buffer[] = [];
    for (;;) {
      const data = await this.read();
      if (data === undefined) throw new Error("input ended inside file content");
      if (data === null) return Buffer.concat(parts);
      parts.push(data);
    }
  }
}
