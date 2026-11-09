export interface BlockerQueueScene {
  items: unknown[];
  ids: string[];
  index: number;
  isInfinite: boolean;
  continuation: string | null;
  context: string | null;
  autoPlaying: boolean | null;
  shuffle: boolean | null;
  repeat: string | null;
  autoplay: boolean | null;
}

export interface BlockerPlaybackScene {
  documentId: string;
  version: number;
  url: string;
  videoId: string;
  playlistId?: string | null;
  seconds: number;
  paused: boolean;
  muted: boolean;
  queue: BlockerQueueScene | null;
}

export type BlockerSceneCapture =
  | { kind: 'idle'; documentId: string; version: number; url: string }
  | { kind: 'active'; scene: BlockerPlaybackScene }
  | { kind: 'unavailable'; reason: string };

export interface BlockerSceneOutcome {
  kind: 'verified' | 'pending' | 'partial' | 'failed' | 'cancelled';
  reason?: string;
}
