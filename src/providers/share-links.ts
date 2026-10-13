import { stripMusicFromShareUrl } from '../utils/share-url';

const selector = 'yt-copy-link-renderer input#share-url';
type Lease = { beginRetirement(): void; restore(): void; attribute(): void };

/** Own only the share input's descriptor; leave clipboard and other inputs alone. */
export const setupShareLinks = (doc: Document = document) => {
  const view = doc.defaultView;
  if (!view) return (_enabled: boolean) => {};
  let enabled = false;
  let epoch = 0;
  const leases = new Map<HTMLInputElement, Lease>();
  const retiring = new Map<HTMLInputElement, Lease>();
  const restoring = new Set<HTMLInputElement>();
  const writesInFlight = new Map<HTMLInputElement, number>();
  const pendingAdmissions = new Set<HTMLInputElement>();
  let observing = false;
  const valueTypes = new Set([
    'text',
    'search',
    'url',
    'tel',
    'password',
    'email',
  ]);
  const nativeValue = Object.getOwnPropertyDescriptor(
    view.HTMLInputElement.prototype,
    'value',
  )!;
  const nativeType = Object.getOwnPropertyDescriptor(
    view.HTMLInputElement.prototype,
    'type',
  )!;
  const supported = (input: HTMLInputElement) =>
    valueTypes.has(nativeType.get!.call(input) as string);
  const dirtyValue = (input: HTMLInputElement) => {
    // HTML cloning copies the dirty-value flag. Probe only the detached clone.
    const clone = view.Node.prototype.cloneNode.call(
      input,
      false,
    ) as HTMLInputElement;
    const before = nativeValue.get!.call(clone) as string;
    clone.setAttribute('value', before === 'probe-a' ? 'probe-b' : 'probe-a');
    return nativeValue.get!.call(clone) === before;
  };
  const preserveSelection = (
    input: HTMLInputElement,
    write: () => void,
    stillOwned = () => true,
  ) => {
    const start = input.selectionStart,
      end = input.selectionEnd,
      direction = input.selectionDirection;
    const beforeLength = (nativeValue.get!.call(input) as string).length;
    write();
    const afterLength = (nativeValue.get!.call(input) as string).length;
    // Keep a full selection, suffix selection or end-caret anchored to the URL end.
    const nextEnd = end === beforeLength ? afterLength : end;
    const nextStart =
      end === beforeLength && start !== null && start !== 0
        ? Math.max(0, afterLength - (beforeLength - start))
        : start;
    if (
      stillOwned() &&
      nextStart !== null &&
      nextEnd !== null &&
      supported(input) &&
      (input.selectionStart !== nextStart ||
        input.selectionEnd !== nextEnd ||
        input.selectionDirection !== direction)
    )
      input.setSelectionRange(nextStart, nextEnd, direction ?? 'none');
  };
  const restoreCleanValue = (input: HTMLInputElement) => {
    const type = input.getAttribute('type'),
      value = input.getAttribute('value');
    preserveSelection(input, () => {
      // Returning from default value mode resets only this input's native flag.
      nativeType.set!.call(input, 'button');
      if (value === null) input.removeAttribute('value');
      else input.setAttribute('value', value);
      if (type === null) input.removeAttribute('type');
      else input.setAttribute('type', type);
    });
  };
  let processing = false;
  const pending: {
    records: MutationRecord[];
    ignoreValue?: HTMLInputElement;
  }[] = [];
  const drain = (ignoreValue?: HTMLInputElement) =>
    processRecords(observer.takeRecords(), ignoreValue);
  const admitPending = () => {
    if (!enabled || !observing) return;
    for (const input of [...pendingAdmissions]) {
      if (retiring.has(input) || writesInFlight.has(input)) continue;
      pendingAdmissions.delete(input);
      attach(input);
    }
  };
  const finishRetirement = (input: HTMLInputElement) => {
    const lease = retiring.get(input);
    if (!lease || restoring.has(input) || writesInFlight.has(input)) return;
    restoring.add(input);
    try {
      lease.restore();
    } finally {
      restoring.delete(input);
      retiring.delete(input);
      admitPending();
    }
  };
  const retireLease = (input: HTMLInputElement, lease: Lease) => {
    if (leases.get(input) !== lease) return;
    lease.beginRetirement();
    leases.delete(input);
    retiring.set(input, lease);
    finishRetirement(input);
  };
  const beginWrite = (input: HTMLInputElement) => {
    writesInFlight.set(input, (writesInFlight.get(input) ?? 0) + 1);
  };
  const endWrite = (input: HTMLInputElement, primaryFailed = false) => {
    const depth = (writesInFlight.get(input) ?? 1) - 1;
    if (depth) writesInFlight.set(input, depth);
    else writesInFlight.delete(input);
    try {
      finishRetirement(input);
      admitPending();
    } catch (error) {
      // Retirement still drains, but cannot replace an in-flight write's error.
      if (!primaryFailed) throw error;
    }
  };
  const attach = (input: HTMLInputElement) => {
    if (
      leases.has(input) ||
      !enabled ||
      input.ownerDocument !== doc ||
      !input.isConnected ||
      !input.matches(selector) ||
      !supported(input)
    )
      return;
    if (retiring.has(input) || writesInFlight.has(input) || !observing) {
      pendingAdmissions.add(input);
      return;
    }
    const previous = Object.getOwnPropertyDescriptor(input, 'value');
    const descriptor =
      previous ??
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value');
    if (!descriptor?.get || !descriptor.set || !descriptor.configurable) return;
    const read = () => descriptor.get!.call(input) as string;
    const write = (value: string) => {
      beginWrite(input);
      let primaryFailed = false;
      try {
        descriptor.set!.call(input, value);
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        endWrite(input, primaryFailed);
      }
    };
    const generation = epoch;
    const samePrevious = () => {
      const current = Object.getOwnPropertyDescriptor(input, 'value');
      return previous
        ? current?.get === previous.get &&
            current?.set === previous.set &&
            current?.configurable === previous.configurable &&
            current?.enumerable === previous.enumerable
        : current === undefined;
    };
    let original = read();
    let rewritten = original;
    let attributeValue = input.getAttribute('value');
    let authoritativeDirty = dirtyValue(input);
    let siteWriteEpoch = 0;
    let siteWritesInFlight = 0;
    let retiredDuringSiteWrite = false;
    if (
      !enabled ||
      epoch !== generation ||
      input.ownerDocument !== doc ||
      !input.isConnected ||
      !input.matches(selector) ||
      !supported(input) ||
      !samePrevious()
    )
      return;
    const ownsDescriptor = () => {
      const current = Object.getOwnPropertyDescriptor(input, 'value');
      return (
        current?.get === get &&
        current.set === set &&
        current.configurable === true &&
        current.enumerable === descriptor.enumerable
      );
    };
    const owns = () =>
      enabled &&
      epoch === generation &&
      input.ownerDocument === doc &&
      input.isConnected &&
      supported(input) &&
      input.matches(selector) &&
      ownsDescriptor();
    let lease: Lease;
    const retire = () => {
      // A newer generation may already own this field after a delegated read.
      retireLease(input, lease);
    };
    const rewrite = (value: string) => {
      original = value;
      rewritten = stripMusicFromShareUrl(original);
      if (!owns()) {
        retire();
        return;
      }
      const current = read();
      if (!owns()) {
        retire();
        return;
      }
      if (current === rewritten) return;
      const writes = siteWriteEpoch;
      preserveSelection(
        input,
        () => {
          if (owns()) write(rewritten);
        },
        () => owns() && siteWriteEpoch === writes,
      );
      attributeValue = input.getAttribute('value');
      drain(input);
    };
    const get = () => read();
    const set = (value: string) => {
      // Attribute records that precede this property write cannot win later.
      siteWritesInFlight++;
      beginWrite(input);
      let primaryFailed = false;
      try {
        drain();
        write(value);
        // Capture authority before releasing the in-flight cleanup fence.
        original = read();
        rewritten = original;
        authoritativeDirty = true;
        siteWriteEpoch++;
        attributeValue = input.getAttribute('value');
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        siteWritesInFlight--;
        endWrite(input, primaryFailed);
      }
      // Coercion/accessor side effects precede the completed property assignment.
      drain(input);
      if (owns()) rewrite(original);
    };
    const inputEdit = () => {
      const current = Object.getOwnPropertyDescriptor(input, 'value');
      if (current?.get !== get || current.set !== set) return;
      original = read();
      rewritten = original;
      authoritativeDirty = true;
      siteWriteEpoch++;
      attributeValue = input.getAttribute('value');
      drain(input);
    };
    Object.defineProperty(input, 'value', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get,
      set,
    });
    input.addEventListener('input', inputEdit);
    lease = {
      beginRetirement() {
        retiredDuringSiteWrite ||= siteWritesInFlight > 0;
      },
      attribute() {
        if (owns()) {
          attributeValue = input.getAttribute('value');
          rewrite(attributeValue ?? '');
        }
      },
      restore() {
        let reset = false;
        try {
          if (!ownsDescriptor()) return;
          const value = read();
          if (!ownsDescriptor()) return;
          // A delegated setter may retire this lease before returning or throwing.
          // Release our descriptor, but never roll back its in-progress native state.
          const ownedValue =
            !retiredDuringSiteWrite &&
            siteWritesInFlight === 0 &&
            value === rewritten;
          const attribute = input.getAttribute('value');
          if (attribute !== attributeValue) original = attribute ?? '';
          reset =
            ownedValue &&
            !authoritativeDirty &&
            supported(input) &&
            dirtyValue(input);
          const writes = siteWriteEpoch;
          // Keep our setter until callouts finish so nested site writes remain observed.
          if (ownedValue && value !== original)
            preserveSelection(
              input,
              () => write(original),
              () => ownsDescriptor() && siteWriteEpoch === writes,
            );
        } finally {
          input.removeEventListener('input', inputEdit);
          if (ownsDescriptor()) {
            if (previous) Object.defineProperty(input, 'value', previous);
            else Reflect.deleteProperty(input, 'value');
          }
        }
        if (
          reset &&
          !authoritativeDirty &&
          samePrevious() &&
          read() === original &&
          samePrevious() &&
          supported(input)
        )
          restoreCleanValue(input);
      },
    };
    leases.set(input, lease);
    rewrite(original);
  };
  const scan = (root: Document | Element) => {
    if (root instanceof view.HTMLInputElement && root.matches(selector))
      attach(root);
    root.querySelectorAll<HTMLInputElement>(selector).forEach(attach);
  };
  const processRecords = (
    records: MutationRecord[],
    ignoreValue?: HTMLInputElement,
  ) => {
    pending.push({ records, ignoreValue });
    if (processing) return;
    processing = true;
    try {
      while (pending.length) {
        const batch = pending.shift()!;
        if (!enabled) return;
        let failed = false;
        let failure: unknown;
        for (const [input, lease] of [...leases]) {
          if (
            input.ownerDocument !== doc ||
            !input.isConnected ||
            !input.matches(selector) ||
            !supported(input)
          ) {
            try {
              retireLease(input, lease);
            } catch (error) {
              if (!failed) failure = error;
              failed = true;
            }
          }
        }
        if (failed) throw failure;
        for (const record of batch.records) {
          if (record.type === 'attributes') {
            if (!(record.target instanceof view.HTMLInputElement)) continue;
            if (record.target.matches(selector)) attach(record.target);
            if (
              record.attributeName === 'value' &&
              record.target !== batch.ignoreValue
            )
              leases.get(record.target)?.attribute();
          } else {
            for (const node of record.addedNodes)
              if (node instanceof view.Element) scan(node);
          }
        }
      }
    } finally {
      pending.length = 0;
      processing = false;
    }
  };
  const observer = new view.MutationObserver((records) =>
    processRecords(records),
  );
  return (value: boolean) => {
    const next = value === true;
    if (next === enabled) return;
    const beforeDrain = epoch;
    if (enabled) drain();
    if (epoch !== beforeDrain) return;
    enabled = next;
    const generation = ++epoch;
    observer.disconnect();
    observing = false;
    let failed = false;
    let failure: unknown;
    for (const [input, lease] of [...leases]) {
      try {
        retireLease(input, lease);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
      if (epoch !== generation) {
        if (failed) throw failure;
        return;
      }
    }
    if (failed) {
      pendingAdmissions.clear();
      throw failure;
    }
    if (!enabled) {
      pendingAdmissions.clear();
      return;
    }
    observer.observe(doc, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'value', 'type'],
    });
    observing = true;
    scan(doc);
    admitPending();
  };
};
