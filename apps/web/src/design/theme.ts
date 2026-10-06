export type Theme = 'system' | 'light' | 'dark';
export function savedTheme(): Theme {
  try {
    const value = localStorage.getItem('bi-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}
export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  try {
    localStorage.setItem('bi-theme', theme);
  } catch {
    /* Nonsensitive preference can remain in memory. */
  }
}
