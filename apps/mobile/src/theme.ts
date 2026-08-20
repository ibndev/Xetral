import { StyleSheet } from 'react-native';

export const colors = {
  bg: '#0b0f14',
  panel: '#131a22',
  line: '#223041',
  text: '#e6edf3',
  muted: '#8b9bb0',
  accent: '#2f81f7',
  danger: '#f85149',
  ok: '#3fb950',
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 20 },
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 10,
    padding: 18,
    marginBottom: 14,
  },
  h1: { color: colors.text, fontSize: 22, fontWeight: '700', marginBottom: 2 },
  h2: { color: colors.muted, fontSize: 14, marginBottom: 14 },
  label: { color: colors.muted, fontSize: 13, marginBottom: 4, marginTop: 10 },
  input: {
    backgroundColor: '#0d1218',
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 7,
    color: colors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 7,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 16,
  },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  // Tabular figures, so a column of balances lines up and a digit changing
  // does not shift the ones beside it.
  amount: { color: colors.text, fontSize: 22, fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted, fontSize: 12 },
  error: { color: colors.danger, fontSize: 13, marginTop: 10 },
  ok: { color: colors.ok, fontSize: 13, marginTop: 10 },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  divider: { borderBottomColor: colors.line, borderBottomWidth: 1, paddingVertical: 12 },
  link: { color: colors.accent, fontSize: 14, marginRight: 16 },
  nav: { flexDirection: 'row', marginBottom: 18, flexWrap: 'wrap' },
});
