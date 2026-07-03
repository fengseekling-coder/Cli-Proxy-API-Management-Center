/**
 * Watches the served /management.html for new asset versions.
 *
 * The CLI proxy serves a single-file SPA at /management.html without
 * cache-busting headers, so browsers can keep showing a stale bundle even
 * after a release has been pulled. This hook polls the Last-Modified
 * header and surfaces a sticky toast when it changes — the user clicks the
 * toast to reload and pick up the new bundle.
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNotificationStore } from '@/stores';

declare const __APP_VERSION__: string;

const POLL_INTERVAL_MS = 30_000;
const APP_VERSION_META = 'meta[name="app-version"]';

const readBuildVersion = (): string => {
  if (typeof document !== 'undefined') {
    const meta = document.querySelector<HTMLMetaElement>(APP_VERSION_META);
    if (meta?.content) return meta.content;
  }
  return String(__APP_VERSION__ || 'dev');
};

export function useAssetVersionWatcher() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const buildVersion = readBuildVersion();
    const cacheBuster = `?v=${encodeURIComponent(buildVersion)}`;
    const watchedUrl = `/management.html${cacheBuster}`;
    const seenKey = `cpa:mgmt-lastmod:${buildVersion}`;
    const knownLastMod = sessionStorage.getItem(seenKey);

    let cancelled = false;

    const checkForUpdate = async () => {
      try {
        const response = await fetch(watchedUrl, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) return;
        const serverLastMod = response.headers.get('Last-Modified');
        if (!serverLastMod) return;
        if (cancelled) return;

        // We have a previously seen Last-Modified for THIS build version,
        // and it differs from the server's → a new asset has been pulled.
        if (knownLastMod && knownLastMod !== serverLastMod) {
          sessionStorage.removeItem(seenKey);
          showNotification(
            t('app.new_version_available', {
              defaultValue: 'New UI version available — click anywhere to reload.',
            }),
            'info',
            0
          );
          // Click anywhere on the page reloads — a one-shot listener so it
          // doesn't hijack subsequent interactions.
          const reloadOnClick = () => {
            window.removeEventListener('click', reloadOnClick, true);
            window.location.reload();
          };
          window.addEventListener('click', reloadOnClick, true);
          return;
        }

        if (!knownLastMod) {
          sessionStorage.setItem(seenKey, serverLastMod);
        }
      } catch {
        // Network errors are normal while the server is restarting; ignore.
      }
    };

    void checkForUpdate();
    const interval = window.setInterval(checkForUpdate, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [showNotification, t]);
}