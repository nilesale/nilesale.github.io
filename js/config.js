/*
 * Nile Sale settings
 * ------------------------------------------------------------
 * Fill these two values from Supabase:
 *   Project Settings → Data API → Project URL
 *   Project Settings → API Keys → anon / publishable key
 * Both are meant to be public, so it's safe to keep them here.
 * NEVER put the "service_role" / secret key in this file.
 *
 * While they are empty, sign-in stays in demo mode.
 * Turn a provider on (true) only after it is enabled in
 * Supabase → Authentication → Sign In / Providers.
 */
window.NILESALE_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  providers: {
    google: true,
    apple: false
  }
};
