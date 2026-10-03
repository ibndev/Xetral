import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A HIDDEN SERVICE LEAVES NO DOOR BEHIND (093), on either app.
 *
 * Every surface that offers a service or one of its currencies has to ask the
 * service states and drop what is hidden. These are the places a customer
 * could otherwise find crypto with it hidden — the shell's navigation and its
 * redirect, the home screen's tiles and Convert action, More, the activity
 * rail and both currency pickers. The SERVER refuses either way; this keeps
 * the apps from drawing a door that leads to a 404.
 *
 * Both apps are read, because the phone cannot be rendered here and a filter
 * dropped from one of them would otherwise be found by a customer.
 */
const WEB = join(import.meta.dirname, '..');
const MOBILE = join(import.meta.dirname, '..', '..', '..', 'mobile');

const SURFACES: readonly (readonly [string, RegExp])[] = [
  [join(WEB, 'ui/shell.tsx'), /isHidden\(services, d\.href\)/],
  [join(WEB, 'ui/shell.tsx'), /paused === 'hidden'\) router\.replace\('\/wallet'\)/],
  [join(WEB, 'app/wallet/page.tsx'), /PRODUCTS\.filter\(\(p\) => !isHidden\(/],
  [join(WEB, 'app/wallet/page.tsx'), /!isHidden\(services, '\/fx'\)/],
  [join(WEB, 'app/more/page.tsx'), /!isHidden\(services\.data, item\.href\)/],
  [join(WEB, 'app/activity/page.tsx'), /activityFiltersFor\([^)]*hiddenCurrencies\(services\)\)/],
  [join(WEB, 'app/transfer/page.tsx'), /sendableFor\(home, \[\], hiddenCurrencies\(services\)\)/],
  [join(WEB, 'app/transfer/page.tsx'), /serviceHidden\(services, 'payouts'\)/],
  [join(WEB, 'app/fx/page.tsx'), /CURRENCIES\.filter\(\(c\) => !hidden\.has\(c\)\)/],
  [join(MOBILE, 'src/shell.tsx'), /TABS\.filter\(\(tab\) => !isHidden\(services, tab\.href\)\)/],
  [join(MOBILE, 'src/shell.tsx'), /paused === 'hidden'\) router\.replace\('\/wallet'\)/],
  [join(MOBILE, 'app/wallet.tsx'), /PRODUCTS\.filter\(\(p\) => !isHidden\(/],
  [join(MOBILE, 'app/wallet.tsx'), /!isHidden\(services, '\/fx'\)/],
  [join(MOBILE, 'app/more.tsx'), /!isHidden\(services\.data, item\.href\)/],
  [join(MOBILE, 'app/activity.tsx'), /activityFiltersFor\([^)]*hiddenCurrencies\(services\)\)/],
  [join(MOBILE, 'app/transfer.tsx'), /sendableFor\(home, \[\], hiddenCurrencies\(services\)\)/],
  [join(MOBILE, 'app/transfer.tsx'), /serviceHidden\(services, 'payouts'\)/],
  [join(MOBILE, 'app/fx.tsx'), /TRANSFER_CURRENCIES\.filter\(\(c\) => !hiddenCurrencies\(services\)\.has\(c\)\)/],
];

describe('a hidden service is filtered on every surface that offers it', () => {
  for (const [file, pattern] of SURFACES) {
    it(`${file.split('/apps/')[1]} — ${pattern.source.slice(0, 48)}`, () => {
      expect(readFileSync(file, 'utf8')).toMatch(pattern);
    });
  }

  it('the gated screens wait for the answer rather than flashing a hidden one', () => {
    for (const file of [join(WEB, 'ui/shell.tsx'), join(MOBILE, 'src/shell.tsx')]) {
      expect(readFileSync(file, 'utf8')).toMatch(/paused === 'wait' \|\| paused === 'hidden'/);
    }
  });
});
