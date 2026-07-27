export declare const TAR_TYPES: Readonly<Record<string, string>>;

export type TarMember = {
  readonly name: string;
  readonly type: string;
  readonly typeflag: string;
  readonly linkname: string;
  readonly size: number;
  readonly mode: number;
  readonly prefix: string;
};

export declare function readTarMembers(gzipBytes: Uint8Array): TarMember[];
