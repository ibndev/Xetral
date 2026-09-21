'use client';

import { useEffect, useState } from 'react';
import { nationalPhone, paymentLinkFor } from '@xetral/client';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import { FormError } from '@/ui/form-error';
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
 * AND NOT THE COMP'S REQUEST SCREEN, deliberately. That one asks for an
 * amount and lists pending requests against named people — a product with a
 * table behind it that this platform does not have. A screen that took an
 * amount and produced a link which ignores it would be worse than not
 * offering one: a payment link's amount is chosen by the PAYER (058), and a
 * customer who typed ₦25,000 into a box would reasonably believe that is what
 * was asked for.
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
      <p className="page-lede">Two ways to be paid. Both are yours permanently.</p>

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
