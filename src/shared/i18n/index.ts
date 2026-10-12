/** The renderer entry: the shared {@link i18n} instance bound to React (`useTranslation`). */

import { setI18n, useTranslation } from "react-i18next";
import { i18n } from "./core";

setI18n(i18n);

export { i18n, isSupportedLanguage, resources, setAppLanguage, SUPPORTED_LANGUAGES, t, type AppLanguage, type SupportedLanguage } from "./core";
export { useTranslation };
