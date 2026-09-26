import { Text, View } from 'react-native';
import type { Announcement } from '@xetral/client';
import { Shell } from '@/shell';
import { Icon } from '@/icon';
import { Empty, FormError, Loading } from '@/ui';
import { useLoad, useXetral } from '@/hooks';
import { cardShadow, font, useTheme } from '@/theme';

/**
 * WHAT THE BELL OPENS — the web's `/notifications`, on the phone.
 *
 * The announcements `/admin/broadcasts` publishes, read on request: the same
 * rows the worker pushes to a lock screen, so a customer who declined product
 * news, or whose handset never registered, can still read them here. No count
 * and no unread state, because nothing records what a customer has read.
 */
export default function Notifications() {
  const client = useXetral();
  const colors = useTheme();
  const feed = useLoad(() => client.announcements(), [client]);
  const items = feed.data?.announcements ?? [];

  return (
    <Shell back="/wallet" title="Notifications">
      {feed.loading && <Loading />}
      <FormError error={feed.error} code={feed.code} />
      {!feed.loading && feed.error === undefined && items.length === 0 && (
        <Empty icon="bell" title="No announcements yet" />
      )}

      {items.length > 0 && (
        <View
          style={{
            backgroundColor: colors.surface,
            borderWidth: 1, borderColor: colors.edge,
            borderRadius: 18,
            paddingHorizontal: 16, paddingVertical: 4,
            ...cardShadow(colors),
          }}
        >
          {items.map((item: Announcement, index: number) => (
            <View
              key={item.uuid}
              style={{
                flexDirection: 'row', gap: 12, paddingVertical: 14,
                borderBottomWidth: index === items.length - 1 ? 0 : 1,
                borderBottomColor: colors.line,
              }}
            >
              <View
                style={{
                  width: 38, height: 38, borderRadius: 12,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: colors.irisTint,
                }}
              >
                <Icon name="bell" size={18} color={colors.irisText} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
                  <Text
                    style={{ flex: 1, color: colors.text, fontFamily: font.sansSemi, fontSize: 14.5 }}
                  >
                    {item.title}
                  </Text>
                  <Text
                    style={{
                      color: colors.text3, fontFamily: font.sansMedium, fontSize: 12,
                      fontVariant: ['tabular-nums'],
                    }}
                  >
                    {whenOf(item.at)}
                  </Text>
                </View>
                {/* Wraps: an announcement is read, not scanned. */}
                <Text style={{ color: colors.text2, fontFamily: font.sans, fontSize: 13.5, lineHeight: 20 }}>
                  {item.body}
                </Text>
              </View>
            </View>
          ))}
        </View>
      )}
    </Shell>
  );
}

/** "14:05" today, "3 Sep" this year, "3 Sep 2025" before — the web's `whenOf`. */
function whenOf(iso: string): string {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) {
    return at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
  return at.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
