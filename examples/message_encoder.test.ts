import { MessageEncoder, MessageType } from './message_encoder';

describe('MessageEncoder', () => {
  let encoder: MessageEncoder;

  beforeEach(() => {
    encoder = new MessageEncoder();
  });

  it('encodes and decodes raw message', () => {
    const raw_message = 'Hello, World!';
    const encoded = encoder.encode(raw_message, MessageType.RAW);
    const decoded = encoder.decode(encoded);
    expect(decoded).toEqual(raw_message);
  });

  it('encodes and decodes xor message', () => {
    const raw_message = 'Hello, World!';
    const encoded = encoder.encode(raw_message, MessageType.XOR);
    const decoded = encoder.decode(encoded);
    expect(decoded).toEqual(raw_message);
  });

  it('encodes and decodes xor message for utf8', () => {
    const raw_message = '你好，世界 😄';
    const encoded = encoder.encode(raw_message, MessageType.XOR);
    const decoded = encoder.decode(encoded);
    expect(decoded).toEqual(raw_message);
  });
});
