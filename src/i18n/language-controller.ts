import type { LanguageResources } from './resources/@types';
import type { i18n, TFunction } from 'i18next';

export type TranslationResource = LanguageResources[string]['translation'];
export type LanguageLoader = (
  name: string,
) => Promise<TranslationResource | undefined>;

export const createLanguageController = (
  engine: i18n,
  load: LanguageLoader,
  available: readonly string[],
) => {
  const known = new Set(available);
  const resources = new Map<string, Promise<TranslationResource | undefined>>();
  let initialization: Promise<TFunction> | undefined;
  let request = 0;
  const translate = () => engine.t.bind(engine);
  const resource = (name: string) => {
    if (!known.has(name)) return Promise.resolve(undefined);
    const cached = resources.get(name);
    if (cached) return cached;
    const pending = Promise.resolve().then(() => load(name));
    resources.set(name, pending);
    pending.then(
      (value) => {
        if (!value && resources.get(name) === pending) resources.delete(name);
      },
      () => {
        if (resources.get(name) === pending) resources.delete(name);
      },
    );
    return pending;
  };
  const initialize = (): Promise<TFunction> => {
    if (initialization) return initialization;
    const pending = (async () => {
      const english = await resource('en');
      if (!english)
        throw new Error('English translation resource is unavailable');
      return await engine.init({
        resources: { en: { translation: english } },
        lng: 'en',
        fallbackLng: 'en',
        interpolation: { escapeValue: false },
      });
    })();
    initialization = pending;
    pending.catch(() => {
      if (initialization === pending) initialization = undefined;
    });
    return pending;
  };
  const setLanguage = async (
    language: string,
    isCurrent: () => boolean = () => true,
  ): Promise<TFunction> => {
    const owner = ++request;
    const ownsRequest = () =>
      owner === request && isCurrent() && owner === request;
    await initialize();
    if (!ownsRequest()) return translate();
    // i18next declares this internal service as any. Check the narrow adapter
    // before using its real regional/script/fallback policy.
    const utilities = engine.services.languageUtils as unknown as {
      toResolveHierarchy?: (code: string) => string[];
    };
    if (typeof utilities.toResolveHierarchy !== 'function')
      throw new Error('i18next language hierarchy service is unavailable');
    const hierarchy = utilities
      .toResolveHierarchy(language)
      .filter((id) => known.has(id));
    await Promise.all(
      hierarchy.map(async (id) => {
        try {
          const value = await resource(id);
          if (value && !engine.hasResourceBundle(id, 'translation'))
            engine.addResourceBundle(id, 'translation', value);
        } catch {
          // Keep English usable; a later explicit selection retries the bundle.
        }
      }),
    );
    if (!ownsRequest()) return translate();
    // With bundles installed and no backend, i18next activates synchronously.
    const result = await engine.changeLanguage(language);
    return owner === request ? result : translate();
  };
  return {
    initialize,
    setLanguage,
    retirePending: () => {
      request++;
    },
  };
};
