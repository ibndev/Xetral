'use client';

import { useEffect, useState } from 'react';
import {
  exponentFor,
  formatAmount,
  isValidAmount,
  nationalPhone,
  paymentLinkFor,
  REQUEST_NOTE_MAX,
  requestLinkFor,
  symbolFor,
} from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { FormError } from '@/ui/form-error';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
import { useLoad, useXetral } from '@/lib/hooks';

/**
 * ASKING TO BE PAID.
 *
 * IT WAS A PANEL AT THE BOTTOM OF ADD MONEY, and the home screen's Request
 * action and its Add action went to the SAME ROUTE — so a customer who tapped
 * Request landed on a page headed "Add money" and had to scroll past an
 * account number to find what they came for. Two of four actions leading to
 * one screen is a product saying it has three.
 *
 * TWO IDENTIFIERS, FOR TWO DIFFERENT PEOPLE, and 058's rule about why they
 * are not one string: the NUMBER is what another Xetral customer types into
 * Send; the LINK is a checkout a stranger pays on, so its address must not be
 * the number a customer's bank, contacts and two-factor codes are attached
 * to.
 *
 * AND NOW THE COMP'S REQUEST CARD, on the product owner's instruction — with
 * the objection that kept it out answered rather than ignored. The objection
 * was that a link which IGNORED a typed amount would be worse than none. So
 * the amount is not ignored: it rides on the link (`requestLinkFor`) and the
 * checkout opens with it filled in, beside the reason, for the payer to read.
 * It is still the payer who pays, and the server still credits what was
 * paid — a request is a prefill, never a claim the API trusts.
 *
 * THE COMP'S "PENDING REQUESTS" LIST IS NOT DRAWN. It names who was asked
 * and whether they paid, which needs a table of requests against people that
 * this platform does not keep — a list of links nobody can mark as settled
 * would be a list that is wrong from the first payment.
 */
