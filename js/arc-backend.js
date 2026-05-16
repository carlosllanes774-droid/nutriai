/**
 * Arc cloud layer — Supabase Auth + profile persistence.
 * Depends on global `supabase` from the Supabase UMD build (createClient).
 */
(function (global) {
  'use strict';

  var TABLE = 'arc_profiles';
  var client = null;
  var authListener = null;

  function readConfig() {
    var c = global.ARC_SUPABASE || {};
    var url = (c.url || '').trim();
    var anonKey = (c.anonKey || c.anon || '').trim();
    if (!url || !anonKey) return null;
    return { url: url, anonKey: anonKey };
  }

  function isConfigured() {
    return !!readConfig();
  }

  function getClient() {
    if (client) return client;
    var cfg = readConfig();
    if (!cfg) return null;
    var lib = global.supabase;
    if (!lib || typeof lib.createClient !== 'function') {
      console.warn('[Arc] Supabase JS not loaded — add the UMD script before arc-backend.js');
      return null;
    }
    client = lib.createClient(cfg.url, cfg.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storage: global.localStorage
      }
    });
    return client;
  }

  function mapAuthError(err) {
    var msg = (err && (err.message || err.error_description)) ? String(err.message || err.error_description) : '';
    var lower = msg.toLowerCase();
    if (lower.indexOf('invalid login') !== -1 || lower.indexOf('invalid email or password') !== -1 || lower.indexOf('wrong password') !== -1)
      return "We couldn't match that password.";
    if (lower.indexOf('user already registered') !== -1 || lower.indexOf('already been registered') !== -1 || lower.indexOf('already registered') !== -1)
      return 'An Arc profile already exists for this email.';
    if (lower.indexOf('password') !== -1 && lower.indexOf('least') !== -1)
      return 'Arc asks for at least 8 characters—just a touch longer.';
    if (lower.indexOf('email') !== -1 && (lower.indexOf('invalid') !== -1 || lower.indexOf('format') !== -1))
      return 'That email needs one more look.';
    if (lower.indexOf('network') !== -1 || lower.indexOf('fetch') !== -1 || lower.indexOf('failed to fetch') !== -1)
      return "Arc couldn't connect right now. Try again in a moment.";
    if (lower.indexOf('popup') !== -1 && lower.indexOf('block') !== -1)
      return 'Your browser paused the window—try again, or allow Arc to continue in this tab.';
    if (lower.indexOf('closed') !== -1 || lower.indexOf('cancel') !== -1 || lower.indexOf('denied') !== -1 || lower.indexOf('user denied') !== -1)
      return 'No worries—that was cancelled. Continue whenever you like.';
    if (lower.indexOf('oauth') !== -1 || lower.indexOf('provider') !== -1)
      return 'Google sign-in paused. Try again in a moment.';
    if (!msg) return 'Something gentle slipped—try once more when you are ready.';
    return 'Something gentle slipped—try once more when you are ready.';
  }

  function getSession() {
    var c = getClient();
    if (!c) return Promise.resolve({ data: { session: null }, error: null });
    return c.auth.getSession();
  }

  function signInWithPassword(email, password) {
    var c = getClient();
    if (!c) return Promise.reject(new Error('Supabase not configured'));
    return c.auth.signInWithPassword({ email: email, password: password });
  }

  function signUpWithPassword(email, password) {
    var c = getClient();
    if (!c) return Promise.reject(new Error('Supabase not configured'));
    return c.auth.signUp({ email: email, password: password });
  }

  /** Full-page OAuth redirect (no popup). Caller should persist local state before await. */
  function signInWithGoogle() {
    var c = getClient();
    if (!c) return Promise.reject(new Error('Supabase not configured'));
    var origin = '';
    try {
      origin = global.location && global.location.origin ? String(global.location.origin) : '';
    } catch (e0) {
      origin = '';
    }
    var path = '';
    try {
      path = global.location && global.location.pathname ? String(global.location.pathname) : '/';
    } catch (e1) {
      path = '/';
    }
    var search = '';
    try {
      search = global.location && global.location.search ? String(global.location.search) : '';
    } catch (e2) {
      search = '';
    }
    var redirectTo = (origin || '') + path + search;
    if (!redirectTo) redirectTo = undefined;
    return c.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: redirectTo
      }
    });
  }

  function resendSignupEmail(email) {
    var c = getClient();
    if (!c) return Promise.reject(new Error('Supabase not configured'));
    var em = (email || '').trim();
    if (!em) return Promise.reject(new Error('missing email'));
    return c.auth.resend({ type: 'signup', email: em });
  }

  function signOut() {
    var c = getClient();
    if (!c) return Promise.resolve();
    return c.auth.signOut();
  }

  function onAuthStateChange(cb) {
    var c = getClient();
    if (!c) return { data: { subscription: null } };
    if (authListener && authListener.unsubscribe) {
      try { authListener.unsubscribe(); } catch (e) {}
    }
    var sub = c.auth.onAuthStateChange(function (event, session) {
      cb(event, session);
    });
    authListener = sub && sub.data ? sub.data.subscription : null;
    return sub;
  }

  function fetchProfileRow(userId) {
    var c = getClient();
    if (!c || !userId) return Promise.resolve({ data: null, error: new Error('no client') });
    return c.from(TABLE).select('profile, app_state, onboarding_completed_at').eq('id', userId).maybeSingle();
  }

  function upsertProfileBundle(userId, bundle, onboardingCompletedAt) {
    var c = getClient();
    if (!c || !userId) return Promise.reject(new Error('no client'));
    var prof = bundle && bundle.profile ? bundle.profile : {};
    var app = bundle && bundle.app ? bundle.app : {};
    var row = {
      id: userId,
      profile: prof,
      app_state: app,
      onboarding_completed_at: onboardingCompletedAt || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    return c.from(TABLE).upsert(row, { onConflict: 'id' }).then(function (res) {
      if (res.error) return Promise.reject(res.error);
      return res;
    });
  }

  global.ArcBackend = {
    TABLE: TABLE,
    readConfig: readConfig,
    isConfigured: isConfigured,
    getClient: getClient,
    mapAuthError: mapAuthError,
    getSession: getSession,
    signInWithPassword: signInWithPassword,
    signUpWithPassword: signUpWithPassword,
    signInWithGoogle: signInWithGoogle,
    resendSignupEmail: resendSignupEmail,
    signOut: signOut,
    onAuthStateChange: onAuthStateChange,
    fetchProfileRow: fetchProfileRow,
    upsertProfileBundle: upsertProfileBundle
  };
})(typeof window !== 'undefined' ? window : this);
