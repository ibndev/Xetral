import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import type { ServiceStates } from '@xetral/client';
import { useXetral } from '@/hooks';

/**
 * WHICH SERVICES ARE ON, COMING SOON OR HIDDEN — the web's `useServiceStates`.
 *
 * Remembered for the life of the app process, so a screen opened after the
 * first draws its lists already filtered and a hidden product never flashes.
 * ASKED AGAIN on every screen and whenever the app returns to the foreground:
 * a phone left open for a day must not keep showing a service an operator has
 * since hidden. The client holds an answer for ten seconds and the server for
 * thirty — that is the whole of the cache, and no release is involved.
 */
let remembered: ServiceStates | undefined;

export function useServiceStates(): { readonly states: ServiceStates | undefined; readonly settled: boolean } {
  const client = useXetral();
  const [states, setStates] = useState<ServiceStates | undefined>(remembered);
  // Answered OR failed. A failed courtesy read hides nothing: unknown is
  // "not paused, not hidden".
  const [settled, setSettled] = useState(remembered !== undefined);

  useEffect(() => {
    let live = true;
    const ask = () => {
      client
        .services()
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
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') ask();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [client]);

  return { states, settled };
}
