import Link from 'next/link';

/**
 * A real 404, rather than Next's default page.
 *
 * The stock one is unstyled and carries Next's own branding, which on a
 * banking domain reads as "this site is broken" — and a customer who thinks
 * their bank is broken checks their balance somewhere else, or calls support.
 */
export default function NotFound() {
  return (
    <main className="shell">
      <div className="nav">
        <strong>Xetral</strong>
      </div>

      <div className="panel">
        <h1>That page is not here</h1>
        <h2>404</h2>
        <p className="lead">
          The link may be old, or the address may have a typo in it. Nothing has
          happened to your money.
        </p>
        <div className="actions">
          <Link href="/wallet">
            <button type="button">Go to my wallet</button>
          </Link>
        </div>
      </div>
    </main>
  );
}
