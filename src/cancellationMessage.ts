import { encodeAbiParameters } from "viem";

export const MAX_CANCELLATION_MESSAGE_LENGTH = 500;

export type EscrowCancellationMessage = {
  message: string;
  messageHash: `0x${string}`;
  calldataSuffix: `0x${string}`;
};

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code === 127 || code < 32 && ![9, 10, 13].includes(code);
  });
}

export async function buildEscrowCancellationMessage(value: string): Promise<EscrowCancellationMessage | undefined> {
  const message = value.trim();
  if (!message) return undefined;
  if (message.length > MAX_CANCELLATION_MESSAGE_LENGTH || hasControlCharacters(message)) {
    throw new Error(`Keep the cancellation message to ${MAX_CANCELLATION_MESSAGE_LENGTH} plain-text characters or fewer.`);
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Cancellation-message fingerprinting is unavailable in this browser.");
  }
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  const messageHash = `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;
  const calldataSuffix = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "string" }],
    [messageHash, message]
  );
  return { message, messageHash, calldataSuffix };
}
