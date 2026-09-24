import { useMemo, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { formatAmount } from '@xetral/client';
import type { CatalogueItem, Purchase } from '@xetral/client';
import { Icon } from '@/icon';
import { Shell } from '@/shell';
import { Button, Done, Empty, Field, FormError, Loading, Panel } from '@/ui';
import { useIdempotencyKey, useLoad, useSubmit, useXetral } from '@/hooks';
import { font, onGround, radius, space, useStyles, useTheme } from '@/theme';

/**
 * TRAVEL eSIM, ON ITS OWN SCREEN — the comp's, and the web's `/esim`, control
 * for control. See `apps/web/src/app/esim/page.tsx`: choosing an eSIM is
 * choosing a destination, so the first thing on screen is a search and a list
 * of plans with prices, and buying is the second step. The money path is the
 * one every bill uses — `client.buy({ service: 'esim' })`.
 */
export default function Esim() {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const catalogue = useLoad(() => client.catalogue('esim'), [client]);
  const history = useLoad(() => client.purchases(), [client]);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<CatalogueItem | undefined>();

  const items = catalogue.data ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? items : items.filter((i) => i.name.toLowerCase().includes(q));
  }, [items, query]);
  const mine = (history.data ?? []).filter((p: Purchase) => p.service === 'esim');

  return (
    <Shell back="/more" title="Travel eSIM">
      <Text style={styles.lead}>Stay connected abroad. Data only, installed as a second SIM beside your own line.</Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 9,
          paddingHorizontal: 14,
          marginTop: space.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.edge,
          ...onGround(colors),
        }}
      >
        <Icon name="search" size={18} color={colors.text3} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search a country"
          placeholderTextColor={colors.text3}
          accessibilityLabel="Search a country"
          style={{ flex: 1, minHeight: 48, color: colors.text, fontFamily: font.sansMedium, fontSize: 15 }}
        />
      </View>

      {picked !== undefined ? (
        <Buy item={picked} onCancel={() => setPicked(undefined)} onBought={history.reload} />
      ) : (
        <View style={{ marginTop: space.lg }}>
          <Text
            style={{
              fontFamily: font.sansBold,
              fontSize: 11,
              letterSpacing: 1.1,
              textTransform: 'uppercase',
              color: colors.text3,
              marginBottom: space.xs,
            }}
          >
            {query.trim() === '' ? 'Plans' : 'Matching plans'}
          </Text>
          {catalogue.loading && <Loading />}
          <FormError error={catalogue.error} code={catalogue.code} />
          {!catalogue.loading && catalogue.error === undefined && shown.length === 0 && (
            <Empty
              icon="sim"
              title={items.length === 0 ? 'No plans available right now' : 'No plan matches that search'}
            />
          )}
          {shown.map((item) => (
            <Pressable
              key={item.code}
              onPress={() => setPicked(item)}
              android_ripple={null}
              accessibilityRole="button"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 13,
                paddingVertical: 13,
                borderBottomWidth: 1,
                borderBottomColor: colors.line,
              }}
            >
              <View
                style={{
                  width: 40, height: 40, borderRadius: 20,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: colors.infoBg,
                }}
              >
                <Icon name="globe" size={20} color={colors.info} />
              </View>
              <View style={{ flex: 1 }}>
                <Text numberOfLines={2} style={{ fontFamily: font.sansSemi, fontSize: 15, color: colors.text }}>
                  {item.name}
                </Text>
              </View>
              <Text style={{ fontFamily: font.numBold, fontSize: 14, color: colors.text }}>
                {item.price === null ? 'Varies' : formatAmount(item.price, item.currency)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {mine.length > 0 && (
        <Panel title="Your eSIMs">
          {mine.map((p: Purchase) => (
            <View key={p.id} style={styles.row}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: colors.text, fontFamily: font.sansSemi }}>{p.target}</Text>
                <Text style={styles.muted}>
                  {p.status === 'reserved' ? 'Waiting on the provider. Your money is held, not spent.' : p.status}
                </Text>
              </View>
              <Text style={styles.amount}>{formatAmount(p.amount, p.currency)}</Text>
            </View>
          ))}
        </Panel>
      )}
    </Shell>
  );
}

function Buy(props: {
  readonly item: CatalogueItem;
  readonly onCancel: () => void;
  readonly onBought: () => void;
}) {
  const client = useXetral();
  const colors = useTheme();
  const { busy, error, code, done, run } = useSubmit();
  const attempt = useIdempotencyKey();
  const [email, setEmail] = useState('');
  const [pin, setPin] = useState('');
  const price = props.item.price;

  return (
    <Panel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: space.sm }}>
        <View
          style={{
            width: 42, height: 42, borderRadius: 21,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: colors.infoBg,
          }}
        >
          <Icon name="globe" size={20} color={colors.info} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: font.sansSemi, fontSize: 15, color: colors.text }}>{props.item.name}</Text>
          <Text style={{ fontFamily: font.sansMedium, fontSize: 12.5, color: colors.text3 }}>
            {price === null ? 'Not available' : formatAmount(price, props.item.currency)}
          </Text>
        </View>
        <Button label="Change" quiet onPress={props.onCancel} />
      </View>

      <Field
        label="Email for the QR code"
        inputMode="email"
        autoCapitalize="none"
        value={email}
        onChangeText={setEmail}
      />
      <Field
        label="Transaction PIN"
        secureTextEntry
        keyboardType="number-pad"
        value={pin}
        onChangeText={setPin}
      />
      <View style={{ marginTop: space.md }}>
        <Button
          label={price === null ? 'Not available' : `Pay ${formatAmount(price, props.item.currency)}`}
          busy={busy}
          disabled={price === null || email.trim() === '' || pin === ''}
          onPress={() =>
            void run(async () => {
              const purchase = await client.buy({
                service: 'esim',
                itemCode: props.item.code,
                target: email.trim(),
                amount: price ?? '',
                pin,
                idempotencyKey: attempt.key,
              });
              attempt.next();
              setPin('');
              props.onBought();
              return purchase.status === 'delivered'
                ? 'Done. The QR code is on its way to your email.'
                : 'Submitted. We will email the QR code shortly.';
            })
          }
        />
      </View>
      <FormError error={error} code={code} />
      <Done message={done} />
    </Panel>
  );
}
