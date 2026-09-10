/**
 * TELLING A HANDSET SOMETHING.
 *
 * NOT `NotificationPort`, and the difference matters more than it looks.
 * That port sends a MESSAGE TO A PERSON at an address they own — an email,
 * which arrives whether or not they still have the app, and whose body 012
 * seals because a rendered reset email carries a live bearer token. This one
 * sends a NOTIFICATION TO AN INSTALLATION: it is delivered by a service the
 * customer's operating system trusts, it can be read off a lock screen by
 * anybody holding the phone, and it stops working the moment the app is
 * uninstalled.
 *
 * THAT LOCK SCREEN IS WHY THERE IS NO AMOUNT IN THIS INTERFACE. Everything
 * here goes to a surface a stranger can read without unlocking anything, so a
 * balance, a transaction figure or an account number has no business in one.
 * The port carries a title and a body and deliberately no money at all — the
 * same argument `apps/mobile/src/screen-privacy.tsx` makes about the app
 * switcher photographing a balance, applied to the place a notification lands.
 *
 * A TOKEN IS AN ADDRESS AND NOT A CREDENTIAL. It identifies one installation
 * and lets its holder send to that handset — nothing more. It cannot read
 * anything and authorises nothing, which is why 065 stores it in the clear
 * under a shape CHECK rather than as a hash.
 */
export interface PushPort {
  readonly provider: string;

  /**
   * Sends one notification to many handsets.
   *
   * BATCHED BY THE CALLER'S ARRAY, chunked by the adapter. A broadcast to a
   * country is thousands of tokens and the services take them a hundred at a
   * time; a caller that had to know the chunk size would be a caller that
   * knows which provider answered, which is the thing a port exists to hide.
   *
   * PARTIAL SUCCESS IS THE NORMAL CASE, so this returns an outcome per token
   * rather than throwing on the first refusal. A handset whose app was
   * uninstalled is refused individually and must not stop the other nine
   * hundred and ninety-nine.
   */
  send(message: PushMessage, tokens: readonly string[]): Promise<readonly PushOutcome[]>;
}

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /**
   * Where tapping it should land, as an in-app path.
   *
   * A PATH RATHER THAN A URL, so a notification can never send a customer of
   * a bank to a page somebody else chose. The app resolves it against its own
   * router and ignores anything it does not recognise.
   */
  readonly path?: string;
}

export interface PushOutcome {
  readonly token: string;
  readonly accepted: boolean;
  /**
   * True when the service says this installation is GONE — uninstalled, or
   * the token superseded. It is the one refusal that means the token must be
   * retired rather than retried: kept, it is a permanent per-broadcast error
   * that makes every report look worse than the delivery is.
   */
  readonly deviceGone: boolean;
  /**
   * The service's own words, for a row an operator reads. Never for a
   * customer: it names our integration — 006's rule.
   */
  readonly reason?: string;
}
