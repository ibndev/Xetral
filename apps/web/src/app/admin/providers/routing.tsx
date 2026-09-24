'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatMinor } from '@xetral/client';
import type {
  AdminRoute,
  AdminRouting,
  AdminRoutingMode,
  AdminRoutingPolicy,
  AdminTreasury,
  ApiErrorCode,
} from '@xetral/client';
import { useAdmin } from '@/lib/hooks';
import { messageFor } from '@/lib/errors';
import { AdminError } from '../access';

/**
 * HOW THE WHOLE GRID IS READ, as one decision rather than thirteen switches.
 *
 * The product owner's three sentences, each a mode: every corridor decided on
 * its own row; each provider carrying the currencies it documents, one of
 * them preferred where two can; one provider carrying everything it can.
 * Plus the one switch that decides whether a refused account request may try
 * the next rail — which is what made Activate account fail in both countries.
 *
 * NOTHING IS SAVED BY PICKING. The panel shows, live, who would serve every
 * corridor under the choice being made — the only honest preview of a mode
 * change — and the PIN sits beside the Save that applies it.
 */
export function RoutingPolicyPanel(props: {
  readonly routing: AdminRouting | undefined;
  readonly error: string | undefined;
  readonly code: ApiErrorCode | undefined;
  readonly onChanged: () => void;
}) {
  const admin = useAdmin();
  const live = props.routing?.policy;
  const [draft, setDraft] = useState<AdminRoutingPolicy | undefined>(live);
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();

  // A reload replaces the draft only while nothing is being edited — an
  // operator mid-choice must not have it reset under them.
  useEffect(() => {
    if (live !== undefined && (draft === undefined || !changed(draft, live))) setDraft(live);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  const providers = useMemo(() => providersOf(props.routing), [props.routing]);
  const preview = useMemo(
    () => (props.routing === undefined || draft === undefined ? [] : previewOf(props.routing, draft)),
    [props.routing, draft],
  );

  if (props.routing === undefined || draft === undefined || live === undefined) {
    return (
      <div className="panel policy-panel">
        <div className="panel-row-head">
          <span className="sec">How money is routed</span>
        </div>
        <AdminError error={props.error} code={props.code} role="support" />
      </div>
    );
  }

  const dirty = changed(draft, live);
  const incomplete =
    (draft.mode === 'single' && draft.single_provider === null) ||
    (draft.mode === 'by_coverage' && draft.preferred_provider === null);

  function pick(mode: AdminRoutingMode): void {
    setDone(undefined);
    setError(undefined);
    setDraft((d) =>
      d === undefined
        ? d
        : {
            ...d,
            mode,
            // Carry the other mode's choice across rather than blanking it:
            // "Flutterwave for everything" and "Flutterwave where it can" are
            // usually the same operator's next thought.
            single_provider: mode === 'single' ? (d.single_provider ?? d.preferred_provider ?? providers[0] ?? null) : d.single_provider,
            preferred_provider:
              mode === 'by_coverage' ? (d.preferred_provider ?? d.single_provider ?? providers[0] ?? null) : d.preferred_provider,
          },
    );
  }

  async function save(): Promise<void> {
    if (draft === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      await admin.setRouting(
        {
          mode: draft.mode,
          preferred_provider: draft.mode === 'by_coverage' ? draft.preferred_provider : null,
          single_provider: draft.mode === 'single' ? draft.single_provider : null,
          account_fallback: draft.account_fallback,
        },
        pin,
      );
      setDone(`Saved. ${MODES[draft.mode].title}${draft.mode === 'per_route' ? '' : ` — ${nameOf((draft.mode === 'single' ? draft.single_provider : draft.preferred_provider) ?? '')}`}.`);
      setPin('');
      props.onChanged();
    } catch (caught: unknown) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel policy-panel">
      <div className="panel-row-head">
        <span className="sec">How money is routed</span>
        <span className="badge ok">{MODES[live.mode].title}</span>
      </div>
      <p className="lead policy-lead">
        Decide who opens account numbers, collects and pays out. Nothing
        already issued moves: an account number keeps receiving where it was
        opened and a payout in flight settles on its own rail.
      </p>
      <AdminError error={props.error} code={props.code} role="support" />

      <div className="mode-grid" role="radiogroup" aria-label="Routing mode">
        {(Object.keys(MODES) as AdminRoutingMode[]).map((mode) => {
          const on = draft.mode === mode;
          return (
            <button
              type="button"
              key={mode}
              role="radio"
              aria-checked={on}
              className={`mode-card${on ? ' on' : ''}`}
              onClick={() => pick(mode)}
            >
              <span className="mode-dot" aria-hidden />
              <span className="mode-title">{MODES[mode].title}</span>
              <span className="mode-sub">{MODES[mode].sub}</span>
            </button>
          );
        })}
      </div>

      {draft.mode !== 'per_route' && (
        <div className="policy-row">
          <div className="policy-row-text">
            <span className="name">
              {draft.mode === 'single' ? 'The provider' : 'Preferred where two can'}
            </span>
            <span className="sub">
              {draft.mode === 'single'
                ? 'Carries every corridor it covers. What it does not cover stays on the corridor rows below.'
                : 'Each provider serves the currencies it covers; this one wins where more than one does.'}
            </span>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Provider">
            {providers.map((p) => {
              const chosen = (draft.mode === 'single' ? draft.single_provider : draft.preferred_provider) === p;
              return (
                <button
                  type="button"
                  key={p}
                  role="radio"
                  aria-checked={chosen}
                  className={chosen ? 'active' : undefined}
                  onClick={() =>
                    setDraft((d) =>
                      d === undefined
                        ? d
                        : d.mode === 'single'
                          ? { ...d, single_provider: p }
                          : { ...d, preferred_provider: p },
                    )
                  }
                >
                  {nameOf(p)}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <label className="policy-row policy-toggle">
        <span className="policy-row-text">
          <span className="name">Try the next provider when an account number is refused</span>
          <span className="sub">
            Flutterwave and Bitnob open a naira account only for a verified
            customer. With this on, Paystack opens one for everybody else.
            Only a definite refusal moves on — never a timeout, which may
            already have opened an account.
          </span>
        </span>
        <span className="switch">
          <input
            type="checkbox"
            role="switch"
            checked={draft.account_fallback}
            onChange={(e) => setDraft((d) => (d === undefined ? d : { ...d, account_fallback: e.target.checked }))}
          />
          <span className="switch-track" aria-hidden />
        </span>
      </label>

      <div className="policy-preview">
        <div className="policy-preview-head">
          <span className="name">{dirty ? 'Who would serve each corridor' : 'Who serves each corridor'}</span>
          {dirty && <span className="badge warn">Not saved</span>}
        </div>
        <div className="serve-grid" role="table" aria-label="Who serves each corridor">
          <div className="serve-row head" role="row">
            <span role="columnheader">Money</span>
            <span role="columnheader">Currency</span>
            <span role="columnheader">Served by</span>
            <span role="columnheader">Then</span>
          </div>
          {preview.map((cell) => (
            <div
              className={`serve-row${cell.moved ? ' moved' : ''}`}
              role="row"
              key={`${cell.operation}:${cell.currency}`}
            >
              <span role="cell" className="op">{OPERATION_LABEL[cell.operation]}</span>
              <span role="cell" className="mono ccy">{cell.currency}</span>
              <span role="cell">
                {cell.serving === null ? (
                  <span className="badge danger">Nobody</span>
                ) : (
                  <span className="served">
                    {nameOf(cell.serving)}
                    {cell.moved && <span className="was">was {cell.was === null ? 'nobody' : nameOf(cell.was)}</span>}
                  </span>
                )}
              </span>
              <span role="cell" className="then">
                {cell.then.length === 0 ? '—' : cell.then.map(nameOf).join(', ')}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="policy-save">
        {done !== undefined && !dirty && <p className="route-done">{done}</p>}
        {dirty && (
          <div className="route-confirm-row">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              placeholder="PIN"
              aria-label="Transaction PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
            <button type="button" disabled={saving || pin === '' || incomplete} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save routing'}
            </button>
            <button type="button" className="ghost" onClick={() => setDraft(live)}>
              Discard
            </button>
          </div>
        )}
        {error !== undefined && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * CAN EACH RAIL PAY WHAT CUSTOMERS HOLD?
 *
 * Three figures that disagree, side by side: what customers are owed, what
 * the ledger says the platform holds (every provider together), and what each
 * provider really holds. The gap between the second and the third is how a
 * customer comes to hold cedis no rail can send. No button here moves money
 * between providers — that is a transfer a person makes — so the panel names
 * the rail and the balance that would close each gap.
 */
export function TreasuryPanel(props: { readonly treasury: AdminTreasury | undefined }) {
  const t = props.treasury;
  if (t === undefined || t.lines.length === 0) return null;
  const unreadable = t.rails.filter((r) => !r.readable).map((r) => nameOf(r.provider));

  return (
    <div className="panel tbl-panel treasury-panel">
      <div className="panel-row-head">
        <span className="sec">Can each rail pay what customers hold?</span>
      </div>
      <p className="lead policy-lead">
        The ledger counts one float per currency for every provider together.
        Money collected at Paystack, or credited by a conversion the platform
        priced itself, reads as held while the rail that pays it out has none.
        Fund the payout rail&rsquo;s balance in that currency, or set{' '}
        <span className="mono">payout_debit_currencies</span> on Settings to pay
        it from another balance at the provider&rsquo;s rate.
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Currency</th>
              <th className="right">Customers hold</th>
              <th className="right">Ledger says held</th>
              {t.rails.map((r) => (
                <th className="right" key={r.provider}>
                  {nameOf(r.provider)}
                </th>
              ))}
              <th>Payouts go out on</th>
            </tr>
          </thead>
          <tbody>
            {t.lines.map((line) => {
              const short = line.payout_rail_short_minor !== null && line.payout_rail_short_minor !== '0';
              return (
                <tr key={line.currency}>
                  <td className="mono">{line.currency}</td>
                  <td className="right amount">{formatMinor(line.owed_minor, line.currency)}</td>
                  <td className="right amount muted">{formatMinor(line.ledger_held_minor, line.currency)}</td>
                  {line.live.map((cell) => (
                    <td
                      className={`right amount${cell.provider === line.payout_rail ? ' strong' : ' muted'}`}
                      key={cell.provider}
                    >
                      {cell.available_minor === null ? (
                        <span className="muted">unreadable</span>
                      ) : (
                        formatMinor(cell.available_minor, line.currency)
                      )}
                    </td>
                  ))}
                  <td>
                    {line.payout_rail === null ? (
                      <span className="muted">not routed</span>
                    ) : (
                      <span className="rail-verdict">
                        {nameOf(line.payout_rail)}
                        {line.debit_currency !== null ? (
                          <span className="badge quiet">pays from {line.debit_currency}</span>
                        ) : short ? (
                          <span className="badge danger">
                            short {formatMinor(line.payout_rail_short_minor as string, line.currency)}
                          </span>
                        ) : line.payout_rail_short_minor === '0' ? (
                          <span className="badge ok">covered</span>
                        ) : null}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unreadable.length > 0 && (
        <p className="hint treasury-hint">
          {unreadable.join(' and ')} {unreadable.length === 1 ? 'has' : 'have'} no balance this
          platform can read, so {unreadable.length === 1 ? 'its column is' : 'their columns are'}{' '}
          blank rather than zero.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------ */

const MODES: Readonly<Record<AdminRoutingMode, { title: string; sub: string }>> = {
  per_route: {
    title: 'Per corridor',
    sub: 'Each row below decides on its own.',
  },
  by_coverage: {
    title: 'By coverage',
    sub: 'Every provider carries the currencies it documents.',
  },
  single: {
    title: 'One provider',
    sub: 'One company carries everything it can.',
  },
};

const OPERATION_LABEL: Readonly<Record<AdminRoute['operation'], string>> = {
  account: 'Account numbers',
  collect: 'Checkouts',
  payout: 'Payouts',
};

const NAMES: Readonly<Record<string, string>> = {
  flutterwave: 'Flutterwave',
  bitnob: 'Bitnob',
  paystack: 'Paystack',
};

export function nameOf(provider: string): string {
  return NAMES[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function changed(a: AdminRoutingPolicy, b: AdminRoutingPolicy): boolean {
  return (
    a.mode !== b.mode ||
    a.account_fallback !== b.account_fallback ||
    (a.mode === 'single' && a.single_provider !== b.single_provider) ||
    (a.mode === 'by_coverage' && a.preferred_provider !== b.preferred_provider)
  );
}

/** Providers this deployment can call for anything, in a stable order. */
function providersOf(routing: AdminRouting | undefined): readonly string[] {
  const all = new Set<string>();
  for (const list of Object.values(routing?.configured ?? {})) for (const p of list) all.add(p);
  return ['flutterwave', 'bitnob', 'paystack'].filter((p) => all.has(p));
}

interface PreviewCell {
  readonly operation: AdminRoute['operation'];
  readonly currency: string;
  readonly serving: string | null;
  readonly then: readonly string[];
  readonly was: string | null;
  readonly moved: boolean;
}

/**
 * WHO WOULD SERVE EACH CORRIDOR under a policy not yet saved.
 *
 * The same ordering `ProviderRouterService.candidates()` applies on the
 * server, restated here so the preview can answer before anything is sent. It
 * only ever PREVIEWS: what serves a customer is the server's answer, and the
 * grid is re-read from it after every save.
 */
function previewOf(routing: AdminRouting, policy: AdminRoutingPolicy): readonly PreviewCell[] {
  return routing.effective.map((cell) => {
    const configured = routing.configured[cell.operation] ?? [];
    const covering = routing.coverage
      .filter((c) => c.operation === cell.operation && c.currency === cell.currency)
      .map((c) => c.provider);
    const ordered: string[] = [];
    const push = (p: string | null): void => {
      if (p !== null && !ordered.includes(p)) ordered.push(p);
    };
    if (policy.mode === 'single' && policy.single_provider !== null && covering.includes(policy.single_provider)) {
      push(policy.single_provider);
    }
    if (policy.mode === 'by_coverage' && covering.length > 0) {
      if (policy.preferred_provider !== null && covering.includes(policy.preferred_provider)) {
        push(policy.preferred_provider);
      }
      if (cell.routed !== null && covering.includes(cell.routed)) push(cell.routed);
      for (const p of ['flutterwave', 'bitnob', 'paystack']) if (covering.includes(p)) push(p);
    }
    push(cell.routed);
    for (const p of ['flutterwave', 'bitnob', 'paystack']) if (covering.includes(p)) push(p);

    const usable = ordered.filter((p) => configured.includes(p));
    const serving = policy.mode === 'per_route' ? cell.routed : (ordered[0] ?? null);
    // Fallbacks shown only where something would actually try them: account
    // numbers with the fallback on, and wallet payouts when a rail is short.
    const then =
      (cell.operation === 'account' && policy.account_fallback) ||
      (cell.operation === 'payout' && policy.mode !== 'single')
        ? usable.filter((p) => p !== serving)
        : [];
    return {
      operation: cell.operation,
      currency: cell.currency,
      serving,
      then,
      was: cell.serving,
      moved: serving !== cell.serving,
    };
  });
}
