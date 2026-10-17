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
  supabaseUrl: 'https://quvsdwcopaoyldpceuac.supabase.co',
  supabaseAnonKey: 'sb_publishable_L6CX14jyiomRmVJahOzGeQ_0daDBHHI',
  // Google OAuth client id (public). Sign-in uses Google's own button, so no secret is needed here.
  googleClientId: '863950479681-n6njad504p57vo48ru4t2d0p8dvtlp54.apps.googleusercontent.com',
  providers: {
    google: true,
    apple: false   // switch to true once Apple is enabled in Supabase
  }
};
