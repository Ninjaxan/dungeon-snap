import { useState } from 'react';
import styled from 'styled-components';

import {
  ConnectButton,
  InstallFlaskButton,
  ReconnectButton,
  Card,
} from '../components';
import { defaultSnapOrigin } from '../config';
import {
  useMetaMask,
  useInvokeSnap,
  useMetaMaskContext,
  useRequestSnap,
} from '../hooks';
import { isLocalSnap, shouldDisplayReconnectButton } from '../utils';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  margin-top: 7.6rem;
  margin-bottom: 7.6rem;
  ${({ theme }) => theme.mediaQueries.small} {
    padding-left: 2.4rem;
    padding-right: 2.4rem;
    margin-top: 2rem;
    margin-bottom: 2rem;
    width: auto;
  }
`;

const Heading = styled.h1`
  margin-top: 0;
  margin-bottom: 2.4rem;
  text-align: center;
`;

const Span = styled.span`
  color: ${(props) => props.theme.colors.primary?.default};
`;

const Subtitle = styled.p`
  font-size: ${({ theme }) => theme.fontSizes.large};
  font-weight: 500;
  margin-top: 0;
  margin-bottom: 0;
  text-align: center;
  max-width: 60rem;
  ${({ theme }) => theme.mediaQueries.small} {
    font-size: ${({ theme }) => theme.fontSizes.text};
  }
`;

const CardContainer = styled.div`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: space-between;
  max-width: 64.8rem;
  width: 100%;
  height: 100%;
  margin-top: 1.5rem;
`;

const SmokeButton = styled.button`
  display: flex;
  align-self: flex-start;
  margin-top: auto;
  padding: 1rem 1.4rem;
  cursor: pointer;
  border-radius: ${({ theme }) => theme.radii.button};
  border: 1px solid ${({ theme }) => theme.colors.background?.inverse};
  background-color: ${({ theme }) => theme.colors.background?.inverse};
  color: ${({ theme }) => theme.colors.text?.inverse};
  font-weight: bold;
  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
`;

const Result = styled.pre`
  background: ${({ theme }) => theme.colors.background?.alternative};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.default};
  padding: 1rem;
  margin-top: 1rem;
  max-height: 16rem;
  overflow: auto;
  font-size: 1.1rem;
  white-space: pre-wrap;
  word-break: break-all;
`;

const ErrorMessage = styled.div`
  background-color: ${({ theme }) => theme.colors.error?.muted};
  border: 1px solid ${({ theme }) => theme.colors.error?.default};
  color: ${({ theme }) => theme.colors.error?.alternative};
  border-radius: ${({ theme }) => theme.radii.default};
  padding: 2.4rem;
  margin-bottom: 2.4rem;
  margin-top: 2.4rem;
  max-width: 60rem;
  width: 100%;
