// The errors media capture rejects with, named as Media Capture and Streams
// names them (design/architecture/media-capture.md §2.1): a `DOMException`
// whose `name` is `NotAllowedError`, `NotFoundError`, `NotReadableError`,
// `OverconstrainedError`, `NotSupportedError` or `AbortError`. Free to
// adopt, and what lets code written against `getUserMedia` in a browser —
// `err.name === 'NotAllowedError'` — run here as written, and the
// components facade hand them to a page unchanged.
//
// The messages are ours: what was asked, what was found, and what to do
// about it, which a browser's never say.

/** A `DOMException` named `name`, its message prefixed the house way. */
export function mediaError(name, message, options) {
  const err = new DOMException(`react-x11: ${message}`, name);
  if (options?.cause !== undefined) {
    Object.defineProperty(err, 'cause', {
      value: options.cause,
      configurable: true,
      writable: true,
    });
  }
  return err;
}

/**
 * A required constraint no device can meet: `constraint` names it, as a
 * browser's `OverconstrainedError` does — `{ width: { exact: 4000 } }` on a
 * 1080p camera rejects with `constraint === 'width'`.
 */
export class OverconstrainedError extends DOMException {
  constructor(constraint, message) {
    super(
      `react-x11: ${
        message ??
        `no device can meet the required ${JSON.stringify(constraint)} ` +
          'constraint. An exact value, a min or a max is required; a bare ' +
          'value or { ideal } is a preference and never fails.'
      }`,
      'OverconstrainedError',
    );
    this.constraint = constraint;
  }
}

/**
 * An error a backend reported by name — the bridge's `camera-error { name,
 * message }` — as the exception its name means. A name we do not know is a
 * device that could not be read, which is the nearest true thing.
 */
export function errorFromBackend(err, what) {
  if (err instanceof DOMException) return err;
  const name = typeof err?.name === 'string' ? err.name : '';
  const message = err?.message ?? String(err);
  switch (name) {
    case 'NotAllowedError':
    case 'NotFoundError':
    case 'NotReadableError':
    case 'NotSupportedError':
    case 'AbortError':
      return mediaError(name, `${what}: ${message}`, { cause: err });
    case 'OverconstrainedError':
      return new OverconstrainedError(err.constraint ?? '', message);
    default:
      return mediaError('NotReadableError', `${what}: ${message}`, {
        cause: err,
      });
  }
}
