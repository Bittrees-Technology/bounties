import { useCallback, useRef, useState } from "react";
import { errorCodeOf, mapErrorToUserMessage } from "./errors";
import type { EscrowErrorCode } from "./errors";
import type { EscrowTxResult, EscrowTxState } from "./types";

export interface EscrowTransactionState {
  state: EscrowTxState;
  txHash?: string;
  errorMessage?: string;
  errorCode?: EscrowErrorCode;
}

const idleState: EscrowTransactionState = { state: "idle" };

/**
 * Drives pending/confirmed/failed UX for a single escrow action. `run` is generic over any
 * EscrowClient method so callers stay decoupled from mock-vs-live client wiring.
 */
export function useEscrowTransaction() {
  const [status, setStatus] = useState<EscrowTransactionState>(idleState);
  const requestId = useRef(0);

  const run = useCallback(async (action: () => Promise<EscrowTxResult>): Promise<EscrowTxResult> => {
    const currentRequest = ++requestId.current;
    setStatus({ state: "pending" });
    try {
      const result = await action();
      if (requestId.current === currentRequest) {
        setStatus({ state: result.state, txHash: result.txHash });
      }
      return result;
    } catch (error) {
      if (requestId.current === currentRequest) {
        setStatus({ state: "failed", errorMessage: mapErrorToUserMessage(error), errorCode: errorCodeOf(error) });
      }
      throw error;
    }
  }, []);

  const reset = useCallback(() => setStatus(idleState), []);

  return { status, run, reset };
}
