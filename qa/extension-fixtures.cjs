const { crc32, deflateRawSync } = require('node:zlib');

const manifestName = 'extension.json';

function manifest(contributes = { snippets: [{ id: 'say-hello', language: 'javascript', prefix: 'hi', body: 'console.log("hello")\n' }] }) {
  return {
    schemaVersion: 1, id: 'org.cevra.hello', version: '1.2.0', displayName: 'Hello café',
    description: 'Declarative example', engines: { cevra: '>=0.1.0 <1.0.0' }, permissions: [], contributes,
  };
}

function zip(entries) {
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name = manifestName, bytes, method = 0, attributes = 0x81a40020 } of entries) {
    const filename = Buffer.from(name);
    const payload = method === 8 ? deflateRawSync(bytes) : bytes;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method === 8 ? 20 : 10, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(filename.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    local.copy(central, 6, 4, 28);
    central.writeUInt32LE(attributes, 38);
    central.writeUInt32LE(offset, 42);
    localRecords.push(local, filename, payload);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + payload.length;
  }
  const directory = Buffer.concat(centralRecords);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, directory, end]);
}

const json = value => Buffer.from(JSON.stringify(value));
const archive = (data = manifest(), entry = {}) => zip([{ bytes: Buffer.isBuffer(data) ? data : json(data), ...entry }]);

module.exports = { archive, json, manifest, manifestName, zip };
