export const blockers = {
  WithBlocklists: 'With blocklists',
  InPlayer: 'In player',
  AdSpeedup: 'Ad speedup',
} as const;

export interface AdblockerConfig {
  enabled: boolean;
  cache: boolean;
  blocker: (typeof blockers)[keyof typeof blockers];
  additionalBlockLists: string[];
  disableDefaultLists: boolean | unknown[];
}
