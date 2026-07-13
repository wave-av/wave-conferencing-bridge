import { describe, expect, it, vi } from 'vitest';

import type { MeetingMediaCapture, WhipPublishRequest } from '../types/meeting-sdk-launch.js';
import { MEETING_SDK_INGRESS_FLAG } from '../types/meeting-sdk-launch.js';
import { inertWhipPublisher } from './meeting-sdk-launch.js';
import {
  WhipAnswerParseError,
  WhipPublishError,
  WhipTeardownError,
  buildPlaceholderOfferSdp,
  createGatewayWhipPublisher,
  resolveWhipPublisher,
} from './gateway-whip-publisher.js';

function capture(overrides: Partial<MeetingMediaCapture> = {}): MeetingMediaCapture {
  return {
    captureId: 'cap-12345678901',
    kind: 'composited',
    stop: async () => {},
    ...overrides,
  };
}

function req(overrides: Partial<WhipPublishRequest> = {}): WhipPublishRequest {
  return {
    whipUrl: 'https://gateway.wave.online/v1/whip/publish',
    streamKey: 'live_test_key',
    capture: capture(),
    ...overrides,
  };
}

describe('buildPlaceholderOfferSdp', () => {
  it('emits a v=0-prefixed, CRLF-terminated SDP with audio + video m-lines', () => {
    const sdp = buildPlaceholderOfferSdp(capture());
    expect(sdp.startsWith('v=0\r\n')).toBe(true);
    expect(sdp).toContain('m=audio ');
    expect(sdp).toContain('m=video ');
    expect(sdp.endsWith('\r\n')).toBe(true);
  });
});

describe('createGatewayWhipPublisher — request shaping', () => {
  it('POSTs application/sdp with Authorization: Bearer <streamKey> and x-wave-room', async () => {
    let seenUrl: string | undefined;
    let seenInit: RequestInit | undefined;
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenInit = init;
      return new Response('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n', {
        status: 201,
        headers: { location: '/v1/whip/resource/res001', 'content-type': 'application/sdp' },
      });
    });
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    await publisher.publish(req());

    expect(seenUrl).toBe('https://gateway.wave.online/v1/whip/publish');
    expect(seenInit?.method).toBe('POST');
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/sdp');
    expect(headers['authorization']).toBe('Bearer live_test_key');
    expect(headers['x-wave-room']).toBe('live_test_key');
    expect(String(seenInit?.body)).toMatch(/^v=0\r\n/);
  });

  it('honors a custom deriveRoom + buildOfferSdp', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\ns=-\r\nt=0 0\r\n', {
        status: 201,
        headers: { location: '/v1/whip/resource/res001' },
      }),
    );
    const publisher = createGatewayWhipPublisher({
      fetch: fetchMock as unknown as typeof fetch,
      deriveRoom: () => 'room-zoom-12345678901',
      buildOfferSdp: () => 'v=0\r\ncustom-offer\r\n',
    });
    await publisher.publish(req());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-wave-room']).toBe('room-zoom-12345678901');
    expect(init.body).toBe('v=0\r\ncustom-offer\r\n');
  });
});

describe('createGatewayWhipPublisher — answer parsing', () => {
  it('resolves a relative Location against whipUrl into an absolute resourceUrl', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } }),
    );
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    const pub = await publisher.publish(req());
    expect(pub.resourceUrl).toBe('https://gateway.wave.online/v1/whip/resource/res001');
  });

  it('throws WhipPublishError on a non-201 status', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 503 }));
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    await expect(publisher.publish(req())).rejects.toBeInstanceOf(WhipPublishError);
  });

  it('throws WhipAnswerParseError when Location is missing', async () => {
    const fetchMock = vi.fn(async () => new Response('v=0\r\nanswer\r\n', { status: 201 }));
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    await expect(publisher.publish(req())).rejects.toBeInstanceOf(WhipAnswerParseError);
  });

  it('throws WhipAnswerParseError when the answer body is empty', async () => {
    const fetchMock = vi.fn(
      async () => new Response('', { status: 201, headers: { location: '/v1/whip/resource/res001' } }),
    );
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    await expect(publisher.publish(req())).rejects.toBeInstanceOf(WhipAnswerParseError);
  });
});

describe('createGatewayWhipPublisher — teardown', () => {
  it('DELETEs the resourceUrl with the same bearer credential', async () => {
    const calls: { method?: string; url: string; headers?: Record<string, string> }[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ method: init?.method, url: String(url), headers: init?.headers as Record<string, string> });
      if (!init?.method || init.method === 'POST') {
        return new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } });
      }
      return new Response(null, { status: 204 });
    });
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    const pub = await publisher.publish(req());
    await pub.stop();

    const del = calls.find((c) => c.method === 'DELETE');
    expect(del?.url).toBe('https://gateway.wave.online/v1/whip/resource/res001');
    expect(del?.headers?.['authorization']).toBe('Bearer live_test_key');
  });

  it('is idempotent: a second stop() does not re-issue the DELETE', async () => {
    let deleteCount = 0;
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCount++;
        return new Response(null, { status: 204 });
      }
      return new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } });
    });
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    const pub = await publisher.publish(req());
    await pub.stop();
    await pub.stop();
    expect(deleteCount).toBe(1);
  });

  it('treats a 404 teardown as already-gone (no throw)', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response('gone', { status: 404 });
      return new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } });
    });
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    const pub = await publisher.publish(req());
    await expect(pub.stop()).resolves.toBeUndefined();
  });

  it('throws WhipTeardownError on an unexpected DELETE failure', async () => {
    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') return new Response('boom', { status: 500 });
      return new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } });
    });
    const publisher = createGatewayWhipPublisher({ fetch: fetchMock as unknown as typeof fetch });
    const pub = await publisher.publish(req());
    await expect(pub.stop()).rejects.toBeInstanceOf(WhipTeardownError);
  });
});

describe('resolveWhipPublisher — selected only when the ingress flag is on', () => {
  it('returns the inert publisher when the flag is absent (never touches the network)', () => {
    const publisher = resolveWhipPublisher({} as NodeJS.ProcessEnv);
    expect(publisher).toBe(inertWhipPublisher);
  });

  it('returns a real gateway publisher when the flag is on', async () => {
    const fetchMock = vi.fn(
      async () => new Response('v=0\r\nanswer\r\n', { status: 201, headers: { location: '/v1/whip/resource/res001' } }),
    );
    const publisher = resolveWhipPublisher({ [MEETING_SDK_INGRESS_FLAG]: '1' } as NodeJS.ProcessEnv, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(publisher).not.toBe(inertWhipPublisher);
    const pub = await publisher.publish(req());
    expect(pub.resourceUrl).toContain('res001');
  });
});
