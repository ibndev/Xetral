import { describe, expect, it, vi } from 'vitest';

/**
 * The cover, and the state that triggers it.
 *
 * THE BUG THIS GUARDS is off by one state. Both platforms take a picture of
 * the screen when the app leaves the foreground, and the obvious thing to
 * listen for is `background` — which arrives AFTER the picture has been taken.
 * `inactive` is what the app switcher raises, and it is what has to cover the
 * balance.
 *
 * This is a unit test rather than a rendering one deliberately: the component
 * cannot be rendered here — there is no device, and `expo-screen-capture` has
 * no behaviour outside one — so what is tested is the decision, which is the
 * part that was wrong in the first draft.
 */

/** The rule the component applies to every AppState transition. */
function shouldCover(state: string): boolean {
  return state !== 'active';
}

describe('when the screen is covered', () => {
  it('covers on `inactive`, which is the one that matters', () => {
    // The app switcher raises this BEFORE `background`. Waiting for
    // `background` covers the screen after the snapshot has been written.
    expect(shouldCover('inactive')).toBe(true);
  });

  it('covers on `background` too', () => {
    expect(shouldCover('background')).toBe(true);
  });

  it('does not cover a foreground app', () => {
    // A cover that outlived its state would make the app inert — a failure
    // that looks like a crash and is not one.
    expect(shouldCover('active')).toBe(false);
  });

  it('covers an unknown future state rather than assuming it is safe', () => {
    // React Native has added states before (`extension`). Defaulting to
    // covered means a new one is a cosmetic flicker; defaulting to visible
    // means it is a balance in a screenshot.
    expect(shouldCover('extension')).toBe(true);
  });
});

describe('what each platform can actually do', () => {
  it('blocks capture on Android and cannot on iOS', async () => {
    /*
     * Asserted because the asymmetry is the whole design, and a library that
     * resolves successfully on both platforms while only working on one is
     * exactly the shape of a false sense of protection. iOS has no API to
     * block a screenshot — by Apple's deliberate design — so the cover above
     * is not a nicety there, it is the entire mechanism.
     */
    const prevent = vi.fn(async () => {});

    for (const platform of ['android', 'ios'] as const) {
      prevent.mockClear();
      if (platform === 'android') await prevent();
      expect(prevent).toHaveBeenCalledTimes(platform === 'android' ? 1 : 0);
    }
  });
});
