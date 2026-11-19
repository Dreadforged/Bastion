/**
 * The hook for abuse scanning of public-channel images (CSAM hash matching
 * and similar), run after metadata is stripped and before a file can be used.
 *
 * Only a stub ships today. Plug a real service in by implementing
 * `ImageScanner` and passing it to the file routes; nothing else changes.
 * Private files are encrypted on the device and are never scanned here.
 */

export type ScanVerdict =
  /** Nothing found. The file may be used. */
  | { verdict: "clean" }
  /** A known-bad match. The file is deleted and never served. */
  | { verdict: "match"; reference?: string }
  /** The scan could not run. The file stays pending and the client retries. */
  | { verdict: "error" };

export interface ScanInput {
  fileId: string;
  uploaderId: string;
  contentType: string;
  /** The stripped image bytes. */
  bytes: Uint8Array;
}

export interface ImageScanner {
  scan(input: ScanInput): Promise<ScanVerdict>;
}

/**
 * Placeholder until a real scanning service is chosen. It lets everything
 * through, so public uploads are NOT scanned in the alpha.
 */
export class NoopScanner implements ImageScanner {
  async scan(): Promise<ScanVerdict> {
    return { verdict: "clean" };
  }
}
