'use client';

/**
 * The last boundary: the root layout itself failed.
 *
 * At this point the app's own `<html>` never rendered, so this component has
 * to supply one — and it cannot rely on the stylesheet having loaded either,
 * which is why the few styles it needs are inline. A page that catches a
 * layout failure and then fails to render is not a boundary.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          background: '#0b0f14',
          color: '#e6edf3',
          font: '15px/1.5 ui-sans-serif, system-ui, sans-serif',
        }}
      >
        <main style={{ maxWidth: 560, margin: '0 auto', padding: '48px 20px' }}>
          <h1 style={{ fontSize: 20, margin: '0 0 8px' }}>Xetral is not loading</h1>
          <p style={{ color: '#8b9bb0' }}>
            Something failed before the page could start. Your account is not
            affected — please reload, and if it keeps happening try again in a
            few minutes.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              padding: '11px 18px',
              background: '#2f81f7',
              color: '#fff',
              border: 0,
              borderRadius: 7,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Reload
          </button>
          {error.digest !== undefined && (
            <p style={{ color: '#8b9bb0', fontSize: 13 }}>Reference {error.digest}</p>
          )}
        </main>
      </body>
    </html>
  );
}
