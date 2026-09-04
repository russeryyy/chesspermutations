declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function isGaMeasurementId(value: string | undefined): boolean {
  return /^G-[A-Z0-9]+$/i.test(value?.trim() ?? '');
}

const configuredMeasurementId = import.meta.env.VITE_GA_MEASUREMENT_ID?.trim();

export const analyticsIsConfigured =
  import.meta.env.PROD && isGaMeasurementId(configuredMeasurementId);

export function analyticsPageLocation(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.origin}${url.pathname}`;
}

export function initializeAnalytics(): boolean {
  if (!analyticsIsConfigured || !configuredMeasurementId) {
    return false;
  }

  if (document.querySelector<HTMLScriptElement>('script[data-chess-analytics]')) {
    return true;
  }

  window.dataLayer = window.dataLayer ?? [];
  window.gtag =
    window.gtag ??
    ((...args: unknown[]) => {
      window.dataLayer?.push(args);
    });

  window.gtag('consent', 'default', {
    ad_personalization: 'denied',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    analytics_storage: 'denied',
  });
  window.gtag('js', new Date());
  window.gtag('config', configuredMeasurementId, {
    allow_ad_personalization_signals: false,
    allow_google_signals: false,
    anonymize_ip: true,
    send_page_view: false,
  });
  window.gtag('event', 'page_view', {
    page_location: analyticsPageLocation(location.href),
    page_path: location.pathname,
    page_title: document.title,
  });

  const script = document.createElement('script');
  script.async = true;
  script.dataset.chessAnalytics = 'true';
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(configuredMeasurementId)}`;
  document.head.append(script);
  return true;
}
