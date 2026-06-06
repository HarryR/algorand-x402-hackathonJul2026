/**
 * Terminal QR rendering for the CLI wallet.
 *
 * Encodes an Algorand payment URI (`algorand://<address>`) — the scheme Pera /
 * Defly recognize, so scanning prefills the recipient when sending funds. Uses
 * the `qrcode` library (pure JS → works in the compiled binary).
 */

import QRCode from 'qrcode';

/** The Algorand URI for an address (amount-less; wallet apps prefill recipient). */
export function algorandUri(address: string): string {
  return `algorand://${address}`;
}

/** Render the address as a scannable terminal QR (Algorand URI inside). */
export async function addressQr(address: string): Promise<string> {
  return QRCode.toString(algorandUri(address), { type: 'terminal', small: true });
}