`;

type Output = { ok: true; data: unknown } | { ok: false; error: string };

const Index = () => {
  const { error } = useMetaMaskContext();
  const { isFlask, snapsDetected, installedSnap } = useMetaMask();
  const requestSnap = useRequestSnap();
  const invokeSnap = useInvokeSnap();
  const [outputs, setOutputs] = useState<Record<string, Output>>({});

  const isMetaMaskReady = isLocalSnap(defaultSnapOrigin)
    ? isFlask
    : snapsDetected;

  const run = async (label: string, method: string, params?: unknown) => {
    try {
      const data = await invokeSnap({ method, params: params as never });
      setOutputs((o) => ({ ...o, [label]: { ok: true, data } }));
    } catch (err) {
      setOutputs((o) => ({
        ...o,
        [label]: { ok: false, error: (err as Error).message },
      }));
    }
  };

  const renderOutput = (label: string) => {
    const out = outputs[label];
    if (!out) return null;
    if (out.ok) return <Result>{JSON.stringify(out.data, null, 2)}</Result>;
    return <Result>Error: {out.error}</Result>;
  };

  return (
    <Container>
      <Heading>
        <Span>Dungeon</Span> Snap
      </Heading>
      <Subtitle>
        Connect MetaMask Flask to your $DGN wallet on dungeon-1. Derive
        addresses, sign messages, send DGN — all from MetaMask.
      </Subtitle>
      <CardContainer>
        {error && (
          <ErrorMessage>
            <b>An error happened:</b> {error.message}
          </ErrorMessage>
        )}
        {!isMetaMaskReady && (
          <Card
            content={{
              title: 'Install Flask',
              description:
                'The Dungeon Snap requires MetaMask Flask, the developer build of MetaMask.',
              button: <InstallFlaskButton />,
            }}
            fullWidth
          />
        )}
        {!installedSnap && (
          <Card
            content={{
              title: 'Connect',
              description: 'Install the Dungeon Snap into MetaMask Flask.',
              button: (
                <ConnectButton
                  onClick={requestSnap}
                  disabled={!isMetaMaskReady}
                />
              ),
            }}
            disabled={!isMetaMaskReady}
          />
        )}
        {shouldDisplayReconnectButton(installedSnap) && (
          <Card
            content={{
              title: 'Reconnect',
              description: 'Reinstall the local Snap after a code change.',
              button: (
                <ReconnectButton
                  onClick={requestSnap}
                  disabled={!installedSnap}
                />
              ),
            }}
            disabled={!installedSnap}
          />
        )}
        <Card
          content={{
            title: 'Get Account',
            description: 'Derive the dungeon1 address from your MetaMask seed.',
            button: (
              <div style={{ width: '100%' }}>
                <SmokeButton
                  type="button"
                  onClick={() => run('account', 'dungeon_getAccount')}
                  disabled={!installedSnap}
                >
                  Get account
                </SmokeButton>
                {renderOutput('account')}
              </div>
            ),
          }}
          disabled={!installedSnap}
        />
        <Card
          content={{
            title: 'Get Balance',
            description:
              'Query DGN balance from api.dungeongames.io for your derived address.',
            button: (
              <div style={{ width: '100%' }}>
                <SmokeButton
                  type="button"
                  onClick={() => run('balance', 'dungeon_getBalance')}
                  disabled={!installedSnap}
                >
                  Get balance
                </SmokeButton>
                {renderOutput('balance')}
              </div>
            ),
          }}
          disabled={!installedSnap}
        />
        <Card
          content={{
            title: 'Show Account Dialog',
            description:
              'Pop the MetaMask info dialog with address + live balance.',
            button: (
              <div style={{ width: '100%' }}>
                <SmokeButton
                  type="button"
                  onClick={() => run('show', 'dungeon_showAccount')}
                  disabled={!installedSnap}
                >
                  Show account
                </SmokeButton>
                {renderOutput('show')}
              </div>
            ),
          }}
          disabled={!installedSnap}
        />
        <Card
          content={{
            title: 'Sign Message (ADR-036)',
            description:
              'Keplr-compat signature. Pops MetaMask approval, signs an ADR-036 sign doc.',
            button: (
              <div style={{ width: '100%' }}>
                <SmokeButton
                  type="button"
                  onClick={() =>
                    run('sign', 'dungeon_signADR036', {
                      message: `Login to Dungeon at ${new Date().toISOString()}`,
                    })
                  }
                  disabled={!installedSnap}
                >
                  Sign ADR-036
                </SmokeButton>
                {renderOutput('sign')}
              </div>
            ),
          }}
          disabled={!installedSnap}
        />
        <Card
          content={{
            title: 'Send 0.1 DGN',
            description:
              'Send 100,000 udgn to dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe (the snaps-jest test wallet).',
            button: (
              <div style={{ width: '100%' }}>
                <SmokeButton
                  type="button"
                  onClick={() =>
                    run('send', 'dungeon_sendTokens', {
                      recipient:
                        'dungeon1navfpzthnwes9g5xmgpwykdayukjavl8w6pehe',
                      amount: '100000',
                      memo: 'snap smoke',
                    })
                  }
                  disabled={!installedSnap}
                >
                  Send 0.1 DGN
                </SmokeButton>
                {renderOutput('send')}
              </div>
            ),
          }}
          disabled={!installedSnap}
          fullWidth
        />
      </CardContainer>
    </Container>
  );
};

export default Index;
