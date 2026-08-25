import { Icon } from './icon';
import { Logo } from './logo';

/**
 * The brand panel beside a sign-in form, from 900px up.
 *
 * BLACK IN BOTH THEMES, which is why the mark is set to `metal` rather than
 * `auto`: this is a surface, not a background, so it does not follow the page
 * — and `auto` would draw a black mark on it every time somebody is using the
 * light theme. It also means the brushed metal is what a customer actually
 * meets on the light theme, instead of the metal existing only for people who
 * happen to prefer dark.
 *
 * Hidden below 900px and not rendered smaller. It is decorative, and the one
 * thing a phone should not spend its width on is decoration in front of the
 * form somebody opened the page to fill in.
 *
 * The three points are claims this codebase can actually stand behind, which
 * is the only reason to make them on a sign-in page: the ledger is
 * double-entry and per-currency, refresh tokens rotate with reuse detection,
 * and the naira rail is real. Marketing copy that the product does not do is
 * how a trust panel becomes the opposite.
 */
export function AuthAside() {
  return (
    <aside className="auth-aside" aria-hidden="true">
      <div className="auth-aside-mark">
        <Logo size={30} tone="metal" />
      </div>

      <div className="auth-pitch">
        <h2>Naira, dollars, and everything between.</h2>
        <ul className="auth-points">
          <li>
            <Icon name="shield" size={17} />
            <span>Every posting double-entry and balanced per currency.</span>
          </li>
          <li>
            <Icon name="lock" size={17} />
            <span>Sessions rotate on every use, and a replayed token ends them all.</span>
          </li>
          <li>
            <Icon name="bank" size={17} />
            <span>A Nigerian account number in your own name, funded from any bank.</span>
          </li>
        </ul>
      </div>

      <p className="auth-legal">Xetral · xetral.com</p>
    </aside>
  );
}
