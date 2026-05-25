import type { OnRpcRequestHandler } from '@metamask/snaps-sdk';
import { Box, Heading, Text, Bold, Copyable, Divider } from '@metamask/snaps-sdk/jsx';
import { SLIP10Node } from '@metamask/key-tree';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { signAsync } from '@noble/secp256k1';
import { fromBech32, toBech32 } from '@cosmjs/encoding';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys';
import { TxBody, AuthInfo, SignDoc, TxRaw } from 'cosmjs-types/cosmos/tx/v1beta1/tx';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing';

const BECH32_PREFIX = 'dungeon';
const LCD_URL = 'https://api.dungeongames.io';
const COIN_DENOM = 'udgn';
const CHAIN_ID = 'dungeon-1';
const DEFAULT_GAS = 200_000n;
const DEFAULT_FEE_UDGN = 14_000n;

type Account = { address: string; pubkey: string };
type Keypair = Account & { pubkeyBytes: Uint8Array; privateKey: Uint8Array };

async function deriveKeypair(): Promise<Keypair> {
  const entropy = await snap.request({
    method: 'snap_getBip32Entropy',
    params: { path: ['m', "44'", "118'"], curve: 'secp256k1' },
  });
  const root = await SLIP10Node.fromJSON(entropy);
  const child = await root.derive(["bip32:0'", 'bip32:0', 'bip32:0']);
  if (!child.compressedPublicKeyBytes || !child.privateKeyBytes) {
    throw new Error('Failed to derive key material.');
  }
  const compressed = child.compressedPublicKeyBytes;
  const privateKey = child.privateKeyBytes;
  const addressBytes = ripemd160(sha256(compressed));
  const address = toBech32(BECH32_PREFIX, addressBytes);
  return {
    address,
    pubkey: Buffer.from(compressed).toString('base64'),
    pubkeyBytes: compressed,
    privateKey,
  };
}

async function deriveAccount(): Promise<Account> {
  const { address, pubkey } = await deriveKeypair();
  return { address, pubkey };
}

async function fetchBalance(address: string): Promise<string> {
  const url = `${LCD_URL}/cosmos/bank/v1beta1/balances/${address}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`LCD ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { balances: { denom: string; amount: string }[] };
  const dgn = body.balances.find((b) => b.denom === COIN_DENOM);
  return dgn ? dgn.amount : '0';
}

function formatDgn(udgn: string): string {
  const n = BigInt(udgn);
  const whole = n / 1_000_000n;
  const frac = (n % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac.length ? `${whole.toString()}.${frac}` : whole.toString();
}

function sortedJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => sortedJsonStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${sortedJsonStringify(obj[k])}`).join(',')}}`;
}

function buildADR036SignDoc(signer: string, message: string): Uint8Array {
  const dataB64 = Buffer.from(new TextEncoder().encode(message)).toString('base64');
  const doc = {
    account_number: '0',
    chain_id: '',
    fee: { amount: [], gas: '0' },
    memo: '',
    msgs: [
      {
        type: 'sign/MsgSignData',
        value: { data: dataB64, signer },
      },
    ],
    sequence: '0',
  };
  return new TextEncoder().encode(sortedJsonStringify(doc));
}

function previewMessage(message: string): string {
  const max = 240;
  return message.length > max ? `${message.slice(0, max)}…` : message;
}

function assertDungeonAddress(addr: unknown): asserts addr is string {
  if (typeof addr !== 'string') {
    throw new Error('recipient must be a dungeon1... address (got non-string).');
  }
  let decoded;
  try {
    decoded = fromBech32(addr);
  } catch {
    throw new Error('recipient must be a dungeon1... address (failed bech32 decode).');
  }
  if (decoded.prefix !== BECH32_PREFIX) {
    throw new Error(`recipient must be a dungeon1... address (got prefix "${decoded.prefix}").`);
  }
  if (decoded.data.length !== 20) {
    throw new Error('recipient must be a dungeon1... address (wrong byte length).');
  }
}

function assertPositiveBigIntString(amount: unknown, field: string): asserts amount is string {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
    throw new Error(`${field} must be a non-negative integer string (udgn).`);
  }
  if (BigInt(amount) <= 0n) {
    throw new Error(`${field} must be greater than 0.`);
  }
}

type AccountInfo = { accountNumber: bigint; sequence: bigint };

