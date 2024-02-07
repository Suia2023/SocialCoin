export enum MessageType {
  RAW = 0,
  XOR = 1,
}

export class MessageEncoder {
  private xor_key = 'suia';

  public encode(raw_message: string, type: MessageType): Uint8Array {
    let uint8Array;
    if (type == MessageType.RAW) {
      uint8Array = this.encode_raw(raw_message);
    } else if (type == MessageType.XOR) {
      uint8Array = this.encode_xor(raw_message);
    } else {
      throw new Error('Unsupported message type');
    }
    let encoded = new Uint8Array(uint8Array.length + 1);
    encoded[0] = type;
    encoded.set(uint8Array, 1);
    return encoded;
  }

  public decode(encoded_message: Uint8Array): string {
    let type = encoded_message[0];
    if (type == MessageType.RAW) {
      return this.decode_raw(encoded_message.slice(1));
    } else if (type == MessageType.XOR) {
      return this.decode_xor(encoded_message.slice(1));
    } else {
      throw new Error('Unsupported message type');
    }
  }

  public encode_raw(raw_message: string): Uint8Array {
    const encoder = new TextEncoder();
    const uint8Array = encoder.encode(raw_message);
    return uint8Array;
  }

  public decode_raw(encoded_message: Uint8Array): string {
    const decoder = new TextDecoder();
    return decoder.decode(encoded_message);
  }

  public encode_xor(raw_message: string): Uint8Array {
    let raw = this.encode_raw(raw_message);
    let result = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      result[i] = raw[i] ^ this.xor_key.charCodeAt(i % this.xor_key.length);
    }
    return result;
  }

  public decode_xor(encoded_message: Uint8Array): string {
    let result = new Uint8Array(encoded_message.length);
    for (let i = 0; i < encoded_message.length; i++) {
      result[i] = encoded_message[i] ^ this.xor_key.charCodeAt(i % this.xor_key.length);
    }
    return this.decode_raw(result);
  }
}
