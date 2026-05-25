# Dungeon Snap

A MetaMask Snap that turns your MetaMask into a full wallet for the **dungeon-1** Cosmos chain. Derive a `dungeon1...` address from your existing MetaMask seed, view your **$DGN** balance, sign messages, and send DGN — all without leaving MetaMask.

Built for the [Dungeon platform](https://dungeongames.io) — DEX, NFT Marketplace, Kosmic Quest, and Cosmos validator services.

---

## What works today

Slice-by-slice build status. Each slice shipped with green tests.

| RPC method | Status | Description |
|---|---|---|
| `dungeon_getAccount` | shipped | Returns `{ address, pubkey }` derived via SLIP-44 coin type 118. |
| `dungeon_getBalance` | shipped | Queries live DGN balance from `api.dungeongames.io`. |
| `dungeon_showAccount` | shipped | Displays an info dialog with address + balance. |
| `dungeon_signArbitrary` | shipped | Raw SHA256 message signing. Returns 64-byte compact secp256k1 signature. |
| `dungeon_signADR036` | shipped | Keplr-compatible ADR-036 message signing. Same shape, signs over the canonical sign doc. |
| `dungeon_buildSendTx` | shipped | Builds + signs a `MsgSend` tx without broadcasting. Returns `{ txBytes, accountNumber, sequence, signature }`. |
| `dungeon_sendTokens` | shipped | Signs and broadcasts a `MsgSend` tx via the LCD. Returns `{ txhash, code, rawLog }`. |
| `dungeon_swapAndBridgeToCard` | not implemented | Skip Router cross-chain "Spend my DGN" flow. Blocked on Skip chain-registry PR. |

---

## Quick start (developer)

```bash
# install deps + initial build
yarn install
yarn workspace dungeon-snap build

# run the test suite (rebuilds bundle then runs jest)
yarn workspace dungeon-snap test

# start local Snap server on http://localhost:8080
yarn workspace dungeon-snap serve

# in another shell, run the companion site
yarn workspace site start
```

Open [MetaMask Flask](https://metamask.io/flask/), point your browser at `http://localhost:8000`, and click **Connect** to install the local Snap.

---

## Calling the Snap from your dapp

```ts
// Install the snap (user prompts once)
await window.ethereum.request({
  method: 'wallet_requestSnaps',
  params: { 'npm:dungeon-snap': {} },
});

// Get the user's dungeon-1 address
const { address, pubkey } = await window.ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'npm:dungeon-snap',
    request: { method: 'dungeon_getAccount' },
  },
});

// Send 1 DGN
const { txhash } = await window.ethereum.request({
  method: 'wallet_invokeSnap',
  params: {
    snapId: 'npm:dungeon-snap',
    request: {
      method: 'dungeon_sendTokens',
      params: { recipient: 'dungeon1...', amount: '1000000', memo: 'hi' },
    },
  },
});
```

---

## Architecture

- **`packages/snap`** — the Snap itself. Bundles to `dist/bundle.js` (~290KB).
- **`packages/site`** — companion Gatsby site for manual smoke-testing.
- **Key derivation:** `@metamask/key-tree` over `snap_getBip32Entropy` (path `m/44'/118'/0'/0/0`).
- **Crypto:** `@noble/hashes` (SHA256, RIPEMD160) + `@noble/secp256k1` (ECDSA sign).
- **Bech32:** `@cosmjs/encoding` for `dungeon` prefix encoding.
- **Protobuf:** `cosmjs-types` for `MsgSend`, `TxBody`, `AuthInfo`, `SignDoc`, `TxRaw`.
- **Why NOT `@cosmjs/crypto`:** its transitive dep `@noble/curves` ships a method named `.eval`, which MetaMask's SES sandbox rejects via regex. Use `@metamask/key-tree` + `@noble/hashes` + `@noble/secp256k1` instead.

---

## Slice 3 (Skip Router) is blocked

The flagship "Spend my DGN" flow swaps DGN → USDC on the Dungeon DEX, bridges to Linea via Axelar GMP, and leaves the funds spendable with MetaMask Card. This requires Skip Router to support dungeon-1.

**Unblock path:**
1. Submit a chain-registry PR to [skip-mev/networks](https://github.com/skip-mev/networks) for dungeon-1 with its IBC channels to Axelar.
2. Wait for Skip to deploy support for dungeon-1.
3. Wire up `@skip-go/client` in this Snap. The `dungeon_swapAndBridgeToCard` method already exists with a clear error pointing here.

---

## Chain config (verified 2026-05-25)

- **Chain ID:** `dungeon-1`
- **SLIP-44 coin type:** `118` (standard Cosmos)
- **Bech32 prefix:** `dungeon`
- **Native denom:** `udgn` (1 DGN = 1,000,000 udgn)
- **LCD endpoint:** `https://api.dungeongames.io`
- **Min gas price:** 0.05 udgn/gas
- **Snap defaults:** gas 200,000 + fee 14,000 udgn (0.014 DGN) per send

---

## Test coverage

13 tests, all green via `yarn workspace dungeon-snap test`:

- Derives a valid `dungeon1` bech32 address
- Derivation is deterministic
- Balance fetches from live LCD
- ADR-036 + raw-sha256 signing produce 64-byte low-S signatures
- Signing is deterministic (RFC6979)
- User-reject paths throw clean errors
- Send rejects invalid bech32, zero amounts, and user-cancels
- Send surfaces "account does not exist" cleanly for unfunded test wallets

---

## AI play-agent

`tools/play-snap-agent.cjs` is an automated smoke runner. It launches Chrome with MetaMask Flask loaded, drives the companion site through every smoke action, auto-clicks Flask approval popups, screenshots each step, and (with `--review`) sends the screenshot reel to Claude Sonnet for visual bug-flagging.

### One-time setup

1. Download MetaMask Flask Chrome zip from [the GitHub releases](https://github.com/MetaMask/metamask-extension/releases) — look for `metamask-flask-chrome-<version>-flask.0.zip`.
2. Extract to `.flask-extension/` at the repo root (so `manifest.json` is at `.flask-extension/manifest.json`).
3. Start the snap server in one terminal: `yarn workspace dungeon-snap serve`.
4. Start the companion site in another: `yarn workspace site start`.
5. Run the agent: `node tools/play-snap-agent.cjs`.
6. On the first run, you'll need to onboard Flask (set password, import/create a test seed). The profile is saved to `~/.dungeon-snap-flask-profile/` and reused on subsequent runs.

### Modes

```
node tools/play-snap-agent.cjs            # headed, no AI review
node tools/play-snap-agent.cjs --review   # adds Claude Sonnet vision pass
node tools/play-snap-agent.cjs --headless # CI mode
```

Outputs land in `ai-reports/play-session/<timestamp>/`: screenshots + `session.log` + `vision-review.md` (if `--review`).

---

## License

MIT — see [LICENSE](./LICENSE).
