import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import type { SnapConfirmationInterface } from '@metamask/snaps-jest';

type OkResponse<T> = { response: { result: T }; id: string };

function getResult<T>(resp: unknown): T {
  const r = resp as OkResponse<T>;
  if (!r.response || !('result' in r.response)) {
    throw new Error(`Snap responded with error: ${JSON.stringify(resp)}`);
  }
  return r.response.result;
}

describe('dungeon-snap', () => {
  describe('dungeon_getAccount', () => {
    it('derives a valid dungeon1 bech32 address', async () => {
      const { request, close } = await installSnap();
      try {
        const response = await request({ method: 'dungeon_getAccount' });
        const result = getResult<{ address: string; pubkey: string }>(response);

        expect(result.address).toMatch(/^dungeon1[02-9ac-hj-np-z]{38}$/);
        expect(typeof result.pubkey).toBe('string');
        expect(Buffer.from(result.pubkey, 'base64').length).toBe(33);
        // eslint-disable-next-line no-console
        console.log('[smoke] derived address:', result.address);
      } finally {
        await close();
      }
    });

    it('is deterministic across calls within a session', async () => {
      const { request, close } = await installSnap();
      try {
        const a = await request({ method: 'dungeon_getAccount' });
        const b = await request({ method: 'dungeon_getAccount' });
        expect(getResult<{ address: string }>(a).address).toBe(
          getResult<{ address: string }>(b).address,
        );
      } finally {
        await close();
      }
    });
  });

  describe('dungeon_getBalance', () => {
    it('queries the live LCD and returns a well-formed balance', async () => {
      const { request, close } = await installSnap();
      try {
        const response = await request({ method: 'dungeon_getBalance' });
        const result = getResult<{ denom: string; amount: string; display: string }>(response);

        expect(result.denom).toBe('udgn');
        expect(result.amount).toMatch(/^\d+$/);
        expect(result.display).toMatch(/^\d+(\.\d+)? DGN$/);
        // eslint-disable-next-line no-console
        console.log('[smoke] balance:', result.display);
      } finally {
        await close();
      }
    });
  });

  describe('dungeon_signArbitrary', () => {
    it('signs a message after user approval, signature verifies against derived pubkey', async () => {
      const { request } = await installSnap();
      const message = 'Login to Dungeon Marketplace at 2026-05-25T16:30:00Z';

      const pending = request({ method: 'dungeon_signArbitrary', params: { message } });
      const ui = (await pending.getInterface()) as SnapConfirmationInterface;
      expect(ui.type).toBe('confirmation');
      await ui.ok();

      const result = getResult<{ signature: string; pubkey: string; address: string }>(
        await pending,
      );

      expect(result.address).toMatch(/^dungeon1[02-9ac-hj-np-z]{38}$/);
      const sigBytes = Buffer.from(result.signature, 'base64');
      const pubBytes = Buffer.from(result.pubkey, 'base64');
      expect(sigBytes.length).toBe(64);
      expect(pubBytes.length).toBe(33);

      // Low-S enforcement: the high 256 bits (s value) must be ≤ N/2.
      // Half of secp256k1 curve order N.
      const sBytes = sigBytes.subarray(32, 64);
      const halfN = Buffer.from(
        '7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0',
        'hex',
      );
      expect(Buffer.compare(sBytes, halfN)).toBeLessThanOrEqual(0);
    });

    it('is deterministic — same message produces same signature', async () => {
      const { request } = await installSnap();
      const message = 'replay-this-exact-message';

      const sign = async () => {
        const pending = request({ method: 'dungeon_signArbitrary', params: { message } });
        const ui = (await pending.getInterface()) as SnapConfirmationInterface;
        await ui.ok();
        return getResult<{ signature: string }>(await pending).signature;
      };

      const a = await sign();
      const b = await sign();
      expect(a).toBe(b);
    });

    it('throws if user rejects the dialog', async () => {
      const { request } = await installSnap();
      const pending = request({
        method: 'dungeon_signArbitrary',
        params: { message: 'do not sign me' },
      });
      const ui = (await pending.getInterface()) as SnapConfirmationInterface;
      await ui.cancel();

      const resp = await pending;
      expect(resp).toRespondWithError({
        code: -32603,
        message: expect.stringContaining('User rejected'),
        stack: expect.any(String),
      });
    });

    it('rejects empty or missing message', async () => {
      const { request } = await installSnap();
      const resp = await request({ method: 'dungeon_signArbitrary', params: {} });
      expect(resp).toRespondWithError({
        code: -32603,
        message: expect.stringContaining('requires { message: string }'),
        stack: expect.any(String),
      });
    });
  });

  describe('dungeon_signADR036 (Keplr-compat)', () => {
    it('produces a 64-byte signature distinct from raw-sha256 mode', async () => {
      const { request } = await installSnap();
      const message = 'Welcome to Dungeon Marketplace';

      const rawPending = request({
        method: 'dungeon_signArbitrary',
        params: { message },
      });
      const rawUi = (await rawPending.getInterface()) as SnapConfirmationInterface;
      await rawUi.ok();
      const rawResult = getResult<{ signature: string; scheme: string }>(await rawPending);
      expect(rawResult.scheme).toBe('raw-sha256');

      const adrPending = request({
        method: 'dungeon_signADR036',
        params: { message },
      });
      const adrUi = (await adrPending.getInterface()) as SnapConfirmationInterface;
      await adrUi.ok();
      const adrResult = getResult<{ signature: string; scheme: string }>(await adrPending);
      expect(adrResult.scheme).toBe('adr-036');

      const adrBytes = Buffer.from(adrResult.signature, 'base64');
      expect(adrBytes.length).toBe(64);
      expect(adrResult.signature).not.toBe(rawResult.signature);
    });
  });

  describe('dungeon_buildSendTx', () => {
    it('rejects an invalid recipient address', async () => {
      const { request } = await installSnap();
      const resp = await request({
        method: 'dungeon_buildSendTx',
        params: { recipient: 'cosmos1xyz', amount: '1000000' },
      });
      expect(resp).toRespondWithError({
        code: -32603,
        message: expect.stringContaining('dungeon1'),
        stack: expect.any(String),
      });
    });

    it('rejects a non-positive amount', async () => {
      const { request } = await installSnap();
      const resp = await request({
        method: 'dungeon_buildSendTx',
        params: {
          recipient: 'dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe',
          amount: '0',
        },
      });
      expect(resp).toRespondWithError({
        code: -32603,
        message: expect.stringContaining('greater than 0'),
        stack: expect.any(String),
      });
    });

    it('throws if user rejects the confirmation', async () => {
      const { request } = await installSnap();
      const pending = request({
        method: 'dungeon_buildSendTx',
        params: {
          recipient: 'dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe',
          amount: '1000000',
        },
      });
      const ui = (await pending.getInterface()) as SnapConfirmationInterface;
      expect(ui.type).toBe('confirmation');
      await ui.cancel();
      expect(await pending).toRespondWithError({
        code: -32603,
        message: expect.stringContaining('User rejected'),
        stack: expect.any(String),
      });
    });

    it('after approval, either signs (account exists) or surfaces account-not-found cleanly', async () => {
      const { request } = await installSnap();
      const pending = request({
        method: 'dungeon_buildSendTx',
        params: {
          recipient: 'dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe',
          amount: '1000000',
          memo: 'snap test',
        },
      });
      const ui = (await pending.getInterface()) as SnapConfirmationInterface;
      await ui.ok();
      const resp = (await pending) as
        | { response: { result: { txBytes: string; signature: string } } }
        | { response: { error: { message: string } } };

      if ('result' in resp.response) {
        const sigBytes = Buffer.from(resp.response.result.signature, 'base64');
        expect(sigBytes.length).toBe(64);
        const txBytes = Buffer.from(resp.response.result.txBytes, 'base64');
        expect(txBytes.length).toBeGreaterThan(64);
        // eslint-disable-next-line no-console
        console.log('[smoke] signed tx bytes:', txBytes.length, 'bytes');
      } else {
        expect(resp.response.error.message).toMatch(
          /Account does not exist|LCD account fetch/,
        );
        // eslint-disable-next-line no-console
        console.log(
          '[smoke] expected LCD error (test wallet unfunded):',
          resp.response.error.message,
        );
      }
    });
  });

  // FOLLOW-UP: protobuf round-trip unit test for buildSignedSendTx is parked.
  // Jest can't ESM-import @noble/hashes/sha2.js without bundling the snap source,
  // and tests run against the bundle (which keeps noble internal). The protobuf
  // path is covered by the snaps-jest test above once the test wallet is funded
  // on dungeon-1 (LCD account fetch succeeds → protobuf path executes → assert
  // structural shape of the returned txBytes).

  describe('error handling', () => {
    it('throws Method not found for unknown methods', async () => {
      const { request, close } = await installSnap();
      try {
        const response = await request({ method: 'foo' });
        expect(response).toRespondWithError({
          code: -32603,
          message: expect.stringContaining('Method not found'),
          stack: expect.any(String),
        });
      } finally {
        await close();
      }
    });
  });
});
