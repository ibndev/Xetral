import { Modal, Pressable, ScrollView, Share, Text, View } from 'react-native';
import { entryTitle, formatAmount, receiptText, statusWords } from '@xetral/client';
import { Icon } from '@/icon';
import { Button, FormError, Loading } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { radius, space, useStyles, useTheme } from '@/theme';

/**
 * ONE TRANSACTION, IN FULL, AND A WAY TO SEND IT ON.
 *
 * THE SHARE IS THE POINT rather than a decoration. The question a customer is
 * answering when they open a transaction is almost always somebody else's —
 * "did you send it?" — and before this the only answer available was a
 * screenshot of a list row, which carries no reference and no destination.
 *
 * `Share.share` with the text the web builds from the same function, so a
 * receipt forwarded from a phone and one copied from a laptop say the same
 * thing.
 */
export function TransactionSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const client = useXetral();
  const styles = useStyles();
  const colors = useTheme();
  const detail = useLoad(() => client.transaction(id), [client, id]);
  const t = detail.data;

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' }}
        onPress={onClose}
        android_ripple={null}
      >
        {/* Stops a tap inside the sheet from closing it. */}
        <Pressable
          android_ripple={null}
          onPress={() => undefined}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            padding: space.lg,
            paddingBottom: space.xl,
            maxHeight: '88%',
          }}
        >
          <ScrollView>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={styles.h2}>Transaction</Text>
              <Pressable accessibilityLabel="Close" onPress={onClose} android_ripple={null}>
                <Icon name="close" size={20} color={colors.text2} />
              </Pressable>
            </View>

            {detail.loading && <Loading />}
            <FormError error={detail.error} code={detail.code} />

            {t !== undefined && (
              <>
                <Text style={[styles.amount, { fontSize: 28, marginTop: space.sm }]}>
                  {formatAmount(t.amount, t.currency)}
                </Text>
                <Text style={styles.lead}>{statusWords(t)}</Text>

                <Row label="What" value={entryTitle(t.description, t.kind)} />
                {t.beneficiary !== undefined && <Row label="To" value={t.beneficiary} />}
                {t.bank_name !== undefined && (
                  <Row
                    label="Bank"
                    value={`${t.bank_name}${
                      t.account_number === undefined ? '' : ` ••${t.account_number.slice(-4)}`
                    }`}
                  />
                )}
                {/* The fee as its own line: a transfer that charges one is two
                    postings against the same wallet, and a customer who can see
                    only the total cannot reconcile it against their balance. */}
                {t.fee !== undefined && !/^0([.,]0+)?$/.test(t.fee) && (
                  <Row label="Fee" value={formatAmount(t.fee, t.currency)} />
                )}
                <Row label="Date" value={new Date(t.occurred_at).toLocaleString()} />
                <Row label="Reference" value={t.reference} />
                {t.narration !== undefined && t.narration !== null && t.narration !== '' && (
                  <Row label="Note" value={t.narration} />
                )}

                <Button
                  label="Share receipt"
                  icon="copy"
                  onPress={() => {
                    // A dismissed share sheet rejects, and that is not an error
                    // worth reporting to anybody.
                    void Share.share({ message: receiptText(t) }).catch(() => undefined);
                  }}
                />
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <View style={styles.row}>
      <Text style={[styles.muted, { flex: 1 }]}>{label}</Text>
      <Text style={[styles.muted, { flex: 1, textAlign: 'right' }]} numberOfLines={2}>
        {value}
      </Text>
    </View>
  );
}
