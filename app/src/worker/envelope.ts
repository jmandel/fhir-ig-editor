import { API_VERSION } from '../site/contract.generated';
import type { ApiEnvelope } from '../site/contract.generated';

/** One parser for every Rust/CLI operation envelope. Operation-specific
 * wrappers only choose how a typed failure becomes an Error. */
export function unwrapApiEnvelope<T, E>(
  serialized: string,
  onFailure: (error: E, operation: string) => Error,
): T {
  const envelope = JSON.parse(serialized) as ApiEnvelope<T, E>;
  if (envelope.apiVersion !== API_VERSION) {
    throw new Error(`unsupported engine apiVersion ${envelope.apiVersion}`);
  }
  if (typeof envelope.op !== 'string' || envelope.op.length === 0) {
    throw new Error('engine envelope omitted its operation');
  }
  if (!envelope.ok) throw onFailure(envelope.error, envelope.op);
  return envelope.result;
}
