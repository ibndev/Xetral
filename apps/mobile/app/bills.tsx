import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatAmount, PURCHASE_SERVICES } from '@xetral/client';
import type { CatalogueItem, Purchase, PurchaseService } from '@xetral/client';
import { Icon } from '@/icon';
import { Shell } from '@/shell';
import {
  AmountCard,
  Button,
  CurrencyPill,
  Done,
  Empty,
  Field,
  FormError,
  Loading,
  Panel,
} from '@/ui';
import { Select } from '@/select';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, radius, space, useStyles, useTheme } from '@/theme';

/**
 * Airtime, data, bills, eSIM and virtual numbers — five services behind one
 * purchase flow, exactly as the web has them.
 *
 * THE LIST IS THE WEB'S, from `@xetral/client`. It was written out in both
 * apps; the crypto screen's equivalent duplication is how the browser spent
 * the whole life of that feature sending chain names the API refused.
 */
type ServiceCode = Exclude<PurchaseService['code'], 'esim'>;

/* eSIM has its own screen, `esim.tsx` — the comp's. Same purchase flow. */
const SERVICES = PURCHASE_SERVICES.filter(
  (s): s is Extract<(typeof PURCHASE_SERVICES)[number], { code: ServiceCode }> => s.code !== 'esim',
);


