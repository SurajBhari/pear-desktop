import type {
  MusicService,
  MusicPage,
} from '../../src/plugins/api-server/backend/music-service';
import type { MusicReadEncoder } from '../../src/plugins/api-server/backend/music-read-result';
import type { MusicInvocation } from '../../src/plugins/api-server/backend/music-access';
import type {
  PlaybackSnapshot,
  QueuePage,
  LyricsResult,
  CommentPage,
} from '../../src/plugins/api-server/music-types';
declare const service: MusicService;
declare const invocation: MusicInvocation;
const current: Promise<PlaybackSnapshot> = service.currentFor(invocation);
const queue: Promise<QueuePage> = service.queueFor(invocation, {});
const encoded: Promise<string> = service.currentFor(
  invocation,
  undefined,
  () => 'owned',
);
// @ts-expect-error no caller-selected return generic
service.currentFor<string>(invocation);
// @ts-expect-error encoder must return a primitive string
const asyncEncoder: MusicReadEncoder<PlaybackSnapshot> = async () => 'owned';
// @ts-expect-error Promise-valued encoder is forbidden
service.currentFor(invocation, undefined, () => Promise.resolve('owned'));
// @ts-expect-error required encoded overload does not accept undefined
service.currentFor(invocation, undefined, undefined);
void [current, queue, encoded, asyncEncoder];

const queueForDTO: Promise<QueuePage> = service.queueFor(invocation, {});
const queueForEncoded: Promise<string> = service.queueFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [queueForDTO, queueForEncoded];
const searchForDTO: Promise<MusicPage> = service.searchFor(invocation, {});
const searchForEncoded: Promise<string> = service.searchFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [searchForDTO, searchForEncoded];
const browseForDTO: Promise<MusicPage> = service.browseFor(invocation, {});
const browseForEncoded: Promise<string> = service.browseFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [browseForDTO, browseForEncoded];
const homeForDTO: Promise<MusicPage> = service.homeFor(invocation, {});
const homeForEncoded: Promise<string> = service.homeFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [homeForDTO, homeForEncoded];
const libraryForDTO: Promise<MusicPage> = service.libraryFor(invocation, {});
const libraryForEncoded: Promise<string> = service.libraryFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [libraryForDTO, libraryForEncoded];
const lyricsForDTO: Promise<LyricsResult> = service.lyricsFor(invocation, {});
const lyricsForEncoded: Promise<string> = service.lyricsFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [lyricsForDTO, lyricsForEncoded];
const relatedForDTO: Promise<MusicPage> = service.relatedFor(invocation, {});
const relatedForEncoded: Promise<string> = service.relatedFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [relatedForDTO, relatedForEncoded];
const commentsForDTO: Promise<CommentPage> = service.commentsFor(
  invocation,
  {},
);
const commentsForEncoded: Promise<string> = service.commentsFor(
  invocation,
  {},
  undefined,
  () => 'owned',
);
void [commentsForDTO, commentsForEncoded];
