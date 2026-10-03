'use client';

import { useEffect, useState } from 'react';
import type { ServiceStates } from '@xetral/client';
import { xetral } from '@/lib/session';

/**
 * WHICH SERVICES ARE ON, COMING SOON OR HIDDEN, for every screen at once.
 *
 * The last answer is remembered for the visit, so a screen opened after the
 * first draws its lists already filtered — a hidden product is never drawn
 * and then taken away. It is ASKED AGAIN on every screen and whenever the tab
 * comes back into view, so an operator hiding a service is seen within one
 * screen change; the client holds an answer for ten seconds and the server
 * for thirty, and nothing longer, so a cached config cannot keep a hidden
 * service on screen beyond that.
 */
let remembered: ServiceStates | undefined;

export function useServiceStates(): { readonly states: ServiceStates | undefined; readonly settled: boolean } {
  const [states, setStates] = useState<ServiceStates | undefined>(remembered);
  // Whether the read has come back — answered OR failed. A failed courtesy
  // read hides nothing: unknown is "not paused, not hidden".
  const [settled, setSettled] = useState(remembered !== undefined);

  useEffect(() => {
    let live = true;
    const ask = () => {
      xetral()
        .client.services()
        .then((answer) => {
          remembered = answer;
          if (live) {
            setStates(answer);
            setSettled(true);
          }
        })
        .catch(() => {
          if (live) setSettled(true);
        });
    };
    ask();
    const onVisible = () => {
      if (document.visibilityState === 'visible') ask();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return { states, settled };
}