export default function Request() {
  const client = useXetral();
  const profile = useLoad(() => client.profile(), [client]);
  const session = useLoad(() => client.currentSession(), [client]);
  /* The customer's own country row, for its dialling code — the same lookup
     Add money does, because the code lives on the country and not on the
     session. A missing row costs the trim and nothing else. */
  const countries = useLoad(() => client.session.countries(), [client]);
  const here = countries.data?.find((c) => c.code === session.data?.country);
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedRequest, setCopiedRequest] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState('');
  const [made, setMade] = useState<{ url: string; amount: string; currency: string } | undefined>();

  /*
   * THE ORIGIN THIS PAGE IS ALREADY BEING SERVED FROM, as the fallback for a
   * link the API could not build. With `APP_BASE_URL` unset the server
   * returns none, and "this deployment has no public address set" is an
   * operator's problem printed where a customer is standing — on the screen
   * they opened in order to ask to be paid.
   *
   * Read in an effect rather than during render, because `window` does not
   * exist on the server and a value that differs between the two is a
   * hydration mismatch. Configuration still WINS when it is set.
   */
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const phone = profile.data?.phone ?? null;
  // Their own dialling code, so it can come OFF the number: the Send screen
  // puts a dialling-code picker in front of its phone field, so the national
  // form is exactly what a sender types and the code shown beside it is a
  // prefix somebody would type twice.
  const local = nationalPhone(phone, here?.dial_code);
  const slug = profile.data?.slug ?? null;
  const link =
    profile.data?.link ?? (slug !== null && origin !== '' ? paymentLinkFor(origin, slug) : null);

  /* Their own money first, then dollars — the two a stranger abroad is
     likeliest to hold. The checkout still offers whatever the route table
     can collect; this is only what the request is written in. */
  const home = session.data?.home_currency ?? 'NGN';
  const currencies = [...new Set([home, 'USD'])];
  const currency = picked === '' ? home : picked;
  const valid = amount.trim() !== '' && isValidAmount(amount, exponentFor(currency)) && !/^0+(\.0+)?$/.test(amount.trim());

  function create(): void {
    if (link === null || !valid) return;
    setCopiedRequest(false);
    setMade({
      url: requestLinkFor(link, { amount: amount.trim(), currency, ...(note.trim() === '' ? {} : { note: note.trim() }) }),
      amount: amount.trim(),
      currency,
    });
  }

  function share(url: string): void {
    const text = `Pay me ${formatAmount(made?.amount ?? '0', made?.currency ?? currency)}${note.trim() === '' ? '' : ` for ${note.trim()}`} on Xetral`;
    if (typeof navigator.share === 'function') {
      void navigator.share({ title: 'Payment request', text, url }).catch(() => undefined);
    } else {
      copy(url, setCopiedRequest);
    }
  }

  function copy(text: string, mark: (v: boolean) => void): void {
    if (text === '') return;
    void navigator.clipboard
      ?.writeText(text)
      // A clipboard the browser refused is not worth a banner — the value is
      // on screen and can be selected.
      .then(() => mark(true))
      .catch(() => undefined);
  }

  return (
    <Shell back="/wallet" title="Request money">
      {/*
        THE COMP'S REQUEST CARD: the figure first, centred, in the home
        screen's own face — the amount is the whole of what is being asked —
        then the reason, then one action. The same card is what the payer
        sees on the checkout, so both sides of a request look like one thing.
      */}
      <div className="req-card">
        <span className="req-eyebrow">You request</span>
        <label className="req-amount">
          <span className="req-symbol" aria-hidden>{symbolFor(currency)}</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0"
            aria-label={`Amount in ${currency}`}
            value={amount}
            style={{ width: `${Math.max(1, amount.length || 1) + 0.4}ch` }}
            onChange={(e) => {
              setAmount(e.target.value.replace(/[^0-9.]/g, ''));
              setMade(undefined);
            }}
          />
        </label>
        {currencies.length > 1 && (
          <div className="req-currency">
            <Select
              labelledBy="req-currency-label"
              value={currency}
              onChange={(code) => {
                setPicked(code);
                setMade(undefined);
              }}
              renderMark={(code) => <CurrencyMark currency={code} size={18} />}
              options={currencies.map((code) => ({ value: code, label: code }))}
            />
            <span id="req-currency-label" hidden>Currency</span>
          </div>
        )}
        <input
          className="req-for"
          type="text"
          maxLength={REQUEST_NOTE_MAX}
          placeholder="What's it for? (optional)"
          aria-label="What it is for"
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            setMade(undefined);
          }}
        />
        {made === undefined ? (
          <button type="button" className="block req-action" disabled={!valid || link === null} onClick={create}>
            Create request link
          </button>
        ) : (
          <div className="req-made">
            <span className="req-made-label">
              Request for {formatAmount(made.amount, made.currency)} ready
            </span>
            <div className="copy-value mono link">{made.url}</div>
            <div className="req-made-actions">
              <button type="button" className="block" onClick={() => share(made.url)}>
                <Icon name="arrowUpRight" size={16} /> Share request
              </button>
              <button type="button" className="ghost" onClick={() => copy(made.url, setCopiedRequest)}>
                <Icon name="copy" size={15} /> {copiedRequest ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
        <p className="req-foot">
          They pay on a secure page, by card, bank transfer or mobile money. It
          lands in your {currency} wallet.
        </p>
      </div>

      <span className="eyebrow">Or share what is always yours</span>

      {/*
        THE NUMBER GETS THE COMP'S ACCOUNT CARD, because it is the identifier
        a customer reads out — and the gradient panel appears once per screen
        for the reason it appears once on Add money.
      */}
      <div className="acct-card">
        <span className="eyebrow" style={{ padding: 0 }}>From a Xetral account</span>
        <div className="acct-card-row">
          <span className="acct-number">{local === '' ? 'Not set' : local}</span>
          <button
            type="button"
            className="copy-chip"
            disabled={local === ''}
            onClick={() => copy(local, setCopiedPhone)}
          >
            <Icon name="copy" size={14} /> {copiedPhone ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="acct-sub">
          {local === ''
            ? 'Add your phone number in Settings so other customers can find you.'
            : 'Another Xetral customer sends to this number. It arrives instantly and free.'}
        </p>
      </div>

      <span className="eyebrow">From anybody else</span>

      {/*
        BOTH VALUES ARE ON SCREEN, ABOVE THEIR BUTTONS. A Copy button beside
        an em dash is a button that copies nothing and says nothing about why;
        what is shown is what is copied, so a customer can read it back over a
        phone call when the clipboard is not the answer.
      */}
      <div className="copy-row">
        <span className="copy-label">
          A checkout page anybody can pay on, in any currency you hold.
        </span>
        <div className="copy-value mono link">{link ?? 'Not set'}</div>
        <button
          type="button"
          className="ghost small"
          disabled={link === null}
          onClick={() => copy(link ?? '', setCopiedLink)}
        >
          <Icon name="copy" size={15} /> {copiedLink ? 'Copied' : 'Copy payment link'}
        </button>
      </div>

      <FormError error={profile.error} code={profile.code} />
    </Shell>
  );
}
