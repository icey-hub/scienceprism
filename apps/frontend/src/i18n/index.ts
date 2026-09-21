import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import enUS from './locales/en-US.json';

const STORAGE_KEY = 'scienceprism-lang';
const LEGACY_STORAGE_KEY = 'openprism-lang';
const defaultLang = 'zh-CN';

function getInitialLang() {
  if (typeof window === 'undefined') return defaultLang;
  const stored = window.localStorage.getItem(STORAGE_KEY) || window.localStorage.getItem(LEGACY_STORAGE_KEY);
  if (stored === 'zh-CN' || stored === 'en-US') return stored;
  return defaultLang;
}

void i18n
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { translation: zhCN },
      'en-US': { translation: enUS }
    },
    lng: getInitialLang(),
    fallbackLng: defaultLang,
    interpolation: { escapeValue: false },
    keySeparator: false
  });

i18n.on('languageChanged', (lng) => {
  if (typeof window === 'undefined') return;
  if (lng === 'zh-CN' || lng === 'en-US') {
    window.localStorage.setItem(STORAGE_KEY, lng);
  }
});

export default i18n;
export const LANGUAGE_STORAGE_KEY = STORAGE_KEY;