export default function Bills() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const [service, setService] = useState<ServiceCode>('airtime');
  const history = useLoad(() => client.purchases(), [client]);
  // The list is a non-empty literal minus one entry, so there is always a first.
  const chosen = SERVICES.find((s) => s.code === service) ?? (SERVICES[0] as (typeof SERVICES)[number]);

  return (
    /* A BACK ARROW AND A TITLE, because this screen is reached from More and
       is not a tab — the web's is the same. */
    <Shell back="/more" title="Bills and airtime">
      <Text style={styles.lead}>Airtime, data, electricity and numbers.</Text>

      {/*
        A GRID OF TILES, WHICH IS WHAT THE COMP DRAWS — and what a wrapping
        row of pills could not do: the chips reflowed as the selection changed
        width, which moves the tabs under the thumb, and "Virtual number" is
        the one a customer is least likely to go looking for. Three columns
        gives every service a mark, a full label and a thumb-width target.

        THE MARK AND THE TONE COME FROM THE CATALOGUE, so the phone and the
        web draw the same one. Written out on both sides they drift, and a
        service whose icon differs between them is one a customer describes to
        support by the wrong name.
      */}
      <View
        style={{
          flexDirection: 'row', flexWrap: 'wrap',
          gap: 11, marginTop: space.md,
        }}
      >
        {SERVICES.map((s) => {
          const on = s.code === service;
          const tint = {
            warn: { bg: colors.warnBg, fg: colors.warn },
            info: { bg: colors.infoBg, fg: colors.info },
            ok: { bg: colors.okBg, fg: colors.ok },
            iris: { bg: colors.irisTint, fg: colors.irisText },
          }[s.tone];
          return (
            <Pressable
              key={s.code}
              onPress={() => setService(s.code)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              android_ripple={null}
              style={{
                // Three across, with the two gaps taken off before the split.
                width: `${(100 - 2 * 4) / 3}%`,
                alignItems: 'center',
                gap: 9,
                paddingVertical: 16,
                paddingHorizontal: 6,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: on ? colors.iris : colors.edge,
                backgroundColor: on ? colors.irisTint : colors.surface,
              }}
            >
              <View
                style={{
                  width: 40, height: 40, borderRadius: 12,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: on ? colors.iris : tint.bg,
                }}
              >
                <Icon name={s.icon} size={20} color={on ? colors.onIris : tint.fg} />
              </View>
              <Text
                numberOfLines={2}
                style={{
                  fontSize: 12,
                  fontFamily: font.sansSemi,
                  color: colors.text,
                  textAlign: 'center',
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
              <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>
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

  /*
   * WHO WITHIN THE SERVICE — the network, the electricity company. VTpass
   * sells per `serviceID` and the catalogue was asked for with none, so data
   * and electricity offered no plans and airtime had no item at all. For
   * airtime the network IS what is bought. The web's bills screen does the
   * same.
   */
  const groupLabel = (service as PurchaseService).group;
  const groups = useLoad(
    () => (groupLabel === undefined ? Promise.resolve([]) : client.purchaseGroups(service.code)),
    [client, service.code, groupLabel],
  );
  const [group, setGroup] = useState('');
  const effectiveGroup = group !== '' ? group : (groups.data?.[0]?.code ?? '');

  const catalogue = useLoad(
    // Not swallowed into an empty list: `service_not_configured` and an
    // outage both read as "there are no plans", which the web never said.
    () =>
      service.code === 'airtime'
        ? Promise.resolve([])
        : groupLabel === undefined
          ? client.catalogue(service.code)
          : effectiveGroup === ''
            ? Promise.resolve([])
            : client.catalogue(service.code, effectiveGroup),
    [client, service.code, groupLabel, effectiveGroup],
  );

  const [chosenItem, setItem] = useState('');
  const [target, setTarget] = useState('');
  const [amount, setAmount] = useState('');
  const [pin, setPin] = useState('');

  const items = catalogue.data ?? [];
  // An item from another network's catalogue is not this one's.
  const pickedItem = items.some((i) => i.code === chosenItem) ? chosenItem : '';
  const item = service.code === 'airtime' ? effectiveGroup : pickedItem;
  const selected = items.find((i) => i.code === pickedItem);
  // A fixed-price item has nothing for the customer to type; a variable one
  // (airtime, electricity) does. Showing an amount box for a ₦500 data bundle
  // invites somebody to type a different number and be confused when it is
  // ignored. Same rule, same wording, as the web's bills screen.
  const fixedPrice = selected?.price !== null && selected?.price !== undefined;

  return (
    <Panel title={`Buy ${service.label.toLowerCase()}`}>
      {(catalogue.loading || groups.loading) && <Loading />}
      {!groups.loading && <FormError error={groups.error} code={groups.code} />}
      {!catalogue.loading && <FormError error={catalogue.error} code={catalogue.code} />}

      {groupLabel !== undefined && (groups.data?.length ?? 0) > 0 && (
        <Select
          label={groupLabel}
          value={effectiveGroup}
          onChange={setGroup}
          placeholder="Choose one"
          options={(groups.data ?? []).map((g) => ({ value: g.code, label: g.name }))}
        />
      )}

      {items.length > 0 && (
        <Select
          label="Choose"
          value={pickedItem}
          onChange={setItem}
          placeholder="Choose one"
          options={items.map((option) => ({
            value: option.code,
            label: option.name,
            // The price on its own line. A data catalogue is the longest list
            // in this app and the one a wrapping chip cloud served worst.
            ...(option.price === null
              ? {}
              : { hint: formatAmount(option.price, option.currency) }),
          }))}
        />
      )}

      <Field
        label={service.target}
        inputMode={service.mode === 'tel' ? 'tel' : service.mode === 'numeric' ? 'numeric' : 'text'}
        autoCapitalize="none"
        value={target}
        onChangeText={setTarget}
      />

      {!fixedPrice && (
        <AmountCard>
          <Text style={styles.fieldLabel}>Amount</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
            <CurrencyPill>
              <Text style={{ color: colors.text, fontFamily: font.sansSemi, fontSize: 14 }}>
                {selected?.currency ?? 'NGN'}
              </Text>
            </CurrencyPill>
            <TextInput
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={colors.text3}
              accessibilityLabel="Amount"
              style={{
                flex: 1,
                textAlign: 'right',
                color: colors.text,
                fontFamily: font.displayBold,
                fontSize: 30,
                letterSpacing: -0.6,
                fontVariant: ['tabular-nums'],
              }}
            />
          </View>
        </AmountCard>
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
