// -----------------------------------------------------------------------------
// A minimal Protocol Buffers (proto3) codec: just what the devolo Device API
// and PLC network API messages need. Their schemas are written by hand in
// src/devolo/schema.js from the published message definitions; no generated
// code, no dependency.
//
// Wire types handled: 0 (varint), 1 (64-bit: the `double` data rates),
// 2 (length-delimited: strings, bytes, sub-messages) and 5 (32-bit, skipped).
// Unknown fields are skipped, so a newer firmware adding fields still decodes.
// -----------------------------------------------------------------------------

const VARINT = 0;
const FIXED64 = 1;
const LENGTH = 2;
const FIXED32 = 5;

export class ProtobufError extends Error {}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let position = offset;
  for (;;) {
    if (position >= buffer.length) {
      throw new ProtobufError('Truncated varint');
    }
    const byte = buffer[position];
    position += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: position };
    }
    shift += 7n;
    if (shift > 63n) {
      throw new ProtobufError('Varint too long');
    }
  }
}

/** The raw fields of a message: field number → list of raw values. */
export function readFields(buffer) {
  const fields = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const { value: key, next } = readVarint(buffer, offset);
    offset = next;
    const number = Number(key >> 3n);
    const wireType = Number(key & 7n);
    let raw;
    if (wireType === VARINT) {
      const read = readVarint(buffer, offset);
      raw = { wireType, value: read.value };
      offset = read.next;
    } else if (wireType === FIXED64) {
      if (offset + 8 > buffer.length) {
        throw new ProtobufError('Truncated 64-bit field');
      }
      raw = { wireType, value: buffer.subarray(offset, offset + 8) };
      offset += 8;
    } else if (wireType === LENGTH) {
      const read = readVarint(buffer, offset);
      const length = Number(read.value);
      offset = read.next;
      if (offset + length > buffer.length) {
        throw new ProtobufError('Truncated length-delimited field');
      }
      raw = { wireType, value: buffer.subarray(offset, offset + length) };
      offset += length;
    } else if (wireType === FIXED32) {
      offset += 4;
      continue;
    } else {
      throw new ProtobufError(`Unsupported wire type ${wireType}`);
    }
    if (number > 0) {
      if (!fields.has(number)) {
        fields.set(number, []);
      }
      fields.get(number).push(raw);
    }
  }
  return fields;
}

const DEFAULTS = {
  bool: false,
  int32: 0,
  uint32: 0,
  int64: 0,
  enum: 0,
  double: 0,
  string: '',
  bytes: Buffer.alloc(0),
};

function scalar(type, raw) {
  switch (type) {
    case 'bool':
      return raw.value !== 0n;
    case 'int32':
    case 'enum':
      return Number(BigInt.asIntN(32, raw.value));
    case 'uint32':
      return Number(BigInt.asUintN(32, raw.value));
    case 'int64':
      return Number(BigInt.asIntN(64, raw.value));
    case 'double':
      return raw.wireType === FIXED64 ? raw.value.readDoubleLE(0) : 0;
    case 'string':
      return Buffer.from(raw.value).toString('utf8');
    case 'bytes':
      return Buffer.from(raw.value);
    default:
      throw new ProtobufError(`Unknown type ${type}`);
  }
}

/**
 * Decode a message.
 * @param {object} schema `{ name: { id, type, repeated? } }`, `type` a scalar
 *   name or a nested schema
 * @param {Buffer|Uint8Array} buffer
 */
export function decode(schema, buffer) {
  const fields = readFields(Buffer.from(buffer ?? []));
  const message = {};
  for (const [name, { id, type, repeated }] of Object.entries(schema)) {
    const raws = fields.get(id) ?? [];
    const nested = typeof type === 'object';
    const one = (raw) => (nested ? decode(type, raw.value) : scalar(type, raw));
    if (repeated) {
      message[name] = raws.filter((raw) => !nested || raw.wireType === LENGTH).map(one);
    } else if (raws.length > 0) {
      // proto3: the last occurrence wins.
      message[name] = one(raws[raws.length - 1]);
    } else {
      message[name] = nested ? null : DEFAULTS[type];
    }
  }
  return message;
}

function writeVarint(value) {
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
}

/**
 * Encode a message of scalar fields (what the requests need). Default values
 * are left out, as proto3 encoders do.
 */
export function encode(schema, message = {}) {
  const parts = [];
  for (const [name, { id, type }] of Object.entries(schema)) {
    const value = message[name];
    if (value === undefined || value === null) {
      continue;
    }
    switch (type) {
      case 'bool':
      case 'int32':
      case 'uint32':
      case 'int64':
      case 'enum': {
        const number = type === 'bool' ? (value ? 1 : 0) : Math.trunc(Number(value));
        if (number !== 0) {
          parts.push(writeVarint((id << 3) | VARINT), writeVarint(number));
        }
        break;
      }
      case 'string':
      case 'bytes': {
        const bytes = Buffer.from(value);
        if (bytes.length > 0) {
          parts.push(writeVarint((id << 3) | LENGTH), writeVarint(bytes.length), bytes);
        }
        break;
      }
      default:
        throw new ProtobufError(`Cannot encode ${type}`);
    }
  }
  return Buffer.concat(parts);
}
