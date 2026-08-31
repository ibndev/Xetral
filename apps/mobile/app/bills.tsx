import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { formatAmount, PURCHASE_SERVICES } from '@xetral/client';
import type { CatalogueItem, Purchase, PurchaseService } from '@xetral/client';
import { Shell } from '@/shell';
import { Button, Done, Empty, Field, FormError, Loading, Panel } from '@/ui';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';

/**
 * Airtime, data, bills, eSIM and virtual numbers — five services behind one
 * purchase flow, exactly as the web has them.
 *
 * THE LIST IS THE WEB'S, from `@xetral/client`. It was written out in both
 * apps; the crypto screen's equivalent duplication is how the browser spent
 * the whole life of that feature sending chain names the API refused.
 */
const SERVICES = PURCHASE_SERVICES;

type ServiceCode = PurchaseService['code'];

export default function Bills() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const [service, setService] = useState<ServiceCode>('airtime');
  const history = useLoad(() => client.purchases(), [client]);
  const chosen = SERVICES.find((s) => s.code === service) ?? SERVICES[0];

  return (
    <Shell>
      <Text style={styles.h1}>Bills and top-ups</Text>
      <Text style={styles.lead}>Airtime, data, electricity, eSIM and numbers.</Text>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: space.md }}>
        {SERVICES.map((s) => {
          const on = s.code === service;
          return (
            <Pressable
              key={s.code}
              onPress={() => setService(s.code)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: radius.pill,
                backgroundColor: on ? colors.brand : colors.surface2,
              }}
            >
              <Text
                style={{
                  fontSize: 13,
                  fontWeight: '600',
                  color: on ? colors.onBrand : colors.text2,
                }}
              >
                {s.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Buy key={service} service={chosen} onBought={history.reload} />

      <Panel title="Recent purchases">
        {history.loading && <Loading />}
        {!history.loading && (history.data?.length ?? 0) === 0 && (
          <Empty icon="receipt" title="Nothing bought yet" />
        )}
        {history.data?.slice(0, 10).map((purchase: Purchase) => (
          <View key={purchase.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontWeight: '600' }}>
                {purchase.service} · {purchase.target}
              </Text>
              <Text style={styles.muted}>
                {purchase.status}
                {purchase.failure_reason === null ? '' : ` — ${purchase.failure_reason}`}
              </Text>
            </View>
            <Text style={styles.amount}>
              {formatAmount(purchase.amount, purchase.currency)}
            </Text>
          </View>
        ))}
        <FormError error={history.error} code={history.code} />
      </Panel>
    </Shell>
  );
}

function Buy({
  service,
  onBought,
}: {
  readonly service: (typeof SERVICES)[number];
  readonly onBought: () => void;
}) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();
  // ONE KEY PER ATTEMPT, generated when this form mounts — and it remounts on
  // a service change because the parent keys it, so switching from airtime to
  // data is a new attempt rather than a replay of the last one.
  const attempt = useIdempotencyKey();

  const catalogue = useLoad(
    () => client.catalogue(service.code).catch(() => [] as readonly CatalogueItem[]),
    [client, service.code],
  );

  const [item, setItem] = useState('');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');

  const items = catalogue.data ?? [];
  const selected = items.find((i) => i.code === item);
  // A fixed-price item has nothing for the customer to type; a variable one
  // (airtime, electricity) does. Showing an amount box for a ₦500 data bundle
  // invites somebody to type a different number and be confused when it is
  // ignored. Same rule, same wording, as the web's bills screen.
  const fixedPrice = selected?.price !== null && selected?.price !== undefined;

  return (
    <Panel title={`Buy ${service.label.toLowerCase()}`}>
      {catalogue.loading && <Loading />}

      {items.length > 0 && (
        <>
          <Text style={styles.label}>Choose</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {items.map((option) => {
              const on = option.code === item;
              return (
                <Pressable
                  key={option.code}
                  onPress={() => setItem(option.code)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 9,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: on ? colors.link : colors.line,
                    backgroundColor: on ? colors.infoBg : colors.surface2,
                  }}
                >
                  <Text style={{ color: colors.text, fontSize: 13, fontWeight: '600' }}>
                    {option.name}
                  </Text>
                  {option.price !== null && (
                    <Text style={[styles.amount, { fontSize: 12 }]}>
                      {formatAmount(option.price, option.currency)}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        </>
      )}

      <Field
        label={service.target}
        inputMode={service.mode === 'tel' ? 'tel' : service.mode === 'numeric' ? 'numeric' : service.mode === 'email' ? 'email' : 'text'}
        autoCapitalize="none"
        value={target}
        onChangeText={setTarget}
      />

      {!fixedPrice && (
        <Field
          label="Amount (NGN)"
          inputMode="decimal"
          placeholder="1000.00"
          value={amount}
          onChangeText={setAmount}
        />
      )}

      <Field
        label="Transaction PIN"
        secureTextEntry
        inputMode="numeric"
        autoComplete="off"
        value={pin}
        onChangeText={setPin}
      />

      <Button
        label="Buy"
        busy={busy}
        disabled={item === '' || target === '' || pin === '' || (!fixedPrice && amount === '')}
        onPress={() =>
          void run(async () => {
            const purchase = await client.buy({
              service: service.code,
              itemCode: item,
              target,
              amount: fixedPrice ? (selected?.price ?? '') : amount,
              pin,
              idempotencyKey: attempt.key,
            });
            attempt.next();
            setPin('');
            onBought();
            return purchase.status === 'delivered'
              ? 'Done.'
              : 'Submitted. We will confirm shortly.';
          })
        }
      />
      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}
