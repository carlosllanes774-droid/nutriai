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
    var msg = (err && (err.message || err.error_description)) ? String(err.message || err.error_description) : 'Something did not connect.';
    var lower = msg.toLowerCase();
    if (lower.indexOf('invalid login') !== -1 || lower.indexOf('invalid email or password') !== -1)
      return 'That email or password did not match our records.';
    if (lower.indexOf('user already registered') !== -1 || lower.indexOf('already been registered') !== -1)
      return 'An account already exists for this email — try signing in.';
    if (lower.indexOf('password') !== -1 && lower.indexOf('least') !== -1) return 'Use at least 8 characters for your password.';
    if (lower.indexOf('email') !== -1 && (lower.indexOf('invalid') !== -1 || lower.indexOf('format') !== -1))
      return 'Double-check the email format.';
    if (lower.indexOf('network') !== -1 || lower.indexOf('fetch') !== -1)
      return 'Network hiccup — a quiet moment, then try again.';
    return 'Could not complete that — please try again in a moment.';
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
    signOut: signOut,
    onAuthStateChange: onAuthStateChange,
    fetchProfileRow: fetchProfileRow,
    upsertProfileBundle: upsertProfileBundle
  };
})(typeof window !== 'undefined' ? window : this);
