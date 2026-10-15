// -----------------------------------------------------------------------------
// A protobuf ENCODER for the simulated adapter: nested, repeated and double
// fields included (the integration itself only encodes small requests, see
// src/devolo/protobuf.js). Checked against bytes produced by the reference
// protobuf library in test/protobuf.test.js.
// -----------------------------------------------------------------------------

const varint = (value) => {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    let byte = Number(rest & 0x7fn);
    rest >>= 7n;
    if (rest > 0n) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (rest > 0n);
  return Buffer.from(bytes);
};

const lengthDelimited = (id, bytes) =>
  Buffer.concat([varint((id << 3) | 2), varint(bytes.length), bytes]);

function field(id, type, value) {
  if (typeof type === 'object') {
    return lengthDelimited(id, encodeMessage(type, value));
  }
  switch (type) {
    case 'string':
    case 'bytes': {
      const bytes = Buffer.from(value);
      return bytes.length ? lengthDelimited(id, bytes) : Buffer.alloc(0);
    }
    case 'double': {
      if (!value) {
        return Buffer.alloc(0);
      }
      const bytes = Buffer.alloc(8);
      bytes.writeDoubleLE(value);
      return Buffer.concat([varint((id << 3) | 1), bytes]);
    }
    default: {
      const number = type === 'bool' ? (value ? 1 : 0) : Math.trunc(value);
      return number ? Buffer.concat([varint(id << 3), varint(number)]) : Buffer.alloc(0);
    }
  }
}

/** Encode a message with a schema of src/devolo/schema.js. */
export function encodeMessage(schema, message = {}) {
  const parts = [];
  for (const [name, { id, type, repeated }] of Object.entries(schema)) {
    const value = message[name];
    if (value === undefined || value === null) {
      continue;
    }
    for (const item of repeated ? value : [value]) {
      parts.push(field(id, type, item));
    }
  }
  return Buffer.concat(parts);
}
