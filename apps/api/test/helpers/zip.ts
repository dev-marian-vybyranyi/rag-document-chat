import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntrySpec {
  name: string;
  data?: Buffer | string;
  method?: 'deflate' | 'store';
  declaredSize?: number;
  encrypted?: boolean;
  symlink?: boolean;
}

const UTF8_NAME = 0x0800;
const ENCRYPTED = 0x0001;

export function buildZip(entries: Array<ZipEntrySpec | string>): Buffer {
  const specs = entries.map((e) => (typeof e === 'string' ? { name: e, data: `// ${e}\n` } : e));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const spec of specs) {
    const raw = Buffer.from(spec.data ?? '');
    const method = spec.method === 'store' ? 0 : 8;
    const stored = method === 0 ? raw : deflateRawSync(raw);
    const name = Buffer.from(spec.name, 'utf8');
    const flags = UTF8_NAME | (spec.encrypted ? ENCRYPTED : 0);
    const size = spec.declaredSize ?? raw.length;
    const checksum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((spec.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + stored.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(specs.length, 8);
  end.writeUInt16LE(specs.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}
