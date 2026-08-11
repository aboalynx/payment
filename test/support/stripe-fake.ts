import type Stripe from 'stripe';

/** Exactly what `new Stripe(key, { httpClient })` accepts, without a deep import. */
type StripeHttpClient = NonNullable<Stripe.StripeConfig['httpClient']>;

interface Recorded {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string>;
}

/**
 * Intercepts Stripe traffic at the transport layer.
 *
 * The SDK accepts a custom `httpClient`, which is the only seam that works for every
 * call regardless of which resource makes it. It also means no test can reach the real
 * API, and the Authorization header — the thing that decides which account is charged —
 * is assertable.
 *
 * The returned object is typed structurally rather than by extending Stripe's
 * `HttpClient` class, so this does not depend on the SDK's internal module layout. The
 * shape matches `HttpClientInterface` in stripe/cjs/net/HttpClient.d.ts: `makeRequest`
 * takes eight positional arguments.
 */
export class FakeStripeHttp {
  readonly requests: Recorded[] = [];

  private readonly stubs = new Map<string, { body: unknown; status: number }>();

  /** Queue a response for any request whose path contains `pathFragment`. */
  stub(pathFragment: string, body: unknown, status = 200): this {
    this.stubs.set(pathFragment, { body, status });
    return this;
  }

  lastRequest(): Recorded | undefined {
    return this.requests.at(-1);
  }

  /** The secret actually sent, read off the Authorization header. */
  lastBearerToken(): string | undefined {
    const auth = this.lastRequest()?.headers['authorization'];
    return auth?.replace(/^Bearer\s+/i, '');
  }

  /** Parsed form body of the last request, since Stripe posts form-encoded. */
  lastBody(): Record<string, string> {
    return Object.fromEntries(new URLSearchParams(this.lastRequest()?.body ?? '').entries());
  }

  /** Every request whose path contains the fragment. */
  requestsTo(pathFragment: string): Recorded[] {
    return this.requests.filter((request) => request.path.includes(pathFragment));
  }

  /** Pass this to `new Stripe(key, { httpClient })`. */
  build(): StripeHttpClient {
    return {
      getClientName: (): string => 'fake',

      makeRequest: (
        _host: string,
        _port: string,
        path: string,
        method: string,
        headers: Record<string, string | number | string[]>,
        requestData: string,
        _protocol: string,
        _timeout: number,
      ) => {
        this.requests.push({
          method,
          path,
          body: requestData,
          headers: Object.fromEntries(
            Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
          ),
        });

        // Later registrations win, so a test can override a shared default.
        let match = { body: {} as unknown, status: 200 };
        for (const [fragment, response] of this.stubs) {
          if (path.includes(fragment)) match = response;
        }

        const payload = match.body;

        return Promise.resolve({
          getStatusCode: (): number => match.status,
          getHeaders: (): Record<string, string> => ({ 'content-type': 'application/json' }),
          getRawResponse: (): unknown => ({}),
          toStream: (): unknown => {
            throw new Error('streaming is not supported by FakeStripeHttp');
          },
          toJSON: (): Promise<unknown> => Promise.resolve(payload),
        });
      },
    };
  }
}