async function fetchAccountInfo(address: string): Promise<AccountInfo> {
  const res = await fetch(`${LCD_URL}/cosmos/auth/v1beta1/accounts/${address}`);
  if (!res.ok) {
    throw new Error(`LCD account fetch ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    account?: { account_number?: string; sequence?: string };
  };
  if (!body.account || body.account.account_number === undefined) {
    throw new Error('Account does not exist on chain. Receive DGN first to initialize.');
  }
  return {
    accountNumber: BigInt(body.account.account_number),
    sequence: BigInt(body.account.sequence ?? '0'),
  };
}

type SendParams = {
  recipient: string;
  amount: string;
  memo: string;
  feeAmount: bigint;
  gasLimit: bigint;
};

type SignedTx = {
  txBytes: Uint8Array;
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signature: Uint8Array;
};

export async function buildSignedSendTx(
  keypair: { address: string; pubkeyBytes: Uint8Array; privateKey: Uint8Array },
  params: SendParams,
  account: AccountInfo,
): Promise<SignedTx> {
  const msgSend = MsgSend.fromPartial({
    fromAddress: keypair.address,
    toAddress: params.recipient,
    amount: [{ denom: COIN_DENOM, amount: params.amount }],
  });
  const msgAny = {
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: MsgSend.encode(msgSend).finish(),
  };

  const txBody = TxBody.fromPartial({
    messages: [msgAny],
    memo: params.memo,
    timeoutHeight: 0n,
  });
  const bodyBytes = TxBody.encode(txBody).finish();

  const pubKeyProto = PubKey.fromPartial({ key: keypair.pubkeyBytes });
  const pubKeyAny = {
    typeUrl: '/cosmos.crypto.secp256k1.PubKey',
    value: PubKey.encode(pubKeyProto).finish(),
  };

  const authInfo = AuthInfo.fromPartial({
    signerInfos: [
      {
        publicKey: pubKeyAny,
        modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } },
        sequence: account.sequence,
      },
    ],
    fee: {
      amount: [{ denom: COIN_DENOM, amount: params.feeAmount.toString() }],
      gasLimit: params.gasLimit,
      payer: '',
      granter: '',
    },
  });
  const authInfoBytes = AuthInfo.encode(authInfo).finish();

  const signDoc = SignDoc.fromPartial({
    bodyBytes,
    authInfoBytes,
    chainId: CHAIN_ID,
    accountNumber: account.accountNumber,
  });
  const signDocBytes = SignDoc.encode(signDoc).finish();
  const digest = sha256(signDocBytes);
  const signature = await signAsync(digest, keypair.privateKey, { prehash: false });

  const txRaw = TxRaw.fromPartial({
    bodyBytes,
    authInfoBytes,
    signatures: [signature],
  });
  const txBytes = TxRaw.encode(txRaw).finish();

  return { txBytes, bodyBytes, authInfoBytes, signature };
}

async function broadcastTx(txBytes: Uint8Array): Promise<{
  txhash: string;
  code: number;
  rawLog: string;
}> {
  const tx_bytes = Buffer.from(txBytes).toString('base64');
  const res = await fetch(`${LCD_URL}/cosmos/tx/v1beta1/txs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx_bytes, mode: 'BROADCAST_MODE_SYNC' }),
  });
  if (!res.ok) {
    throw new Error(`Broadcast ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    tx_response: { txhash: string; code: number; raw_log: string };
  };
  return {
    txhash: body.tx_response.txhash,
    code: body.tx_response.code,
    rawLog: body.tx_response.raw_log,
  };
}

export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) => {
  switch (request.method) {
    case 'dungeon_getAccount': {
      return await deriveAccount();
    }

    case 'dungeon_getBalance': {
      const { address } = await deriveAccount();
      const udgn = await fetchBalance(address);
      return { denom: COIN_DENOM, amount: udgn, display: `${formatDgn(udgn)} DGN` };
    }

    case 'dungeon_showAccount': {
      const { address } = await deriveAccount();
      let balanceLine: string;
      try {
        const udgn = await fetchBalance(address);
        balanceLine = `${formatDgn(udgn)} DGN`;
      } catch (err) {
        balanceLine = `Balance fetch failed: ${(err as Error).message}`;
      }
      return snap.request({
        method: 'snap_dialog',
        params: {
          type: 'alert',
          content: (
            <Box>
              <Heading>Dungeon Wallet</Heading>
              <Text>
                <Bold>Address</Bold>
              </Text>
              <Copyable value={address} />
              <Divider />
              <Text>
                <Bold>Balance</Bold>
              </Text>
              <Text>{balanceLine}</Text>
            </Box>
          ),
        },
      });
    }

    case 'dungeon_signADR036':
    case 'dungeon_signArbitrary': {
      const params = (request.params ?? {}) as { message?: unknown };
      if (typeof params.message !== 'string' || params.message.length === 0) {
        throw new Error('dungeon_signArbitrary requires { message: string }.');
      }
      const message = params.message;
      const { address, pubkey, privateKey } = await deriveKeypair();

      const approved = (await snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Heading>Sign message</Heading>
              <Text>
                <Bold>{origin}</Bold> is requesting your signature.
              </Text>
              <Divider />
              <Text>
                <Bold>Signer</Bold>
              </Text>
              <Copyable value={address} />
              <Divider />
              <Text>
                <Bold>Message</Bold>
              </Text>
              <Text>{previewMessage(message)}</Text>
            </Box>
          ),
        },
      })) as boolean;

      if (!approved) {
        throw new Error('User rejected the signature request.');
      }

      const signBytes =
        request.method === 'dungeon_signADR036'
          ? buildADR036SignDoc(address, message)
          : new TextEncoder().encode(message);
      const digest = sha256(signBytes);
      const sig = await signAsync(digest, privateKey, { prehash: false });

      return {
        signature: Buffer.from(sig).toString('base64'),
        pubkey,
        address,
        scheme: request.method === 'dungeon_signADR036' ? 'adr-036' : 'raw-sha256',
      };
    }

    case 'dungeon_buildSendTx':
    case 'dungeon_sendTokens': {
      const params = (request.params ?? {}) as {
        recipient?: unknown;
        amount?: unknown;
        memo?: unknown;
      };
      assertDungeonAddress(params.recipient);
      assertPositiveBigIntString(params.amount, 'amount');
      const recipient: string = params.recipient;
      const amount: string = params.amount;
      const memo = typeof params.memo === 'string' ? params.memo : '';
      const feeAmount = DEFAULT_FEE_UDGN;
      const gasLimit = DEFAULT_GAS;

      const keypair = await deriveKeypair();

      const approved = (await snap.request({
        method: 'snap_dialog',
        params: {
          type: 'confirmation',
          content: (
            <Box>
              <Heading>Send DGN</Heading>
              <Text>
                <Bold>{origin}</Bold> is requesting a transfer.
              </Text>
              <Divider />
              <Text>
                <Bold>From</Bold>
              </Text>
              <Copyable value={keypair.address} />
              <Text>
                <Bold>To</Bold>
              </Text>
              <Copyable value={recipient} />
              <Divider />
              <Text>
                <Bold>Amount</Bold>
              </Text>
              <Text>{`${formatDgn(amount)} DGN`}</Text>
              <Text>
                <Bold>Fee</Bold>
              </Text>
              <Text>{`${formatDgn(feeAmount.toString())} DGN (gas ${gasLimit.toString()})`}</Text>
              {memo ? (
                <Box>
                  <Divider />
                  <Text>
                    <Bold>Memo</Bold>
                  </Text>
                  <Text>{previewMessage(memo)}</Text>
                </Box>
              ) : null}
            </Box>
          ),
        },
      })) as boolean;

      if (!approved) {
        throw new Error('User rejected the transfer.');
      }

      const account = await fetchAccountInfo(keypair.address);
      const signed = await buildSignedSendTx(
        keypair,
        { recipient, amount, memo, feeAmount, gasLimit },
        account,
      );

      if (request.method === 'dungeon_buildSendTx') {
        return {
          txBytes: Buffer.from(signed.txBytes).toString('base64'),
          accountNumber: account.accountNumber.toString(),
          sequence: account.sequence.toString(),
          signature: Buffer.from(signed.signature).toString('base64'),
        };
      }

      const result = await broadcastTx(signed.txBytes);
      return {
        txhash: result.txhash,
        code: result.code,
        rawLog: result.rawLog,
      };
    }

    case 'dungeon_swapAndBridgeToCard': {
      throw new Error(
        'dungeon_swapAndBridgeToCard is not yet implemented. ' +
          'It depends on Skip Router supporting dungeon-1 — submit a chain-registry PR to skip-mev first. ' +
          'See README.md "Slice 3" section for details.',
      );
    }

    default:
      throw new Error(`Method not found: ${request.method}`);
  }
};
