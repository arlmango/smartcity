export declare function normalizeForwardedFor(
  header: string | string[] | undefined,
  remoteAddress: string | undefined,
  trustedHops: number | string | undefined,
): string;
export declare function parseTrustedHops(raw: unknown): number;
export declare function isIp(s: unknown): boolean;
