import type { MusicService } from '../../src/plugins/api-server/backend/music-service';
import type { MusicInvocation } from '../../src/plugins/api-server/backend/music-access';
import type { MusicOperationReceipt } from '../../src/plugins/api-server/music-types';

declare const service: MusicService;
declare const invocation: MusicInvocation;
const prepare: Promise<MusicOperationReceipt> = service.prepareFor(
  invocation,
  {},
);
const control: Promise<MusicOperationReceipt> = service.controlFor(
  invocation,
  {},
);
const navigation: Promise<MusicOperationReceipt> = service.navigateFor(
  invocation,
  {},
);
const queue: Promise<MusicOperationReceipt> = service.mutateQueueFor(
  invocation,
  {},
);
const status: Promise<MusicOperationReceipt> = service.operationFor(
  invocation,
  'owned',
);
const encode = (receipt: MusicOperationReceipt): string =>
  JSON.stringify(receipt);
const encoded: Promise<string>[] = [
  service.prepareFor(invocation, {}, undefined, encode),
  service.controlFor(invocation, {}, undefined, encode),
  service.navigateFor(invocation, {}, undefined, encode),
  service.mutateQueueFor(invocation, {}, undefined, encode),
  service.operationFor(invocation, 'owned', undefined, encode),
];
// @ts-expect-error an absent encoder cannot select the encoded overload
service.controlFor(invocation, {}, undefined, undefined);
// @ts-expect-error Promise-valued encoders cannot escape the in-lease checkpoint
service.prepareFor(invocation, {}, undefined, async () => 'unowned');
// @ts-expect-error no caller-selected return generic
service.operationFor<string>(invocation, 'owned');
void [prepare, control, navigation, queue, status, encoded];
